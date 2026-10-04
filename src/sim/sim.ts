// Microscopic traffic simulation.
//
// Longitudinal control: Intelligent Driver Model (IDM) with start-up reaction
// delay, curve speed anticipation and virtual obstacles for stop lines.
// Lateral control: MOBIL lane changing (incentive + safety + politeness) with
// mandatory route-based changes, cooperative zipper merging and keep-right bias.
// Junctions: signal / stop / yield / all-way stop (FIFO) / roundabout logic with
// geometric conflict zones, time-to-arrival gap acceptance, "don't block the box",
// permissive left turners waiting inside the junction and red-light runners.

import { clamp, normAngle } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import {
  Conn,
  Lane,
  Link,
  Network,
  Node,
  Seg,
  SIG_G,
  SIG_NONE,
  SIG_P,
  SIG_R,
  SIG_Y,
  buildLanes,
  clampLaneCounts,
  computeCorners,
  setRoadSlots,
} from './network.ts';
import type { Control, Road } from './network.ts';
import { buildJunction, cleanupDying, stronglyConnected, updateLinkNexts } from './junction.ts';
import { SignalCtrl } from './signals.ts';
import { WaveManager } from './corridors.ts';
import type { PlanType } from './signals.ts';
import { Router } from './routing.ts';
import { MODEL, Vehicle, randomPaint } from './vehicle.ts';
import type { Dest, VKind } from './vehicle.ts';

export type SimEvent =
  | { type: 'trip'; v: Vehicle; time: number; ff: number }
  | { type: 'abandon'; v: Vehicle }
  | { type: 'crash'; x: number; y: number; vehicles: Vehicle[]; node: Node | null }
  | { type: 'redrun'; v: Vehicle; node: Node }
  | { type: 'horn'; x: number; y: number; v: Vehicle }
  | { type: 'emergencyArrived'; v: Vehicle; time: number }
  | { type: 'towDone'; v: Vehicle }
  | { type: 'busStop'; v: Vehicle; passengers: number };

export interface SpawnReq {
  kind: VKind;
  model: number;
  color?: number;
  link: Link;
  s?: number; // lane coordinate for pull-outs (undefined = start of link, gateway entry)
  side?: 1 | -1; // building side for pull-outs (+1 = right of travel)
  dest: Dest | null;
  goal: Link; // final link (dest link or exit link towards a gateway)
  origin?: number;
  siren?: boolean;
  route?: Link[]; // fixed route (bus lines)
}

function idm(v: number, v0: number, gap: number, vl: number, T: number, s0: number, a: number, b: number): number {
  if (gap <= 0.05) return -9;
  const sStar = s0 + Math.max(0, v * T + (v * (v - vl)) / (2 * Math.sqrt(a * b)));
  const r = v / Math.max(v0, 0.1);
  const r2 = r * r;
  const q = sStar / gap;
  return a * (1 - r2 * r2 - q * q);
}

function idmFree(v: number, v0: number, a: number): number {
  const r = v / Math.max(v0, 0.1);
  const r2 = r * r;
  return a * (1 - r2 * r2);
}

/** time to travel distance d starting at speed v with acceleration a up to vmax */
export function timeToCover(d: number, v: number, a: number, vmax: number): number {
  if (d <= 0) return 0;
  vmax = Math.max(vmax, 0.5);
  if (v >= vmax) return d / Math.max(v, 0.1);
  const tAcc = (vmax - v) / a;
  const dAcc = (v + vmax) * 0.5 * tAcc;
  if (d <= dAcc) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
  return tAcc + (d - dAcc) / vmax;
}

const tmpPose = { x: 0, y: 0, dx: 1, dy: 0 };

interface LaneSnapshot {
  roads: Set<Road>;
  lanes: Lane[];
  vehs: { v: Vehicle; lane: Lane; s: number }[];
  arrows: Map<Link, number[]>;
}

export class Sim {
  net: Network;
  router: Router;
  rng: RNG;
  vehicles: Vehicle[] = [];
  time = 0;
  events: SimEvent[] = [];
  rain = 0;
  /** global multiplier for demand (game difficulty) */
  aggressionBias = 0;
  private statT = 0;
  private dt = 1 / 30;
  private mergeLanes: Lane[] = [];
  private mergeReq = new Map<Lane, { v: Vehicle; s: number }[]>();
  private sirens: Vehicle[] = [];
  signalNodes: Node[] = [];
  /** green-wave streets */
  waves: WaveManager;
  gatewayQueues = new Map<number, SpawnReq[]>();
  stats = {
    trips: 0,
    abandoned: 0,
    crashes: 0,
    redRuns: 0,
    spawned: 0,
  };

  constructor(net: Network, seed = 1) {
    this.net = net;
    this.router = new Router(net);
    this.rng = new RNG(seed);
    this.waves = new WaveManager(net);
  }

  // -------------------------------------------------------------------------
  // network management

  initJunctions(): void {
    for (const n of this.net.nodes) {
      if (n.control === 'signal' && !n.signal) n.signal = new SignalCtrl(n);
      buildJunction(this.net, n);
      if (n.control === 'signal') n.signal!.rebuild();
    }
    updateLinkNexts(this.net);
    this.refreshSignalList();
  }

  refreshSignalList(): void {
    this.signalNodes = this.net.nodes.filter((n) => n.control === 'signal' && n.signal);
  }

  setControl(n: Node, control: Control, plan?: PlanType): void {
    if (n.gateway) return;
    const prev = n.control;
    n.control = control;
    if (control === 'signal') {
      if (!n.signal) n.signal = new SignalCtrl(n, plan ?? 'two');
      else if (plan) n.signal.plan = plan;
    }
    buildJunction(this.net, n);
    if (control === 'signal') {
      n.signal!.rebuild();
      n.signal!.safeRestart();
    }
    if (prev !== control || control === 'roundabout') this.onJunctionChanged(n);
    updateLinkNexts(this.net);
    this.refreshSignalList();
  }

  /** rebuild connectors after lane arrows changed */
  rebuildNode(n: Node): void {
    buildJunction(this.net, n);
    if (n.control === 'signal' && n.signal) {
      n.signal.rebuild(true);
      n.signal.safeRestart();
    }
    this.onJunctionChanged(n);
    updateLinkNexts(this.net);
  }

  private onJunctionChanged(n: Node): void {
    // vehicles approaching this node must re-plan their movement
    for (const v of this.vehicles) {
      if (v.seg.isLane && (v.seg as Lane).link.to === n) {
        v.committed = null;
        v.stopDone = false;
        this.planAhead(v);
      }
    }
  }

  /** Re-stripe a road. Returns false if the change would disconnect the network. */
  restripe(r: Road, ab: number, ba: number, busAB = r.busAB, busBA = r.busBA, speed = r.speed, test = true): boolean {
    [ab, ba] = clampLaneCounts(r, ab, ba);
    const old = { ab: r.lanesAB, ba: r.lanesBA, busAB: r.busAB, busBA: r.busBA, speed: r.speed };
    const snap = this.snapshotLanes([r]);
    const ends = [r.a, r.b];
    const apply = (): void => {
      buildLanes(r);
      this.restoreArrows(snap);
      for (const n of ends) buildJunction(this.net, n);
      updateLinkNexts(this.net);
    };
    r.lanesAB = ab;
    r.lanesBA = ba;
    r.busAB = busAB;
    r.busBA = busBA;
    r.speed = speed;
    apply();
    if (test && !stronglyConnected(this.net)) {
      r.lanesAB = old.ab;
      r.lanesBA = old.ba;
      r.busAB = old.busAB;
      r.busBA = old.busBA;
      r.speed = old.speed;
      apply();
      this.remapLanes(snap, ends);
      this.afterRebuild(ends);
      return false;
    }
    this.remapLanes(snap, ends);
    this.afterRebuild(ends);
    r.version++;
    return true;
  }

  /**
   * Widen (or narrow) a road to a number of lane slots and stripe it with ab / ba lanes.
   * The curb corners move at both ends, so every road meeting those junctions gets new lanes
   * and every junction those roads touch gets new connectors. Vehicles keep their place.
   */
  reshapeRoad(r: Road, slots: number, ab: number, ba: number, test = true): boolean {
    const ends = [r.a, r.b];
    const roads = new Set<Road>();
    for (const n of ends) for (const arm of n.arms) roads.add(arm.road);
    const nodes = new Set<Node>();
    for (const rd of roads) {
      nodes.add(rd.a);
      nodes.add(rd.b);
    }
    const snap = this.snapshotLanes(roads);
    const old = { slots: r.maxLanes, ab: r.lanesAB, ba: r.lanesBA };
    const apply = (sl: number, a: number, b: number): void => {
      setRoadSlots(r, sl);
      [a, b] = clampLaneCounts(r, a, b);
      r.lanesAB = a;
      r.lanesBA = b;
      for (const n of ends) computeCorners(n);
      for (const rd of roads) buildLanes(rd);
      this.restoreArrows(snap);
      for (const n of nodes) buildJunction(this.net, n);
      updateLinkNexts(this.net);
    };
    apply(slots, ab, ba);
    const ok = !test || stronglyConnected(this.net);
    if (!ok) apply(old.slots, old.ab, old.ba);
    this.remapLanes(snap, nodes);
    this.afterRebuild(nodes);
    if (ok) for (const rd of roads) rd.version++;
    return ok;
  }

