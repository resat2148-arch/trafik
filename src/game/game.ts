// Game controller: day cycle, economy, satisfaction, incidents, player actions.

import { clamp, dist } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import { PRESETS, generateCity, pickMajorAxis } from '../world/citygen.ts';
import { generateGrowthCity, growthLevel } from '../world/growth.ts';
import type { Building, City, CityPreset } from '../world/citygen.ts';
import { Sim } from '../sim/sim.ts';
import type { SimEvent } from '../sim/sim.ts';
import { Demand } from '../sim/demand.ts';
import { ROAD_SPECS, SIG_P, computeCorners, laneWidthOf, maxSlotsOf, setRoadSlots, slotsFor } from '../sim/network.ts';
import type { Arm, Conn, Control, Lane, Link, Node, Road } from '../sim/network.ts';
import { arrowOptions, availableBits, movementsFor, stronglyConnected } from '../sim/junction.ts';
import type { PlanType, SigMode } from '../sim/signals.ts';
import { MODEL } from '../sim/vehicle.ts';
import type { Vehicle } from '../sim/vehicle.ts';
import { GameRenderer } from '../render/renderer.ts';
import type { QualityLevel } from '../render/renderer.ts';
import type { Selection } from '../render/overlays.ts';
import { DAY_LENGTH, hourAt, timeAtHour } from './clock.ts';
import { COST, POLICIES, SCORE, STAR2, STAR3, UPKEEP, dayConfig, growthDayConfig, scoreStars, starsFor, tripPoints, tripScore, unlocksFor } from './config.ts';
import type { DayConfig, Unlock } from './config.ts';
import { loadSave, snapshotNetwork, storeSave, translateNetwork } from './save.ts';
import type { RunSave, SaveData } from './save.ts';
import { t } from './i18n.ts';
import type { StrKey } from './i18n.ts';
import { Audio } from '../audio/audio.ts';
import { Platform } from '../platform/crazygames.ts';

export type Phase = 'boot' | 'menu' | 'intro' | 'playing' | 'report' | 'fired' | 'complete';
export type ToastKind = 'info' | 'warn' | 'bad' | 'good';
/** why a road cannot be made wider */
export type WidenBlock = 'bridge' | 'max' | 'short' | 'buildings';

export interface GameUI {
  toast(msg: string, kind: ToastKind, action?: { label: string; fn: () => void }, key?: string): void;
  refreshPanel(): void;
  phaseChanged(p: Phase): void;
  floatText(x: number, y: number, text: string, color: string): void;
  tutorialEvent(ev: string): void;
}

export interface DayStats {
  trips: number;
  tripTime: number;
  ffTime: number;
  satArea: number;
  satTime: number;
  abandoned: number;
  crashes: number;
  income: number;
  spent: number;
  emergencies: number;
  emergenciesFast: number;
  passengers: number;
  newBuildings: number;
  minSat: number;
}

/** growing city: where the day's score came from */
export interface ScoreParts {
  trips: number;
  tripCount: number;
  emergency: number;
  crashes: number;
  abandoned: number;
  blocked: number;
}

export interface Report {
  avg: number;
  stars: number;
  upkeep: number;
  grant: number;
  doubled: boolean;
  /** growing city */
  score?: number;
  target?: number;
  passed?: boolean;
  record?: boolean;
  prevBest?: number;
}

function emptyParts(): ScoreParts {
  return { trips: 0, tripCount: 0, emergency: 0, crashes: 0, abandoned: 0, blocked: 0 };
}

export interface Incident {
  id: number;
  vehicles: Vehicle[];
  x: number;
  y: number;
  age: number;
  clearAfter: number;
  tow: Vehicle | null;
  towWork: number;
  where: string;
}

function emptyStats(): DayStats {
  return {
    trips: 0,
    tripTime: 0,
    ffTime: 0,
    satArea: 0,
    satTime: 0,
    abandoned: 0,
    crashes: 0,
    income: 0,
    spent: 0,
    emergencies: 0,
    emergenciesFast: 0,
    passengers: 0,
    newBuildings: 0,
    minSat: 100,
  };
}

let INC_ID = 1;

/** does a box (building or car park) stand where a road `slots` lanes wide plus a narrow sidewalk would be? */
function crowdsRoad(r: Road, slots: number, cx: number, cy: number, hw: number, hh: number, ux: number, uy: number): boolean {
  const need = (r.median + slots * laneWidthOf(r)) / 2 + 1.5;
  if (r.center.project(cx, cy).d > need + Math.hypot(hw, hh)) return false;
  const vx = -uy;
  const vy = ux;
  const steps = Math.max(2, Math.ceil(Math.max(hw, hh)));
  for (let i = 0; i <= steps; i++) {
    const f = (i / steps) * 2 - 1;
    const pts = [
      [cx + ux * hw * f + vx * hh, cy + uy * hw * f + vy * hh],
      [cx + ux * hw * f - vx * hh, cy + uy * hw * f - vy * hh],
      [cx + ux * hw + vx * hh * f, cy + uy * hw + vy * hh * f],
      [cx - ux * hw + vx * hh * f, cy - uy * hw + vy * hh * f],
    ];
    for (const [x, y] of pts) if (r.center.project(x, y).d < need) return true;
  }
  return false;
}

export class Game {
  save: SaveData;
  phase: Phase = 'boot';
  ui: GameUI | null = null;
  renderer!: GameRenderer;
  preset!: CityPreset;
  city!: City;
  sim!: Sim;
  demand!: Demand;
  day = 1;
  money = 0;
  sat = 70;
  speed = 1;
  prevSpeed = 1;
  dayT = 0;
  cfg!: DayConfig;
  stats: DayStats = emptyStats();
  incidents: Incident[] = [];
  unlocks = new Set<Unlock>();
  policies = new Set<string>();
  preempt = false;
  selection: Selection = null;
  follow: Vehicle | null = null;
  starsHistory: number[] = [];
  totalTrips = 0;
  private rng = new RNG(Date.now() & 0xffff);
  private emergencyT = 60;
  private accidentAcc = 0;
  private tipT = 15;
  private tipsShown = new Set<string>();
  private rushNotified = { am: false, pm: false };
  private rainNotified = false;
  private eventNotified = false;
  private warnT = 0;
  private lastHour = 6;
  private lastBlocked = 0;
  private lastPopup = 0;
  policeCooldown = new Map<number, number>();
  endless = false;
  menuMode = false;
  onTick: (() => void) | null = null;
  private emergencies = new Map<Vehicle, number>();
  hotNodes: Node[] = [];
  private hotT = 0;
  private autosaveT = 0;
  tutorialActive = false;
  /** growing city: the day's score so far and where it came from */
  score = 0;
  scoreParts: ScoreParts = emptyParts();
  /** growing city: the level is over and the saved run already holds the next one */
  private levelDone = false;
  /** growing city: the new district is being shown (buildings rising, camera on it) */
  revealing = false;

  constructor() {
    this.save = loadSave();
  }

  /** playing the growing city (its days are levels) */
  get growth(): boolean {
    return this.preset?.id === 'growth';
  }

