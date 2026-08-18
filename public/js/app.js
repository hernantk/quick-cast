// Socket.IO e Estado da Aplicação
const socket = io();

let currentRole = null; // 'host' | 'viewer' | null
let currentRoomId = null;
let hostManager = null;
let viewerManager = null;
let currentStream = null;
let isCoverFit = false;
let isWebcamActive = false;
let publicTunnelUrl = null;
let isTunnelLoading = false;

// Elementos do DOM
const setupSection = document.getElementById('setupSection');
const streamSection = document.getElementById('streamSection');
const tabHostBtn = document.getElementById('tabHostBtn');
const tabViewerBtn = document.getElementById('tabViewerBtn');
const hostCard = document.getElementById('hostCard');
const viewerCard = document.getElementById('viewerCard');
const hostRoomInput = document.getElementById('hostRoomInput');
const hostPinInput = document.getElementById('hostPinInput');
const checkPin = document.getElementById('checkPin');
const checkWebcam = document.getElementById('checkWebcam');
const viewerRoomInput = document.getElementById('viewerRoomInput');
const viewerPinInput = document.getElementById('viewerPinInput');
const activeRoomCode = document.getElementById('activeRoomCode');
const viewersCountText = document.getElementById('viewersCountText');
const streamStatusText = document.getElementById('streamStatusText');
const mainVideo = document.getElementById('mainVideo');
const webcamVideo = document.getElementById('webcamVideo');
const webcamPip = document.getElementById('webcamPip');
const toggleWebcamBtn = document.getElementById('toggleWebcamBtn');
const webcamBtnLabel = document.getElementById('webcamBtnLabel');
const videoOverlay = document.getElementById('videoOverlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayDesc = document.getElementById('overlayDesc');
const unmuteBtn = document.getElementById('unmuteBtn');
const networkIpText = document.getElementById('networkIpText');
const exitBtnText = document.getElementById('exitBtnText');
const statsResolution = document.getElementById('statsResolution');
const qrModal = document.getElementById('qrModal');
const qrImage = document.getElementById('qrImage');
const modalRoomLink = document.getElementById('modalRoomLink');
const pinModal = document.getElementById('pinModal');
const modalPinInput = document.getElementById('modalPinInput');
const volumeSlider = document.getElementById('volumeSlider');
const volumeIcon = document.getElementById('volumeIcon');
const tunnelToggleBtn = document.getElementById('tunnelToggleBtn');
const tunnelBtnText = document.getElementById('tunnelBtnText');
const cfBannerText = document.getElementById('cfBannerText');
const cfBannerBtn = document.getElementById('cfBannerBtn');
const cfConfirmModal = document.getElementById('cfConfirmModal');

// 1. Inicialização ao carregar a página
window.addEventListener('DOMContentLoaded', async () => {
  generateRandomRoom();
  fetchNetworkInfo();
  checkUrlParams();
  setupKeyboardShortcuts();
  setupDraggablePip();
});

// Gera um ID de sala aleatório de 6 caracteres
function generateRandomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  hostRoomInput.value = result;
}

// Alterna exibição do campo de PIN no setup do Host
function togglePinInput() {
  if (checkPin.checked) {
    hostPinInput.style.display = 'block';
    hostPinInput.focus();
  } else {
    hostPinInput.style.display = 'none';
  }
}

// Busca informações de rede e status do Túnel Cloudflare
async function fetchNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    
    if (data.publicTunnelUrl) {
      publicTunnelUrl = data.publicTunnelUrl;
      updateTunnelUi(true);
    } else {
      updateTunnelUi(false);
    }

    if (data.networkUrls && data.networkUrls.length > 0) {
      const net = data.networkUrls[0];
      networkIpText.innerHTML = `Rede Wi-Fi: <b>${net.ip}:${data.port}</b>`;
    } else {
      networkIpText.innerText = `Porta: ${data.port}`;
    }
  } catch (err) {
    networkIpText.innerText = 'Online';
  }
}

// Atualiza botões e indicadores do Cloudflare Tunnel
function updateTunnelUi(isActive) {
  if (isActive && publicTunnelUrl) {
    tunnelToggleBtn.classList.add('active');
    tunnelBtnText.innerText = `🌐 Online: ${publicTunnelUrl.replace('https://', '')}`;
    if (cfBannerText) cfBannerText.innerHTML = `✅ <b>Link de Internet Ativo:</b> ${publicTunnelUrl}`;
    if (cfBannerBtn) cfBannerBtn.innerText = 'Desativar';
  } else {
    tunnelToggleBtn.classList.remove('active');
    tunnelBtnText.innerText = '🌐 Ativar Link de Internet (Cloudflare)';
    if (cfBannerText) cfBannerText.innerText = 'Quer compartilhar com quem está em outra casa/cidade?';
    if (cfBannerBtn) cfBannerBtn.innerText = 'Ativar Cloudflare';
  }
}

