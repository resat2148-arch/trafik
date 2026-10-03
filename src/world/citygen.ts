// Procedural city generator.
//
// Produces a slightly irregular grid city with avenues / a boulevard, an
// optional river crossed by a few bridges (natural bottlenecks), off-map
// gateways for through traffic, zoned blocks with buildings and bus lines.

import type { V2 } from '../core/math.ts';
import { clamp, dist, obbCorners, obbOverlap, pointInPolygon, polygonCentroid, right } from '../core/math.ts';
import type { OBB } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import { arcPoints, clipHalfPlane, offsetClosed, signedArea, simplifyClosed } from '../core/geom.ts';
import { Network, ROAD_SPECS } from '../sim/network.ts';
import type { Arm, Link, Node, Road, RoadClass } from '../sim/network.ts';
import { buildJunction, stronglyConnected, updateLinkNexts } from '../sim/junction.ts';

export type Zone = 'res' | 'com' | 'off' | 'ind' | 'park' | 'civic' | 'water';
export type BKind =
  | 'house'
  | 'apartment'
  | 'shop'
  | 'office'
  | 'tower'
  | 'industrial'
  | 'hospital'
  | 'fire'
  | 'police'
  | 'school';

export interface Building {
  id: number;
  x: number;
  y: number;
  w: number; // along frontage
  d: number; // depth
  ux: number; // frontage direction
  uy: number;
  h: number;
  floors: number;
  kind: BKind;
  zone: Zone;
  pop: number;
  jobs: number;
  shop: number;
  road: Road;
  side: 1 | -1; // side of the road relative to a->b
  s: number; // position along road centre line
  color: number;
  style: number;
  roof: 'flat' | 'gable';
  day: number;
  block: number;
  tier: number; // 0..1 random for variation
}

export interface Block {
  id: number;
  curb: V2[];
  lot: V2[];
  zone: Zone;
  water: boolean;
  park: boolean;
  plaza: boolean;
  nodes: Node[];
  roads: Road[];
  centroid: V2;
  area: number;
  trees: V2[];
  parking: OBB[];
}

export interface River {
  yTop: number;
  yBot: number;
}

export interface BusLine {
  id: number;
  name: string;
  color: number;
  links: Link[];
  stops: { link: Link; s: number }[];
  headway: number;
}

export interface CityPreset {
  id: string;
  name: { en: string; tr: string };
  seed: number;
  cols: number;
  rows: number;
  blockMin: number;
  blockMax: number;
  avenueCols: number[];
  avenueRows: number[];
  boulevardCol: number;
  boulevardRow: number;
  river: { afterRow: number; width: number; bridges: number[] } | null;
  removeFrac: number;
  jitter: number;
  extraGateways: number;
  oneWays: boolean;
  downtown: number; // 0..1 downtown radius factor
  industrial: 'ne' | 'nw' | 'se' | 'sw' | 'none';
  days: number;
  demand: number; // base demand multiplier
  growth: number; // per-day demand growth
  startMoney: number;
  tutorialNode?: [number, number];
}

export interface City {
  preset: CityPreset;
  net: Network;
  buildings: Building[];
  blocks: Block[];
  river: River | null;
  bounds: { minx: number; miny: number; maxx: number; maxy: number };
  center: V2;
  gateways: Node[];
  busLines: BusLine[];
  hospital: Building | null;
  fireStation: Building | null;
  police: Building | null;
  tutorialNode: Node | null;
  grid: (Node | null)[][];
}

const STREET_NAMES = [
  'Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Birch', 'Willow', 'Ash', 'Cherry', 'Walnut', 'Linden', 'Poplar',
  'Hill', 'Lake', 'River', 'Park', 'Market', 'Church', 'Mill', 'Station', 'Harbor', 'Garden', 'Spring', 'Sunset',
];
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

export const PRESETS: CityPreset[] = [
  {
    id: 'maple',
    name: { en: 'Maple Valley', tr: 'Akçaağaç Vadisi' },
    seed: 1207,
    cols: 5,
    rows: 5,
    blockMin: 82,
    blockMax: 104,
    avenueCols: [2],
    avenueRows: [2],
    boulevardCol: -1,
    boulevardRow: -1,
    river: null,
    removeFrac: 0.12,
    jitter: 3.5,
    extraGateways: 2,
    oneWays: false,
    downtown: 0.35,
    industrial: 'se',
    days: 5,
    demand: 0.8,
    growth: 0.14,
    startMoney: 15000,
    tutorialNode: [2, 2],
  },
  {
    id: 'riverside',
    name: { en: 'Riverside', tr: 'Nehirkent' },
    seed: 4242,
    cols: 6,
    rows: 6,
    blockMin: 80,
    blockMax: 108,
    avenueCols: [1, 4],
    avenueRows: [1],
    boulevardCol: -1,
    boulevardRow: 4,
    river: { afterRow: 2, width: 46, bridges: [1, 3, 4] },
    removeFrac: 0.1,
    jitter: 4,
    extraGateways: 3,
    oneWays: false,
    downtown: 0.38,
    industrial: 'sw',
    days: 7,
    demand: 0.95,
    growth: 0.13,
    startMoney: 22000,
  },
  {
    id: 'downtown',
    name: { en: 'Downtown Heights', tr: 'Merkez Tepeler' },
    seed: 9001,
    cols: 7,
    rows: 7,
    blockMin: 74,
    blockMax: 96,
    avenueCols: [1, 5],
    avenueRows: [1, 5],
    boulevardCol: 3,
    boulevardRow: 3,
    river: null,
    removeFrac: 0.06,
    jitter: 2.5,
    extraGateways: 4,
    oneWays: true,
    downtown: 0.5,
    industrial: 'ne',
    days: 8,
    demand: 1.1,
    growth: 0.12,
    startMoney: 30000,
  },
  {
    id: 'metro',
    name: { en: 'Metropolis Bay', tr: 'Metropol Körfezi' },
    seed: 31337,
    cols: 8,
    rows: 8,
    blockMin: 76,
    blockMax: 100,
    avenueCols: [1, 6],
    avenueRows: [1, 6],
    boulevardCol: 3,
    boulevardRow: -1,
    river: { afterRow: 3, width: 54, bridges: [1, 3, 5, 6] },
    removeFrac: 0.08,
    jitter: 3.5,
    extraGateways: 5,
    oneWays: true,
    downtown: 0.45,
    industrial: 'sw',
    days: 10,
    demand: 1.2,
    growth: 0.12,
    startMoney: 40000,
  },
];

