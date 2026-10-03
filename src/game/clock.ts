// Day clock.  The simulation runs in real seconds (vehicles move at real
// speeds) while the day clock runs at a variable rate: rush hours last longer
// in real time than the quiet middle of the day.

// [sim seconds since start of day, hour]
export const DAY_KEYS: [number, number][] = [
  [0, 6.0],
  [40, 7.0],
  [165, 9.5],
  [250, 16.0],
  [400, 19.0],
  [460, 22.0],
];

export const DAY_LENGTH = DAY_KEYS[DAY_KEYS.length - 1][0];

export function hourAt(t: number): number {
  if (t <= 0) return DAY_KEYS[0][1];
  for (let i = 1; i < DAY_KEYS.length; i++) {
    const [t1, h1] = DAY_KEYS[i];
    if (t <= t1) {
      const [t0, h0] = DAY_KEYS[i - 1];
      return h0 + ((h1 - h0) * (t - t0)) / (t1 - t0);
    }
  }
  return DAY_KEYS[DAY_KEYS.length - 1][1];
}

export function timeAtHour(h: number): number {
  if (h <= DAY_KEYS[0][1]) return 0;
  for (let i = 1; i < DAY_KEYS.length; i++) {
    const [t1, h1] = DAY_KEYS[i];
    if (h <= h1) {
      const [t0, h0] = DAY_KEYS[i - 1];
      return t0 + ((t1 - t0) * (h - h0)) / (h1 - h0);
    }
  }
  return DAY_LENGTH;
}

export function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}

export function isRush(h: number): boolean {
  return (h >= 7 && h < 9.5) || (h >= 16.5 && h < 19);
}
