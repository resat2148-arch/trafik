// Headless simulation test: runs a city for a simulated day without
// rendering and reports throughput, delays, overlaps (collisions) and
// deadlocks.  Usage: node --experimental-strip-types tests/headless.ts [preset|growth] [day|level] [seconds]

import { PRESETS, generateCity } from '../src/world/citygen.ts';
import { GROWTH_PRESET, generateGrowthCity } from '../src/world/growth.ts';
import { Sim } from '../src/sim/sim.ts';
import { Demand } from '../src/sim/demand.ts';
import { DAY_LENGTH, hourAt, fmtHour } from '../src/game/clock.ts';
import type { Conn, Lane } from '../src/sim/network.ts';

const presetId = process.argv[2] ?? 'maple';
const day = Number(process.argv[3] ?? 1);
const secs = Number(process.argv[4] ?? DAY_LENGTH);
// 'growth' runs a level of the growing city (the day argument is the level)
const preset = presetId === 'growth' ? GROWTH_PRESET : PRESETS.find((p) => p.id === presetId)!;

const t0 = performance.now();
const city = presetId === 'growth' ? generateGrowthCity(day) : generateCity(preset);
const t1 = performance.now();
const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const seed = seedArg ? Number(seedArg.slice(7)) : 0;
const sim = new Sim(city.net, 99 + seed);
sim.initJunctions();
const fix = process.argv.includes('--fix');
if (fix) {
  // a sensible engineer: signals at major crossings, roundabouts at busy local ones
  for (const n of city.net.nodes) {
    if (n.gateway || n.arms.length < 3) continue;
    const majors = n.arms.filter((a) => a.road.cls !== 'local').length;
    if (majors >= 2) sim.setControl(n, 'signal');
    else if (majors === 1 && n.arms.length >= 4) sim.setControl(n, 'signal');
  }
}
if (process.argv.includes('--ra')) {
  for (const n of city.net.nodes) if (!n.gateway && n.arms.length >= 3 && n.control === 'allstop') sim.setControl(n, 'roundabout');
}
if (process.argv.includes('--bent')) {
  // every unsignalised junction becomes a priority junction whose major road turns a corner
  for (const n of city.net.nodes) {
    if (n.gateway || n.arms.length < 3 || n.control === 'signal') continue;
    sim.setControl(n, 'priority');
    n.majorRoads = new Set([n.arms[0].road.id, n.arms[1].road.id]);
    sim.rebuildNode(n);
  }
}
if (process.argv.includes('--smart')) {
  for (const n of city.net.nodes) if (n.signal) {
    n.signal.mode = 'smart';
    n.signal.autoTime();
  }
}
if (process.argv.includes('--actuated')) {
  for (const n of city.net.nodes) if (n.signal) n.signal.mode = 'actuated';
}
if (process.argv.includes('--legacy')) {
  // the outdated timing plans a fresh city starts with
  let k = 1;
  for (const n of city.net.nodes) if (n.signal) n.signal.legacyTiming(() => ((k = (k * 16807) % 2147483647) / 2147483647));
}
// --wave=NAME[,NAME]: green waves along these streets
const waveArg = process.argv.find((a) => a.startsWith('--wave='));
if (waveArg) for (const name of waveArg.slice(7).split(',')) sim.waves.add(name);
const demand = new Demand(city, sim, 5 + seed);
let pop = 0;
let jobs = 0;
for (const b of city.buildings) if (b.day <= day) {
  pop += b.pop;
  jobs += b.jobs;
}
console.log(`pop ${pop.toFixed(0)} jobs ${jobs.toFixed(0)}`);
demand.setDay(day);
demand.scale = Math.pow(1 + preset.growth, day - 1);
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
if (scaleArg) demand.scale *= Number(scaleArg.split('=')[1]);

console.log(
  `city ${preset.id}: nodes=${city.net.nodes.length} roads=${city.net.roads.length} links=${city.net.links.length} blocks=${city.blocks.length} buildings=${city.buildings.length} gen=${(t1 - t0).toFixed(0)}ms`,
);
const ctrl: Record<string, number> = {};
for (const n of city.net.nodes) ctrl[n.control] = (ctrl[n.control] ?? 0) + 1;
console.log('controls', JSON.stringify(ctrl), 'bus lines', city.busLines.length);

// --widen=T: at sim time T widen every road by one lane (two on divided roads) while traffic runs
const widenArg = process.argv.find((a) => a.startsWith('--widen='));
const widenAt = widenArg ? Number(widenArg.split('=')[1]) : -1;

