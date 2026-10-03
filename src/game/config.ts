// Game balance: costs, unlocks, daily scenarios.

import type { CityPreset } from '../world/citygen.ts';
import { RNG } from '../core/rng.ts';

export type Unlock =
  | 'signal'
  | 'allstop'
  | 'priority'
  | 'timing'
  | 'arrows'
  | 'box'
  | 'roundabout'
  | 'restripe'
  | 'speed'
  | 'bus'
  | 'actuated'
  | 'smart'
  | 'greenwave'
  | 'policies'
  | 'preempt'
  | 'rtor';

export const ALL_UNLOCKS: Unlock[] = [
  'signal',
  'allstop',
  'priority',
  'timing',
  'arrows',
  'box',
  'roundabout',
  'restripe',
  'speed',
  'bus',
  'actuated',
  'smart',
  'greenwave',
  'policies',
  'preempt',
  'rtor',
];

/** first city teaches tools gradually; later cities start with everything */
export const TUTORIAL_UNLOCKS: Record<number, Unlock[]> = {
  1: ['signal', 'allstop', 'priority', 'timing'],
  2: ['arrows', 'box', 'rtor'],
  3: ['roundabout'],
  4: ['restripe', 'speed', 'bus'],
  5: ['actuated', 'smart', 'greenwave', 'policies', 'preempt'],
};

export function unlocksFor(preset: CityPreset, day: number): Set<Unlock> {
  if (preset.id !== 'maple') return new Set(ALL_UNLOCKS);
  const s = new Set<Unlock>();
  for (let d = 1; d <= day; d++) for (const u of TUTORIAL_UNLOCKS[d] ?? []) s.add(u);
  if (day > 5) for (const u of ALL_UNLOCKS) s.add(u);
  return s;
}

export function unlockDay(preset: CityPreset, u: Unlock): number {
  if (preset.id !== 'maple') return 1;
  for (const [d, list] of Object.entries(TUTORIAL_UNLOCKS)) if (list.includes(u)) return Number(d);
  return 1;
}

export const COST = {
  signal: 3000,
  allstop: 300,
  priority: 300,
  roundaboutLocal: 9000,
  roundaboutMajor: 14000,
  actuated: 1500,
  smart: 4000,
  arrows: 200,
  box: 400,
  restripe: 1200,
  speed: 100,
  bus: 800,
  tow: 250,
  greenwave: 1000,
  rtor: 100,
  preempt: 2500,
  police: 600,
};

export const UPKEEP = {
  signal: 40,
  actuated: 25,
  smart: 60,
  roundabout: 20,
};

export interface Policy {
  id: 'flex' | 'transit' | 'safety';
  cost: number; // per day
}

export const POLICIES: Policy[] = [
  { id: 'flex', cost: 900 },
  { id: 'transit', cost: 1200 },
  { id: 'safety', cost: 600 },
];

export interface DayConfig {
  day: number;
  demand: number; // multiplier on top of preset demand
  rain: [number, number] | null;
  event: { hour: number; until: number; rate: number } | null;
  accidentRate: number; // per vehicle-hour factor
  emergencies: boolean;
  aggression: number;
}

export function dayConfig(preset: CityPreset, day: number): DayConfig {
  const rng = new RNG(preset.seed * 31 + day * 977);
  const tutorial = preset.id === 'maple';
  const demand = Math.pow(1 + preset.growth, day - 1);
  let rain: [number, number] | null = null;
  let event: DayConfig['event'] = null;
  if (tutorial) {
    if (day === 3) rain = [16.5, 21.5];
    if (day === 5) event = { hour: 16.8, until: 19.2, rate: 0.55 };
  } else {
    if (day >= 2 && rng.chance(0.35)) {
      const s = rng.pick([7, 8, 13, 16.5, 17.5]);
      rain = [s, s + rng.range(2, 4)];
    }
    if (day % 3 === 0) event = { hour: rng.pick([16.5, 17, 18]), until: 0, rate: 0.6 + day * 0.03 };
    if (event) event.until = event.hour + 2.2;
  }
  return {
    day,
    demand,
    rain,
    event,
    accidentRate: tutorial && day === 1 ? 0 : 0.6 + day * 0.12,
    emergencies: !(tutorial && day === 1),
    aggression: Math.min(0.12, (day - 1) * 0.015),
  };
}

/** satisfaction score (0..100) for a completed trip */
export function tripScore(time: number, ff: number): number {
  // ff is a realistic uncongested travel time; ~1.2x is normal city driving
  const r = time / Math.max(10, ff);
  if (r <= 1.4) return 100;
  if (r <= 2.2) return 100 - ((r - 1.4) / 0.8) * 45;
  if (r <= 3.4) return 55 - ((r - 2.2) / 1.2) * 45;
  if (r <= 4.4) return 10 - (r - 3.4) * 10;
  return 0;
}

export function starsFor(avg: number): number {
  return avg >= 80 ? 3 : avg >= 62 ? 2 : avg >= 42 ? 1 : 0;
}
