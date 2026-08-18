const os = require('os');
const {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useVP8,
  useVP9,
  useH264,
  useAV1X,
  useOPUS,
  useNACK,
  usePLI,
  useREMB
} = require('werift');

const RTCP_VIDEO = [useNACK(), usePLI(), useREMB()];

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
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    iceAdditionalHostAddresses: localHostAddresses(),
    icePortRange: icePortRange(),
    iceUseTcp: true,
    codecs: {
      audio: [useOPUS()],
      video: [
        useVP9(),
        useVP8(),
        useH264(),
        new RTCRtpCodecParameters({
          mimeType: 'video/AV1',
          clockRate: 90000,
          rtcpFeedback: RTCP_VIDEO
        }),
        useAV1X()
      ]
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
    this.pliTimer = null;
  }

  hasMedia() {
    const videos = this.tracks.filter((t) => t.kind === 'video').length;
    const audios = this.tracks.filter((t) => t.kind === 'audio').length;
    return videos >= Math.max(1, this.expected.video) && audios >= this.expected.audio;
  }

  async waitForMedia(timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.hasMedia()) return true;
      await sleep(100);
    }
    return this.tracks.some((t) => t.kind === 'video');
  }

  startPli() {
    if (this.pliTimer) return;
    this.pliTimer = setInterval(() => {
      for (const published of this.tracks) {
        if (published.kind !== 'video' || !published.track?.ssrc || !published.transceiver) continue;
        published.transceiver.receiver.sendRtcpPLI(published.track.ssrc).catch(() => {});
      }
    }, 2000);
  }

  rememberTrack(track, transceiver) {
    if (this.tracks.some((item) => item.track.uuid === track.uuid)) return;
    const videos = this.tracks.filter((t) => t.kind === 'video').length;
    const label = track.kind === 'audio' ? 'audio' : (videos === 0 ? 'screen' : 'webcam');
    this.tracks.push({ track, kind: track.kind, label, transceiver });
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
      this.startPli();
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

  addPublishedTrackToPeer(pc, published) {
    const sender = pc.addTrack(published.track);
    if (published.kind === 'video' && sender?.onPictureLossIndication) {
      sender.onPictureLossIndication.subscribe(() => {
        if (published.track?.ssrc && published.transceiver) {
          published.transceiver.receiver.sendRtcpPLI(published.track.ssrc).catch(() => {});
        }
      });
    }
    return sender;
  }

  async forwardNewTrack(track) {
    const published = this.tracks.find((item) => item.track === track || item.track.uuid === track.uuid);
    if (!published) return;

    for (const [viewerId, sub] of this.subscribers) {
      const already = sub.pc.getSenders().some((sender) => sender.track?.uuid === published.track.uuid);
      if (already) continue;
      try {
        this.addPublishedTrackToPeer(sub.pc, published);
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
      this.addPublishedTrackToPeer(pc, published);
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

    for (const published of this.tracks) {
      if (published.kind === 'video' && published.track?.ssrc && published.transceiver) {
        published.transceiver.receiver.sendRtcpPLI(published.track.ssrc).catch(() => {});
      }
    }

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
    try {
      await sub.pc.close();
    } catch (e) {}
  }

  async close() {
    if (this.pliTimer) {
      clearInterval(this.pliTimer);
      this.pliTimer = null;
    }

    for (const viewerId of [...this.subscribers.keys()]) {
      await this.removeSubscriber(viewerId);
    }

    if (this.publisherPc) {
      try {
        await this.publisherPc.close();
      } catch (e) {}
      this.publisherPc = null;
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

module.exports = { SfuManager, serializeCandidate };
