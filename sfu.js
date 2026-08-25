const os = require('os');

let werift;
try {
  werift = require('werift');
} catch (err) {
  console.error('[SFU] Não foi possível carregar o WebRTC do servidor (werift):', err.message);
  console.error('[SFU] O executável seguirá em modo P2P.');

  class DisabledSfuManager {
    peek() {
      return null;
    }

    get() {
      return {
        addSubscriber: async () => false,
        handlePublishOffer: async () => {
          throw new Error('SFU indisponível neste executável');
        },
        handlePublisherIce: async () => {},
        handleSubscribeAnswer: async () => {},
        handleSubscriberIce: async () => {},
        removeSubscriber: async () => {}
      };
    }

    async close() {}
  }

  module.exports = {
    SfuManager: DisabledSfuManager,
    serializeCandidate: () => null
  };
  return;
}

const { TemporalClassifier } = require('./temporal');

const {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  MediaStreamTrack,
  useVP8,
  useVP9,
  useH264,
  useAV1X,
  useOPUS,
  useNACK,
  usePLI,
  useREMB,
  useTWCC,
  useSdesMid,
  useAbsSendTime,
  useTransportWideCC,
  useAudioLevelIndication,
  useDependencyDescriptor
} = werift;

// NACK+PLI para recuperacao, REMB+TWCC para estimativa de banda.
const RTCP_VIDEO = [useNACK(), usePLI(), useREMB(), useTWCC()];

// useOPUS() vem com rtcpFeedback vazio, o que deixa o audio invisivel para o
// controle de congestionamento: ele consome banda sem aparecer na conta.
const RTCP_AUDIO = [useTWCC()];

// O werift nao negocia nenhuma extensao de cabecalho por padrao. Sem
// transport-cc/abs-send-time o navegador transmite "as cegas": nao recebe
// feedback de congestionamento e nao consegue ajustar o bitrate, o que gera
// picos de banda e bufferbloat. Habilitar as extensoes e o que torna o
// controle de congestionamento do Chrome/Firefox funcional contra o SFU.
function headerExtensions() {
  return {
    audio: [useSdesMid(), useAudioLevelIndication(), useTransportWideCC(), useAbsSendTime()],
    video: [useSdesMid(), useTransportWideCC(), useAbsSendTime(), useDependencyDescriptor()]
  };
}

// Os helpers do werift (useVP9/useVP8/useH264) trazem apenas nack+pli+remb.
// Sem transport-cc no rtcp-fb o navegador nao envia relatorios TWCC e volta a
// depender so do REMB, que reage devagar demais para tela em movimento.
function withFeedback(codec) {
  return new RTCRtpCodecParameters({
    mimeType: codec.mimeType,
    clockRate: codec.clockRate,
    channels: codec.channels,
    payloadType: codec.payloadType,
    parameters: codec.parameters,
    rtcpFeedback: RTCP_VIDEO
  });
}

function audioCodecs() {
  return [useOPUS()].flat().map(
    (codec) =>
      new RTCRtpCodecParameters({
        mimeType: codec.mimeType,
        clockRate: codec.clockRate,
        channels: codec.channels,
        payloadType: codec.payloadType,
        parameters: codec.parameters,
        rtcpFeedback: RTCP_AUDIO
      })
  );
}

function videoCodecs() {
  return [useVP9(), useVP8(), useH264(), useAV1X()]
    .flat()
    .map(withFeedback)
    .concat(
      new RTCRtpCodecParameters({
        mimeType: 'video/AV1',
        clockRate: 90000,
        rtcpFeedback: RTCP_VIDEO
      })
    );
}

// Intervalo minimo entre pedidos de keyframe para a mesma track.
const KEYFRAME_MIN_INTERVAL_MS = 1000;

// O apresentador publica L1T3: uma camada espacial, tres temporais (0,1,2).
const MAX_TEMPORAL_LAYER = 2;

