// Growing city: one planned city revealed level by level.
//
// The whole city is planned once from a fixed seed: grid, streets, river and
// bridges, zoning and every building. A level builds a rectangle of that plan.
// A street that leads on into a district not built yet ends in an off-map stub
// pointing the same way, so a junction looks and behaves the same before and
// after its neighbourhood grows; blocks and buildings come from the plan, so
// nothing already built moves when the city grows.

import { dist } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import { Network } from '../sim/network.ts';
import type { Link, Node, Road } from '../sim/network.ts';
import { buildJunction, updateLinkNexts } from '../sim/junction.ts';
import { buildBlocks, generateCity } from './citygen.ts';
import type { Block, Building, BusLine, City, CityPreset } from './citygen.ts';

export interface GrowthLevel {
  /** grid columns and rows of the plan built at this level (inclusive) */
  cols: [number, number];
  rows: [number, number];
  /** the district this level adds */
  district: { en: string; tr: string };
  /** demand scale for the whole city */
  demand: number;
  /** share of residents' commutes that leave the built-up area */
  external: number;
  /** score needed to pass the level */
  target: number;
}

export interface GrowthInfo {
  level: number;
  /** level node id -> plan node id (-1: off-map end of a stub) */
  fullNode: number[];
  /** level road id -> plan road id (a stub stands in for the plan street it leads along) */
  fullRoad: number[];
  nodeOfFull: Map<number, Node>;
  roadOfFull: Map<number, Road>;
  /** off-map ends of streets that lead on into districts not built yet */
  stubs: Set<Node>;
  /** buildings that appear at this level */
  fresh: Set<number>;
  /** streets built at this level */
  newRoads: Set<Road>;
  /** centre and radius of the district this level adds */
  focus: { x: number; y: number; r: number };
  /** share of residents' commutes that leave the built-up area */
  external: number;
}

/** the levels' building areas: [first col, last col, first row, last row] */
const AREAS: [number, number, number, number][] = [
  [0, 2, 5, 7],
  [0, 3, 5, 7],
  [0, 3, 4, 7],
  [0, 4, 3, 7],
  [0, 5, 3, 7],
  [0, 5, 2, 7],
  [0, 6, 2, 7],
  [0, 7, 2, 7],
  [0, 7, 0, 7],
  [0, 7, 0, 7],
];

const DISTRICTS: { en: string; tr: string }[] = [
  { en: 'Plane Tree Quarter', tr: 'Çınaraltı Mahallesi' },
  { en: 'Market Street', tr: 'Çarşı' },
  { en: 'School Hill', tr: 'Okul Bayırı' },
  { en: 'City Centre', tr: 'Şehir Merkezi' },
  { en: 'Business Park', tr: 'İş Merkezi' },
  { en: 'Riverside', tr: 'Nehir Kıyısı' },
  { en: 'East Side', tr: 'Doğu Yakası' },
  { en: 'Industrial Zone', tr: 'Sanayi Bölgesi' },
  { en: 'Across the River', tr: 'Karşıyaka' },
  { en: 'Metropolis', tr: 'Metropol' },
];

// calibrated with headless runs: an untouched network passes the first levels, from level 4 on only an
// improved one reaches the target
const DEMAND = [0.39, 0.57, 0.77, 1.2, 1.32, 1.52, 1.66, 1.8, 2.08, 2.25];
const EXTERNAL = [0.6, 0.55, 0.5, 0.42, 0.38, 0.34, 0.3, 0.27, 0.22, 0.2];
const TARGET = [1800, 2350, 2900, 4150, 4400, 4650, 5500, 5800, 6250, 6300];

export const GROWTH_LEVELS: GrowthLevel[] = AREAS.map(([c0, c1, r0, r1], i) => ({
  cols: [c0, c1],
  rows: [r0, r1],
  district: DISTRICTS[i],
  demand: DEMAND[i],
  external: EXTERNAL[i],
  target: TARGET[i],
}));

