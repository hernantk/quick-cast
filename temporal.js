/**
 * Extração da camada temporal de um pacote RTP de vídeo.
 *
 * Codecs com escalabilidade temporal (o L1T3 que o apresentador envia) marcam
 * cada quadro com um `temporal id`. Quadros de camada alta nunca servem de
 * referência para os de camada baixa, então o SFU pode simplesmente descartar
 * T2 (ou T1+T2) para um espectador em dificuldade: a imagem continua íntegra,
 * só chega com menos quadros por segundo — e proporcionalmente menos banda.
 *
 * AV1 e VP9-SVC carregam essa informação no header extension "dependency
 * descriptor". VP8 e VP9 simples carregam no payload descriptor. Quando não
 * dá para determinar a camada, devolvemos null e o chamador encaminha tudo.
 */

const DEPENDENCY_DESCRIPTOR_URI =
  'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension';

/** Leitor de bits big-endian, que é como a SDP e o DD são serializados. */
class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bitPos = 0;
  }

  get remaining() {
    return this.buffer.length * 8 - this.bitPos;
  }

  read(bits) {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      if (this.bitPos >= this.buffer.length * 8) throw new RangeError('DD truncado');
      const byte = this.buffer[this.bitPos >> 3];
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
      value = (value << 1) | bit;
      this.bitPos++;
    }
    return value;
  }

  skip(bits) {
    this.bitPos += bits;
  }
}

/**
 * Decodifica o dependency descriptor (AV1 / VP9-SVC).
 *
 * A estrutura de templates só viaja nos quadros-chave; os demais pacotes
 * trazem apenas 3 bytes com o `template_id`. Por isso o leitor guarda estado
 * entre pacotes: aprende o mapa template -> camada temporal no quadro-chave e
 * o consulta depois. Só lemos os campos até `template_layers()` — dtis, fdiffs
 * e chains não interessam para a decisão de descarte.
 */
class DependencyDescriptorReader {
  constructor() {
    this.templateTemporalIds = null;
    this.templateIdOffset = 0;
  }

  /** @returns {number|null} temporal id, ou null se ainda não dá para saber */
  temporalId(payload) {
    if (!payload || payload.length < 3) return null;

    if (payload.length > 3) {
      try {
        this.parseExtended(payload);
      } catch (err) {
        // Descritor malformado ou variante que não conhecemos: encaminha tudo.
        return null;
      }
    }

    if (!this.templateTemporalIds || !this.templateTemporalIds.length) return null;

    const templateId = payload[0] & 0x3f;
    const index = (templateId - this.templateIdOffset) & 0x3f;
    const temporal = this.templateTemporalIds[index];
    return temporal === undefined ? null : temporal;
  }

  parseExtended(payload) {
    const reader = new BitReader(payload);
    reader.skip(24); // mandatory_descriptor_fields: start/end/template_id + frame_number

    const structurePresent = reader.read(1);
    reader.read(1); // active_decode_targets_present_flag
    reader.read(1); // custom_dtis_flag
    reader.read(1); // custom_fdiffs_flag
    reader.read(1); // custom_chains_flag

    if (!structurePresent) return;

    const templateIdOffset = reader.read(6);
    reader.read(5); // dt_cnt_minus_one

    // template_layers(): pares de bits até o marcador de fim (3).
    const temporalIds = [];
    let temporal = 0;
    let next;
    do {
      temporalIds.push(temporal);
      next = reader.read(2);
      if (next === 1) {
        temporal++;
      } else if (next === 2) {
        temporal = 0; // nova camada espacial reinicia a temporal
      }
    } while (next !== 3 && temporalIds.length < 64);

    if (next !== 3) throw new RangeError('template_layers sem terminador');

    this.templateTemporalIds = temporalIds;
    this.templateIdOffset = templateIdOffset;
  }
}

/** VP8: temporal id vive no payload descriptor, atrás de campos opcionais. */
function vp8TemporalId(payload) {
  if (!payload || payload.length < 1) return null;
  const extended = (payload[0] & 0x80) !== 0; // X
  if (!extended) return null;
  if (payload.length < 2) return null;

  const flags = payload[1];
  const hasPictureId = (flags & 0x80) !== 0; // I
  const hasTl0PicIdx = (flags & 0x40) !== 0; // L
  const hasTid = (flags & 0x20) !== 0; // T
  const hasKeyIdx = (flags & 0x10) !== 0; // K
  if (!hasTid) return null;

  let offset = 2;
  if (hasPictureId) {
    if (payload.length < offset + 1) return null;
    offset += (payload[offset] & 0x80) !== 0 ? 2 : 1; // M: id de 15 bits
  }
  if (hasTl0PicIdx) offset += 1;
  if (!hasTid && !hasKeyIdx) return null;
  if (payload.length < offset + 1) return null;

  return (payload[offset] >> 6) & 0x03;
}

/** VP9: temporal id no byte de layer indices, quando o flag L está ligado. */
function vp9TemporalId(payload) {
  if (!payload || payload.length < 1) return null;
  const first = payload[0];
  const hasPictureId = (first & 0x80) !== 0; // I
  const hasLayerIndices = (first & 0x20) !== 0; // L
  if (!hasLayerIndices) return null;

  let offset = 1;
  if (hasPictureId) {
    if (payload.length < offset + 1) return null;
    offset += (payload[offset] & 0x80) !== 0 ? 2 : 1; // M: id de 15 bits
  }
  if (payload.length < offset + 1) return null;

  return (payload[offset] >> 5) & 0x07;
}

/**
 * Mantém o estado necessário para classificar os pacotes de UMA track.
 * Uma instância por track publicada (o estado dos templates é do fluxo, não
 * do espectador).
 */
class TemporalClassifier {
  constructor(mimeType) {
    this.mime = (mimeType || '').toLowerCase();
    this.dd = new DependencyDescriptorReader();
    this.sawTemporalLayers = false;
  }

  /**
   * @param {import('werift').RtpPacket} rtp
   * @param {object|undefined} extensions extensões já parseadas pelo werift
   * @returns {number|null} camada temporal, ou null se indeterminada
   */
  classify(rtp, extensions) {
    const ddPayload = extensions && extensions[DEPENDENCY_DESCRIPTOR_URI];
    if (ddPayload && ddPayload.length) {
      const id = this.dd.temporalId(ddPayload);
      if (id !== null) {
        if (id > 0) this.sawTemporalLayers = true;
        return id;
      }
    }

    const payload = rtp.payload;
    if (this.mime.includes('vp9')) {
      const id = vp9TemporalId(payload);
      if (id !== null && id > 0) this.sawTemporalLayers = true;
      return id;
    }
    if (this.mime.includes('vp8')) {
      const id = vp8TemporalId(payload);
      if (id !== null && id > 0) this.sawTemporalLayers = true;
      return id;
    }

    return null;
  }
}

module.exports = {
  DEPENDENCY_DESCRIPTOR_URI,
  BitReader,
  DependencyDescriptorReader,
  TemporalClassifier,
  vp8TemporalId,
  vp9TemporalId
};
