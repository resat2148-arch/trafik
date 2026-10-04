// Modal screens: main menu, city select, day intro / report, fired, complete,
// settings, help, pause and policies.

import type { Game, Phase } from '../game/game.ts';
import { PRESETS } from '../world/citygen.ts';
import type { CityPreset } from '../world/citygen.ts';
import { getLang, money, num, setLang, t } from '../game/i18n.ts';
import type { StrKey } from '../game/i18n.ts';
import { COST, POLICIES, STAR2, STAR3, TUTORIAL_UNLOCKS, dayConfig, growthDayConfig } from '../game/config.ts';
import { GROWTH_LEVELS, growthLevel } from '../world/growth.ts';
import { ACHIEVEMENTS, ACH_NEED } from '../game/achievements.ts';
import type { AchDef } from '../game/achievements.ts';
import { PERKS, perkById } from '../game/perks.ts';
import type { PerkId } from '../game/perks.ts';
import type { Building } from '../world/citygen.ts';
import { fmtHour } from '../game/clock.ts';
import { storeSave, defaultSave } from '../game/save.ts';
import { Audio } from '../audio/audio.ts';
import { Platform } from '../platform/crazygames.ts';
import { ICON, h, svg } from './dom.ts';
import type { UI } from './ui.ts';

const UNLOCK_NAMES: Record<string, StrKey> = {
  signal: 'ctrl_signal',
  allstop: 'ctrl_allstop',
  priority: 'ctrl_priority',
  timing: 'phases',
  arrows: 'approaches',
  box: 'boxJunction',
  rtor: 'rtor',
  roundabout: 'ctrl_roundabout',
  restripe: 'lanes',
  speed: 'speedLimit',
  bus: 'busLane',
  actuated: 'mode_actuated',
  smart: 'mode_smart',
  greenwave: 'greenWave',
  policies: 'policies',
  preempt: 'emergencyPreempt',
};

export class Menus {
  game: Game;
  ui: UI;
  root: HTMLElement;
  private stack: HTMLElement[] = [];

  constructor(game: Game, ui: UI, root: HTMLElement) {
    this.game = game;
    this.ui = ui;
    this.root = root;
  }

  private clear(): void {
    this.root.innerHTML = '';
    this.stack = [];
  }

  private modal(cls: string, ...children: (HTMLElement | null)[]): HTMLElement {
    const card = h('div', { class: `modal ${cls}` }, ...children);
    const wrap = h('div', { class: 'modal-wrap' }, card);
    this.root.append(wrap);
    this.stack.push(wrap);
    requestAnimationFrame(() => wrap.classList.add('show'));
    return card;
  }

  private closeTop(): void {
    const w = this.stack.pop();
    if (w) w.remove();
  }

  onPhase(p: Phase): void {
    this.clear();
    switch (p) {
      case 'menu':
        this.mainMenu();
        break;
      case 'intro':
        if (this.game.growth) this.levelIntro();
        else this.dayIntro();
        break;
      case 'report':
        if (this.game.growth) this.levelReport();
        else this.dayReport();
        break;
      case 'fired':
        this.fired();
        break;
      case 'complete':
        if (this.game.growth) this.growthComplete();
        else this.complete();
        break;
    }
  }

  // ------------------------------------------------------------------ main

  mainMenu(): void {
    const g = this.game;
    const run = g.save.run;
    const runPreset = run ? PRESETS.find((p) => p.id === run.city) : null;
    const btns = h('div', { class: 'menu-btns' });
    if (run && runPreset) {
      btns.append(
        h(
          'button',
          { class: 'btn big primary', onclick: () => this.startRun(runPreset.id, true) },
          svg(ICON.play2, 26),
          h('span', null, t('continue'), h('small', null, `${runPreset.name[getLang()]} · ${t('day')} ${run.day}`)),
        ),
      );
    } else {
      btns.append(h('button', { class: 'btn big primary', onclick: () => this.startRun('maple', false) }, svg(ICON.play2, 26), t('play')));
    }
    const gp = g.save.growth;
    const gStars = gp.stars.reduce((a, b) => a + (b ?? 0), 0);
    btns.append(
      h(
        'button',
        { class: 'btn big growth-btn', onclick: () => this.growthHub() },
        h('span', { class: 'gb-ico' }, '🏗️'),
        h('span', null, t('growthMode'), h('small', null, g.save.growthRun ? t('levelProgress', { n: g.save.growthRun.day, s: gStars }) : t('growthSub'))),
        g.save.growthRun ? null : h('i', { class: 'new-tag' }, t('growthTag')),
      ),
      h('button', { class: 'btn big', onclick: () => this.citySelect() }, svg(ICON.city, 22), t('cities')),
      h('button', { class: 'btn big', onclick: () => this.achievementsModal() }, h('span', { class: 'gb-ico' }, '🏆'), t('achievements'), h('span', { class: 'ach-count' }, `${achEarned(g.save.ach)}/${ACHIEVEMENTS.length}`)),
      h(
        'div',
        { class: 'row gap center' },
        h('button', { class: 'btn', onclick: () => this.settings() }, svg(ICON.gear, 18), t('settings')),
        h('button', { class: 'btn', onclick: () => this.help() }, svg(ICON.help, 18), t('howToPlay')),
      ),
    );
    const card = h(
      'div',
      { class: 'main-menu' },
      h('div', { class: 'logo' }, h('div', { class: 'logo-top' }, 'GRIDLOCK', h('span', null, 'CITY')), h('div', { class: 'logo-sub' }, t('subtitle'))),
      btns,
      h('div', { class: 'menu-foot' }, '🚦 🚗 🚌 🚑 🚕'),
    );
    const wrap = h('div', { class: 'modal-wrap menu-wrap' }, card);
    this.root.append(wrap);
    this.stack.push(wrap);
    requestAnimationFrame(() => wrap.classList.add('show'));
  }