/** past the last level the city stays the same size while traffic keeps growing */
export function growthLevel(level: number): GrowthLevel {
  const n = GROWTH_LEVELS.length;
  if (level <= n) return GROWTH_LEVELS[Math.max(1, level) - 1];
  const last = GROWTH_LEVELS[n - 1];
  const k = level - n;
  return {
    ...last,
    district: last.district,
    demand: last.demand * Math.pow(1.05, k),
    target: Math.round((last.target * Math.pow(1.03, k)) / 50) * 50,
  };
}

export const GROWTH_PRESET: CityPreset = {
  id: 'growth',
  name: { en: 'Boomtown', tr: 'Büyüyen Şehir' },
  seed: 2718,
  cols: 8,
  rows: 8,
  blockMin: 78,
  blockMax: 98,
  avenueCols: [2, 6],
  avenueRows: [3, 6],
  boulevardCol: 4,
  boulevardRow: -1,
  river: { afterRow: 1, width: 48, bridges: [2, 4, 6] },
  removeFrac: 0.08,
  jitter: 3.5,
  extraGateways: 4,
  oneWays: false,
  downtown: 0.45,
  industrial: 'se',
  days: GROWTH_LEVELS.length,
  demand: 1,
  growth: 0,
  startMoney: 12000,
  // streets along the edge of any level's area always exist, so every built block is closed
  protectEdge: (h, i, j) =>
    AREAS.some(([c0, c1, r0, r1]) => (h ? (j === r0 || j === r1) && i >= c0 && i + 1 <= c1 : (i === c0 || i === c1) && j >= r0 && j + 1 <= r1)),
};

/** length of the off-map stub that stands in for a street into an unbuilt district */
const STUB = 150;

let PLAN: City | null = null;

/** the whole planned city (deterministic, built once) */
export function growthPlan(): City {
  if (!PLAN) PLAN = generateCity(GROWTH_PRESET);
  return PLAN;
}