// Politica de adaptacao por espectador, guiada pela perda relatada nos
// Receiver Reports RTCP. Nao usamos o estimador de banda do werift porque ele
// nao produz leitura confiavel (availableBitrate fica em zero e o score de
// congestionamento satura mesmo em loopback sem perda nenhuma).
const LOSS_DOWNGRADE = 0.06; // ~6% de perda: derruba uma camada
const LOSS_UPGRADE = 0.01; // abaixo de 1% de forma sustentada: sobe de volta
const UPGRADE_STABLE_REPORTS = 5; // relatorios limpos exigidos antes de subir
const TEMPORAL_ENABLED = process.env.SFU_TEMPORAL !== '0';

function uint16(value) {
  return value & 0xffff;
}

/**
 * Replica uma track de video publicada para os espectadores, podendo descartar
 * camadas temporais individualmente para cada um.
 *
 * O parsing da camada acontece UMA vez por pacote (o estado de templates do
 * dependency descriptor pertence ao fluxo, nao ao espectador); o resultado e
 * reaproveitado por todos os inscritos.
 *
 * Ao descartar pacotes precisamos renumerar os que seguem: se deixassemos os
 * buracos na sequencia RTP, o navegador do espectador leria como perda e
 * dispararia NACKs pedindo pacotes que nunca foram enviados.
 */
class VideoFanout {
  constructor(published) {
    this.published = published;
    this.classifier = new TemporalClassifier(published.track?.codec?.mimeType);
    this.subscribers = new Map(); // viewerId -> estado de encaminhamento
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe) return;
    const sub = this.published.track.onReceiveRtp.subscribe((rtp, extensions) => {
      this.onRtp(rtp, extensions);
    });
    this.unsubscribe = sub?.unSubscribe || null;
  }

  onRtp(rtp, extensions) {
    // O codec so fica conhecido depois da negociacao; atualiza na primeira vez.
    if (!this.classifier.mime && this.published.track?.codec?.mimeType) {
      this.classifier.mime = this.published.track.codec.mimeType.toLowerCase();
    }

    let layer = null;
    try {
      layer = this.classifier.classify(rtp, extensions);
    } catch (err) {
      layer = null;
    }

    for (const state of this.subscribers.values()) {
      // layer null = camada indeterminada: encaminha, nunca arrisca cortar.
      if (layer !== null && layer > state.targetLayer) {
        state.dropped = uint16(state.dropped + 1);
        state.droppedTotal++;
        continue;
      }

      const clone = rtp.clone();
      clone.header.sequenceNumber = uint16(rtp.header.sequenceNumber - state.dropped);
      try {
        state.track.writeRtp(clone);
      } catch (err) {
        // espectador saindo no meio do envio
      }
    }
  }

  createTrack(viewerId) {
    const track = new MediaStreamTrack({ kind: 'video' });
    this.subscribers.set(viewerId, {
      track,
      targetLayer: MAX_TEMPORAL_LAYER,
      dropped: 0,
      droppedTotal: 0,
      cleanReports: 0
    });
    this.start();
    return track;
  }

  removeTrack(viewerId) {
    const state = this.subscribers.get(viewerId);
    if (!state) return;
    this.subscribers.delete(viewerId);
    try {
      state.track.stop?.();
    } catch (err) {}
  }

  /** Aplica a perda relatada por um espectador e ajusta a camada alvo dele. */
  applyLoss(viewerId, lossRatio) {
    const state = this.subscribers.get(viewerId);
    if (!state || !this.classifier.sawTemporalLayers) return null;

    const before = state.targetLayer;

    if (lossRatio >= LOSS_DOWNGRADE) {
      state.cleanReports = 0;
      if (state.targetLayer > 0) state.targetLayer--;
    } else if (lossRatio <= LOSS_UPGRADE) {
      state.cleanReports++;
      if (state.cleanReports >= UPGRADE_STABLE_REPORTS && state.targetLayer < MAX_TEMPORAL_LAYER) {
        state.targetLayer++;
        state.cleanReports = 0;
      }
    } else {
      state.cleanReports = 0;
    }

    return state.targetLayer === before ? null : { from: before, to: state.targetLayer };
  }

  stats(viewerId) {
    const state = this.subscribers.get(viewerId);
    if (!state) return null;
    return { targetLayer: state.targetLayer, droppedTotal: state.droppedTotal };
  }

  close() {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {}
      this.unsubscribe = null;
    }
    for (const viewerId of [...this.subscribers.keys()]) this.removeTrack(viewerId);
  }
}