  private afterRebuild(nodes: Iterable<Node>): void {
    for (const n of nodes) {
      if (n.control === 'signal' && n.signal) {
        n.signal.rebuild(true);
        n.signal.safeRestart();
      }
      this.onJunctionChanged(n);
    }
  }

  /** remember lanes, their vehicles and lane arrows of some roads before they are rebuilt */
  private snapshotLanes(roads: Iterable<Road>): LaneSnapshot {
    const snap: LaneSnapshot = { roads: new Set(roads), lanes: [], vehs: [], arrows: new Map() };
    for (const rd of snap.roads)
      for (const link of [rd.ab, rd.ba]) {
        snap.arrows.set(link, link.lanes.map((l) => l.arrows));
        for (const l of link.lanes) {
          snap.lanes.push(l);
          for (const v of l.vehs) snap.vehs.push({ v, lane: l, s: v.s });
        }
      }
    return snap;
  }

  /** keep custom lane arrows on links whose lane count did not change */
  private restoreArrows(snap: LaneSnapshot): void {
    for (const [link, arr] of snap.arrows) if (link.lanes.length === arr.length) link.lanes.forEach((l, i) => (l.arrows = arr[i]));
  }

  /** move vehicles and every reference to the old lanes of a snapshot onto the rebuilt lanes */
  private remapLanes(snap: LaneSnapshot, nodes: Iterable<Node>): void {
    const map = new Map<Seg, Lane | null>();
    for (const ol of snap.lanes) {
      const lanes = ol.link.lanes;
      const before = snap.arrows.get(ol.link)?.length ?? 0;
      // same or more lanes: keep the vehicle's lane counted from the curb; fewer: nearest lane
      let best: Lane | null = lanes.length >= before ? (lanes[ol.index] ?? null) : null;
      if (!best) {
        let bd = Infinity;
        for (const nl of lanes) {
          const d = Math.abs(nl.offset - ol.offset);
          if (d < bd) {
            bd = d;
            best = nl;
          }
        }
      }
      map.set(ol, best);
    }
    const touched = new Set<Lane>();
    for (const { v, lane: ol, s } of snap.vehs) {
      ol.removeVehicle(v);
      const nl = map.get(ol) ?? null;
      if (!nl) {
        this.removeVehicle(v, 'abandon');
        continue;
      }
      // keep the vehicle where it physically is
      const p = ol.path.point(clamp(s, 0, ol.len));
      v.seg = nl;
      v.s = clamp(nl.path.project(p.x, p.y).s, 0.05, nl.len - 0.1);
      v.lat += (ol.offset - nl.offset) * (nl.link.forward ? 1 : -1);
      nl.addVehicle(v);
      touched.add(nl);
      v.committed = null;
      v.holdLine = false;
    }
    // a lane that got shorter must not squeeze its queue into overlapping cars
    for (const l of touched) {
      l.resort();
      const vs = l.vehs;
      for (let i = vs.length - 2; i >= 0; i--) {
        const lead = vs[i + 1];
        const maxS = lead.s - lead.len - 0.3;
        if (vs[i].s > maxS) vs[i].s = Math.max(0.05, maxS);
      }
    }
    // connectors still carrying vehicles lead into the new lanes
    for (const n of nodes) {
      for (const c of n.dying) {
        const to = c.outs[0];
        const nl = to ? map.get(to) : undefined;
        if (nl) {
          c.outs = [nl];
          c.toLane = nl;
        }
      }
    }
    for (const v of this.vehicles) {
      if (v.state === 'gone') continue;
      for (let i = 0; i < v.plan.length; i++) {
        const nl = map.get(v.plan[i]);
        if (nl) v.plan[i] = nl;
      }
      for (let i = 0; i < v.prevSegs.length; i++) {
        const nl = map.get(v.prevSegs[i]);
        if (nl) v.prevSegs[i] = nl;
      }
      if (v.seg.isLane) this.planAhead(v);
      // routes through links without lanes need a new route
      if (v.route.some((l, i) => i >= v.ri && l.lanes.length === 0)) this.reroute(v, true);
      if (v.dest && snap.roads.has(v.dest.link.road)) this.fixDestLane(v);
    }
    for (const v of this.vehicles.slice()) if (v.state === 'gone') this.vehicles.splice(this.vehicles.indexOf(v), 1);
  }

  fixDestLane(v: Vehicle): void {
    const d = v.dest!;
    const link = d.link;
    if (link.lanes.length === 0) return;
    d.lane = d.side === 1 ? 0 : link.lanes.length - 1;
    d.s = clamp(d.s, 4, link.lanes[0].len - 4);
  }

  // -------------------------------------------------------------------------
  // main loop

