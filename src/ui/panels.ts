// Context panels for the selected junction / road / vehicle.

import type { Game } from '../game/game.ts';
import { t, money } from '../game/i18n.ts';
import type { StrKey } from '../game/i18n.ts';
import { COST, unlockDay } from '../game/config.ts';
import type { Unlock } from '../game/config.ts';
import { ROAD_SPECS, SIG_G, SIG_P, kmh, slotsFor } from '../sim/network.ts';
import type { Arm, Control, Lane, Node, Road } from '../sim/network.ts';
import type { Phase as SigPhase, PlanType, SigMode } from '../sim/signals.ts';
import type { Vehicle } from '../sim/vehicle.ts';
import { MODEL } from '../sim/vehicle.ts';
import { ICON, arrowSvg, fmtSec, h, losColor, svg } from './dom.ts';
import { Audio } from '../audio/audio.ts';

function add(el: HTMLElement, ...kids: (HTMLElement | null | undefined | false)[]): void {
  for (const k of kids) if (k) el.append(k);
}

const MODEL_NAMES = ['Sedan', 'Hatchback', 'SUV', 'Van', 'Taxi', 'Truck', 'Bus', 'Ambulance', 'Police', 'Fire truck', 'Tow truck', 'Pickup'];

export class Panels {
  game: Game;
  root: HTMLElement;
  private live: (() => void)[] = [];
  /** lane counts being edited in the road panel, and why the last + was refused */
  private pendingLanes: { road: Road; ab: number; ba: number; note: string } | null = null;

  constructor(game: Game, root: HTMLElement) {
    this.game = game;
    this.root = root;
  }

  private locked(u: Unlock): boolean {
    return !this.game.unlocks.has(u);
  }

  /** one line under a section title: what the setting does to traffic */
  private desc(key: StrKey, lead = false): HTMLElement {
    return h('div', { class: `sec-desc ${lead ? 'lead' : ''}` }, t(key));
  }

  private lockNote(u: Unlock): HTMLElement {
    const n = unlockDay(this.game.preset, u);
    return h('div', { class: 'lock-note' }, svg(ICON.lock, 14), this.game.growth ? t('locked_level', { n }) : t('locked_feature', { n }));
  }

  render(): void {
    this.root.innerHTML = '';
    this.live = [];
    const sel = this.game.selection;
    this.root.classList.toggle('open', !!sel);
    if (!sel) return;
    if (sel.kind === 'node') this.nodePanel(sel.node);
    else if (sel.kind === 'road') this.roadPanel(sel.road);
    else this.vehiclePanel(sel.v);
    this.tick();
  }

  tick(): void {
    for (const f of this.live) f();
  }

