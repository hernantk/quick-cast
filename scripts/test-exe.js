const http = require('http');
const path = require('path');
const { spawn, execSync } = require('child_process');

const exePath = path.resolve(__dirname, '..', 'dist', 'quickcast.exe');
const PORT = process.env.TEST_PORT || '3847';

function fail(message, extra) {
  console.error('\n[test-exe] FALHOU:', message);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      timeout: 8000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout ${urlPath}`));
    });
    req.on('error', reject);
  });
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error('Timeout aguardando o .exe iniciar.\n' + buf.slice(-2000)));
    }, timeoutMs);

    const onData = (chunk) => {
      buf += chunk.toString();
      if (/SERVIDOR QUICKCAST/.test(buf) || /Acesso Local/.test(buf)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(buf);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`O .exe encerrou com código ${code} antes de ficar pronto.\n${buf.slice(-2000)}`));
    });
  });
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (e) {}
}

async function main() {
  const fs = require('fs');
  if (!fs.existsSync(exePath)) {
    fail(`Executável não encontrado: ${exePath}. Rode npm run build:exe`);
    return;
  }

  console.log('[test-exe] Iniciando', exePath, 'na porta', PORT);
  const child = spawn(exePath, ['--no-open'], {
    env: { ...process.env, PORT, NODE_ENV: 'test' },
    cwd: path.dirname(exePath),
    windowsHide: true
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  try {
    await waitForReady(child, 25000);
    await new Promise((r) => setTimeout(r, 400));

    const checks = [
      { path: '/', test: (r) => r.status === 200 && r.body.includes('QuickCast') && r.body.includes('/js/socket.io.min.js') },
      { path: '/js/socket.io.min.js', test: (r) => r.status === 200 && r.body.includes('io') },
      { path: '/js/app.js', test: (r) => r.status === 200 && r.body.includes('fetchNetworkInfo') },
      { path: '/js/webrtc.js', test: (r) => r.status === 200 && r.body.includes('HostManager') },
      { path: '/css/style.css', test: (r) => r.status === 200 && r.body.length > 100 },
      { path: '/img/logo.svg', test: (r) => r.status === 200 },
      { path: '/api/network-info', test: (r) => r.status === 200 && JSON.parse(r.body.toString()).port === Number(PORT) },
      { path: '/api/qr?text=hello', test: (r) => r.status === 200 && JSON.parse(r.body.toString()).qr.startsWith('data:image') },
      { path: '/r/ABC123', test: (r) => r.status === 200 && r.body.includes('QuickCast') },
      { path: '/socket.io/?EIO=4&transport=polling', test: (r) => r.status === 200 && /"sid"/.test(r.body.toString()) },
    ];

    let failed = 0;
    for (const check of checks) {
      try {
        const res = await get(check.path);
        const ok = check.test(res);
        console.log(`${ok ? 'OK  ' : 'FAIL'} ${check.path}  (HTTP ${res.status}, ${res.body.length} bytes)`);
        if (!ok) failed += 1;
      } catch (err) {
        console.log(`FAIL ${check.path}  (${err.message})`);
        failed += 1;
      }
    }

    const sfuDisabled = /SFU/.test(log) && /indisponível|Não foi possível carregar/i.test(log);
    if (sfuDisabled) {
      console.log('WARN SFU não carregou no .exe — fallback P2P será usado.');
    } else {
      console.log('OK   SFU (werift) carregou sem erro no boot.');
    }

    if (failed) {
      fail(`${failed} verificação(ões) falharam.`);
      console.log('\n--- log do .exe ---\n' + log.slice(-3000));
    } else {
      console.log('\n[test-exe] Todas as funções checadas no .exe responderam como no modo de desenvolvimento.');
    }
  } catch (err) {
    fail(err.message, log.slice(-3000));
  } finally {
    killTree(child.pid);
  }
}

main();