  startRun(id: string, cont: boolean): void {
    Audio.unlock();
    Audio.click();
    const g = this.game;
    const growth = id === 'growth';
    const run = cont ? (growth ? g.save.growthRun : g.save.run) : null;
    if (!cont) {
      if (growth) g.save.growthRun = null;
      else g.save.run = null;
    }
    this.clear();
    const loading = h('div', { class: 'loading-overlay' }, h('div', { class: 'spinner' }), t('loading'));
    this.root.append(loading);
    Platform.loadingStart();
    setTimeout(() => {
      g.loadCity(id, run, false);
      Platform.loadingStop();
      loading.remove();
      g.setPhase('intro');
    }, 30);
  }

  /** growing city: the career at a glance (levels, stars, best scores) */
  growthHub(): void {
    Audio.click();
    const g = this.game;
    const gp = g.save.growth;
    const run = g.save.growthRun;
    const totalStars = gp.stars.reduce((a, b) => a + (b ?? 0), 0);
    const totalScore = gp.best.reduce((a, b) => a + (b ?? 0), 0);
    const list = h('div', { class: 'lvl-list' });
    const cur = run?.day ?? 1;
    GROWTH_LEVELS.forEach((lv, i) => {
      const n = i + 1;
      const open = n <= Math.max(gp.level, cur);
      const st = gp.stars[i] ?? 0;
      list.append(
        h(
          'div',
          { class: `lvl ${open ? '' : 'locked'} ${n === cur ? 'cur' : ''}` },
          h('span', { class: 'lvl-num' }, open ? String(n) : svg(ICON.lock, 14)),
          h('div', { class: 'lvl-info' }, h('b', null, lv.district[getLang()]), h('span', null, `${t('target')} ${num(lv.target)}${gp.best[i] ? ` · ${t('bestScore')} ${num(gp.best[i])}` : ''}`)),
          h('span', { class: 'lvl-stars' }, ...[0, 1, 2].map((k) => h('i', { class: k < st ? 'on' : '' }, '★'))),
        ),
      );
    });
    // a second tap within a few seconds confirms
    let armed = 0;
    const restart = h('button', { class: 'btn danger', onclick: () => {
      if (Date.now() - armed > 4000) {
        armed = Date.now();
        restart.textContent = t('confirmRestart');
        return;
      }
      g.save.growthRun = null;
      storeSave(g.save, true);
      this.startRun('growth', false);
    } }, t('restartCareer'));
    this.modal(
      'growth-hub',
      h('div', { class: 'intro-city' }, '🏗️ ', t('growthMode')),
      h('p', { class: 'hub-desc' }, t('growthDesc')),
      h('div', { class: 'hub-stats' }, h('div', null, h('span', null, t('rankLbl')), h('b', null, t(rankKey(totalStars)))), h('div', null, h('span', null, t('stars')), h('b', null, `★ ${totalStars} / ${GROWTH_LEVELS.length * 3}`)), h('div', null, h('span', null, t('totalScore')), h('b', null, num(totalScore)))),
      run ? perkStrip(run.perks ?? {}) : null,
      list,
      h(
        'div',
        { class: 'col gap' },
        h('button', { class: 'btn big primary', onclick: () => this.startRun('growth', !!run) }, svg(ICON.play2, 24), run ? t('continueLevel', { n: run.day }) : t('startCareer')),
        h('div', { class: 'row center gap' }, run ? restart : null, h('button', { class: 'btn', onclick: () => this.closeTop() }, t('back'))),
      ),
    );
  }

  /** every achievement: earned ones in colour, the rest with their progress */
  achievementsModal(): void {
    Audio.click();
    const g = this.game;
    const grid = h('div', { class: 'ach-grid' });
    for (const a of ACHIEVEMENTS) {
      const got = !!g.save.ach[a.id];
      const prog = !got && a.goal ? Math.min(1, g.save.life[a.goal.stat] / a.goal.n) : null;
      grid.append(
        h(
          'div',
          { class: `ach-card ${a.tier} ${got ? 'got' : 'locked'}` },
          h('span', { class: 'ach-badge' }, a.icon),
          h(
            'div',
            { class: 'ach-info' },
            h('b', null, t(`ach_${a.id}` as StrKey)),
            h('span', null, achDesc(a)),
            prog !== null ? h('div', { class: 'ach-prog' }, h('i', { style: { width: `${prog * 100}%` } }), h('em', null, `${num(g.save.life[a.goal!.stat])} / ${num(a.goal!.n)}`)) : null,
          ),
          h('span', { class: 'ach-reward' }, got ? '✓' : `+${money(a.reward)}`),
        ),
      );
    }
    this.modal(
      'achievements',
      h('h2', null, '🏆 ', t('achievements'), h('span', { class: 'ach-count big' }, `${achEarned(g.save.ach)}/${ACHIEVEMENTS.length}`)),
      h('p', null, t('achSub')),
      grid,
      h('div', { class: 'row center' }, h('button', { class: 'btn primary', onclick: () => this.closeTop() }, t('close'))),
    );
  }

