// Traffic signal controller.
//
// Plans:
//   two      – one phase per axis, left turns permissive (yield to oncoming)
//   leftlead – protected left-turn phase before each through phase
//   split    – every approach gets its own phase (no conflicts at all)
// Modes:
//   fixed    – fixed green times (optionally coordinated with an offset)
//   actuated – detector based gap-out / max-out, skips phases without demand
//   smart    – adaptive max-pressure selection of the next phase

import { normAngle } from '../core/math.ts';
import { Conn, Node, SIG_G, SIG_NONE, SIG_P, SIG_R, SIG_Y } from './network.ts';
import type { Arm, Lane } from './network.ts';

export type PlanType = 'two' | 'leftlead' | 'split';
export type SigMode = 'fixed' | 'actuated' | 'smart';

export interface Phase {
  green: Map<Conn, number>;
  dur: number; // configured green time (fixed mode) / max green (actuated)
  arms: Arm[]; // approaches that get green in this phase
  kind: 'all' | 'left' | 'through';
  // runtime statistics
  lastServed: number;
  served: number;
}

export interface SignalSave {
  plan: PlanType;
  mode: SigMode;
  durs: number[];
  yellow: number;
  allRed: number;
  offset: number;
  coord: boolean;
}

export class SignalCtrl {
  node: Node;
  plan: PlanType;
  mode: SigMode;
  phases: Phase[] = [];
  cur = 0;
  next = 0;
  state: 'G' | 'Y' | 'AR' = 'G';
  t = 0;
  yellow = 3.5;
  allRed = 1.5;
  offset = 0;
  coord = false;
  /** sim time of the last red onset per conn (for red-runner logic) */
  redSince = new Map<Conn, number>();
  private extend = 0;
  preemptConn: Conn | null = null;
  preemptT = 0;
  cycleStart = 0;

  constructor(node: Node, plan: PlanType = 'two', mode: SigMode = 'fixed') {
    this.node = node;
    this.plan = plan;
    this.mode = mode;
  }

  get cycleLength(): number {
    let c = 0;
    for (const p of this.phases) c += p.dur + this.yellow + this.allRed;
    return c;
  }

  /** Approaches grouped into axes of (roughly) opposite arms. */
  axes(): Arm[][] {
    const appr = this.node.arms.filter((a) => a.inLink);
    const used = new Set<Arm>();
    const out: Arm[][] = [];
    for (const a of appr) {
      if (used.has(a)) continue;
      used.add(a);
      let best: Arm | null = null;
      let bestErr = 0.75;
      for (const b of appr) {
        if (used.has(b)) continue;
        const err = Math.abs(Math.abs(normAngle(b.angle - a.angle)) - Math.PI);
        if (err < bestErr) {
          bestErr = err;
          best = b;
        }
      }
      if (best) {
        used.add(best);
        out.push([a, best]);
      } else out.push([a]);
    }
    // T-junction: merge the stem with nothing; through road is the pair
    return out;
  }

  rebuild(keepDurations = true): void {
    const old = this.phases.map((p) => p.dur);
    const conns = this.node.conns;
    const byArm = (arm: Arm): Conn[] => conns.filter((c) => c.inArm === arm);
    const phases: Phase[] = [];
    const mk = (arms: Arm[], kind: Phase['kind']): Phase => ({ green: new Map(), dur: 20, arms, kind, lastServed: 0, served: 0 });
    let plan = this.plan;
    if (this.node.arms.length > 4 && plan === 'two') plan = 'split';
    const axes = this.axes();
    if (plan === 'split') {
      for (const ax of axes)
        for (const a of ax) {
          const p = mk([a], 'all');
          for (const c of byArm(a)) p.green.set(c, SIG_G);
          p.dur = 16;
          phases.push(p);
        }
    } else {
      for (const ax of axes) {
        if (ax.length === 1) {
          const p = mk(ax, 'all');
          for (const c of byArm(ax[0])) p.green.set(c, SIG_G);
          p.dur = 18;
          phases.push(p);
          continue;
        }
        const hasLeft = ax.some((a) => byArm(a).some((c) => c.turn === 'L' || c.turn === 'U'));
        if (plan === 'leftlead' && hasLeft) {
          const pl = mk(ax, 'left');
          for (const a of ax)
            for (const c of byArm(a)) if (c.turn === 'L' || c.turn === 'U' || c.turn === 'R') pl.green.set(c, SIG_G);
          pl.dur = 10;
          phases.push(pl);
          const pt = mk(ax, 'through');
          for (const a of ax)
            for (const c of byArm(a)) pt.green.set(c, c.turn === 'L' || c.turn === 'U' ? SIG_P : SIG_G);
          pt.dur = 22;
          phases.push(pt);
        } else {
          const p = mk(ax, 'all');
          for (const a of ax)
            for (const c of byArm(a)) p.green.set(c, c.turn === 'L' || c.turn === 'U' ? SIG_P : SIG_G);
          p.dur = 24;
          phases.push(p);
        }
      }
    }
    // a single-approach "axis" with nothing to conflict gets protected movements;
    // with 2 phases, through roads get a slightly longer green by default
    if (keepDurations && old.length === phases.length) phases.forEach((p, i) => (p.dur = old[i]));
    this.phases = phases;
    this.cur = 0;
    this.next = phases.length > 1 ? 1 : 0;
    this.state = 'G';
    this.t = 0;
    this.apply(0);
  }

