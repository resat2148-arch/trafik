// Controlled discharge test: a queue of cars at a red light turns green.
import { Network } from '../src/sim/network.ts';
import type { Lane, Conn } from '../src/sim/network.ts';
import { buildJunction, updateLinkNexts } from '../src/sim/junction.ts';
import { Sim } from '../src/sim/sim.ts';
import { Vehicle, MODEL } from '../src/sim/vehicle.ts';
import { RNG } from '../src/core/rng.ts';

const net = new Network();
const N = net.addNode(0, 0);
const W = net.addNode(-300, 0);
const E = net.addNode(300, 0);
const S = net.addNode(0, 150);
const Nn = net.addNode(0, -150);
for (const g of [W, E, S, Nn]) g.gateway = true;
const cls = (process.argv[2] ?? 'avenue') as 'avenue' | 'local';
net.addRoad(W, N, cls);
net.addRoad(N, E, cls);
net.addRoad(S, N, cls);
net.addRoad(N, Nn, cls);
net.buildGeometry();
N.control = 'signal';
const sim = new Sim(net, 3);
sim.initJunctions();
updateLinkNexts(net);
const sig = N.signal!;
sig.phases.forEach((p) => (p.dur = 40));
const westIn = net.roads[0].ab; // W -> N
const exitE = net.roads[1].ab; // N -> E
const lane: Lane = westIn.lanes[0];
const rng = new RNG(5);
const n = 15;
const cars: Vehicle[] = [];
let s = lane.len - 0.6;
for (let i = 0; i < n; i++) {
  const v = new Vehicle('car', MODEL.sedan, 0xffffff);
  v.personalise(rng, 0);
  v.route = [westIn, exitE];
  v.ri = 0;
  v.seg = lane;
  v.s = s;
  v.v = 0;
  v.dest = null;
  lane.addVehicle(v);
  sim.vehicles.push(v);
  sim.planAhead(v);
  cars.push(v);
  s -= v.len + v.s0;
}
// force red for the west approach first: find phase that serves west straight
const conn = lane.moves.get(exitE.id)![0] as Conn;
const phaseIdx = sig.phases.findIndex((p) => p.green.has(conn));
sig.cur = (phaseIdx + 1) % sig.phases.length;
sig.state = 'G';
sig.t = 0;
sig.phases[sig.cur].dur = 5;
const cross = new Map<number, number>();
const dt = 1 / 30;
let greenAt = -1;
for (let t = 0; t < 120; t += dt) {
  sim.step(dt);
  sim.events.length = 0;
  if (greenAt < 0 && (conn.sig === 3 || conn.sig === 2)) greenAt = sim.time;
  for (const v of cars) if (!cross.has(v.id) && v.seg !== lane) cross.set(v.id, sim.time);
}
const times = cars.map((v) => cross.get(v.id) ?? NaN);
console.log(`class=${cls} green at ${greenAt.toFixed(2)}`);
let prev = greenAt;
const hw: string[] = [];
for (const tm of times) {
  hw.push((tm - prev).toFixed(2));
  prev = tm;
}
console.log('crossing headways:', hw.join(' '));
const sat = (times[n - 1] - times[4]) / (n - 5);
console.log(`saturation headway (veh 5..15): ${sat.toFixed(2)} s => ${(3600 / sat).toFixed(0)} veh/h/lane; start-up lost ~ ${(times[4] - greenAt - 5 * sat).toFixed(2)} s`);
console.log('speeds at stop line approx:', cars.slice(0, 8).map((v) => v.v.toFixed(1)).join(' '));
void buildJunction;