// ---------------------------------------------------------------------------

export function generateCity(preset: CityPreset): City {
  const rng = new RNG(preset.seed);
  const net = new Network();
  const { cols, rows } = preset;
  const lineClassCol = (i: number): RoadClass =>
    i === preset.boulevardCol ? 'boulevard' : preset.avenueCols.includes(i) ? 'avenue' : 'local';
  const lineClassRow = (j: number): RoadClass =>
    j === preset.boulevardRow ? 'boulevard' : preset.avenueRows.includes(j) ? 'avenue' : 'local';

  // grid line positions
  const xs: number[] = [0];
  for (let i = 1; i < cols; i++) xs.push(xs[i - 1] + rng.range(preset.blockMin, preset.blockMax));
  const ys: number[] = [0];
  let river: River | null = null;
  for (let j = 1; j < rows; j++) {
    let step = rng.range(preset.blockMin, preset.blockMax);
    if (preset.river && j === preset.river.afterRow + 1) {
      const hwA = ROAD_SPECS[lineClassRow(j - 1)].width / 2 + ROAD_SPECS[lineClassRow(j - 1)].sidewalk;
      const hwB = ROAD_SPECS[lineClassRow(j)].width / 2 + ROAD_SPECS[lineClassRow(j)].sidewalk;
      step = hwA + 7 + preset.river.width + 7 + hwB;
      river = { yTop: ys[j - 1] + hwA + 7, yBot: ys[j - 1] + hwA + 7 + preset.river.width };
    }
    ys.push(ys[j - 1] + step);
  }
  const cx = (xs[0] + xs[cols - 1]) / 2;
  const cy = (ys[0] + ys[rows - 1]) / 2;
  for (let i = 0; i < cols; i++) xs[i] -= cx;
  for (let j = 0; j < rows; j++) ys[j] -= cy;
  if (river) {
    river.yTop -= cy;
    river.yBot -= cy;
  }

  // nodes
  const grid: (Node | null)[][] = [];
  for (let i = 0; i < cols; i++) {
    grid.push([]);
    for (let j = 0; j < rows; j++) {
      const colMajor = lineClassCol(i) !== 'local';
      const rowMajor = lineClassRow(j) !== 'local';
      const nearRiver = preset.river && (j === preset.river.afterRow || j === preset.river.afterRow + 1);
      let jx = colMajor ? 0 : rng.range(-preset.jitter, preset.jitter);
      let jy = rowMajor || nearRiver ? 0 : rng.range(-preset.jitter, preset.jitter);
      if (i === 0 || i === cols - 1) jx *= 0.3;
      if (j === 0 || j === rows - 1) jy *= 0.3;
      grid[i].push(net.addNode(xs[i] + jx, ys[j] + jy));
    }
  }

  // edges
  interface E {
    a: Node;
    b: Node;
    cls: RoadClass;
    h: boolean;
    i: number;
    j: number;
    keep: boolean;
    bridge: boolean;
  }
  const edges: E[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols - 1; i++)
      edges.push({ a: grid[i][j]!, b: grid[i + 1][j]!, cls: lineClassRow(j), h: true, i, j, keep: true, bridge: false });
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows - 1; j++) {
      const crossesRiver = preset.river && j === preset.river.afterRow;
      if (crossesRiver && !preset.river!.bridges.includes(i)) continue;
      edges.push({ a: grid[i][j]!, b: grid[i][j + 1]!, cls: lineClassCol(i), h: false, i, j, keep: true, bridge: !!crossesRiver });
    }

  // remove some local edges for irregularity (keep degree >= 3 and connectivity)
  const degree = new Map<Node, number>();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const candidates = rng.shuffle(edges.filter((e) => e.cls === 'local' && !e.bridge));
  let toRemove = Math.round(edges.length * preset.removeFrac);
  for (const e of candidates) {
    if (toRemove <= 0) break;
    const onBoundary = e.h ? e.j === 0 || e.j === rows - 1 : e.i === 0 || e.i === cols - 1;
    if (onBoundary) continue;
    if ((degree.get(e.a) ?? 0) < 4 || (degree.get(e.b) ?? 0) < 4) continue;
    if (preset.river && (e.j === preset.river.afterRow || e.j === preset.river.afterRow + 1) && e.h) continue;
    e.keep = false;
    if (!connected(edges)) {
      e.keep = true;
      continue;
    }
    degree.set(e.a, degree.get(e.a)! - 1);
    degree.set(e.b, degree.get(e.b)! - 1);
    toRemove--;
  }

  // names
  const names = rng.shuffle(STREET_NAMES.slice());
  let nameIdx = 0;
  let aveIdx = 0;
  const colNames: string[] = [];
  const rowNames: string[] = [];
  for (let i = 0; i < cols; i++) {
    const c = lineClassCol(i);
    colNames.push(c === 'boulevard' ? 'Grand Blvd' : c === 'avenue' ? `${ORD[aveIdx++]} Ave` : `${names[nameIdx++ % names.length]} St`);
  }
  for (let j = 0; j < rows; j++) {
    const c = lineClassRow(j);
    rowNames.push(c === 'boulevard' ? 'Central Blvd' : c === 'avenue' ? `${ORD[aveIdx++]} Ave` : `${names[nameIdx++ % names.length]} St`);
  }

  for (const e of edges) {
    if (!e.keep) continue;
    const r = net.addRoad(e.a, e.b, e.cls);
    r.bridge = e.bridge;
    r.name = e.h ? rowNames[e.j] : colNames[e.i];
  }

  // gateways (off-map connections)
  const gateways: Node[] = [];
  const GW = 150;
  const addGateway = (n: Node, dx: number, dy: number, cls: RoadClass, name: string): void => {
    const g = net.addNode(n.x + dx * GW, n.y + dy * GW);
    g.gateway = true;
    g.control = 'none';
    const r = net.addRoad(n, g, cls);
    r.name = name;
    gateways.push(g);
  };
  for (let i = 0; i < cols; i++) {
    const c = lineClassCol(i);
    if (c === 'local') continue;
    addGateway(grid[i][0]!, 0, -1, c, colNames[i]);
    addGateway(grid[i][rows - 1]!, 0, 1, c, colNames[i]);
  }
  for (let j = 0; j < rows; j++) {
    const c = lineClassRow(j);
    if (c === 'local') continue;
    addGateway(grid[0][j]!, -1, 0, c, rowNames[j]);
    addGateway(grid[cols - 1][j]!, 1, 0, c, rowNames[j]);
  }
  // a few local gateways
  const localSides: [Node, number, number, string][] = [];
  for (let i = 1; i < cols - 1; i++) {
    if (lineClassCol(i) !== 'local') continue;
    localSides.push([grid[i][0]!, 0, -1, colNames[i]], [grid[i][rows - 1]!, 0, 1, colNames[i]]);
  }
  for (let j = 1; j < rows - 1; j++) {
    if (lineClassRow(j) !== 'local') continue;
    if (preset.river && (j === preset.river.afterRow || j === preset.river.afterRow + 1)) continue;
    localSides.push([grid[0][j]!, -1, 0, rowNames[j]], [grid[cols - 1][j]!, 1, 0, rowNames[j]]);
  }
  rng.shuffle(localSides);
  for (let k = 0; k < Math.min(preset.extraGateways, localSides.length); k++) {
    const [n, dx, dy, nm] = localSides[k];
    addGateway(n, dx, dy, 'local', nm);
  }

  // one-way pairs downtown: alternate directions of interior local streets
  if (preset.oneWays) {
    let flip = false;
    for (let j = 1; j < rows - 1; j++) {
      if (lineClassRow(j) !== 'local') continue;
      flip = !flip;
      if (rng.chance(0.35)) continue;
      for (const r of net.roads) {
        if (r.cls !== 'local' || r.a.gateway || r.b.gateway) continue;
        if (Math.abs(r.a.y - r.b.y) > 20) continue;
        if (Math.abs((r.a.y + r.b.y) / 2 - ys[j]) > 10) continue;
        const ab = r.b.x > r.a.x === flip;
        r.lanesAB = ab ? 2 : 0;
        r.lanesBA = ab ? 0 : 2;
      }
    }
  }

  net.buildGeometry();

  // initial junction controls - an "old" city configuration
  const tutorialNode = preset.tutorialNode ? grid[preset.tutorialNode[0]][preset.tutorialNode[1]] : null;
  for (const n of net.nodes) {
    if (n.gateway) continue;
    if (n.arms.length <= 2) {
      n.control = 'none';
      continue;
    }
    const classes = n.arms.map((a) => a.road.cls);
    const majors = classes.filter((c) => c !== 'local').length;
    const majorRoads = n.arms.filter((a) => a.road.cls !== 'local').map((a) => a.road.id);
    if (majors >= 3 || (majors >= 2 && new Set(n.arms.filter((a) => a.road.cls !== 'local').map((a) => a.road.name)).size >= 2)) {
      n.control = 'signal';
    } else if (majors >= 1) {
      n.control = rng.chance(0.25) ? 'signal' : 'priority';
      for (const id of majorRoads) n.majorRoads.add(id);
    } else {
      n.control = rng.chance(0.45) ? 'allstop' : 'priority';
      // major axis: the straightest pair
      pickMajorAxis(n);
    }
    if (n.majorRoads.size === 0) pickMajorAxis(n);
  }
  if (tutorialNode) {
    tutorialNode.control = 'allstop';
  }
  for (const n of net.nodes) {
    if (n.control === 'signal') {
      // created by sim.initJunctions
    }
    buildJunction(net, n);
  }
  updateLinkNexts(net);
  if (preset.oneWays && !stronglyConnected(net)) {
    for (const r of net.roads) {
      const spec = ROAD_SPECS[r.cls];
      if (r.lanesAB === 0 || r.lanesBA === 0) {
        r.lanesAB = spec.lanesAB;
        r.lanesBA = spec.lanesBA;
      }
    }
    net.buildGeometry();
    for (const n of net.nodes) buildJunction(net, n);
    updateLinkNexts(net);
  }

  // node names
  for (const n of net.nodes) {
    const nm = [...new Set(n.arms.map((a) => a.road.name))];
    n.name = nm.slice(0, 2).join(' & ');
  }

  // blocks
  const blocks = buildBlocks(net, river);
  const bounds = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const n of net.nodes) {
    if (n.gateway) continue;
    bounds.minx = Math.min(bounds.minx, n.x);
    bounds.miny = Math.min(bounds.miny, n.y);
    bounds.maxx = Math.max(bounds.maxx, n.x);
    bounds.maxy = Math.max(bounds.maxy, n.y);
  }
  const center = { x: (bounds.minx + bounds.maxx) / 2, y: (bounds.miny + bounds.maxy) / 2 };
  const radius = Math.max(bounds.maxx - bounds.minx, bounds.maxy - bounds.miny) / 2;
  assignZones(blocks, preset, center, radius, rng);
  const buildings: Building[] = [];
  for (const b of blocks) placeBuildings(b, net, buildings, rng, center, radius, preset);
  assignDays(buildings, center, radius, rng);
  const hospital = pickStation(buildings, 'hospital', center, radius * 0.45, rng);
  const fireStation = pickStation(buildings, 'fire', center, radius * 0.7, rng);
  const police = pickStation(buildings, 'police', center, radius * 0.6, rng);
  const busLines = makeBusLines(net, grid, preset, rng);

  return {
    preset,
    net,
    buildings,
    blocks,
    river,
    bounds,
    center,
    gateways,
    busLines,
    hospital,
    fireStation,
    police,
    tutorialNode,
    grid,
  };
}