// Ligar / Desligar Cloudflare Tunnel via 1 clique
async function toggleCloudflareTunnel() {
  if (isTunnelLoading) return;

  if (publicTunnelUrl) {
    // Solicita confirmação antes de desativar o link público
    if (cfConfirmModal) {
      cfConfirmModal.classList.add('active');
    }
  } else {
    // Ativar túnel
    isTunnelLoading = true;
    showToast('Criando link seguro da Cloudflare... Aguarde alguns segundos.', 'info');
    tunnelBtnText.innerText = '⏳ Gerando link Cloudflare...';
    try {
      const res = await fetch('/api/tunnel/start', { method: 'POST' });
      const data = await res.json();
      if (data.success && data.url) {
        publicTunnelUrl = data.url;
        updateTunnelUi(true);
        showToast('Link de Internet criado com sucesso!', 'success');
      } else {
        throw new Error(data.error || 'Falha ao criar link');
      }
    } catch (err) {
      console.error(err);
      showToast('Erro ao iniciar Cloudflare: ' + err.message, 'error');
      updateTunnelUi(false);
    }
    isTunnelLoading = false;
  }
}

// Fechar modal de confirmação do Cloudflare
function closeCfConfirmModal(event) {
  if (!event || event.target === cfConfirmModal) {
    if (cfConfirmModal) cfConfirmModal.classList.remove('active');
  }
}

// Executa o encerramento do Cloudflare Tunnel após confirmação
async function confirmDisableTunnel() {
  closeCfConfirmModal();
  if (isTunnelLoading) return;
  isTunnelLoading = true;

  showToast('Desativando link de internet...', 'info');
  try {
    await fetch('/api/tunnel/stop', { method: 'POST' });
    publicTunnelUrl = null;
    updateTunnelUi(false);
    showToast('Link de internet desativado.', 'info');
  } catch (e) {
    showToast('Erro ao parar o túnel.', 'error');
  }

  isTunnelLoading = false;
}

// Verifica se há sala na URL (?room=XYZ ou /r/XYZ)
function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  let room = urlParams.get('room');
  
  if (!room && window.location.pathname.startsWith('/r/')) {
    room = window.location.pathname.replace('/r/', '').trim();
  }

  if (room) {
    switchTab('viewer');
    viewerRoomInput.value = room.toUpperCase();
    showToast(`Sala ${room.toUpperCase()} detectada no link!`, 'info');
  }
}

