// Configuração WebRTC, STUN Servers (Cloudflare + Google) e Otimizações de Latência
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 2,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Perfis de qualidade de vídeo da tela (captura)
const QUALITY_PROFILES = {
  '1080p60': {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1080p30': {
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
    frameRate: { ideal: 30, max: 30 }
  },
  '720p30': {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 }
  },
  '4k30': {
    width: { ideal: 3840, max: 3840 },
    height: { ideal: 2160, max: 2160 },
    frameRate: { ideal: 30, max: 30 }
  }
};

// Limites de encoding: mesma resolução/FPS, bem menos banda que o default do Chrome (10–25 Mbps)
const ENCODING_PROFILES = {
  '1080p60': {
    maxBitrate: 6_500_000,
    maxFramerate: 60,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate'
  },
  '1080p30': {
    maxBitrate: 3_500_000,
    maxFramerate: 30,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '720p30': {
    maxBitrate: 1_800_000,
    maxFramerate: 30,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '4k30': {
    maxBitrate: 10_000_000,
    maxFramerate: 30,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  }
};

const AUDIO_MAX_BITRATE = 128_000;
const WEBCAM_MAX_BITRATE = 350_000;
const WEBCAM_MAX_FRAMERATE = 15;
const VIDEO_CODEC_PREFERENCE = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];

function getEncodingProfile(quality) {
  return ENCODING_PROFILES[quality] || ENCODING_PROFILES['1080p60'];
}

function setTrackContentHint(track, hint) {
  if (track && 'contentHint' in track) {
    try {
      track.contentHint = hint;
    } catch (e) {}
  }
}

function preferEfficientVideoCodecs(peer) {
  if (!peer || typeof peer.getTransceivers !== 'function') return;
  if (typeof RTCRtpSender.getCapabilities !== 'function') return;

  try {
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps?.codecs?.length) return;

    const preferred = [];
    const others = [];

    for (const codec of caps.codecs) {
      const mime = codec.mimeType.toLowerCase();
      const prefIndex = VIDEO_CODEC_PREFERENCE.findIndex((p) => mime === p.toLowerCase());
      if (prefIndex !== -1) {
        preferred.push({ codec, prefIndex });
      } else {
        others.push(codec);
      }
    }

    preferred.sort((a, b) => a.prefIndex - b.prefIndex);
    const ordered = [...preferred.map((p) => p.codec), ...others];

    peer.getTransceivers().forEach((transceiver) => {
      const kind = transceiver.sender?.track?.kind || transceiver.receiver?.track?.kind;
      if (kind === 'audio') return;
      try {
        if (typeof transceiver.setCodecPreferences === 'function') {
          transceiver.setCodecPreferences(ordered);
        }
      } catch (err) {
        console.warn('[WebRTC] Preferência de codec ignorada:', err.message);
      }
    });
  } catch (err) {
    console.warn('[WebRTC] setCodecPreferences erro ignorado:', err.message);
  }
}

async function applySenderParams(sender, { maxBitrate, maxFramerate, degradationPreference } = {}) {
  if (!sender) return;

  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    params.encodings.forEach((enc) => {
      if (maxBitrate) enc.maxBitrate = maxBitrate;
      if (maxFramerate) enc.maxFramerate = maxFramerate;
    });

    if (degradationPreference) {
      params.degradationPreference = degradationPreference;
    }

    await sender.setParameters(params);
  } catch (err) {
    console.warn('[WebRTC] Encoding não aplicado:', err.message);
  }
}

/**
 * Classe responsável pelo Apresentador (Host)
 */
class HostManager {
  constructor(socket, onStreamReady, onWebcamReady, onStreamEnded) {
    this.socket = socket;
    this.onStreamReady = onStreamReady;
    this.onWebcamReady = onWebcamReady;
    this.onStreamEnded = onStreamEnded;
    this.screenStream = null;
    this.webcamStream = null;
    this.micStream = null;
    this.audioContext = null;
    this.quality = '1080p60';
    this.sfuPeer = null;
    this.sfuSenders = {};
    this.sfuReady = false;
    this.peers = new Map(); // viewerId -> RTCPeerConnection (fallback P2P)
    this.peerSenders = new Map(); // viewerId -> { screenTrack, audioTrack, webcamTrack }
  }