  /** the saved run of the mode being played */
  get runSave(): RunSave | null {
    return this.growth ? this.save.growthRun : this.save.run;
  }

  quality(): QualityLevel {
    if (this.save.quality) return this.save.quality;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency || 4;
    return mobile ? 'low' : cores >= 8 ? 'high' : 'medium';
  }

  applyQuality(level: QualityLevel, manual = true): void {
    this.save.quality = level;
    if (manual) this.save.qualityManual = true;
    storeSave(this.save, true);
    this.renderer.setQuality(level, this.sim ?? null, this.day);
  }

  initRenderer(container: HTMLElement): void {
    this.renderer = new GameRenderer(container, this.quality());
    this.renderer.rig.onClick = (x, y) => this.pick(x, y);
    this.renderer.rig.onHover = (x, y) => this.hover(x, y);
  }

  // ---------------------------------------------------------------- loading

  loadCity(id: string, run: RunSave | null, menu = false, reveal = !menu): void {
    if (id === 'growth') {
      // the level's part of the planned city
      this.city = generateGrowthCity(run && run.city === id ? run.day : 1);
      this.preset = this.city.preset;
    } else {
      this.preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
      this.city = generateCity(this.preset);
    }
    this.levelDone = false;
    this.sim = new Sim(this.city.net, (this.preset.seed * 7) | 0);
    this.sim.initJunctions();
    this.demand = new Demand(this.city, this.sim, this.preset.seed + 5);
    this.menuMode = menu;
    this.incidents = [];
    this.selection = null;
    this.follow = null;
    if (run && run.city === id) {
      this.day = run.day;
      this.money = run.money;
      this.sat = run.sat;
      this.policies = new Set(run.policies);
      this.preempt = run.preempt;
      this.totalTrips = run.totalTrips;
      this.starsHistory = run.stars.slice();
      this.applyNetwork(run);
      for (const w of run.waves ?? []) this.sim.waves.add(w.name, w.dir);
    } else {
      const lr = new RNG(this.preset.seed + 99);
      for (const n of this.city.net.nodes) if (n.signal) n.signal.legacyTiming(() => lr.next());
      this.day = 1;
      this.money = this.preset.startMoney;
      this.sat = 70;
      this.policies = new Set();
      this.preempt = false;
      this.totalTrips = 0;
      this.starsHistory = [];
    }
    if (this.growth) this.clearWidenedLots();
    this.renderer.setCity(this.city, this.sim, this.day);
    this.renderer.overlays.setSelection(null);
    this.revealing = this.growth && reveal;
    if (this.revealing) this.renderer.reveal(this.city);
    this.prepareDay();
  }

  /**
   * Growing city: buildings of a newly built district keep clear of streets the player
   * widened before the district existed.
   */
  private clearWidenedLots(): void {
    const wide = this.city.net.roads.filter((r) => r.maxLanes > ROAD_SPECS[r.cls].maxLanes && !r.a.gateway && !r.b.gateway);
    if (!wide.length) return;
    // the same clearance a widening needs, so what stood beside the street when it was widened stays
    const blocked = (cx: number, cy: number, hw: number, hh: number, ux: number, uy: number): boolean => wide.some((r) => crowdsRoad(r, r.maxLanes, cx, cy, hw, hh, ux, uy));
    const keep = this.city.buildings.filter((b) => !blocked(b.x, b.y, b.w / 2, b.d / 2, b.ux, b.uy));
    if (keep.length === this.city.buildings.length) return;
    const fresh = this.city.growth?.fresh;
    const nextFresh = new Set<number>();
    keep.forEach((b, i) => {
      if (fresh?.has(b.id)) nextFresh.add(i);
      b.id = i;
    });
    this.city.buildings = keep;
    if (this.city.growth) this.city.growth.fresh = nextFresh;
    for (const bl of this.city.blocks) bl.parking = bl.parking.filter((pk) => !blocked(pk.cx, pk.cy, pk.hw, pk.hh, pk.ux, pk.uy));
    for (const s of ['hospital', 'fireStation', 'police'] as const) if (this.city[s] && !keep.includes(this.city[s]!)) this.city[s] = null;
  }

  private applyNetwork(run: RunSave): void {
    const net = this.city.net;
    for (const rs of run.roads) {
      const r = net.roads[rs.id];
      if (r && rs.slots && rs.slots !== r.maxLanes) this.sim.reshapeRoad(r, rs.slots, rs.ab, rs.ba, false);
    }
    for (const rs of run.roads) {
      const r = net.roads[rs.id];
      if (!r) continue;
      if (r.lanesAB !== rs.ab || r.lanesBA !== rs.ba || r.busAB !== rs.busAB || r.busBA !== rs.busBA || r.speed !== rs.speed)
        this.sim.restripe(r, rs.ab, rs.ba, rs.busAB, rs.busBA, rs.speed, false);
    }
    for (const [linkId, idx, mask] of run.arrows) {
      const lane = net.links[linkId]?.lanes[idx];
      if (lane) lane.arrows = mask;
    }
    for (const ns of run.nodes) {
      const n = net.nodes[ns.id];
      if (!n) continue;
      n.majorRoads = new Set(ns.major);
      n.stopMinor = ns.stopMinor;
      n.box = ns.box;
      n.rtor = ns.rtor;
      this.sim.setControl(n, ns.control);
      if (ns.signal && n.signal) {
        n.signal.load(ns.signal);
        n.signal.preemptConn = null;
      }
    }
    for (const n of net.nodes) if (!n.gateway && n.arms.length >= 2) this.sim.rebuildNode(n);
    for (const ns of run.nodes) {
      const n = net.nodes[ns.id];
      if (n?.signal && ns.signal) n.signal.load(ns.signal);
    }
  }

  private prepareDay(): void {
    this.cfg = this.growth ? growthDayConfig(this.day) : dayConfig(this.preset, this.day);
    this.unlocks = unlocksFor(this.preset, this.day);
    // every level starts with fresh goodwill; only the score decides it
    if (this.growth && !this.menuMode) this.sat = 70;
    this.score = 0;
    this.scoreParts = emptyParts();
    this.demand.setDay(this.day);
    this.demand.scale = this.cfg.demand * (this.policies.has('transit') ? 0.9 : 1);
    this.sim.aggressionBias = this.cfg.aggression - (this.policies.has('safety') ? 0.08 : 0);
    this.renderer.world?.setDay(this.day);
    this.dayT = this.menuMode ? timeAtHour(7.6) : 0;
    this.stats = emptyStats();
    this.stats.newBuildings = this.growth ? this.city.growth?.fresh.size ?? 0 : this.city.buildings.filter((b) => b.day === this.day).length;
    this.stats.minSat = this.sat;
    this.rushNotified = { am: false, pm: false };
    this.rainNotified = false;
    this.eventNotified = false;
    this.emergencyT = 70 + this.rng.next() * 60;
    this.tipsShown.clear();
    this.sim.clearAll();
    this.demand.clear();
    this.demand.stats.blocked = 0;
    this.lastBlocked = 0;
    this.incidents = [];
    this.emergencies.clear();
    for (const n of this.city.net.nodes) {
      n.delayEMA = 0;
      n.passed = 0;
      n.delayN = 0;
      n.delaySum = 0;
    }
    if (this.menuMode) {
      this.demand.scale = 0.55;
      // warm up so the menu backdrop is alive
      for (let i = 0; i < 40 * 30; i++) this.simStep(1 / 30, true);
    } else {
      // early morning traffic already on the streets when the day starts
      const keep = this.demand.scale;
      this.demand.scale = keep * 2.2;
      for (let i = 0; i < 26 * 30; i++) this.simStep(1 / 30, true);
      this.demand.scale = keep;
      this.sim.stats.trips = 0;
    }
    // departures that failed before the day started do not count against it
    this.lastBlocked = this.demand.stats.blocked;
  }

