import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { hourAt } from '../src/game/clock.ts';
import type { Conn, Lane } from '../src/sim/network.ts';

const preset = PRESETS.find((p) => p.id === 'maple')!;
const city = generateCity(preset);
const sim = new Sim(city.net, 99);
sim.initJunctions();
for (const n of city.net.nodes) if (!n.gateway && n.arms.length >= 3 && n.control === 'allstop') sim.setControl(n, 'roundabout');
const demand = new Demand(city, sim, 5);
const dt = 1 / 30;
const node = city.net.nodes[12];
console.log('ra', node.ra, 'arms', node.arms.map((a) => [a.road.cls, a.trim.toFixed(1), (a.angle * 57.3).toFixed(0)]));
for (const c of node.conns) console.log(`conn#${c.id} ${c.kind} len=${c.len.toFixed(1)} vmax=${c.vmax.toFixed(1)} conflicts=${c.conflicts.map((k) => `${k.other.kind}#${k.other.id}[${k.sIn.toFixed(1)}-${k.sOut.toFixed(1)}|${k.oIn.toFixed(1)}-${k.oOut.toFixed(1)}${k.merge ? 'M' : ''}]`).join(' ')}`);
for (let t = 0; t < 130; t += dt) {
  demand.update(dt, hourAt(t));
  sim.step(dt);
  sim.events.length = 0;
}
// snapshot of the roundabout
for (const c of node.conns) {
  if (c.vehs.length) console.log(`on ${c.kind}#${c.id}: ${c.vehs.map((v) => `${v.id}@${v.s.toFixed(1)} v=${v.v.toFixed(1)} next=${v.plan[0]?.isLane ? 'lane' : (v.plan[0] as Conn)?.kind + '#' + v.plan[0]?.id}`).join(', ')}`);
}
for (const a of node.arms) {
  const l = a.inLink;
  if (!l) continue;
  for (const lane of l.lanes) {
    const vs = lane.vehs;
    const f = vs[vs.length - 1];
    if (f) console.log(`approach lane#${lane.id} q=${vs.length} front ${f.id} dEnd=${(lane.len - f.s).toFixed(1)} v=${f.v.toFixed(1)} hold=${f.holdLine} why=${f.holdWhy} wait=${f.waitT.toFixed(1)} plan0=${(f.plan[0] as Conn)?.kind}#${f.plan[0]?.id}`);
  }
}
for (const a of node.arms) {
  const l = a.outLink;
  if (!l) continue;
  for (const lane of l.lanes) console.log(`exit lane#${lane.id} vehs=${lane.vehs.length} first=${lane.vehs[0] ? (lane.vehs[0].s - lane.vehs[0].len).toFixed(1) : '-'} len=${lane.len.toFixed(1)}`);
}