export function generateGrowthCity(level: number): City {
  const full = growthPlan();
  const def = growthLevel(level);
  const prev = level > 1 ? growthLevel(level - 1) : null;
  const ij = new Map<Node, [number, number]>();
  full.grid.forEach((col, i) => col.forEach((n, j) => n && ij.set(n, [i, j])));
  const within = (n: Node, d: GrowthLevel): boolean => {
    const p = ij.get(n);
    return !!p && p[0] >= d.cols[0] && p[0] <= d.cols[1] && p[1] >= d.rows[0] && p[1] <= d.rows[1];
  };

  // ---- network: the plan's streets inside the area, stubs where they lead out of it
  const net = new Network();
  const fullNode: number[] = [];
  const fullRoad: number[] = [];
  const nodeOfFull = new Map<number, Node>();
  const roadOfFull = new Map<number, Road>();
  const stubs = new Set<Node>();
  const addNode = (src: Node | null, x: number, y: number): Node => {
    const n = net.addNode(x, y);
    fullNode.push(src ? src.id : -1);
    if (src) nodeOfFull.set(src.id, n);
    return n;
  };
  for (const n of full.net.nodes) if (!n.gateway && within(n, def)) addNode(n, n.x, n.y);
  // the plan's own off-map connections at the city edge
  for (const n of full.net.nodes) {
    if (!n.gateway || !n.arms[0] || !nodeOfFull.has(n.arms[0].other.id)) continue;
    addNode(n, n.x, n.y).gateway = true;
  }
  for (const r of full.net.roads) {
    let a = nodeOfFull.get(r.a.id);
    let b = nodeOfFull.get(r.b.id);
    if (!a && !b) continue;
    if (!a || !b) {
      // the street goes on into a district not built yet: it leaves the map along the same line
      const from = a ? r.a : r.b;
      const to = a ? r.b : r.a;
      if (to.gateway) continue;
      const L = dist(from, to) || 1;
      const g = addNode(null, from.x + ((to.x - from.x) / L) * STUB, from.y + ((to.y - from.y) / L) * STUB);
      g.gateway = true;
      stubs.add(g);
      if (a) b = g;
      else a = g;
    }
    const lr = net.addRoad(a, b!, r.cls);
    lr.name = r.name;
    lr.bridge = r.bridge;
    lr.lanesAB = r.lanesAB;
    lr.lanesBA = r.lanesBA;
    fullRoad.push(r.id);
    roadOfFull.set(r.id, lr);
  }
  net.buildGeometry();
  // junction controls as planned: every junction has the same arms at every level
  for (const n of net.nodes) {
    const src = fullNode[n.id] >= 0 ? full.net.nodes[fullNode[n.id]] : null;
    if (n.gateway || !src) {
      n.control = 'none';
      continue;
    }
    n.control = src.control;
    n.stopMinor = src.stopMinor;
    n.majorRoads = new Set([...src.majorRoads].map((id) => roadOfFull.get(id)?.id).filter((id): id is number => id !== undefined));
    n.name = src.name;
  }
  let tutorialNode: Node | null = null;
  if (level === 1) {
    // the first lesson: the crossing of the two main roads starts as a 4-way stop
    const majors = (n: Node): number => n.arms.filter((a) => a.road.cls !== 'local').length;
    const cands = net.nodes.filter((n) => !n.gateway && n.arms.length >= 4 && majors(n) > 0).sort((a, b) => majors(b) - majors(a));
    tutorialNode = cands[0] ?? null;
    if (tutorialNode) tutorialNode.control = 'allstop';
  }
  for (const n of net.nodes) buildJunction(net, n);
  updateLinkNexts(net);

  // ---- blocks: zoning, lots, trees and car parks of the plan
  const river = full.river;
  const blocks = buildBlocks(net, river);
  const blockOfFull = new Map<number, Block>();
  for (const b of blocks) {
    let best: Block | null = null;
    let bd = 3;
    for (const fb of full.blocks) {
      const d = dist(fb.centroid, b.centroid);
      if (d < bd && Math.abs(fb.area - b.area) < fb.area * 0.05 + 5) {
        bd = d;
        best = fb;
      }
    }
    if (!best) continue;
    b.zone = best.zone;
    b.water = best.water;
    b.park = best.park;
    b.plaza = best.plaza;
    b.lot = best.lot;
    b.trees = best.trees;
    b.parking = best.parking;
    blockOfFull.set(best.id, b);
  }

  // ---- buildings of the built blocks
  const buildings: Building[] = [];
  const fresh = new Set<number>();
  const bOfFull = new Map<number, Building>();
  for (const fb of full.buildings) {
    const lb = blockOfFull.get(fb.block);
    const road = roadOfFull.get(fb.road.id);
    if (!lb || !road) continue;
    const b: Building = { ...fb, id: buildings.length, road, block: lb.id, day: 1 };
    buildings.push(b);
    bOfFull.set(fb.id, b);
    if (!prev || !full.blocks[fb.block].nodes.every((n) => within(n, prev))) fresh.add(b.id);
  }
  const station = (s: Building | null): Building | null => (s ? bOfFull.get(s.id) ?? null : null);

  // ---- extent, grid and what is new
  const bounds = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const added = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  const grid: (Node | null)[][] = full.grid.map((col) => col.map(() => null));
  for (const n of net.nodes) {
    if (n.gateway) continue;
    bounds.minx = Math.min(bounds.minx, n.x);
    bounds.miny = Math.min(bounds.miny, n.y);
    bounds.maxx = Math.max(bounds.maxx, n.x);
    bounds.maxy = Math.max(bounds.maxy, n.y);
    const src = full.net.nodes[fullNode[n.id]];
    const p = ij.get(src)!;
    grid[p[0]][p[1]] = n;
    if (!prev || !within(src, prev)) {
      added.minx = Math.min(added.minx, n.x);
      added.miny = Math.min(added.miny, n.y);
      added.maxx = Math.max(added.maxx, n.x);
      added.maxy = Math.max(added.maxy, n.y);
    }
  }
  const box = added.minx < Infinity ? added : bounds;
  const focus = { x: (box.minx + box.maxx) / 2, y: (box.miny + box.maxy) / 2, r: Math.max(80, Math.hypot(box.maxx - box.minx, box.maxy - box.miny) / 2) };
  const newRoads = new Set<Road>();
  for (const r of net.roads) {
    if (r.a.gateway || r.b.gateway) continue;
    const fr = full.net.roads[fullRoad[r.id]];
    if (!prev || !within(fr.a, prev) || !within(fr.b, prev)) newRoads.add(r);
  }

  const preset: CityPreset = { ...GROWTH_PRESET, demand: def.demand };
  return {
    preset,
    net,
    buildings,
    blocks,
    river,
    bounds,
    center: { x: (bounds.minx + bounds.maxx) / 2, y: (bounds.miny + bounds.maxy) / 2 },
    gateways: net.nodes.filter((n) => n.gateway),
    busLines: busLines(net, grid, def),
    hospital: station(full.hospital),
    fireStation: station(full.fireStation),
    police: station(full.police),
    tutorialNode,
    grid,
    growth: { level, fullNode, fullRoad, nodeOfFull, roadOfFull, stubs, fresh, newRoads, focus, external: def.external },
  };
}

