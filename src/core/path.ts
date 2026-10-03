// Polyline path with arc-length parameterisation.  Every lane, connector and
// roundabout ring segment in the network is a Path, and vehicles store their
// longitudinal position as an arc length `s` along it.

import type { V2 } from './math.ts';

export interface Pose {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export function makePose(): Pose {
  return { x: 0, y: 0, dx: 1, dy: 0 };
}

export class Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  readonly n: number;
  private _minRadius = -1;

  constructor(pts: readonly V2[]) {
    // remove duplicate consecutive points
    const clean: V2[] = [];
    for (const p of pts) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-4) clean.push(p);
    }
    if (clean.length === 1) clean.push({ x: clean[0].x + 1e-3, y: clean[0].y });
    this.n = clean.length;
    this.xs = new Float64Array(this.n);
    this.ys = new Float64Array(this.n);
    this.cum = new Float64Array(this.n);
    let acc = 0;
    for (let i = 0; i < this.n; i++) {
      this.xs[i] = clean[i].x;
      this.ys[i] = clean[i].y;
      if (i > 0) acc += Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  /** Index i of the segment [i, i+1] containing arc length s. */
  locate(s: number): number {
    const cum = this.cum;
    if (s <= 0) return 0;
    if (s >= this.length) return this.n - 2;
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Position and unit direction at arc length s (linear extrapolation beyond the ends). */
  sample(s: number, out: Pose): Pose {
    const i = this.locate(s);
    const x0 = this.xs[i];
    const y0 = this.ys[i];
    const x1 = this.xs[i + 1];
    const y1 = this.ys[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i];
    const dx = segLen > 1e-9 ? (x1 - x0) / segLen : 1;
    const dy = segLen > 1e-9 ? (y1 - y0) / segLen : 0;
    const t = s - this.cum[i];
    out.x = x0 + dx * t;
    out.y = y0 + dy * t;
    out.dx = dx;
    out.dy = dy;
    return out;
  }

  /** Direction smoothed across vertices (used for rendering lane-change normals). */
  point(s: number): V2 {
    const p = this.sample(s, makePose());
    return { x: p.x, y: p.y };
  }

  start(): V2 {
    return { x: this.xs[0], y: this.ys[0] };
  }

  end(): V2 {
    return { x: this.xs[this.n - 1], y: this.ys[this.n - 1] };
  }

  startDir(): V2 {
    const p = this.sample(0, makePose());
    return { x: p.dx, y: p.dy };
  }

  endDir(): V2 {
    const p = this.sample(this.length, makePose());
    return { x: p.dx, y: p.dy };
  }

  points(): V2[] {
    const out: V2[] = [];
    for (let i = 0; i < this.n; i++) out.push({ x: this.xs[i], y: this.ys[i] });
    return out;
  }

  /** Smallest radius of curvature along the path (Infinity for straight paths). */
  minRadius(): number {
    if (this._minRadius >= 0) return this._minRadius;
    let best = Infinity;
    // evaluate on points spaced ~2 m apart to avoid sampling noise
    const step = 2;
    if (this.length > step * 2) {
      const a = makePose();
      const b = makePose();
      const c = makePose();
      for (let s = step; s < this.length - step; s += step * 0.5) {
        this.sample(s - step, a);
        this.sample(s, b);
        this.sample(s + step, c);
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const bcx = c.x - b.x;
        const bcy = c.y - b.y;
        const acx = c.x - a.x;
        const acy = c.y - a.y;
        const cr = Math.abs(abx * bcy - aby * bcx);
        if (cr < 1e-6) continue;
        const r = (Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(acx, acy)) / (2 * cr);
        if (r < best) best = r;
      }
    }
    this._minRadius = best;
    return best;
  }

  /** Closest point on the path to (x, y). */
  project(x: number, y: number): { s: number; d: number } {
    let bestD = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.n - 1; i++) {
      const ax = this.xs[i];
      const ay = this.ys[i];
      const bx = this.xs[i + 1];
      const by = this.ys[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + dx * t;
      const cy = ay + dy * t;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) {
        bestD = d;
        bestS = this.cum[i] + Math.sqrt(l2) * t;
      }
    }
    return { s: bestS, d: bestD };
  }

  /** Signed lateral offset of (x,y) from the path (positive = right side). */
  lateral(x: number, y: number): number {
    const pr = this.project(x, y);
    const p = this.sample(pr.s, makePose());
    return (x - p.x) * -p.dy + (y - p.y) * p.dx;
  }

  /** Sub-path between arc lengths s0 and s1. */
  sub(s0: number, s1: number): Path {
    s0 = Math.max(0, Math.min(this.length, s0));
    s1 = Math.max(0, Math.min(this.length, s1));
    const pts: V2[] = [this.point(s0)];
    for (let i = 0; i < this.n; i++) {
      if (this.cum[i] > s0 && this.cum[i] < s1) pts.push({ x: this.xs[i], y: this.ys[i] });
    }
    pts.push(this.point(s1));
    return new Path(pts);
  }

  reversed(): Path {
    return new Path(this.points().reverse());
  }

  /**
   * Offset polyline by d to the right (+) or left (-) using mitred joins.
   */
  offset(d: number): Path {
    return new Path(offsetPolyline(this.points(), d));
  }

  static line(a: V2, b: V2): Path {
    return new Path([a, b]);
  }

  static bezier(p0: V2, p1: V2, p2: V2, p3: V2, maxStep = 0.8): Path {
    const approx =
      Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const n = Math.max(4, Math.ceil(approx / maxStep));
    return new Path(bezierPoints(p0, p1, p2, p3, n));
  }

  /** Circular arc around (cx,cy) from angle a0 to a1 (radians, direction given by sign of a1-a0). */
  static arc(cx: number, cy: number, r: number, a0: number, a1: number, maxStep = 0.8): Path {
    const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / maxStep));
    const pts: V2[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return new Path(pts);
  }

  static concat(paths: Path[]): Path {
    const pts: V2[] = [];
    for (const p of paths) for (const q of p.points()) pts.push(q);
    return new Path(pts);
  }
}

export function bezierPoints(p0: V2, p1: V2, p2: V2, p3: V2, n: number): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return pts;
}

export function offsetPolyline(pts: readonly V2[], d: number): V2[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const out: V2[] = [];
  const dirs: V2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const l = Math.hypot(dx, dy) || 1;
    dirs.push({ x: dx / l, y: dy / l });
  }
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const r = { x: -dirs[0].y, y: dirs[0].x };
      out.push({ x: pts[0].x + r.x * d, y: pts[0].y + r.y * d });
    } else if (i === n - 1) {
      const r = { x: -dirs[n - 2].y, y: dirs[n - 2].x };
      out.push({ x: pts[i].x + r.x * d, y: pts[i].y + r.y * d });
    } else {
      const r0 = { x: -dirs[i - 1].y, y: dirs[i - 1].x };
      const r1 = { x: -dirs[i].y, y: dirs[i].x };
      let mx = r0.x + r1.x;
      let my = r0.y + r1.y;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) {
        mx = r1.x;
        my = r1.y;
      } else {
        mx /= ml;
        my /= ml;
      }
      const cosHalf = mx * r1.x + my * r1.y;
      const k = d / Math.max(0.35, cosHalf);
      out.push({ x: pts[i].x + mx * k, y: pts[i].y + my * k });
    }
  }
  return out;
}