  async applyPeerEncoding(viewerId) {
    const senders = this.peerSenders.get(viewerId);
    if (!senders) return;

    const encoding = getEncodingProfile(this.quality);
    await applySenderParams(senders.screenSender, encoding);
    await applySenderParams(senders.audioSender, { maxBitrate: AUDIO_MAX_BITRATE });
    await applySenderParams(senders.webcamSender, {
      maxBitrate: WEBCAM_MAX_BITRATE,
      maxFramerate: WEBCAM_MAX_FRAMERATE,
      degradationPreference: 'maintain-framerate'
    });
  }

  async applySfuEncoding() {
    if (!this.sfuPeer) return;
    const encoding = getEncodingProfile(this.quality);
    await applySenderParams(this.sfuSenders.screenSender, encoding);
    await applySenderParams(this.sfuSenders.audioSender, { maxBitrate: AUDIO_MAX_BITRATE });
    await applySenderParams(this.sfuSenders.webcamSender, {
      maxBitrate: WEBCAM_MAX_BITRATE,
      maxFramerate: WEBCAM_MAX_FRAMERATE,
      degradationPreference: 'maintain-framerate'
    });
  }

  async publishToSfu() {
    if (!this.screenStream) return;

    if (this.sfuPeer) {
      try {
        this.sfuPeer.close();
      } catch (e) {}
    }

    this.sfuReady = false;
    this.sfuSenders = {};
    this.sfuPeer = new RTCPeerConnection(rtcConfig);

    this.screenStream.getTracks().forEach((track) => {
      const sender = this.sfuPeer.addTrack(track, this.screenStream);
      if (track.kind === 'video') this.sfuSenders.screenSender = sender;
      if (track.kind === 'audio') this.sfuSenders.audioSender = sender;
    });

    if (this.webcamStream) {
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      if (webcamTrack) {
        this.sfuSenders.webcamSender = this.sfuPeer.addTrack(webcamTrack, this.webcamStream);
      }
    }

    preferEfficientVideoCodecs(this.sfuPeer);
    await this.applySfuEncoding();

    this.sfuPeer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('sfu:publish-ice', { candidate: event.candidate });
      }
    };

    this.sfuPeer.onconnectionstatechange = () => {
      const state = this.sfuPeer?.connectionState;
      console.log('[SFU] Publisher:', state);
      if (state === 'connected') {
        this.sfuReady = true;
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.sfuReady = false;
      }
    };

    const offer = await this.sfuPeer.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false
    });
    await this.sfuPeer.setLocalDescription(offer);
    await this.applySfuEncoding();

    this.socket.emit('sfu:publish-offer', {
      offer,
      hasAudio: this.screenStream.getAudioTracks().length > 0,
      hasWebcam: !!this.webcamStream
    });
  }

  async handleSfuAnswer(answer) {
    if (!this.sfuPeer || !answer) return;
    await this.sfuPeer.setRemoteDescription(new RTCSessionDescription(answer));
    this.sfuReady = true;
  }

  async handleSfuIce(candidate) {
    if (!this.sfuPeer || !candidate) return;
    try {
      await this.sfuPeer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[SFU] ICE do servidor ignorado:', err.message);
    }
  }

  async renegotiateSfu() {
    if (!this.sfuPeer || this.sfuPeer.signalingState === 'closed') return;
    preferEfficientVideoCodecs(this.sfuPeer);
    const offer = await this.sfuPeer.createOffer();
    await this.sfuPeer.setLocalDescription(offer);
    await this.applySfuEncoding();
    this.socket.emit('sfu:publish-offer', {
      offer,
      hasAudio: this.screenStream?.getAudioTracks().length > 0,
      hasWebcam: !!this.webcamStream
    });
  }

  async startCapture({ quality = '1080p60', includeAudio = true, includeMic = false, includeWebcam = false }) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      if (!window.isSecureContext) {
        throw new Error('O navegador bloqueia o compartilhamento de tela em conexões HTTP sem SSL. Acesse pelo endereço "http://localhost:' + (location.port || '8900') + '" ou utilize HTTPS.');
      }
      throw new Error('Seu navegador não suporta compartilhamento de tela (getDisplayMedia). Utilize Google Chrome, Microsoft Edge, Firefox, Brave ou Opera.');
    }

    this.quality = quality;
    const videoConstraints = QUALITY_PROFILES[quality] || QUALITY_PROFILES['1080p60'];
    const encoding = getEncodingProfile(quality);

    try {
      let displayStream;
      try {
        // 1. Capturar Tela com áudio avançado e exclusão de superfície própria
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            ...videoConstraints,
            cursor: 'always'
          },
          audio: includeAudio ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000
          } : false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: includeAudio ? 'include' : 'exclude',
          preferCurrentTab: false
        });
      } catch (captureErr) {
        if (captureErr.name === 'NotAllowedError') {
          throw captureErr;
        }
        console.warn('Captura padrão falhou, tentando fallback com configurações básicas:', captureErr);
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              ...videoConstraints,
              cursor: 'always'
            },
            audio: !!includeAudio,
            selfBrowserSurface: 'exclude',
            surfaceSwitching: 'include',
            systemAudio: includeAudio ? 'include' : 'exclude'
          });
        } catch (fallbackErr) {
          if (fallbackErr.name === 'NotAllowedError') {
            throw fallbackErr;
          }
          // Fallback final: apenas vídeo sem constraints rígidas
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false
          });
        }
      }

      // 2. Mix de Áudio (se Microfone estiver ativo)
      let mixedAudioStream = null;
      if (includeMic) {
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
          this.micStream.getAudioTracks().forEach((track) => setTrackContentHint(track, 'speech'));

          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const dest = this.audioContext.createMediaStreamDestination();

          if (displayStream.getAudioTracks().length > 0) {
            const displaySource = this.audioContext.createMediaStreamSource(displayStream);
            displaySource.connect(dest);
          }

          const micSource = this.audioContext.createMediaStreamSource(this.micStream);
          micSource.connect(dest);

          mixedAudioStream = dest.stream;
        } catch (micErr) {
          console.warn('Não foi possível acessar o microfone:', micErr);
        }
      }

      // Monta Stream Principal da Tela
      this.screenStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...(mixedAudioStream ? mixedAudioStream.getAudioTracks() : displayStream.getAudioTracks())
      ]);

      // 3. Capturar Webcam se selecionada
      if (includeWebcam) {
        await this.startWebcam();
      }

      const videoTrack = displayStream.getVideoTracks()[0];
      if (videoTrack) {
        setTrackContentHint(videoTrack, encoding.contentHint);
        videoTrack.onended = () => {
          this.stopCapture();
        };
      }

      displayStream.getAudioTracks().forEach((track) => setTrackContentHint(track, 'music'));
      this.screenStream.getAudioTracks().forEach((track) => {
        setTrackContentHint(track, includeAudio ? 'music' : 'speech');
      });

      if (this.onStreamReady) {
        this.onStreamReady(this.screenStream);
      }

      return this.screenStream;
    } catch (err) {
      console.error('Erro ao iniciar captura:', err);
      throw err;
    }
  }

  async startWebcam() {
    try {
      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 480, max: 640 },
          height: { ideal: 270, max: 360 },
          frameRate: { ideal: 15, max: 24 }
        },
        audio: false
      });

      this.webcamStream.getVideoTracks().forEach((track) => setTrackContentHint(track, 'motion'));

      if (this.onWebcamReady) {
        this.onWebcamReady(this.webcamStream);
      }

      // Atualiza os peers já conectados (fallback P2P)
      this.peers.forEach((peer, viewerId) => {
        const webcamTrack = this.webcamStream.getVideoTracks()[0];
        if (webcamTrack) {
          const sender = peer.addTrack(webcamTrack, this.webcamStream);
          if (!this.peerSenders.has(viewerId)) this.peerSenders.set(viewerId, {});
          this.peerSenders.get(viewerId).webcamSender = sender;
          applySenderParams(sender, {
            maxBitrate: WEBCAM_MAX_BITRATE,
            maxFramerate: WEBCAM_MAX_FRAMERATE,
            degradationPreference: 'maintain-framerate'
          });
        }
      });

      if (this.sfuPeer && this.webcamStream) {
        const webcamTrack = this.webcamStream.getVideoTracks()[0];
        if (webcamTrack && !this.sfuSenders.webcamSender) {
          this.sfuSenders.webcamSender = this.sfuPeer.addTrack(webcamTrack, this.webcamStream);
          await this.renegotiateSfu();
        }
      }

      return this.webcamStream;
    } catch (err) {
      console.warn('Erro ao acessar webcam:', err);
      return null;
    }
  }

  stopWebcam() {
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach(t => t.stop());
      this.webcamStream = null;
    }

    // Remove tracks dos peers
    this.peers.forEach((peer, viewerId) => {
      const senders = this.peerSenders.get(viewerId);
      if (senders && senders.webcamSender) {
        try {
          peer.removeTrack(senders.webcamSender);
        } catch (e) {}
        senders.webcamSender = null;
      }
    });

    if (this.onWebcamReady) {
      this.onWebcamReady(null);
    }
  }

  // Cria conexão WebRTC para um espectador
  async addViewer(viewerId) {
    if (!this.screenStream) return;

    console.log(`[WebRTC] Adicionando espectador ${viewerId}`);
    const peer = new RTCPeerConnection(rtcConfig);
    this.peers.set(viewerId, peer);
    this.peerSenders.set(viewerId, {});

    // 1. Adiciona faixas de tela e áudio
    this.screenStream.getTracks().forEach((track) => {
      const sender = peer.addTrack(track, this.screenStream);
      if (track.kind === 'video') this.peerSenders.get(viewerId).screenSender = sender;
      if (track.kind === 'audio') this.peerSenders.get(viewerId).audioSender = sender;
    });

    // 2. Adiciona faixa da webcam se ativa
    if (this.webcamStream) {
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      if (webcamTrack) {
        const sender = peer.addTrack(webcamTrack, this.webcamStream);
        this.peerSenders.get(viewerId).webcamSender = sender;
      }
    }

    preferEfficientVideoCodecs(peer);
    await this.applyPeerEncoding(viewerId);

    // ICE Candidates
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal:ice-candidate', {
          targetId: viewerId,
          candidate: event.candidate
        });
      }
    };

    // Cria Oferta
    try {
      const offer = await peer.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      await peer.setLocalDescription(offer);
      await this.applyPeerEncoding(viewerId);

      this.socket.emit('signal:offer', {
        toViewerId: viewerId,
        offer,
        hasWebcam: !!this.webcamStream
      });
    } catch (err) {
      console.error(`Erro ao criar oferta para ${viewerId}:`, err);
    }
  }

  async handleAnswer(viewerId, answer) {
    const peer = this.peers.get(viewerId);
    if (peer) {
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async handleIceCandidate(viewerId, candidate) {
    const peer = this.peers.get(viewerId);
    if (peer && candidate) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Erro ao adicionar ICE candidate no Host:', err);
      }
    }
  }

  removeViewer(viewerId) {
    const peer = this.peers.get(viewerId);
    if (peer) {
      peer.close();
      this.peers.delete(viewerId);
      this.peerSenders.delete(viewerId);
    }
  }

  stopCapture() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    this.stopWebcam();

    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.peers.forEach(peer => peer.close());
    this.peers.clear();
    this.peerSenders.clear();

    if (this.sfuPeer) {
      try {
        this.sfuPeer.close();
      } catch (e) {}
      this.sfuPeer = null;
      this.sfuSenders = {};
      this.sfuReady = false;
    }

    if (this.onStreamEnded) {
      this.onStreamEnded();
    }
  }
}