/** bus lines along the first planned avenue and the last cross avenue that are built */
function busLines(net: Network, grid: (Node | null)[][], def: GrowthLevel): BusLine[] {
  const p = GROWTH_PRESET;
  const lines: BusLine[] = [];
  const colors = [0xd6332b, 0x2a7bd6, 0x2fa84f, 0xe59b18];
  // the off-map end reached from n heading away from m
  const beyond = (n: Node, m: Node): Node | null => {
    const L = dist(n, m) || 1;
    const dx = (n.x - m.x) / L;
    const dy = (n.y - m.y) / L;
    let best: Node | null = null;
    let bd = 0.9;
    for (const a of n.arms) {
      const d = a.dir.x * dx + a.dir.y * dy;
      if (a.other.gateway && d > bd) {
        bd = d;
        best = a.other;
      }
    }
    return best;
  };
  const tryLine = (nodes: Node[], name: string, rng: RNG): void => {
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
  const line = (nodes: (Node | null)[], name: string, seed: number): void => {
    const ns = nodes.filter((n): n is Node => !!n);
    if (ns.length < 2) return;
    const g0 = beyond(ns[0], ns[1]);
    const g1 = beyond(ns[ns.length - 1], ns[ns.length - 2]);
    if (!g0 || !g1) return;
    const rng = new RNG(seed);
    tryLine([g0, ...ns, g1], name, rng);
    tryLine([g1, ...ns.slice().reverse(), g0], name, rng);
  };
  const cols = [...p.avenueCols, ...(p.boulevardCol >= 0 ? [p.boulevardCol] : [])];
  const rows = [...p.avenueRows, ...(p.boulevardRow >= 0 ? [p.boulevardRow] : [])];
  const col = cols.find((i) => i >= def.cols[0] && i <= def.cols[1]);
  if (col !== undefined) {
    const ns: (Node | null)[] = [];
    for (let j = def.rows[0]; j <= def.rows[1]; j++) ns.push(grid[col][j]);
    line(ns, 'Line 1', 11);
  }
  const row = [...rows].reverse().find((j) => j >= def.rows[0] && j <= def.rows[1]);
  if (row !== undefined) {
    const ns: (Node | null)[] = [];
    for (let i = def.cols[0]; i <= def.cols[1]; i++) ns.push(grid[i][row]);
    line(ns, 'Line 2', 23);
  }
  return lines;
}
