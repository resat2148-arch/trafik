// Road network model.
//
//  Node   – junction (or off-map gateway).  Owns the internal connectors.
//  Road   – physical street between two nodes with a fixed curb-to-curb width.
//  Link   – one travel direction of a road (routing graph edge).
//  Lane   – a lane of a link between the two stop lines.
//  Conn   – internal path through a junction (turning movement, roundabout
//           ring segment, roundabout entry/exit).
//
// Lanes and connectors share the `Seg` base so vehicles can move through any
// sequence of them with a single longitudinal coordinate `s`.

import { Path } from '../core/path.ts';
import type { V2 } from '../core/math.ts';
import { angleOf, clamp, lineIntersect, normAngle, posAngle, right } from '../core/math.ts';
import type { Vehicle } from './vehicle.ts';
import type { SignalCtrl } from './signals.ts';

export const SIG_R = 0;
export const SIG_Y = 1;
export const SIG_P = 2; // permissive green (yield to conflicting traffic)
export const SIG_G = 3; // protected green
export const SIG_NONE = 4;

export const ARROW_L = 1;
export const ARROW_S = 2;
export const ARROW_R = 4;
export const ARROW_U = 8;

export type Turn = 'L' | 'S' | 'R' | 'U';
export const turnBit = (t: Turn): number => (t === 'L' ? ARROW_L : t === 'S' ? ARROW_S : t === 'R' ? ARROW_R : ARROW_U);
export const turnRank = (t: Turn): number => (t === 'S' ? 3 : t === 'R' ? 2 : t === 'L' ? 1 : 0);

export type Control = 'none' | 'priority' | 'allstop' | 'signal' | 'roundabout';
export type RoadClass = 'local' | 'avenue' | 'boulevard';

export interface RoadSpec {
  width: number; // curb to curb incl. median
  median: number;
  sidewalk: number;
  lanesAB: number;
  lanesBA: number;
  speed: number; // m/s
  maxLanes: number;
  corner: number; // curb corner radius at junctions
}

export const ROAD_SPECS: Record<RoadClass, RoadSpec> = {
  local: { width: 7.0, median: 0, sidewalk: 3.0, lanesAB: 1, lanesBA: 1, speed: 40 / 3.6, maxLanes: 2, corner: 6 },
  avenue: { width: 14.0, median: 0, sidewalk: 3.5, lanesAB: 2, lanesBA: 2, speed: 50 / 3.6, maxLanes: 4, corner: 8 },
  boulevard: { width: 23.0, median: 3.5, sidewalk: 4.0, lanesAB: 3, lanesBA: 3, speed: 60 / 3.6, maxLanes: 6, corner: 9 },
};

export const CROSSWALK_W = 3.0;

export interface Obstacle {
  s: number; // front position (like a vehicle)
  len: number;
  kind: 'accident' | 'works' | 'stall';
  id: number;
}

let SEG_ID = 1;

export class Seg {
  readonly id: number;
  readonly isLane: boolean;
  path: Path;
  len: number;
  vehs: Vehicle[] = []; // sorted ascending by s (index 0 = most upstream)
  vmax: number;
  outs: Seg[] = [];
  ins: Seg[] = [];
  /** segments that start at the same point (diverging paths) */
  siblings: Seg[] = [];
  obstacles: Obstacle[] = [];

  constructor(isLane: boolean, path: Path, vmax: number) {
    this.id = SEG_ID++;
    this.isLane = isLane;
    this.path = path;
    this.len = path.length;
    this.vmax = vmax;
  }

  /** Index of the first vehicle (lowest s >= given s). */
  insertIndex(s: number): number {
    const v = this.vehs;
    let i = 0;
    while (i < v.length && v[i].s < s) i++;
    return i;
  }

  addVehicle(veh: Vehicle): void {
    const i = this.insertIndex(veh.s);
    this.vehs.splice(i, 0, veh);
  }

  removeVehicle(veh: Vehicle): void {
    const i = this.vehs.indexOf(veh);
    if (i >= 0) this.vehs.splice(i, 1);
  }

