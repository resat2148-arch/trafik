// Achievements: permanent badges for milestones, good days and engineering feats.
// Each one pays a one-off reward into the city treasury when it is earned.

/** lifetime counters some achievements count towards */
export interface LifeStats {
  trips: number;
  bus: number;
  ambulances: number;
  tows: number;
  roundabouts: number;
  widened: number;
}

export function emptyLife(): LifeStats {
  return { trips: 0, bus: 0, ambulances: 0, tows: 0, roundabouts: 0, widened: 0 };
}

export interface AchDef {
  id: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold';
  /** money paid when earned */
  reward: number;
  /** earned by a lifetime counter reaching n */
  goal?: { stat: keyof LifeStats; n: number };
}

export const ACHIEVEMENTS: AchDef[] = [
  // career
  { id: 'firstDay', icon: '🌅', tier: 'bronze', reward: 500 },
  { id: 'threeStars', icon: '⭐', tier: 'bronze', reward: 1000 },
  { id: 'record', icon: '🏅', tier: 'bronze', reward: 800 },
  { id: 'level3', icon: '🏘️', tier: 'bronze', reward: 1000 },
  { id: 'level6', icon: '🏙️', tier: 'silver', reward: 2000 },
  { id: 'level10', icon: '🌆', tier: 'gold', reward: 5000 },
  { id: 'allCities', icon: '🗺️', tier: 'gold', reward: 5000 },
  { id: 'starCollector', icon: '🌟', tier: 'silver', reward: 2500 },
  { id: 'perkCollector', icon: '🎁', tier: 'silver', reward: 2000 },
  // a good day
  { id: 'happyCity', icon: '😄', tier: 'silver', reward: 1500 },
  { id: 'noCrash', icon: '🛡️', tier: 'silver', reward: 1500 },
  { id: 'noAbandon', icon: '🤝', tier: 'silver', reward: 1500 },
  { id: 'comeback', icon: '💪', tier: 'silver', reward: 1500 },
  { id: 'overachiever', icon: '🚀', tier: 'gold', reward: 3000 },
  // engineering
  { id: 'roundabouts', icon: '🔄', tier: 'bronze', reward: 1000, goal: { stat: 'roundabouts', n: 5 } },
  { id: 'widener', icon: '🛣️', tier: 'bronze', reward: 1000, goal: { stat: 'widened', n: 5 } },
  { id: 'smartGrid', icon: '🤖', tier: 'silver', reward: 2000 },
  { id: 'greenWaves', icon: '🟢', tier: 'silver', reward: 2000 },
  { id: 'police', icon: '🚓', tier: 'bronze', reward: 500 },
  // the city at work
  { id: 'busFan', icon: '🚌', tier: 'bronze', reward: 1000, goal: { stat: 'bus', n: 2000 } },
  { id: 'towTrucks', icon: '🚛', tier: 'bronze', reward: 800, goal: { stat: 'tows', n: 10 } },
  { id: 'lifesaver', icon: '🚑', tier: 'silver', reward: 2000, goal: { stat: 'ambulances', n: 15 } },
  { id: 'trips10k', icon: '🚗', tier: 'gold', reward: 3000, goal: { stat: 'trips', n: 10000 } },
];

export const achById = (id: string): AchDef | undefined => ACHIEVEMENTS.find((a) => a.id === id);

/** thresholds of the achievements that need more than one event */
export const ACH_NEED = {
  /** junctions running Smart AI at the same time */
  smartGrid: 8,
  /** streets with a green wave at the same time */
  greenWaves: 3,
  /** stars over all cities and levels */
  starCollector: 25,
  /** perk ranks collected in one career */
  perkCollector: 6,
  /** average satisfaction of a day (%) */
  happyCity: 85,
  /** trips a day must have for "nobody gave up" */
  noAbandon: 300,
  /** satisfaction a comeback day dipped below (%) */
  comeback: 25,
  /** share of the target for "beyond the target" */
  overachiever: 1.4,
};
