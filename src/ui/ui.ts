// HUD, toasts, world markers and the glue between game and DOM.

import type { Game, GameUI, Phase, ToastKind } from '../game/game.ts';
import { t, money, num } from '../game/i18n.ts';
import { growthLevel } from '../world/growth.ts';
import { STAR2, STAR3 } from '../game/config.ts';
import { DAY_KEYS, DAY_LENGTH, fmtHour, isRush } from '../game/clock.ts';
import { intensityAt } from '../sim/demand.ts';
import { Audio } from '../audio/audio.ts';
import { ICON, h, losColor, svg } from './dom.ts';
import { Panels } from './panels.ts';
import { Menus } from './menus.ts';
import { Tutorial } from './tutorial.ts';

interface Toast {
  el: HTMLElement;
  t: number;
  key?: string;
}

export class UI implements GameUI {
  game: Game;
  root: HTMLElement;
  hud!: HTMLElement;
  panels!: Panels;
  menus!: Menus;
  tutorial!: Tutorial;
  private toasts: HTMLElement;
  private toastList: Toast[] = [];
  private markers: HTMLElement;
  private floaters: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private lastVals: Record<string, string> = {};
  private panelT = 0;
  private markerPool: HTMLElement[] = [];
  losOn = false;
  private vignette: HTMLElement;

  constructor(game: Game, root: HTMLElement) {
    this.game = game;
    this.root = root;
    this.markers = h('div', { class: 'markers' });
    this.floaters = h('div', { class: 'floaters' });
    this.toasts = h('div', { class: 'toasts' });
    this.vignette = h('div', { class: 'vignette' });
    root.append(this.vignette, this.markers, this.floaters);
    this.buildHud();
    root.append(this.toasts);
    const panelRoot = h('div', { class: 'panel' });
    root.append(panelRoot);
    this.panels = new Panels(game, panelRoot);
    const modalRoot = h('div', { class: 'modal-root' });
    root.append(modalRoot);
    this.menus = new Menus(game, this, modalRoot);
    this.tutorial = new Tutorial(game, this, root);
    this.bindKeys();
  }

  // ------------------------------------------------------------------ HUD