  /** keep vehicles sorted (insertion sort - almost always sorted already) */
  resort(): void {
    const v = this.vehs;
    for (let i = 1; i < v.length; i++) {
      const x = v[i];
      let j = i - 1;
      while (j >= 0 && v[j].s > x.s) {
        v[j + 1] = v[j];
        j--;
      }
      v[j + 1] = x;
    }
  }
}

export class Lane extends Seg {
  link: Link;
  index: number; // 0 = curb lane
  width: number;
  offset: number; // lateral offset from road centre line (relative to road a->b, + = right)
  arrows = 0;
  busOnly = false;
  left: Lane | null = null; // towards centre
  right: Lane | null = null; // towards curb
  /** target link id -> internal path [conn..., targetLane] */
  moves = new Map<number, Seg[]>();
  // statistics (updated by sim)
  queue = 0;

  constructor(link: Link, index: number, path: Path, width: number, offset: number) {
    super(true, path, link.road.speed);
    this.link = link;
    this.index = index;
    this.width = width;
    this.offset = offset;
  }
}

export interface Conflict {
  other: Conn;
  sIn: number;
  sOut: number;
  oIn: number;
  oOut: number;
  merge: boolean;
}

export type ConnKind = 'move' | 'entry' | 'ring' | 'exit' | 'uturn';

export class Conn extends Seg {
  node: Node;
  kind: ConnKind;
  turn: Turn = 'S';
  rank = 3;
  conflicts: Conflict[] = [];
  sig = SIG_NONE;
  /** heading of travel when entering (used by right-before-left rule) */
  inHeading = 0;
  fromLane: Lane | null = null;
  toLane: Lane | null = null;
  inArm: Arm | null = null;
  outArm: Arm | null = null;
  dead = false;
  /** vehicles that committed to entering (approaching with intent) */
  laneIndex = 0;
  /** box-junction counter of vehicles inside heading to toLane */
  constructor(node: Node, kind: ConnKind, path: Path, vmax: number) {
    super(false, path, vmax);
    this.node = node;
    this.kind = kind;
  }
}

export class Arm {
  node: Node;
  road: Road;
  atA: boolean;
  dir: V2 = { x: 1, y: 0 }; // unit vector pointing away from node along road
  angle = 0;
  hw = 3.5;
  trim = 0; // stop line distance from node centre (along the road)
  tangent = 0; // max fillet tangent distance (curb becomes straight after this)
  index = 0;

  constructor(node: Node, road: Road, atA: boolean) {
    this.node = node;
    this.road = road;
    this.atA = atA;
  }

  /** link arriving at the node through this arm */
  get inLink(): Link | null {
    const l = this.atA ? this.road.ba : this.road.ab;
    return l.lanes.length ? l : null;
  }

  /** link leaving the node through this arm */
  get outLink(): Link | null {
    const l = this.atA ? this.road.ab : this.road.ba;
    return l.lanes.length ? l : null;
  }

  get other(): Node {
    return this.atA ? this.road.b : this.road.a;
  }
}

export interface Corner {
  armA: Arm; // arm i
  armB: Arm; // arm i+1 (counter-clockwise in angle order)
  kind: 'fillet' | 'straight' | 'reflex';
  // fillet data
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  t1: V2; // tangent point on arm A curb
  t2: V2; // tangent point on arm B curb
  tA: number; // distance along arm A of tangent point
  tB: number;
}

export interface RoundaboutGeom {
  ro: number; // outer asphalt radius
  rr: number; // ring centre line radius
  ri: number; // island radius (incl. apron)
  laneW: number;
}

export class Node {
  id: number;
  x: number;
  y: number;
  arms: Arm[] = [];
  corners: Corner[] = [];
  control: Control = 'priority';
  stopMinor = true; // stop signs (true) or yield signs (false) on minor approaches
  majorRoads = new Set<number>();
  box = false; // yellow box junction (no blocking)
  rtor = false; // right turn on red
  signal: SignalCtrl | null = null;
  conns: Conn[] = [];
  dying: Conn[] = [];
  gateway = false;
  ra: RoundaboutGeom | null = null;
  name = '';
  /** all-way stop queue: vehicles that completed their stop, in arrival order */
  stopQueue: Vehicle[] = [];
  // statistics
  delaySum = 0;
  delayN = 0;
  delayEMA = 0;
  passed = 0;
  // set by builder
  maxRoundaboutR = 0;
  version = 0;

