// CrazyGames SDK v3 integration with graceful fallback when the SDK is not
// available (local development, other hosts, ad blockers).

interface CGSDK {
  init(): Promise<void>;
  environment: string;
  game: {
    loadingStart(): void;
    loadingStop(): void;
    gameplayStart(): void;
    gameplayStop(): void;
    happytime(): void;
    settings?: { muteAudio?: boolean };
    addSettingsChangeListener?(cb: (s: { muteAudio?: boolean }) => void): void;
  };
  ad: {
    requestAd(type: 'midgame' | 'rewarded', cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: unknown) => void }): void;
    hasAdblock?(): Promise<boolean>;
  };
  data?: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
}

declare global {
  interface Window {
    CrazyGames?: { SDK: CGSDK };
  }
}

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

class PlatformImpl {
  private sdk: CGSDK | null = null;
  ready = false;
  private gameplay = false;
  private lastMidgame = 0;
  onAdStart: (() => void) | null = null;
  onAdEnd: (() => void) | null = null;
  onMuteChange: ((muted: boolean) => void) | null = null;
  muted = false;

  async init(): Promise<void> {
    try {
      if (!window.CrazyGames) await this.loadScript(3500);
      if (window.CrazyGames?.SDK) {
        const sdk = window.CrazyGames.SDK;
        await Promise.race([sdk.init(), new Promise((_, rej) => setTimeout(() => rej(new Error('sdk init timeout')), 4000))]);
        if (sdk.environment === 'disabled') return;
        this.sdk = sdk;
        this.ready = true;
        try {
          this.muted = !!sdk.game.settings?.muteAudio;
          sdk.game.addSettingsChangeListener?.((s) => {
            this.muted = !!s.muteAudio;
            this.onMuteChange?.(this.muted);
          });
        } catch {
          /* optional */
        }
      }
    } catch (e) {
      console.info('[platform] CrazyGames SDK unavailable, running standalone.', e);
      this.sdk = null;
    }
  }

  private loadScript(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      const done = (): void => resolve();
      s.onload = done;
      s.onerror = done;
      setTimeout(done, timeout);
      document.head.appendChild(s);
    });
  }

  loadingStart(): void {
    try {
      this.sdk?.game.loadingStart();
    } catch {
      /* ignore */
    }
  }

  loadingStop(): void {
    try {
      this.sdk?.game.loadingStop();
    } catch {
      /* ignore */
    }
  }

  gameplayStart(): void {
    if (this.gameplay) return;
    this.gameplay = true;
    try {
      this.sdk?.game.gameplayStart();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    if (!this.gameplay) return;
    this.gameplay = false;
    try {
      this.sdk?.game.gameplayStop();
    } catch {
      /* ignore */
    }
  }

  happytime(): void {
    try {
      this.sdk?.game.happytime();
    } catch {
      /* ignore */
    }
  }

  /** Midgame ad between days. Resolves when the game may continue. */
  midgame(): Promise<void> {
    if (!this.sdk) return Promise.resolve();
    const now = Date.now();
    if (now - this.lastMidgame < 3 * 60 * 1000) return Promise.resolve();
    this.lastMidgame = now;
    return new Promise((resolve) => {
      let finished = false;
      const end = (): void => {
        if (finished) return;
        finished = true;
        this.onAdEnd?.();
        resolve();
      };
      try {
        this.sdk!.ad.requestAd('midgame', {
          adStarted: () => this.onAdStart?.(),
          adFinished: end,
          adError: end,
        });
      } catch {
        end();
      }
      setTimeout(end, 60000);
    });
  }

  /** Rewarded ad. Resolves true if the reward should be granted. */
  rewarded(): Promise<boolean> {
    if (!this.sdk) return Promise.resolve(import.meta.env?.DEV ? true : false);
    return new Promise((resolve) => {
      let finished = false;
      const end = (ok: boolean): void => {
        if (finished) return;
        finished = true;
        this.onAdEnd?.();
        resolve(ok);
      };
      try {
        this.sdk!.ad.requestAd('rewarded', {
          adStarted: () => this.onAdStart?.(),
          adFinished: () => end(true),
          adError: () => end(false),
        });
      } catch {
        end(false);
      }
      setTimeout(() => end(false), 90000);
    });
  }

  get hasAds(): boolean {
    return !!this.sdk;
  }

  getItem(k: string): string | null {
    try {
      const v = this.sdk?.data?.getItem(k);
      if (v !== undefined && v !== null) return v;
    } catch {
      /* fall back */
    }
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }

  setItem(k: string, v: string): void {
    try {
      this.sdk?.data?.setItem(k, v);
    } catch {
      /* ignore */
    }
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  }

  removeItem(k: string): void {
    try {
      this.sdk?.data?.removeItem(k);
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export const Platform = new PlatformImpl();
