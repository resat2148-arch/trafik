// Interactive first-day tutorial.

import type { Game, Phase } from '../game/game.ts';
import { t } from '../game/i18n.ts';
import type { StrKey } from '../game/i18n.ts';
import { storeSave } from '../game/save.ts';
import { Audio } from '../audio/audio.ts';
import { h } from './dom.ts';
import type { UI } from './ui.ts';

interface Step {
  text: StrKey;
  wait?: string; // event prefix that completes the step
  target?: string; // data-tut selector to highlight
  focusNode?: boolean;
  button?: StrKey;
}

const STEPS: Step[] = [
  { text: 'tut1', button: 'next' },
  { text: 'tut2', wait: 'selectNode', focusNode: true },
  { text: 'tut3', wait: 'control:signal', target: 'ctrl-signal' },
  { text: 'tut4', button: 'next' },
  { text: 'tut5', wait: 'traffic', target: 'tool-traffic' },
  { text: 'tut6', button: 'gotIt' },
];

export class Tutorial {
  game: Game;
  ui: UI;
  private el: HTMLElement;
  private step = -1;
  private glowT = 0;

  constructor(game: Game, ui: UI, root: HTMLElement) {
    this.game = game;
    this.ui = ui;
    this.el = h('div', { class: 'tut' });
    this.el.style.display = 'none';
    root.append(this.el);
  }

  get active(): boolean {
    return this.step >= 0;
  }

  onPhase(p: Phase): void {
    const g = this.game;
    if (p === 'playing' && !g.save.tutorialDone && g.preset.id === 'maple' && g.day === 1 && this.step < 0) {
      this.step = 0;
      g.tutorialActive = true;
      this.show();
    } else if (p !== 'playing' && p !== 'intro') {
      this.hide();
    }
  }

  private show(): void {
    const s = STEPS[this.step];
    if (!s) return this.finish();
    const g = this.game;
    this.el.innerHTML = '';
    this.el.style.display = '';
    this.el.append(
      h('div', { class: 'tut-avatar' }, '👷'),
      h(
        'div',
        { class: 'tut-body' },
        h('div', { class: 'tut-text' }, t(s.text)),
        h(
          'div',
          { class: 'tut-actions' },
          s.button ? h('button', { class: 'btn primary', onclick: () => this.advance() }, t(s.button)) : null,
          h('button', { class: 'btn link', onclick: () => this.finish() }, t('skip')),
        ),
      ),
    );
    if (s.focusNode && g.city.tutorialNode) {
      const n = g.city.tutorialNode;
      g.renderer.rig.focus(n.x, n.y, 190);
      g.renderer.overlays.setHints([n]);
    } else g.renderer.overlays.setHints([]);
    this.glow(s.target);
  }

  private glow(sel?: string): void {
    document.querySelectorAll('.tut-glow').forEach((e) => e.classList.remove('tut-glow'));
    if (!sel) return;
    document.querySelectorAll(`[data-tut="${sel}"]`).forEach((e) => e.classList.add('tut-glow'));
  }

  tick(dt: number): void {
    if (this.step < 0) return;
    this.glowT -= dt;
    if (this.glowT <= 0) {
      this.glowT = 0.4;
      // panels re-render, so re-apply the highlight
      this.glow(STEPS[this.step]?.target);
    }
  }

  event(ev: string): void {
    if (this.step < 0) return;
    const s = STEPS[this.step];
    if (!s?.wait) return;
    const g = this.game;
    if (s.wait === 'selectNode') {
      if (!ev.startsWith('selectNode')) return;
      const id = Number(ev.split(':')[1]);
      if (g.city.tutorialNode && id !== g.city.tutorialNode.id) return;
    } else if (!ev.startsWith(s.wait)) return;
    Audio.success();
    this.advance();
  }

  private advance(): void {
    this.step++;
    if (this.step >= STEPS.length) this.finish();
    else this.show();
  }

  finish(): void {
    this.step = -1;
    this.hide();
    const g = this.game;
    g.tutorialActive = false;
    g.save.tutorialDone = true;
    storeSave(g.save, true);
    g.renderer.overlays.setHints([]);
  }

  private hide(): void {
    this.el.style.display = 'none';
    this.glow();
  }
}
