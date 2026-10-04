// Vehicles, vehicle types and driver personalities.

import { makePose } from '../core/path.ts';
import type { Pose } from '../core/path.ts';
import type { RNG } from '../core/rng.ts';
import type { Conn, Lane, Link, Seg } from './network.ts';

export type VKind = 'car' | 'taxi' | 'van' | 'truck' | 'bus' | 'ambulance' | 'police' | 'fire' | 'tow';

/** Render model ids (see render/vehicleModels.ts) */
export const MODEL = {
  sedan: 0,
  hatch: 1,
  suv: 2,
  van: 3,
  taxi: 4,
  truck: 5,
  bus: 6,
  ambulance: 7,
  police: 8,
  fire: 9,
  tow: 10,
  pickup: 11,
} as const;
export const MODEL_COUNT = 12;

export interface ModelSpec {
  len: number;
  width: number;
  a: number; // max acceleration
  b: number; // comfortable deceleration
  vmax: number;
}

export const MODEL_SPECS: ModelSpec[] = [
  { len: 4.6, width: 1.82, a: 1.7, b: 2.4, vmax: 45 }, // sedan
  { len: 4.0, width: 1.75, a: 1.6, b: 2.4, vmax: 42 }, // hatch
  { len: 4.85, width: 1.95, a: 1.5, b: 2.3, vmax: 45 }, // suv
  { len: 5.3, width: 2.0, a: 1.2, b: 2.1, vmax: 36 }, // van
  { len: 4.7, width: 1.82, a: 1.8, b: 2.5, vmax: 45 }, // taxi
  { len: 8.6, width: 2.45, a: 0.85, b: 1.8, vmax: 30 }, // truck
  { len: 12.0, width: 2.55, a: 0.9, b: 1.6, vmax: 25 }, // bus
  { len: 6.2, width: 2.2, a: 1.9, b: 2.8, vmax: 45 }, // ambulance
  { len: 4.9, width: 1.85, a: 2.1, b: 2.9, vmax: 50 }, // police
  { len: 10.0, width: 2.5, a: 1.1, b: 2.0, vmax: 33 }, // fire
  { len: 6.8, width: 2.3, a: 1.2, b: 2.2, vmax: 33 }, // tow
  { len: 5.3, width: 1.95, a: 1.5, b: 2.3, vmax: 42 }, // pickup
];

// realistic car paint distribution
const PAINT: [number, number][] = [
  [0xf2f2f0, 22],
  [0x15171a, 16],
  [0x8a8f96, 14],
  [0xc3c7cc, 12],
  [0x2a4f8f, 8],
  [0xa3191c, 8],
  [0x3f4a3a, 3],
  [0x6e1f2c, 3],
  [0xd0c3a5, 3],
  [0x1f6b8a, 3],
  [0xe07b1a, 2],
  [0x3b7a3a, 2],
  [0xe8c51e, 1],
  [0x4d3424, 2],
  [0x7aa6d6, 2],
];

export function randomPaint(rng: RNG): number {
  return rng.weighted(
    PAINT.map((p) => p[0]),
    PAINT.map((p) => p[1]),
  );
}

export interface Dest {
  link: Link;
  lane: number; // lane index to stop in (curb side)
  s: number; // stop position along that lane
  building: number;
  side: 1 | -1; // which side the curb is relative to travel (+1 right)
}

export type VState = 'drive' | 'pullout' | 'park' | 'crashed' | 'gone';

let VID = 1;