function localHostAddresses() {
  const addresses = ['127.0.0.1'];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const iface of list || []) {
      const family = iface.family === 'IPv4' || iface.family === 4;
      if (family && iface.address && !addresses.includes(iface.address)) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

function icePortRange() {
  const raw = process.env.SFU_PORT_RANGE;
  if (!raw || !raw.includes('-')) return undefined;
  const [min, max] = raw.split('-').map((n) => parseInt(n, 10));
  if (!min || !max || min >= max) return undefined;
  return [min, max];
}

function peerConfig() {
  return {
    iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' }
    ],
    iceAdditionalHostAddresses: localHostAddresses(),
    icePortRange: icePortRange(),
    iceUseTcp: true,
    headerExtensions: headerExtensions(),
    codecs: {
      audio: audioCodecs(),
      video: videoCodecs()
    }
  };
}

function serializeDesc(desc) {
  if (!desc) return null;
  return { type: desc.type, sdp: desc.sdp };
}

function serializeCandidate(candidate) {
  if (!candidate) return null;
  const json = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
  const value = json && typeof json.toJSON === 'function' && json !== candidate ? json.toJSON() : json;
  if (!value || (!value.candidate && value.sdpMid == null && value.sdpMLineIndex == null)) return null;
  return {
    candidate: value.candidate,
    sdpMid: value.sdpMid ?? null,
    sdpMLineIndex: value.sdpMLineIndex ?? null,
    usernameFragment: value.usernameFragment ?? null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SfuRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.publisherPc = null;
    this.publisherSocket = null;
    this.tracks = [];
    this.subscribers = new Map();
    this.expected = { video: 1, audio: 0 };
  }

  hasMedia() {
    const videos = this.tracks.filter((t) => t.kind === 'video').length;
    const audios = this.tracks.filter((t) => t.kind === 'audio').length;
    return videos >= Math.max(1, this.expected.video) && audios >= this.expected.audio;
  }

  async waitForMedia(timeoutMs = 2500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.hasMedia()) return true;
      await sleep(30);
    }
    return this.tracks.some((t) => t.kind === 'video');
  }

  // Um keyframe de tela 1080p custa centenas de KB. Pedi-los em intervalo fixo
  // multiplica a banda do publisher sem beneficio nenhum: keyframe so e
  // necessario quando alguem entra ou quando um espectador perde o quadro de
  // referencia (PLI). O throttle evita rajadas quando varios pedem de uma vez.
  requestKeyframe(published) {
    if (!published || published.kind !== 'video') return;
    if (!published.track?.ssrc || !published.transceiver) return;

    const now = Date.now();
    if (published.lastKeyframeAt && now - published.lastKeyframeAt < KEYFRAME_MIN_INTERVAL_MS) return;
    published.lastKeyframeAt = now;

    published.transceiver.receiver.sendRtcpPLI(published.track.ssrc).catch(() => {});
  }

  requestKeyframeAll() {
    for (const published of this.tracks) {
      this.requestKeyframe(published);
    }
  }

  rememberTrack(track, transceiver) {
    if (this.tracks.some((item) => item.track.uuid === track.uuid)) return;
    const videos = this.tracks.filter((t) => t.kind === 'video').length;
    const label = track.kind === 'audio' ? 'audio' : (videos === 0 ? 'screen' : 'webcam');
    const published = { track, kind: track.kind, label, transceiver };
    if (track.kind === 'video' && TEMPORAL_ENABLED) {
      published.fanout = new VideoFanout(published);
    }
    this.tracks.push(published);
    console.log(`[SFU] Track recebida na sala ${this.roomId}: ${label} (${track.kind})`);
  }

  attachPublisherEvents(socket) {
    try {
      this.publisherPc.onRemoteTransceiverAdded.subscribe((transceiver) => {
        transceiver.onTrack.subscribe((track) => {
          this.rememberTrack(track, transceiver);
          this.forwardNewTrack(track).catch((err) => {
            console.warn('[SFU] Falha ao replicar track nova:', err.message);
          });
        });
      });
    } catch (err) {
      console.warn('[SFU] onRemoteTransceiverAdded indisponível:', err.message);
    }

    this.publisherPc.ontrack = (event) => {
      const track = event.track;
      const transceiver = event.transceiver;
      this.rememberTrack(track, transceiver);
      this.forwardNewTrack(track).catch((err) => {
        console.warn('[SFU] Falha ao replicar track nova:', err.message);
      });
    };

    const emitPublisherIce = (candidate) => {
      const payload = serializeCandidate(candidate);
      if (payload) socket.emit('sfu:publish-ice', { candidate: payload });
    };

    if (this.publisherPc.onIceCandidate?.subscribe) {
      this.publisherPc.onIceCandidate.subscribe(emitPublisherIce);
    } else {
      this.publisherPc.onicecandidate = (event) => emitPublisherIce(event?.candidate);
    }

    this.publisherPc.onconnectionstatechange = () => {
      console.log(`[SFU] Publisher ${this.roomId}: ${this.publisherPc.connectionState}`);
    };
  }

  async handlePublishOffer(socket, offer, meta = {}) {
    this.publisherSocket = socket;
    this.expected = {
      video: meta.hasWebcam ? 2 : 1,
      audio: meta.hasAudio ? 1 : 0
    };

    if (!this.publisherPc) {
      this.publisherPc = new RTCPeerConnection(peerConfig());
      this.attachPublisherEvents(socket);
    }

    await this.publisherPc.setRemoteDescription(offer);
    const answer = await this.publisherPc.createAnswer();
    await this.publisherPc.setLocalDescription(answer);
    socket.emit('sfu:publish-answer', { answer: serializeDesc(this.publisherPc.localDescription || answer) });
  }

  async handlePublisherIce(candidate) {
    if (!this.publisherPc || !candidate) return;
    try {
      await this.publisherPc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[SFU] ICE do publisher ignorado:', err.message);
    }
  }

  addPublishedTrackToPeer(pc, published, viewerId) {
    // Video com camadas temporais recebe uma track propria por espectador, o
    // que permite descartar camadas so para quem esta com perda. Audio (e o
    // caso sem fanout) segue no caminho compartilhado.
    const outbound = published.fanout && viewerId
      ? published.fanout.createTrack(viewerId)
      : published.track;

    const sender = pc.addTrack(outbound);

    if (published.kind === 'video' && sender?.onPictureLossIndication) {
      // Repassa o PLI do espectador ao publisher (throttled).
      sender.onPictureLossIndication.subscribe(() => this.requestKeyframe(published));
    }

    if (published.fanout && viewerId && sender?.onRtcp) {
      sender.onRtcp.subscribe((rtcp) => this.handleSubscriberRtcp(published, viewerId, rtcp));
    }

    return sender;
  }

  /**
   * Receiver Reports trazem `fractionLost` em 1/256. E o unico sinal de
   * congestionamento confiavel disponivel aqui, e chega ~1x por segundo.
   */
  handleSubscriberRtcp(published, viewerId, rtcp) {
    if (!rtcp || !Array.isArray(rtcp.reports) || !rtcp.reports.length) return;

    let worst = 0;
    for (const report of rtcp.reports) {
      const lost = (report?.fractionLost || 0) / 256;
      if (lost > worst) worst = lost;
    }

    const change = published.fanout.applyLoss(viewerId, worst);
    if (change) {
      console.log(
        `[SFU] Espectador ${viewerId}: camada temporal ${change.from} -> ${change.to} ` +
        `(perda ${(worst * 100).toFixed(1)}%)`
      );
    }
  }

  async forwardNewTrack(track) {
    const published = this.tracks.find((item) => item.track === track || item.track.uuid === track.uuid);
    if (!published) return;

    for (const [viewerId, sub] of this.subscribers) {
      const already = published.fanout
        ? published.fanout.subscribers.has(viewerId)
        : sub.pc.getSenders().some((sender) => sender.track?.uuid === published.track.uuid);
      if (already) continue;
      try {
        this.addPublishedTrackToPeer(sub.pc, published, viewerId);
        await this.renegotiateSubscriber(viewerId);
      } catch (err) {
        console.warn(`[SFU] Não foi possível adicionar track ao espectador ${viewerId}:`, err.message);
      }
    }
  }

  async renegotiateSubscriber(viewerId) {
    const sub = this.subscribers.get(viewerId);
    if (!sub) return;
    const offer = await sub.pc.createOffer();
    await sub.pc.setLocalDescription(offer);
    sub.socket.emit('sfu:subscribe-offer', {
      offer: serializeDesc(sub.pc.localDescription || offer),
      hasWebcam: this.tracks.some((t) => t.label === 'webcam')
    });
  }

  async addSubscriber(socket) {
    const ready = await this.waitForMedia();
    if (!ready || !this.tracks.length) return false;

    if (this.subscribers.has(socket.id)) {
      await this.removeSubscriber(socket.id);
    }

    const pc = new RTCPeerConnection(peerConfig());
    this.subscribers.set(socket.id, { pc, socket });

    for (const published of this.tracks) {
      this.addPublishedTrackToPeer(pc, published, socket.id);
    }

    const emitSubscriberIce = (candidate) => {
      const payload = serializeCandidate(candidate);
      if (payload) socket.emit('sfu:subscribe-ice', { candidate: payload });
    };

    if (pc.onIceCandidate?.subscribe) {
      pc.onIceCandidate.subscribe(emitSubscriberIce);
    } else {
      pc.onicecandidate = (event) => emitSubscriberIce(event?.candidate);
    }

    pc.onconnectionstatechange = () => {
      console.log(`[SFU] Espectador ${socket.id}: ${pc.connectionState}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('sfu:subscribe-offer', {
      offer: serializeDesc(pc.localDescription || offer),
      hasWebcam: this.tracks.some((t) => t.label === 'webcam')
    });

    // Bootstrap: o espectador so decodifica a partir de um keyframe. Pedimos um
    // agora e repetimos uma vez depois da negociacao, caso o primeiro tenha
    // chegado antes do peer estar pronto para receber.
    // O espectador pode ter desconectado durante as negociacoes acima.
    const sub = this.subscribers.get(socket.id);
    if (!sub) return false;

    this.requestKeyframeAll();
    sub.bootstrapTimer = setTimeout(() => {
      if (this.subscribers.get(socket.id) === sub && sub.pc.connectionState !== 'closed') {
        this.requestKeyframeAll();
      }
    }, 1200);

    return true;
  }

  async handleSubscribeAnswer(viewerId, answer) {
    const sub = this.subscribers.get(viewerId);
    if (!sub) return;
    await sub.pc.setRemoteDescription(answer);
  }

  async handleSubscriberIce(viewerId, candidate) {
    const sub = this.subscribers.get(viewerId);
    if (!sub || !candidate) return;
    try {
      await sub.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[SFU] ICE do espectador ignorado:', err.message);
    }
  }

  async removeSubscriber(viewerId) {
    const sub = this.subscribers.get(viewerId);
    if (!sub) return;
    this.subscribers.delete(viewerId);
    if (sub.bootstrapTimer) clearTimeout(sub.bootstrapTimer);
    for (const published of this.tracks) {
      if (published.fanout) published.fanout.removeTrack(viewerId);
    }
    try {
      await sub.pc.close();
    } catch (e) {}
  }

  async close() {
    for (const viewerId of [...this.subscribers.keys()]) {
      await this.removeSubscriber(viewerId);
    }

    if (this.publisherPc) {
      try {
        await this.publisherPc.close();
      } catch (e) {}
      this.publisherPc = null;
    }

    for (const published of this.tracks) {
      if (published.fanout) published.fanout.close();
    }

    this.tracks = [];
    this.publisherSocket = null;
  }
}

class SfuManager {
  constructor() {
    this.rooms = new Map();
  }

  get(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new SfuRoom(roomId));
    }
    return this.rooms.get(roomId);
  }

  peek(roomId) {
    return this.rooms.get(roomId) || null;
  }

  async close(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    await room.close();
    this.rooms.delete(roomId);
  }
}

module.exports = { SfuManager, serializeCandidate, VideoFanout, MAX_TEMPORAL_LAYER };