function connected(edges: { a: Node; b: Node; keep: boolean }[]): boolean {
  const adj = new Map<Node, Node[]>();
  for (const e of edges) {
    if (!e.keep) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a)!.push(e.b);
    adj.get(e.b)!.push(e.a);
  }
  const nodes = [...adj.keys()];
  if (!nodes.length) return true;
  const seen = new Set<Node>([nodes[0]]);
  const st = [nodes[0]];
  while (st.length) {
    const u = st.pop()!;
    for (const v of adj.get(u)!) if (!seen.has(v)) {
      seen.add(v);
      st.push(v);
    }
  }
  return seen.size === nodes.length;
}

export function pickMajorAxis(n: Node): void {
  n.majorRoads.clear();
  let best: [Arm, Arm] | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < n.arms.length; i++)
    for (let j = i + 1; j < n.arms.length; j++) {
      const a = n.arms[i];
      const b = n.arms[j];
      const straight = -Math.abs(Math.abs(Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle))) - Math.PI);
      const cls = (a.road.cls !== 'local' ? 1 : 0) + (b.road.cls !== 'local' ? 1 : 0);
      const score = straight + cls * 2 + (a.road.name === b.road.name ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = [a, b];
      }
    }
  if (best) {
    n.majorRoads.add(best[0].road.id);
    n.majorRoads.add(best[1].road.id);
  }
}

