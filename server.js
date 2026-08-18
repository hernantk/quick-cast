const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const QRCode = require('qrcode');
const fs = require('fs');
const { SfuManager } = require('./sfu');
const { startTunnel } = require('./tunnel');

const isPackaged = typeof process.pkg !== 'undefined';
const publicDir = path.join(__dirname, 'public');

if (isPackaged) {
  try {
    process.chdir(path.dirname(process.execPath));
  } catch (e) {}
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // O cliente fica em public/js/socket.io.min.js — evita createReadStream no snapshot do pkg
  serveClient: false
});

let PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
let activeTunnel = null;
let publicTunnelUrl = null;

const PUBLIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json'
};

function sendPublicFile(relPath, res) {
  const candidate = relPath === '/' ? 'index.html' : relPath.replace(/^\/+/, '');
  if (!candidate || candidate.includes('..') || path.isAbsolute(candidate)) return false;

  const filePath = path.join(publicDir, candidate);
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', PUBLIC_MIME[ext] || 'application/octet-stream');
    res.send(fs.readFileSync(filePath));
    return true;
  } catch (e) {
    return false;
  }
}

function sendIndexHtml(res) {
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(path.join(publicDir, 'index.html')));
  } catch (e) {
    res.status(500).send('Erro ao carregar a interface do QuickCast');
  }
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    if (child) child.unref();
  } catch (e) {
    exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${url}"`, () => {});
  }
}

// Servir arquivos estáticos da pasta public
app.use(express.static(publicDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
  if (sendPublicFile(req.path, res)) return;
  next();
});
app.use(express.json());

// Função para iniciar Túnel Cloudflare
async function enableTunnel() {
  if (activeTunnel && publicTunnelUrl) return publicTunnelUrl;
  try {
    console.log('[Cloudflare] Criando túnel seguro gratuito (Cloudflare Quick Tunnel)...');
    activeTunnel = await startTunnel({ port: PORT });
    publicTunnelUrl = await activeTunnel.getURL();
    console.log('\n======================================================');
    console.log('🌐 LINK DE INTERNET ATIVO (CLOUDFLARE HTTPS):');
    console.log(`👉 ${publicTunnelUrl}`);
    console.log('======================================================\n');
    return publicTunnelUrl;
  } catch (err) {
    console.error('[Cloudflare] Erro ao criar túnel:', err.message);
    activeTunnel = null;
    publicTunnelUrl = null;
    throw err;
  }
}

// Função para desativar Túnel Cloudflare
async function disableTunnel() {
  if (activeTunnel) {
    try {
      await activeTunnel.close();
    } catch (e) {}
    activeTunnel = null;
    publicTunnelUrl = null;
    console.log('[Cloudflare] Túnel desativado.');
  }
}

// Prevenir que o fechamento do processo filho do cloudflared gere crash no Node
process.on('uncaughtException', (err) => {
  if (err && err.message && err.message.includes('cloudflared')) {
    return;
  }
  console.error('Erro não tratado:', err);
});

// Rotas de controle do Túnel
app.get('/api/tunnel/status', (req, res) => {
  res.json({
    active: !!activeTunnel,
    url: publicTunnelUrl
  });
});

app.post('/api/tunnel/start', async (req, res) => {
  try {
    const url = await enableTunnel();
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tunnel/stop', async (req, res) => {
  await disableTunnel();
  res.json({ success: true });
});

// Gerar QR Code via endpoint simples
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) {
    return res.status(400).json({ error: 'Parâmetro text é obrigatório.' });
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(text, {
      width: 280,
      margin: 2,
      color: {
        dark: '#ffffff',
        light: '#0f172a'
      }
    });
    res.json({ qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar QR code', details: err.message });
  }
});

// Endpoint com informações de rede da máquina e status da internet
app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          interface: name,
          ip: iface.address,
          url: `http://${iface.address}:${PORT}`
        });
      }
    }
  }

  res.json({
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    networkUrls: addresses,
    tunnelActive: !!activeTunnel,
    publicTunnelUrl: publicTunnelUrl
  });
});

// Redirecionamento amigável para sala
app.get('/r/:roomId', (req, res) => {
  sendIndexHtml(res);
});

// Gerenciamento de Salas em memória
const rooms = new Map();
const sfu = new SfuManager();

