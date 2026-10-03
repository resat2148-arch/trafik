// Procedural Web Audio: city ambience, horns, sirens, crashes, rain, UI sounds
// and a small generative lo-fi music loop. No audio files are needed.

class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private musicBus!: GainNode;
  private ambient!: GainNode;
  private rainGain!: GainNode;
  private sirenGain!: GainNode;
  private sirenOsc!: OscillatorNode;
  private noiseBuf!: AudioBuffer;
  sfxVol = 0.8;
  musicVol = 0.5;
  muted = false;
  private platformMuted = false;
  private musicOn = false;
  private nextNote = 0;
  private step = 0;
  private schedTimer: number | null = null;
  private hornBudget = 0;
  tension = 0;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.applyVolumes();
    // noise buffer (brownian-ish)
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5 * 0.6 + w * 0.08;
    }
    // ambience: low traffic rumble
    const amb = ctx.createBufferSource();
    amb.buffer = this.noiseBuf;
    amb.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0;
    amb.connect(lp).connect(this.ambient).connect(this.sfx);
    amb.start();
    // rain
    const rn = ctx.createBufferSource();
    rn.buffer = this.makeWhite();
    rn.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 6000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rn.connect(hp).connect(lp2).connect(this.rainGain).connect(this.sfx);
    rn.start();
    // siren voice (continuous, gain controlled)
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sawtooth';
    this.sirenOsc.frequency.value = 700;
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 1100;
    sf.Q.value = 0.8;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(sf).connect(this.sirenGain).connect(this.sfx);
    this.sirenOsc.start();
    if (this.musicOn) this.startMusic();
  }

  private makeWhite(): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  setPlatformMuted(m: boolean): void {
    this.platformMuted = m;
    this.applyVolumes();
  }

  setVolumes(sfx: number, music: number): void {
    this.sfxVol = sfx;
    this.musicVol = music;
    this.applyVolumes();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const off = this.muted || this.platformMuted;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(off ? 0 : 1, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.sfxVol * 0.9, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.musicVol * 0.32, t, 0.05);
  }

  /** continuous layers: traffic rumble, rain, siren proximity */
  update(traffic: number, rain: number, siren: number, time: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.ambient.gain.setTargetAtTime(Math.min(0.5, traffic * 0.5), t, 0.4);
    this.rainGain.gain.setTargetAtTime(rain * 0.22, t, 0.6);
    this.sirenGain.gain.setTargetAtTime(siren * 0.05, t, 0.15);
    if (siren > 0.01) {
      // European two-tone (hi-lo) siren
      const hi = Math.floor(time * 1.6) % 2 === 0;
      this.sirenOsc.frequency.setTargetAtTime(hi ? 950 : 712, t, 0.02);
    }
    this.hornBudget = Math.min(3, this.hornBudget + 0.05);
  }

  private env(g: GainNode, t0: number, a: number, peak: number, d: number): void {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, pan = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    this.env(g, t0, 0.008, vol, dur);
    let node: AudioNode = o.connect(g);
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node = node.connect(p);
    }
    node.connect(this.sfx);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  click(): void {
    this.tone('sine', 900, 620, 0.06, 0.15);
  }

  select(): void {
    this.tone('triangle', 520, 780, 0.09, 0.14);
  }

  cash(): void {
    this.tone('sine', 1320, 1320, 0.07, 0.12);
    this.tone('sine', 1760, 1760, 0.12, 0.12, 0.07);
  }

  build(): void {
    this.noiseBurst(0.18, 1400, 0.25);
    this.tone('square', 180, 120, 0.12, 0.08, 0.02);
    this.tone('triangle', 660, 990, 0.15, 0.1, 0.12);
  }

  alert(): void {
    this.tone('triangle', 660, 660, 0.14, 0.16);
    this.tone('triangle', 520, 520, 0.2, 0.16, 0.16);
  }

  error(): void {
    this.tone('square', 220, 160, 0.18, 0.08);
  }

  success(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone('triangle', f, f, 0.28, 0.14, i * 0.09));
  }

  fail(): void {
    [392, 330, 262].forEach((f, i) => this.tone('sawtooth', f, f * 0.98, 0.35, 0.07, i * 0.22));
  }

  horn(pan: number, vol: number): void {
    if (!this.ctx || this.hornBudget < 1) return;
    this.hornBudget -= 1;
    const base = 380 + Math.random() * 140;
    const dur = 0.18 + Math.random() * 0.35;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = base * 2;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.09 * vol, t0 + 0.02);
    g.gain.setValueAtTime(0.09 * vol, t0 + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.06);
    let out: AudioNode = f.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      out = out.connect(p);
    }
    out.connect(this.sfx);
    for (const mul of [1, 1.26]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * mul;
      o.connect(f);
      o.start(t0);
      o.stop(t0 + dur + 0.1);
    }
    // double honk sometimes
    if (Math.random() < 0.3) setTimeout(() => this.horn(pan, vol * 0.9), dur * 1000 + 120);
  }

  private noiseBurst(dur: number, freq: number, vol: number, delay = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t0, 0.005, vol, dur);
    s.connect(f).connect(g).connect(this.sfx);
    s.start(t0, Math.random());
    s.stop(t0 + dur + 0.1);
  }

  crash(): void {
    this.noiseBurst(0.6, 900, 0.9);
    this.noiseBurst(0.25, 3000, 0.4, 0.02);
    // glass tinkles
    for (let i = 0; i < 6; i++) this.tone('sine', 2500 + Math.random() * 2500, 2000, 0.08, 0.04, 0.08 + Math.random() * 0.4);
  }

  // ------------------------------------------------------------------ music

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (on && this.ctx) this.startMusic();
    if (!on) this.stopMusic();
  }

  private startMusic(): void {
    if (!this.ctx || this.schedTimer !== null) return;
    this.nextNote = this.ctx.currentTime + 0.2;
    this.step = 0;
    this.schedTimer = window.setInterval(() => this.schedule(), 90);
  }

  private stopMusic(): void {
    if (this.schedTimer !== null) {
      clearInterval(this.schedTimer);
      this.schedTimer = null;
    }
  }

  private schedule(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const spb = 60 / 86 / 2; // eighth notes at 86 bpm
    // Am9 - Fmaj7 - Cmaj7 - G6 (relaxed lo-fi)
    const chords = [
      [57, 60, 64, 67, 71],
      [53, 57, 60, 64, 67],
      [48, 52, 55, 59, 64],
      [55, 59, 62, 64, 67],
    ];
    while (this.nextNote < ctx.currentTime + 0.25) {
      const t = this.nextNote;
      const bar = Math.floor(this.step / 8) % 4;
      const beat = this.step % 8;
      const ch = chords[bar];
      if (beat === 0) {
        for (const n of ch.slice(0, 4)) this.pad(n, t, spb * 8);
        this.bass(ch[0] - 12, t, spb * 3);
      }
      if (beat === 4) this.bass(ch[0] - 12 + (this.tension > 0.5 ? 1 : 0), t, spb * 2.5);
      // arpeggio
      if (beat % 2 === 1 || Math.random() < 0.25) {
        const n = ch[(this.step * 3 + bar) % ch.length] + 12;
        this.pluck(n, t, 0.045 + Math.random() * 0.02);
      }
      // soft drums
      if (beat === 0 || beat === 5) this.kick(t);
      if (beat % 2 === 0) this.hat(t, beat === 4 ? 0.05 : 0.025);
      if (beat === 4) this.snare(t);
      this.nextNote += spb * (beat % 2 === 0 ? 1.08 : 0.92); // swing
      this.step++;
    }
  }

  private mtof(m: number): number {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  private pad(n: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = this.mtof(n);
    o.detune.value = (Math.random() - 0.5) * 12;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.022, t + 0.6);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  private pluck(n: number, t: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = this.mtof(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.7);
  }

  private bass(n: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = this.mtof(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  private hat(t: number, vol: number): void {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    s.connect(f).connect(g).connect(this.musicBus);
    s.start(t, Math.random());
    s.stop(t + 0.06);
  }

  private snare(t: number): void {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    s.connect(f).connect(g).connect(this.musicBus);
    s.start(t, Math.random());
    s.stop(t + 0.16);
  }
}

export const Audio = new AudioEngine();
