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
  // Pre-coleta candidatos antes da oferta: encurta o handshake ICE.
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Perfis de qualidade de vídeo da tela (captura)
const QUALITY_PROFILES = {
  '1080p60_ultra': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1080p60': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 }
  },
  '1080p30': {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 }
  },
  '2k60': {
    width: { ideal: 2560 },
    height: { ideal: 1440 },
    frameRate: { ideal: 60, max: 60 }
  },
  '4k30': {
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    frameRate: { ideal: 30, max: 30 }
  },
  '720p60': {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 60, max: 60 }
  },
  '720p30': {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 }
  }
};

// Limites de encoding: resolução, FPS, bitrate e preferências de degradação
const ENCODING_PROFILES = {
  '1080p60_ultra': {
    maxBitrate: 14_000_000,
    maxFramerate: 60,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '1080p60': {
    maxBitrate: 8_500_000,
    maxFramerate: 60,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '1080p30': {
    maxBitrate: 4_500_000,
    maxFramerate: 30,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '2k60': {
    maxBitrate: 18_000_000,
    maxFramerate: 60,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '4k30': {
    maxBitrate: 25_000_000,
    maxFramerate: 30,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  '720p60': {
    maxBitrate: 3_500_000,
    maxFramerate: 60,
    contentHint: 'motion',
    degradationPreference: 'balanced'
  },
  '720p30': {
    maxBitrate: 1_800_000,
    maxFramerate: 30,
    contentHint: 'text',
    degradationPreference: 'maintain-resolution'
  }
};

const AUDIO_MAX_BITRATE = 128_000;
const SPEECH_MAX_BITRATE = 48_000;
const WEBCAM_MAX_BITRATE = 350_000;
const WEBCAM_MAX_FRAMERATE = 15;
const VIDEO_CODEC_PREFERENCE = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];

// L1T3 = uma camada espacial, tres camadas temporais. Sob congestionamento o
// controle de banda descarta camadas temporais inteiras em vez de borrar a
// imagem, e o decodificador se recupera de perdas sem pedir keyframe.
const SCREEN_SCALABILITY_MODE = 'L1T3';

// No fallback P2P cada espectador recebe um encode e um upload proprios: tres
// espectadores triplicam a banda de subida do apresentador. Dividimos o teto
// entre eles para o total ficar limitado, com um piso para nao virar borrao.
const P2P_MIN_SCREEN_BITRATE = 1_500_000;

/**
 * Reescreve o fmtp do Opus na SDP local.
 * - usedtx=1: em silencio o Opus cai de ~50 pacotes/s para ~2,5/s. Numa
 *   apresentacao tipica (a maior parte do tempo sem som) isso elimina quase
 *   toda a banda de audio.
 * - useinbandfec=1: recupera perdas dentro do proprio fluxo, sem retransmissao,
 *   evitando o atraso de um NACK/round-trip.
 * - minptime=10: permite pacotes de 10ms quando o encoder achar util.
 */
function tuneOpusSdp(sdp, { stereo = true, maxBitrate = AUDIO_MAX_BITRATE } = {}) {
  if (typeof sdp !== 'string' || !sdp) return sdp;

  const payloads = [...sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/\d+/gim)].map((m) => m[1]);
  if (!payloads.length) return sdp;

  const wanted = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '1',
    stereo: stereo ? '1' : '0',
    'sprop-stereo': stereo ? '1' : '0',
    maxaveragebitrate: String(maxBitrate)
  };

  const lines = sdp.split(/\r\n|\n/);
  const out = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(/^a=fmtp:(\d+)\s+(.*)$/i);
    if (!match || !payloads.includes(match[1])) {
      out.push(line);
      continue;
    }

    const params = new Map();
    for (const part of match[2].split(';')) {
      const [key, ...rest] = part.split('=');
      if (key && key.trim()) params.set(key.trim(), rest.join('='));
    }
    for (const [key, value] of Object.entries(wanted)) params.set(key, value);

    seen.add(match[1]);
    out.push(`a=fmtp:${match[1]} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`);
  }

  // Payloads de Opus anunciados sem linha de fmtp: injeta uma logo apos o rtpmap.
  const missing = payloads.filter((pt) => !seen.has(pt));
  if (missing.length) {
    const fmtp = Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';');
    for (let i = out.length - 1; i >= 0; i--) {
      const match = out[i].match(/^a=rtpmap:(\d+)\s+opus\//i);
      if (match && missing.includes(match[1])) {
        out.splice(i + 1, 0, `a=fmtp:${match[1]} ${fmtp}`);
      }
    }
  }

  return out.join('\r\n');
}

/**
 * DTX/FEC/maxaveragebitrate no Opus sao preferencias de RECEPTOR: o encoder do
 * apresentador so os aplica se enxergar os parametros na SDP remota. Por isso
 * ajustamos tambem a answer que chega do SFU (ou do espectador, em P2P) antes
 * do setRemoteDescription — e o que de fato liga o DTX no lado que transmite.
 */
function tuneRemoteDescription(desc, audioOptions) {
  if (!desc?.sdp) return desc;
  try {
    return new RTCSessionDescription({ type: desc.type, sdp: tuneOpusSdp(desc.sdp, audioOptions) });
  } catch (err) {
    console.warn('[WebRTC] Ajuste de SDP remota ignorado:', err.message);
    return new RTCSessionDescription(desc);
  }
}

function tuneLocalDescription(desc, audioOptions) {
  if (!desc?.sdp) return desc;
  try {
    return { type: desc.type, sdp: tuneOpusSdp(desc.sdp, audioOptions) };
  } catch (err) {
    console.warn('[WebRTC] Ajuste de SDP do Opus ignorado:', err.message);
    return desc;
  }
}

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

async function applySenderParams(sender, { maxBitrate, maxFramerate, degradationPreference, networkPriority } = {}) {
  if (!sender) return;

  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    params.encodings.forEach((enc) => {
      if (maxBitrate) enc.maxBitrate = maxBitrate;
      if (maxFramerate) enc.maxFramerate = maxFramerate;
      // Prioridade define quem cede banda primeiro quando o link satura:
      // a tela mantem qualidade, a webcam degrada antes.
      if (networkPriority) {
        enc.networkPriority = networkPriority;
        enc.priority = networkPriority;
      }
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
 * Adiciona uma track de envio ja com os limites de encoding definidos.
 *
 * addTrack() so aceita limites depois via setParameters, e nesse intervalo o
 * Chrome pode disparar uma rajada inicial no bitrate padrao (bem acima do teto
 * desejado). Criando o transceiver com sendEncodings o teto vale desde o
 * primeiro frame, e e a unica forma de pedir camadas temporais (scalabilityMode).
 */
function addSendTrack(peer, track, stream, encoding = {}) {
  const sendEncoding = {};
  if (encoding.maxBitrate) sendEncoding.maxBitrate = encoding.maxBitrate;
  if (encoding.maxFramerate) sendEncoding.maxFramerate = encoding.maxFramerate;
  if (encoding.networkPriority) {
    sendEncoding.networkPriority = encoding.networkPriority;
    sendEncoding.priority = encoding.networkPriority;
  }
  if (encoding.scalabilityMode && track.kind === 'video') {
    sendEncoding.scalabilityMode = encoding.scalabilityMode;
  }

  if (typeof peer.addTransceiver === 'function') {
    try {
      const transceiver = peer.addTransceiver(track, {
        direction: 'sendonly',
        streams: stream ? [stream] : [],
        sendEncodings: [sendEncoding]
      });
      if (transceiver?.sender) return transceiver.sender;
    } catch (err) {
      console.warn('[WebRTC] addTransceiver indisponível, usando addTrack:', err.message);
    }
  }

  return stream ? peer.addTrack(track, stream) : peer.addTrack(track);
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
    this.audioIsSpeechOnly = false;
    this.sfuPeer = null;
    this.sfuSenders = {};
    this.sfuReady = false;
    this.peers = new Map(); // viewerId -> RTCPeerConnection (fallback P2P)
    this.peerSenders = new Map(); // viewerId -> { screenTrack, audioTrack, webcamTrack }
  }

  screenEncoding() {
    return {
      ...getEncodingProfile(this.quality),
      networkPriority: 'high',
      scalabilityMode: SCREEN_SCALABILITY_MODE
    };
  }

  /** Teto de tela para UM espectador P2P, ja dividido pelo total de peers. */
  p2pScreenEncoding() {
    const base = this.screenEncoding();
    const peers = Math.max(1, this.peers.size);
    if (peers === 1) return base;
    return {
      ...base,
      maxBitrate: Math.max(Math.round(base.maxBitrate / peers), P2P_MIN_SCREEN_BITRATE)
    };
  }

  /** Redistribui o orcamento quando entra ou sai um espectador P2P. */
  async reapplyPeerEncodings() {
    for (const viewerId of this.peers.keys()) {
      await this.applyPeerEncoding(viewerId);
    }
  }

  audioEncoding() {
    return { maxBitrate: this.audioMaxBitrate(), networkPriority: 'high' };
  }

  webcamEncoding() {
    return {
      maxBitrate: WEBCAM_MAX_BITRATE,
      maxFramerate: WEBCAM_MAX_FRAMERATE,
      degradationPreference: 'maintain-framerate',
      networkPriority: 'low'
    };
  }

  // Voz precisa de muito menos banda que audio de sistema: 48 kbps mono cobrem
  // fala com folga, contra 128 kbps estereo necessarios para musica/jogo.
  audioMaxBitrate() {
    return this.audioIsSpeechOnly ? SPEECH_MAX_BITRATE : AUDIO_MAX_BITRATE;
  }

  audioSdpOptions() {
    return { stereo: !this.audioIsSpeechOnly, maxBitrate: this.audioMaxBitrate() };
  }

  async applyPeerEncoding(viewerId) {
    const senders = this.peerSenders.get(viewerId);
    if (!senders) return;

    await applySenderParams(senders.screenSender, this.p2pScreenEncoding());
    await applySenderParams(senders.audioSender, this.audioEncoding());
    await applySenderParams(senders.webcamSender, this.webcamEncoding());
  }

  async applySfuEncoding() {
    if (!this.sfuPeer) return;
    await applySenderParams(this.sfuSenders.screenSender, this.screenEncoding());
    await applySenderParams(this.sfuSenders.audioSender, this.audioEncoding());
    await applySenderParams(this.sfuSenders.webcamSender, this.webcamEncoding());
  }

  async setQuality(quality) {
    if (!QUALITY_PROFILES[quality]) return;
    this.quality = quality;
    const videoConstraints = QUALITY_PROFILES[quality];
    const encoding = getEncodingProfile(quality);

    console.log(`[Host] Mudando qualidade em tempo real para: ${quality}`, encoding);

    // 1. Atualizar constraints da faixa de vídeo local se disponível
    if (this.screenStream) {
      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          await videoTrack.applyConstraints({
            width: videoConstraints.width,
            height: videoConstraints.height,
            frameRate: videoConstraints.frameRate
          });
        } catch (err) {
          console.warn('[WebRTC] applyConstraints falhou:', err.message);
        }
        setTrackContentHint(videoTrack, encoding.contentHint);
      }
    }

    // 2. Atualizar parâmetros do sender SFU
    if (this.sfuPeer) {
      await this.applySfuEncoding();
    }

    // 3. Atualizar parâmetros de todos os senders P2P
    if (this.peers.size > 0) {
      await this.reapplyPeerEncodings();
    }
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
      if (track.kind === 'video') {
        this.sfuSenders.screenSender = addSendTrack(this.sfuPeer, track, this.screenStream, this.screenEncoding());
      } else if (track.kind === 'audio') {
        this.sfuSenders.audioSender = addSendTrack(this.sfuPeer, track, this.screenStream, this.audioEncoding());
      }
    });

    if (this.webcamStream) {
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      if (webcamTrack) {
        this.sfuSenders.webcamSender = addSendTrack(this.sfuPeer, webcamTrack, this.webcamStream, this.webcamEncoding());
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

    const offer = tuneLocalDescription(
      await this.sfuPeer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false }),
      this.audioSdpOptions()
    );
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
    await this.sfuPeer.setRemoteDescription(tuneRemoteDescription(answer, this.audioSdpOptions()));
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
    const offer = tuneLocalDescription(await this.sfuPeer.createOffer(), this.audioSdpOptions());
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

      // Sem audio de sistema, o que sobra e no maximo o microfone: voz mono
      // cabe em uma fracao do bitrate reservado para musica/jogo.
      this.audioIsSpeechOnly = displayStream.getAudioTracks().length === 0;

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
          if (!this.peerSenders.has(viewerId)) this.peerSenders.set(viewerId, {});
          this.peerSenders.get(viewerId).webcamSender =
            addSendTrack(peer, webcamTrack, this.webcamStream, this.webcamEncoding());
        }
      });

      if (this.sfuPeer && this.webcamStream) {
        const webcamTrack = this.webcamStream.getVideoTracks()[0];
        if (webcamTrack && !this.sfuSenders.webcamSender) {
          this.sfuSenders.webcamSender =
            addSendTrack(this.sfuPeer, webcamTrack, this.webcamStream, this.webcamEncoding());
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

    // O caminho SFU tambem precisa soltar o sender. Sem isso a track fica
    // pendurada na conexao e, pior, `sfuSenders.webcamSender` continua
    // preenchido — o que faz o religar da webcam ser silenciosamente ignorado.
    if (this.sfuPeer && this.sfuSenders.webcamSender) {
      try {
        this.sfuPeer.removeTrack(this.sfuSenders.webcamSender);
      } catch (e) {}
      this.sfuSenders.webcamSender = null;
      this.renegotiateSfu().catch((err) => {
        console.warn('[SFU] Renegociação ao desligar a webcam falhou:', err.message);
      });
    }

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
    const senders = this.peerSenders.get(viewerId);
    this.screenStream.getTracks().forEach((track) => {
      if (track.kind === 'video') {
        senders.screenSender = addSendTrack(peer, track, this.screenStream, this.p2pScreenEncoding());
      } else if (track.kind === 'audio') {
        senders.audioSender = addSendTrack(peer, track, this.screenStream, this.audioEncoding());
      }
    });

    // 2. Adiciona faixa da webcam se ativa
    if (this.webcamStream) {
      const webcamTrack = this.webcamStream.getVideoTracks()[0];
      if (webcamTrack) {
        senders.webcamSender = addSendTrack(peer, webcamTrack, this.webcamStream, this.webcamEncoding());
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
      const offer = tuneLocalDescription(
        await peer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false }),
        this.audioSdpOptions()
      );
      await peer.setLocalDescription(offer);
      await this.applyPeerEncoding(viewerId);

      this.socket.emit('signal:offer', {
        toViewerId: viewerId,
        offer,
        hasWebcam: !!this.webcamStream
      });

      // O novo peer muda a divisao do orcamento para todos os outros.
      await this.reapplyPeerEncodings();
    } catch (err) {
      console.error(`Erro ao criar oferta para ${viewerId}:`, err);
    }
  }

  async handleAnswer(viewerId, answer) {
    const peer = this.peers.get(viewerId);
    if (peer) {
      await peer.setRemoteDescription(tuneRemoteDescription(answer, this.audioSdpOptions()));
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
      // Sobrou banda para quem ficou.
      this.reapplyPeerEncodings().catch(() => {});
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

    const answer = tuneLocalDescription(await this.peer.createAnswer());
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