  private buildHud(): void {
    const g = this.game;
    const dayChip = h('div', { class: 'chip day-chip' }, (this.els.dayLbl = h('span', { class: 'day-lbl' }, t('day'))), (this.els.day = h('b', null, '1')));
    const clockIcon = h('span', { class: 'clock-ico' });
    this.els.clockIcon = clockIcon;
    const clock = h('div', { class: 'chip clock-chip' }, clockIcon, (this.els.clock = h('b', null, '06:00')), (this.els.rush = h('span', { class: 'rush-tag' }, t('rush'))));
    // day progress with rush hour bands and demand curve
    const bar = h('div', { class: 'day-bar' });
    const curve = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    curve.setAttribute('viewBox', '0 0 100 20');
    curve.setAttribute('preserveAspectRatio', 'none');
    let d = 'M0 20';
    for (let i = 0; i <= 100; i++) {
      const tt = (i / 100) * DAY_LENGTH;
      // hour at this time
      let hh = 6;
      for (let k = 1; k < DAY_KEYS.length; k++) {
        if (tt <= DAY_KEYS[k][0]) {
          const [t0, h0] = DAY_KEYS[k - 1];
          const [t1, h1] = DAY_KEYS[k];
          hh = h0 + ((h1 - h0) * (tt - t0)) / (t1 - t0);
          break;
        }
      }
      d += ` L${i} ${(20 - intensityAt(hh) * 18).toFixed(1)}`;
    }
    d += ' L100 20 Z';
    curve.innerHTML = `<path d="${d}" fill="rgba(255,176,32,.35)"/>`;
    bar.append(curve, (this.els.dayFill = h('i', { class: 'day-fill' })), (this.els.dayKnob = h('b', { class: 'day-knob' })));
    const left = h('div', { class: 'tb-left' }, h('div', { class: 'row' }, dayChip, clock), bar);
    // satisfaction
    const satFill = h('i');
    this.els.satFill = satFill;
    const sat = h(
      'div',
      { class: 'sat', title: t('satisfaction') },
      (this.els.satEmoji = h('span', { class: 'sat-emoji' }, '🙂')),
      h(
        'div',
        { class: 'sat-col' },
        h('div', { class: 'sat-lbl' }, t('satisfaction'), (this.els.satPct = h('b', null, '70%'))),
        h('div', { class: 'sat-bar' }, satFill),
        // growing city: the day's score against the level's target (the marks are the 2nd and 3rd star)
        (this.els.scoreRow = h(
          'div',
          { class: 'score-row' },
          h('div', { class: 'sat-lbl' }, t('score'), (this.els.scoreVal = h('b', null, '0'))),
          h('div', { class: 'score-bar' }, (this.els.scoreFill = h('i')), h('em', { class: 'm1' }), h('em', { class: 'm2' })),
        )),
      ),
    );
    const center = h('div', { class: 'tb-center' }, sat);
    const right = h(
      'div',
      { class: 'tb-right' },
      h('div', { class: 'chip money-chip', title: t('money') }, svg(ICON.money, 18), (this.els.money = h('b', null, '$0'))),
      h('div', { class: 'chip hide-xs', title: t('vehicles') }, svg(ICON.car, 18), (this.els.veh = h('b', null, '0'))),
      h('div', { class: 'chip hide-sm', title: t('avgSpeed') }, svg(ICON.gauge, 18), (this.els.speed = h('b', null, '0'))),
      h('button', { class: 'icon-btn menu-btn', title: t('menu'), onclick: () => this.menus.pauseMenu() }, svg(ICON.menu, 22)),
    );
    const top = h('div', { class: 'topbar' }, left, center, right);
    // bottom bar
    const mkTool = (icon: string, title: string, fn: () => void, id: string): HTMLElement => {
      const b = h('button', { class: 'tool', title, 'data-tut': id, onclick: () => {
        Audio.click();
        fn();
      } }, svg(icon, 24));
      this.els[id] = b;
      return b;
    };
    const tools = h(
      'div',
      { class: 'tools' },
      mkTool(ICON.layers, t('trafficLayer'), () => this.toggleTraffic(), 'tool-traffic'),
      mkTool(ICON.grade, t('losLayer'), () => this.toggleLOS(), 'tool-los'),
      mkTool(ICON.policy, t('policies'), () => this.menus.policies(), 'tool-policy'),
      mkTool(ICON.help, t('howToPlay'), () => this.menus.help(), 'tool-help'),
    );
    const speeds = h(
      'div',
      { class: 'speeds-ctl' },
      mkTool(ICON.pause, t('pause'), () => g.togglePause(), 'sp-0'),
      mkTool(ICON.play, t('speed1'), () => g.setSpeedMul(1), 'sp-1'),
      mkTool(ICON.fast, t('speed2'), () => g.setSpeedMul(2), 'sp-2'),
      mkTool(ICON.faster, t('speed3'), () => g.setSpeedMul(4), 'sp-4'),
    );
    const bottom = h('div', { class: 'bottombar' }, tools, speeds);
    this.hud = h('div', { class: 'hud' }, top, bottom, (this.els.pauseBadge = h('div', { class: 'pause-badge' }, t('paused'))));
    this.root.append(this.hud);
  }

  toggleTraffic(): void {
    const o = this.game.renderer.overlays;
    o.setTraffic(!o.trafficOn);
    this.els['tool-traffic'].classList.toggle('active', o.trafficOn);
    this.tutorial.event('traffic');
  }

  toggleLOS(): void {
    this.losOn = !this.losOn;
    this.els['tool-los'].classList.toggle('active', this.losOn);
  }

  private set(key: string, val: string): void {
    if (this.lastVals[key] === val) return;
    this.lastVals[key] = val;
    this.els[key].textContent = val;
  }