  constructor(id: number, x: number, y: number) {
    this.id = id;
    this.x = x;
    this.y = y;
  }

  get degree(): number {
    return this.arms.length;
  }

  armFor(road: Road): Arm | undefined {
    return this.arms.find((a) => a.road === road);
  }

  inLinks(): Link[] {
    const out: Link[] = [];
    for (const a of this.arms) {
      const l = a.inLink;
      if (l) out.push(l);
    }
    return out;
  }
}

export class Link {
  id: number;
  road: Road;
  forward: boolean; // a -> b
  lanes: Lane[] = [];
  /** allowed next links for routing (derived from junction moves) */
  nexts: Link[] = [];
  closed = false;
  // routing statistics
  speedEMA = 0;
  ttFree = 1;
  ttEst = 1;
  count = 0; // vehicles currently on link
  flowCount = 0;
  delayEMA = 0; // average control delay at the downstream junction (s)
  stopped = 0; // vehicles currently stopped / queued on the link

  constructor(id: number, road: Road, forward: boolean) {
    this.id = id;
    this.road = road;
    this.forward = forward;
  }

  get from(): Node {
    return this.forward ? this.road.a : this.road.b;
  }

  get to(): Node {
    return this.forward ? this.road.b : this.road.a;
  }

  get toArm(): Arm {
    return this.forward ? this.road.armB : this.road.armA;
  }

  get fromArm(): Arm {
    return this.forward ? this.road.armA : this.road.armB;
  }

  get reverse(): Link {
    return this.forward ? this.road.ba : this.road.ab;
  }

  get length(): number {
    return this.lanes.length ? this.lanes[0].len : this.road.length;
  }
}

export class Road {
  id: number;
  a: Node;
  b: Node;
  cls: RoadClass;
  name = '';
  width: number;
  median: number;
  sidewalk: number;
  maxLanes: number;
  lanesAB: number;
  lanesBA: number;
  speed: number;
  busAB = false;
  busBA = false;
  bridge = false;
  center: Path;
  length: number;
  armA!: Arm;
  armB!: Arm;
  ab: Link;
  ba: Link;
  /** default configuration for "reset" */
  version = 0;

  constructor(id: number, a: Node, b: Node, cls: RoadClass, linkIdBase: number, pts?: V2[]) {
    this.id = id;
    this.a = a;
    this.b = b;
    this.cls = cls;
    const spec = ROAD_SPECS[cls];
    this.width = spec.width;
    this.median = spec.median;
    this.sidewalk = spec.sidewalk;
    this.maxLanes = spec.maxLanes;
    this.lanesAB = spec.lanesAB;
    this.lanesBA = spec.lanesBA;
    this.speed = spec.speed;
    this.center = new Path(pts ?? [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ]);
    this.length = this.center.length;
    this.ab = new Link(linkIdBase, this, true);
    this.ba = new Link(linkIdBase + 1, this, false);
  }

  get oneWay(): boolean {
    return this.lanesAB === 0 || this.lanesBA === 0;
  }

  get trimmedLength(): number {
    return Math.max(1, this.length - this.armA.trim - this.armB.trim);
  }
}

// ---------------------------------------------------------------------------
// Network container & geometry construction
// ---------------------------------------------------------------------------

export class Network {
  nodes: Node[] = [];
  roads: Road[] = [];
  links: Link[] = [];
  /** incremented whenever the topology / lane layout changes (routing caches) */
  version = 0;

  addNode(x: number, y: number): Node {
    const n = new Node(this.nodes.length, x, y);
    this.nodes.push(n);
    return n;
  }

  addRoad(a: Node, b: Node, cls: RoadClass, pts?: V2[]): Road {
    const r = new Road(this.roads.length, a, b, cls, this.links.length, pts);
    this.roads.push(r);
    this.links.push(r.ab, r.ba);
    return r;
  }

