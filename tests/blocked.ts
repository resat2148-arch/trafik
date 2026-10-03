import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { DAY_LENGTH, hourAt } from '../src/game/clock.ts';

const preset = PRESETS.find((p) => p.id === 'maple')!;
preset.demand = 0.45;
const city = generateCity(preset);
const sim = new Sim(city.net, 7);
sim.initJunctions();
const demand = new Demand(city, sim, 5);
const dt = 1 / 30;
// instrument: count blocked per building and record why
const origOrigin = (demand as unknown as { originTrip: Function }).originTrip.bind(demand);
const blockedBy = new Map<number, number>();
(demand as unknown as { originTrip: Function }).originTrip = (o: { id: number }, ...rest: unknown[]) => {
  const before = demand.stats.blocked;
  origOrigin(o, ...rest);
  if (demand.stats.blocked > before) blockedBy.set(o.id, (blockedBy.get(o.id) ?? 0) + 1);
};
for (let t = 0; t < DAY_LENGTH; t += dt) {
  demand.update(dt, hourAt(t));
  sim.step(dt);
  sim.events.length = 0;
}
const list = [...blockedBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [id, n] of list) {
  const b = city.buildings[id];
  const d = demand.destFor(b)!;
  const lane = d.link.lanes[d.side === 1 ? 0 : d.link.lanes.length - 1];
  console.log(`bldg ${id} ${b.kind} pop=${b.pop.toFixed(0)} jobs=${b.jobs.toFixed(0)} blocked=${n} road=${b.road.name}(${b.road.cls}) link=${d.link.id} lanes=${d.link.lanes.length} s=${d.s.toFixed(0)}/${lane.len.toFixed(0)} vehsOnLane=${lane.vehs.length}`);
}
console.log('total blocked', demand.stats.blocked, 'generated', demand.stats.generated);