// ---------------------------------------------------------------------------
// blocks (faces of the planar road graph)

export function cornerPoints(n: Node, armIn: Arm, armOut: Arm): V2[] {
  // corner between armOut (lower angle, "A") and armIn (higher angle, "B") at node n
  const c = n.corners.find((k) => k.armA === armOut && k.armB === armIn);
  if (n.ra) {
    // roundabout: curb follows the circle
    const R = n.ra.ro + 0.2;
    const pB = curbPointAtRadius(n, armIn, -1, R);
    const pA = curbPointAtRadius(n, armOut, 1, R);
    const aB = Math.atan2(pB.y - n.y, pB.x - n.x);
    const aA = Math.atan2(pA.y - n.y, pA.x - n.x);
    let sweep = aA - aB;
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
    const pts: V2[] = [];
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) * R) / 1.5));
    pts.push({ x: n.x + armIn.dir.x * armIn.trim - right(armIn.dir).x * armIn.hw, y: n.y + armIn.dir.y * armIn.trim - right(armIn.dir).y * armIn.hw });
    for (let i = 0; i <= steps; i++) {
      const a = aB + (sweep * i) / steps;
      pts.push({ x: n.x + Math.cos(a) * R, y: n.y + Math.sin(a) * R });
    }
    pts.push({ x: n.x + armOut.dir.x * armOut.trim + right(armOut.dir).x * armOut.hw, y: n.y + armOut.dir.y * armOut.trim + right(armOut.dir).y * armOut.hw });
    return pts;
  }
  if (c && c.kind === 'fillet') {
    return arcPoints(c.cx, c.cy, c.r, c.a1, c.a0, 1.2);
  }
  const rB = right(armIn.dir);
  const rA = right(armOut.dir);
  const pB = { x: n.x - rB.x * armIn.hw, y: n.y - rB.y * armIn.hw };
  const pA = { x: n.x + rA.x * armOut.hw, y: n.y + rA.y * armOut.hw };
  if (dist(pA, pB) < 0.5) return [pA];
  if (c && c.kind === 'reflex') {
    // go around the outside of the bend
    const aB = Math.atan2(pB.y - n.y, pB.x - n.x);
    const aA = Math.atan2(pA.y - n.y, pA.x - n.x);
    const r = (armIn.hw + armOut.hw) / 2;
    let sweep = aA - aB;
    while (sweep > 0) sweep -= Math.PI * 2;
    const pts: V2[] = [];
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * r / 1.5));
    for (let i = 0; i <= steps; i++) {
      const a = aB + (sweep * i) / steps;
      pts.push({ x: n.x + Math.cos(a) * r, y: n.y + Math.sin(a) * r });
    }
    return pts;
  }
  return [pB, pA];
}

