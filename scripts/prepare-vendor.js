const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
const destDir = path.join(__dirname, '..', 'public', 'js');
const dest = path.join(destDir, 'socket.io.min.js');

if (!fs.existsSync(src)) {
  console.error('[prepare-vendor] socket.io.min.js não encontrado. Rode npm install.');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('[prepare-vendor] Cliente Socket.IO copiado para public/js/socket.io.min.js');
