const {
  DependencyDescriptorReader, TemporalClassifier, vp8TemporalId, vp9TemporalId,
  DEPENDENCY_DESCRIPTOR_URI: DD
} = require('../temporal.js');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// ---- Estrutura real capturada do Chrome (AV1 L1T3) ----
const LONG = hex('80 00 01 80 02 14 ea a8 60 41 4d 14 10 20 84 27 04 ff 02 cf');
const r = new DependencyDescriptorReader();
check('keyframe -> T0', r.temporalId(LONG), 0);
check('templates aprendidos = [0,0,1,2,2]', r.templateTemporalIds, [0, 0, 1, 2, 2]);
check('template_id_offset', r.templateIdOffset, 0);

// Pacotes curtos reais (3 bytes): template_id nos 6 bits baixos do byte 0
check('curto 00 00 01 -> T0', r.temporalId(hex('00 00 01')), 0);
check('curto 40 00 01 -> T0', r.temporalId(hex('40 00 01')), 0);
// template_id 1,2,3,4 conforme o mapa aprendido
check('template 1 -> T0', r.temporalId(hex('01 00 02')), 0);
check('template 2 -> T1', r.temporalId(hex('02 00 03')), 1);
check('template 3 -> T2', r.temporalId(hex('03 00 04')), 2);
check('template 4 -> T2', r.temporalId(hex('04 00 05')), 2);
// start_of_frame/end_of_frame nos bits altos nao podem vazar para o template_id
check('80|template 3 -> T2', r.temporalId(hex('83 00 06')), 2);
check('c0|template 2 -> T1', r.temporalId(hex('c2 00 07')), 1);

// ---- Sem estrutura aprendida ainda ----
const fresh = new DependencyDescriptorReader();
check('sem keyframe -> null', fresh.temporalId(hex('02 00 03')), null);

// ---- Entradas degeneradas ----
check('buffer curto -> null', r.temporalId(hex('00 00')), null);
check('vazio -> null', r.temporalId(Buffer.alloc(0)), null);
check('null -> null', r.temporalId(null), null);

// Bytes 0xff parseiam como estrutura legal de UM template (idc=3 imediato).
// O importante e nao lancar e nao devolver lixo.
const rff = new DependencyDescriptorReader();
// offset=63 e um unico template: o template_id 0 do proprio pacote fica fora
// da estrutura, entao o correto e responder null (indeterminado).
check('0xff -> null (id fora da estrutura)', rff.temporalId(hex('80 00 01 ff ff ff ff ff')), null);
check('0xff -> um unico template', rff.templateTemporalIds, [0]);
check('0xff -> offset 63', rff.templateIdOffset, 63);
check('0xff -> id 63 mapeia T0', rff.temporalId(hex('3f 00 02')), 0);

// Estrutura truncada no meio de template_layers deve lancar e ser engolida,
// preservando o mapa aprendido antes.
const before = r.templateTemporalIds.slice();
check('truncado -> null', r.temporalId(hex('80 00 01 80')), null);
check('estado preservado apos truncado', r.templateTemporalIds, before);

// ---- template_id_offset diferente de zero ----
// flags=10000 | offset(6)=000101 | dt_cnt(5)=00000 | layers 01,11
//  byte3 = 1000 0000            (flag bits + 3 primeiros bits do offset)
//  byte4 = 101 00000            (3 ultimos bits do offset + dt_cnt)
//  byte5 = 01 11 0000           (next_layer_idc: 01 -> T1, 11 -> fim)
const b = Buffer.from([0x80, 0x00, 0x01, 0x80, 0xa0, 0x70]);
const r2 = new DependencyDescriptorReader();
r2.temporalId(b);
check('offset lido', r2.templateIdOffset, 5);
check('templates com offset', r2.templateTemporalIds, [0, 1]);
// template_id 5 mapeia para o indice 0 -> T0; template_id 6 -> indice 1 -> T1
check('offset aplicado (id 5 -> T0)', r2.temporalId(hex('05 00 09')), 0);
check('offset aplicado (id 6 -> T1)', r2.temporalId(hex('06 00 0a')), 1);

// ---- VP9 ----
// byte0: I=1(0x80) L=1(0x20) -> 0xa0 ; pictureId 1 byte (0x01) ; layer byte TID=2 -> 0x40
check('vp9 TID=2', vp9TemporalId(Buffer.from([0xa0, 0x01, 0x40])), 2);
// sem flag L -> null
check('vp9 sem L -> null', vp9TemporalId(Buffer.from([0x80, 0x01])), null);
// pictureId de 2 bytes (M=1)
check('vp9 picId 15 bits', vp9TemporalId(Buffer.from([0xa0, 0x81, 0x23, 0x60])), 3);

// ---- VP8 ----
// byte0 X=1 (0x80); byte1 T=1 (0x20); byte2 TID nos 2 bits altos (0x80 -> 2)
check('vp8 TID=2', vp8TemporalId(Buffer.from([0x80, 0x20, 0x80])), 2);
check('vp8 sem X -> null', vp8TemporalId(Buffer.from([0x00])), null);
// I=1 (picid 1 byte) + T=1
check('vp8 com picId', vp8TemporalId(Buffer.from([0x80, 0xa0, 0x05, 0x40])), 1);

// ---- Classifier ----
const cls = new TemporalClassifier('video/AV1');
check('classifier keyframe', cls.classify({ payload: Buffer.alloc(0) }, { [DD]: LONG }), 0);
check('classifier T2', cls.classify({ payload: Buffer.alloc(0) }, { [DD]: hex('03 00 04') }), 2);
check('classifier viu camadas', cls.sawTemporalLayers, true);
const clsNone = new TemporalClassifier('video/H264');
check('h264 sem DD -> null', clsNone.classify({ payload: Buffer.from([1, 2, 3]) }, undefined), null);

console.log(fail ? `\n${fail} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fail ? 1 : 0);