  /** growing city: pick one of the advantages offered after a level, then carry on */
  perkChoice(after: () => void): void {
    const g = this.game;
    const offer = g.perkChoices;
    if (!offer) {
      after();
      return;
    }
    const passed = (g.save.growthRun?.day ?? g.day) - 1;
    const owned = g.save.growthRun?.perks ?? g.perks;
    let done = false;
    const cards = h('div', { class: 'perk-cards' });
    offer.forEach((id, i) => {
      const p = perkById(id)!;
      const rank = (owned[id] ?? 0) + 1;
      const card = h(
        'button',
        { class: 'perk-card', style: { animationDelay: `${0.1 + i * 0.12}s` }, onclick: () => {
          if (done) return;
          done = true;
          card.classList.add('picked');
          g.pickPerk(id);
          this.ui.toast(`${p.icon} ${t('perkGained', { p: t(`perk_${id}` as StrKey) })}`, 'good');
          setTimeout(() => {
            this.closeTop();
            after();
          }, 650);
        } },
        h('span', { class: 'perk-ico' }, p.icon),
        h(
          'span',
          { class: 'perk-txt' },
          h('b', null, t(`perk_${id}` as StrKey)),
          h('span', { class: 'perk-desc' }, t(`perkDesc_${id}` as StrKey)),
          p.max > 1 ? h('span', { class: 'perk-rank' }, t('perkRank', { r: rank, m: p.max })) : null,
        ),
      );
      cards.append(card);
    });
    this.modal('perks', h('h2', null, '🎁 ', t('perkTitle')), h('p', null, t('perkSub', { n: passed })), cards);
  }

  citySelect(): void {
    const g = this.game;
    const list = h('div', { class: 'city-list' });
    PRESETS.forEach((p, i) => {
      const prog = g.save.progress[p.id];
      const unlocked = !!prog?.unlocked || i === 0;
      const stars = prog?.stars.reduce((a, b) => a + (b ?? 0), 0) ?? 0;
      const card = h(
        'button',
        {
          class: `city-card ${unlocked ? '' : 'locked'}`,
          onclick: () => {
            if (!unlocked) return;
            const cont = g.save.run?.city === p.id;
            this.startRun(p.id, cont);
          },
        },
        h('div', { class: 'city-thumb', style: { background: cityGradient(p, i) } }, unlocked ? h('span', { class: 'city-num' }, String(i + 1)) : svg(ICON.lock, 30)),
        h('div', { class: 'city-info' }, h('b', null, p.name[getLang()]), h('span', null, t('daysCount', { n: p.days })), unlocked ? h('span', { class: 'stars' }, `★ ${stars} / ${p.days * 3}`) : h('span', { class: 'muted' }, t('unlockHint')), prog?.completed ? h('span', { class: 'done' }, t('completed')) : null),
      );
      list.append(card);
    });
    this.modal('cities', h('h2', null, t('cities')), list, h('div', { class: 'row center' }, h('button', { class: 'btn', onclick: () => this.closeTop() }, t('back'))));
  }

  // ------------------------------------------------------------------ day flow

  dayIntro(): void {
    const g = this.game;
    const p = g.preset;
    const day = g.day;
    const cfg = dayConfig(p, day);
    const unlockedToday = p.id === 'maple' ? TUTORIAL_UNLOCKS[day] ?? [] : day === 1 ? [] : [];
    const demandPct = Math.round(cfg.demand * (g.policies.has('transit') ? 0.9 : 1) * 100);
    const items: HTMLElement[] = [];
    const growth = day > 1 ? ` (+${Math.round(p.growth * 100)}%)` : '';
    items.push(h('div', { class: 'intro-row' }, svg(ICON.car, 22), h('span', null, t('population')), h('b', null, `${demandPct}%${growth}`)));
    if (g.stats.newBuildings > 0 && day > 1) items.push(h('div', { class: 'intro-row' }, svg(ICON.city, 22), h('span', null, t('newBuildings', { n: g.stats.newBuildings }))));
    const fc: string[] = [];
    if (cfg.rain) fc.push(t('rainForecast', { h: `${fmtHour(cfg.rain[0])}–${fmtHour(cfg.rain[1])}` }));
    if (cfg.event) fc.push(t('eventForecast', { e: `${fmtHour(cfg.event.hour)}` }));
    items.push(h('div', { class: 'intro-row' }, svg(cfg.rain ? ICON.rain : ICON.sun, 22), h('span', null, t('forecast')), h('b', null, fc.length ? fc.join(' · ') : t('clearSky'))));
    const chips = unlockedToday.length
      ? h('div', { class: 'unlock-box' }, h('div', { class: 'unlock-title' }, '🔓 ', t('unlocked')), h('div', { class: 'chips' }, ...unlockedToday.map((u) => h('span', { class: 'chip-u' }, t(UNLOCK_NAMES[u] ?? 'phases')))))
      : null;
    const stars = g.starsHistory;
    this.modal(
      'intro',
      h('div', { class: 'intro-city' }, p.name[getLang()]),
      h('div', { class: 'intro-day' }, t('dayIntro', { n: day }), h('span', { class: 'of' }, ` / ${p.days}`)),
      h('div', { class: 'day-dots' }, ...Array.from({ length: p.days }, (_, i) => h('i', { class: i < day - 1 ? `done s${stars[i] ?? 0}` : i === day - 1 ? 'cur' : '' }))),
      h('div', { class: 'intro-list' }, ...items),
      chips,
      h('div', { class: 'intro-money' }, svg(ICON.money, 20), money(g.money)),
      h(
        'div',
        { class: 'row center' },
        h('button', { class: 'btn big primary', 'data-tut': 'start', onclick: () => {
          Audio.unlock();
          Audio.click();
          this.clear();
          g.startDay();
        } }, svg(ICON.play, 22), t('start')),
      ),
    );
  }