export class Vehicle {
  readonly id: number;
  kind: VKind;
  model: number;
  color: number;
  len: number;
  width: number;
  // driver
  aggr = 0.5;
  v0f = 1;
  T = 1.4;
  s0 = 2;
  a = 1.5;
  b = 2.2;
  polite = 0.3;
  gapT = 1.6;
  react = 0.7;
  aLatF = 1;
  boxBlock = false;
  redRun = false;
  nav = false;
  seed = 0;
  // kinematics
  seg!: Seg;
  s = 0;
  v = 0;
  acc = 0;
  accLead = 0; // acceleration ignoring stop lines (lane change incentive)
  prevSegs: Seg[] = [];
  // route
  route: Link[] = [];
  ri = 0;
  plan: Seg[] = [];
  planVer = -1;
  dest: Dest | null = null;
  exitAtGateway = false;
  // intersection state
  committed: Conn | null = null;
  holdLine = false;
  holdWhy = '';
  /** where a vehicle standing in a crossing ahead stops this one (inside a junction) */
  physStop = Infinity;
  physBy: Vehicle | null = null;
  /** who keeps this vehicle standing inside a junction: 1 = in a crossing ahead, 2 = car in front */
  blockedBy: Vehicle | null = null;
  blockKind = 0;
  /** gridlock breaker: briefly edge past these standing vehicles */
  squeezeT = 0;
  squeezePast: Set<Vehicle> | null = null;
  lastEvt = '';
  lastEvtT = 0;
  stopDone = false;
  stopDoneT = 0;
  waitT = 0; // time spent waiting at the current stop line
  approachWait = 0;
  startDelay = 0;
  stuckT = 0;
  // lane change
  lcCool = 0;
  lat = 0; // lateral visual offset (m, + = right)
  latV = 0;
  latTarget = 0;
  blink = 0; // -1 left, 1 right
  blinkT = 0;
  mandatoryLC = 0; // -1 / +1 desired direction when the current lane is invalid
  mergeWait = 0;
  // state
  state: VState = 'drive';
  stateT = 0;
  emergency = false;
  siren = false;
  pullOver = 0;
  bus: BusInfo | null = null;
  tow: TowInfo | null = null;
  // trip statistics
  spawnT = 0;
  ffTime = 0;
  dist = 0;
  waitTotal = 0;
  stops = 0;
  rerouteT = 0;
  mood = 0; // 0 calm .. 1 furious
  hornT = 0;
  hornFlash = 0;
  origin = -1;
  // render
  pose: Pose = makePose();
  x = 0;
  y = 0;
  hx = 1;
  hy = 0;
  brake = false;
  hazard = false;
  fade = 1;
  instance = -1;

  constructor(kind: VKind, model: number, color: number) {
    this.id = VID++;
    this.kind = kind;
    this.model = model;
    this.color = color;
    const spec = MODEL_SPECS[model];
    this.len = spec.len;
    this.width = spec.width;
    this.a = spec.a;
    this.b = spec.b;
  }

  get lane(): Lane | null {
    return this.seg.isLane ? (this.seg as Lane) : null;
  }

  get link(): Link | null {
    return this.route[this.ri] ?? null;
  }

  /** Assign a random driver personality. */
  personalise(rng: RNG, aggressionBias = 0): void {
    const ag = Math.min(1, Math.max(0, rng.normal(0.45 + aggressionBias, 0.2)));
    this.aggr = ag;
    this.seed = Math.floor(rng.next() * 1e9);
    this.v0f = 0.9 + ag * 0.2 + rng.normal(0, 0.03);
    this.T = Math.max(0.75, 1.5 - ag * 0.7 + rng.normal(0, 0.1));
    this.s0 = Math.max(1.2, 2.2 - ag * 0.8 + rng.normal(0, 0.15));
    this.a *= 0.85 + ag * 0.35;
    this.b *= 0.9 + ag * 0.3;
    this.polite = Math.max(0, 0.55 - ag * 0.5 + rng.normal(0, 0.1));
    this.gapT = Math.max(0.6, 2.3 - ag * 1.4 + rng.normal(0, 0.2));
    this.react = Math.max(0.3, 0.85 - ag * 0.45 + rng.normal(0, 0.1));
    this.aLatF = 0.9 + ag * 0.3;
    this.boxBlock = ag > 0.68 && rng.chance(0.55);
    this.redRun = ag > 0.75 && rng.chance(0.35);
    this.nav = rng.chance(0.5);
  }
}

export interface BusInfo {
  line: number;
  stops: { link: Link; s: number }[];
  nextStop: number;
  dwell: number;
  passengers: number;
}

export interface TowInfo {
  target: Vehicle[];
  phase: 'go' | 'work' | 'leave';
  t: number;
}

export function resetVehicleIds(): void {
  VID = 1;
}