  // ---------------------------------------------------------------- day flow

  startDay(): void {
    this.setPhase('playing');
    this.speed = 1;
    Platform.gameplayStart();
    this.persist(true);
  }

  setPhase(p: Phase): void {
    this.phase = p;
    this.ui?.phaseChanged(p);
    if (p !== 'playing') Platform.gameplayStop();
  }

  /** daily running costs of signals, roundabouts and policies */
  private upkeep(): number {
    let upkeep = 0;
    for (const n of this.city.net.nodes) {
      if (n.control === 'signal' && n.signal) {
        upkeep += UPKEEP.signal + (n.signal.mode === 'actuated' ? UPKEEP.actuated : n.signal.mode === 'smart' ? UPKEEP.smart : 0);
      } else if (n.control === 'roundabout') upkeep += UPKEEP.roundabout;
    }
    for (const p of POLICIES) if (this.policies.has(p.id)) upkeep += p.cost;
    return upkeep;
  }

  private endDay(): void {
    if (this.growth) {
      this.endLevel();
      return;
    }
    const s = this.stats;
    const avg = s.satTime > 0 ? s.satArea / s.satTime : this.sat;
    const stars = starsFor(avg);
    const upkeep = this.upkeep();
    const grant = Math.round(1500 + avg * 45 + this.day * 250);
    this.report = { avg, stars, upkeep, grant, doubled: false };
    this.money += grant - upkeep;
    this.starsHistory[this.day - 1] = Math.max(this.starsHistory[this.day - 1] ?? 0, stars);
    const prog = this.save.progress[this.preset.id] ?? { unlocked: true, bestDay: 0, stars: [], completed: false };
    prog.bestDay = Math.max(prog.bestDay, this.day);
    prog.stars[this.day - 1] = Math.max(prog.stars[this.day - 1] ?? 0, stars);
    const complete = this.day >= this.preset.days && !this.endless;
    if (complete) {
      prog.completed = true;
      const idx = PRESETS.findIndex((p) => p.id === this.preset.id);
      const next = PRESETS[idx + 1];
      if (next) {
        const np = this.save.progress[next.id] ?? { unlocked: false, bestDay: 0, stars: [], completed: false };
        np.unlocked = true;
        this.save.progress[next.id] = np;
      }
    }
    this.save.progress[this.preset.id] = prog;
    this.day++;
    this.persist(true);
    Audio.success();
    if (stars >= 2) Platform.happytime();
    this.setPhase(complete ? 'complete' : 'report');
  }

  report: Report = { avg: 0, stars: 0, upkeep: 0, grant: 0, doubled: false };

  /** growing city: the level's day is over; reaching the score target opens the next district */
  private endLevel(): void {
    const lv = this.day;
    const def = growthLevel(lv);
    const s = this.stats;
    const avg = s.satTime > 0 ? s.satArea / s.satTime : this.sat;
    const stars = scoreStars(this.score, def.target);
    const passed = stars > 0;
    const prog = this.save.growth;
    const prevBest = prog.best[lv - 1] ?? 0;
    prog.best[lv - 1] = Math.max(prevBest, this.score);
    prog.stars[lv - 1] = Math.max(prog.stars[lv - 1] ?? 0, stars);
    let upkeep = 0;
    let grant = 0;
    if (passed) {
      upkeep = this.upkeep();
      grant = Math.round((2500 + this.score * 0.8 + lv * 500) / 10) * 10;
      this.money += grant - upkeep;
      prog.level = Math.max(prog.level, lv + 1);
      this.starsHistory[lv - 1] = Math.max(this.starsHistory[lv - 1] ?? 0, stars);
    }
    this.report = { avg, stars, upkeep, grant, doubled: false, score: this.score, target: def.target, passed, record: prevBest > 0 && this.score > prevBest, prevBest };
    if (passed) {
      // the next level's city with everything the player built so far
      this.save.growthRun = this.nextLevelRun();
      this.save.lastMode = 'growth';
      storeSave(this.save, true);
      this.levelDone = true;
      Audio.success();
      if (stars >= 2) Platform.happytime();
    } else {
      this.persist(true);
      Audio.fail();
    }
    this.setPhase('report');
  }

  /** the saved run that starts the next level: this network carried over onto the bigger city */
  private nextLevelRun(): RunSave {
    const next = generateGrowthCity(this.day + 1);
    return {
      city: 'growth',
      day: this.day + 1,
      money: Math.round(this.money),
      sat: 70,
      policies: [...this.policies],
      preempt: this.preempt,
      ...translateNetwork(snapshotNetwork(this.city.net), this.city, next),
      totalTrips: this.totalTrips,
      stars: this.starsHistory.slice(),
      waves: this.sim.waves.corridors.map((c) => ({ name: c.name, dir: c.dir })),
    };
  }

  async nextDay(): Promise<void> {
    await Platform.midgame();
    if (this.growth) {
      // passed: the saved run is the next level; failed: play the level again
      this.loadCity('growth', this.save.growthRun);
      this.setPhase('intro');
      return;
    }
    this.prepareDay();
    this.setPhase('intro');
  }

  async doubleGrant(): Promise<boolean> {
    if (this.report.doubled) return false;
    const ok = await Platform.rewarded();
    if (ok) {
      this.report.doubled = true;
      this.money += this.report.grant;
      if (this.levelDone && this.save.growthRun) {
        // the next level is already saved: the bonus goes with it
        this.save.growthRun.money += this.report.grant;
        storeSave(this.save, true);
      } else this.persist(true);
      Audio.cash();
    }
    return ok;
  }

  retryDay(): void {
    // reload the city from the saved run at the start of the day
    const run = this.runSave;
    this.loadCity(this.preset.id, run && run.city === this.preset.id ? run : null, false, false);
    this.setPhase('intro');
  }

  async secondChance(): Promise<boolean> {
    const ok = await Platform.rewarded();
    if (!ok) return false;
    // clear the worst jams and restore patience
    for (const v of this.sim.vehicles.slice()) if (v.stuckT > 20 || v.state === 'crashed') this.sim.removeVehicle(v, 'cleared');
    for (const inc of this.incidents) this.sim.clearCrash(inc.vehicles);
    this.incidents = [];
    this.sat = 45;
    this.setPhase('playing');
    Platform.gameplayStart();
    return true;
  }

