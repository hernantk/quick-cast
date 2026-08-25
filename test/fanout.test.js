// Testa o descarte de camada temporal e a renumeracao de sequencia.
const { VideoFanout } = require('../sfu.js');
const { DEPENDENCY_DESCRIPTOR_URI: DD } = require('../temporal.js');
const { RtpPacket, RtpHeader } = require('werift');

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
};
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Estrutura real do Chrome: templates -> [T0,T0,T1,T2,T2]
const KEYFRAME_DD = hex('80 00 01 80 02 14 ea a8 60 41 4d 14 10 20 84 27 04 ff 02 cf');
const ddFor = (templateId) => Buffer.from([templateId & 0x3f, 0x00, 0x02]);

function makeFanout() {
  let handler = null;
  const published = {
    kind: 'video',
    track: {
      codec: { mimeType: 'video/AV1' },
      onReceiveRtp: {
        subscribe(fn) { handler = fn; return { unSubscribe() { handler = null; } }; }
      }
    }
  };
  const fanout = new VideoFanout(published);
  return { fanout, feed: (rtp, ext) => handler(rtp, ext) };
}

function attach(fanout, viewerId) {
  const track = fanout.createTrack(viewerId);
  const sent = [];
  track.writeRtp = (rtp) => sent.push(rtp.header.sequenceNumber);
  return sent;
}

const pkt = (seq) => new RtpPacket(new RtpHeader({ sequenceNumber: seq, payloadType: 45, ssrc: 1 }), Buffer.alloc(50));

// ---------- 1. Um espectador em cada camada alvo ----------
{
  const { fanout, feed } = makeFanout();
  const all = attach(fanout, 'v-all');   // camada 2 (padrao)
  const mid = attach(fanout, 'v-mid');
  const base = attach(fanout, 'v-base');
  fanout.subscribers.get('v-mid').targetLayer = 1;
  fanout.subscribers.get('v-base').targetLayer = 0;

  // keyframe (T0) ensina a estrutura
  feed(pkt(100), { [DD]: KEYFRAME_DD });
  // padrao L1T3 tipico: T0 T2 T1 T2  (template ids 0,3,2,4)
  const pattern = [0, 3, 2, 4];
  let seq = 101;
  for (let i = 0; i < 12; i++) feed(pkt(seq++), { [DD]: ddFor(pattern[i % 4]) });

  check('todas as camadas recebem tudo', all.length, 13);
  check('camada 1 descarta T2', mid.length, 13 - 6);
  check('camada 0 so T0', base.length, 1 + 3);

  // renumeracao: sem buracos para nenhum espectador
  const contiguous = (arr) => arr.every((v, i) => i === 0 || v === (arr[i - 1] + 1) % 65536);
  check('sequencia contigua (todas)', contiguous(all), true);
  check('sequencia contigua (camada 1)', contiguous(mid), true);
  check('sequencia contigua (camada 0)', contiguous(base), true);
  check('camada 0 comeca no mesmo seq', base[0], 100);
}

// ---------- 2. Camada indeterminada nunca e descartada ----------
{
  const { fanout, feed } = makeFanout();
  const sent = attach(fanout, 'v');
  fanout.subscribers.get('v').targetLayer = 0;
  // sem DD e sem codec conhecido -> classify devolve null
  for (let i = 0; i < 5; i++) feed(pkt(200 + i), undefined);
  check('sem info de camada encaminha tudo', sent.length, 5);
}

// ---------- 3. Wraparound de 16 bits ----------
{
  const { fanout, feed } = makeFanout();
  const sent = attach(fanout, 'v');
  fanout.subscribers.get('v').targetLayer = 0;
  feed(pkt(65530), { [DD]: KEYFRAME_DD });          // T0, passa
  feed(pkt(65531), { [DD]: ddFor(3) });             // T2, descarta
  feed(pkt(65532), { [DD]: ddFor(0) });             // T0, passa -> 65531
  feed(pkt(65533), { [DD]: ddFor(4) });             // T2, descarta
  feed(pkt(65534), { [DD]: ddFor(0) });             // T0, passa -> 65532
  check('renumera atravessando o limite', sent, [65530, 65531, 65532]);

  // agora forca o wrap de verdade
  const sent2 = attach(fanout, 'w');
  fanout.subscribers.get('w').targetLayer = 0;
  fanout.subscribers.get('w').dropped = 3;
  feed(pkt(1), { [DD]: ddFor(0) });                  // 1 - 3 = -2 -> 65534
  check('wrap negativo vira uint16', sent2, [65534]);
}

// ---------- 4. Isolamento entre espectadores ----------
{
  const { fanout, feed } = makeFanout();
  const a = attach(fanout, 'a');
  const b = attach(fanout, 'b');
  fanout.subscribers.get('b').targetLayer = 0;
  feed(pkt(10), { [DD]: KEYFRAME_DD });
  feed(pkt(11), { [DD]: ddFor(3) });
  feed(pkt(12), { [DD]: ddFor(0) });
  check('espectador rapido nao e afetado', a, [10, 11, 12]);
  check('espectador lento renumerado', b, [10, 11]);
  check('remocao limpa o estado', (fanout.removeTrack('b'), fanout.subscribers.has('b')), false);
  feed(pkt(13), { [DD]: ddFor(0) });
  check('apos remover, o outro segue', a.length, 4);
}

// ---------- 5. Politica de adaptacao ----------
{
  const { fanout, feed } = makeFanout();
  attach(fanout, 'v');
  feed(pkt(1), { [DD]: KEYFRAME_DD });
  feed(pkt(2), { [DD]: ddFor(3) }); // garante sawTemporalLayers

  check('perda alta desce', fanout.applyLoss('v', 0.10), { from: 2, to: 1 });
  check('perda alta desce de novo', fanout.applyLoss('v', 0.10), { from: 1, to: 0 });
  check('nao passa do piso', fanout.applyLoss('v', 0.10), null);

  for (let i = 0; i < 4; i++) check(`limpo ${i + 1}/5 ainda nao sobe`, fanout.applyLoss('v', 0), null);
  check('quinto relatorio limpo sobe', fanout.applyLoss('v', 0), { from: 0, to: 1 });

  // perda intermediaria nao sobe nem desce, mas zera a contagem
  check('zona morta nao mexe', fanout.applyLoss('v', 0.03), null);
  for (let i = 0; i < 4; i++) fanout.applyLoss('v', 0);
  check('contagem reiniciou', fanout.applyLoss('v', 0), { from: 1, to: 2 });
}

// ---------- 6. Sem camadas temporais, nao adapta ----------
{
  const { fanout, feed } = makeFanout();
  attach(fanout, 'v');
  feed(pkt(1), { [DD]: KEYFRAME_DD }); // so T0 visto
  check('sem camadas observadas nao degrada', fanout.applyLoss('v', 0.5), null);
}

console.log(fail ? `\n${fail} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(fail ? 1 : 0);