  /** growing city: a level starts; first the new district is shown, then the briefing */
  levelIntro(): void {
    const g = this.game;
    const lv = g.day;
    const def = growthLevel(lv);
    if (g.perkChoices) {
      // the game was closed before the last level's advantage was picked
      this.perkChoice(() => this.levelIntro());
      return;
    }
    if (g.revealing) {
      g.revealing = false;
      const banner = h(
        'div',
        { class: 'district-banner' },
        h('div', { class: 'db-level' }, t('levelN', { n: lv })),
        h('div', { class: 'db-name' }, lv === 1 ? t('firstDistrict') : lv > GROWTH_LEVELS.length ? t('trafficGrows') : t('districtBuilt', { d: def.district[getLang()] })),
      );
      this.root.append(banner);
      setTimeout(() => banner.classList.add('out'), 2600);
      setTimeout(() => {
        banner.remove();
        if (g.phase === 'intro' && !this.stack.length) this.levelBriefing();
      }, 3000);
      return;
    }
    this.levelBriefing();
  }

  private levelBriefing(): void {
    const g = this.game;
    const lv = g.day;
    const def = growthLevel(lv);
    const cfg = growthDayConfig(lv);
    const gp = g.save.growth;
    const fresh = g.city.growth?.fresh;
    const items: HTMLElement[] = [];
    if (fresh?.size && lv <= GROWTH_LEVELS.length) {
      const mix = buildingMix(g.city.buildings.filter((b) => fresh.has(b.id)));
      items.push(h('div', { class: 'intro-row' }, svg(ICON.city, 22), h('span', null, t('newDistrict'), h('em', { class: 'mix' }, mix)), h('b', null, def.district[getLang()])));
    } else {
      items.push(h('div', { class: 'intro-row' }, svg(ICON.city, 22), h('span', null, t('cityGrown')), h('b', null, def.district[getLang()])));
    }
    const fc: string[] = [];
    if (cfg.rain) fc.push(t('rainForecast', { h: `${fmtHour(cfg.rain[0])}–${fmtHour(cfg.rain[1])}` }));
    if (cfg.event) fc.push(t('eventForecast', { e: `${fmtHour(cfg.event.hour)}` }));
    items.push(h('div', { class: 'intro-row' }, svg(cfg.rain ? ICON.rain : ICON.sun, 22), h('span', null, t('forecast')), h('b', null, fc.length ? fc.join(' · ') : t('clearSky'))));
    const unlockedNow = TUTORIAL_UNLOCKS[lv] ?? [];
    const chips = unlockedNow.length
      ? h('div', { class: 'unlock-box' }, h('div', { class: 'unlock-title' }, '🔓 ', t('unlocked')), h('div', { class: 'chips' }, ...unlockedNow.map((u) => h('span', { class: 'chip-u' }, t(UNLOCK_NAMES[u] ?? 'phases')))))
      : null;
    if (Object.keys(g.perks).length) items.push(h('div', { class: 'intro-row perks-row' }, h('span', null, t('yourPerks')), perkStrip(g.perks)));
    const best = gp.best[lv - 1];
    const n = GROWTH_LEVELS.length;
    this.modal(
      'intro',
      h('div', { class: 'intro-city' }, t('growthMode')),
      h('div', { class: 'intro-day' }, t('levelN', { n: lv }), lv <= n ? h('span', { class: 'of' }, ` / ${n}`) : null),
      h('div', { class: 'day-dots' }, ...Array.from({ length: n }, (_, i) => h('i', { class: i < lv - 1 ? `done s${gp.stars[i] ?? 0}` : i === lv - 1 ? 'cur' : '' }))),
      h(
        'div',
        { class: 'target-box' },
        h('div', { class: 'tb-main' }, h('span', null, '🎯 ', t('targetScore')), h('b', null, num(def.target))),
        h('div', { class: 'tb-stars' }, h('span', null, `★★ ${num(def.target * STAR2)}`), h('span', null, `★★★ ${num(def.target * STAR3)}`), best ? h('span', { class: 'tb-best' }, `${t('bestScore')}: ${num(best)}`) : null),
        h('div', { class: 'tb-hint' }, t('scoreHint')),
      ),
      h('div', { class: 'intro-list' }, ...items),
      chips,
      h('div', { class: 'intro-money' }, svg(ICON.money, 20), money(g.money)),
      h('div', { class: 'row center' }, h('button', { class: 'btn big primary', 'data-tut': 'start', onclick: () => {
        Audio.unlock();
        Audio.click();
        this.clear();
        g.startDay();
      } }, svg(ICON.play, 22), t('start'))),
    );
  }

