// Congestion aware route planner (Dijkstra over directed links).
// Link costs come from live travel time estimates measured by the simulation,
// plus turn penalties and a small per-driver perception noise so that not all
// drivers pick exactly the same path.

import type { Link, Network } from './network.ts';
import { relTurnAngle } from './network.ts';

class Heap {
  keys: number[] = [];
  vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(k: number, v: number): void {
    const keys = this.keys;
    const vals = this.vals;
    keys.push(k);
    vals.push(v);
    let i = keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [keys[p], keys[i]] = [keys[i], keys[p]];
      [vals[p], vals[i]] = [vals[i], vals[p]];
      i = p;
    }
  }

  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const lk = keys.pop()!;
    const lv = vals.pop()!;
    if (keys.length > 0) {
      keys[0] = lk;
      vals[0] = lv;
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && keys[l] < keys[m]) m = l;
        if (r < n && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [vals[m], vals[i]] = [vals[i], vals[m]];
        i = m;
      }
    }
    return top;
  }

  topKey(): number {
    return this.keys[0];
  }
}

export interface RouteOpts {
  seed?: number; // perception noise seed
  noise?: number; // 0..0.3
  live?: boolean; // use live travel times (navigation app) instead of habitual free-flow + typical delays
  avoidLink?: Link | null;
}

export class Router {
  net: Network;
  private dist: Float64Array = new Float64Array(0);
  private prev: Int32Array = new Int32Array(0);
  private done: Uint8Array = new Uint8Array(0);
  turnPenalty = { L: 6, R: 2, S: 0, U: 25 };

  constructor(net: Network) {
    this.net = net;
  }

  private ensure(): void {
    const n = this.net.links.length;
    if (this.dist.length !== n) {
      this.dist = new Float64Array(n);
      this.prev = new Int32Array(n);
      this.done = new Uint8Array(n);
    }
  }

  linkCost(l: Link, o: RouteOpts): number {
    let c: number;
    if (o.live) c = l.ttEst + l.delayEMA;
    else c = l.ttFree * 0.6 + l.ttEst * 0.4 + l.delayEMA * 0.5;
    if (o.noise && o.seed !== undefined) {
      const h = Math.imul(o.seed ^ (l.id * 2654435761), 0x45d9f3b) >>> 0;
      c *= 1 + ((h % 1000) / 1000 - 0.5) * 2 * o.noise;
    }
    if (l.closed) c += 1e6;
    return c;
  }

  turnCost(from: Link, to: Link): number {
    const inArm = from.toArm;
    const outArm = to.fromArm;
    const inHeading = Math.atan2(-inArm.dir.y, -inArm.dir.x);
    const rel = relTurnAngle(inHeading, outArm.angle);
    if (from.reverse === to) return this.turnPenalty.U;
    if (Math.abs(rel) < 0.55) return this.turnPenalty.S;
    return rel < 0 ? this.turnPenalty.L : this.turnPenalty.R;
  }

  /**
   * Shortest path from `from` (already on it) to `to`. The returned route starts with `from`.
   */
  route(from: Link, to: Link | ((l: Link) => boolean), o: RouteOpts = {}): Link[] | null {
    this.ensure();
    const isGoal = typeof to === 'function' ? to : (l: Link) => l === to;
    if (isGoal(from)) return [from];
    const dist = this.dist;
    const prev = this.prev;
    const done = this.done;
    dist.fill(Infinity);
    prev.fill(-1);
    done.fill(0);
    const h = new Heap();
    dist[from.id] = 0;
    h.push(0, from.id);
    let goal = -1;
    while (h.size) {
      const d = h.topKey();
      const u = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      const lu = this.net.links[u];
      if (u !== from.id && isGoal(lu)) {
        goal = u;
        break;
      }
      if (d > 1e5) break;
      for (const nx of lu.nexts) {
        if (nx.closed && !isGoal(nx)) continue;
        if (o.avoidLink && nx === o.avoidLink) continue;
        const nd = d + this.turnCost(lu, nx) + this.linkCost(nx, o);
        if (nd < dist[nx.id]) {
          dist[nx.id] = nd;
          prev[nx.id] = u;
          h.push(nd, nx.id);
        }
      }
    }
    if (goal < 0) return null;
    const out: Link[] = [];
    let c = goal;
    while (c >= 0) {
      out.push(this.net.links[c]);
      if (c === from.id) break;
      c = prev[c];
    }
    out.reverse();
    if (out[0] !== from) return null;
    return out;
  }

  /** Estimated cost of a route (live) */
  routeCost(route: Link[], startIdx = 0): number {
    let c = 0;
    for (let i = startIdx; i < route.length; i++) {
      c += route[i].ttEst + route[i].delayEMA;
      if (i > startIdx) c += this.turnCost(route[i - 1], route[i]);
    }
    return c;
  }

  freeFlowTime(route: Link[]): number {
    let t = 0;
    for (let i = 0; i < route.length; i++) {
      t += route[i].ttFree;
      if (i > 0) t += this.turnCost(route[i - 1], route[i]) * 0.5;
    }
    return t;
  }
}