io.on('connection', (socket) => {
  let currentRoom = null;
  let isHost = false;

  // Host cria / registra uma sala com senha/PIN opcional
  socket.on('host:create-room', ({ roomId, pin }) => {
    if (rooms.has(roomId)) {
      const existing = rooms.get(roomId);
      if (existing.hostId && existing.hostId !== socket.id) {
        socket.emit('room:error', { message: 'Esta sala já está em uso por outro apresentador.' });
        return;
      }
    }

    currentRoom = roomId;
    isHost = true;

    rooms.set(roomId, {
      hostId: socket.id,
      pin: pin ? String(pin).trim() : null,
      viewers: new Set(),
      p2pViewers: new Set(),
      createdAt: Date.now()
    });

    socket.join(roomId);
    socket.emit('host:room-created', { roomId, isProtected: !!pin });
    console.log(`[Host] Sala criada: ${roomId} (Host: ${socket.id}, Protegida: ${!!pin})`);
  });

  // Espectador entra na sala
  socket.on('viewer:join-room', async ({ roomId, pin }) => {
    const room = rooms.get(roomId);
    if (!room || !room.hostId) {
      socket.emit('room:not-found', { message: 'Sala não encontrada ou apresentação ainda não iniciada.' });
      return;
    }

    // Validação de Senha / PIN
    if (room.pin) {
      if (!pin) {
        socket.emit('room:password-required', { roomId });
        return;
      }
      if (String(pin).trim() !== room.pin) {
        socket.emit('room:invalid-password', { message: 'Senha incorreta. Tente novamente.' });
        return;
      }
    }

    currentRoom = roomId;
    isHost = false;

    room.viewers.add(socket.id);
    socket.join(roomId);

    console.log(`[Viewer] ${socket.id} entrou na sala ${roomId}`);

    const sfuRoom = sfu.peek(roomId) || sfu.get(roomId);
    let viaSfu = false;
    try {
      viaSfu = await sfuRoom.addSubscriber(socket);
    } catch (err) {
      console.warn('[SFU] Falha ao inscrever espectador:', err.message);
    }

    if (viaSfu) {
      console.log(`[SFU] Espectador ${socket.id} inscrito na sala ${roomId}`);
    } else {
      room.p2pViewers.add(socket.id);
      io.to(room.hostId).emit('host:new-viewer', { viewerId: socket.id });
    }

    io.to(roomId).emit('room:viewers-count', { count: room.viewers.size });
  });

  socket.on('sfu:publish-offer', async ({ offer, hasAudio, hasWebcam }) => {
    if (!currentRoom || !isHost || !offer) return;
    try {
      await sfu.get(currentRoom).handlePublishOffer(socket, offer, { hasAudio, hasWebcam });
    } catch (err) {
      console.error('[SFU] Erro no publish-offer:', err);
      socket.emit('sfu:publish-error', { message: err.message });
    }
  });

  socket.on('sfu:publish-ice', async ({ candidate }) => {
    if (!currentRoom || !isHost) return;
    const room = sfu.peek(currentRoom);
    if (room) await room.handlePublisherIce(candidate);
  });

  socket.on('sfu:subscribe-answer', async ({ answer }) => {
    if (!currentRoom || !answer) return;
    const room = sfu.peek(currentRoom);
    if (room) await room.handleSubscribeAnswer(socket.id, answer);
  });

  socket.on('sfu:subscribe-ice', async ({ candidate }) => {
    if (!currentRoom) return;
    const room = sfu.peek(currentRoom);
    if (room) await room.handleSubscriberIce(socket.id, candidate);
  });

  socket.on('sfu:request-p2p', async () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
    if (room.p2pViewers.has(socket.id)) return;
    room.p2pViewers.add(socket.id);

    const sfuRoom = sfu.peek(currentRoom);
    if (sfuRoom) await sfuRoom.removeSubscriber(socket.id);

    if (room.hostId) {
      console.log(`[SFU] Fallback P2P para espectador ${socket.id} na sala ${currentRoom}`);
      io.to(room.hostId).emit('host:new-viewer', { viewerId: socket.id });
    }
  });

  // Host envia Oferta WebRTC (SDP Offer) para um espectador específico
  socket.on('signal:offer', ({ toViewerId, offer, hasWebcam }) => {
    io.to(toViewerId).emit('signal:offer', {
      fromHostId: socket.id,
      offer,
      hasWebcam
    });
  });

  // Espectador responde com Resposta WebRTC (SDP Answer) para o host
  socket.on('signal:answer', ({ toHostId, answer }) => {
    io.to(toHostId).emit('signal:answer', {
      fromViewerId: socket.id,
      answer
    });
  });

  // Troca de ICE Candidates (WebRTC ICE Candidate)
  socket.on('signal:ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('signal:ice-candidate', {
      fromId: socket.id,
      candidate
    });
  });

  // Host notifica alteração de status da Webcam (ligada/desligada)
  socket.on('host:webcam-status', ({ roomId, enabled }) => {
    if (rooms.has(roomId) && rooms.get(roomId).hostId === socket.id) {
      socket.to(roomId).emit('room:webcam-status', { enabled });
    }
  });

  // Host para de compartilhar voluntariamente
  socket.on('host:stop-sharing', async ({ roomId }) => {
    if (rooms.has(roomId) && rooms.get(roomId).hostId === socket.id) {
      io.to(roomId).emit('room:stream-ended', { message: 'A apresentação foi encerrada pelo apresentador.' });
      await sfu.close(roomId);
      rooms.delete(roomId);
      console.log(`[Host] Apresentação encerrada na sala ${roomId}`);
    }
  });

  // Desconexão
  socket.on('disconnect', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    const room = rooms.get(currentRoom);

    if (isHost && room.hostId === socket.id) {
      // Host desconectou: finaliza a sala
      io.to(currentRoom).emit('room:stream-ended', { message: 'O apresentador se desconectou.' });
      sfu.close(currentRoom).catch(() => {});
      rooms.delete(currentRoom);
      console.log(`[Host] Host desconectou da sala ${currentRoom}`);
    } else if (room.viewers.has(socket.id)) {
      // Espectador desconectou
      room.viewers.delete(socket.id);
      room.p2pViewers?.delete(socket.id);
      const sfuRoom = sfu.peek(currentRoom);
      if (sfuRoom) sfuRoom.removeSubscriber(socket.id).catch(() => {});
      if (room.hostId) {
        io.to(room.hostId).emit('host:viewer-left', { viewerId: socket.id });
      }
      io.to(currentRoom).emit('room:viewers-count', { count: room.viewers.size });
      console.log(`[Viewer] Espectador ${socket.id} saiu da sala ${currentRoom}`);
    }
  });
});