  /** growing city: the level's result */
  levelReport(): void {
    const g = this.game;
    const r = g.report;
    const s = g.stats;
    const p = g.scoreParts;
    const lv = g.day;
    const passed = !!r.passed;
    const target = r.target ?? 0;
    const score = r.score ?? 0;
    const row = (label: string, v: number, cls = ''): HTMLElement => h('div', { class: `rep-row ${cls}` }, h('span', null, label), h('b', null, `${v > 0 ? '+' : ''}${num(v)}`));
    const parts = h(
      'div',
      { class: 'rep-grid' },
      row(t('scoreTrips', { n: p.tripCount }), p.trips, 'good'),
      p.emergency ? row(t('scoreEmergency'), p.emergency, p.emergency > 0 ? 'good' : 'bad') : null,
      p.crashes ? row(t('scoreCrashes'), p.crashes, 'bad') : null,
      p.abandoned ? row(t('scoreAbandoned'), p.abandoned, 'bad') : null,
      p.blocked ? row(t('scoreBlocked'), p.blocked, 'bad') : null,
    );
    const pct = Math.max(0, Math.min(1, score / (target * STAR3)));
    const meter = h(
      'div',
      { class: `score-meter ${passed ? 'ok' : 'miss'}` },
      h('div', { class: 'sm-top' }, h('span', null, t('totalPoints')), h('b', null, num(score)), r.record ? h('em', { class: 'record' }, `🏅 ${t('newRecord')}`) : null),
      h('div', { class: 'sm-bar' }, h('i', { style: { width: `${pct * 100}%` } }), h('em', { class: 'm0' }), h('em', { class: 'm1' }), h('em', { class: 'm2' })),
      h('div', { class: 'sm-lbl' }, `${t('target')} ${num(target)}`),
    );
    if (!passed) {
      const card = this.modal(
        'report',
        h('div', { class: 'fired-emoji' }, '🚧'),
        h('h2', null, t('levelFailed')),
        meter,
        h('p', null, t('levelFailedDesc', { t: num(target) })),
        parts,
        this.dayAchievements(),
      );
      card.append(
        h(
          'div',
          { class: 'col gap' },
          h('button', { class: 'btn big primary', onclick: () => {
            Audio.click();
            this.clear();
            g.retryDay();
          } }, '↻ ', t('retryLevel')),
          h('button', { class: 'btn', onclick: () => this.toMenu() }, t('menu')),
        ),
      );
      return;
    }
    const starsEl = h('div', { class: 'big-stars' });
    for (let i = 0; i < 3; i++) starsEl.append(h('span', { class: `bstar ${i < r.stars ? 'on' : ''}`, style: { animationDelay: `${0.25 + i * 0.25}s` } }, svg(ICON.star, 54)));
    const grantEl = h('b', null, `+${money(r.grant)}`);
    const next = lv < GROWTH_LEVELS.length ? growthLevel(lv + 1) : null;
    const achEl = this.dayAchievements();
    const card = this.modal(
      'report',
      h('h2', null, t('levelPassed', { n: lv })),
      starsEl,
      meter,
      parts,
      h(
        'div',
        { class: 'rep-money' },
        h('div', { class: 'rep-row good' }, h('span', null, t('income')), h('b', null, `+${money(s.income)}`)),
        h('div', { class: 'rep-row good' }, h('span', null, t('grant')), grantEl),
        h('div', { class: 'rep-row bad' }, h('span', null, t('expenses')), h('b', null, `-${money(r.upkeep)}`)),
      ),
      achEl,
      next ? h('div', { class: 'next-district' }, '🏗️ ', t('nextDistrict', { d: next.district[getLang()] })) : null,
    );
    const btns = h('div', { class: 'row center gap' });
    if (Platform.hasAds || import.meta.env.DEV) {
      const adBtn = h('button', { class: 'btn ad', onclick: async () => {
        adBtn.setAttribute('disabled', '');
        const ok = await g.doubleGrant();
        if (ok) {
          grantEl.textContent = `+${money(r.grant * 2)}`;
          this.ui.toast(t('rewardDone'), 'good');
          adBtn.remove();
        } else {
          this.ui.toast(t('adUnavailable'), 'warn');
          adBtn.removeAttribute('disabled');
        }
      } }, '▶ ', t('bonusDouble'));
      btns.append(adBtn);
    }
    // the last planned district: celebrate before traffic keeps growing
    const finale = lv === GROWTH_LEVELS.length;
    btns.append(h('button', { class: 'btn big primary', onclick: () => {
      Audio.click();
      // first the advantage for passing, then the next district
      this.perkChoice(() => {
        this.clear();
        if (finale) g.setPhase('complete');
        else void g.nextDay();
      });
    } }, finale ? '🏆 ' : '', t('nextLevel'), ' ➜'));
    card.append(btns);
  }

  /** chips of the achievements earned during the day that just ended */
  private dayAchievements(): HTMLElement | null {
    const ids = this.game.dayAch;
    if (!ids.length) return null;
    return h(
      'div',
      { class: 'day-ach' },
      h('div', { class: 'day-ach-title' }, '🏆 ', t('achToday')),
      h('div', { class: 'chips' }, ...ids.map((id) => {
        const a = ACHIEVEMENTS.find((x) => x.id === id);
        return h('span', { class: `chip-u ach-chip ${a?.tier ?? ''}` }, a?.icon ?? '', ' ', t(`ach_${id}` as StrKey));
      })),
    );
  }