  setPlan(plan: PlanType): void {
    this.plan = plan;
    this.rebuild(false);
  }

  /** Transition to all-red briefly so changes are safe. */
  safeRestart(): void {
    this.state = 'AR';
    this.t = 0;
    this.next = 0;
  }

  update(dt: number, time: number): void {
    if (this.phases.length === 0) return;
    this.t += dt;
    const ph = this.phases[this.cur];
    if (this.state === 'G') {
      if (this.shouldEnd(ph, time)) {
        this.next = this.pickNext();
        if (this.next === this.cur) {
          // no other demand: rest in green
          this.t = Math.min(this.t, ph.dur * 0.5);
        } else {
          this.state = 'Y';
          this.t = 0;
          for (const c of ph.green.keys()) if (!this.phases[this.next].green.has(c)) this.redSince.set(c, time + this.yellow);
        }
      }
    } else if (this.state === 'Y') {
      if (this.t >= this.yellow) {
        this.state = 'AR';
        this.t = 0;
      }
    } else if (this.t >= this.allRed) {
      const prev = this.cur;
      this.cur = this.next;
      this.state = 'G';
      this.t = 0;
      this.extend = 0;
      this.phases[prev].lastServed = time;
      if (this.cur === 0) this.cycleStart = time;
      if (this.mode === 'fixed' && this.coord && this.cur === 0) this.syncOffset(time);
    }
    if (this.preemptT > 0) this.preemptT -= dt;
    this.apply(time);
  }

  private syncOffset(time: number): void {
    const C = this.cycleLength;
    if (C <= 0) return;
    let err = (((time - this.offset) % C) + C) % C; // how far into the cycle we are
    if (err > C / 2) err -= C;
    // shorten / lengthen this phase green to drift towards the target
    this.extend = Math.max(-this.phases[0].dur * 0.3, Math.min(this.phases[0].dur * 0.3, -err));
  }

  private shouldEnd(ph: Phase, time: number): boolean {
    // emergency pre-emption
    if (this.preemptConn && this.preemptT > 0) {
      if (ph.green.has(this.preemptConn)) return false;
      return this.t > 3;
    }
    if (this.mode === 'fixed') return this.t >= ph.dur + this.extend;
    const minG = 6;
    const maxG = this.mode === 'smart' ? Math.max(ph.dur, 20) * 1.8 : ph.dur * 1.6;
    if (this.t < minG) return false;
    const otherDemand = this.phases.some((p, i) => i !== this.cur && this.phaseDemand(p) > 0);
    if (!otherDemand) return false;
    if (this.t >= maxG) return true;
    const gap = this.mode === 'smart' ? 2.2 : 3.0;
    if (!this.arriving(ph, gap)) return true;
    if (this.mode === 'smart') {
      // max-pressure: switch if another phase has much more queued demand
      const here = this.phaseDemand(ph);
      let best = 0;
      this.phases.forEach((p, i) => {
        if (i !== this.cur) best = Math.max(best, this.phaseDemand(p) + (time - p.lastServed) * 0.05);
      });
      if (best > here * 2.5 + 4 && this.t > minG + 4) return true;
    }
    return false;
  }

  private pickNext(): number {
    const n = this.phases.length;
    if (this.preemptConn && this.preemptT > 0) {
      const idx = this.phases.findIndex((p) => p.green.has(this.preemptConn!));
      if (idx >= 0) return idx;
    }
    if (this.mode === 'fixed') return (this.cur + 1) % n;
    if (this.mode === 'smart') {
      let best = -1;
      let bestV = 0;
      for (let i = 0; i < n; i++) {
        if (i === this.cur) continue;
        const d = this.phaseDemand(this.phases[i]);
        if (d <= 0) continue;
        const v = d;
        if (v > bestV) {
          bestV = v;
          best = i;
        }
      }
      return best >= 0 ? best : this.cur;
    }
    for (let k = 1; k <= n; k++) {
      const i = (this.cur + k) % n;
      if (i === this.cur) break;
      if (this.phaseDemand(this.phases[i]) > 0) return i;
    }
    return this.cur;
  }

