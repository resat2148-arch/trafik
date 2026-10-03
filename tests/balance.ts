// Balance test: plays days with the game's satisfaction / money rules and a
// simple player strategy.  Usage:
//   node --experimental-strip-types tests/balance.ts <preset> <fromDay> <toDay> <strategy>
// strategies: none | tutorial | good

import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { DAY_LENGTH, hourAt } from '../src/game/clock.ts';
import { dayConfig, starsFor, tripScore } from '../src/game/config.ts';
import type { Node } from '../src/sim/network.ts';

const presetId = process.argv[2] ?? 'maple';
const from = Number(process.argv[3] ?? 1);
const to = Number(process.argv[4] ?? 5);
const strategy = process.argv[5] ?? 'tutorial';
const demandArg = process.argv.find((a) => a.startsWith('--demand='));
const growthArg = process.argv.find((a) => a.startsWith('--growth='));
const preset = PRESETS.find((p) => p.id === presetId)!;
if (demandArg) preset.demand = Number(demandArg.split('=')[1]);
if (growthArg) preset.growth = Number(growthArg.split('=')[1]);
const city = generateCity(preset);
const sim = new Sim(city.net, 7);
sim.initJunctions();
import { RNG as RNG2 } from '../src/core/rng.ts';
{
  const lr = new RNG2(preset.seed + 99);
  for (const n of city.net.nodes) if (n.signal) n.signal.legacyTiming(() => lr.next());
}
const demand = new Demand(city, sim, 5);
const dt = 1 / 30;

import { pickMajorAxis } from '../src/world/citygen.ts';
import { unlocksFor } from '../src/game/config.ts';
const fixed = new Set<Node>();
const retimed = new Set<Node>();
const actThreshold = Number(process.argv.find((a) => a.startsWith('--act='))?.split('=')[1] ?? 30);
const actEvery = Number(process.argv.find((a) => a.startsWith('--every='))?.split('=')[1] ?? 25);
let actions = 0;
function smartPlayer(day: number): void {
  const un = unlocksFor(preset, day);
  let worst: Node | null = null;
  for (const n of city.net.nodes) {
    if (n.gateway || n.arms.length < 3 || fixed.has(n)) continue;
    if (n.delayEMA < actThreshold || n.passed < 8) continue;
    if (!worst || n.delayEMA > worst.delayEMA) worst = n;
  }
  if (!worst) {
    // upgrade fixed signals when smart control is available
    if (un.has('actuated')) for (const n of city.net.nodes) if (n.signal && n.signal.mode === 'fixed') n.signal.mode = 'actuated';
    return;
  }
  const n = worst;
  const majors = n.arms.filter((a) => a.road.cls !== 'local').length;
  actions++;
  if (n.control === 'allstop') {
    if (majors >= 2) {
      sim.setControl(n, 'signal');
      n.signal!.autoTime();
      retimed.add(n);
    } else if (un.has('roundabout') && n.maxRoundaboutR >= 9) sim.setControl(n, 'roundabout');
    else {
      pickMajorAxis(n);
      n.stopMinor = false;
      sim.setControl(n, 'priority');
    }
  } else if (n.control === 'priority') {
    if (n.stopMinor) {
      n.stopMinor = false;
      sim.rebuildNode(n);
      return;
    }
    if (un.has('roundabout') && n.maxRoundaboutR >= 9 && majors < 2) sim.setControl(n, 'roundabout');
    else sim.setControl(n, 'signal');
  } else if (n.control === 'signal' && n.signal) {
    if (!retimed.has(n)) {
      n.signal.autoTime();
      retimed.add(n);
      return;
    }
    if (un.has('smart')) n.signal.mode = 'smart';
    else if (un.has('actuated')) n.signal.mode = 'actuated';
    else if (n.signal.plan === 'two' && un.has('arrows')) n.signal.setPlan('leftlead');
  }
  if (n.signal && un.has('actuated') && n.signal.mode === 'fixed') n.signal.mode = 'actuated';
  fixed.add(n);
}

