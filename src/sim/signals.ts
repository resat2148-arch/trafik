// Traffic signal controller.
//
// Plans:
//   two      – one phase per axis, left turns permissive (yield to oncoming)
//   leftlead – protected left-turn phase before each through phase
//   split    – every approach gets its own phase (no conflicts at all)
// Modes:
//   fixed    – fixed green times
//   actuated – detectors end a green once its queue is served (gap-out) or at the
//              configured maximum (max-out) and skip phases nobody waits for
//   smart    – actuated, and after every green it re-plans that phase's green time
//              from the traffic it measured (served + still waiting on the busiest lane)
// A signal on a green-wave street is coordinated: it follows a common cycle with an
// offset, the phase serving the street starts on schedule and side phases end at fixed
// force-off points (actuated / smart side phases may still end early and hand the time back).

import { normAngle } from '../core/math.ts';
import { Conn, Node, SIG_G, SIG_NONE, SIG_P, SIG_R, SIG_Y } from './network.ts';
import type { Arm, Lane } from './network.ts';

export type PlanType = 'two' | 'leftlead' | 'split';
export type SigMode = 'fixed' | 'actuated' | 'smart';

export interface Phase {
  green: Map<Conn, number>;
  /** fixed: green time; actuated: maximum green; smart: green time planned by the controller */
  dur: number;
  arms: Arm[]; // approaches that get green in this phase
  kind: 'all' | 'left' | 'through';
  // runtime statistics
  lastServed: number; // sim time this phase last ended
  served: number; // vehicles that entered during the current / last green
  lastGreen: number; // length of the last green actually given
  laneServed: Map<Lane, number>; // vehicles served per approach lane during the current green
}

/** green-wave coordination handed to a signal by its street corridor */
export interface CoordPlan {
  cycle: number; // common cycle length of the corridor
  offset: number; // when (mod cycle) the coordinated phase starts
  phase: number; // index of the phase serving the street
}

export interface SignalSave {
  plan: PlanType;
  mode: SigMode;
  durs: number[];
  yellow: number;
  allRed: number;
  /** older saves: one-off green wave settings, now replaced by street corridors */
  offset?: number;
  coord?: boolean;
}