  /** growing city: the last planned district is done */
  growthComplete(): void {
    const g = this.game;
    const gp = g.save.growth;
    const totalStars = gp.stars.reduce((a, b) => a + (b ?? 0), 0);
    const totalScore = gp.best.reduce((a, b) => a + (b ?? 0), 0);
    const card = this.modal(
      'complete',
      h('div', { class: 'fired-emoji' }, '🏙️🏆'),
      h('h2', null, t('growthComplete')),
      h('p', null, t('growthCompleteDesc')),
      h('div', { class: 'hub-stats' }, h('div', null, h('span', null, t('rankLbl')), h('b', null, t(rankKey(totalStars)))), h('div', null, h('span', null, t('stars')), h('b', null, `★ ${totalStars} / ${GROWTH_LEVELS.length * 3}`)), h('div', null, h('span', null, t('totalScore')), h('b', null, num(totalScore)))),
      null,
    );
    card.append(
      h(
        'div',
        { class: 'col gap' },
        h('button', { class: 'btn big primary', onclick: () => {
          this.clear();
          void g.nextDay();
        } }, t('endless')),
        h('button', { class: 'btn', onclick: () => this.toMenu() }, t('menu')),
      ),
    );
  }

  dayReport(): void {
    const g = this.game;
    const s = g.stats;
    const r = g.report;
    const avgTrip = s.trips ? s.tripTime / s.trips : 0;
    const starsEl = h('div', { class: 'big-stars' });
    for (let i = 0; i < 3; i++) {
      const st = h('span', { class: `bstar ${i < r.stars ? 'on' : ''}`, style: { animationDelay: `${0.25 + i * 0.25}s` } }, svg(ICON.star, 54));
      starsEl.append(st);
    }
    const row = (k: StrKey, v: string, cls = ''): HTMLElement => h('div', { class: `rep-row ${cls}` }, h('span', null, t(k)), h('b', null, v));
    const grantEl = h('b', null, `+${money(r.grant)}`);
    const card = this.modal(
      'report',
      h('h2', null, t('dayReport', { n: g.day - 1 })),
      starsEl,
      h(
        'div',
        { class: 'rep-grid' },
        row('avgSatisfaction', `${Math.round(r.avg)}%`),
        row('tripsDone', String(s.trips)),
        row('avgTrip', `${Math.round(avgTrip)} ${t('sec')}`),
        row('incidents', String(s.crashes)),
        row('abandoned', String(s.abandoned)),
      ),
      h(
        'div',
        { class: 'rep-money' },
        row('income', `+${money(s.income)}`, 'good'),
        h('div', { class: 'rep-row good' }, h('span', null, t('grant')), grantEl),
        row('expenses', `-${money(r.upkeep)}`, 'bad'),
      ),
      this.dayAchievements(),
    );
    const btns = h('div', { class: 'row center gap' });
    if (Platform.hasAds || import.meta.env.DEV) {
      const adBtn = h('button', { class: 'btn ad', onclick: async () => {
        adBtn.setAttribute('disabled', '');
        const ok = await g.doubleGrant();
        if (ok) {
          grantEl.textContent = `+${money(r.grant * 2)}`;
          this.ui.toast(t('rewardDone'), 'good');
          adBtn.remove();
        } else {
          this.ui.toast(t('adUnavailable'), 'warn');
          adBtn.removeAttribute('disabled');
        }
      } }, '▶ ', t('bonusDouble'));
      btns.append(adBtn);
    }
    btns.append(h('button', { class: 'btn big primary', onclick: () => {
      Audio.click();
      this.clear();
      void g.nextDay();
    } }, t('nextDay'), ' ➜'));
    card.append(btns);
  }

  fired(): void {
    const g = this.game;
    const card = this.modal(
      'fired',
      h('div', { class: 'fired-emoji' }, '🤬📢'),
      h('h2', null, t('fired')),
      h('p', null, t('firedDesc')),
      h('div', { class: 'rep-grid' }, h('div', { class: 'rep-row' }, h('span', null, t('tripsDone')), h('b', null, String(g.stats.trips))), h('div', { class: 'rep-row' }, h('span', null, t('abandoned')), h('b', null, String(g.stats.abandoned)))),
      null,
    );
    const btns = h('div', { class: 'col gap' });
    if (Platform.hasAds || import.meta.env.DEV) {
      const b = h('button', { class: 'btn big ad', onclick: async () => {
        b.setAttribute('disabled', '');
        const ok = await g.secondChance();
        if (!ok) {
          this.ui.toast(t('adUnavailable'), 'warn');
          b.removeAttribute('disabled');
        } else this.clear();
      } }, '▶ ', t('secondChance'));
      btns.append(b);
    }
    btns.append(
      h('button', { class: 'btn big primary', onclick: () => {
        this.clear();
        g.retryDay();
      } }, t('retry')),
      h('button', { class: 'btn', onclick: () => this.toMenu() }, t('menu')),
    );
    card.append(btns);
  }

  complete(): void {
    const g = this.game;
    const idx = PRESETS.findIndex((p) => p.id === g.preset.id);
    const next = PRESETS[idx + 1];
    const total = g.starsHistory.reduce((a, b) => a + (b ?? 0), 0);
    const card = this.modal(
      'complete',
      h('div', { class: 'fired-emoji' }, '🏆'),
      h('h2', null, t('cityComplete', { c: g.preset.name[getLang()] })),
      h('p', null, t('cityCompleteDesc', { n: g.preset.days })),
      h('div', { class: 'big-stars static' }, svg(ICON.star, 40), h('b', null, `${total} / ${g.preset.days * 3}`)),
      null,
    );
    const btns = h('div', { class: 'col gap' });
    if (next) {
      btns.append(h('button', { class: 'btn big primary', onclick: () => {
        g.save.run = null;
        this.startRun(next.id, false);
      } }, `${t('nextCity')}: ${next.name[getLang()]} ➜`));
    }
    btns.append(
      h('button', { class: 'btn', onclick: () => {
        g.endless = true;
        this.clear();
        void g.nextDay();
      } }, t('endless')),
      h('button', { class: 'btn', onclick: () => this.toMenu() }, t('menu')),
    );
    card.append(btns);
  }