/** point on the curb line of an arm at distance R from the node centre. side=+1 right curb (towards next arm) */
function curbPointAtRadius(n: Node, arm: Arm, side: number, R: number): V2 {
  const r = right(arm.dir);
  const hw = arm.hw;
  const t = Math.sqrt(Math.max(0, R * R - hw * hw));
  return { x: n.x + arm.dir.x * t + r.x * hw * side, y: n.y + arm.dir.y * t + r.y * hw * side };
}

const isGatewayRoad = (r: Road): boolean => r.a.gateway || r.b.gateway;

export function faceWalk(net: Network): { node: Node; armIn: Arm; armOut: Arm }[][] {
  const visited = new Set<number>();
  const faces: { node: Node; armIn: Arm; armOut: Arm }[][] = [];
  for (const r of net.roads) {
    if (isGatewayRoad(r)) continue;
    for (const fwd of [true, false]) {
      const key0 = r.id * 2 + (fwd ? 0 : 1);
      if (visited.has(key0)) continue;
      const face: { node: Node; armIn: Arm; armOut: Arm }[] = [];
      let cur = r;
      let f = fwd;
      let guard = 0;
      while (guard++ < 1000) {
        const key = cur.id * 2 + (f ? 0 : 1);
        if (visited.has(key)) break;
        visited.add(key);
        const v = f ? cur.b : cur.a;
        const armIn = f ? cur.armB : cur.armA;
        const arms = v.arms.filter((a) => !isGatewayRoad(a.road));
        const idx = arms.indexOf(armIn);
        const next = arms[(idx - 1 + arms.length) % arms.length];
        face.push({ node: v, armIn, armOut: next });
        cur = next.road;
        f = next.atA;
      }
      if (face.length >= 3) faces.push(face);
    }
  }
  return faces;
}

export function blockCurb(face: { node: Node; armIn: Arm; armOut: Arm }[]): V2[] {
  const pts: V2[] = [];
  for (const c of face) pts.push(...cornerPoints(c.node, c.armIn, c.armOut));
  return simplifyClosed(pts, 0.05, 0.0005);
}

function buildBlocks(net: Network, river: River | null): Block[] {
  const faces = faceWalk(net);
  const blocks: Block[] = [];
  for (const face of faces) {
    const curb = blockCurb(face);
    const area = signedArea(curb);
    if (area <= 50) continue; // outer face or degenerate
    const centroid = polygonCentroid(curb);
    const water = !!river && centroid.y > river.yTop && centroid.y < river.yBot;
    let lot = simplifyClosed(offsetClosed(curb, 3.2), 0.2, 0.002);
    if (signedArea(lot) < 30) lot = [];
    const roads = [...new Set(face.map((c) => c.armOut.road))];
    blocks.push({
      id: blocks.length,
      curb,
      lot,
      zone: water ? 'water' : 'res',
      water,
      park: false,
      plaza: false,
      nodes: face.map((c) => c.node),
      roads,
      centroid,
      area,
      trees: [],
      parking: [],
    });
  }
  // the largest face may still be the outer boundary if orientation flipped
  return blocks;
}

/** promenade parts of a water block (outside the river band) */
export function waterBlockLand(b: Block, river: River): V2[][] {
  const top = clipHalfPlane(b.curb, 0, 1, river.yTop);
  const bot = clipHalfPlane(b.curb, 0, -1, -river.yBot);
  return [top, bot].filter((p) => p.length >= 3 && Math.abs(signedArea(p)) > 5);
}

