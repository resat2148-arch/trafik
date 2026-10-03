// Modal screens: main menu, city select, day intro / report, fired, complete,
// settings, help, pause and policies.

import type { Game, Phase } from '../game/game.ts';
import { PRESETS } from '../world/citygen.ts';
import type { CityPreset } from '../world/citygen.ts';
import { getLang, money, setLang, t } from '../game/i18n.ts';
import type { StrKey } from '../game/i18n.ts';
import { COST, POLICIES, TUTORIAL_UNLOCKS, dayConfig } from '../game/config.ts';
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
        this.dayIntro();
        break;
      case 'report':
        this.dayReport();
        break;
      case 'fired':
        this.fired();
        break;
      case 'complete':
        this.complete();
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
    btns.append(
      h('button', { class: 'btn big', onclick: () => this.citySelect() }, svg(ICON.city, 22), t('cities')),
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
    const run = cont ? g.save.run : null;
    if (!cont) {
      g.save.run = null;
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
      null,
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
    const id = g.save.run?.city ?? 'maple';
    g.loadCity(id, g.save.run, true);
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
      h(
        'div',
        { class: 'col gap' },
        h('button', { class: 'btn big primary', onclick: resume }, svg(ICON.play, 20), t('resume')),
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
          s.quality = lv;
          storeSave(s, true);
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
      h('div', { class: 'hint' }, t('qualityNote')),
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
          pre ? null : h('span', { class: 'cost' }, money(COST.preempt)),
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
      lock ? h('div', { class: 'lock-note' }, svg(ICON.lock, 14), t('locked_feature', { n: 5 })) : null,
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
