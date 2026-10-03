import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { hourAt } from '../src/game/clock.ts';
import type { Conn } from '../src/sim/network.ts';

const preset = PRESETS.find((p) => p.id === 'maple')!;
const city = generateCity(preset);
const sim = new Sim(city.net, 99);
sim.initJunctions();
const demand = new Demand(city, sim, 5);
demand.scale = 0.6;
const dt = 1 / 30;
const node = city.net.nodes[8];
const c370 = node.conns.find((c) => c.id === 370)!;
const c371 = node.conns.find((c) => c.id === 371)!;
for (const c of [c370, c371]) {
  console.log(`conn ${c.id} ${c.turn} from lane ${c.fromLane?.id} (idx ${c.fromLane?.index}) arm ${c.inArm?.index} start=(${c.path.start().x.toFixed(1)},${c.path.start().y.toFixed(1)}) len=${c.len.toFixed(1)}`);
  for (const k of c.conflicts) console.log(`   vs ${k.other.id} ${k.other.turn} [${k.sIn.toFixed(1)}-${k.sOut.toFixed(1)}] other[${k.oIn.toFixed(1)}-${k.oOut.toFixed(1)}] merge=${k.merge}`);
}
for (let t = 0; t < 333; t += dt) {
  demand.update(dt, hourAt(t));
  sim.step(dt);
  sim.events.length = 0;
  sim.updatePoses();
  if (t > 324) {
    const fmt = (c: Conn) => c.vehs.map((v) => `#${v.id}@${v.s.toFixed(1)} v=${v.v.toFixed(1)} a=${v.acc.toFixed(1)} (${v.x.toFixed(1)},${v.y.toFixed(1)})`).join(' ');
    const lanes = [c370.fromLane!, c371.fromLane!];
    const fr = lanes.map((l) => { const f = l.vehs[l.vehs.length - 1]; return f ? `lane${l.id}: #${f.id} dEnd=${(l.len - f.s).toFixed(1)} v=${f.v.toFixed(1)} plan0=${f.plan[0]?.id} hold=${f.holdLine} why=${f.holdWhy} stopDone=${f.stopDone} committed=${f.committed?.id}` : ''; }).join(' | ');
    if (Math.round(t * 30) % 6 === 0) console.log(`t=${t.toFixed(2)} 370:[${fmt(c370)}] 371:[${fmt(c371)}] ${fr} q=${node.stopQueue.map((v) => v.id).join(',')}`);
  }
}