function assignZones(blocks: Block[], preset: CityPreset, center: V2, radius: number, rng: RNG): void {
  const land = blocks.filter((b) => !b.water);
  for (const b of land) {
    const r = dist(b.centroid, center) / radius;
    const dx = b.centroid.x - center.x;
    const dy = b.centroid.y - center.y;
    const inIndustrial =
      preset.industrial !== 'none' &&
      r > 0.55 &&
      ((preset.industrial === 'ne' && dx > 0 && dy < 0) ||
        (preset.industrial === 'nw' && dx < 0 && dy < 0) ||
        (preset.industrial === 'se' && dx > 0 && dy > 0) ||
        (preset.industrial === 'sw' && dx < 0 && dy > 0));
    if (inIndustrial && rng.chance(0.8)) b.zone = 'ind';
    else if (r < preset.downtown * 0.55) b.zone = rng.chance(0.75) ? 'off' : 'com';
    else if (r < preset.downtown) b.zone = rng.chance(0.45) ? 'com' : rng.chance(0.5) ? 'off' : 'res';
    else if (r < preset.downtown + 0.25) b.zone = rng.chance(0.3) ? 'com' : 'res';
    else b.zone = rng.chance(0.12) ? 'com' : 'res';
  }
  // parks
  const mid = land.filter((b) => b.zone !== 'ind' && b.area > 3000);
  rng.shuffle(mid);
  const nParks = Math.max(1, Math.round(land.length / 14));
  for (let k = 0; k < Math.min(nParks, mid.length); k++) {
    mid[k].park = true;
    mid[k].zone = 'park';
  }
  // a downtown plaza
  const dt = land.filter((b) => b.zone === 'off' && !b.park).sort((a, b) => dist(a.centroid, center) - dist(b.centroid, center));
  if (dt.length > 2 && rng.chance(0.7)) dt[1].plaza = true;
}

interface KindSpec {
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  setback: [number, number];
  gap: [number, number];
}

const KIND_SPECS: Record<BKind, KindSpec> = {
  house: { w: [10, 14], d: [9, 12], floors: [1, 2], setback: [4, 6], gap: [3, 6] },
  apartment: { w: [16, 28], d: [12, 17], floors: [3, 7], setback: [1.5, 3], gap: [2, 5] },
  shop: { w: [10, 20], d: [12, 18], floors: [1, 3], setback: [0.3, 1], gap: [0, 2] },
  office: { w: [20, 34], d: [16, 26], floors: [6, 16], setback: [1, 2.5], gap: [3, 6] },
  tower: { w: [24, 34], d: [22, 32], floors: [16, 38], setback: [2, 4], gap: [5, 9] },
  industrial: { w: [26, 46], d: [20, 34], floors: [1, 2], setback: [5, 9], gap: [5, 10] },
  hospital: { w: [40, 50], d: [28, 34], floors: [5, 7], setback: [4, 6], gap: [4, 6] },
  fire: { w: [20, 24], d: [16, 20], floors: [2, 2], setback: [6, 8], gap: [3, 5] },
  police: { w: [22, 26], d: [16, 20], floors: [3, 3], setback: [3, 5], gap: [3, 5] },
  school: { w: [36, 44], d: [20, 26], floors: [2, 3], setback: [6, 8], gap: [4, 6] },
};

const FACADE_COLORS: Record<string, number[]> = {
  house: [0xe8dcc6, 0xd9c7a7, 0xc9d3d6, 0xe5e1d8, 0xd6b89a, 0xbfc9b5, 0xe9d5c0, 0xc7b8a8],
  apartment: [0xd8cbb8, 0xb9a48c, 0xc9b9a3, 0xa58d77, 0xd3c6b6, 0xbcaea0, 0xcab197, 0x9e8a7a],
  shop: [0xe9e2d4, 0xd2c1a6, 0xcbb7a1, 0xb7aa9a, 0xe0d0b8, 0xc4b5a6],
  office: [0xa7b4bf, 0x8e9ba6, 0xb8c1c7, 0x9aa7b2, 0xc2c8cc, 0x7d8b97, 0xb1b9bf],
  tower: [0x8fa3b5, 0x7a8ea0, 0x9eb0bf, 0x6d8194, 0xa9b6c2, 0x5f7386],
  industrial: [0xb5b0a6, 0xa49f95, 0x9b968c, 0xc0bab0, 0x8f8c84],
  hospital: [0xf2f2ee],
  fire: [0xb3443a],
  police: [0x9aa6b8],
  school: [0xc98f62],
};

function pickKind(zone: Zone, r: number, rng: RNG, preset: CityPreset): BKind {
  switch (zone) {
    case 'off':
      return r < preset.downtown * 0.35 && rng.chance(0.65) ? 'tower' : rng.chance(0.75) ? 'office' : 'shop';
    case 'com':
      return rng.chance(0.6) ? 'shop' : rng.chance(0.6) ? 'apartment' : 'office';
    case 'ind':
      return rng.chance(0.85) ? 'industrial' : 'shop';
    case 'res':
      return r < preset.downtown + 0.12 ? (rng.chance(0.75) ? 'apartment' : 'shop') : rng.chance(0.78) ? 'house' : rng.chance(0.6) ? 'apartment' : 'shop';
    default:
      return 'house';
  }
}

