// Level-up advantages (growing city): after every level passed the player picks one of
// three perks that last for the rest of the career. Some can be taken more than once.

import { RNG } from '../core/rng.ts';

export type PerkId = 'grant' | 'toll' | 'bulk' | 'roadCrew' | 'upkeep' | 'safety' | 'patience' | 'score' | 'tow' | 'ambulance' | 'flex' | 'smart' | 'police';

export interface PerkDef {
  id: PerkId;
  icon: string;
  /** how many times it can be taken */
  max: number;
}

export const PERKS: PerkDef[] = [
  { id: 'grant', icon: '🏛️', max: 3 },
  { id: 'toll', icon: '🎫', max: 2 },
  { id: 'bulk', icon: '🚦', max: 2 },
  { id: 'roadCrew', icon: '🚧', max: 2 },
  { id: 'upkeep', icon: '🧰', max: 2 },
  { id: 'safety', icon: '🦺', max: 2 },
  { id: 'patience', icon: '🧘', max: 2 },
  { id: 'score', icon: '📈', max: 3 },
  { id: 'tow', icon: '🚛', max: 1 },
  { id: 'ambulance', icon: '🚑', max: 1 },
  { id: 'flex', icon: '🕒', max: 1 },
  { id: 'smart', icon: '🤖', max: 1 },
  { id: 'police', icon: '🚓', max: 1 },
];

/** effect of one rank */
export const PERK = {
  /** level grant */
  grant: 0.2,
  /** income per trip */
  toll: 0.25,
  /** junction controls cheaper */
  bulk: 0.2,
  /** restriping and widening cheaper */
  roadCrew: 0.25,
  /** running costs lower */
  upkeep: 0.3,
  /** accidents rarer */
  safety: 0.25,
  /** drivers wait longer before getting angry or giving up */
  patience: 0.25,
  /** trip points */
  score: 0.05,
  /** rush-hour demand factor */
  flex: 0.92,
};

/** perks owned, by rank */
export type Perks = Partial<Record<PerkId, number>>;

export const perkById = (id: string): PerkDef | undefined => PERKS.find((p) => p.id === id);

/** the three advantages offered after a level (the same offer every time it is asked for) */
export function perkOffer(level: number, owned: Perks, seed: number): PerkId[] {
  const rng = new RNG((seed * 7919 + level * 104729) >>> 0);
  const open = PERKS.filter((p) => (owned[p.id] ?? 0) < p.max).map((p) => p.id);
  const out: PerkId[] = [];
  while (out.length < 3 && open.length) out.push(open.splice(Math.floor(rng.next() * open.length), 1)[0]);
  return out;
}

/** perk ranks owned in total */
export function perkCount(p: Perks): number {
  let n = 0;
  for (const k of Object.keys(p) as PerkId[]) n += p[k] ?? 0;
  return n;
}
