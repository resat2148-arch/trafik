import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { hourAt } from '../src/game/clock.ts';
import type { Conn, Lane } from '../src/sim/network.ts';
import type { Vehicle } from '../src/sim/vehicle.ts';

const preset = PRESETS.find((p) => p.id === (process.argv[2] ?? 'maple'))!;
const city = generateCity(preset);
const sim = new Sim(city.net, 99);
sim.initJunctions();
const demand = new Demand(city, sim, 5);
const dt = 1 / 30;
let target: Vehicle | null = null;
let steps = 0;
const startT = Number(process.argv[3] ?? 100);
for (let t = 0; t < startT + 60; t += dt) {
  demand.update(dt, hourAt(t));
  sim.step(dt);
  sim.events.length = 0;
  if (t > startT && !target) {
    target = sim.vehicles.find((v) => v.seg.isLane && v.holdLine && v.holdWhy === 'stop' && v.v < 1 && (v.seg as Lane).vehs.indexOf(v) === (v.seg as Lane).vehs.length - 1) ?? null;
    if (target) console.log('tracing', target.id);
  }
  if (target && steps++ % 6 === 0 && steps < 900) {
    const v = target;
    const lane = v.seg.isLane ? (v.seg as Lane) : null;
    const c = (lane ? v.plan[0] : v.seg) as Conn;
    let info = '';
    if (lane) {
      const n = c.node;
      info = `dEnd=${(lane.len - v.s).toFixed(2)} q=[${n.stopQueue.map((w) => w.id + (w === v ? '*' : '') + ':' + (sim.time - w.stopDoneT).toFixed(1)).join(',')}]`;
    } else info = `inside s=${v.s.toFixed(1)}/${c.len.toFixed(1)}`;
    console.log(`t=${t.toFixed(2)} v=${v.v.toFixed(2)} acc=${v.acc.toFixed(2)} hold=${v.holdLine} why=${v.holdWhy} stopDone=${v.stopDone} start=${v.startDelay.toFixed(2)} ${info} state=${v.state}`);
    if (v.state === 'gone') break;
  }
}