function placeBuildings(b: Block, net: Network, out: Building[], rng: RNG, center: V2, radius: number, preset: CityPreset): void {
  if (b.water || b.lot.length < 3) return;
  const lot = b.lot;
  const placed: OBB[] = [];
  const nodes = b.nodes;
  const r = dist(b.centroid, center) / radius;
  const clearOf = (cx: number, cy: number, rad: number): boolean => {
    for (const n of nodes) {
      const need = Math.max(n.maxRoundaboutR + 5.5, 14) + rad;
      if (Math.hypot(cx - n.x, cy - n.y) < need) return false;
    }
    return true;
  };
  if (b.park || b.plaza) {
    // trees on a jittered grid
    const step = b.plaza ? 14 : 9;
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of lot) {
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x);
      maxy = Math.max(maxy, p.y);
    }
    for (let x = minx + 3; x < maxx - 3; x += step)
      for (let y = miny + 3; y < maxy - 3; y += step) {
        const px = x + rng.range(-3, 3);
        const py = y + rng.range(-3, 3);
        if (!pointInPolygon(px, py, lot)) continue;
        if (b.plaza && Math.hypot(px - b.centroid.x, py - b.centroid.y) < 16) continue;
        if (rng.chance(b.plaza ? 0.6 : 0.82)) b.trees.push({ x: px, y: py });
      }
    return;
  }
  const n = lot.length;
  for (let e = 0; e < n; e++) {
    const a = lot[e];
    const c = lot[(e + 1) % n];
    const L = dist(a, c);
    if (L < 9) continue;
    const ux = (c.x - a.x) / L;
    const uy = (c.y - a.y) / L;
    const nx = -uy; // right of travel = inside the block
    const ny = ux;
    let pos = 1.5;
    let tries = 0;
    while (pos < L - 6 && tries++ < 60) {
      const kind = pickKind(b.zone, r, rng, preset);
      const spec = KIND_SPECS[kind];
      let w = rng.range(spec.w[0], spec.w[1]);
      if (pos + w > L - 1) w = L - 1 - pos;
      if (w < spec.w[0] * 0.75) break;
      let d = rng.range(spec.d[0], spec.d[1]);
      const setback = rng.range(spec.setback[0], spec.setback[1]);
      let ok = false;
      let box: OBB | null = null;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const cx = a.x + ux * (pos + w / 2) + nx * (setback + d / 2);
        const cy = a.y + uy * (pos + w / 2) + ny * (setback + d / 2);
        box = { cx, cy, hw: w / 2, hh: d / 2, ux, uy };
        ok = obbCorners(box).every((p) => pointInPolygon(p.x, p.y, lot)) && !placed.some((p) => obbOverlap(p, box!, 0.8));
        ok = ok && clearOf(cx, cy, Math.hypot(w, d) * 0.5 - 2);
        if (!ok) d *= 0.72;
        if (d < spec.d[0] * 0.6) break;
      }
      if (!ok || !box) {
        pos += 4;
        continue;
      }
      placed.push(box);
      const floors = Math.max(1, Math.round(rng.range(spec.floors[0], spec.floors[1]) * (kind === 'tower' ? 1 - r * 0.6 : 1)));
      const floorH = kind === 'industrial' ? 5 : kind === 'shop' ? 4 : 3.2;
      const h = floors * floorH + (kind === 'industrial' ? rng.range(1, 4) : 0.6);
      const area = w * d;
      let pop = 0;
      let jobs = 0;
      let shop = 0;
      switch (kind) {
        case 'house':
          pop = 4;
          break;
        case 'apartment':
          pop = (floors * area) / 45;
          shop = area * 0.003;
          break;
        case 'shop':
          jobs = (floors * area) / 60;
          shop = area * 0.05;
          pop = floors > 1 ? (floors - 1) * area / 70 : 0;
          break;
        case 'office':
        case 'tower':
          jobs = (floors * area) / 35;
          shop = area * 0.01;
          break;
        case 'industrial':
          jobs = area / 70;
          break;
        default:
          jobs = area / 40;
      }
      // access road: nearest road of the block
      const fx = a.x + ux * (pos + w / 2);
      const fy = a.y + uy * (pos + w / 2);
      let road: Road = b.roads[0];
      let bestD = Infinity;
      for (const rd of b.roads) {
        const pr = rd.center.project(fx, fy);
        if (pr.d < bestD) {
          bestD = pr.d;
          road = rd;
        }
      }
      const pr = road.center.project(fx, fy);
      const lateral = road.center.lateral(fx, fy);
      const colors = FACADE_COLORS[kind];
      out.push({
        id: out.length,
        x: box.cx,
        y: box.cy,
        w,
        d,
        ux,
        uy,
        h,
        floors,
        kind,
        zone: b.zone,
        pop,
        jobs,
        shop,
        road,
        side: lateral >= 0 ? 1 : -1,
        s: pr.s,
        color: rng.pick(colors),
        style: rng.int(0, 3),
        roof: kind === 'house' ? 'gable' : 'flat',
        day: 1,
        block: b.id,
        tier: rng.next(),
      });
      pos += w + rng.range(spec.gap[0], spec.gap[1]);
    }
  }
  // backyard trees / parking lots in the leftover interior
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of lot) {
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  const wantParking = b.zone === 'com' || b.zone === 'off' || b.zone === 'ind';
  if (wantParking) {
    for (let k = 0; k < 6; k++) {
      const px = rng.range(minx + 10, maxx - 10);
      const py = rng.range(miny + 10, maxy - 10);
      const box: OBB = { cx: px, cy: py, hw: rng.range(9, 15), hh: rng.range(7, 11), ux: 1, uy: 0 };
      if (!obbCorners(box).every((p) => pointInPolygon(p.x, p.y, lot))) continue;
      if (placed.some((p) => obbOverlap(p, box, 1))) continue;
      placed.push(box);
      b.parking.push(box);
      if (b.parking.length >= 2) break;
    }
  }
  const treeDensity = b.zone === 'res' ? 0.75 : b.zone === 'ind' ? 0.2 : 0.35;
  for (let x = minx + 2; x < maxx - 2; x += 8)
    for (let y = miny + 2; y < maxy - 2; y += 8) {
      if (!rng.chance(treeDensity)) continue;
      const px = x + rng.range(-3, 3);
      const py = y + rng.range(-3, 3);
      if (!pointInPolygon(px, py, lot)) continue;
      const probe: OBB = { cx: px, cy: py, hw: 2, hh: 2, ux: 1, uy: 0 };
      if (placed.some((p) => obbOverlap(p, probe, 0.5))) continue;
      b.trees.push({ x: px, y: py });
    }
  void net;
}

