// Green waves: every signal on a street joins its corridor. Corridors share one common
// cycle and each signal gets an offset so a platoon released at one junction reaches the
// next one as it turns green. Membership, cycle, offsets and direction are re-derived every
// second, so timing changes, new signals and widened roads never break the wave.

import type { V2 } from '../core/math.ts';
import type { Network, Node, Road } from './network.ts';
import type { CoordPlan, SignalCtrl } from './signals.ts';

export interface Corridor {
  /** street name */
  name: string;
  /** direction the wave runs: 0 follows the busier direction, 1 along the street axis, -1 against it */
  dir: number;
  /** signals on the street, ordered along the axis (derived) */
  members: Node[];
  /** direction currently served (derived) */
  active: number;
  /** street axis: ordering direction for members */
  axis: V2;
  flowT: number;
}

/** head start a signal gets over the arriving platoon, so its own queue is moving */
const LEAD = 2;

const mod = (a: number, m: number): number => ((a % m) + m) % m;

export function naturalCycle(s: SignalCtrl): number {
  let c = 0;
  for (const p of s.phases) c += p.dur + s.yellow + s.allRed;
  return c;
}

export class WaveManager {
  corridors: Corridor[] = [];
  /** common cycle of all green-wave signals */
  cycle = 0;
  private t = 0;
  private net: Network;

  constructor(net: Network) {
    this.net = net;
  }

  get(name: string): Corridor | undefined {
    return this.corridors.find((c) => c.name === name);
  }

  add(name: string, dir = 0): Corridor {
    const have = this.get(name);
    if (have) return have;
    const roads = this.streetRoads(name);
    const r = roads.reduce((a, b) => (b.id < a.id ? b : a), roads[0]);
    const L = r ? Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) || 1 : 1;
    const axis = r ? { x: (r.b.x - r.a.x) / L, y: (r.b.y - r.a.y) / L } : { x: 1, y: 0 };
    const c: Corridor = { name, dir, members: [], active: dir || 1, axis, flowT: 0 };
    this.corridors.push(c);
    this.t = 0;
    return c;
  }

  remove(name: string): void {
    this.corridors = this.corridors.filter((c) => c.name !== name);
    this.t = 0;
  }

  setDir(name: string, dir: number): void {
    const c = this.get(name);
    if (!c) return;
    c.dir = dir;
    if (dir) c.active = dir;
    c.flowT = 0;
    this.t = 0;
  }

  streetRoads(name: string): Road[] {
    return this.net.roads.filter((r) => r.name === name);
  }

  /** corridors running through a junction */
  at(n: Node): Corridor[] {
    return this.corridors.filter((c) => c.members.includes(n));
  }

  /** stretch of the street the wave covers: roads between its first and last signal */
  span(c: Corridor): Road[] {
    if (c.members.length < 2) return [];
    const pr = (p: V2): number => p.x * c.axis.x + p.y * c.axis.y;
    const lo = pr(c.members[0]) - 0.5;
    const hi = pr(c.members[c.members.length - 1]) + 0.5;
    return this.streetRoads(c.name).filter((r) => Math.min(pr(r.a), pr(r.b)) >= lo && Math.max(pr(r.a), pr(r.b)) <= hi);
  }

  update(dt: number, signals: Node[]): void {
    for (const c of this.corridors) c.flowT -= dt;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 1;
    const plans = new Map<Node, CoordPlan>();
    for (const c of this.corridors) {
      const pr = (p: V2): number => p.x * c.axis.x + p.y * c.axis.y;
      c.members = signals.filter((n) => n.signal && n.arms.some((a) => a.road.name === c.name)).sort((a, b) => pr(a) - pr(b));
    }
    // one cycle for every green wave keeps crossing waves consistent; it follows the slowest
    // member up at once and down only on a clear drop, so adaptive members do not make it jitter
    let need = 0;
    for (const c of this.corridors) if (c.members.length >= 2) for (const n of c.members) need = Math.max(need, naturalCycle(n.signal!));
    need = Math.ceil(need);
    if (need > this.cycle || need < this.cycle - 8) this.cycle = need;
    const C = this.cycle;
    for (const c of this.corridors) {
      if (c.members.length < 2) continue;
      this.chooseDirection(c);
      const d = { x: c.axis.x * c.active, y: c.axis.y * c.active };
      const order = c.active > 0 ? c.members : [...c.members].reverse();
      const roads = this.span(c);
      const v = 0.9 * Math.min(...(roads.length ? roads : this.streetRoads(c.name)).map((r) => r.speed));
      const phase = order.map((n) => streetPhase(n.signal!, c.name, d));
      // when the wave reaches each signal, relative to the first one
      const arrive = [0];
      for (let i = 1; i < order.length; i++) {
        const gap = Math.hypot(order[i].x - order[i - 1].x, order[i].y - order[i - 1].y);
        arrive.push(arrive[i - 1] + Math.max(0, gap / v - LEAD));
      }
      // a signal already timed by an earlier corridor (a crossing wave) anchors this street
      let base = 0;
      const ai = order.findIndex((n) => plans.has(n));
      if (ai >= 0) {
        const an = order[ai];
        const ap = plans.get(an)!;
        base = ap.offset + an.signal!.schedule(ap).start[phase[ai]] - arrive[ai];
      }
      order.forEach((n, i) => {
        if (!plans.has(n)) plans.set(n, { cycle: C, offset: mod(base + arrive[i], C), phase: phase[i] });
      });
    }
    for (const n of signals) n.signal!.setCoord(plans.get(n) ?? null);
  }

  /** auto direction: serve the busier direction, switching only on a clear difference */
  private chooseDirection(c: Corridor): void {
    if (c.dir !== 0) {
      c.active = c.dir;
      return;
    }
    if (c.flowT > 0) return;
    c.flowT = 60;
    let fwd = 0;
    let back = 0;
    for (const r of this.streetRoads(c.name)) {
      const along = (r.b.x - r.a.x) * c.axis.x + (r.b.y - r.a.y) * c.axis.y >= 0;
      fwd += along ? r.ab.flowCount : r.ba.flowCount;
      back += along ? r.ba.flowCount : r.ab.flowCount;
    }
    if (c.active > 0 && back > fwd * 1.4 + 2) c.active = -1;
    else if (c.active < 0 && fwd > back * 1.4 + 2) c.active = 1;
  }
}

/** the phase that releases traffic travelling along the street in direction d */
function streetPhase(s: SignalCtrl, name: string, d: V2): number {
  let best = 0;
  let bestScore = -Infinity;
  s.phases.forEach((p, i) => {
    let sc = 0;
    // the approach vehicles arrive from (pointing against d) matters most
    for (const a of p.arms) if (a.road.name === name) sc += a.dir.x * d.x + a.dir.y * d.y < 0 ? 2 : 1;
    if (p.kind === 'through') sc += 0.5;
    if (p.kind === 'left') sc -= 1;
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  return best;
}