  /** per-frame update */
  tick(dt: number): void {
    const g = this.game;
    if (g.phase === 'playing' || g.phase === 'intro') {
      const hour = g.hour;
      this.set('day', String(g.day));
      this.set('dayLbl', g.growth ? t('level') : t('day'));
      this.root.classList.toggle('growth-mode', g.growth);
      this.els.scoreRow.style.display = g.growth ? '' : 'none';
      if (g.growth) {
        const target = growthLevel(g.day).target;
        this.set('scoreVal', `${num(g.score)} / ${num(target)}`);
        const f = Math.max(0, Math.min(1, g.score / (target * STAR3)));
        this.els.scoreFill.style.width = `${Math.max(1.5, f * 100)}%`;
        this.els.scoreFill.style.background = g.score >= target * STAR2 ? 'linear-gradient(90deg,#ffd166,#ffb020)' : g.score >= target ? '#3ee07a' : '#ff9f43';
      }
      this.set('clock', fmtHour(hour));
      const night = hour < 6.5 || hour > 19.6;
      const ico = night ? 'moon' : g.sim.rain > 0.1 ? 'rain' : 'sun';
      if (this.lastVals.ico !== ico) {
        this.lastVals.ico = ico;
        this.els.clockIcon.innerHTML = '';
        this.els.clockIcon.append(svg(ICON[ico as 'sun'], 18));
      }
      this.els.rush.style.display = isRush(hour) ? '' : 'none';
      const frac = Math.min(1, g.dayT / DAY_LENGTH);
      this.els.dayFill.style.width = `${frac * 100}%`;
      this.els.dayKnob.style.left = `${frac * 100}%`;
      const sat = Math.round(g.sat);
      this.set('satPct', `${sat}%`);
      this.els.satFill.style.width = `${Math.max(2, g.sat)}%`;
      this.els.satFill.style.background = g.sat > 70 ? '#3ee07a' : g.sat > 50 ? '#b9e04a' : g.sat > 35 ? '#ffc23a' : g.sat > 20 ? '#ff8a3a' : '#ff4b3e';
      this.set('satEmoji', g.sat > 80 ? '😄' : g.sat > 62 ? '🙂' : g.sat > 45 ? '😐' : g.sat > 28 ? '😟' : g.sat > 12 ? '😠' : '🤬');
      this.set('money', money(g.money));
      this.els.money.classList.toggle('neg', g.money < 0);
      this.set('veh', String(g.sim.vehicles.length));
      let sv = 0;
      for (const v of g.sim.vehicles) sv += v.v;
      const avg = g.sim.vehicles.length ? (sv / g.sim.vehicles.length) * 3.6 : 0;
      this.set('speed', `${Math.round(avg)} ${t('speedUnit')}`);
      for (const s of [0, 1, 2, 4]) this.els[`sp-${s}`].classList.toggle('active', g.speed === s);
      this.els.pauseBadge.style.display = g.speed === 0 && g.phase === 'playing' ? '' : 'none';
      this.vignette.style.opacity = g.sat < 25 && g.phase === 'playing' ? String(0.35 + 0.35 * Math.sin(performance.now() / 300) ** 2) : '0';
    }
    this.hud.classList.toggle('hidden', !(g.phase === 'playing' || g.phase === 'intro'));
    // toasts
    for (const ts of this.toastList.slice()) {
      ts.t -= dt;
      if (ts.t <= 0) this.removeToast(ts);
    }
    this.panelT -= dt;
    if (this.panelT <= 0) {
      this.panelT = 0.25;
      this.panels.tick();
    }
    this.updateMarkers();
    this.tutorial.tick(dt);
  }

  // ------------------------------------------------------------------ markers