function assignDays(buildings: Building[], center: V2, radius: number, rng: RNG): void {
  const scored = buildings.map((b) => ({ b, s: dist(b, center) / radius + rng.range(-0.25, 0.25) + (b.kind === 'house' ? 0.1 : 0) }));
  scored.sort((p, q) => p.s - q.s);
  const cum = [0.6, 0.66, 0.72, 0.78, 0.84, 0.89, 0.93, 0.96, 0.98, 1.0];
  scored.forEach((e, i) => {
    const f = (i + 1) / scored.length;
    let day = 1;
    while (day <= cum.length && f > cum[day - 1]) day++;
    e.b.day = Math.min(day, 10);
  });
}

function pickStation(buildings: Building[], kind: BKind, center: V2, maxR: number, rng: RNG): Building | null {
  const cands = buildings.filter(
    (b) => (b.kind === 'apartment' || b.kind === 'office' || b.kind === 'shop') && b.day === 1 && dist(b, center) < maxR && b.w >= 18,
  );
  if (!cands.length) return null;
  const b = rng.pick(cands);
  b.kind = kind;
  b.zone = 'civic';
  b.color = FACADE_COLORS[kind][0];
  b.roof = 'flat';
  if (kind === 'hospital') {
    b.floors = Math.max(b.floors, 5);
    b.h = b.floors * 3.4 + 1;
  } else {
    b.floors = 2;
    b.h = 8;
  }
  b.pop = 0;
  b.jobs = 40;
  b.shop = 0;
  return b;
}

function makeBusLines(net: Network, grid: (Node | null)[][], preset: CityPreset, rng: RNG): BusLine[] {
  const lines: BusLine[] = [];
  const cols = preset.cols;
  const rows = preset.rows;
  const colors = [0xd6332b, 0x2a7bd6, 0x2fa84f, 0xe59b18];
  const tryLine = (nodes: Node[], name: string): void => {
    const links: Link[] = [];
    for (let k = 0; k < nodes.length - 1; k++) {
      const a = nodes[k];
      const b = nodes[k + 1];
      const road = net.roads.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      if (!road) return;
      const l = road.a === a ? road.ab : road.ba;
      if (!l.lanes.length) return;
      links.push(l);
    }
    if (links.length < 3) return;
    const stops: { link: Link; s: number }[] = [];
    links.forEach((l, i) => {
      if (i === 0 || i === links.length - 1) return;
      if (i % 2 === 1 && l.length > 55) stops.push({ link: l, s: l.length * rng.range(0.45, 0.6) });
    });
    lines.push({ id: lines.length, name, color: colors[lines.length % colors.length], links, stops, headway: 70 });
  };
  // along a major column (north -> south) and a major row (west -> east)
  const majorCols = [...preset.avenueCols, ...(preset.boulevardCol >= 0 ? [preset.boulevardCol] : [])];
  const majorRows = [...preset.avenueRows, ...(preset.boulevardRow >= 0 ? [preset.boulevardRow] : [])];
  const findGateway = (n: Node): Node | null => {
    for (const a of n.arms) if (a.other.gateway) return a.other;
    return null;
  };
  if (majorCols.length) {
    const i = majorCols[0];
    const col: Node[] = [];
    for (let j = 0; j < rows; j++) col.push(grid[i][j]!);
    const g0 = findGateway(col[0]);
    const g1 = findGateway(col[col.length - 1]);
    if (g0 && g1) {
      tryLine([g0, ...col, g1], 'Line 1');
      tryLine([g1, ...col.slice().reverse(), g0], 'Line 1');
    }
  }
  if (majorRows.length) {
    const j = majorRows[majorRows.length - 1];
    const row: Node[] = [];
    for (let i = 0; i < cols; i++) row.push(grid[i][j]!);
    const g0 = findGateway(row[0]);
    const g1 = findGateway(row[row.length - 1]);
    if (g0 && g1) {
      tryLine([g0, ...row, g1], 'Line 2');
      tryLine([g1, ...row.slice().reverse(), g0], 'Line 2');
    }
  }
  return lines;
}

export function cityRadius(c: City): number {
  return Math.max(c.bounds.maxx - c.bounds.minx, c.bounds.maxy - c.bounds.miny) / 2;
}

export { clamp };
