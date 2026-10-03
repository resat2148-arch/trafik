// Measure saturation flow (discharge headway) at a signalized approach.
import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { hourAt } from '../src/game/clock.ts';
import { SIG_G, SIG_P } from '../src/sim/network.ts';
import type { Conn, Lane } from '../src/sim/network.ts';

const preset = PRESETS.find((p) => p.id === 'maple')!;
preset.demand = 1.2;
const city = generateCity(preset);
const sim = new Sim(city.net, 7);
sim.initJunctions();
const node = city.tutorialNode!;
sim.setControl(node, 'signal');
const demand = new Demand(city, sim, 5);
const dt = 1 / 30;
// per lane: last entry time while green with queue
const lastEntry = new Map<Lane, number>();
const headways: number[] = [];
const prevSeg = new Map<number, unknown>();
let t = 0;
for (; t < 200; t += dt) {
  demand.update(dt, hourAt(t));
  sim.step(dt);
  sim.events.length = 0;
  // detect entries into the node's connectors
  for (const c of node.conns) {
    for (const v of c.vehs) {
      if (prevSeg.get(v.id) === c) continue;
      prevSeg.set(v.id, c);
      const lane = c.fromLane!;
      // queue behind (saturated condition): at least 3 vehicles waiting within 25 m
      let q = 0;
      for (const w of lane.vehs) if (lane.len - w.s < 30) q++;
      const green = c.sig === SIG_G || c.sig === SIG_P;
      const last = lastEntry.get(lane);
      if (green && q >= 3 && last !== undefined && sim.time - last < 6 && c.turn === 'S') headways.push(sim.time - last);
      lastEntry.set(lane, sim.time);
    }
  }
}
headways.sort((a, b) => a - b);
const avg = headways.reduce((a, b) => a + b, 0) / Math.max(1, headways.length);
console.log(`samples=${headways.length} avg headway=${avg.toFixed(2)}s => ${(3600 / avg).toFixed(0)} veh/h/lane; median=${headways[Math.floor(headways.length / 2)]?.toFixed(2)}`);
void (null as unknown as Conn);
