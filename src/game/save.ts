// Persistence: settings, campaign progress and the current city run.

import type { Lang } from './i18n.ts';
import type { QualityLevel } from '../render/renderer.ts';
import type { SignalSave } from '../sim/signals.ts';
import type { Control, Network } from '../sim/network.ts';
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
  };
}

export function loadSave(): SaveData {
  try {
    const raw = Platform.getItem(KEY);
    if (!raw) return defaultSave();
    const d = JSON.parse(raw) as SaveData;
    if (d.v !== 1) return defaultSave();
    const def = defaultSave();
    return { ...def, ...d, progress: { ...def.progress, ...d.progress } };
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
  const roads: RoadSave[] = net.roads.map((r) => ({ id: r.id, ab: r.lanesAB, ba: r.lanesBA, speed: r.speed, busAB: r.busAB, busBA: r.busBA }));
  const arrows: [number, number, number][] = [];
  for (const l of net.links) for (const lane of l.lanes) arrows.push([l.id, lane.index, lane.arrows]);
  return { nodes, roads, arrows };
}