// Alternar entre abas Host e Viewer
function switchTab(tab) {
  if (tab === 'host') {
    tabHostBtn.classList.add('active');
    tabViewerBtn.classList.remove('active');
    hostCard.style.display = 'flex';
    viewerCard.style.display = 'none';
  } else {
    tabViewerBtn.classList.add('active');
    tabHostBtn.classList.remove('active');
    viewerCard.style.display = 'flex';
    hostCard.style.display = 'none';
  }
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  const icon = type === 'error' ? '⚠️' : (type === 'success' ? '✅' : 'ℹ️');
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// -------------------------------------------------------------
// FLUXO DO APRESENTADOR (HOST)
// -------------------------------------------------------------
async function startHostStream() {
  const roomId = (hostRoomInput.value || '').trim().toUpperCase();
  if (!roomId) {
    showToast('Por favor, informe um código para a sala.', 'error');
    return;
  }

  const quality = document.getElementById('qualitySelect').value;
  const includeAudio = document.getElementById('checkAudio').checked;
  const includeMic = document.getElementById('checkMic').checked;
  const includeWebcam = checkWebcam.checked;
  const pin = (checkPin.checked ? hostPinInput.value : '').trim();

  try {
    hostManager = new HostManager(
      socket,
      (screenStream) => {
        currentStream = screenStream;
        mainVideo.srcObject = screenStream;
        mainVideo.muted = true;
        mainVideo.play().catch(console.error);

        currentRole = 'host';
        currentRoomId = roomId;

        setupSection.style.display = 'none';
        streamSection.classList.add('active');
        activeRoomCode.innerText = roomId;
        exitBtnText.innerText = 'Encerrar Transmissão';
        streamStatusText.innerText = 'TRANSMITINDO AO VIVO';
        videoOverlay.classList.add('hidden');
        toggleWebcamBtn.style.display = 'inline-flex';

        updateVideoStats();

        // Notifica o servidor para registrar a sala com PIN opcional
        socket.emit('host:create-room', { roomId, pin });
        hostManager.publishToSfu().catch((err) => {
          console.warn('[SFU] Publicação falhou, espectadores usarão P2P:', err);
        });
        showToast('Transmissão iniciada com sucesso!', 'success');
      },
      (webcamStream) => {
        if (webcamStream) {
          isWebcamActive = true;
          webcamVideo.srcObject = webcamStream;
          webcamPip.classList.add('active');
          webcamBtnLabel.innerText = 'Webcam Ativa';
          toggleWebcamBtn.classList.add('active');
          socket.emit('host:webcam-status', { roomId: currentRoomId, enabled: true });
        } else {
          isWebcamActive = false;
          webcamVideo.srcObject = null;
          webcamPip.classList.remove('active');
          webcamBtnLabel.innerText = 'Webcam Desligada';
          toggleWebcamBtn.classList.remove('active');
          socket.emit('host:webcam-status', { roomId: currentRoomId, enabled: false });
        }
      },
      () => {
        handleExitStream();
      }
    );

    await hostManager.startCapture({ quality, includeAudio, includeMic, includeWebcam });

  } catch (err) {
    console.error('Erro ao iniciar stream:', err);
    if (err.name === 'NotAllowedError' || err.message?.includes('Permission denied')) {
      showToast('Permissão de captura de tela cancelada pelo usuário.', 'info');
    } else {
      showToast('Erro ao iniciar transmissão: ' + (err.message || err), 'error');
    }
  }
}

// Alternar Webcam ao vivo durante a transmissão (Host)
async function toggleLiveWebcam() {
  if (!hostManager) return;
  if (isWebcamActive) {
    hostManager.stopWebcam();
    showToast('Webcam desativada.', 'info');
  } else {
    try {
      await hostManager.startWebcam();
      showToast('Webcam ativada!', 'success');
    } catch (e) {
      showToast('Não foi possível ativar a webcam.', 'error');
    }
  }
}

// -------------------------------------------------------------
// FLUXO DO ESPECTADOR (VIEWER)
// -------------------------------------------------------------
function joinViewerStream(overridePin = null) {
  let inputVal = (viewerRoomInput.value || '').trim();
  if (!inputVal) {
    showToast('Informe o código ou link da sala.', 'error');
    return;
  }

  let roomId = inputVal;
  if (inputVal.includes('room=')) {
    roomId = new URL(inputVal, window.location.origin).searchParams.get('room') || inputVal;
  } else if (inputVal.includes('/r/')) {
    roomId = inputVal.split('/r/')[1].split('?')[0].split('#')[0];
  }
  roomId = roomId.toUpperCase().trim();

  const pin = overridePin !== null ? overridePin : (viewerPinInput.value || '').trim();

  currentRole = 'viewer';
  currentRoomId = roomId;

  setupSection.style.display = 'none';
  streamSection.classList.add('active');
  activeRoomCode.innerText = roomId;
  exitBtnText.innerText = 'Sair da Sala';
  streamStatusText.innerText = 'CONECTANDO...';
  toggleWebcamBtn.style.display = 'none';

  videoOverlay.classList.remove('hidden');
  overlayTitle.innerText = 'Conectando à transmissão...';
  overlayDesc.innerText = `Aguardando sinal WebRTC da sala ${roomId}...`;
  unmuteBtn.style.display = 'none';

  viewerManager = new ViewerManager(
    socket,
    (screenStream) => {
      currentStream = screenStream;
      mainVideo.srcObject = screenStream;
      mainVideo.muted = false;

      mainVideo.play().then(() => {
        videoOverlay.classList.add('hidden');
        streamStatusText.innerText = 'AO VIVO';
        showToast('Conectado à transmissão!', 'success');
      }).catch((err) => {
        console.warn('Autoplay com áudio bloqueado pelo navegador:', err);
        videoOverlay.classList.remove('hidden');
        overlayTitle.innerText = 'Transmissão Pronta';
        overlayDesc.innerText = 'Clique abaixo para liberar o vídeo com áudio.';
        unmuteBtn.style.display = 'inline-flex';
      });

      updateVideoStats();
    },
    (webcamStream) => {
      console.log('[Viewer] Faixa de webcam do apresentador recebida!');
      webcamVideo.srcObject = webcamStream;
      webcamPip.classList.add('active');
      webcamVideo.play().catch(console.error);
    },
    (connectionState) => {
      if (connectionState === 'connected') {
        streamStatusText.innerText = 'AO VIVO';
      } else if (connectionState === 'disconnected' || connectionState === 'failed') {
        streamStatusText.innerText = 'DESCONECTADO';
        showToast('Conexão perdida com o apresentador.', 'error');
      }
    }
  );

  socket.emit('viewer:join-room', { roomId, pin });
}

function unmuteVideo() {
  mainVideo.muted = false;
  mainVideo.play().then(() => {
    videoOverlay.classList.add('hidden');
    unmuteBtn.style.display = 'none';
    streamStatusText.innerText = 'AO VIVO';
  }).catch(console.error);
}

// -------------------------------------------------------------
// EVENTOS DO SOCKET.IO
// -------------------------------------------------------------
socket.on('host:new-viewer', ({ viewerId }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.addViewer(viewerId);
    showToast('Novo espectador conectado!', 'info');
  }
});