/**
 * Classe responsável pelo Espectador (Viewer)
 */
class ViewerManager {
  constructor(socket, onScreenTrackReceived, onWebcamTrackReceived, onConnectionStateChange) {
    this.socket = socket;
    this.onScreenTrackReceived = onScreenTrackReceived;
    this.onWebcamTrackReceived = onWebcamTrackReceived;
    this.onConnectionStateChange = onConnectionStateChange;
    this.peer = null;
    this.hostId = null;
    this.signalingTarget = 'p2p';
    this.fallbackTimer = null;
    this.p2pRequested = false;
    this.screenStream = new MediaStream();
    this.webcamStream = new MediaStream();
    this.videoTracksCount = 0;
  }

  clearFallbackTimer() {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  requestP2pFallback() {
    if (this.p2pRequested || this.signalingTarget !== 'sfu') return;
    if (this.screenStream.getVideoTracks().length > 0) return;
    this.p2pRequested = true;
    this.clearFallbackTimer();
    console.warn('[SFU] Falha de conexão, pedindo fallback P2P');
    this.socket.emit('sfu:request-p2p');
  }

  emitIce(candidate) {
    if (this.signalingTarget === 'sfu') {
      this.socket.emit('sfu:subscribe-ice', { candidate });
    } else if (this.hostId) {
      this.socket.emit('signal:ice-candidate', {
        targetId: this.hostId,
        candidate
      });
    }
  }

  emitAnswer(answer) {
    if (this.signalingTarget === 'sfu') {
      this.socket.emit('sfu:subscribe-answer', { answer });
    } else {
      this.socket.emit('signal:answer', {
        toHostId: this.hostId,
        answer
      });
    }
  }

  wirePeer() {
    this.peer.ontrack = (event) => {
      console.log('[WebRTC Viewer] Track recebida:', event.track.kind, event.streams[0]?.id);

      // Otimização de Latência Zero (Jitter Buffer mínimo / Playout instantâneo)
      if (event.receiver) {
        try {
          if ('jitterBufferTarget' in event.receiver) {
            event.receiver.jitterBufferTarget = 0;
          }
        } catch (e) {}
        try {
          if ('playoutDelayHint' in event.receiver) {
            event.receiver.playoutDelayHint = 0;
          }
        } catch (e) {}
      }

      if (event.track.kind === 'audio') {
        if (![...this.screenStream.getAudioTracks()].some((t) => t.id === event.track.id)) {
          this.screenStream.addTrack(event.track);
        }
        if (this.onScreenTrackReceived) {
          this.onScreenTrackReceived(this.screenStream);
        }
      } else if (event.track.kind === 'video') {
        this.videoTracksCount++;

        if (this.videoTracksCount === 1) {
          this.screenStream.addTrack(event.track);
          if (this.onScreenTrackReceived) {
            this.onScreenTrackReceived(this.screenStream);
          }
        } else {
          this.webcamStream.addTrack(event.track);
          if (this.onWebcamTrackReceived) {
            this.onWebcamTrackReceived(this.webcamStream);
          }
        }
      }
    };

    this.peer.onicecandidate = (event) => {
      if (event.candidate) this.emitIce(event.candidate);
    };

    this.peer.onconnectionstatechange = () => {
      const state = this.peer?.connectionState;
      if (state === 'connected') {
        this.clearFallbackTimer();
      } else if (state === 'failed') {
        this.requestP2pFallback();
      }
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };
  }

  async handleOffer(fromHostId, offer, hasWebcam) {
    const viaSfu = fromHostId === 'sfu';
    this.hostId = fromHostId;
    this.signalingTarget = viaSfu ? 'sfu' : 'p2p';

    if (!viaSfu) {
      this.p2pRequested = true;
      this.clearFallbackTimer();
    }

    const reusePeer = viaSfu && this.peer && this.peer.signalingState !== 'closed' && this.signalingTarget === 'sfu';

    if (!reusePeer) {
      if (this.peer) {
        try {
          this.peer.close();
        } catch (e) {}
      }

      this.videoTracksCount = 0;
      this.peer = new RTCPeerConnection(rtcConfig);
      this.screenStream = new MediaStream();
      this.webcamStream = new MediaStream();
      this.wirePeer();
    }

    await this.peer.setRemoteDescription(new RTCSessionDescription(offer));
    preferEfficientVideoCodecs(this.peer);

    if (typeof this.peer.getReceivers === 'function') {
      this.peer.getReceivers().forEach((receiver) => {
        try {
          if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
        } catch (e) {}
        try {
          if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
        } catch (e) {}
      });
    }

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    this.emitAnswer(answer);

    if (viaSfu && !this.p2pRequested) {
      this.clearFallbackTimer();
      this.fallbackTimer = setTimeout(() => {
        if (this.peer?.connectionState !== 'connected') {
          this.requestP2pFallback();
        }
      }, 8000);
    }
  }

  async handleIceCandidate(candidate) {
    if (this.peer && candidate) {
      try {
        await this.peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Erro ao adicionar ICE candidate no Viewer:', err);
      }
    }
  }

  leave() {
    this.clearFallbackTimer();
    this.p2pRequested = false;
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    this.hostId = null;
    this.signalingTarget = 'p2p';
  }
}
