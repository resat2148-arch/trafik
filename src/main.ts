import './fonts.css';
import './styles.css';
import { Game } from './game/game.ts';
import { UI } from './ui/ui.ts';
import { detectLang, setLang, t } from './game/i18n.ts';
import { Platform } from './platform/crazygames.ts';
import { Audio } from './audio/audio.ts';
import { loadSave } from './game/save.ts';

const bootFill = document.getElementById('boot-fill') as HTMLElement;
const boot = document.getElementById('boot') as HTMLElement;
const progress = (p: number): void => {
  bootFill.style.width = `${Math.round(p * 100)}%`;
};

async function main(): Promise<void> {
  progress(0.05);
  Platform.loadingStart();
  const sdk = Platform.init();
  const game = new Game();
  setLang(game.save.lang ?? detectLang());
  progress(0.15);
  await sdk;
  // the platform may hold its own (cloud) save: reload it now that the SDK is ready
  game.save = loadSave();
  setLang(game.save.lang ?? detectLang());
  progress(0.3);
  await frame();
  const view = document.getElementById('view') as HTMLElement;
  game.initRenderer(view);
  progress(0.5);
  await frame();
  const ui = new UI(game, document.getElementById('ui') as HTMLElement);
  game.ui = ui;
  const menuCity = game.save.run?.city ?? 'maple';
  game.loadCity(menuCity, game.save.run, true);
  game.renderer.rig.autoOrbit = true;
  progress(0.9);
  await frame();
  Audio.setVolumes(game.save.sfx, game.save.music);
  Audio.setPlatformMuted(Platform.muted);
  Platform.onMuteChange = (m) => Audio.setPlatformMuted(m);
  Platform.onAdStart = () => Audio.setMuted(true);
  Platform.onAdEnd = () => Audio.setMuted(false);
  const unlock = (): void => {
    Audio.unlock();
    Audio.setMusic(game.save.music > 0.01);
  };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });
  game.setPhase('menu');
  progress(1);
  Platform.loadingStop();
  boot.classList.add('hide');
  setTimeout(() => boot.remove(), 600);

  // pause when the tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.phase === 'playing' && game.speed !== 0) ui.menus.pauseMenu();
  });

  let last = performance.now();
  let fpsT = 0;
  let frames = 0;
  // step graphics down on slow devices unless the player picked a level
  let slowT = 0;
  const autoQuality = (fps: number): void => {
    if (game.save.qualityManual || game.phase !== 'playing' || game.speed === 0 || document.hidden) {
      slowT = 0;
      return;
    }
    slowT = fps < 26 ? slowT + 1 : Math.max(0, slowT - 1);
    if (slowT < 6) return;
    slowT = 0;
    const lv = game.renderer.level;
    const next = lv === 'high' ? 'medium' : lv === 'medium' ? 'low' : null;
    if (!next) return;
    game.applyQuality(next, false);
    ui.toast(t('qualityAuto'), 'info');
  };
  const loop = (now: number): void => {
    const raw = (now - last) / 1000;
    const dt = Math.min(0.1, raw);
    last = now;
    game.renderer.rig.autoOrbit = game.phase === 'menu';
    game.update(dt);
    ui.tick(dt);
    // frame rate from real time; long stalls (hidden tab, ads) restart the window
    if (raw > 1.5) {
      frames = 0;
      fpsT = 0;
    } else {
      frames++;
      fpsT += raw;
    }
    if (fpsT > 1) {
      (window as unknown as { __fps: number }).__fps = frames / fpsT;
      autoQuality(frames / fpsT);
      frames = 0;
      fpsT = 0;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as { __game: Game }).__game = game;
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot');
  if (el) el.innerHTML = `<div style="color:#fff;font:16px sans-serif;padding:20px;text-align:center">Failed to start: ${String(e?.message ?? e)}</div>`;
});