  private updateMarkers(): void {
    const g = this.game;
    let i = 0;
    const show = g.phase === 'playing' || g.phase === 'intro';
    const r = g.renderer;
    const use = (): HTMLElement => {
      let m = this.markerPool[i];
      if (!m) {
        m = h('div', { class: 'marker' });
        m.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const fn = (m as unknown as { _fn?: () => void })._fn;
          fn?.();
        });
        this.markerPool.push(m);
        this.markers.append(m);
      }
      i++;
      m.style.display = '';
      return m;
    };
    if (show) {
      for (const inc of g.incidents) {
        const p = r.toScreen(inc.x, inc.y, 6);
        if (!p.visible) continue;
        const m = use();
        m.className = 'marker inc';
        m.textContent = '💥';
        m.style.transform = `translate(${p.x}px, ${p.y}px)`;
        (m as unknown as { _fn?: () => void })._fn = () => g.focusIncident(inc);
      }
      const nodes = this.losOn ? g.city.net.nodes.filter((n) => !n.gateway && n.arms.length >= 3) : g.hotNodes;
      for (const n of nodes) {
        const p = r.toScreen(n.x, n.y, 8);
        if (!p.visible) continue;
        const m = use();
        const grade = g.sim.nodeLOS(n);
        if (this.losOn) {
          m.className = 'marker los';
          m.textContent = grade;
          m.style.background = losColor(grade);
        } else {
          m.className = 'marker hot';
          m.textContent = '⚠';
          m.style.background = '';
        }
        m.style.transform = `translate(${p.x}px, ${p.y}px)`;
        (m as unknown as { _fn?: () => void })._fn = () => g.selectNode(n);
      }
    }
    for (let k = i; k < this.markerPool.length; k++) this.markerPool[k].style.display = 'none';
  }

  // ------------------------------------------------------------------ GameUI

  toast(msg: string, kind: ToastKind, action?: { label: string; fn: () => void }, key?: string): void {
    if (key) {
      const ex = this.toastList.find((x) => x.key === key);
      if (ex) {
        ex.t = 6;
        return;
      }
    }
    const el = h(
      'div',
      { class: `toast ${kind}` },
      h('span', { class: 'toast-msg' }, msg),
      action
        ? h('button', { class: 'toast-btn', onclick: () => {
            action.fn();
            this.removeToast(ts);
          } }, action.label)
        : null,
    );
    const ts: Toast = { el, t: kind === 'bad' ? 9 : 6.5, key };
    this.toastList.push(ts);
    this.toasts.prepend(el);
    if (this.toastList.length > 4) this.removeToast(this.toastList[0]);
  }

  private removeToast(ts: Toast): void {
    const i = this.toastList.indexOf(ts);
    if (i >= 0) this.toastList.splice(i, 1);
    ts.el.classList.add('out');
    setTimeout(() => ts.el.remove(), 300);
  }

  refreshPanel(): void {
    this.panels.render();
  }

  phaseChanged(p: Phase): void {
    this.menus.onPhase(p);
    this.tutorial.onPhase(p);
    if (p !== 'playing') this.game.select(null);
  }

  floatText(x: number, y: number, text: string, color: string): void {
    const p = this.game.renderer.toScreen(x, y, 6);
    if (!p.visible) return;
    const el = h('div', { class: 'floater', style: { left: `${p.x}px`, top: `${p.y}px`, color } }, text);
    this.floaters.append(el);
    setTimeout(() => el.remove(), 1400);
  }

  tutorialEvent(ev: string): void {
    this.tutorial.event(ev);
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const g = this.game;
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (g.phase !== 'playing') return;
      if (e.code === 'Space') g.togglePause();
      else if (e.code === 'Digit1') g.setSpeedMul(1);
      else if (e.code === 'Digit2') g.setSpeedMul(2);
      else if (e.code === 'Digit3') g.setSpeedMul(4);
      else if (e.code === 'KeyT') this.toggleTraffic();
      else if (e.code === 'KeyL') this.toggleLOS();
      else if (e.code === 'Escape') {
        if (g.selection) g.select(null);
        else this.menus.pauseMenu();
      }
    });
  }
}