function applyStrategy(day: number): void {
  if (strategy === 'none') return;
  if (strategy === 'tutorial' || strategy === 'good' || strategy === 'smart') {
    const n = city.tutorialNode;
    if (n && n.control !== 'signal') sim.setControl(n, 'signal');
  }
  if (strategy === 'good') {
    for (const n of city.net.nodes) {
      if (n.gateway || n.arms.length < 3) continue;
      const majors = n.arms.filter((a) => a.road.cls !== 'local').length;
      if (majors >= 2 && n.control !== 'signal') sim.setControl(n, 'signal');
      if (n.signal && day >= 2) n.signal.mode = 'smart';
      if (n.control === 'allstop' && day >= 3 && n.maxRoundaboutR >= 9) sim.setControl(n, 'roundabout');
    }
  }
}

let sat = 70;
let lastBlocked = 0;
for (let day = from; day <= to; day++) {
  const cfg = dayConfig(preset, day);
  demand.setDay(day);
  demand.scale = cfg.demand;
  sim.aggressionBias = cfg.aggression;
  sim.clearAll();
  demand.clear();
  demand.stats.blocked = 0;
  lastBlocked = 0;
  applyStrategy(day);
  // warm-up like the game
  demand.scale = cfg.demand * 2.2;
  for (let i = 0; i < 26 * 30; i++) {
    demand.update(dt, 6);
    sim.step(dt);
  }
  sim.events.length = 0;
  demand.scale = cfg.demand;
  let t = 0;
  let satArea = 0;
  let minSat = sat;
  let trips = 0;
  let money = 0;
  let abandons = 0;
  let maxVeh = 0;
  let fired = false;
  const samples: string[] = [];
  const ratios: number[] = [];
  const timeUse: Record<string, number> = {};
  for (; t < DAY_LENGTH; t += dt) {
    const hour = hourAt(t);
    demand.update(dt, hour);
    sim.rain = cfg.rain && hour >= cfg.rain[0] && hour <= cfg.rain[1] ? 1 : 0;
    sim.step(dt);
    if (strategy === 'smart' && Math.floor(t / actEvery) !== Math.floor((t - dt) / actEvery)) smartPlayer(day);
    for (const e of sim.events) {
      if (e.type === 'trip') {
        ratios.push(e.time / e.ff);
        const sc = tripScore(e.time, e.ff);
        sat += (sc - sat) * 0.018;
        money += Math.round(3 + (sc / 100) * 4);
        trips++;
      } else if (e.type === 'abandon') {
        sat -= 0.9;
        abandons++;
      } else if (e.type === 'crash') sat -= 2.5;
    }
    sim.events.length = 0;
    let furious = 0;
    for (const v of sim.vehicles) if (v.mood > 0.5) furious++;
    if (Math.floor(t) !== Math.floor(t - dt) && hour > 16.5 && hour < 19) {
      for (const v of sim.vehicles) {
        let k: string;
        const vd = sim.vdes(v, v.seg);
        if (v.state !== 'drive') k = v.state;
        else if (v.v > 0.7 * vd) k = 'free';
        else if (v.v > 2) k = v.seg.isLane ? 'slow-lane' : 'slow-junction';
        else if (!v.seg.isLane) k = 'stopped-junction:' + (v.seg as unknown as { node: Node }).node.control;
        else if (v.holdLine && v.plan[0] && !v.plan[0].isLane) k = 'line-' + (v.plan[0] as unknown as { node: Node }).node.control + '-' + v.holdWhy;
        else {
          const lane = v.seg as unknown as { vehs: unknown[]; link: { road: { cls: string }; to: Node } };
          const i = lane.vehs.indexOf(v);
          k = i < lane.vehs.length - 1 ? 'queue-' + lane.link.road.cls + '>' + lane.link.to.control : 'front';
        }
        timeUse[k] = (timeUse[k] ?? 0) + 1;
      }
    }
    sat -= Math.min(0.5, furious * 0.005) * dt;
    const homeQ = demand.waitingAtHome() + sim.gatewayBacklog();
    sat -= Math.min(0.25, homeQ * 0.002) * dt;
    if (demand.stats.blocked > lastBlocked) {
      sat -= (demand.stats.blocked - lastBlocked) * 0.45;
      lastBlocked = demand.stats.blocked;
    }
    sat = Math.max(0, Math.min(100, sat));
    satArea += sat * dt;
    minSat = Math.min(minSat, sat);
    maxVeh = Math.max(maxVeh, sim.vehicles.length);
    if (Math.floor(t / 40) !== Math.floor((t - dt) / 40)) samples.push(`${hour.toFixed(1)}h:${Math.round(sat)}%/${sim.vehicles.length}v/${furious}f`);
    if (sat <= 0) {
      fired = true;
      break;
    }
  }
  const avg = satArea / Math.max(1, t);
  console.log(
    `day ${day} [${strategy}${strategy === 'smart' ? ' a=' + actions : ''}] demand=${cfg.demand.toFixed(2)} avgSat=${avg.toFixed(0)} min=${minSat.toFixed(0)} end=${sat.toFixed(0)} stars=${starsFor(avg)} trips=${trips} toll=$${money} abandon=${abandons} blocked=${demand.stats.blocked} maxVeh=${maxVeh} ${fired ? 'FIRED' : ''}`,
  );
  console.log('   ', samples.join(' '));
  ratios.sort((a, b) => a - b);
  const pc = (q: number): string => (ratios[Math.floor(q * (ratios.length - 1))] ?? 0).toFixed(2);
  const tot = Object.values(timeUse).reduce((a, b) => a + b, 0);
  console.log('    pm-peak:', Object.entries(timeUse).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${((100 * n) / tot).toFixed(0)}%`).join(', '));
  console.log(`    time/ff p10=${pc(0.1)} p25=${pc(0.25)} p50=${pc(0.5)} p75=${pc(0.75)} p90=${pc(0.9)}`);
  if (fired) break;
}
void (null as unknown as Node);

// ---- end-of-run diagnostics
{
  const reasons: Record<string, number> = {};
  for (const v of sim.vehicles) {
    if (v.stuckT < 25) continue;
    let k = '';
    if (!v.seg.isLane) {
      const c = v.seg as unknown as { node: Node; kind: string; turn: string };
      k = `inside:${c.node.control}:${c.kind}/${c.turn}`;
    } else {
      const lane = v.seg as unknown as { vehs: unknown[]; len: number; link: { to: Node } };
      const idx = lane.vehs.indexOf(v);
      if (idx < lane.vehs.length - 1) k = 'queue';
      else if (v.holdLine) k = `line:${(v.plan[0] as unknown as { node: Node }).node.control}:${v.holdWhy}`;
      else if (!v.plan.length) k = `noplan(dest=${!!v.dest},ri=${v.ri}/${v.route.length})`;
      else k = `front:v=${v.v.toFixed(1)}`;
    }
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  console.log('stuck:', JSON.stringify(reasons));
  const worst = city.net.nodes.filter((n) => !n.gateway && n.arms.length >= 3).sort((a, b) => b.delayEMA - a.delayEMA).slice(0, 6);
  for (const n of worst) {
    let q = 0;
    for (const a of n.arms) for (const l of a.inLink?.lanes ?? []) q += l.vehs.length;
    let inside = 0;
    for (const c of n.conns) inside += c.vehs.length;
    console.log(`  node ${n.id} ${n.control}${n.signal ? '/' + n.signal.mode : ''} ${n.name} delay=${n.delayEMA.toFixed(0)} passed=${n.passed} queued=${q} inside=${inside} arms=${n.arms.map((a) => a.road.cls[0] + (a.inLink?.lanes.length ?? 0)).join(',')}`);
  }
  // where are vehicles?
  let onLocal = 0;
  let parkingWait = 0;
  for (const v of sim.vehicles) {
    if (v.seg.isLane && (v.seg as unknown as { link: { road: { cls: string } } }).link.road.cls === 'local') onLocal++;
    if (v.dest && v.ri === v.route.length - 1) parkingWait++;
  }
  console.log(`  vehicles=${sim.vehicles.length} onLocal=${onLocal} onDestLink=${parkingWait} home=${demand.waitingAtHome()} gw=${sim.gatewayBacklog()}`);
}
