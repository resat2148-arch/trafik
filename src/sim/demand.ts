// Travel demand: time-of-day trip generation with a gravity model.
// Purposes: home->work, work->home, shopping, business, through traffic,
// inbound / outbound commuters and freight.

import { RNG } from '../core/rng.ts';
import { clamp, dist } from '../core/math.ts';
import type { Building, City } from '../world/citygen.ts';
import type { Link, Node } from './network.ts';
import type { Sim, SpawnReq } from './sim.ts';
import type { Dest, VKind } from './vehicle.ts';
import { MODEL } from './vehicle.ts';

type Purpose = 'hbw' | 'whb' | 'shop' | 'biz' | 'thru' | 'inc' | 'outc' | 'freight';

// hourly profiles 0..24 (relative intensity)
const PROFILES: Record<Purpose, number[]> = {
  //     0    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20   21   22   23   24
  hbw: [0.0, 0, 0, 0, 0.02, 0.1, 0.35, 0.85, 1.0, 0.55, 0.2, 0.1, 0.08, 0.08, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02, 0.02, 0.01, 0, 0, 0],
  whb: [0.0, 0, 0, 0, 0, 0.0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.15, 0.12, 0.1, 0.2, 0.55, 1.0, 0.9, 0.45, 0.2, 0.1, 0.05, 0.02, 0],
  shop: [0.0, 0, 0, 0, 0, 0.0, 0.05, 0.12, 0.2, 0.35, 0.55, 0.7, 0.8, 0.75, 0.65, 0.6, 0.7, 0.85, 0.9, 0.75, 0.5, 0.3, 0.12, 0.05, 0],
  biz: [0.0, 0, 0, 0, 0, 0.0, 0.05, 0.2, 0.45, 0.8, 1.0, 1.0, 0.8, 0.9, 1.0, 0.85, 0.6, 0.35, 0.15, 0.05, 0.02, 0, 0, 0, 0],
  thru: [0.1, 0.05, 0.05, 0.05, 0.1, 0.25, 0.5, 0.85, 1.0, 0.8, 0.6, 0.55, 0.6, 0.6, 0.6, 0.65, 0.85, 1.0, 0.9, 0.6, 0.45, 0.35, 0.25, 0.15, 0.1],
  inc: [0.0, 0, 0, 0, 0.02, 0.12, 0.4, 0.9, 1.0, 0.5, 0.2, 0.1, 0.1, 0.1, 0.08, 0.06, 0.05, 0.03, 0.02, 0.02, 0.01, 0, 0, 0, 0],
  outc: [0.0, 0, 0, 0, 0, 0.0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.12, 0.1, 0.1, 0.2, 0.6, 1.0, 0.85, 0.4, 0.15, 0.08, 0.04, 0.02, 0],
  freight: [0.05, 0.03, 0.03, 0.05, 0.15, 0.35, 0.6, 0.75, 0.8, 0.9, 1.0, 1.0, 0.9, 0.95, 1.0, 0.9, 0.7, 0.45, 0.25, 0.15, 0.1, 0.08, 0.06, 0.05, 0.05],
};

// trips per second at profile 1.0 and demand scale 1.0
const BASE_RATE: Record<Purpose, number> = {
  hbw: 1.05,
  whb: 1.1,
  shop: 0.32,
  biz: 0.22,
  thru: 0.3,
  inc: 0.38,
  outc: 0.4,
  freight: 0.11,
};

export function profileAt(p: Purpose, hour: number): number {
  const arr = PROFILES[p];
  const h = clamp(hour, 0, 23.999);
  const i = Math.floor(h);
  const t = h - i;
  return arr[i] * (1 - t) + arr[i + 1] * t;
}

/** total relative demand intensity at a given hour (for the HUD chart) */
export function intensityAt(hour: number): number {
  let s = 0;
  let tot = 0;
  for (const p of Object.keys(BASE_RATE) as Purpose[]) {
    s += BASE_RATE[p] * profileAt(p, hour);
    tot += BASE_RATE[p];
  }
  return s / tot;
}

class Sampler {
  items: Building[] = [];
  cum: number[] = [];
  total = 0;

  constructor(items: Building[], w: (b: Building) => number) {
    for (const b of items) {
      const x = w(b);
      if (x <= 0) continue;
      this.total += x;
      this.items.push(b);
      this.cum.push(this.total);
    }
  }