  step(dt: number): void {
    this.time += dt;
    this.dt = dt;
    this.waves.update(dt, this.signalNodes);
    for (const n of this.signalNodes) n.signal!.update(dt, this.time);
    this.sirens = this.vehicles.filter((v) => v.siren && v.state === 'drive');
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) this.think(vs[i], dt);
    for (let i = 0; i < vs.length; i++) this.move(vs[i], dt);
    // merge requests are rebuilt every step during lane change evaluation
    for (const l of this.mergeLanes) this.mergeReq.delete(l);
    this.mergeLanes.length = 0;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      v.lcCool -= dt;
      if (v.lcCool <= 0) this.laneChange(v);
      this.updateLateral(v, dt);
    }
    // remove finished vehicles
    let w = 0;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.state !== 'gone') vs[w++] = v;
    }
    vs.length = w;
    this.processGatewayQueues();
    this.statT += dt;
    if (this.statT >= 1) {
      this.updateStats(this.statT);
      this.statT = 0;
      for (const n of this.net.nodes) if (n.dying.length) cleanupDying(n);
    }
  }

  // -------------------------------------------------------------------------
  // longitudinal decision

  vdes(v: Vehicle, seg: Seg): number {
    let vd = seg.vmax;
    if (seg.isLane) vd *= v.v0f;
    else vd *= v.aLatF;
    vd *= 1 - this.rain * 0.12;
    if (v.siren) vd *= seg.isLane ? 1.3 : 1.1;
    return Math.max(1.5, vd);
  }

  private think(v: Vehicle, dt: number): void {
    if (v.state === 'crashed') {
      v.acc = 0;
      v.v = 0;
      v.hazard = true;
      v.stateT += dt;
      return;
    }
    if (v.state === 'park') {
      v.acc = v.v > 0 ? -Math.max(2, v.b) : 0;
      v.stateT += dt;
      if (v.stateT > 1.6) this.finishTrip(v);
      return;
    }
    const seg = v.seg;
    const rainT = this.rain * 0.45;
    const T = v.T + rainT;
    const a = v.a * (1 - this.rain * 0.15);
    const vd = this.vdes(v, seg);
    const look = Math.max(40, (v.v * v.v) / (2 * v.b) + v.v * 2.5 + 15);
    let acc = idmFree(v.v, vd, a);
    const L = this.findLeader(v, look);
    if (L) {
      let aL = idm(v.v, vd, L.gap, L.vl, T, v.s0, a, v.b);
      if (L.vl < 0.3) aL = Math.min(aL, this.stopProfile(v.v, L.gap - v.s0, v.b, aL));
      acc = Math.min(acc, aL);
    }
    // cooperative yielding to vehicles that need to merge into this lane
    if (seg.isLane) {
      const reqs = this.mergeReq.get(seg as Lane);
      if (reqs && (v.polite > 0.25 || v.v < 4)) {
        for (const r of reqs) {
          if (r.v === v) continue;
          const g = r.s - r.v.len - v.s;
          if (g > 0.5 && g < 35 && r.v.mergeWait > 1.2) {
            acc = Math.min(acc, idm(v.v, vd, g, r.v.v, T, v.s0 + 1, a, v.b));
          }
        }
      }
    }
    v.accLead = acc;
    // slow down for sharp connectors / ring segments ahead
    let d = seg.len - v.s;
    for (let i = 0; i < v.plan.length && d < look; i++) {
      const nx = v.plan[i];
      const vn = this.vdes(v, nx);
      if (vn < v.v) {
        const need = (vn * vn - v.v * v.v) / (2 * Math.max(d - 0.5, 0.5));
        if (need < -0.2) acc = Math.min(acc, Math.max(need * 1.15, -v.b * 1.8));
      }
      d += nx.len;
    }
    const stopD = this.stopDistance(v, look);
    if (stopD < Infinity) {
      const aI = idm(v.v, vd, stopD + 0.3, 0, T, 0.6, a, v.b);
      acc = Math.min(acc, this.stopProfile(v.v, stopD, v.b, aI));
    }
    // yield to emergency vehicles coming from behind
    if (!v.siren && this.sirens.length && seg.isLane) {
      const lane = seg as Lane;
      for (const e of this.sirens) {
        if (!e.seg.isLane || (e.seg as Lane).link !== lane.link) continue;
        const behind = v.s - e.s;
        if (behind > -2 && behind < 55) {
          v.latTarget = 1.15;
          acc = Math.min(acc, idm(v.v, vd * 0.25, 30, 0, T, v.s0, a, v.b));
          v.pullOver = 3;
        }
      }
    }
    if (v.pullOver > 0) {
      v.pullOver -= dt;
      if (v.pullOver <= 0 && v.state === 'drive') v.latTarget = 0;
    }
    // start-up reaction time when the queue starts moving
    if (v.v < 0.15 && acc > 0.15) {
      v.startDelay += dt;
      if (v.startDelay < v.react) acc = Math.min(acc, 0);
    } else if (v.v > 0.8) v.startDelay = 0;
    v.acc = clamp(acc, -9, a);
    // waiting statistics
    if (v.v < 0.5) {
      v.waitT += dt;
      v.stuckT += dt;
    } else if (v.v > 3) {
      v.waitT = Math.max(0, v.waitT - dt * 2);
      v.stuckT = 0;
    }
    if (v.v < 2) {
      v.approachWait += dt;
      v.waitTotal += dt;
    }
    v.mood = clamp((v.stuckT - 15) / 60, 0, 1);
    if (v.stuckT > 8 && v.hornT <= 0 && L && L.gap < 12 && !v.holdLine) {
      if (this.rng.chance(0.04 + v.aggr * 0.05)) {
        this.events.push({ type: 'horn', x: v.x, y: v.y, v });
        v.hornT = 6 + this.rng.next() * 10;
        v.hornFlash = 1.6;
      }
    }
    if (v.hornT > 0) v.hornT -= dt;
    if (v.hornFlash > 0) v.hornFlash -= dt;
    if (v.stuckT > 160 && !v.emergency && !v.bus) this.removeVehicle(v, 'abandon');
    // periodic rerouting with navigation apps / when stuck
    v.rerouteT -= dt;
    if (v.rerouteT <= 0 && seg.isLane && !v.committed) {
      v.rerouteT = 20 + this.rng.next() * 25;
      if (v.nav || v.waitT > 35) this.reroute(v, false);
    }
  }

  /**
   * Drivers brake for a standing obstacle with an (almost) constant deceleration
   * so that they stop at the line in finite time instead of IDM's slow creep.
   */
  private stopProfile(v: number, d: number, b: number, aIdm: number): number {
    const dEff = Math.max(d - 0.1, 0.02);
    if (v < 0.4 && dEff > 0.6) return aIdm; // creep up to the line / queue
    if (dEff <= 0.05) return Math.min(aIdm, -v * 4);
    const need = (v * v) / (2 * dEff);
    if (need > 0.72 * b || dEff < 1.5) return -need;
    // far enough: approach freely, but never faster than what still allows a comfortable stop
    return Math.max(aIdm, 0.5 * (Math.sqrt(2 * 0.72 * b * dEff) - v));
  }

  private findLeader(v: Vehicle, look: number): { gap: number; vl: number } | null {
    const best = { gap: Infinity, vl: 0 };
    const seg = v.seg;
    const vs = seg.vehs;
    const idx = vs.indexOf(v);
    if (idx >= 0) {
      for (let j = idx + 1; j < vs.length; j++) {
        const w = vs[j];
        // emergency vehicles squeeze past vehicles that pulled over
        if (v.siren && w.pullOver > 0 && w.lat > 0.6 && w.v < 2) continue;
        best.gap = w.s - w.len - v.s;
        best.vl = w.v;
        break;
      }
    }
    for (const o of seg.obstacles) {
      if (o.s > v.s) {
        const g = o.s - o.len - v.s;
        if (g < best.gap) {
          best.gap = g;
          best.vl = 0;
        }
      }
    }
    if (!seg.isLane) {
      // vehicles on sibling connectors that have not cleared the diverge area
      if (v.s < 10) {
        for (const sib of seg.siblings) {
          const w = sib.vehs[0];
          if (w && w.s - w.len < 7 && w.s > v.s) {
            const g = w.s - w.len - v.s;
            if (g < best.gap) {
              best.gap = g;
              best.vl = w.v;
            }
          }
        }
      }
      this.mergeLeader(v, seg as Conn, seg.len - v.s, best);
    }
    if (best.gap < Infinity) return best;
    let d = seg.len - v.s;
    for (let i = 0; i < v.plan.length; i++) {
      if (d > look) break;
      const nx = v.plan[i];
      if (nx.vehs.length) {
        let w = nx.vehs[0];
        if (v.siren && w.pullOver > 0 && w.lat > 0.6) w = nx.vehs.find((x) => !(x.pullOver > 0 && x.lat > 0.6)) ?? w;
        const g = d + w.s - w.len;
        if (g < best.gap) {
          best.gap = g;
          best.vl = w.v;
        }
      }
      for (const o of nx.obstacles) {
        const g = d + o.s - o.len;
        if (g < best.gap) {
          best.gap = g;
          best.vl = 0;
        }
      }
      if (!nx.isLane) {
        for (const sib of nx.siblings) {
          const w = sib.vehs[0];
          if (w && w.s - w.len < 7) {
            const g = d + w.s - w.len;
            if (g < best.gap) {
              best.gap = g;
              best.vl = w.v;
            }
          }
        }
        this.mergeLeader(v, nx as Conn, d + nx.len, best);
      }
      if (best.gap < Infinity) break;
      d += nx.len;
    }
    return best.gap < Infinity ? best : null;
  }

  /**
   * Zipper merge: vehicles on a connector that merges with ours and that are
   * closer to the merge point are treated as (virtual) leaders.
   */
  private mergeLeader(v: Vehicle, c: Conn, dToEnd: number, best: { gap: number; vl: number }): void {
    for (const k of c.conflicts) {
      if (!k.merge) continue;
      const o = k.other;
      for (const w of o.vehs) {
        if (w === v) continue;
        const rW = o.len - w.s;
        if (rW > dToEnd || (rW === dToEnd && w.id > v.id)) continue;
        // only vehicles that actually entered the merge area lead; a vehicle
        // still waiting to give way in front of the zone does not
        if (w.s < k.oIn + 0.3 && w.v < 1.5) continue;
        if (w.s < k.oIn - 4) continue;
        const g = dToEnd - rW - w.len;
        if (g < best.gap) {
          best.gap = g;
          best.vl = w.v;
        }
      }
    }
  }

  private atDestLink(v: Vehicle): boolean {
    return !!v.dest && v.ri === v.route.length - 1 && v.route[v.ri] === v.dest.link;
  }

  /** distance to the nearest point where the vehicle must stop (Infinity if none) */
  private stopDistance(v: Vehicle, look: number): number {
    let best = Infinity;
    const seg = v.seg;
    if (seg.isLane) {
      const lane = seg as Lane;
      const dEnd = lane.len - v.s;
      if (this.atDestLink(v) && v.dest!.s - v.s < -1.0) {
        // drove past the destination: go around the block
        this.loopBack(v);
      }
      if (this.atDestLink(v) && lane.index === v.dest!.lane) {
        const d = v.dest!.s - v.s;
        const need = d > 0.5 ? (v.v * v.v) / (2 * d) : 99;
        if (d > -1.0 && d < 0.2 && v.v > 2.5) this.loopBack(v);
        else if (need > v.b * 2.2 && d > 0.5 && v.v > 3) this.loopBack(v);
        else if (d > -1.0) {
          best = Math.max(0, d);
          if (d < 3 && v.v < 0.6) {
            v.state = 'park';
            v.stateT = 0;
            v.latTarget = v.dest!.side * 2.6;
            v.blink = v.dest!.side;
            v.blinkT = 2;
          } else if (d < 40) {
            v.blink = v.dest!.side;
            v.blinkT = 0.5;
          }
        }
      }
      if (v.bus) {
        const b = v.bus;
        const st = b.stops[b.nextStop];
        if (st && st.link === lane.link && lane.index === 0) {
          const d = st.s - v.s;
          if (d > -2) {
            if (d < 2.5 && v.v < 0.4) {
              if (b.dwell <= 0) {
                b.dwell = 8 + this.rng.next() * 12;
                const pax = Math.floor(2 + this.rng.next() * 14);
                b.passengers = pax;
                this.events.push({ type: 'busStop', v, passengers: pax });
              }
              b.dwell -= this.dt;
              v.blink = 1;
              v.blinkT = 0.5;
              if (b.dwell <= 0.05) {
                b.nextStop++;
                b.dwell = 0;
                v.blink = -1;
                v.blinkT = 2.5;
              } else best = Math.min(best, 0);
            } else best = Math.min(best, Math.max(0, d));
          }
        }
      }
      const first = v.plan[0];
      if (first && !first.isLane) {
        if (dEnd < look) {
          const ok = this.entryDecision(v, lane, first as Conn, dEnd);
          v.holdLine = !ok;
          if (!ok) best = Math.min(best, Math.max(0, dEnd - 0.4));
          else if (!v.committed) {
            // yield signs / turning: approach slowly
            const c = first as Conn;
            if (c.node.control === 'priority' && !this.isMajor(c) && !c.node.stopMinor && dEnd > 2) {
              const vcap = 3 + dEnd * 0.25;
              if (v.v > vcap) best = Math.min(best, dEnd + 6);
            }
          }
        } else v.holdLine = false;
        // look further: short next link ending at a red light / stop sign
        if (best === Infinity) best = Math.min(best, this.aheadStop(v, dEnd, look));
      } else if (!first) {
        v.holdLine = false;
        const route = v.route;
        const exitHere = !route[v.ri + 1] && lane.link.to.gateway;
        if (!exitHere && !this.atDestLink(v)) best = Math.min(best, Math.max(0, dEnd - 0.5));
        if (this.atDestLink(v)) best = Math.min(best, Math.max(0, dEnd - 0.5));
        if (!exitHere && dEnd < 25 && !this.atDestLink(v) && v.lcCool > 0.3) {
          // wrong lane near the end: pick another movement
          if (dEnd < 14 || v.waitT > 6) this.rerouteFromLane(v);
        }
      }
    } else {
      const c = seg as Conn;
      best = Math.min(best, this.junctionHold(v, c, 0, v.s));
      let d = c.len - v.s;
      for (const nx of v.plan) {
        if (nx.isLane || d > 22) break;
        best = Math.min(best, this.junctionHold(v, nx as Conn, d, 0));
        d += nx.len;
      }
      if (best === Infinity) best = Math.min(best, this.aheadStop(v, -1, look));
    }
    return best;
  }

  /** Hard stops further ahead in the plan (red light after a short link). */
  private aheadStop(v: Vehicle, dFirst: number, look: number): number {
    let d = v.seg.len - v.s;
    let prev: Seg = v.seg;
    let skipped = dFirst >= 0; // the first junction (if on a lane) was handled by entryDecision
    for (let i = 0; i < v.plan.length; i++) {
      const nx = v.plan[i];
      if (d > look) break;
      if (prev.isLane && !nx.isLane) {
        if (skipped) skipped = false;
        else {
          const c = nx as Conn;
          if (c.node.control === 'signal' && (c.sig === SIG_R || c.sig === SIG_Y) && !v.siren) return Math.max(0, d - 0.4);
          if (c.node.control === 'allstop' || (c.node.control === 'priority' && !this.isMajor(c) && c.node.stopMinor))
            return Math.max(0, d - 0.4);
        }
      }
      d += nx.len;
      prev = nx;
    }
    return Infinity;
  }

  /** movements whose drivers give way to conflicting traffic while already inside the junction */
  private yieldsInside(o: Conn): boolean {
    if (o.kind === 'entry') return true;
    return o.node.control === 'signal' && o.sig === SIG_P;
  }

  /** approaching vehicles on this connector must come to a full stop first */
  private stopControlled(o: Conn): boolean {
    const n = o.node;
    if (n.control === 'allstop') return true;
    if (n.control === 'priority') return n.stopMinor && !this.isMajor(o);
    return false;
  }

  private isMajor(c: Conn): boolean {
    return !!c.inArm && c.node.majorRoads.has(c.inArm.road.id);
  }

  /**
   * Right of way at a priority junction: 2 = follows the major road (straight or bent),
   * 1 = turns off the major road, 0 = comes from a minor road.
   */
  private priorityClass(c: Conn): number {
    if (!this.isMajor(c)) return 0;
    if (c.turn === 'U') return 1;
    return c.outArm && c.node.majorRoads.has(c.outArm.road.id) ? 2 : 1;
  }

  private mustYield(c: Conn, o: Conn, v: Vehicle): boolean {
    if (v.siren) return false;
    const n = c.node;
    switch (n.control) {
      case 'roundabout':
        if (c.kind === 'entry') {
          if (o.kind !== 'entry') return true;
          return c.rank < o.rank || (c.rank === o.rank && c.id > o.id);
        }
        return false;
      case 'signal': {
        const sc = c.sig;
        const so = o.sig;
        if (so === SIG_R || so === SIG_Y) return false;
        if (sc === SIG_R || sc === SIG_Y) return true;
        if (sc === SIG_G && so !== SIG_G) return false;
        if (so === SIG_G && sc !== SIG_G) return true;
        return this.rankYield(c, o);
      }
      case 'priority': {
        const cp = this.priorityClass(c);
        const op = this.priorityClass(o);
        if (cp !== op) return cp < op;
        return this.rankYield(c, o);
      }
      default:
        return this.rankYield(c, o);
    }
  }

  private rankYield(c: Conn, o: Conn): boolean {
    if (c.rank !== o.rank) return c.rank < o.rank;
    const d = normAngle(o.inHeading - c.inHeading);
    if (d < -0.3 && d > -2.8) return true; // other comes from the right
    if (d > 0.3 && d < 2.8) return false;
    return c.id > o.id;
  }

  /** Decide whether the vehicle may pass the stop line onto connector c. */
  private entryDecision(v: Vehicle, lane: Lane, c: Conn, dEnd: number): boolean {
    if (v.committed === c) return true;
    if (c.dead) {
      this.planAhead(v);
      v.holdWhy = 'replan';
      return false;
    }
    const n = c.node;
    const ctrl = n.control;
    const em = v.siren;
    let needStop = false;
    if (ctrl === 'signal' && c.sig !== SIG_NONE && !em) {
      const sig = c.sig;
      if (sig === SIG_R) {
        if (n.rtor && c.turn === 'R') needStop = true;
        else {
          const since = this.time - (n.signal?.redSince.get(c) ?? -99);
          if (v.redRun && since < 1.5 && dEnd < Math.max(4, v.v * 1.3) && v.v > 5 && dEnd > 0.5) {
            v.committed = c;
            this.onRedRun(v, c, since);
            return true;
          }
          v.holdWhy = 'red';
          return false;
        }
      } else if (sig === SIG_Y) {
        const need = (v.v * v.v) / (2 * Math.max(dEnd - 0.5, 0.1));
        const tLeft = n.signal ? n.signal.yellow - n.signal.t : 2;
        const canClear = dEnd / Math.max(v.v, 0.1) < tLeft + 0.5;
        if ((need < v.b * (1.3 - v.aggr * 0.5) && dEnd > 1.0) || (!canClear && need < 5)) {
          v.holdWhy = 'red';
          return false;
        }
        v.committed = c;
        return true;
      }
    } else if (ctrl === 'allstop') needStop = true;
    else if (ctrl === 'priority' && !this.isMajor(c) && n.stopMinor) needStop = true;
    if (em) needStop = false;
    if (needStop) {
      if (!v.stopDone) {
        if (dEnd < 3.2 && v.v < 0.35) {
          v.stopDone = true;
          v.stopDoneT = this.time;
          v.stops++;
          if (ctrl === 'allstop' && !n.stopQueue.includes(v)) n.stopQueue.push(v);
        }
        v.holdWhy = 'stop';
        return false;
      }
      if (this.time - v.stopDoneT < 0.6 + v.react * 0.6) {
        v.holdWhy = 'stop';
        return false;
      }
    }
    if (ctrl === 'allstop' && !em) {
      // first-come first-served among conflicting movements; drivers that cannot
      // go (blocked exit) or hesitate too long lose their turn
      for (const w of n.stopQueue) {
        if (w === v) break;
        if (w.state !== 'drive' || !w.seg.isLane) continue;
        const wc = w.plan[0] as Conn | undefined;
        if (!wc || wc.isLane) continue;
        if (this.time - w.stopDoneT > 7) continue;
        if ((wc.kind === 'move' || wc.kind === 'uturn') && !this.spaceAfter(w, wc, 0)) continue;
        if (wc === c || c.conflicts.some((k) => k.other === wc)) {
          v.holdWhy = 'turn';
          return false;
        }
      }
    }
    // don't block the box
    if ((c.kind === 'move' || c.kind === 'uturn') && !em) {
      const strict = n.box || !v.boxBlock || ctrl !== 'signal';
      if (!this.spaceAfter(v, c, strict ? 0 : -v.len * 0.9)) {
        v.holdWhy = 'box';
        return false;
      }
    }
    const permissiveInside =
      !em && ctrl === 'signal' && c.sig === SIG_P && (c.turn === 'L' || c.turn === 'U');
    for (const k of c.conflicts) {
      if (permissiveInside && k.sIn > 4.5 && !k.merge) {
        if (!this.occupancyClear(v, c, k, dEnd + k.sIn)) {
          v.holdWhy = 'gap';
          return false;
        }
        continue;
      }
      if (!this.zoneClear(v, c, k, dEnd + k.sIn, dEnd + k.sOut)) {
        v.holdWhy = 'gap';
        return false;
      }
    }
    if (permissiveInside) {
      // at most one or two turners wait inside the junction
      let waiting = 0;
      for (const w of c.vehs) if (w.v < 1.5) waiting++;
      if (waiting >= 2) {
        v.holdWhy = 'gap';
        return false;
      }
    }
    const brakeD = (v.v * v.v) / (2 * v.b) + 2.5;
    if (dEnd < brakeD || (v.v < 2 && dEnd < 5)) v.committed = c;
    return true;
  }

  /** free space downstream of a connector for this vehicle */
  private spaceAfter(v: Vehicle, c: Conn, tolerance: number): boolean {
    const to = c.toLane;
    if (!to) return true;
    let space = to.len;
    if (to.vehs.length) {
      const w = to.vehs[0];
      space = w.s - w.len;
      if (w.v > 2.5) space += w.v * 1.5;
    }
    for (const o of to.obstacles) space = Math.min(space, o.s - o.len);
    for (const inc of to.ins) {
      for (const w of inc.vehs) if (w !== v) space -= w.len + 2.0;
    }
    return space >= v.len + 2.0 + tolerance;
  }

  /** only physical occupancy of a zone (used for permissive left turners entering the junction) */
  private occupancyClear(v: Vehicle, c: Conn, k: { other: Conn; oIn: number; oOut: number }, dIn: number): boolean {
    const tIn = timeToCover(Math.max(0, dIn), v.v, v.a, this.vdes(v, c));
    for (const w of k.other.vehs) {
      const wRear = w.s - w.len;
      if (wRear >= k.oOut) continue;
      if (k.oIn - w.s <= 0) {
        if (w.v < 0.3) return false;
        if ((k.oOut - wRear) / Math.max(w.v, 0.5) + 0.3 > tIn) return false;
      }
    }
    return true;
  }

  /**
   * Gap acceptance for one conflict zone.
   * dIn / dOut are distances from the vehicle front to the zone start / end.
   */
  private zoneClear(
    v: Vehicle,
    c: Conn,
    k: { other: Conn; oIn: number; oOut: number; merge: boolean },
    dIn: number,
    dOut: number,
  ): boolean {
    const O = k.other;
    const vmaxC = this.vdes(v, c);
    const rt = v.v < 0.3 ? v.react * 0.5 : 0;
    // drivers accelerate briskly when crossing / merging into a gap
    const aGo = v.a * 1.25;
    const tIn = rt + timeToCover(Math.max(0, dIn), v.v, aGo, vmaxC);
    // crossing: the rear must clear the zone; merging: reach the merge point
    const tOut = rt + timeToCover(Math.max(0, dOut + (k.merge ? 0 : v.len)), v.v, aGo, vmaxC);
    const yieldsTo = this.mustYield(c, O, v);
    const impatience = 1 - Math.min(0.75, v.waitT / 50);
    const margin = k.merge ? (0.5 + v.gapT * 0.45) * impatience : (0.4 + v.gapT) * impatience;
    // after a long wait drivers squeeze into smaller gaps: for merges it is enough
    // to reach the merge point clearly ahead of the other vehicle (it will adapt)
    const forcing = v.waitT > 22 + v.gapT * 6;
    const tNeed = forcing ? (k.merge ? tIn + 1.4 : tOut + 0.6) : tOut + margin;
    for (const w of O.vehs) {
      if (w === v) continue;
      const wRear = w.s - w.len;
      if (wRear >= k.oOut) continue;
      const wdIn = k.oIn - w.s;
      if (wdIn <= 0) {
        if (w.v < 0.3) return false;
        const tClear = (k.oOut - wRear) / Math.max(w.v, 0.5);
        if (tClear + 0.4 > tIn) return false;
        continue;
      }
      const wv = Math.max(this.vdes(w, O), w.v);
      const tInW = (w.v < 0.3 ? w.react * 0.5 : 0) + timeToCover(wdIn, w.v, w.a, wv);
      const tOutW = tInW + (k.oOut - k.oIn + w.len) / Math.max(1.5, Math.min(wv, w.v + 2));
      // a vehicle already inside the junction has right of way, unless it is one of
      // the movements that give way inside the junction (permissive lefts / roundabout entries)
      const wYieldsInside = this.yieldsInside(O) && this.mustYield(O, c, w);
      if (yieldsTo || w.siren || !wYieldsInside) {
        if (w.v < 0.3 && wdIn > 1 && wYieldsInside && !w.siren) continue;
        if (tInW < (w.siren ? tOut + margin : tNeed)) return false;
      } else {
        const wStop = (w.v * w.v) / (2 * 3.5);
        if (wdIn < wStop + 0.5 && tInW < tOut + 0.3 && tOutW > tIn - 0.3) return false;
      }
    }
    for (const up of O.ins) {
      if (!this.scanApproach(v, up, O, k, 0, yieldsTo, tIn, tOut, tNeed - tOut)) return false;
      if (!up.isLane) {
        for (const up2 of up.ins) {
          if (!this.scanApproach(v, up2, O, k, up.len, yieldsTo, tIn, tOut, tNeed - tOut, up)) return false;
        }
      }
    }
    return true;
  }

  private scanApproach(
    v: Vehicle,
    up: Seg,
    O: Conn,
    k: { oIn: number; oOut: number },
    extra: number,
    yieldsTo: boolean,
    tIn: number,
    tOut: number,
    margin: number,
    via?: Seg,
  ): boolean {
    const vs = up.vehs;
    for (let i = vs.length - 1; i >= 0; i--) {
      const w = vs[i];
      if (w === v) continue;
      const toStart = up.len - w.s + extra;
      if (toStart > 85) break;
      if (via) {
        if (w.plan[0] !== via || w.plan[1] !== O) continue;
      } else if (w.plan[0] !== O) continue;
      if (w.state !== 'drive') break;
      const committed = w.committed === O;
      if (!w.siren && !committed) {
        if (!yieldsTo || this.stopControlled(O)) continue;
        if (w.holdLine) break; // it will stop at its line, so will the ones behind it
      }
      const wdIn = toStart + k.oIn;
      const wv = Math.max(this.vdes(w, O), 2);
      const tInW = (w.v < 0.3 ? w.react : 0) + timeToCover(wdIn, w.v, w.a, Math.max(wv, w.v));
      const tOutW = tInW + (k.oOut - k.oIn + w.len) / Math.max(1.5, wv);
      if (committed && !yieldsTo && !w.siren) {
        if (tInW < tOut && tOutW > tIn - 0.3) return false;
        break;
      }
      if (tInW < tOut + margin) return false;
      break;
    }
    return true;
  }

  /** Vehicles inside a junction: wait before conflict zones that are occupied / have priority traffic. */
  private junctionHold(v: Vehicle, c: Conn, d0: number, sOnC: number): number {
    let best = Infinity;
    for (const k of c.conflicts) {
      if (k.sOut <= sOnC) continue;
      const dIn = d0 + k.sIn - sOnC;
      if (dIn > 30) break;
      const O = k.other;
      if (dIn < -0.1) {
        // already inside the zone: keep going, unless we only just entered it and
        // another vehicle is further inside (emergency stop to avoid a collision)
        if (dIn > -2.5 && d0 === 0 && !k.merge) {
          const depth = -dIn;
          for (const w of O.vehs) {
            const wDepth = w.s - k.oIn;
            if (wDepth <= 0 || w.s - w.len >= k.oOut) continue;
            if (wDepth > depth || (wDepth === depth && w.id < v.id)) return 0;
          }
        }
        continue;
      }
      // physical occupancy
      let blocked = false;
      const tIn = timeToCover(Math.max(0, dIn), v.v, v.a, this.vdes(v, c));
      for (const w of O.vehs) {
        const wRear = w.s - w.len;
        if (wRear >= k.oOut) continue;
        if (k.oIn - w.s <= 0) {
          if (w.v < 0.3 || (k.oOut - wRear) / Math.max(w.v, 0.5) + 0.2 > tIn) {
            blocked = true;
            break;
          }
        }
      }
      if (!blocked) {
        const yields = this.mustYield(c, O, v);
        const permissive = c.node.control === 'signal' && c.sig === SIG_P;
        if (yields && (permissive || c.kind === 'entry')) {
          // still in time to wait? (permissive turners and late arrivals)
          if (dIn > 0.3 && !this.zoneClear(v, c, k, dIn, d0 + k.sOut - sOnC)) blocked = true;
        }
      }
      if (blocked) best = Math.min(best, Math.max(0, dIn - 0.6));
    }
    return best;
  }

  private onRedRun(v: Vehicle, c: Conn, since: number): void {
    this.stats.redRuns++;
    const n = c.node;
    this.events.push({ type: 'redrun', v, node: n });
    const allRed = n.signal ? n.signal.allRed : 2;
    // crash risk grows when the all-red clearance interval is short
    const p = clamp((2.4 - allRed) * 0.22 + since * 0.08, 0.02, 0.6);
    if (!this.rng.chance(p)) return;
    let victim: Vehicle | null = null;
    for (const k of c.conflicts) {
      for (const w of k.other.vehs) {
        if (w.state === 'drive' && !w.emergency && w.v > 1) {
          victim = w;
          break;
        }
      }
      if (victim) break;
      const up = k.other.fromLane;
      if (up && up.vehs.length) {
        const w = up.vehs[up.vehs.length - 1];
        if (w.plan[0] === k.other && up.len - w.s < 6 && w.v > 0.5 && !w.emergency) {
          victim = w;
          break;
        }
      }
    }
    if (victim) {
      // the runner enters the junction and both stop at the crash point
      this.pendingCrash.push({ a: v, b: victim, t: 0.5 + this.rng.next() * 0.5, node: n });
    }
  }

  pendingCrash: { a: Vehicle; b: Vehicle; t: number; node: Node | null }[] = [];

  crash(vs: Vehicle[], node: Node | null): void {
    for (const v of vs) {
      if (v.state === 'gone') continue;
      v.state = 'crashed';
      v.v = 0;
      v.acc = 0;
      v.hazard = true;
      v.siren = false;
      v.committed = null;
      v.stateT = 0;
      this.dropFromStopQueue(v);
    }
    this.stats.crashes++;
    const p = vs[0];
    this.events.push({ type: 'crash', x: p.x, y: p.y, vehicles: vs, node });
  }

  /** remove crashed vehicles (tow truck arrived / police cleared) */
  clearCrash(vs: Vehicle[]): void {
    for (const v of vs) if (v.state === 'crashed') this.removeVehicle(v, 'cleared');
  }

  /** random crash between a vehicle and its leader (rear-end / side swipe) */
  randomCrash(): Vehicle[] | null {
    const cands = this.vehicles.filter((v) => v.state === 'drive' && v.v > 7 && v.seg.isLane && !v.emergency && !v.bus);
    if (!cands.length) return null;
    const v = this.rng.pick(cands);
    const lane = v.seg as Lane;
    const i = lane.vehs.indexOf(v);
    const lead = i >= 0 && i < lane.vehs.length - 1 ? lane.vehs[i + 1] : null;
    const group = lead && lead.s - lead.len - v.s < 14 && lead.state === 'drive' ? [v, lead] : [v];
    if (lane.len - v.s < 8) return null;
    this.crash(group, null);
    return group;
  }

  // -------------------------------------------------------------------------
  // integration and segment transitions

  private move(v: Vehicle, dt: number): void {
    if (v.state === 'crashed' || v.state === 'gone') return;
    let nv = v.v + v.acc * dt;
    let ds: number;
    if (nv < 0) {
      ds = v.acc < 0 ? Math.max(0, (-0.5 * v.v * v.v) / v.acc) : 0;
      nv = 0;
    } else ds = v.v * dt + 0.5 * v.acc * dt * dt;
    v.v = nv;
    v.brake = v.acc < -0.6 || (v.v < 0.3 && v.state !== 'pullout');
    if (ds <= 0) return;
    v.s += ds;
    v.dist += ds;
    let guard = 0;
    while (v.s >= v.seg.len && guard++ < 6) {
      const next = v.plan[0];
      const seg = v.seg;
      if (!next) {
        if (seg.isLane && (seg as Lane).link.to.gateway && !v.route[v.ri + 1]) {
          this.finishTrip(v);
        } else {
          v.s = seg.len - 0.01;
          v.v = 0;
        }
        return;
      }
      const overflow = v.s - seg.len;
      seg.removeVehicle(v);
      v.prevSegs.unshift(seg);
      if (v.prevSegs.length > 3) v.prevSegs.pop();
      v.plan.shift();
      v.seg = next;
      v.s = Math.min(overflow, next.len - 0.01);
      next.addVehicle(v);
      v.lastEvt = `enter ${next.isLane ? 'lane' : 'conn'} ${next.id} from ${seg.id} s=${v.s.toFixed(2)} idx=${next.vehs.indexOf(v)}/${next.vehs.length}`;
      v.lastEvtT = this.time;
      if (next.isLane) {
        (next as Lane).link.flowCount++;
        v.ri++;
        v.committed = null;
        v.stopDone = false;
        v.holdLine = false;
        v.waitT = 0;
        v.lcCool = 0.5 + this.rng.next() * 0.5;
        const nl = next as Lane;
        if (nl.link !== v.route[v.ri]) {
          // route got out of sync (should not happen): re-align
          const idx = v.route.indexOf(nl.link);
          if (idx >= 0) v.ri = idx;
          else this.reroute(v, true);
        }
        this.planAhead(v);
      } else if (seg.isLane) {
        // entered a junction: record delay at this approach
        const c = next as Conn;
        const n = c.node;
        const link = (seg as Lane).link;
        const w = v.approachWait;
        link.delayEMA += (w - link.delayEMA) * 0.08;
        n.delayEMA += (w - n.delayEMA) * 0.04;
        n.delaySum += w;
        n.delayN++;
        n.passed++;
        n.signal?.onEnter(c, seg as Lane);
        v.approachWait = 0;
        this.dropFromStopQueue(v);
        v.stopDone = false;
      }
    }
  }

  private dropFromStopQueue(v: Vehicle): void {
    if (!v.seg) return;
    const seg = v.seg;
    let n: Node | null = null;
    if (seg.isLane) n = (seg as Lane).link.to;
    else n = (seg as Conn).node;
    const q = n.stopQueue;
    const i = q.indexOf(v);
    if (i >= 0) q.splice(i, 1);
    // also scan previous node (vehicles that just entered a junction)
    for (const p of v.prevSegs) {
      if (p.isLane) {
        const qq = (p as Lane).link.to.stopQueue;
        const j = qq.indexOf(v);
        if (j >= 0) qq.splice(j, 1);
      }
    }
  }

  planAhead(v: Vehicle): void {
    v.plan = [];
    if (!v.seg.isLane) return;
    let lane = v.seg as Lane;
    let ri = v.ri;
    for (let depth = 0; depth < 2; depth++) {
      const next = v.route[ri + 1];
      if (!next) break;
      const mv = lane.moves.get(next.id);
      if (!mv) break;
      for (const s of mv) v.plan.push(s);
      const tl = mv[mv.length - 1] as Lane;
      if (tl.len > 55) break;
      lane = tl;
      ri++;
    }
  }

  // -------------------------------------------------------------------------
  // lane changing (MOBIL)

  private busLaneAllowed(v: Vehicle, lane: Lane, dEnd: number): boolean {
    if (v.kind === 'bus' || v.emergency || v.kind === 'taxi' || v.tow) return true;
    if (dEnd < 40) {
      const next = v.route[v.ri + 1];
      if (next && lane.moves.has(next.id)) {
        const c = lane.moves.get(next.id)![0] as Conn;
        if (c.turn === 'R') return true;
      }
    }
    return false;
  }

  laneOk(v: Vehicle, lane: Lane): boolean {
    const dEnd = lane.len - v.s;
    if (lane.busOnly && !this.busLaneAllowed(v, lane, dEnd)) {
      // a bus lane is only acceptable if it is the only lane leading to the next link
      return false;
    }
    if (this.atDestLink(v)) return lane.index === v.dest!.lane;
    if (v.bus) {
      const st = v.bus.stops[v.bus.nextStop];
      if (st && st.link === lane.link && st.s > v.s - 2 && st.s - v.s < 140) return lane.index === 0;
    }
    const next = v.route[v.ri + 1];
    if (!next) return true;
    return lane.moves.has(next.id);
  }

  private nextNextBias(v: Vehicle, lane: Lane): number {
    const next = v.route[v.ri + 1];
    if (!next) return 0;
    const mv = lane.moves.get(next.id);
    if (!mv) return 0;
    const tl = mv[mv.length - 1] as Lane;
    const nn = v.route[v.ri + 2];
    if (!nn) {
      // next link is the destination: arrive in the lane next to the curb we stop at
      if (v.dest && v.dest.link === next) return tl.index === v.dest.lane ? 0.6 : 0;
      return 0;
    }
    return tl.moves.has(nn.id) ? 0.35 : 0;
  }

  private laneChange(v: Vehicle): void {
    v.lcCool = 0.35 + this.rng.next() * 0.35;
    if (v.state !== 'drive' || !v.seg.isLane || v.committed) return;
    const lane = v.seg as Lane;
    const link = lane.link;
    if (link.lanes.length < 2) {
      v.mandatoryLC = 0;
      return;
    }
    const dEnd = lane.len - v.s;
    if (v.s < 3 || dEnd < 2.5) return;
    if (Math.abs(v.lat) > 1.2) return; // still finishing a previous manoeuvre
    const curOk = this.laneOk(v, lane);
    let mand = 0;
    if (!curOk) {
      for (let k = 1; k < link.lanes.length; k++) {
        const r = link.lanes[lane.index - k];
        if (r && this.laneOk(v, r)) {
          mand = 1;
          break;
        }
        const l = link.lanes[lane.index + k];
        if (l && this.laneOk(v, l)) {
          mand = -1;
          break;
        }
      }
    }
    v.mandatoryLC = mand;
    const dTarget = this.atDestLink(v) ? v.dest!.s - v.s : dEnd;
    const urgency = clamp(1 - (dTarget - 12) / 110, 0, 1);
    const discretionaryOK = dEnd > 30 && v.s > 6 && !v.bus;
    let best: Lane | null = null;
    let bestScore = 0;
    let bestS = 0;
    const T = v.T + this.rain * 0.45;
    for (const cand of [lane.left, lane.right]) {
      if (!cand) continue;
      const toRight = cand === lane.right;
      const isMand = mand !== 0 && (mand === 1) === toRight;
      if (!isMand && !discretionaryOK) continue;
      const candOk = this.laneOk(v, cand);
      if (cand.busOnly && !this.busLaneAllowed(v, cand, cand.len - v.s)) continue;
      const sN = v.s * (cand.len / lane.len);
      const vs = cand.vehs;
      let lead: Vehicle | null = null;
      let lag: Vehicle | null = null;
      for (let i = 0; i < vs.length; i++) {
        if (vs[i].s >= sN) {
          lead = vs[i];
          lag = i > 0 ? vs[i - 1] : null;
          break;
        }
      }
      if (!lead && vs.length) lag = vs[vs.length - 1];
      let lagS = lag ? lag.s : -Infinity;
      // vehicles about to enter the candidate lane from the junction behind us
      if (!lag || lagS < 0) {
        for (const inc of cand.ins) {
          for (const w of inc.vehs) {
            const sv = w.s - inc.len;
            if (sv > lagS) {
              lagS = sv;
              lag = w;
            }
          }
        }
      }
      const minGap = isMand ? 0.6 + 1.4 * (1 - urgency) : 2.0;
      let gapF = Infinity;
      let gapB = Infinity;
      if (lead) {
        gapF = lead.s - lead.len - sN;
        if (gapF < minGap) continue;
      }
      if (lag) {
        gapB = sN - v.len - lagS;
        if (gapB < minGap) continue;
      }
      let blocked = false;
      for (const o of cand.obstacles) if (o.s > sN - v.len - 3 && o.s - o.len < sN + 3) blocked = true;
      if (blocked) continue;
      const vdC = this.vdes(v, cand);
      let aLagNew = 0;
      let aLagOld = 0;
      if (lag) {
        aLagNew = idm(lag.v, this.vdes(lag, cand), gapB, v.v, lag.T + this.rain * 0.45, lag.s0, lag.a, lag.b);
        aLagOld = lag.accLead;
        const bSafe = isMand ? 2.2 + 2.8 * urgency : 1.8;
        if (aLagNew < -bSafe) continue;
      }
      const aNew = lead ? idm(v.v, vdC, gapF, lead.v, T, v.s0, v.a, v.b) : idmFree(v.v, vdC, v.a);
      const aOld = v.accLead;
      const idx = lane.vehs.indexOf(v);
      const fol = idx > 0 ? lane.vehs[idx - 1] : null;
      let fDelta = 0;
      if (fol) {
        const myLead = idx < lane.vehs.length - 1 ? lane.vehs[idx + 1] : null;
        const vdF = this.vdes(fol, lane);
        const aFolNew = myLead
          ? idm(fol.v, vdF, myLead.s - myLead.len - fol.s, myLead.v, fol.T, fol.s0, fol.a, fol.b)
          : idmFree(fol.v, vdF, fol.a);
        fDelta = aFolNew - fol.accLead;
      }
      let score = aNew - aOld + v.polite * (aLagNew - aLagOld + fDelta);
      if (isMand) score += 1.5 + 5 * urgency;
      else if (curOk && !candOk) score -= dTarget > 170 ? 0.7 : 60;
      if (!curOk && !candOk && !isMand) score -= 1;
      // obstacle (crash / stopped bus) ahead in the current lane
      if (this.blockedAhead(v, lane, 70)) score += 2.5;
      score += toRight ? 0.1 : -0.05;
      if (cand.busOnly) score -= 0.3;
      score += this.nextNextBias(v, cand) - this.nextNextBias(v, lane);
      const thr = 0.25 + (1 - v.aggr) * 0.45;
      if (score > thr && score > bestScore) {
        bestScore = score;
        best = cand;
        bestS = sN;
      }
    }
    if (best) {
      this.applyLaneChange(v, lane, best, bestS);
    } else if (mand !== 0) {
      v.blink = mand === 1 ? 1 : -1;
      v.blinkT = 1;
      v.mergeWait += 0.5;
      const target = mand === 1 ? lane.right : lane.left;
      if (target) {
        let arr = this.mergeReq.get(target);
        if (!arr) {
          this.mergeReq.set(target, (arr = []));
          this.mergeLanes.push(target);
        }
        arr.push({ v, s: v.s * (target.len / lane.len) });
      }
    }
  }

  private blockedAhead(v: Vehicle, lane: Lane, range: number): boolean {
    for (const o of lane.obstacles) if (o.s > v.s && o.s - v.s < range) return true;
    const i = lane.vehs.indexOf(v);
    for (let j = i + 1; j < lane.vehs.length; j++) {
      const w = lane.vehs[j];
      if (w.s - v.s > range) break;
      if (w.state === 'crashed' || (w.bus && w.bus.dwell > 0) || w.state === 'park') return true;
    }
    return false;
  }

  private applyLaneChange(v: Vehicle, from: Lane, to: Lane, sN: number): void {
    v.lastEvt = `lc ${from.id}->${to.id} s=${v.s.toFixed(1)}->${sN.toFixed(1)}`;
    v.lastEvtT = this.time;
    from.removeVehicle(v);
    v.seg = to;
    v.s = sN;
    to.addVehicle(v);
    const dOff = (from.offset - to.offset) * (from.link.forward ? 1 : -1);
    v.lat += dOff;
    v.blink = dOff > 0 ? -1 : 1;
    v.blinkT = 2.4;
    v.lcCool = 2.5 + this.rng.next() * 2.5;
    v.mergeWait = 0;
    v.holdLine = false;
    v.committed = null;
    this.planAhead(v);
  }

  private updateLateral(v: Vehicle, dt: number): void {
    // critically damped spring towards the target lateral offset
    const k = v.state === 'park' ? 3.0 : 5.5;
    const c = 2 * Math.sqrt(k);
    const acc = -k * (v.lat - v.latTarget) - c * v.latV;
    v.latV += acc * dt;
    v.lat += v.latV * dt;
    if (v.blinkT > 0) {
      v.blinkT -= dt;
      if (v.blinkT <= 0) v.blink = 0;
    }
    // indicate upcoming turns
    if (v.blink === 0 && v.seg.isLane && v.plan.length) {
      const dEnd = v.seg.len - v.s;
      const c0 = v.plan[0];
      if (!c0.isLane && dEnd < 35) {
        const t = (c0 as Conn).turn;
        if ((c0 as Conn).kind === 'move') v.blink = t === 'L' || t === 'U' ? -1 : t === 'R' ? 1 : 0;
      }
    } else if (!v.seg.isLane && v.blinkT <= 0) {
      const c0 = v.seg as Conn;
      if (c0.kind === 'move') v.blink = c0.turn === 'L' || c0.turn === 'U' ? -1 : c0.turn === 'R' ? 1 : 0;
      else if (c0.kind === 'exit') v.blink = 1;
      else v.blink = 0;
    }
  }

  // -------------------------------------------------------------------------
  // routing helpers

  /** Re-plan the route from the current link. force=true always adopts the new route. */
  reroute(v: Vehicle, force: boolean): boolean {
    if (!v.seg.isLane) return false;
    const cur = (v.seg as Lane).link;
    const goal = v.route[v.route.length - 1];
    if (!goal) return false;
    if (cur === goal && !force) return false;
    const r = this.router.route(cur, goal, { seed: v.seed, noise: 0.08, live: true });
    if (!r) return false;
    if (!force) {
      const oldCost = this.router.routeCost(v.route, v.ri);
      const newCost = this.router.routeCost(r, 0);
      if (newCost > oldCost * 0.85 - 4) return false;
    }
    v.route = v.route.slice(0, v.ri).concat(r);
    this.planAhead(v);
    return true;
  }

  /** Missed the destination: plan a loop around the block back to the same link. */
  loopBack(v: Vehicle): void {
    if (!v.seg.isLane) return;
    const cur = (v.seg as Lane).link;
    let best: Link[] | null = null;
    let bestC = Infinity;
    const lane = v.seg as Lane;
    const options = lane.moves.size ? [...lane.moves.keys()].map((id) => this.net.links[id]) : cur.nexts;
    for (const nx of options) {
      if (nx === cur.reverse && options.length > 1) continue;
      const r = this.router.route(nx, cur, { live: true });
      if (!r) continue;
      const c = this.router.routeCost(r, 0);
      if (c < bestC) {
        bestC = c;
        best = r;
      }
    }
    if (!best) {
      // no way back (e.g. the only way on leaves the city): drive out of town
      for (const nx of options) {
        const r = nx.to.gateway ? [nx] : this.router.route(nx, (l) => l.to.gateway, { live: true });
        if (r) {
          best = r;
          v.dest = null;
          break;
        }
      }
    }
    if (best) {
      v.route = v.route.slice(0, v.ri + 1).concat(best);
      this.planAhead(v);
      v.lcCool = 0.3;
    }
  }

  /** In the wrong lane at the stop line: choose a movement allowed from this lane. */
  private rerouteFromLane(v: Vehicle): void {
    const lane = v.seg as Lane;
    const goal = v.route[v.route.length - 1];
    let best: Link[] | null = null;
    let bestC = Infinity;
    for (const id of lane.moves.keys()) {
      const nx = this.net.links[id];
      const r = nx === goal ? [nx] : this.router.route(nx, goal, { live: true });
      if (!r) continue;
      const c = this.router.routeCost(r, 0);
      if (c < bestC) {
        bestC = c;
        best = r;
      }
    }
    v.lcCool = 2;
    if (!best) {
      // destination unreachable from here: give up and leave the city
      for (const id of lane.moves.keys()) {
        const nx = this.net.links[id];
        const r = nx.to.gateway ? [nx] : this.router.route(nx, (l) => l.to.gateway, { live: true });
        if (r) {
          best = r;
          v.dest = null;
          break;
        }
      }
    }
    if (best) {
      v.route = v.route.slice(0, v.ri + 1).concat(best);
      this.planAhead(v);
      v.mandatoryLC = 0;
    } else if (v.waitT > 20) this.removeVehicle(v, 'abandon');
  }

  // -------------------------------------------------------------------------
  // spawning / removal

  trySpawn(req: SpawnReq): Vehicle | null {
    const link = req.link;
    if (link.lanes.length === 0) return null;
    const route = req.route ? req.route.slice() : this.router.route(link, req.goal, { live: true, noise: 0.1, seed: Math.floor(this.rng.next() * 1e9) });
    if (!route) return null;
    const v = new Vehicle(req.kind, req.model, req.color ?? randomPaint(this.rng));
    v.personalise(this.rng, this.aggressionBias);
    v.route = route;
    v.ri = 0;
    v.dest = req.dest;
    v.origin = req.origin ?? -1;
    v.siren = !!req.siren;
    v.emergency = !!req.siren;
    let lane: Lane;
    let s: number;
    if (req.s !== undefined) {
      // pull-out from a building onto the curb lane of its side
      const side = req.side ?? 1;
      lane = side === 1 ? link.lanes[0] : link.lanes[link.lanes.length - 1];
      if (lane.busOnly && link.lanes.length > 1) lane = link.lanes[1];
      s = clamp(req.s, v.len + 1, lane.len - 2);
      if (!this.gapForInsert(lane, s, v.len, true)) return null;
      v.v = 0;
      v.lat = side * 3.0;
      v.latTarget = 0;
      v.blink = -side as 1 | -1;
      v.blinkT = 2.5;
    } else {
      // gateway entry: pick the lane valid for the first movement with most room
      v.seg = link.lanes[0];
      let bestLane: Lane | null = null;
      let bestRoom = -1;
      for (const l of link.lanes) {
        if (l.busOnly && !v.bus && v.kind !== 'bus') continue;
        const room = l.vehs.length ? l.vehs[0].s - l.vehs[0].len : l.len;
        const ok = this.laneOkFor(route, 0, l);
        const score = room + (ok ? 30 : 0);
        if (score > bestRoom) {
          bestRoom = score;
          bestLane = l;
        }
      }
      lane = bestLane ?? link.lanes[0];
      s = Math.min(v.len + 0.5, lane.len - 1);
      const room = lane.vehs.length ? lane.vehs[0].s - lane.vehs[0].len : lane.len;
      if (room < v.len + 4) return null;
      v.v = Math.min(lane.vmax * 0.85, Math.max(0, (room - v.len - 4) * 0.5));
    }
    v.seg = lane;
    v.s = s;
    lane.addVehicle(v);
    v.lastEvt = `spawn lane ${lane.id} s=${s.toFixed(1)} pull=${req.s !== undefined}`;
    v.lastEvtT = this.time;
    this.vehicles.push(v);
    this.planAhead(v);
    v.spawnT = this.time;
    v.ffTime = Math.max(10, this.router.freeFlowTime(route));
    v.rerouteT = 10 + this.rng.next() * 20;
    v.lcCool = 0.5;
    v.state = 'drive';
    this.stats.spawned++;
    this.updatePose(v);
    return v;
  }

  private laneOkFor(route: Link[], ri: number, lane: Lane): boolean {
    const next = route[ri + 1];
    if (!next) return true;
    return lane.moves.has(next.id);
  }

  private gapForInsert(lane: Lane, s: number, len: number, pullout: boolean): boolean {
    for (const w of lane.vehs) {
      const wFront = w.s;
      const wRear = w.s - w.len;
      if (wRear < s + 4 && wFront > s - len - 2) return false;
      if (wFront <= s - len - 2) {
        const gap = s - len - wFront;
        if (gap < 6 + w.v * (pullout ? 2.0 : 1.2)) return false;
      }
    }
    for (const o of lane.obstacles) if (o.s - o.len < s + 4 && o.s > s - len - 2) return false;
    if (s - len < 25) {
      for (const inc of lane.ins) for (const w of inc.vehs) {
        const sv = w.s - inc.len;
        const gap = s - len - sv;
        if (gap < 6 + w.v * (pullout ? 2.0 : 1.2)) return false;
      }
    }
    return true;
  }

  /** queue a vehicle that wants to enter from a gateway */
  queueGateway(req: SpawnReq): void {
    let q = this.gatewayQueues.get(req.link.id);
    if (!q) this.gatewayQueues.set(req.link.id, (q = []));
    if (q.length < 25) q.push(req);
  }

  private processGatewayQueues(): void {
    for (const q of this.gatewayQueues.values()) {
      if (!q.length) continue;
      const v = this.trySpawn(q[0]);
      if (v) q.shift();
      else if (q.length && !q[0].link.lanes.length) q.shift();
    }
  }

  gatewayBacklog(): number {
    let n = 0;
    for (const q of this.gatewayQueues.values()) n += q.length;
    return n;
  }

  private finishTrip(v: Vehicle): void {
    const tt = this.time - v.spawnT;
    if (v.siren || v.emergency) this.events.push({ type: 'emergencyArrived', v, time: tt });
    else if (v.tow) this.events.push({ type: 'towDone', v });
    else {
      this.events.push({ type: 'trip', v, time: tt, ff: v.ffTime });
      this.stats.trips++;
    }
    this.removeVehicle(v, 'done');
  }

  removeVehicle(v: Vehicle, reason: 'done' | 'abandon' | 'cleared'): void {
    if (v.state === 'gone') return;
    if (reason === 'abandon') {
      this.events.push({ type: 'abandon', v });
      this.stats.abandoned++;
    }
    this.dropFromStopQueue(v);
    v.seg.removeVehicle(v);
    v.state = 'gone';
  }

  // -------------------------------------------------------------------------

  private updateStats(dt: number): void {
    for (const l of this.net.links) {
      if (!l.lanes.length) continue;
      let n = 0;
      let sumV = 0;
      let stopped = 0;
      for (const lane of l.lanes) {
        let q = 0;
        for (let i = lane.vehs.length - 1; i >= 0; i--) {
          const w = lane.vehs[i];
          n++;
          sumV += w.v;
          if (w.v < 1) stopped++;
          if (w.v < 1.5 && q === lane.vehs.length - 1 - i) q++;
        }
        lane.queue = q;
      }
      l.count = n;
      l.stopped = stopped;
      const vAvg = n ? sumV / n : l.road.speed;
      const ttNow = l.length / Math.max(1.0, vAvg) + (stopped * 2.2) / Math.max(1, l.lanes.length);
      const target = n ? Math.max(l.ttFree, ttNow) : l.ttFree;
      l.ttEst += (target - l.ttEst) * Math.min(1, 0.3 * dt);
      l.speedEMA += (vAvg - l.speedEMA) * Math.min(1, 0.3 * dt);
      if (!n) l.delayEMA *= 0.97;
      l.flowCount *= Math.pow(0.985, dt);
    }
    for (const n of this.net.nodes) {
      // remove stale vehicles from all-way stop queues
      if (n.stopQueue.length) n.stopQueue = n.stopQueue.filter((v) => v.state === 'drive' && v.seg.isLane && (v.seg as Lane).link.to === n);
    }
    for (const p of this.pendingCrash.slice()) {
      p.t -= dt;
      if (p.t <= 0) {
        this.pendingCrash.splice(this.pendingCrash.indexOf(p), 1);
        if (p.a.state === 'drive' && p.b.state === 'drive') this.crash([p.a, p.b], p.node);
      }
    }
  }

  // -------------------------------------------------------------------------
  // render support

  posAt(v: Vehicle, s: number, out: { x: number; y: number; dx: number; dy: number }): void {
    let seg = v.seg;
    let ss = s;
    let i = 0;
    while (ss < 0 && i < v.prevSegs.length) {
      seg = v.prevSegs[i++];
      ss += seg.len;
    }
    seg.path.sample(ss, out);
  }

  updatePose(v: Vehicle): void {
    const p = tmpPose;
    this.posAt(v, v.s - v.len * 0.2, p);
    const fx = p.x;
    const fy = p.y;
    this.posAt(v, v.s - v.len * 0.8, p);
    let hx = fx - p.x;
    let hy = fy - p.y;
    const l = Math.hypot(hx, hy);
    if (l > 1e-4) {
      hx /= l;
      hy /= l;
    } else {
      hx = v.hx;
      hy = v.hy;
    }
    // yaw slightly with lateral motion (lane change)
    const yaw = clamp(-v.latV * 0.06, -0.25, 0.25);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    v.hx = hx * cy - hy * sy;
    v.hy = hx * sy + hy * cy;
    const cx = (fx + p.x) * 0.5;
    const cyy = (fy + p.y) * 0.5;
    v.x = cx - hy * v.lat;
    v.y = cyy + hx * v.lat;
  }

  updatePoses(): void {
    for (const v of this.vehicles) this.updatePose(v);
  }

  // -------------------------------------------------------------------------
  // helpers for the game layer

  nodeLOS(n: Node): string {
    const d = n.delayEMA;
    if (d < 10) return 'A';
    if (d < 20) return 'B';
    if (d < 35) return 'C';
    if (d < 55) return 'D';
    if (d < 80) return 'E';
    return 'F';
  }

  spawnModelFor(kind: VKind): number {
    switch (kind) {
      case 'taxi':
        return MODEL.taxi;
      case 'van':
        return this.rng.chance(0.5) ? MODEL.van : MODEL.pickup;
      case 'truck':
        return MODEL.truck;
      case 'bus':
        return MODEL.bus;
      case 'ambulance':
        return MODEL.ambulance;
      case 'police':
        return MODEL.police;
      case 'fire':
        return MODEL.fire;
      case 'tow':
        return MODEL.tow;
      default:
        return this.rng.weighted([MODEL.sedan, MODEL.hatch, MODEL.suv, MODEL.pickup], [45, 28, 22, 5]);
    }
  }

  /** remove every vehicle (end of day) */
  clearAll(): void {
    for (const v of this.vehicles) {
      v.seg.removeVehicle(v);
      v.state = 'gone';
    }
    this.vehicles.length = 0;
    for (const n of this.net.nodes) {
      n.stopQueue = [];
      for (const c of n.dying) c.vehs.length = 0;
      cleanupDying(n);
    }
    for (const l of this.net.links) for (const lane of l.lanes) lane.vehs.length = 0;
    this.gatewayQueues.clear();
    this.pendingCrash = [];
  }
}

export { SIG_G, SIG_P, SIG_R, SIG_Y };