  private header(kind: string, title: string, extra?: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'p-head' },
      h('div', { class: 'p-titles' }, h('div', { class: 'p-kind' }, kind), h('div', { class: 'p-title' }, title)),
      extra ?? null,
      h('button', { class: 'icon-btn p-close', title: t('close'), onclick: () => this.game.select(null) }, svg(ICON.close, 18)),
    );
  }

  // ------------------------------------------------------------------ junction

  private nodePanel(n: Node): void {
    const g = this.game;
    const los = g.sim.nodeLOS(n);
    const badge = h('div', { class: 'los-badge', style: { background: losColor(los) } }, los);
    this.live.push(() => {
      const l = g.sim.nodeLOS(n);
      badge.textContent = l;
      badge.style.background = losColor(l);
    });
    const body = h('div', { class: 'p-body' });
    this.root.append(h('div', { class: 'panel-card' }, this.header(t('junction'), n.name, badge), body));
    // live stats
    const stDelay = h('b', null, '');
    const stPassed = h('b', null, '');
    const stQueue = h('b', null, '');
    let lastPassed = n.passed;
    let lastT = performance.now();
    let rate = 0;
    this.live.push(() => {
      stDelay.textContent = `${Math.round(n.delayEMA)}${t('sec')}`;
      const now = performance.now();
      if (now - lastT > 4000) {
        rate = ((n.passed - lastPassed) / ((now - lastT) / 1000)) * 60 * (g.speed || 1) ** 0;
        lastPassed = n.passed;
        lastT = now;
      }
      stPassed.textContent = `${n.passed}`;
      let q = 0;
      for (const a of n.arms) for (const l of a.inLink?.lanes ?? []) q += l.queue;
      stQueue.textContent = `${q}`;
      void rate;
    });
    body.append(
      h(
        'div',
        { class: 'stats-row' },
        h('div', { class: 'stat' }, h('span', null, t('delay')), stDelay),
        h('div', { class: 'stat' }, h('span', null, t('throughput')), stPassed),
        h('div', { class: 'stat' }, h('span', null, t('queue')), stQueue),
      ),
    );
    // control type selector
    const ctrls: [Control, string, Unlock][] = [
      ['priority', ICON.priority, 'priority'],
      ['allstop', ICON.stop, 'allstop'],
      ['signal', ICON.signal, 'signal'],
      ['roundabout', ICON.roundabout, 'roundabout'],
    ];
    const grid = h('div', { class: 'ctrl-grid' });
    for (const [c, icon, u] of ctrls) {
      const cost = g.controlCost(n, c);
      const lock = this.locked(u);
      const noRoom = c === 'roundabout' && !g.canRoundabout(n);
      const b = h(
        'button',
        {
          class: `ctrl-btn ${n.control === c ? 'active' : ''} ${lock || noRoom ? 'disabled' : ''}`,
          'data-tut': `ctrl-${c}`,
          title: t(`ctrlDesc_${c}` as StrKey),
          onclick: () => {
            if (lock) return;
            g.setControl(n, c);
          },
        },
        svg(icon, 30),
        h('span', { class: 'ctrl-name' }, t(`ctrl_${c}` as StrKey)),
        lock ? h('span', { class: 'cost lock' }, svg(ICON.lock, 12), `${g.growth ? t('level') : t('day')} ${unlockDay(g.preset, u)}`) : n.control === c ? h('span', { class: 'cost on' }, '✓') : h('span', { class: `cost ${g.canAfford(cost) ? '' : 'bad'}` }, money(cost)),
      );
      grid.append(b);
    }
    body.append(h('div', { class: 'sec-title' }, t('control')), this.desc('ctrlSecDesc'), grid, h('div', { class: 'hint' }, t(`ctrlDesc_${n.control === 'none' ? 'priority' : n.control}` as StrKey)));
    if (n.control === 'priority') this.prioritySection(body, n);
    if (n.control === 'signal' && n.signal) this.signalSection(body, n);
    // police (gridlock breaker)
    {
      const cd = (g.policeCooldown.get(n.id) ?? 0) - g.sim.time;
      body.append(
        this.desc('policeDesc', true),
        h(
          'button',
          { class: `btn wide police ${cd > 0 ? 'disabled' : ''}`, title: t('policeDesc'), onclick: () => g.sendPolice(n) },
          h('span', null, '🚓 ', t('police')),
          h('span', { class: 'cost' }, money(COST.police)),
        ),
      );
    }
    // yellow box
    if (n.control !== 'roundabout') {
      const lock = this.locked('box');
      body.append(
        this.desc('boxDesc', true),
        this.toggleRow(svg(ICON.box, 20), t('boxJunction'), n.box, lock ? null : `${money(COST.box)}`, lock, () => g.toggleBox(n), lock ? this.lockNote('box') : null),
      );
    }
    // lanes & turns
    if (n.control !== 'roundabout') this.lanesSection(body, n);
  }

  private toggleRow(icon: HTMLElement, label: string, on: boolean, cost: string | null, lock: boolean, fn: () => void, note: HTMLElement | null = null): HTMLElement {
    return h(
      'div',
      { class: `toggle-row ${lock ? 'disabled' : ''}` },
      icon,
      h('span', { class: 'tr-label' }, label, note),
      cost && !on ? h('span', { class: 'cost' }, cost) : null,
      h('button', { class: `switch ${on ? 'on' : ''}`, disabled: lock, onclick: () => !lock && fn() }, h('i')),
    );
  }

  private prioritySection(body: HTMLElement, n: Node): void {
    const g = this.game;
    // every pair of arms can carry the major road: straight through or turning
    const arms = n.arms;
    const grid = h('div', { class: 'major-grid' });
    for (let i = 0; i < arms.length; i++)
      for (let j = i + 1; j < arms.length; j++) {
        const A = arms[i];
        const B = arms[j];
        const on = n.majorRoads.size === 2 && n.majorRoads.has(A.road.id) && n.majorRoads.has(B.road.id);
        const label = A.road.name === B.road.name ? A.road.name : `${A.road.name} · ${B.road.name}`;
        grid.append(
          h(
            'button',
            { class: `major-opt ${on ? 'active' : ''}`, title: label, onclick: () => g.setMajor(n, A, B) },
            h('div', { class: 'major-dia', html: majorDiagram(n, A, B, g.renderer.rig.yaw) }),
            h('span', null, label),
          ),
        );
      }
    body.append(
      h('div', { class: 'sec-title' }, t('majorRoad'), h('span', { class: 'sec-extra' }, money(COST.priority))),
      this.desc('majorHint'),
      grid,
      h('div', { class: 'sec-title' }, t('minorSign')),
      this.desc('minorDesc'),
      h(
        'div',
        { class: 'seg' },
        h('button', { class: n.stopMinor ? 'active' : '', onclick: () => g.setStopMinor(n, true) }, svg(ICON.stop, 18), t('stopSign')),
        h('button', { class: !n.stopMinor ? 'active' : '', onclick: () => g.setStopMinor(n, false) }, svg(ICON.yield, 18), t('yieldSign')),
      ),
    );
  }

  private signalSection(body: HTMLElement, n: Node): void {
    const g = this.game;
    const s = n.signal!;
    // plan
    const plans: PlanType[] = ['two', 'leftlead', 'split'];
    body.append(
      h('div', { class: 'sec-title' }, t('plan')),
      this.desc(`planDesc_${s.plan}` as StrKey),
      h(
        'div',
        { class: 'seg' },
        ...plans.map((p) => h('button', { class: s.plan === p ? 'active' : '', title: t(`planDesc_${p}` as StrKey), onclick: () => g.setPlan(n, p) }, t(`plan_${p}` as StrKey))),
      ),
    );
    // controller mode
    const modes: [SigMode, Unlock, number][] = [
      ['fixed', 'timing', 0],
      ['actuated', 'actuated', COST.actuated],
      ['smart', 'smart', COST.smart],
    ];
    const modeRow = h('div', { class: 'seg' });
    for (const [m, u, c] of modes) {
      const lock = this.locked(u);
      modeRow.append(
        h(
          'button',
          { class: `${s.mode === m ? 'active' : ''} ${lock ? 'disabled' : ''}`, title: t(`modeDesc_${m}` as StrKey), onclick: () => !lock && g.setMode(n, m) },
          lock ? svg(ICON.lock, 12) : null,
          t(`mode_${m}` as StrKey),
          c && s.mode !== m && !lock ? h('small', null, ` ${money(c)}`) : null,
        ),
      );
    }
    body.append(h('div', { class: 'sec-title' }, t('mode')), this.desc(`modeDesc_${s.mode}` as StrKey), modeRow);
    // phases
    const list = h('div', { class: 'phase-list' });
    s.phases.forEach((p, i) => list.append(this.phaseRow(n, p, i)));
    const cycle = h('span', null, '');
    this.live.push(() => {
      const c = s.coord ? s.coord.cycle : s.cycleLength;
      cycle.textContent = `${t('cycle')}: ${Math.round(c)}${t('sec')}${s.coord ? ' 🌊' : ''}`;
    });
    add(
      body,
      h('div', { class: 'sec-title' }, t('phases'), h('span', { class: 'sec-extra' }, cycle)),
      this.desc(`phasesDesc_${s.mode}` as StrKey),
      list,
      s.mode === 'smart' ? null : h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: () => g.autoTime(n) }, svg(ICON.auto, 16), t('autoTime'))),
    );
    if (!this.locked('greenwave')) this.waveSection(body, n);
    // all-red
    const val = h('b', null, `${s.allRed.toFixed(1)}${t('sec')}`);
    const range = h('input', { type: 'range', min: '0.5', max: '4', step: '0.5', value: String(s.allRed) }) as HTMLInputElement;
    range.addEventListener('input', () => {
      g.setAllRed(n, Number(range.value));
      val.textContent = `${Number(range.value).toFixed(1)}${t('sec')}`;
      warn.style.display = Number(range.value) < 1.5 ? '' : 'none';
    });
    const warn = h('div', { class: 'hint bad', style: { display: s.allRed < 1.5 ? '' : 'none' } }, '⚠ ', t('allRedWarn'));
    body.append(h('div', { class: 'sec-title' }, t('allRed')), this.desc('allRedDesc'), h('div', { class: 'slider-row' }, h('span', null, t('allRed')), range, val), warn);
    if (!this.locked('rtor')) body.append(this.desc('rtorDesc', true), this.toggleRow(svg(ICON.signal, 18), t('rtor'), n.rtor, money(COST.rtor), false, () => g.toggleRTOR(n)));
  }

  private waveSection(body: HTMLElement, n: Node): void {
    const g = this.game;
    const w = g.sim.waves;
    body.append(h('div', { class: 'sec-title' }, t('greenWave'), h('span', { class: 'sec-extra' }, money(COST.greenwave))), this.desc('greenWaveDesc'));
    for (const name of [...new Set(n.arms.map((a) => a.road.name))]) {
      const c = w.get(name);
      const signals = g.sim.signalNodes.filter((m) => m.arms.some((a) => a.road.name === name)).length;
      const lock = !c && signals < 2;
      body.append(this.toggleRow(svg(ICON.wave, 18), name, !!c, money(COST.greenwave), lock, () => g.toggleWave(n, name), lock ? h('div', { class: 'hint' }, t('waveNeeds')) : null));
      if (!c || c.members.length < 2) continue;
      // the cross streets at both ends name the two directions
      const cross = (m: Node): string => m.name.split(' & ').find((x) => x !== name) ?? m.name;
      const fwd = cross(c.members[c.members.length - 1]);
      const back = cross(c.members[0]);
      const dirs: [number, string][] = [
        [0, t('waveAuto')],
        [1, `➜ ${fwd}`],
        [-1, `➜ ${back}`],
      ];
      add(
        body,
        h('div', { class: 'hint' }, t('waveMembers', { n: c.members.length, c: Math.round(w.cycle) })),
        h('div', { class: 'seg wave-dir' }, ...dirs.map(([d, label]) => h('button', { class: c.dir === d ? 'active' : '', onclick: () => g.setWaveDir(name, d) }, label))),
        c.dir === 0 ? h('div', { class: 'hint' }, t('waveNow', { r: c.active > 0 ? fwd : back })) : null,
      );
    }
  }

  private phaseRow(n: Node, p: SigPhase, i: number): HTMLElement {
    const g = this.game;
    const s = n.signal!;
    const smart = s.mode === 'smart';
    const dia = h('div', { class: 'phase-dia', html: phaseDiagram(n, p, g.renderer.rig.yaw) });
    const prog = h('i');
    const lbl = h('b', null, `${p.dur}${t('sec')}`);
    const last = h('small', { class: 'phase-last' }, '');
    const range = h('input', { type: 'range', min: '4', max: '75', step: '1', value: String(p.dur), disabled: smart }) as HTMLInputElement;
    range.addEventListener('input', () => {
      g.setPhaseDur(n, i, Number(range.value));
      lbl.textContent = `${range.value}${t('sec')}`;
    });
    const title = s.mode === 'fixed' ? t('green') : smart ? t('aiGreen') : t('maxGreen');
    const row = h(
      'div',
      { class: 'phase-row' },
      dia,
      h('div', { class: 'phase-ctl' }, h('div', { class: 'phase-top' }, h('span', null, `${title} ${i + 1}`), last, lbl), range, h('div', { class: 'phase-prog' }, prog)),
    );
    this.live.push(() => {
      const active = s.cur === i;
      row.classList.toggle('active', active);
      row.classList.toggle('yellow', active && s.state !== 'G');
      // the green this phase can still get: schedule (green wave), maximum (detectors) or set time
      const total = s.coord && active ? s.t + Math.max(0, s.forceOff - g.sim.time) : s.mode === 'fixed' ? p.dur : s.maxGreen(p);
      const frac = active ? (s.state === 'G' ? Math.min(1, s.t / Math.max(1, total)) : 1) : 0;
      prog.style.width = `${frac * 100}%`;
      // timings that change by themselves: show what was actually given
      if (s.mode !== 'fixed' || s.coord) last.textContent = p.lastGreen > 0 ? t('lastGreen', { s: Math.round(p.lastGreen) }) : '';
      if (smart && Number(range.value) !== p.dur) {
        range.value = String(p.dur);
        lbl.textContent = `${p.dur}${t('sec')}`;
      }
    });
    return row;
  }

  private lanesSection(body: HTMLElement, n: Node): void {
    const g = this.game;
    const lock = this.locked('arrows');
    const sec = h('div', { class: 'lanes-sec' });
    body.append(h('div', { class: 'sec-title' }, t('approaches'), h('span', { class: 'sec-extra' }, money(COST.arrows))), this.desc('approachesDesc'), lock ? this.lockNote('arrows') : h('div', { class: 'hint' }, t('laneHint')), sec);
    for (const arm of n.arms) {
      const inL = arm.inLink;
      if (!inL || inL.lanes.length === 0) continue;
      const row = h('div', { class: 'approach' }, h('div', { class: 'appr-name' }, dirArrow(arm, g.renderer.rig.yaw), arm.road.name));
      const btns = h('div', { class: 'lane-btns' });
      const lanes = inL.lanes.slice().reverse(); // left lane first
      for (const lane of lanes) {
        const opts = g.laneOptions(lane);
        const b = h('button', {
          class: `lane-btn ${lane.busOnly ? 'bus' : ''} ${lock || opts.length < 2 ? 'disabled' : ''}`,
          html: arrowSvg(lane.arrows, 24),
          onclick: () => !lock && opts.length >= 2 && g.cycleArrows(lane),
        });
        btns.append(b);
      }
      row.append(btns);
      sec.append(row);
    }
  }

  // ------------------------------------------------------------------ road

  private roadPanel(r: Road): void {
    const g = this.game;
    const body = h('div', { class: 'p-body' });
    const len = Math.round(r.trimmedLength);
    this.root.append(h('div', { class: 'panel-card' }, this.header(`${t('road')} · ${len} m`, r.name), body));
    const st = h('b');
    const sp = h('b');
    this.live.push(() => {
      let n = 0;
      let sv = 0;
      for (const l of [r.ab, r.ba]) for (const lane of l.lanes) for (const v of lane.vehs) {
        n++;
        sv += v.v;
      }
      st.textContent = String(n);
      sp.textContent = `${n ? Math.round((sv / n) * 3.6) : kmh(r.speed)} ${t('speedUnit')}`;
    });
    body.append(h('div', { class: 'stats-row' }, h('div', { class: 'stat' }, h('span', null, t('vehicles')), st), h('div', { class: 'stat' }, h('span', null, t('avgSpeed')), sp)));
    // lanes editor: re-stripe within the current width, or widen the road for more lanes
    const lock = this.locked('restripe');
    const pend = this.pendingLanes && this.pendingLanes.road === r ? this.pendingLanes : { road: r, ab: r.lanesAB, ba: r.lanesBA, note: '' };
    this.pendingLanes = pend;
    const toA = r.a.name.split(' & ').find((x) => x !== r.name) ?? r.a.name;
    const toB = r.b.name.split(' & ').find((x) => x !== r.name) ?? r.b.name;
    const dirRow = (label: string, which: 'ab' | 'ba', heading: number): HTMLElement => {
      const val = h('b', { class: 'lane-count' }, String(pend[which]));
      const vis = h('div', { class: 'lane-vis' });
      const draw = (): void => {
        vis.innerHTML = '';
        for (let i = 0; i < pend[which]; i++) vis.append(h('span', { class: 'lane-pip', style: { transform: `rotate(${heading}deg)` } }, '➜'));
        if (pend[which] === 0) vis.append(h('span', { class: 'lane-none' }, '—'));
        val.textContent = String(pend[which]);
      };
      draw();
      const change = (d: number): void => {
        const nab = which === 'ab' ? pend.ab + d : pend.ab;
        const nba = which === 'ba' ? pend.ba + d : pend.ba;
        pend.note = '';
        // a divided road keeps both directions; any road keeps at least one lane
        const min = r.median > 0 ? 1 : 0;
        if (nab < min || nba < min || nab + nba === 0) return;
        const slots = slotsFor(r, nab, nba);
        const why = slots > r.maxLanes ? g.widenBlocker(r, slots) : null;
        if (why) {
          pend.note = t(`widen_${why}` as StrKey);
          Audio.error();
        } else {
          pend.ab = nab;
          pend.ba = nba;
        }
        this.render();
      };
      return h(
        'div',
        { class: 'dir-row' },
        h('span', { class: 'dir-label' }, label),
        vis,
        h('button', { class: 'icon-btn sm', disabled: lock, onclick: () => change(-1) }, '−'),
        val,
        h('button', { class: 'icon-btn sm', disabled: lock, onclick: () => change(1) }, '+'),
      );
    };
    const angAB = (Math.atan2(r.b.y - r.a.y, r.b.x - r.a.x) * 180) / Math.PI + (g.renderer.rig.yaw * 180) / Math.PI;
    const changed = pend.ab !== r.lanesAB || pend.ba !== r.lanesBA;
    const extra = slotsFor(r, pend.ab, pend.ba) - r.maxLanes;
    let note: HTMLElement | null = null;
    if (lock) note = this.lockNote('restripe');
    else if (pend.note) note = h('div', { class: 'hint bad' }, pend.note);
    else if (changed && extra > 0) note = h('div', { class: 'hint' }, '🚧 ', extra === 1 ? t('widenNote1') : t('widenNote', { n: extra }));
    else if (!changed) note = h('div', { class: 'hint' }, t('lanesHint', { c: money(COST.widen) }));
    add(
      body,
      h('div', { class: 'sec-title' }, t('lanes'), h('span', { class: 'sec-extra' }, t('widthM', { m: Math.round(r.width) }))),
      this.desc('lanesDesc'),
      dirRow(t('towards', { r: toB }), 'ab', angAB),
      dirRow(t('towards', { r: toA }), 'ba', angAB + 180),
      note,
    );
    if (!lock && changed) {
      body.append(
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: 'btn primary', onclick: () => {
            if (g.restripe(r, pend.ab, pend.ba)) this.pendingLanes = null;
            else {
              pend.ab = r.lanesAB;
              pend.ba = r.lanesBA;
            }
            this.render();
          } }, t(extra > 0 ? 'widenApply' : 'apply'), h('span', { class: 'cost' }, money(g.restripeCost(r, pend.ab, pend.ba)))),
          h('button', { class: 'btn', onclick: () => {
            this.pendingLanes = null;
            this.render();
          } }, t('undo')),
        ),
      );
    }
    // speed limit
    const slock = this.locked('speed');
    const speeds = [30, 40, 50, 60, 70];
    add(
      body,
      h('div', { class: 'sec-title' }, t('speedLimit'), h('span', { class: 'sec-extra' }, money(COST.speed))),
      this.desc('speedDesc'),
      slock ? this.lockNote('speed') : null,
      h(
        'div',
        { class: 'seg speeds' },
        ...speeds.map((s) =>
          h('button', { class: `${kmh(r.speed) === s ? 'active' : ''} ${slock ? 'disabled' : ''}`, onclick: () => !slock && g.setSpeed(r, s) }, h('span', { class: 'speed-sign' }, String(s))),
        ),
      ),
    );
    // bus lanes
    const block = this.locked('bus');
    add(body, h('div', { class: 'sec-title' }, t('busLane'), h('span', { class: 'sec-extra' }, money(COST.bus))), this.desc('busDesc'), block ? this.lockNote('bus') : null);
    if (r.lanesAB > 1) body.append(this.toggleRow(svg(ICON.bus, 18), t('towards', { r: toB }), r.busAB, null, block, () => g.toggleBus(r, true)));
    if (r.lanesBA > 1) body.append(this.toggleRow(svg(ICON.bus, 18), t('towards', { r: toA }), r.busBA, null, block, () => g.toggleBus(r, false)));
    void ROAD_SPECS;
  }

  // ------------------------------------------------------------------ vehicle

  private vehiclePanel(v: Vehicle): void {
    const g = this.game;
    const body = h('div', { class: 'p-body' });
    const name = MODEL_NAMES[v.model] ?? 'Vehicle';
    const persona = v.aggr > 0.62 ? `${t('aggressive')} 😤` : v.aggr < 0.32 ? `${t('calm')} 😌` : `${t('normal')} 🙂`;
    this.root.append(h('div', { class: 'panel-card' }, this.header(t('vehicle'), `${name}`), body));
    const status = h('b');
    const speed = h('b');
    const waited = h('b');
    this.live.push(() => {
      status.textContent = t(g.vehicleStatus(v));
      speed.textContent = `${Math.round(v.v * 3.6)} ${t('speedUnit')}`;
      waited.textContent = fmtSec(v.waitTotal);
    });
    body.append(
      h('div', { class: 'kv' }, h('span', null, t('driver')), h('b', null, v.emergency ? '🚑' : persona)),
      h('div', { class: 'kv' }, h('span', null, t('status')), status),
      h('div', { class: 'kv' }, h('span', null, t('speed')), speed),
      h('div', { class: 'kv' }, h('span', null, t('waited')), waited),
    );
    if (v.dest) {
      const b = g.city.buildings[v.dest.building];
      body.append(h('div', { class: 'kv' }, h('span', null, t('heading')), h('b', null, b ? b.road.name : v.dest.link.road.name)));
    } else if (!v.tow) body.append(h('div', { class: 'kv' }, h('span', null, t('heading')), h('b', null, t('leavingCity'))));
    if (v.state !== 'crashed') {
      body.append(
        h(
          'div',
          { class: 'row gap' },
          h('button', { class: `btn ${g.follow === v ? 'primary' : ''}`, onclick: () => {
            g.follow = g.follow === v ? null : v;
            this.render();
          } }, svg(ICON.eye, 16), t('follow')),
        ),
      );
    }
    const inc = g.incidentOf(v);
    if (inc) {
      const timer = h('span');
      this.live.push(() => {
        timer.textContent = t('policeClears', { t: fmtSec(Math.max(0, inc.clearAfter - inc.age)) });
      });
      body.append(
        h(
          'div',
          { class: 'incident-box' },
          h('div', { class: 'inc-title' }, '💥 ', t('accident')),
          h('div', { class: 'hint' }, timer),
          inc.tow
            ? h('div', { class: 'hint good' }, svg(ICON.tow, 16), t('towOnWay'))
            : h('button', { class: 'btn primary wide', onclick: () => g.dispatchTow(inc) }, svg(ICON.tow, 18), t('dispatchTow'), h('span', { class: 'cost' }, money(COST.tow))),
        ),
      );
    }
    void MODEL;
    void SIG_G;
  }
}

