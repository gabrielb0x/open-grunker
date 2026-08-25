/** A watcher joins as a spectator and must get the whole picture. */
import { WebSocket } from 'ws';
import * as K from './shared/constants.js';
import { KEY } from './shared/movement.js';

const ROOM = 'subzero-ffa';
function client(name, spectate = false) {
  const ws = new WebSocket('ws://127.0.0.1:7499/ws');
  const c = { ws, id: 0, seq: 0, snaps: [], frames: [], send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)) };
  ws.on('open', () => c.send({ o: K.C2S.HELLO, name, v: K.PROTOCOL_VERSION, room: ROOM, spectate }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.o === K.S2C.WELCOME) { c.id = m.id; if (!spectate) c.send({ o: K.C2S.PLAY }); }
    if (m.o === K.S2C.SNAPSHOT) c.snaps.push(m);
    else c.frames.push(m);
  });
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = client('Player1');
const b = client('Viewer', true);
await sleep(1500);
b.send({ o: K.C2S.SPECMODE, v: 1 });
await sleep(900);
// Burn some rounds so the watched magazine is not a full one.
for (let i = 0; i < 5; i++) { a.send({ o: K.C2S.SHOOT, y: 0, p: 0, a: 0, n: i + 1, b: i }); await sleep(120); }
await sleep(400);

const spec = b.frames.filter((m) => m.o === K.S2C.MATCH && m.phase === 'specMode').pop();
console.log('specMode frame:', spec ? `on=${spec.on} target=${spec.targetId} name=${spec.name} roster=${spec.scoreboard?.length}` : 'none');
const last = b.snaps.at(-1);
console.log('own body:', last?.y, '· watched ammo/reserve/reloading:', last?.sa, '· players visible:', last?.p?.length);
const row = last?.p?.find((e) => e[0] === a.id);
console.log('watched player entry: health', row?.[7], 'slot', row?.[8]);
a.ws.close(); b.ws.close(); process.exit(0);