  persist(immediate = false): void {
    if (this.menuMode || this.levelDone) return;
    const snap = snapshotNetwork(this.city.net);
    const run: RunSave = {
      city: this.preset.id,
      day: this.day,
      money: Math.round(this.money),
      sat: this.sat,
      policies: [...this.policies],
      preempt: this.preempt,
      ...snap,
      totalTrips: this.totalTrips,
      stars: this.starsHistory,
      waves: this.sim.waves.corridors.map((c) => ({ name: c.name, dir: c.dir })),
    };
    if (this.growth) this.save.growthRun = run;
    else this.save.run = run;
    this.save.lastMode = this.growth ? 'growth' : 'campaign';
    storeSave(this.save, immediate);
  }

  private addScore(part: keyof ScoreParts, pts: number, x?: number, y?: number): void {
    if (!this.growth) return;
    const before = this.score;
    this.score += pts;
    this.scoreParts[part] += pts;
    // cheer when the target and the extra stars are reached
    const target = growthLevel(this.day).target;
    if (before < target && this.score >= target) {
      this.ui?.toast(`🎯 ${t('targetReached')}`, 'good');
      Audio.success();
    } else if (before < target * STAR2 && this.score >= target * STAR2) this.ui?.toast(`⭐⭐ ${t('starReached', { n: 2 })}`, 'good');
    else if (before < target * STAR3 && this.score >= target * STAR3) this.ui?.toast(`⭐⭐⭐ ${t('starReached', { n: 3 })}`, 'good');
    if (x !== undefined && y !== undefined && Math.abs(pts) >= 20) this.ui?.floatText(x, y, `${pts > 0 ? '+' : ''}${pts} ★`, pts > 0 ? '#ffd166' : '#ff8a6b');
  }

  // ---------------------------------------------------------------- update

  get hour(): number {
    return hourAt(this.dayT);
  }

  rainNow(): number {
    const r = this.cfg?.rain;
    if (!r) return 0;
    const h = this.hour;
    if (h < r[0] || h > r[1]) return 0;
    return clamp(Math.min(h - r[0], r[1] - h) * 2.5, 0, 1);
  }

  update(realDt: number): void {
    const playing = this.phase === 'playing';
    const scale = playing ? this.speed : this.menuMode || this.phase === 'intro' ? 0.6 : 0;
    let simDt = Math.min(realDt, 0.1) * scale;
    while (simDt > 1e-5) {
      const h = Math.min(simDt, 1 / 30);
      this.simStep(h, !playing);
      simDt -= h;
    }
    if (this.follow) {
      if (this.follow.state === 'gone') this.follow = null;
      else this.renderer.rig.focus(this.follow.x, this.follow.y);
    }
    const hour = this.menuMode ? 8 + Math.sin(performance.now() / 60000) * 0.3 : this.hour;
    this.renderer.frame(realDt, hour, this.sim.rain, this.sim);
    this.updateAudio();
    this.onTick?.();
  }

  private simStep(dt: number, passive: boolean): void {
    const hour = this.hour;
    const peak = (hour > 7 && hour < 9.5) || (hour > 16.3 && hour < 19);
    let demandScale = 1;
    if (this.policies.has('flex') && peak) demandScale = 0.85;
    this.demand.update(dt * demandScale, hour);
    this.sim.rain = this.rainNow();
    this.sim.step(dt);
    if (!passive) this.dayT += dt;
    else if (this.menuMode) this.dayT += dt * 0.2;
    this.handleEvents(passive);
    if (passive) return;
    this.updateSatisfaction(dt);
    this.updateIncidents(dt);
    this.updateEmergencies(dt);
    this.updateEvents(dt, hour);
    if (this.dayT >= DAY_LENGTH) this.endDay();
  }

  private handleEvents(passive: boolean): void {
    const evs = this.sim.events;
    if (!evs.length) return;
    for (const e of evs) this.onSimEvent(e, passive);
    evs.length = 0;
  }

  private onSimEvent(e: SimEvent, passive: boolean): void {
    if (passive) return;
    switch (e.type) {
      case 'trip': {
        const score = tripScore(e.time, e.ff);
        this.addScore('trips', tripPoints(e.time, e.ff));
        this.scoreParts.tripCount++;
        this.sat += (score - this.sat) * 0.018;
        const toll = Math.round(3 + (score / 100) * 4);
        this.money += toll;
        // occasional floating income near the camera
        const now = performance.now();
        if (now - this.lastPopup > 650) {
          const rig = this.renderer.rig;
          if (Math.hypot(e.v.x - rig.target.x, e.v.y - rig.target.z) < rig.viewRadius * 0.9) {
            this.lastPopup = now;
            this.ui?.floatText(e.v.x, e.v.y, `+$${toll}`, score > 70 ? '#7dffa8' : score > 40 ? '#ffe08a' : '#ff9a8a');
          }
        }
        this.stats.income += toll;
        this.stats.trips++;
        this.stats.tripTime += e.time;
        this.stats.ffTime += e.ff;
        this.totalTrips++;
        break;
      }
      case 'abandon':
        this.sat -= 0.9;
        this.stats.abandoned++;
        this.addScore('abandoned', SCORE.abandon);
        break;
      case 'crash': {
        this.sat -= 2.5;
        this.stats.crashes++;
        this.addScore('crashes', SCORE.crash, e.x, e.y);
        const where = e.node ? e.node.name : this.roadNameAt(e.vehicles[0]);
        const inc: Incident = { id: INC_ID++, vehicles: e.vehicles, x: e.x, y: e.y, age: 0, clearAfter: 150, tow: null, towWork: 0, where };
        this.incidents.push(inc);
        Audio.crash();
        this.ui?.toast(e.node ? t('redRunCrash', { r: where }) : t('accidentAt', { r: where }), 'bad', {
          label: t('show'),
          fn: () => this.focusIncident(inc),
        });
        break;
      }
      case 'horn': {
        const s = this.renderer.toScreen(e.x, e.y);
        if (s.visible && this.renderer.rig.dist < 450) {
          const w = this.renderer.container.clientWidth || 1;
          Audio.horn((s.x / w) * 2 - 1, clamp(1 - this.renderer.rig.dist / 450, 0.2, 1));
        }
        break;
      }
      case 'emergencyArrived': {
        const ff = this.emergencies.get(e.v) ?? e.time;
        this.emergencies.delete(e.v);
        this.stats.emergencies++;
        if (e.time < ff * 1.9 + 10) {
          this.stats.emergenciesFast++;
          const bonus = 400;
          this.money += bonus;
          this.stats.income += bonus;
          this.sat = Math.min(100, this.sat + 1.5);
          this.addScore('emergency', SCORE.emergencyFast, e.v.x, e.v.y);
          this.ui?.toast(t('ambulanceFast', { m: `$${bonus}` }), 'good');
          Audio.cash();
        } else {
          this.sat -= 3;
          this.addScore('emergency', SCORE.emergencySlow, e.v.x, e.v.y);
          this.ui?.toast(t('ambulanceSlow'), 'warn');
        }
        break;
      }
      case 'towDone':
        break;
      case 'busStop':
        this.money += e.passengers;
        this.stats.passengers += e.passengers;
        this.stats.income += e.passengers;
        break;
      case 'redrun':
        break;
    }
  }