function dirArrow(arm: Arm, yaw: number): HTMLElement {
  // direction of travel when approaching (towards the junction)
  const ang = (Math.atan2(-arm.dir.y, -arm.dir.x) * 180) / Math.PI + (yaw * 180) / Math.PI;
  return h('span', { class: 'appr-dir', style: { transform: `rotate(${ang}deg)` } }, '➜');
}

/** SVG diagram of the movements that are green in a phase */
/** small map of a junction with the major road drawn through two of its arms */
export function majorDiagram(n: Node, A: Arm, B: Arm, yaw: number): string {
  const C = 24;
  const R = 20;
  const parts: string[] = [];
  parts.push(`<circle cx="${C}" cy="${C}" r="7" fill="#3a3f47"/>`);
  for (const a of n.arms)
    parts.push(`<line x1="${C}" y1="${C}" x2="${(C + a.dir.x * R).toFixed(1)}" y2="${(C + a.dir.y * R).toFixed(1)}" stroke="#3a3f47" stroke-width="9" stroke-linecap="round"/>`);
  const ax = C + A.dir.x * R;
  const ay = C + A.dir.y * R;
  const bx = C + B.dir.x * R;
  const by = C + B.dir.y * R;
  parts.push(`<path d="M${ax.toFixed(1)} ${ay.toFixed(1)} Q${C} ${C} ${bx.toFixed(1)} ${by.toFixed(1)}" stroke="#ffc23a" stroke-width="5" fill="none" stroke-linecap="round"/>`);
  const deg = (yaw * 180) / Math.PI;
  return `<svg width="48" height="48" viewBox="0 0 48 48"><g transform="rotate(${deg.toFixed(1)} 24 24)">${parts.join('')}</g></svg>`;
}