  toMenu(): void {
    const g = this.game;
    g.persist(true);
    this.clear();
    if (g.save.lastMode === 'growth' && g.save.growthRun) g.loadCity('growth', g.save.growthRun, true);
    else g.loadCity(g.save.run?.city ?? 'maple', g.save.run, true);
    g.renderer.rig.autoOrbit = true;
    g.setPhase('menu');
  }

  // ------------------------------------------------------------------ misc

  pauseMenu(): void {
    const g = this.game;
    if (g.phase !== 'playing') return;
    const prev = g.speed;
    g.setSpeedMul(0);
    const resume = (): void => {
      this.clear();
      g.setSpeedMul(prev || 1);
    };
    this.modal(
      'pause',
      h('h2', null, t('paused')),
      g.growth ? h('div', { class: 'pause-perks' }, h('div', { class: 'sec-title' }, t('yourPerks')), perkStrip(g.perks)) : null,
      h(
        'div',
        { class: 'col gap' },
        h('button', { class: 'btn big primary', onclick: resume }, svg(ICON.play, 20), t('resume')),
        h('button', { class: 'btn', onclick: () => this.achievementsModal() }, '🏆 ', t('achievements'), h('span', { class: 'ach-count' }, `${achEarned(g.save.ach)}/${ACHIEVEMENTS.length}`)),
        h('button', { class: 'btn', onclick: () => this.settings() }, svg(ICON.gear, 18), t('settings')),
        h('button', { class: 'btn', onclick: () => this.help() }, svg(ICON.help, 18), t('howToPlay')),
        h('button', { class: 'btn', onclick: () => this.toMenu() }, svg(ICON.home, 18), t('menu')),
      ),
    );
  }

  settings(): void {
    const g = this.game;
    const s = g.save;
    const langSeg = h(
      'div',
      { class: 'seg' },
      h('button', { class: getLang() === 'en' ? 'active' : '', onclick: () => this.setLanguage('en') }, 'English'),
      h('button', { class: getLang() === 'tr' ? 'active' : '', onclick: () => this.setLanguage('tr') }, 'Türkçe'),
    );
    const slider = (val: number, fn: (v: number) => void): HTMLInputElement => {
      const r = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(val) }) as HTMLInputElement;
      r.addEventListener('input', () => fn(Number(r.value)));
      return r;
    };
    const q = s.quality ?? g.quality();
    const qSeg = h(
      'div',
      { class: 'seg' },
      ...(['low', 'medium', 'high'] as const).map((lv) =>
        h('button', { class: q === lv ? 'active' : '', onclick: () => {
          if (lv !== q) g.applyQuality(lv);
          else if (!s.qualityManual) {
            s.qualityManual = true;
            storeSave(s, true);
          }
          this.closeTop();
          this.settings();
        } }, t(lv)),
      ),
    );
    this.modal(
      'settings',
      h('h2', null, t('settings')),
      h('div', { class: 'set-row' }, h('span', null, t('language')), langSeg),
      h('div', { class: 'set-row' }, h('span', null, t('sound')), slider(s.sfx, (v) => {
        s.sfx = v;
        Audio.setVolumes(s.sfx, s.music);
        storeSave(s);
      })),
      h('div', { class: 'set-row' }, h('span', null, t('music')), slider(s.music, (v) => {
        s.music = v;
        Audio.setVolumes(s.sfx, s.music);
        Audio.setMusic(v > 0.01);
        storeSave(s);
      })),
      h('div', { class: 'set-row' }, h('span', null, t('graphics')), qSeg),
      h(
        'div',
        { class: 'row center gap' },
        h('button', { class: 'btn danger', onclick: () => {
          if (!confirmBox(t('confirmReset'))) return;
          const d = defaultSave();
          d.lang = s.lang;
          Object.assign(s, d);
          storeSave(s, true);
          location.reload();
        } }, t('resetProgress')),
        h('button', { class: 'btn primary', onclick: () => this.closeTop() }, t('close')),
      ),
    );
  }

  private setLanguage(l: 'en' | 'tr'): void {
    setLang(l);
    this.game.save.lang = l;
    storeSave(this.game.save, true);
    // rebuild the whole UI in the new language
    location.reload();
  }

  help(): void {
    const items: StrKey[] = ['help1', 'help2', 'help3', 'help4', 'help5', 'help6'];
    this.modal(
      'help',
      h('h2', null, t('howToPlay')),
      h('div', { class: 'help-list' }, ...items.map((k, i) => h('div', { class: 'help-item' }, h('span', { class: 'help-num' }, String(i + 1)), h('span', null, t(k))))),
      h('div', { class: 'sec-title' }, t('controls')),
      h('div', { class: 'hint' }, t('ctrlHelp')),
      h('div', { class: 'row center' }, h('button', { class: 'btn primary', onclick: () => this.closeTop() }, t('gotIt'))),
    );
  }

  policies(): void {
    const g = this.game;
    const lock = !g.unlocks.has('policies');
    const list = h('div', { class: 'pol-list' });
    const render = (): void => {
      list.innerHTML = '';
      for (const p of POLICIES) {
        const on = g.policies.has(p.id);
        list.append(
          h(
            'div',
            { class: `pol ${on ? 'on' : ''} ${lock ? 'disabled' : ''}` },
            h('div', { class: 'pol-info' }, h('b', null, t(`pol_${p.id}` as StrKey)), h('span', null, t(`polDesc_${p.id}` as StrKey))),
            h('span', { class: 'cost' }, `${money(p.cost)}${t('perDay')}`),
            h('button', { class: `switch ${on ? 'on' : ''}`, disabled: lock, onclick: () => {
              if (lock) return;
              g.togglePolicy(p.id);
              render();
            } }, h('i')),
          ),
        );
      }
      const pre = g.preempt;
      list.append(
        h(
          'div',
          { class: `pol ${pre ? 'on' : ''} ${lock ? 'disabled' : ''}` },
          h('div', { class: 'pol-info' }, h('b', null, '🚑 ', t('emergencyPreempt')), h('span', null, t('emergencyPreemptDesc'))),
          pre ? null : h('span', { class: 'cost' }, money(g.costOf('preempt'))),
          h('button', { class: `switch ${pre ? 'on' : ''}`, disabled: lock, onclick: () => {
            if (lock) return;
            g.togglePreempt();
            render();
          } }, h('i')),
        ),
      );
    };
    render();
    this.modal(
      'policies',
      h('h2', null, t('policies')),
      lock ? h('div', { class: 'lock-note' }, svg(ICON.lock, 14), g.growth ? t('locked_level', { n: 5 }) : t('locked_feature', { n: 5 })) : null,
      list,
      h('div', { class: 'row center' }, h('button', { class: 'btn primary', onclick: () => this.closeTop() }, t('close'))),
    );
  }
}