const mod = (a: number, m: number): number => ((a % m) + m) % m;

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
  /** set by the green-wave corridor this signal belongs to */
  coord: CoordPlan | null = null;
  /** sim time the current green must end at in coordinated operation */
  forceOff = 0;
  /** sim time of the last red onset per conn (for red-runner logic) */
  redSince = new Map<Conn, number>();
  preemptConn: Conn | null = null;
  preemptT = 0;
  private now = 0;

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
    const mk = (arms: Arm[], kind: Phase['kind']): Phase => ({ green: new Map(), dur: 20, arms, kind, lastServed: 0, served: 0, lastGreen: 0, laneServed: new Map() });
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
    for (const p of phases) p.lastGreen = p.dur;
    this.phases = phases;
    this.cur = 0;
    this.next = phases.length > 1 ? 1 : 0;
    this.state = 'G';
    this.t = 0;
    if (this.coord && this.coord.phase >= phases.length) this.coord = null;
    if (phases.length) this.startGreen(phases[0], this.now);
    this.apply(this.now);
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
    this.now = time;
    if (this.phases.length === 0) return;
    this.t += dt;
    const ph = this.phases[this.cur];
    if (this.state === 'G') {
      if (this.shouldEnd(ph, time)) {
        this.next = this.pickNext(time);
        if (this.next === this.cur) {
          // nobody else is waiting: rest in green, timers restart when someone arrives
          this.t = Math.min(this.t, this.minGreen(ph));
        } else {
          this.endGreen(ph, time);
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
      this.cur = this.next;
      this.state = 'G';
      this.t = 0;
      this.startGreen(this.phases[this.cur], time);
    }
    if (this.preemptT > 0) this.preemptT -= dt;
    this.apply(time);
  }

  /** a vehicle crossed the stop line onto connector c */
  onEnter(c: Conn, from: Lane): void {
    const ph = this.phases[this.cur];
    if (!ph || this.state === 'AR' || !ph.green.has(c)) return;
    ph.served++;
    ph.laneServed.set(from, (ph.laneServed.get(from) ?? 0) + 1);
  }

  private minGreen(ph: Phase): number {
    return ph.kind === 'left' ? 4 : 6;
  }

  /** longest green a phase may get in the current mode */
  maxGreen(ph: Phase): number {
    return this.mode === 'smart' ? Math.round(ph.dur * 1.25 + 2) : ph.dur;
  }

  private startGreen(ph: Phase, time: number): void {
    ph.served = 0;
    ph.laneServed.clear();
    if (this.coord) this.forceOff = time + this.allowance(this.cur, time);
  }

  private endGreen(ph: Phase, time: number): void {
    ph.lastGreen = this.t;
    ph.lastServed = time;
    if (this.mode === 'smart') this.learn(ph);
  }

  /**
   * Smart mode: plan the next green of a phase from what this one had to serve.
   * Critical lane volume (served on green + still queued) at a saturation headway of
   * 2.3 s plus start-up loss and a 15 % reserve; smoothed so timings settle.
   */
  private learn(ph: Phase): void {
    let crit = 0;
    const lanes = new Set<Lane>();
    for (const c of ph.green.keys()) if (c.fromLane) lanes.add(c.fromLane);
    for (const l of lanes) {
      let waiting = 0;
      for (const v of l.vehs) {
        const want = v.plan[0];
        if (l.len - v.s < 80 && want instanceof Conn && ph.green.has(want)) waiting++;
      }
      crit = Math.max(crit, (ph.laneServed.get(l) ?? 0) + waiting);
    }
    const need = 3 + crit * 2.3 * 1.15;
    const lo = ph.kind === 'left' ? 5 : 7;
    ph.dur = Math.round(Math.max(lo, Math.min(60, ph.dur * 0.6 + need * 0.4)));
  }

  /** green windows of a coordinated schedule (cycle time 0 = start of the coordinated phase) */
  schedule(plan: CoordPlan | null = this.coord): { start: number[]; end: number[] } {
    const n = this.phases.length;
    const start = new Array<number>(n).fill(0);
    const end = new Array<number>(n).fill(0);
    if (!plan || n === 0) return { start, end };
    const k = plan.phase;
    const lost = this.yellow + this.allRed;
    let side = 0;
    for (let j = 0; j < n; j++) if (j !== k) side += this.phases[j].dur;
    end[k] = Math.max(this.phases[k].dur, plan.cycle - side - n * lost);
    let tt = end[k];
    for (let m = 1; m < n; m++) {
      const j = (k + m) % n;
      start[j] = tt + lost;
      end[j] = start[j] + this.phases[j].dur;
      tt = end[j];
    }
    return { start, end };
  }

  /** called by the green-wave manager; a changed plan re-times the running green */
  setCoord(plan: CoordPlan | null): void {
    const was = this.coord;
    this.coord = plan && plan.phase < this.phases.length ? plan : null;
    const p = this.coord;
    if (!p) return;
    const moved = !was || was.phase !== p.phase || was.cycle !== p.cycle || Math.abs(mod(was.offset - p.offset + p.cycle / 2, p.cycle) - p.cycle / 2) > 1;
    const ph = this.phases[this.cur];
    if (moved && this.state === 'G' && ph) this.forceOff = Math.max(this.now - this.t + this.minGreen(ph), this.now + this.allowance(this.cur, this.now));
  }

  /**
   * Green left in phase i's window of the coordinated schedule if it starts at `time`:
   * a green that starts late gets less, one that starts early gets more.
   */
  private windowLeft(i: number, time: number): number {
    const co = this.coord!;
    const C = co.cycle;
    const sch = this.schedule();
    const late = mod(time - co.offset - sch.start[i] + C / 2, C) - C / 2;
    return sch.end[i] - sch.start[i] - late;
  }

  /** green time phase i may run when it starts now, following the coordinated schedule */
  private allowance(i: number, time: number): number {
    const ph = this.phases[i];
    const left = this.windowLeft(i, time);
    // the street phase absorbs timing errors (at most half a cycle when early, down to a short green when late)
    if (i === this.coord!.phase) return Math.max(Math.min(10, ph.dur), left);
    return Math.max(this.minGreen(ph), Math.min(left, ph.dur * 1.5 + 5));
  }

  private shouldEnd(ph: Phase, time: number): boolean {
    // emergency pre-emption
    if (this.preemptConn && this.preemptT > 0) {
      if (ph.green.has(this.preemptConn)) return false;
      return this.t > 3;
    }
    const minG = this.minGreen(ph);
    const gap = this.mode === 'smart' ? 2.5 : 3.0;
    if (this.coord) {
      if (time >= this.forceOff) return true;
      // the street phase keeps its green until the force-off; actuated side phases may gap out
      if (this.mode === 'fixed' || this.cur === this.coord.phase) return false;
      return this.t >= minG && !this.arriving(ph, gap);
    }
    if (this.mode === 'fixed') return this.t >= ph.dur;
    if (this.t < minG) return false;
    if (this.t >= this.maxGreen(ph)) return true;
    return !this.arriving(ph, gap);
  }

  private pickNext(time: number): number {
    const n = this.phases.length;
    if (this.preemptConn && this.preemptT > 0) {
      const idx = this.phases.findIndex((p) => p.green.has(this.preemptConn!));
      if (idx >= 0) return idx;
    }
    if (this.mode === 'fixed') return (this.cur + 1) % n;
    // detectors: the next phase in the ring somebody waits for; empty phases are skipped
    const startAt = time + this.yellow + this.allRed;
    for (let k = 1; k < n; k++) {
      const i = (this.cur + k) % n;
      if (this.coord && i === this.coord.phase) return i;
      if (this.phaseDemand(this.phases[i]) <= 0) continue;
      if (this.coord && this.windowLeft(i, startAt) < this.minGreen(this.phases[i])) continue;
      return i;
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
        // a queue over the stop-line detector keeps calling; others must arrive within the gap
        if (d < 25 && v.v < 3) return true;
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
    };
  }

  load(s: SignalSave): void {
    this.plan = s.plan;
    this.mode = s.mode;
    this.yellow = s.yellow;
    this.allRed = s.allRed;
    this.rebuild(false);
    if (s.durs.length === this.phases.length) this.phases.forEach((p, i) => (p.dur = s.durs[i]));
  }
}

export function sigColor(s: number): 'r' | 'y' | 'g' | 'n' {
  return s === SIG_R ? 'r' : s === SIG_Y ? 'y' : s === SIG_G || s === SIG_P ? 'g' : 'n';
}