// Função para iniciar o servidor na primeira porta disponível
function startServer(portToTry) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Servidor] Porta ${portToTry} ocupada. Tentando a próxima porta disponível (${portToTry + 1})...`);
        server.removeListener('listening', onListening);
        server.removeListener('error', onError);
        resolve(startServer(portToTry + 1));
      } else {
        server.removeListener('listening', onListening);
        server.removeListener('error', onError);
        reject(err);
      }
    };

    const onListening = () => {
      server.removeListener('error', onError);
      PORT = server.address().port;
      resolve(PORT);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(portToTry);
  });
}

// Inicialização do servidor
startServer(PORT)
  .then(async (actualPort) => {
    console.log('\n======================================================');
    console.log('🚀 SERVIDOR QUICKCAST (COMPARTILHAMENTO DE TELA) INICIADO!');
    console.log('======================================================');
    console.log(`👉 Acesso Local:    http://localhost:${actualPort}`);
    
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`📱 Acesso na Rede:  http://${iface.address}:${actualPort}`);
        }
      }
    }

    // Se foi passado argumento --tunnel ou variável de ambiente TUNNEL=true
    if (process.argv.includes('--tunnel') || process.env.TUNNEL === 'true') {
      try {
        await enableTunnel();
      } catch (e) {}
    } else if (isPackaged) {
      console.log('\n💡 Dica: Clique em "Ativar Link de Internet" na interface para gerar um link público HTTPS.');
      console.log('======================================================\n');
    } else {
      console.log('\n💡 Dica: Para gerar um link público seguro na internet, execute:');
      console.log('   npm run online (ou clique no botão "🌐 Criar Link de Internet" na interface)');
      console.log('======================================================\n');
    }

    if (isPackaged) {
      console.log('[QuickCast] Rodando como executável empacotado.');
    }

    // Abrir navegador automaticamente se não for desativado via --no-open
    if (!process.argv.includes('--no-open') && process.env.NODE_ENV !== 'test') {
      const localUrl = `http://localhost:${actualPort}`;
      setTimeout(() => openBrowser(localUrl), 500);
    }
  })
  .catch((err) => {
    console.error('Erro fatal ao iniciar servidor:', err);
    process.exit(1);
  });