  /** Builds arms, junction geometry (trims, corners) and lanes. Junction internals are built separately. */
  buildGeometry(): void {
    for (const n of this.nodes) n.arms = [];
    for (const r of this.roads) {
      r.armA = new Arm(r.a, r, true);
      r.armB = new Arm(r.b, r, false);
      r.a.arms.push(r.armA);
      r.b.arms.push(r.armB);
    }
    for (const n of this.nodes) {
      for (const arm of n.arms) {
        const p = arm.road.center;
        const d = arm.atA ? p.startDir() : (() => {
          const e = p.endDir();
          return { x: -e.x, y: -e.y };
        })();
        arm.dir = d;
        arm.angle = posAngle(angleOf(d));
        arm.hw = arm.road.width / 2;
      }
      n.arms.sort((a, b) => a.angle - b.angle);
      n.arms.forEach((a, i) => (a.index = i));
      n.gateway = n.gateway || n.arms.length === 1;
      computeCorners(n);
    }
    for (const r of this.roads) buildLanes(r);
    this.version++;
  }
}

/**
 * Corner (curb fillet) between consecutive arms and the resulting stop-line trims.
 */
export function computeCorners(n: Node): void {
  n.corners = [];
  const k = n.arms.length;
  for (const a of n.arms) {
    a.tangent = 0;
    a.trim = 0;
  }
  if (k === 0) return;
  if (k === 1) {
    // gateway / dead end: lanes run to the node
    n.arms[0].trim = 0;
    return;
  }
  for (let i = 0; i < k; i++) {
    const A = n.arms[i];
    const B = n.arms[(i + 1) % k];
    let alpha = B.angle - A.angle;
    if (k === 1) alpha = Math.PI * 2;
    if (alpha <= 0) alpha += Math.PI * 2;
    const rA = right(A.dir); // points towards increasing angle -> towards B
    const rB = right(B.dir);
    const pA = { x: n.x + rA.x * A.hw, y: n.y + rA.y * A.hw };
    const pB = { x: n.x - rB.x * B.hw, y: n.y - rB.y * B.hw };
    const rc = Math.max(ROAD_SPECS[A.road.cls].corner, ROAD_SPECS[B.road.cls].corner);
    const corner: Corner = {
      armA: A,
      armB: B,
      kind: 'straight',
      cx: 0,
      cy: 0,
      r: 0,
      a0: 0,
      a1: 0,
      t1: pA,
      t2: pB,
      tA: 0,
      tB: 0,
    };
    if (alpha < Math.PI - 0.3) {
      const hit = lineIntersect(pA, A.dir, pB, B.dir);
      if (hit && hit.t > -50 && hit.u > -50) {
        const beta = alpha / 2;
        const dT = rc / Math.tan(beta);
        const tA = hit.t + dT;
        const tB = hit.u + dT;
        const t1 = { x: pA.x + A.dir.x * tA, y: pA.y + A.dir.y * tA };
        const t2 = { x: pB.x + B.dir.x * tB, y: pB.y + B.dir.y * tB };
        // fillet centre: offset from tangent point t1 by rc towards B side (rA)
        const cx = t1.x + rA.x * rc;
        const cy = t1.y + rA.y * rc;
        corner.kind = 'fillet';
        corner.cx = cx;
        corner.cy = cy;
        corner.r = rc;
        corner.a0 = Math.atan2(t1.y - cy, t1.x - cx);
        corner.a1 = Math.atan2(t2.y - cy, t2.x - cx);
        corner.t1 = t1;
        corner.t2 = t2;
        corner.tA = tA;
        corner.tB = tB;
        A.tangent = Math.max(A.tangent, tA);
        B.tangent = Math.max(B.tangent, tB);
      }
    } else if (alpha > Math.PI + 0.3) {
      corner.kind = 'reflex';
    }
    n.corners.push(corner);
  }
  const isJunction = k >= 3;
  for (const a of n.arms) {
    let t = Math.max(a.tangent, a.hw * 0.6) + 0.5;
    if (isJunction) t += CROSSWALK_W + 1.2;
    else t = Math.max(t, 2);
    a.trim = t;
  }
  // roundabout outer radius available: keep a margin before the stop lines
  let minTrim = Infinity;
  for (const a of n.arms) minTrim = Math.min(minTrim, a.trim);
  n.maxRoundaboutR = isJunction ? minTrim - 1.0 : 0;
}

