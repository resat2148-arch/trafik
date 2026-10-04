// Persistence: settings, campaign progress and the current city run.

import type { Lang } from './i18n.ts';
import type { QualityLevel } from '../render/renderer.ts';
import type { SignalSave } from '../sim/signals.ts';
import type { Control, Network } from '../sim/network.ts';
import type { City } from '../world/citygen.ts';
import type { LifeStats } from './achievements.ts';
import { emptyLife } from './achievements.ts';
import type { PerkId, Perks } from './perks.ts';
import { Platform } from '../platform/crazygames.ts';

export interface NodeSave {
  id: number;
  control: Control;
  major: number[];
  stopMinor: boolean;
  box: boolean;
  rtor: boolean;
  signal?: SignalSave;
}

export interface RoadSave {
  id: number;
  /** lane slots (physical width); missing in saves made before roads could be widened */
  slots?: number;
  ab: number;
  ba: number;
  speed: number;
  busAB: boolean;
  busBA: boolean;
}

export interface RunSave {
  city: string;
  day: number;
  money: number;
  sat: number;
  policies: string[];
  preempt: boolean;
  nodes: NodeSave[];
  roads: RoadSave[];
  arrows: [number, number, number][]; // linkId, laneIndex, mask
  totalTrips: number;
  stars: number[];
  /** green-wave streets; missing in older saves */
  waves?: { name: string; dir: number }[];
  /** growing city: advantages picked so far, the offer waiting to be picked, and the seed of the offers */
  perks?: Perks;
  perkOffer?: PerkId[];
  perkSeed?: number;
}

/** growing city: career progress */
export interface GrowthProgress {
  /** highest level unlocked */
  level: number;
  /** best score and stars per level (index: level - 1) */
  best: number[];
  stars: number[];
}

export interface CityProgress {
  unlocked: boolean;
  bestDay: number;
  stars: number[];
  completed: boolean;
}

export interface SaveData {
  v: 1;
  lang: Lang | null;
  sfx: number;
  music: number;
  quality: QualityLevel | null;
  /** quality picked by the player (never auto-adjusted then) */
  qualityManual: boolean;
  tutorialDone: boolean;
  progress: Record<string, CityProgress>;
  run: RunSave | null;
  /** growing city: progress and the level in play (its city id is 'growth') */
  growth: GrowthProgress;
  growthRun: RunSave | null;
  /** mode played last (shown behind the main menu) */
  lastMode?: 'campaign' | 'growth';
  /** achievements earned (id -> time) and the lifetime counters they count */
  ach: Record<string, number>;
  life: LifeStats;
}

const KEY = 'gridlock-city-save-v1';

export function defaultSave(): SaveData {
  return {
    v: 1,
    lang: null,
    sfx: 0.8,
    music: 0.45,
    quality: null,
    qualityManual: false,
    tutorialDone: false,
    progress: { maple: { unlocked: true, bestDay: 0, stars: [], completed: false } },
    run: null,
    growth: { level: 1, best: [], stars: [] },
    growthRun: null,
    ach: {},
    life: emptyLife(),
  };
}

export function loadSave(): SaveData {
  try {
    const raw = Platform.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as SaveData;
    if (d.v !== 1) return defaultSave();
    const def = defaultSave();
    return { ...def, ...d, progress: { ...def.progress, ...d.progress }, growth: { ...def.growth, ...d.growth }, ach: { ...d.ach }, life: { ...def.life, ...d.life } };
  } catch {
    return defaultSave();
  }
}

let pending: number | null = null;

export function storeSave(d: SaveData, immediate = false): void {
  const write = (): void => {
    pending = null;
    try {
      Platform.setItem(KEY, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  };
  if (immediate) {
    if (pending !== null) clearTimeout(pending);
    write();
    return;
  }
  if (pending !== null) return;
  pending = window.setTimeout(write, 1500);
}

export function clearSave(): void {
  Platform.removeItem(KEY);
}

/** capture the player's network configuration */
export function snapshotNetwork(net: Network): Pick<RunSave, 'nodes' | 'roads' | 'arrows'> {
  const nodes: NodeSave[] = net.nodes
    .filter((n) => !n.gateway && n.arms.length >= 2)
    .map((n) => ({
      id: n.id,
      control: n.control,
      major: [...n.majorRoads],
      stopMinor: n.stopMinor,
      box: n.box,
      rtor: n.rtor,
      signal: n.signal ? n.signal.save() : undefined,
    }));
  const roads: RoadSave[] = net.roads.map((r) => ({ id: r.id, slots: r.maxLanes, ab: r.lanesAB, ba: r.lanesBA, speed: r.speed, busAB: r.busAB, busBA: r.busBA }));
  const arrows: [number, number, number][] = [];
  for (const l of net.links) for (const lane of l.lanes) arrows.push([l.id, lane.index, lane.arrows]);
  return { nodes, roads, arrows };
}

/**
 * Growing city: carry the player's network settings over to the next level's city.
 * Junctions and streets are matched through the city plan; a street that was an
 * off-map stub and is now built keeps the settings of its approach lanes.
 */
export function translateNetwork(snap: Pick<RunSave, 'nodes' | 'roads' | 'arrows'>, from: City, to: City): Pick<RunSave, 'nodes' | 'roads' | 'arrows'> {
  const fg = from.growth;
  const tg = to.growth;
  if (!fg || !tg) return snap;
  const roadId = (id: number): number | undefined => {
    const full = fg.fullRoad[id];
    return full === undefined ? undefined : tg.roadOfFull.get(full)?.id;
  };
  const nodeId = (id: number): number | undefined => {
    const full = fg.fullNode[id];
    return full === undefined || full < 0 ? undefined : tg.nodeOfFull.get(full)?.id;
  };
  const nodes: NodeSave[] = [];
  for (const ns of snap.nodes) {
    const id = nodeId(ns.id);
    if (id === undefined) continue;
    nodes.push({ ...ns, id, major: ns.major.map(roadId).filter((r): r is number => r !== undefined) });
  }
  const roads: RoadSave[] = [];
  for (const rs of snap.roads) {
    const id = roadId(rs.id);
    if (id !== undefined) roads.push({ ...rs, id });
  }
  const arrows: [number, number, number][] = [];
  for (const [linkId, idx, mask] of snap.arrows) {
    const link = from.net.links[linkId];
    const id = link ? roadId(link.road.id) : undefined;
    if (id === undefined) continue;
    const r = to.net.roads[id];
    arrows.push([(link.forward ? r.ab : r.ba).id, idx, mask]);
  }
  return { nodes, roads, arrows };
}