  sample(rng: RNG): Building | null {
    if (!this.items.length) return null;
    const r = rng.next() * this.total;
    let lo = 0;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] < r) lo = m + 1;
      else hi = m;
    }
    return this.items[lo];
  }
}

export interface DemandStats {
  generated: number;
  blocked: number; // trips that could not leave their driveway (queue full)
}

export class Demand {
  city: City;
  sim: Sim;
  rng: RNG;
  scale = 1;
  day = 1;
  private homes!: Sampler;
  private jobs!: Sampler;
  private shops!: Sampler;
  private freightO!: Sampler;
  private active: Building[] = [];
  private acc: Record<Purpose, number> = { hbw: 0, whb: 0, shop: 0, biz: 0, thru: 0, inc: 0, outc: 0, freight: 0 };
  entries: Link[] = [];
  exits: Link[] = [];
  private garages = new Map<number, SpawnReq[]>();
  private garageList: number[] = [];
  private busT: number[] = [];
  stats: DemandStats = { generated: 0, blocked: 0 };
  lambda = 400;
  /** extra events: stadium etc. */
  hotspot: { b: Building; until: number; rate: number } | null = null;

  constructor(city: City, sim: Sim, seed = 7) {
    this.city = city;
    this.sim = sim;
    this.rng = new RNG(seed);
    this.collectGateways();
    this.setDay(1);
    const rad = Math.max(city.bounds.maxx - city.bounds.minx, city.bounds.maxy - city.bounds.miny) / 2;
    this.lambda = rad * 0.9;
    this.busT = city.busLines.map((_, i) => 10 + i * 17);
  }

  collectGateways(): void {
    this.entries = [];
    this.exits = [];
    for (const g of this.city.gateways) {
      const arm = g.arms[0];
      if (!arm) continue;
      const out = arm.outLink; // leaves gateway into the city
      const inn = arm.inLink; // arrives at gateway
      if (out) this.entries.push(out);
      if (inn) this.exits.push(inn);
    }
  }

  setDay(day: number): void {
    this.day = day;
    this.active = this.city.buildings.filter((b) => b.day <= day && b.zone !== 'civic');
    this.homes = new Sampler(this.active, (b) => b.pop);
    this.jobs = new Sampler(this.active, (b) => b.jobs);
    this.shops = new Sampler(this.active, (b) => b.shop);
    this.freightO = new Sampler(this.active, (b) => (b.kind === 'industrial' ? b.jobs : 0));
  }

  update(dt: number, hour: number): void {
    const sc = this.scale * this.city.preset.demand;
    for (const p of Object.keys(BASE_RATE) as Purpose[]) {
      const rate = BASE_RATE[p] * profileAt(p, hour) * sc;
      this.acc[p] += rate * dt;
      let guard = 0;
      while (this.acc[p] >= 1 && guard++ < 20) {
        this.acc[p] -= 1;
        this.generate(p);
      }
      // stochastic remainder (Poisson-ish)
    }
    if (this.hotspot) {
      if (hour > this.hotspot.until) this.hotspot = null;
      else if (this.rng.chance(this.hotspot.rate * dt)) this.tripTo(this.hotspot.b);
    }
    this.processGarages();
    this.updateBuses(dt, hour);
  }

  private pickDest(sampler: Sampler, from: { x: number; y: number }): Building | null {
    // gravity: sample several candidates by attraction and weight by distance decay
    let best: Building | null = null;
    let bestW = -1;
    for (let k = 0; k < 6; k++) {
      const c = sampler.sample(this.rng);
      if (!c) continue;
      const d = dist(c, from);
      if (d < 120) continue;
      const w = Math.exp(-d / this.lambda) * (0.6 + this.rng.next());
      if (w > bestW) {
        bestW = w;
        best = c;
      }
    }
    return best;
  }