const dt = 1 / 30;
let overlaps = 0;
let zoneViolations = 0;
let maxVeh = 0;
let tripTimes = 0;
let tripFF = 0;
let trips = 0;
let abandons = 0;
let crashes = 0;
const simStart = performance.now();
let lastReport = 0;
const worstOverlap: string[] = [];
const timeUse: Record<string, number> = {};

for (let t = 0; t < secs; t += dt) {
  if (widenAt >= 0 && t >= widenAt && t - dt < widenAt) {
    let widened = 0;
    const vBefore = sim.vehicles.length;
    for (const r of city.net.roads) {
      if (r.bridge) continue;
      const div = r.median > 0;
      const ab = r.lanesAB + (div || r.id % 2 === 0 ? 1 : 0);
      const ba = r.lanesBA + (div || r.id % 2 === 1 ? 1 : 0);
      if (sim.reshapeRoad(r, r.maxLanes + (div ? 2 : 1), ab, ba)) widened++;
    }
    console.log(`widened ${widened}/${city.net.roads.length} roads at t=${t.toFixed(1)}, vehicles ${vBefore} -> ${sim.vehicles.length}`);
  }
  const hour = hourAt(t);
  demand.update(dt, hour);
  sim.step(dt);
  for (const e of sim.events) {
    if (e.type === 'trip') {
      trips++;
      tripTimes += e.time;
      tripFF += e.ff;
    } else if (e.type === 'abandon') abandons++;
    else if (e.type === 'crash') crashes++;
  }
  sim.events.length = 0;
  maxVeh = Math.max(maxVeh, sim.vehicles.length);
  // overlap check every 0.5 s
  if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) {
    for (const l of city.net.links)
      for (const lane of l.lanes) checkSeg(lane);
    for (const n of city.net.nodes) {
      for (const c of n.conns) checkSeg(c);
      // conflict zone double occupancy
      for (const c of n.conns) {
        for (const k of c.conflicts) {
          if (k.merge) continue;
          if (k.other.id < c.id) continue;
          for (const a of c.vehs) {
            if (!(a.s > k.sIn + 0.8 && a.s - a.len < k.sOut - 0.8)) continue;
            for (const b of k.other.vehs) {
              if (b.s > k.oIn + 0.8 && b.s - b.len < k.oOut - 0.8) {
                if (a === b) {
                  if (worstOverlap.length < 8) worstOverlap.push(`SAME VEHICLE #${a.id} in conn ${c.id} and ${k.other.id}; seg=${a.seg.id} last=${a.lastEvt}`);
                  continue;
                }
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (d < 2.2) {
                  zoneViolations++;
                  if (worstOverlap.length < 8)
                    worstOverlap.push(
                      `zone node=${n.id}(${n.control}) ${c.kind}/${c.turn}#${c.id} sig=${c.sig} vs ${k.other.kind}/${k.other.turn}#${k.other.id} sig=${k.other.sig} t=${t.toFixed(1)} d=${d.toFixed(2)}`,
                    );
                }
              }
            }
          }
        }
      }
    }
  }
  if (Math.floor(t) !== Math.floor(t - dt)) {
    for (const v of sim.vehicles) {
      let k: string;
      const vd = sim.vdes(v, v.seg);
      if (v.state !== 'drive') k = v.state;
      else if (v.v > 0.7 * vd) k = 'free';
      else if (v.v > 2) k = v.seg.isLane ? 'slow-lane' : 'slow-junction';
      else if (!v.seg.isLane) k = 'stopped-junction';
      else if (v.holdLine && v.plan[0] && !v.plan[0].isLane) k = 'line-' + (v.plan[0] as Conn).node.control + '-' + v.holdWhy;
      else {
        const lane = v.seg as Lane;
        const i = lane.vehs.indexOf(v);
        k = i < lane.vehs.length - 1 ? 'queue' : v.plan.length ? 'front-other' : 'front-noplan';
      }
      timeUse[k] = (timeUse[k] ?? 0) + 1;
    }
  }
  if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) {
    // invariant: every vehicle is listed exactly in its own segment
    const seen = new Map<number, number>();
    const segs: (Lane | Conn)[] = [];
    for (const l of city.net.links) for (const lane of l.lanes) segs.push(lane);
    for (const n of city.net.nodes) segs.push(...n.conns, ...n.dying);
    for (const sg of segs) for (const v of sg.vehs) {
      seen.set(v.id, (seen.get(v.id) ?? 0) + 1);
      if (v.seg !== sg && worstOverlap.length < 12) worstOverlap.push(`INVARIANT #${v.id} listed in seg ${sg.id} but v.seg=${v.seg.id} state=${v.state} last=${v.lastEvt}`);
    }
    for (const [id, n] of seen) if (n > 1 && worstOverlap.length < 12) worstOverlap.push(`INVARIANT #${id} listed ${n} times`);
  }
  if (t - lastReport >= 30) {
    lastReport = t;
    let stuck = 0;
    let sumV = 0;
    for (const v of sim.vehicles) {
      if (v.stuckT > 60) stuck++;
      sumV += v.v;
    }
    console.log(
      `${fmtHour(hour)} t=${t.toFixed(0)} veh=${sim.vehicles.length} trips=${trips} meanV=${(sumV / Math.max(1, sim.vehicles.length) * 3.6).toFixed(1)}km/h stuck60=${stuck} abandon=${abandons} crash=${crashes} gwQ=${sim.gatewayBacklog()} home=${demand.waitingAtHome()} overlaps=${overlaps} zone=${zoneViolations}`,
    );
  }
}