  private updateSatisfaction(dt: number): void {
    let furious = 0;
    for (const v of this.sim.vehicles) if (v.mood > 0.5) furious++;
    // waiting vehicles slowly erode satisfaction
    this.sat -= Math.min(0.5, furious * 0.005) * dt;
    const homeQ = this.demand.waitingAtHome() + this.sim.gatewayBacklog();
    this.sat -= Math.min(0.25, homeQ * 0.002) * dt;
    // trips that could not even start (street in front of the house jammed)
    const blocked = this.demand.stats.blocked;
    if (blocked > this.lastBlocked) {
      this.sat -= (blocked - this.lastBlocked) * 0.45;
      this.addScore('blocked', (blocked - this.lastBlocked) * SCORE.blocked);
      this.lastBlocked = blocked;
    }
    this.sat = clamp(this.sat, 0, 100);
    this.stats.satArea += this.sat * dt;
    this.stats.satTime += dt;
    this.stats.minSat = Math.min(this.stats.minSat, this.sat);
    Audio.tension = 1 - this.sat / 100;
    this.warnT -= dt;
    if (this.sat < 20 && this.warnT <= 0) {
      this.warnT = 40;
      Audio.alert();
      this.ui?.toast(t('furious'), 'bad', undefined, 'furious');
    }
    if (this.sat <= 0 && this.phase === 'playing') {
      Audio.fail();
      this.setPhase('fired');
    }
  }

  private updateIncidents(dt: number): void {
    // random accidents
    const n = this.sim.vehicles.length;
    const rate = this.cfg.accidentRate * (n / 150) * (1 + this.sim.rain * 1.5) * (this.policies.has('safety') ? 0.55 : 1) * 0.0022;
    this.accidentAcc += rate * dt;
    if (this.accidentAcc > 1) {
      this.accidentAcc = 0;
      this.sim.randomCrash();
    } else if (this.rng.next() < rate * dt) {
      this.sim.randomCrash();
    }
    for (const inc of this.incidents.slice()) {
      inc.age += dt;
      if (inc.tow) {
        const tw = inc.tow;
        if (tw.state === 'gone') {
          // reached its destination (parked next to the wreck)
          inc.towWork = 99;
        } else if (Math.hypot(tw.x - inc.x, tw.y - inc.y) < 22 && tw.v < 1.5) inc.towWork += dt;
        if (inc.towWork > 5) {
          this.resolveIncident(inc);
          if (tw.state !== 'gone') this.sim.removeVehicle(tw, 'cleared');
          continue;
        }
      }
      if (inc.age > inc.clearAfter) this.resolveIncident(inc);
    }
  }

  private resolveIncident(inc: Incident): void {
    this.sim.clearCrash(inc.vehicles);
    this.incidents.splice(this.incidents.indexOf(inc), 1);
    this.ui?.toast(t('cleared'), 'good');
    this.ui?.refreshPanel();
  }