socket.on('host:viewer-left', ({ viewerId }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.removeViewer(viewerId);
  }
});

socket.on('signal:offer', ({ fromHostId, offer, hasWebcam }) => {
  if (currentRole === 'viewer' && viewerManager) {
    viewerManager.handleOffer(fromHostId, offer, hasWebcam);
  }
});

socket.on('signal:answer', ({ fromViewerId, answer }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.handleAnswer(fromViewerId, answer);
  }
});

socket.on('signal:ice-candidate', ({ fromId, candidate }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.handleIceCandidate(fromId, candidate);
  } else if (currentRole === 'viewer' && viewerManager) {
    viewerManager.handleIceCandidate(candidate);
  }
});

socket.on('sfu:publish-answer', ({ answer }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.handleSfuAnswer(answer);
  }
});

socket.on('sfu:publish-ice', ({ candidate }) => {
  if (currentRole === 'host' && hostManager) {
    hostManager.handleSfuIce(candidate);
  }
});

socket.on('sfu:publish-error', ({ message }) => {
  console.warn('[SFU] Erro no servidor:', message);
});

socket.on('sfu:subscribe-offer', ({ offer, hasWebcam }) => {
  if (currentRole === 'viewer' && viewerManager) {
    viewerManager.handleOffer('sfu', offer, hasWebcam);
  }
});

socket.on('sfu:subscribe-ice', ({ candidate }) => {
  if (currentRole === 'viewer' && viewerManager) {
    viewerManager.handleIceCandidate(candidate);
  }
});

socket.on('room:webcam-status', ({ enabled }) => {
  if (currentRole === 'viewer') {
    if (enabled) {
      webcamPip.classList.add('active');
    } else {
      webcamPip.classList.remove('active');
    }
  }
});

socket.on('room:viewers-count', ({ count }) => {
  viewersCountText.innerText = `${count} ${count === 1 ? 'espectador' : 'espectadores'}`;
});

socket.on('room:password-required', () => {
  pinModal.classList.add('active');
  modalPinInput.value = '';
  modalPinInput.focus();
});

socket.on('room:invalid-password', ({ message }) => {
  showToast(message, 'error');
  pinModal.classList.add('active');
  modalPinInput.select();
});

socket.on('room:not-found', ({ message }) => {
  showToast(message, 'error');
  handleExitStream();
});

socket.on('room:stream-ended', ({ message }) => {
  showToast(message, 'info');
  if (currentRole === 'viewer') {
    videoOverlay.classList.remove('hidden');
    overlayTitle.innerText = 'Transmissão Encerrada';
    overlayDesc.innerText = message;
    unmuteBtn.style.display = 'none';
    webcamPip.classList.remove('active');
  }
});

socket.on('room:error', ({ message }) => {
  showToast(message, 'error');
  handleExitStream();
});

// -------------------------------------------------------------
// MODAL DE PIN / SENHA
// -------------------------------------------------------------
function submitPinModal() {
  const pin = modalPinInput.value.trim();
  if (!pin) {
    showToast('Digite a senha para prosseguir.', 'error');
    return;
  }
  pinModal.classList.remove('active');
  socket.emit('viewer:join-room', { roomId: currentRoomId, pin });
}

function cancelPinModal() {
  pinModal.classList.remove('active');
  handleExitStream();
}