function checkSeg(seg: Lane | Conn): void {
  const vs = seg.vehs;
  for (let i = 1; i < vs.length; i++) {
    if (vs[i].s < vs[i - 1].s) {
      overlaps++;
      if (worstOverlap.length < 8) worstOverlap.push(`order seg=${seg.id} lane=${seg.isLane}`);
      continue;
    }
    const gap = vs[i].s - vs[i].len - vs[i - 1].s;
    if (gap < -0.8) {
      overlaps++;
      if (worstOverlap.length < 8) worstOverlap.push(`overlap seg=${seg.id} lane=${seg.isLane} gap=${gap.toFixed(2)} t=${sim.time.toFixed(1)}\n      back ${vs[i - 1].id} ${vs[i - 1].kind} s=${vs[i - 1].s.toFixed(1)} v=${vs[i - 1].v.toFixed(1)} ${vs[i - 1].state} [${vs[i - 1].lastEvt} @${vs[i - 1].lastEvtT.toFixed(1)}]\n      front ${vs[i].id} ${vs[i].kind} s=${vs[i].s.toFixed(1)} len=${vs[i].len} v=${vs[i].v.toFixed(1)} ${vs[i].state} [${vs[i].lastEvt} @${vs[i].lastEvtT.toFixed(1)}]`);
    }
  }
}

const simMs = performance.now() - simStart;
console.log('---');
console.log(`sim ${secs.toFixed(0)}s in ${(simMs / 1000).toFixed(2)}s real (${((secs / simMs) * 1000).toFixed(1)}x), max vehicles ${maxVeh}`);
console.log(`trips ${trips}, mean travel ${(tripTimes / Math.max(1, trips)).toFixed(1)}s, ff ${(tripFF / Math.max(1, trips)).toFixed(1)}s, ratio ${(tripTimes / Math.max(1, tripFF)).toFixed(2)}`);
console.log(`abandoned ${abandons}, crashes ${crashes}, redRuns ${sim.stats.redRuns}, overlaps ${overlaps}, zoneViolations ${zoneViolations}, blocked ${demand.stats.blocked}`);
for (const w of worstOverlap) console.log('  ', w);
// --street=NAME: approach delays along a street in both directions (e.g. to judge a green wave)
const streetArg = process.argv.find((a) => a.startsWith('--street='));
if (streetArg) {
  const name = streetArg.slice(9);
  const roads = city.net.roads.filter((r) => r.name === name);
  const sig = sim.signalNodes.filter((n) => n.arms.some((a) => a.road.name === name));
  const c = sim.waves.get(name);
  let fwd = 0;
  let fwdN = 0;
  let back = 0;
  let backN = 0;
  const ax = c ? c.axis : { x: roads[0].b.x - roads[0].a.x, y: roads[0].b.y - roads[0].a.y };
  for (const r of roads)
    for (const l of [r.ab, r.ba]) {
      if (!sig.includes(l.to)) continue;
      const along = (l.to.x - l.from.x) * ax.x + (l.to.y - l.from.y) * ax.y > 0;
      if (along) {
        fwd += l.delayEMA;
        fwdN++;
      } else {
        back += l.delayEMA;
        backN++;
      }
    }
  console.log(
    `street ${name}: ${sig.length} signals, wave=${c ? `dir ${c.dir} active ${c.active} cycle ${sim.waves.cycle}` : 'off'}; mean signal delay along axis ${(fwd / Math.max(1, fwdN)).toFixed(1)}s, against ${(back / Math.max(1, backN)).toFixed(1)}s`,
  );
}
const los: Record<string, number> = {};
for (const n of city.net.nodes) if (!n.gateway && n.passed > 0) los[sim.nodeLOS(n)] = (los[sim.nodeLOS(n)] ?? 0) + 1;
console.log('LOS', JSON.stringify(los));
const worst = city.net.nodes.filter((n) => !n.gateway).sort((a, b) => b.delayEMA - a.delayEMA).slice(0, 5);
for (const n of worst) console.log(`  node ${n.id} ${n.control} ${n.name} delay=${n.delayEMA.toFixed(1)} passed=${n.passed}`);