  private generate(p: Purpose): void {
    const rng = this.rng;
    switch (p) {
      case 'hbw': {
        const o = this.homes.sample(rng);
        if (!o) return;
        if (this.external > 0 && this.exits.length && rng.chance(this.external)) {
          // works outside the built-up area
          this.originTrip(o, null, this.nearestGateway(this.exits, o, false), this.commuteKind());
          return;
        }
        const d = this.pickDest(this.jobs, o);
        if (d) this.buildingTrip(o, d, this.commuteKind());
        return;
      }
      case 'whb': {
        if (this.external > 0 && this.entries.length && rng.chance(this.external)) {
          // coming home from work outside the built-up area
          const d = this.homes.sample(rng);
          const dest = d ? this.destFor(d) : null;
          if (!d || !dest) return;
          const kind = this.commuteKind();
          this.sim.queueGateway({ kind, model: this.sim.spawnModelFor(kind), link: this.nearestGateway(this.entries, d, true), dest, goal: dest.link });
          this.stats.generated++;
          return;
        }
        const o = this.jobs.sample(rng);
        if (!o) return;
        const d = this.pickDest(this.homes, o);
        if (d) this.buildingTrip(o, d, this.commuteKind());
        return;
      }
      case 'shop': {
        if (rng.chance(0.5)) {
          const o = this.homes.sample(rng);
          if (!o) return;
          const d = this.pickDest(this.shops, o);
          if (d) this.buildingTrip(o, d, this.commuteKind());
        } else {
          const o = this.shops.sample(rng);
          if (!o) return;
          const d = this.pickDest(this.homes, o);
          if (d) this.buildingTrip(o, d, this.commuteKind());
        }
        return;
      }
      case 'biz': {
        const o = this.jobs.sample(rng);
        if (!o) return;
        const d = this.pickDest(rng.chance(0.5) ? this.jobs : this.shops, o);
        if (d) this.buildingTrip(o, d, rng.chance(0.25) ? 'van' : rng.chance(0.15) ? 'taxi' : 'car');
        return;
      }
      case 'thru': {
        if (this.entries.length < 2) return;
        const a = this.pickGateway(this.entries);
        let b: Link | null = null;
        for (let k = 0; k < 5; k++) {
          const c = this.pickGateway(this.exits);
          if (c.road === a.road) continue;
          if (dist(c.to, a.from) < this.lambda * 0.8) continue;
          b = c;
          break;
        }
        if (!b) return;
        const kind: VKind = rng.chance(0.12) ? 'truck' : 'car';
        this.sim.queueGateway({ kind, model: this.sim.spawnModelFor(kind), link: a, dest: null, goal: b });
        this.stats.generated++;
        return;
      }
      case 'inc': {
        const d = this.jobs.sample(rng);
        if (!d || !this.entries.length) return;
        const a = this.nearestGateway(this.entries, d, true);
        const dest = this.destFor(d);
        if (!dest) return;
        const kind = this.commuteKind();
        this.sim.queueGateway({ kind, model: this.sim.spawnModelFor(kind), link: a, dest, goal: dest.link });
        this.stats.generated++;
        return;
      }
      case 'outc': {
        const o = this.jobs.sample(rng);
        if (!o || !this.exits.length) return;
        const b = this.nearestGateway(this.exits, o, false);
        this.originTrip(o, null, b, this.commuteKind());
        return;
      }
      case 'freight': {
        const o = this.freightO.sample(rng) ?? this.jobs.sample(rng);
        if (!o) return;
        if (rng.chance(0.4) && this.exits.length) {
          this.originTrip(o, null, rng.pick(this.exits), 'truck');
        } else {
          const d = this.pickDest(this.shops, o);
          if (d) this.buildingTrip(o, d, rng.chance(0.6) ? 'truck' : 'van');
        }
        return;
      }
    }
  }

  private nearestGateway(list: Link[], b: Building, entering: boolean): Link {
    // choose by distance with randomness
    let best = list[0];
    let bw = -1;
    for (const l of list) {
      const g: Node = entering ? l.from : l.to;
      const w = Math.exp(-dist(g, b) / (this.lambda * 1.2)) * (0.5 + this.rng.next()) * this.gatewayWeight(l);
      if (w > bw) {
        bw = w;
        best = l;
      }
    }
    return best;
  }

  /** growing city: share of residents' commutes that leave the built-up area */
  get external(): number {
    return this.city.growth?.external ?? 0;
  }

  /** growing city: through traffic and commuters favour the main roads out of town */
  private gatewayWeight(l: Link): number {
    if (!this.city.growth) return 1;
    const c = l.road.cls;
    return c === 'local' ? 0.3 : c === 'avenue' ? 1 : 1.5;
  }

  private pickGateway(list: Link[]): Link {
    if (!this.city.growth) return this.rng.pick(list);
    let tot = 0;
    for (const l of list) tot += this.gatewayWeight(l);
    let r = this.rng.next() * tot;
    for (const l of list) {
      r -= this.gatewayWeight(l);
      if (r <= 0) return l;
    }
    return list[list.length - 1];
  }