export function phaseDiagram(n: Node, p: SigPhase, yaw: number): string {
  const C = 32;
  const R = 26;
  const parts: string[] = [];
  parts.push(`<circle cx="${C}" cy="${C}" r="9" fill="#3a3f47"/>`);
  for (const a of n.arms) {
    const x = C + a.dir.x * R;
    const y = C + a.dir.y * R;
    parts.push(`<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" stroke="#3a3f47" stroke-width="12" stroke-linecap="round"/>`);
  }
  const seen = new Set<string>();
  for (const [c, st] of p.green) {
    if (!c.inArm || !c.outArm) continue;
    const key = `${c.inArm.index}-${c.outArm.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const A = c.inArm;
    const B = c.outArm;
    const rA = { x: -A.dir.y, y: A.dir.x };
    const rB = { x: -B.dir.y, y: B.dir.x };
    const sx = C + A.dir.x * 24 - rA.x * 3.2;
    const sy = C + A.dir.y * 24 - rA.y * 3.2;
    const ex = C + B.dir.x * 24 + rB.x * 3.2;
    const ey = C + B.dir.y * 24 + rB.y * 3.2;
    const col = st === SIG_G ? '#3ee07a' : '#b7f5c9';
    const dash = st === SIG_P ? 'stroke-dasharray="3 2.5"' : '';
    const cx = C + (A.dir.x * 4 + B.dir.x * 4) - rA.x * 2;
    const cy = C + (A.dir.y * 4 + B.dir.y * 4) - rA.y * 2;
    parts.push(`<path d="M${sx.toFixed(1)} ${sy.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="${col}" stroke-width="2.2" fill="none" ${dash}/>`);
    // arrow head
    const hx = ex - (cx - ex) * 0.0;
    const dx = ex - cx;
    const dy = ey - cy;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    parts.push(
      `<path d="M${(hx - ux * 4.5 - uy * 3).toFixed(1)} ${(ey - uy * 4.5 + ux * 3).toFixed(1)} L${hx.toFixed(1)} ${ey.toFixed(1)} L${(hx - ux * 4.5 + uy * 3).toFixed(1)} ${(ey - uy * 4.5 - ux * 3).toFixed(1)}" fill="${col}" stroke="none"/>`,
    );
  }
  const deg = (yaw * 180) / Math.PI;
  return `<svg width="64" height="64" viewBox="0 0 64 64"><g transform="rotate(${deg.toFixed(1)} 32 32)">${parts.join('')}</g></svg>`;
}

export type { Lane };
