// Polygon helpers used by the city generator and the renderer.

import type { V2 } from './math.ts';
import { normAngle } from './math.ts';

/** Offset a closed polygon to the right of travel by d (mitre joins, limited). */
export function offsetClosed(pts: readonly V2[], d: number): V2[] {
  const n = pts.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    let d0x = p1.x - p0.x;
    let d0y = p1.y - p0.y;
    let l0 = Math.hypot(d0x, d0y) || 1;
    d0x /= l0;
    d0y /= l0;
    let d1x = p2.x - p1.x;
    let d1y = p2.y - p1.y;
    let l1 = Math.hypot(d1x, d1y) || 1;
    d1x /= l1;
    d1y /= l1;
    const r0x = -d0y;
    const r0y = d0x;
    const r1x = -d1y;
    const r1y = d1x;
    let mx = r0x + r1x;
    let my = r0y + r1y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = r1x;
      my = r1y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cosHalf = mx * r1x + my * r1y;
    const k = d / Math.max(0.3, cosHalf);
    out.push({ x: p1.x + mx * k, y: p1.y + my * k });
    l0 = l1;
  }
  return out;
}

/** Remove points closer than eps and nearly collinear points. */
export function simplifyClosed(pts: V2[], eps = 0.05, angEps = 0.002): V2[] {
  let out: V2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push(p);
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < eps) out.pop();
  // collinear removal
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const res: V2[] = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const a = out[(i - 1 + n) % n];
      const b = out[i];
      const c = out[(i + 1) % n];
      const a1 = Math.atan2(b.y - a.y, b.x - a.x);
      const a2 = Math.atan2(c.y - b.y, c.x - b.x);
      if (Math.abs(normAngle(a2 - a1)) < angEps) {
        changed = true;
        continue;
      }
      res.push(b);
    }
    out = res;
  }
  return out;
}

/** Sutherland-Hodgman clip against half plane n·p <= c */
export function clipHalfPlane(poly: readonly V2[], nx: number, ny: number, c: number): V2[] {
  const out: V2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = a.x * nx + a.y * ny - c;
    const db = b.x * nx + b.y * ny - c;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function signedArea(pts: readonly V2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Arc points from angle a0 sweeping the short way to a1 (exclusive of the start if skipFirst). */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, step = 1.2, skipFirst = false): V2[] {
  const sweep = normAngle(a1 - a0);
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / step));
  const pts: V2[] = [];
  for (let i = skipFirst ? 1 : 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/** Full circle polygon (open, no duplicated end point). */
export function circlePoints(cx: number, cy: number, r: number, step = 1.0): V2[] {
  const n = Math.max(12, Math.ceil((Math.PI * 2 * r) / step));
  const pts: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/** Arc with an explicit sweep direction */
export function arcPointsDir(cx: number, cy: number, r: number, a0: number, sweep: number, step = 1.2): V2[] {
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / step));
  const pts: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

export function polyBounds(pts: readonly V2[]): { minx: number; miny: number; maxx: number; maxy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of pts) {
    if (p.x < minx) minx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.x > maxx) maxx = p.x;
    if (p.y > maxy) maxy = p.y;
  }
  return { minx, miny, maxx, maxy };
}

/** distance from point to closed polygon boundary */
export function distToPolygon(x: number, y: number, pts: readonly V2[]): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}