function confirmBox(msg: string): boolean {
  // window.confirm is not allowed on some portals; use a simple double-click guard instead
  const k = '__confirm_reset';
  const w = window as unknown as Record<string, number>;
  const now = Date.now();
  if (w[k] && now - w[k] < 4000) return true;
  w[k] = now;
  const el = document.createElement('div');
  el.className = 'toast warn';
  el.textContent = `${msg} (↻)`;
  document.querySelector('.toasts')?.prepend(el);
  setTimeout(() => el.remove(), 3500);
  return false;
}

/** number of achievements earned */
function achEarned(ach: Record<string, number>): number {
  return ACHIEVEMENTS.filter((a) => ach[a.id]).length;
}

/** an achievement's description with its threshold filled in */
function achDesc(a: AchDef): string {
  const need: Record<string, number> = {
    starCollector: ACH_NEED.starCollector,
    perkCollector: ACH_NEED.perkCollector,
    happyCity: ACH_NEED.happyCity,
    noAbandon: ACH_NEED.noAbandon,
    comeback: ACH_NEED.comeback,
    overachiever: Math.round(ACH_NEED.overachiever * 100),
    smartGrid: ACH_NEED.smartGrid,
    greenWaves: ACH_NEED.greenWaves,
  };
  return t(`achDesc_${a.id}` as StrKey, { n: num(a.goal?.n ?? need[a.id] ?? 0) });
}

/** the career's advantages as icons with their rank (name and effect on hover) */
function perkStrip(perks: Partial<Record<PerkId, number>>): HTMLElement {
  const owned = PERKS.filter((p) => (perks[p.id] ?? 0) > 0);
  if (!owned.length) return h('div', { class: 'perk-strip empty' }, t('noPerks'));
  return h(
    'div',
    { class: 'perk-strip' },
    ...owned.map((p) =>
      h('span', { class: 'perk-chip', title: `${t(`perk_${p.id}` as StrKey)}: ${t(`perkDesc_${p.id}` as StrKey)}` }, p.icon, (perks[p.id] ?? 0) > 1 ? h('em', null, `×${perks[p.id]}`) : null),
    ),
  );
}

/** career title for the stars collected in the growing city */
function rankKey(stars: number): StrKey {
  return (['rank0', 'rank1', 'rank2', 'rank3', 'rank4', 'rank5'] as const)[Math.min(5, Math.floor(stars / 6))];
}

/** short description of the buildings a district adds, e.g. "12 homes · 5 shops" */
function buildingMix(list: Building[]): string {
  const c = { homes: 0, shops: 0, offices: 0, factories: 0, services: 0 };
  for (const b of list) {
    if (b.kind === 'house' || b.kind === 'apartment') c.homes++;
    else if (b.kind === 'shop') c.shops++;
    else if (b.kind === 'office' || b.kind === 'tower') c.offices++;
    else if (b.kind === 'industrial') c.factories++;
    else c.services++;
  }
  const parts = (Object.keys(c) as (keyof typeof c)[]).filter((k) => c[k] > 0).map((k) => `${c[k]} ${t(k)}`);
  return `${t('buildingsMix', { n: list.length })}: ${parts.join(' · ')}`;
}

function cityGradient(p: CityPreset, i: number): string {
  const g = [
    'linear-gradient(135deg,#7cc56b,#3d8a56)',
    'linear-gradient(135deg,#5fb2d8,#2d6aa0)',
    'linear-gradient(135deg,#9a8ee8,#5642a8)',
    'linear-gradient(135deg,#f0a35a,#b0482c)',
  ];
  void p;
  return g[i % g.length];
}