// ---- diagnostics: why are vehicles stuck?
const reasons: Record<string, number> = {};
const samples: string[] = [];
for (const v of sim.vehicles) {
  if (v.stuckT < 30) continue;
  let r = '';
  if (v.seg.isLane) {
    const lane = v.seg as Lane;
    const idx = lane.vehs.indexOf(v);
    const lead = idx < lane.vehs.length - 1 ? lane.vehs[idx + 1] : null;
    const first = v.plan[0] as Conn | undefined;
    if (lead) r = `lane-queue(lead ${lead.state} v=${lead.v.toFixed(1)})`;
    else if (!first) {
      const next = v.route[v.ri + 1];
      r = `lane-noplan(ri=${v.ri}/${v.route.length} dest=${!!v.dest} laneIdx=${lane.index}/${lane.link.lanes.length} dEnd=${(lane.len - v.s).toFixed(1)} arrows=${lane.link.lanes.map((l) => l.arrows).join('|')} moves=${lane.link.lanes.map((l) => [...l.moves.keys()].join('+')).join('|')} next=${next?.id} curLink=${lane.link.id} routeLink=${v.route[v.ri]?.id} lcCool=${v.lcCool.toFixed(2)} mand=${v.mandatoryLC} node=${lane.link.to.id}/${lane.link.to.control})`;
    }
    else if (first.isLane) r = 'lane-plan-lane?';
    else r = `line-hold(${first.node.control} ${first.kind}/${first.turn} sig=${first.sig} hold=${v.holdLine} stopDone=${v.stopDone} dEnd=${(lane.len - v.s).toFixed(1)} toVeh=${first.toLane?.vehs.length})`;
  } else {
    const c = v.seg as Conn;
    const idx = c.vehs.indexOf(v);
    r = `conn(${c.node.control} ${c.kind}/${c.turn} s=${v.s.toFixed(1)}/${c.len.toFixed(1)} idx=${idx}/${c.vehs.length} next=${v.plan[0]?.isLane ? 'lane' : 'conn'} nextVeh=${v.plan[0]?.vehs.length})`;
  }
  const key = r.split('(')[0];
  reasons[key] = (reasons[key] ?? 0) + 1;
  if (samples.length < 25) samples.push(`#${v.id} ${v.kind} stuck=${v.stuckT.toFixed(0)} ${r}`);
}
console.log('stuck reasons', JSON.stringify(reasons));
const totUse = Object.values(timeUse).reduce((a, b) => a + b, 0);
console.log('time use:', Object.entries(timeUse).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${(100 * n / totUse).toFixed(1)}%`).join(', '));
for (const s of samples) console.log('  ', s);

for (const v of sim.vehicles) {
  if (v.stuckT < 30 || !v.seg.isLane || v.plan.length) continue;
  const lane = v.seg as Lane;
  const cur = lane.link;
  console.log(`debug #${v.id}: atDest=${v.dest && v.ri === v.route.length - 1 && v.route[v.ri] === v.dest.link} destLink=${v.dest?.link.id} destLane=${v.dest?.lane} destS=${v.dest?.s.toFixed(1)} s=${v.s.toFixed(1)} len=${lane.len.toFixed(1)}`);
  for (const id of lane.moves.keys()) {
    const nx = city.net.links[id];
    const r = sim.router.route(nx, cur, { live: true });
    console.log(`   move ${id}: route back to ${cur.id}: ${r ? r.map((l) => l.id).join('>') : 'NULL'} nexts(${nx.id})=${nx.nexts.map((l) => l.id).join(',')}`);
  }
}