/** width of one lane slot of a road (its class' standard lane width) */
export function laneWidthOf(r: Road): number {
  const s = ROAD_SPECS[r.cls];
  return (s.width - s.median) / s.maxLanes;
}

/** the widest a road may be built: two lane slots more than its class standard */
export function maxSlotsOf(r: Road): number {
  return ROAD_SPECS[r.cls].maxLanes + 2;
}

/** lane slots needed to carry the given lane counts (divided roads keep both halves equal) */
export function slotsFor(r: Road, ab: number, ba: number): number {
  return r.median > 0 ? 2 * Math.max(ab, ba) : ab + ba;
}

/** Change the physical width of a road to a number of lane slots. Corners and lanes are rebuilt by the caller. */
export function setRoadSlots(r: Road, slots: number): void {
  r.maxLanes = slots;
  r.width = r.median + slots * laneWidthOf(r);
  if (r.armA) r.armA.hw = r.width / 2;
  if (r.armB) r.armB.hw = r.width / 2;
}

/** (Re)build lanes for both directions of a road from its current lane configuration. */
export function buildLanes(r: Road): void {
  const nTot = r.lanesAB + r.lanesBA;
  const usable = r.width - r.median;
  // a median splits the carriageway in two halves: lanes of each direction share their own half
  const w = r.median > 0 ? usable / 2 / Math.max(1, r.lanesAB, r.lanesBA) : nTot > 0 ? usable / nTot : usable;
  const s0 = r.armA.trim;
  const s1 = r.length - r.armB.trim;
  const base = r.center.sub(s0, Math.max(s0 + 1, s1));
  for (const link of [r.ab, r.ba]) {
    const n = link.forward ? r.lanesAB : r.lanesBA;
    link.lanes = [];
    for (let i = 0; i < n; i++) {
      // AB lanes lie on the right side of the a->b direction
      let off: number;
      if (link.forward) {
        off = r.width / 2 - (i + 0.5) * w;
        if (r.median > 0 && r.lanesBA > 0) off = Math.max(off, r.median / 2 + 0.5 * w);
      } else {
        off = -(r.width / 2 - (i + 0.5) * w);
        if (r.median > 0 && r.lanesAB > 0) off = Math.min(off, -(r.median / 2 + 0.5 * w));
      }
      // undivided asymmetric layouts: lanes are packed from each curb
      let path = base.offset(off);
      if (!link.forward) path = path.reversed();
      const lane = new Lane(link, i, path, w, off);
      lane.busOnly = (link.forward ? r.busAB : r.busBA) && i === 0 && n > 1;
      link.lanes.push(lane);
    }
    for (let i = 0; i < link.lanes.length; i++) {
      link.lanes[i].right = i > 0 ? link.lanes[i - 1] : null;
      link.lanes[i].left = i < link.lanes.length - 1 ? link.lanes[i + 1] : null;
    }
    link.ttFree = (s1 - s0) / Math.max(3, r.speed * 0.9);
    link.ttEst = link.ttFree;
    link.speedEMA = r.speed;
  }
}

/** Classify a turn from incoming travel heading to outgoing heading. */
export function classifyTurn(inHeading: number, outHeading: number): Turn {
  const d = normAngle(outHeading - inHeading);
  if (Math.abs(d) < 0.55) return 'S';
  if (Math.abs(d) > 2.55) return 'U';
  return d < 0 ? 'L' : 'R';
}

export function relTurnAngle(inHeading: number, outHeading: number): number {
  return normAngle(outHeading - inHeading);
}

export const kmh = (ms: number): number => Math.round(ms * 3.6);

export function clampLaneCounts(r: Road, ab: number, ba: number): [number, number] {
  ab = clamp(Math.round(ab), 0, r.maxLanes);
  ba = clamp(Math.round(ba), 0, r.maxLanes);
  if (r.median > 0) {
    const half = Math.floor(r.maxLanes / 2);
    ab = clamp(ab, 1, half);
    ba = clamp(ba, 1, half);
  }
  while (ab + ba > r.maxLanes) {
    if (ab >= ba) ab--;
    else ba--;
  }
  if (ab + ba === 0) ab = 1;
  return [ab, ba];
}