  /** queued / approaching vehicles that want a movement of this phase */
  phaseDemand(p: Phase): number {
    let d = 0;
    const seen = new Set<Lane>();
    for (const c of p.green.keys()) {
      const lane = c.fromLane;
      if (!lane || seen.has(lane)) continue;
      seen.add(lane);
      const vs = lane.vehs;
      for (let i = vs.length - 1; i >= 0; i--) {
        const v = vs[i];
        if (lane.len - v.s > 70) break;
        const want = v.plan[0];
        if (want instanceof Conn && p.green.has(want)) d += 1 + v.waitT * 0.02;
      }
    }
    return d;
  }

  private arriving(p: Phase, gap: number): boolean {
    for (const c of p.green.keys()) {
      const lane = c.fromLane;
      if (!lane) continue;
      const vs = lane.vehs;
      for (let i = vs.length - 1; i >= 0; i--) {
        const v = vs[i];
        const d = lane.len - v.s;
        if (d > 60) break;
        if (v.plan[0] !== c) continue;
        if (d < 4 || d / Math.max(v.v, 0.5) < gap) return true;
      }
    }
    return false;
  }

  apply(time: number): void {
    const ph = this.phases[this.cur];
    const nx = this.phases[this.next];
    for (const c of this.node.conns) {
      if (c.kind !== 'move' && c.kind !== 'uturn') {
        c.sig = SIG_NONE;
        continue;
      }
      const g = ph ? ph.green.get(c) : undefined;
      let s = SIG_R;
      if (this.state === 'G') s = g ?? SIG_R;
      else if (this.state === 'Y') {
        if (g !== undefined) s = nx && nx.green.has(c) ? g : SIG_Y;
      } else {
        if (g !== undefined && nx && nx.green.has(c)) s = nx.green.get(c)!;
      }
      if (s === SIG_R && c.sig !== SIG_R && c.sig !== SIG_Y) this.redSince.set(c, time);
      c.sig = s;
    }
  }

  /** Remaining green+yellow time for a conn (for driver anticipation); -1 when not green */
  timeToRed(c: Conn): number {
    if (c.sig === SIG_Y) return this.yellow - this.t;
    if (c.sig !== SIG_G && c.sig !== SIG_P) return -1;
    if (this.state !== 'G') return this.yellow;
    const ph = this.phases[this.cur];
    return Math.max(0, ph.dur - this.t) + this.yellow;
  }

  /**
   * Webster-style retiming: green split proportional to the measured demand of
   * each phase (recent flow + current queues), cycle length from the number of phases.
   */
  autoTime(): void {
    const demand = this.phases.map((p) => {
      let q = 0;
      const lanes = new Set<Lane>();
      for (const c of p.green.keys()) if (c.fromLane) lanes.add(c.fromLane);
      for (const l of lanes) q += l.link.flowCount / Math.max(1, l.link.lanes.length) + l.vehs.length * 1.5;
      for (const a of p.arms) q += a.road.cls === 'local' ? 1.5 : a.road.cls === 'avenue' ? 4 : 6;
      return q + 1;
    });
    const total = demand.reduce((a, b) => a + b, 0);
    const lost = this.phases.length * (this.yellow + this.allRed);
    const ratio = Math.min(0.9, total / 120);
    const cycle = Math.max(40, Math.min(110, (1.5 * lost + 5) / (1 - ratio) + this.phases.length * 6));
    const green = Math.max(8 * this.phases.length, cycle - lost);
    this.phases.forEach((p, i) => {
      p.dur = Math.max(p.kind === 'left' ? 6 : 8, Math.min(70, Math.round((green * demand[i]) / total)));
    });
  }

  /** an outdated timing plan from decades ago: side roads get far too much green */
  legacyTiming(rnd: () => number): void {
    if (this.phases.length < 2) return;
    const major = (p: Phase): number => p.arms.reduce((a, arm) => a + (arm.road.cls === 'local' ? 1 : arm.road.cls === 'avenue' ? 3 : 4), 0);
    const scores = this.phases.map(major);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    this.phases.forEach((p, i) => {
      if (max === min) p.dur = Math.round(18 + rnd() * 24);
      else p.dur = scores[i] === max ? Math.round(11 + rnd() * 6) : Math.round(30 + rnd() * 14);
    });
  }

  save(): SignalSave {
    return {
      plan: this.plan,
      mode: this.mode,
      durs: this.phases.map((p) => p.dur),
      yellow: this.yellow,
      allRed: this.allRed,
      offset: this.offset,
      coord: this.coord,
    };
  }

  load(s: SignalSave): void {
    this.plan = s.plan;
    this.mode = s.mode;
    this.yellow = s.yellow;
    this.allRed = s.allRed;
    this.offset = s.offset;
    this.coord = s.coord;
    this.rebuild(false);
    if (s.durs.length === this.phases.length) this.phases.forEach((p, i) => (p.dur = s.durs[i]));
  }
}

export function sigColor(s: number): 'r' | 'y' | 'g' | 'n' {
  return s === SIG_R ? 'r' : s === SIG_Y ? 'y' : s === SIG_G || s === SIG_P ? 'g' : 'n';
}
