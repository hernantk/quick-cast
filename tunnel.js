const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');

const DOWNLOAD_URLS = {
  win32: {
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    ia32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe',
    arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  },
  linux: {
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
    arm: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm'
  },
  darwin: {
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
    arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
  }
};

function getBinaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function getStoredBinaryPath() {
  const dir = path.join(os.tmpdir(), 'quickcast-bin');
  return path.join(dir, getBinaryName());
}

function findExistingBinary() {
  // 0. Next to the packaged .exe (so a bundled/local cloudflared works without download)
  if (typeof process.pkg !== 'undefined' && process.execPath) {
    const besideExe = path.join(path.dirname(process.execPath), getBinaryName());
    if (fs.existsSync(besideExe)) return besideExe;
  }

  // 1. Check in temp dir
  const tempPath = getStoredBinaryPath();
  if (fs.existsSync(tempPath)) {
    return tempPath;
  }

  // 2. Check in untun's old cache if present
  const untunDir = path.join(os.tmpdir(), 'node-untun');
  if (fs.existsSync(untunDir)) {
    try {
      const files = fs.readdirSync(untunDir);
      for (const f of files) {
        if (f.startsWith('cloudflared') && (process.platform !== 'win32' || f.endsWith('.exe'))) {
          const full = path.join(untunDir, f);
          if (fs.existsSync(full)) return full;
        }
      }
    } catch (e) {}
  }

  // 3. Check Program Files on Windows
  if (process.platform === 'win32') {
    const pfPaths = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe')
    ];
    for (const p of pfPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 4. Check system PATH
  try {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch (e) {}

  return null;
}

function downloadFile(url, destPath, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Muitos redirecionamentos ao baixar cloudflared.'));

  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileStream = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fileStream.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return resolve(downloadFile(res.headers.location, destPath, redirects + 1));
      }

      if (res.statusCode !== 200) {
        fileStream.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        return reject(new Error(`Falha no download (HTTP ${res.statusCode})`));
      }

      res.pipe(fileStream);
    });

    fileStream.on('finish', () => {
      fileStream.close(() => resolve(destPath));
    });

    fileStream.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });

    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (e) {}
      reject(err);
    });
  });
}

async function ensureCloudflared() {
  const existing = findExistingBinary();
  if (existing) return existing;

  const platform = process.platform;
  const arch = process.arch;
  const platformUrls = DOWNLOAD_URLS[platform];
  if (!platformUrls) {
    throw new Error(`Plataforma não suportada para túnel automático: ${platform}`);
  }

  const downloadUrl = platformUrls[arch] || platformUrls.x64;
  if (!downloadUrl) {
    throw new Error(`Arquitetura não suportada para túnel automático: ${arch}`);
  }

  const targetPath = getStoredBinaryPath();
  console.log('[Cloudflare] Baixando binário cloudflared oficial...');

  if (platform === 'darwin') {
    const tgzPath = targetPath + '.tgz';
    await downloadFile(downloadUrl, tgzPath);
    execSync(`tar -xzf "${path.basename(tgzPath)}"`, { cwd: path.dirname(targetPath) });
    try { fs.unlinkSync(tgzPath); } catch (e) {}
    fs.chmodSync(targetPath, '755');
  } else {
    await downloadFile(downloadUrl, targetPath);
    if (platform !== 'win32') {
      fs.chmodSync(targetPath, '755');
    }
  }

  console.log('[Cloudflare] Binário cloudflared pronto em:', targetPath);
  return targetPath;
}

function startTunnel(options = {}) {
  return new Promise(async (resolve, reject) => {
    let binaryPath;
    try {
      binaryPath = await ensureCloudflared();
    } catch (err) {
      return reject(err);
    }

    const port = options.port || 8900;
    const targetUrl = `http://127.0.0.1:${port}`;
    const args = ['tunnel', '--url', targetUrl, '--no-autoupdate'];

    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: path.dirname(binaryPath),
      env: process.env
    });

    let resolved = false;
    let publicUrl = null;
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        publicUrl = match[0];
        clearTimeout(timeout);
        resolve({
          getURL: () => publicUrl,
          close: async () => {
            try {
              if (child && !child.killed) {
                child.kill('SIGINT');
                setTimeout(() => {
                  try { if (!child.killed) child.kill('SIGKILL'); } catch (e) {}
                }, 2000);
              }
            } catch (e) {}
          }
        });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared encerrou com código ${code} antes de gerar o link.`));
      }
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill('SIGKILL'); } catch (e) {}
        reject(new Error('Tempo limite de conexão ao Cloudflare Tunnel atingido (30s). Verifique sua conexão com a internet.'));
      }
    }, 30000);
  });
}

module.exports = { startTunnel, ensureCloudflared };