// -------------------------------------------------------------
// CONTROLES DE STREAM & RECURSOS
// -------------------------------------------------------------
function handleExitStream() {
  if (currentRole === 'host' && hostManager) {
    socket.emit('host:stop-sharing', { roomId: currentRoomId });
    hostManager.stopCapture();
    hostManager = null;
  } else if (currentRole === 'viewer' && viewerManager) {
    viewerManager.leave();
    viewerManager = null;
  }

  currentRole = null;
  currentRoomId = null;
  currentStream = null;
  isWebcamActive = false;

  mainVideo.srcObject = null;
  webcamVideo.srcObject = null;
  webcamPip.classList.remove('active');
  streamSection.classList.remove('active');
  setupSection.style.display = 'block';
  videoOverlay.classList.add('hidden');
}

function updateVideoStats() {
  if (!mainVideo) return;
  mainVideo.onloadedmetadata = () => {
    const w = mainVideo.videoWidth;
    const h = mainVideo.videoHeight;
    if (w && h) {
      statsResolution.innerText = `${w}x${h}`;
    }
  };
}

// Link de compartilhamento (usa Cloudflare URL pública se estiver ativo!)
function getShareUrl() {
  const base = publicTunnelUrl || window.location.origin;
  return `${base}/?room=${currentRoomId}`;
}

async function copyShareLink() {
  if (!currentRoomId) return;
  const link = getShareUrl();
  try {
    await navigator.clipboard.writeText(link);
    showToast('Link de compartilhamento copiado!', 'success');
  } catch (err) {
    const input = document.createElement('input');
    input.value = link;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Link de compartilhamento copiado!', 'success');
  }
}

// Modal do QR Code
async function openQrModal() {
  if (!currentRoomId) return;
  const link = getShareUrl();
  modalRoomLink.innerText = link;
  
  try {
    const res = await fetch(`/api/qr?text=${encodeURIComponent(link)}`);
    const data = await res.json();
    if (data.qr) {
      qrImage.src = data.qr;
      qrModal.classList.add('active');
    }
  } catch (err) {
    showToast('Não foi possível gerar o QR Code.', 'error');
  }
}

function closeQrModal(event) {
  if (!event || event.target === qrModal) {
    qrModal.classList.remove('active');
  }
}

// Controles de Player
function toggleFullscreen() {
  const wrapper = document.getElementById('videoWrapper');
  if (!document.fullscreenElement) {
    wrapper.requestFullscreen().catch(console.error);
  } else {
    document.exitFullscreen().catch(console.error);
  }
}

async function togglePictureInPicture() {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
  } else if (document.pictureInPictureEnabled && mainVideo) {
    await mainVideo.requestPictureInPicture();
  }
}

function toggleFitMode() {
  isCoverFit = !isCoverFit;
  if (isCoverFit) {
    mainVideo.classList.add('cover');
    showToast('Modo: Preencher Tela', 'info');
  } else {
    mainVideo.classList.remove('cover');
    showToast('Modo: Ajustar Proporção', 'info');
  }
}

function changeVolume(val) {
  mainVideo.volume = parseFloat(val);
  mainVideo.muted = (mainVideo.volume === 0);
  updateVolumeIcon();
}

function toggleAudioMute() {
  mainVideo.muted = !mainVideo.muted;
  if (!mainVideo.muted && mainVideo.volume === 0) {
    mainVideo.volume = 1;
    volumeSlider.value = 1;
  }
  updateVolumeIcon();
}

function updateVolumeIcon() {
  if (mainVideo.muted || mainVideo.volume === 0) {
    volumeIcon.innerHTML = `
      <line x1="1" y1="1" x2="23" y2="23"></line>
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
    `;
  } else {
    volumeIcon.innerHTML = `
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    `;
  }
}

// Atalhos de teclado
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'f' || e.key === 'F') {
      toggleFullscreen();
    } else if (e.key === 'p' || e.key === 'P') {
      togglePictureInPicture();
    } else if (e.key === 'm' || e.key === 'M') {
      toggleAudioMute();
    }
  });

  modalPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPinModal();
  });
}

// Torna o card flutuante da Webcam arrastável sobre a tela
function setupDraggablePip() {
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  webcamPip.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = webcamPip.getBoundingClientRect();
    const parentRect = document.getElementById('videoWrapper').getBoundingClientRect();
    
    initialLeft = rect.left - parentRect.left;
    initialTop = rect.top - parentRect.top;
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    webcamPip.style.left = `${initialLeft + dx}px`;
    webcamPip.style.top = `${initialTop + dy}px`;
    webcamPip.style.right = 'auto';
    webcamPip.style.bottom = 'auto';
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });
}