  private commuteKind(): VKind {
    const r = this.rng.next();
    return r < 0.88 ? 'car' : r < 0.93 ? 'taxi' : r < 0.98 ? 'van' : 'truck';
  }

  /** destination descriptor for a building */
  destFor(b: Building): Dest | null {
    const r = b.road;
    let link: Link;
    let side: 1 | -1;
    let lane: number;
    if (b.side === 1) {
      if (r.lanesAB > 0) {
        link = r.ab;
        side = 1;
        lane = 0;
      } else {
        link = r.ba;
        side = -1;
        lane = r.ba.lanes.length - 1;
      }
    } else if (r.lanesBA > 0) {
      link = r.ba;
      side = 1;
      lane = 0;
    } else {
      link = r.ab;
      side = -1;
      lane = r.ab.lanes.length - 1;
    }
    if (!link.lanes.length) return null;
    const L = link.lanes[0].len;
    if (L < 16) return null;
    let s = link.forward ? b.s - r.armA.trim : r.length - b.s - r.armB.trim;
    s = L > 46 ? clamp(s, 18, L - 10) : clamp(s, Math.min(10, L * 0.4), L - 6);
    return { link, lane, s, building: b.id, side };
  }

  private buildingTrip(o: Building, d: Building, kind: VKind): void {
    const dest = this.destFor(d);
    if (!dest) return;
    this.originTrip(o, dest, dest.link, kind);
  }

  private tripTo(d: Building): void {
    const o = this.homes.sample(this.rng);
    if (!o) return;
    this.buildingTrip(o, d, 'car');
  }

  private originTrip(o: Building, dest: Dest | null, goal: Link, kind: VKind): void {
    const od = this.destFor(o);
    if (!od) return;
    if (dest && od.link === dest.link && Math.abs(od.s - dest.s) < 80) return;
    const req: SpawnReq = {
      kind,
      model: this.sim.spawnModelFor(kind),
      link: od.link,
      s: od.s,
      side: od.side,
      dest,
      goal,
      origin: o.id,
    };
    let q = this.garages.get(o.id);
    if (!q) {
      this.garages.set(o.id, (q = []));
      this.garageList.push(o.id);
    }
    // parking garages of big buildings can hold more departing cars
    const cap = 4 + Math.floor((o.jobs + o.pop) / 30);
    if (q.length >= cap) {
      this.stats.blocked++;
      return;
    }
    q.push(req);
    this.stats.generated++;
  }

  private processGarages(): void {
    if (!this.garageList.length) return;
    const keep: number[] = [];
    for (const id of this.garageList) {
      const q = this.garages.get(id);
      if (!q || !q.length) {
        this.garages.delete(id);
        continue;
      }
      const v = this.sim.trySpawn(q[0]);
      if (v) q.shift();
      else {
        // unreachable or no gap: keep waiting (drop if it looks impossible)
        const r = q[0];
        if (!r.link.lanes.length) q.shift();
      }
      if (q.length) keep.push(id);
      else this.garages.delete(id);
    }
    this.garageList = keep;
  }

  waitingAtHome(): number {
    let n = 0;
    for (const q of this.garages.values()) n += q.length;
    return n;
  }

  private updateBuses(dt: number, hour: number): void {
    const lines = this.city.busLines;
    if (hour < 5.5 || hour > 23) return;
    for (let i = 0; i < lines.length; i++) {
      this.busT[i] -= dt;
      if (this.busT[i] > 0) continue;
      const line = lines[i];
      const hw = line.headway * (hour > 7 && hour < 9.5 ? 0.75 : hour > 16 && hour < 19 ? 0.75 : 1.1);
      this.busT[i] = hw;
      const v = this.sim.trySpawn({
        kind: 'bus',
        model: MODEL.bus,
        color: line.color,
        link: line.links[0],
        dest: null,
        goal: line.links[line.links.length - 1],
        route: line.links,
      });
      if (v) {
        v.bus = { line: line.id, stops: line.stops.slice(), nextStop: 0, dwell: 0, passengers: 0 };
        v.nav = false;
        v.boxBlock = false;
        v.redRun = false;
      } else this.busT[i] = 4;
    }
  }

  clear(): void {
    this.garages.clear();
    this.garageList = [];
    for (const k of Object.keys(this.acc) as Purpose[]) this.acc[k] = 0;
  }
}