  private updateEmergencies(dt: number): void {
    if (!this.cfg.emergencies) return;
    const h = this.hour;
    if (h < 6.5 || h > 21.5) return;
    this.emergencyT -= dt;
    if (this.emergencyT > 0) return;
    this.emergencyT = 110 + this.rng.next() * 90;
    const targets = this.city.buildings.filter((b) => b.day <= this.day && b.pop > 0);
    if (!targets.length) return;
    const tgt = this.rng.pick(targets);
    const from = this.city.hospital;
    const dest = this.demand.destFor(tgt);
    if (!dest) return;
    let v: Vehicle | null = null;
    if (from && dist(from, tgt) > 150) {
      const od = this.demand.destFor(from);
      if (od) v = this.sim.trySpawn({ kind: 'ambulance', model: MODEL.ambulance, link: od.link, s: od.s, side: od.side, dest, goal: dest.link, siren: true });
    }
    if (!v) {
      const entries = this.demand.entries;
      if (!entries.length) return;
      let best = entries[0];
      let bd = Infinity;
      for (const e of entries) {
        const d = dist(e.from, tgt);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      v = this.sim.trySpawn({ kind: 'ambulance', model: MODEL.ambulance, link: best, dest, goal: dest.link, siren: true });
    }
    if (!v) return;
    v.nav = true;
    v.boxBlock = false;
    v.redRun = false;
    this.emergencies.set(v, v.ffTime / 0.85);
    this.ui?.toast(t('ambulance'), 'info', { label: t('show'), fn: () => this.selectVehicle(v!) });
  }

  private updateEvents(dt: number, hour: number): void {
    if (!this.rushNotified.am && hour >= 7.1) {
      this.rushNotified.am = true;
      this.ui?.toast(t('rushStart'), 'warn');
      Audio.alert();
    }
    if (!this.rushNotified.pm && hour >= 16.4) {
      this.rushNotified.pm = true;
      this.ui?.toast(t('rushStart'), 'warn');
      Audio.alert();
    }
    const r = this.cfg.rain;
    if (r && !this.rainNotified && hour >= r[0]) {
      this.rainNotified = true;
      this.ui?.toast(t('rainStart'), 'info');
    }
    const ev = this.cfg.event;
    if (ev && !this.eventNotified && hour >= ev.hour - 0.4) {
      this.eventNotified = true;
      const b = this.eventBuilding();
      if (b) {
        this.demand.hotspot = { b, until: ev.until, rate: ev.rate };
        this.ui?.toast(t('eventStart', { b: this.roadNameOfBuilding(b) }), 'warn', { label: t('show'), fn: () => this.renderer.rig.focus(b.x, b.y, 180) });
      }
    }
    // emergency signal pre-emption
    if (this.preempt) {
      for (const v of this.sim.vehicles) {
        if (!v.siren || !v.seg.isLane) continue;
        const c = v.plan[0] as Conn | undefined;
        if (!c || c.isLane) continue;
        const n = c.node;
        if (n.signal && v.seg.len - v.s < 90) {
          n.signal.preemptConn = c;
          n.signal.preemptT = 6;
        }
      }
    }
    this.hotT -= dt;
    if (this.hotT <= 0) {
      this.hotT = 2;
      this.hotNodes = this.city.net.nodes.filter((n) => !n.gateway && n.arms.length >= 3 && n.delayEMA > 50 && n.passed > 5);
    }
    this.tipT -= dt;
    if (this.tipT <= 0) {
      this.tipT = 25;
      this.advisor();
    }
    this.autosaveT += dt;
  }

  private eventBuilding(): Building | null {
    const big = this.city.buildings.filter((b) => b.day <= this.day && (b.kind === 'office' || b.kind === 'tower' || b.kind === 'shop') && b.w * b.d > 400);
    if (!big.length) return null;
    big.sort((a, b) => b.w * b.d * b.h - a.w * a.d * a.h);
    return big[this.day % Math.min(3, big.length)];
  }

  /** contextual tips about the worst junction */
  private advisor(): void {
    let worst: Node | null = null;
    for (const n of this.city.net.nodes) {
      if (n.gateway || n.arms.length < 3 || n.passed < 6) continue;
      if (n.delayEMA < 40) continue;
      if (!worst || n.delayEMA > worst.delayEMA) worst = n;
    }
    if (!worst) return;
    let key: StrKey | null = null;
    const n = worst;
    // diagnose
    let gapWait = 0;
    let boxStuck = 0;
    let leftBlock = 0;
    for (const arm of n.arms) {
      const l = arm.inLink;
      if (!l) continue;
      for (const lane of l.lanes) {
        const f = lane.vehs[lane.vehs.length - 1];
        if (!f || lane.len - f.s > 4) continue;
        if (f.holdWhy === 'gap' && f.holdLine) gapWait++;
        const c = f.plan[0] as Conn | undefined;
        if (c && !c.isLane && (c.turn === 'L' || c.sig === SIG_P) && (lane.arrows & 2) && lane.vehs.length > 3) leftBlock++;
      }
    }
    for (const c of n.conns) for (const v of c.vehs) if (v.v < 0.3) boxStuck++;
    if (n.control === 'allstop') key = 'tipAllStop';
    else if (boxStuck >= 2 && !n.box && this.unlocks.has('box')) key = 'tipBox';
    else if (n.control === 'priority' && gapWait > 0) key = 'tipMinorGap';
    else if (n.control === 'signal' && leftBlock > 0 && this.unlocks.has('arrows')) key = 'tipLeftLane';
    else if (n.control === 'signal') key = 'tipSignalSplit';
    if (!key) return;
    const id = `${key}:${n.id}`;
    if (this.tipsShown.has(id)) return;
    this.tipsShown.add(id);
    this.ui?.toast(t(key, { r: n.name }), 'info', { label: t('show'), fn: () => this.selectNode(n) }, 'tip');
  }

  private updateAudio(): void {
    const rig = this.renderer.rig;
    const near = clamp(1 - rig.dist / 700, 0.05, 1);
    let count = 0;
    let siren = 0;
    for (const v of this.sim.vehicles) {
      const dx = v.x - rig.target.x;
      const dy = v.y - rig.target.z;
      const d = Math.hypot(dx, dy);
      if (d < rig.viewRadius) count++;
      if (v.siren && d < rig.viewRadius * 1.2) siren = Math.max(siren, 1 - d / (rig.viewRadius * 1.2));
    }
    Audio.update(clamp(count / 60, 0, 1) * near, this.sim.rain, siren * near, performance.now() / 1000);
  }

  // ---------------------------------------------------------------- picking

  pick(cx: number, cy: number): void {
    if (this.phase !== 'playing' && this.phase !== 'intro') return;
    const p = this.renderer.rig.groundAt(cx, cy);
    if (!p) return;
    const x = p.x;
    const y = p.z;
    // vehicles
    let bestV: Vehicle | null = null;
    let bd = 3.2;
    for (const v of this.sim.vehicles) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < bd) {
        bd = d;
        bestV = v;
      }
    }
    if (bestV) {
      this.selectVehicle(bestV);
      return;
    }
    const n = this.nodeAt(x, y);
    if (n) {
      this.selectNode(n);
      return;
    }
    const r = this.roadAt(x, y);
    if (r) {
      this.select({ kind: 'road', road: r });
      Audio.select();
      return;
    }
    this.select(null);
  }

  private hover(cx: number, cy: number): void {
    const p = this.renderer.rig.groundAt(cx, cy);
    this.renderer.overlays.hoverNode = p ? this.nodeAt(p.x, p.z) : null;
    this.renderer.renderer.domElement.style.cursor = this.renderer.overlays.hoverNode ? 'pointer' : '';
  }

  nodeAt(x: number, y: number): Node | null {
    let best: Node | null = null;
    let bd = Infinity;
    for (const n of this.city.net.nodes) {
      if (n.gateway || n.arms.length < 3) continue;
      const r = Math.max(...n.arms.map((a) => a.trim));
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < r && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  roadAt(x: number, y: number): Road | null {
    let best: Road | null = null;
    let bd = Infinity;
    for (const r of this.city.net.roads) {
      if (r.a.gateway || r.b.gateway) continue;
      const pr = r.center.project(x, y);
      if (pr.s < r.armA.trim || pr.s > r.length - r.armB.trim) continue;
      if (pr.d < r.width / 2 + 2 && pr.d < bd) {
        bd = pr.d;
        best = r;
      }
    }
    return best;
  }

  select(s: Selection): void {
    this.selection = s;
    this.follow = null;
    this.renderer.overlays.setSelection(s);
    this.refreshWaveOverlay();
    this.ui?.refreshPanel();
  }

  selectNode(n: Node): void {
    this.select({ kind: 'node', node: n });
    const rig = this.renderer.rig;
    rig.focus(n.x, n.y, Math.min(rig.dist, 170));
    Audio.select();
    this.ui?.tutorialEvent('selectNode:' + n.id);
  }

  selectVehicle(v: Vehicle): void {
    this.select({ kind: 'vehicle', v });
    Audio.select();
  }

  focusIncident(inc: Incident): void {
    this.renderer.rig.focus(inc.x, inc.y, 120);
    const v = inc.vehicles[0];
    if (v && v.state === 'crashed') this.select({ kind: 'vehicle', v });
  }

  incidentOf(v: Vehicle): Incident | null {
    return this.incidents.find((i) => i.vehicles.includes(v)) ?? null;
  }

  roadNameAt(v: Vehicle): string {
    if (v.seg.isLane) return (v.seg as Lane).link.road.name;
    return (v.seg as Conn).node.name;
  }

  roadNameOfBuilding(b: Building): string {
    return b.road.name;
  }

  // ---------------------------------------------------------------- actions

  canAfford(cost: number): boolean {
    return this.money >= cost;
  }

  private pay(cost: number, x?: number, y?: number): boolean {
    if (cost <= 0) return true;
    if (this.money < cost) {
      Audio.error();
      this.ui?.toast(t('notEnough'), 'bad', undefined, 'money');
      return false;
    }
    this.money -= cost;
    this.stats.spent += cost;
    if (x !== undefined && y !== undefined) this.ui?.floatText(x, y, `-$${cost}`, '#ff8a6b');
    Audio.build();
    return true;
  }

  controlCost(n: Node, c: Control): number {
    if (c === n.control) return 0;
    switch (c) {
      case 'signal':
        return COST.signal;
      case 'roundabout':
        return n.arms.some((a) => a.road.cls !== 'local') ? COST.roundaboutMajor : COST.roundaboutLocal;
      case 'allstop':
        return COST.allstop;
      default:
        return COST.priority;
    }
  }

  canRoundabout(n: Node): boolean {
    return n.arms.length >= 3 && n.maxRoundaboutR >= 9;
  }

  setControl(n: Node, c: Control): boolean {
    if (n.control === c) return true;
    if (c === 'roundabout' && !this.canRoundabout(n)) {
      this.ui?.toast(t('noRoom'), 'warn');
      return false;
    }
    const cost = this.controlCost(n, c);
    if (!this.pay(cost, n.x, n.y)) return false;
    const wasRA = n.control === 'roundabout';
    if (c === 'priority' && n.majorRoads.size === 0) pickMajorAxis(n);
    this.sim.setControl(n, c);
    if (n.signal && c === 'signal') {
      n.signal.mode = 'fixed';
      this.autoTime(n, true);
    }
    this.renderer.world.refresh({ roads: wasRA || c === 'roundabout', blocks: wasRA || c === 'roundabout' });
    if (wasRA || c === 'roundabout') this.renderer.peds?.build(this.city);
    this.renderer.overlays.buildTraffic(this.city.net);
    this.renderer.overlays.setSelection(this.selection);
    this.sim.waves.update(0, this.sim.signalNodes);
    this.refreshWaveOverlay();
    this.afterChange();
    this.ui?.tutorialEvent('control:' + c);
    return true;
  }

  setStopMinor(n: Node, stop: boolean): void {
    if (n.stopMinor === stop) return;
    if (!this.pay(COST.priority, n.x, n.y)) return;
    n.stopMinor = stop;
    this.sim.rebuildNode(n);
    this.renderer.world.refresh();
    this.afterChange();
  }

  /** make the road through arms a and b (straight on or turning) the major road of a priority junction */
  setMajor(n: Node, a: Arm, b: Arm): void {
    const next = [a.road.id, b.road.id];
    if (n.majorRoads.size === 2 && next.every((id) => n.majorRoads.has(id))) return;
    if (!this.pay(COST.priority, n.x, n.y)) return;
    n.majorRoads = new Set(next);
    this.sim.rebuildNode(n);
    this.renderer.world.refresh();
    this.renderer.overlays.setSelection(this.selection);
    this.afterChange();
  }

  setPlan(n: Node, plan: PlanType): void {
    if (!n.signal || n.signal.plan === plan) return;
    n.signal.setPlan(plan);
    this.autoTime(n, true);
    n.signal.safeRestart();
    Audio.click();
    this.afterChange();
  }

  setMode(n: Node, mode: SigMode): void {
    const s = n.signal;
    if (!s || s.mode === mode) return;
    const cost = mode === 'actuated' ? COST.actuated : mode === 'smart' ? COST.smart : 0;
    if (!this.pay(cost, n.x, n.y)) return;
    s.mode = mode;
    // the AI starts from a plan fitted to recent traffic and refines it every cycle
    if (mode === 'smart') s.autoTime();
    this.afterChange();
  }

  setPhaseDur(n: Node, i: number, sec: number): void {
    const s = n.signal;
    if (!s || !s.phases[i] || s.mode === 'smart') return;
    s.phases[i].dur = clamp(Math.round(sec), 4, 90);
    this.afterChange(false);
  }

  setAllRed(n: Node, v: number): void {
    if (!n.signal) return;
    n.signal.allRed = clamp(v, 0.5, 4);
    this.afterChange(false);
  }

  toggleRTOR(n: Node): void {
    if (!n.rtor && !this.pay(COST.rtor, n.x, n.y)) return;
    n.rtor = !n.rtor;
    this.afterChange();
  }

  toggleBox(n: Node): void {
    if (!n.box && !this.pay(COST.box, n.x, n.y)) return;
    n.box = !n.box;
    this.renderer.world.buildMarkings();
    this.afterChange();
  }

  /** Webster-style split based on measured approach demand */
  autoTime(n: Node, silent = false): void {
    const s = n.signal;
    if (!s) return;
    s.autoTime();
    if (!silent) {
      Audio.click();
      this.afterChange(false);
    }
  }

  /** coordinate signals along the main road through this junction */
  /** start or stop the green wave along a street through this junction */
  toggleWave(n: Node, street: string): void {
    const w = this.sim.waves;
    if (w.get(street)) {
      w.remove(street);
      Audio.click();
    } else {
      if (!this.pay(COST.greenwave, n.x, n.y)) return;
      w.add(street);
      this.ui?.toast(t('waveOn', { r: street }), 'good');
    }
    w.update(0, this.sim.signalNodes);
    this.refreshWaveOverlay();
    this.afterChange();
  }

  setWaveDir(street: string, dir: number): void {
    this.sim.waves.setDir(street, dir);
    this.sim.waves.update(0, this.sim.signalNodes);
    this.afterChange();
  }

  /** highlight the green-wave streets through the selected junction */
  refreshWaveOverlay(): void {
    const s = this.selection;
    const roads = s && s.kind === 'node' ? this.sim.waves.at(s.node).flatMap((c) => this.sim.waves.span(c)) : [];
    this.renderer.overlays.setWaves(roads);
  }

  laneOptions(lane: Lane): number[] {
    const n = lane.link.to;
    const arm = lane.link.toArm;
    const avail = availableBits(movementsFor(n, arm));
    const arr = lane.link.lanes.map((l) => l.arrows);
    return arrowOptions(arr, lane.index, avail);
  }

  cycleArrows(lane: Lane): void {
    const opts = this.laneOptions(lane);
    if (opts.length < 2) return;
    const i = opts.indexOf(lane.arrows);
    const next = opts[(i + 1) % opts.length];
    const n = lane.link.to;
    if (!this.pay(COST.arrows, n.x, n.y)) return;
    const old = lane.arrows;
    lane.arrows = next;
    this.sim.rebuildNode(n);
    if (!stronglyConnected(this.city.net)) {
      lane.arrows = old;
      this.sim.rebuildNode(n);
      this.money += COST.arrows;
      this.ui?.toast(t('wouldDisconnect'), 'warn');
      return;
    }
    this.renderer.world.refresh();
    this.afterChange();
  }

  /** cost of re-striping a road to ab / ba lanes, widening it when they do not fit */
  restripeCost(r: Road, ab: number, ba: number): number {
    const extra = slotsFor(r, ab, ba) - r.maxLanes;
    return extra > 0 ? extra * COST.widen : COST.restripe;
  }

  /** why the road cannot be widened to carry `slots` lanes, or null when it can */
  widenBlocker(r: Road, slots: number): WidenBlock | null {
    if (slots <= r.maxLanes) return null;
    if (r.bridge) return 'bridge';
    if (slots > maxSlotsOf(r)) return 'max';
    // dry run of the curb corners: the streets meeting at both ends need room for a queue
    const ends = [r.a, r.b];
    const before = new Map<Road, number>();
    for (const n of ends) for (const arm of n.arms) before.set(arm.road, arm.road.trimmedLength);
    const old = r.maxLanes;
    setRoadSlots(r, slots);
    for (const n of ends) computeCorners(n);
    let short = false;
    for (const [rd, len] of before) if (rd.trimmedLength < 20 && rd.trimmedLength < len - 0.5) short = true;
    setRoadSlots(r, old);
    for (const n of ends) computeCorners(n);
    if (short) return 'short';
    // buildings and car parks keep at least a narrow sidewalk
    for (const b of this.city.buildings) if (crowdsRoad(r, slots, b.x, b.y, b.w / 2, b.d / 2, b.ux, b.uy)) return 'buildings';
    for (const bl of this.city.blocks) for (const pk of bl.parking) if (crowdsRoad(r, slots, pk.cx, pk.cy, pk.hw, pk.hh, pk.ux, pk.uy)) return 'buildings';
    return null;
  }

  restripe(r: Road, ab: number, ba: number): boolean {
    if (ab === r.lanesAB && ba === r.lanesBA) return true;
    const slots = Math.max(r.maxLanes, slotsFor(r, ab, ba));
    const widen = slots > r.maxLanes;
    const why = widen ? this.widenBlocker(r, slots) : null;
    if (why) {
      Audio.error();
      this.ui?.toast(t(`widen_${why}` as StrKey), 'warn');
      return false;
    }
    const cost = this.restripeCost(r, ab, ba);
    if (!this.canAfford(cost)) {
      this.pay(cost);
      return false;
    }
    const ok = widen ? this.sim.reshapeRoad(r, slots, ab, ba) : this.sim.restripe(r, ab, ba);
    if (!ok) {
      Audio.error();
      this.ui?.toast(t('wouldDisconnect'), 'warn');
      return false;
    }
    this.pay(cost, (r.a.x + r.b.x) / 2, (r.a.y + r.b.y) / 2);
    if (widen) {
      // the carriageway, its corners and everything along the curb move
      this.renderer.rebuildWorld(this.day);
      this.ui?.toast(t('widened', { r: r.name }), 'good');
    }
    this.afterRoadChange(r, !widen);
    return true;
  }

  setSpeed(r: Road, kmh: number): void {
    const ms = kmh / 3.6;
    if (Math.abs(r.speed - ms) < 0.1) return;
    if (!this.pay(COST.speed, (r.a.x + r.b.x) / 2, (r.a.y + r.b.y) / 2)) return;
    this.sim.restripe(r, r.lanesAB, r.lanesBA, r.busAB, r.busBA, ms, false);
    this.afterRoadChange(r);
  }

  toggleBus(r: Road, forward: boolean): void {
    const ab = forward ? !r.busAB : r.busAB;
    const ba = forward ? r.busBA : !r.busBA;
    const turningOn = forward ? !r.busAB : !r.busBA;
    if (turningOn && !this.pay(COST.bus, (r.a.x + r.b.x) / 2, (r.a.y + r.b.y) / 2)) return;
    this.sim.restripe(r, r.lanesAB, r.lanesBA, ab, ba, r.speed, false);
    this.afterRoadChange(r);
  }

  private afterRoadChange(r: Road, refresh = true): void {
    if (refresh) this.renderer.world.refresh();
    this.renderer.overlays.buildTraffic(this.city.net);
    this.renderer.overlays.setSelection({ kind: 'road', road: r });
    this.afterChange();
    void ROAD_SPECS;
  }

  dispatchTow(inc: Incident): void {
    if (inc.tow) return;
    if (!this.pay(COST.tow, inc.x, inc.y)) return;
    const wreck = inc.vehicles[inc.vehicles.length - 1];
    let link: Link | null = null;
    let laneIdx = 0;
    let s = 10;
    if (wreck.seg.isLane) {
      const lane = wreck.seg as Lane;
      link = lane.link;
      laneIdx = lane.index;
      s = Math.max(4, wreck.s - wreck.len - 7);
    } else {
      const c = wreck.seg as Conn;
      if (c.fromLane) {
        link = c.fromLane.link;
        laneIdx = c.fromLane.index;
        s = c.fromLane.len - 3;
      }
    }
    if (!link) return;
    // spawn at the gateway / depot nearest to the incident
    const entries = this.demand.entries;
    let best = entries[0];
    let bd = Infinity;
    for (const e of entries) {
      const d = Math.hypot(e.from.x - inc.x, e.from.y - inc.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    const dest = { link, lane: laneIdx, s, building: -1, side: 1 as const };
    const fire = this.city.fireStation;
    let v: Vehicle | null = null;
    if (fire) {
      const od = this.demand.destFor(fire);
      if (od) v = this.sim.trySpawn({ kind: 'tow', model: MODEL.tow, link: od.link, s: od.s, side: od.side, dest, goal: link });
    }
    if (!v && best) v = this.sim.trySpawn({ kind: 'tow', model: MODEL.tow, link: best, dest, goal: link });
    if (!v) {
      // could not spawn now: police take a bit longer
      this.money += COST.tow;
      return;
    }
    v.tow = { target: inc.vehicles, phase: 'go', t: 0 };
    v.nav = true;
    v.boxBlock = false;
    v.redRun = false;
    v.aggr = 0.6;
    inc.tow = v;
    inc.clearAfter = Math.max(inc.clearAfter, inc.age + 240);
    this.ui?.toast(t('towOnWay'), 'info');
    this.ui?.refreshPanel();
  }

  /** traffic police untangle a gridlocked junction */
  sendPolice(n: Node): void {
    const until = this.policeCooldown.get(n.id) ?? 0;
    if (this.sim.time < until) return;
    if (!this.pay(COST.police, n.x, n.y)) return;
    let cleared = 0;
    for (const c of [...n.conns, ...n.dying]) {
      for (const v of c.vehs.slice()) {
        if (v.v < 0.6 && !v.emergency && v.state === 'drive') {
          this.sim.removeVehicle(v, 'cleared');
          cleared++;
        }
      }
    }
    for (const a of n.arms) {
      for (const l of a.inLink?.lanes ?? []) {
        for (const v of l.vehs.slice()) {
          if (v.stuckT > 18 && !v.emergency && v.state === 'drive') {
            this.sim.removeVehicle(v, 'cleared');
            cleared++;
          }
        }
      }
    }
    this.policeCooldown.set(n.id, this.sim.time + 45);
    this.ui?.toast(`🚓 ${t('policeDone', { n: cleared })}`, 'good');
    this.afterChange(false);
  }

  togglePolicy(id: string): void {
    if (this.policies.has(id)) this.policies.delete(id);
    else this.policies.add(id);
    Audio.click();
    this.demand.scale = this.cfg.demand * (this.policies.has('transit') ? 0.9 : 1);
    this.sim.aggressionBias = this.cfg.aggression - (this.policies.has('safety') ? 0.08 : 0);
    this.afterChange();
  }

  togglePreempt(): void {
    if (!this.preempt && !this.pay(COST.preempt)) return;
    this.preempt = !this.preempt;
    this.afterChange();
  }

  private afterChange(save = true): void {
    this.ui?.refreshPanel();
    if (save) this.persist();
  }

  // ---------------------------------------------------------------- speed

  setSpeedMul(s: number): void {
    if (this.phase !== 'playing') return;
    if (s === 0 && this.speed !== 0) this.prevSpeed = this.speed;
    this.speed = s;
    this.ui?.refreshPanel();
  }

  togglePause(): void {
    this.setSpeedMul(this.speed === 0 ? this.prevSpeed || 1 : 0);
  }

  /** helper for the UI: current waiting reason of a vehicle */
  vehicleStatus(v: Vehicle): StrKey {
    if (v.state === 'crashed') return 'st_crashed';
    if (v.state === 'park') return 'st_park';
    if (v.bus && v.bus.dwell > 0) return 'st_bus';
    if (v.v > 1.5) return 'st_moving';
    if (v.holdLine) {
      switch (v.holdWhy) {
        case 'red':
          return 'st_red';
        case 'stop':
          return 'st_stop';
        case 'gap':
          return 'st_gap';
        case 'box':
          return 'st_box';
        case 'turn':
          return 'st_turn';
      }
    }
    return 'st_queue';
  }

  presetById(id: string): CityPreset {
    return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  }
}

export { PRESETS };
