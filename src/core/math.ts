// Small math helpers shared by the simulation and the renderer.
// The simulation works on the ground plane (x, y) where +y points "down" on the
// default screen orientation (it maps to three.js +z).  With this convention the
// right-hand side of a heading (dx, dy) is (-dy, dx).

export interface V2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function normAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Angle in [0, TAU) */
export function posAngle(a: number): number {
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}

export const v2 = (x: number, y: number): V2 => ({ x, y });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const cross = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.y);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};
export function norm(a: V2): V2 {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}
/** Right-hand normal of a direction (screen convention, +y down). */
export const right = (d: V2): V2 => ({ x: -d.y, y: d.x });
export const fromAngle = (a: number): V2 => ({ x: Math.cos(a), y: Math.sin(a) });
export const angleOf = (d: V2): number => Math.atan2(d.y, d.x);
export const madd = (a: V2, d: V2, s: number): V2 => ({ x: a.x + d.x * s, y: a.y + d.y * s });

/** Intersection of two infinite lines p + t*r and q + u*s.  Returns t,u or null when parallel. */
export function lineIntersect(p: V2, r: V2, q: V2, s: V2): { t: number; u: number } | null {
  const rxs = cross(r, s);
  if (Math.abs(rxs) < 1e-9) return null;
  const qp = sub(q, p);
  return { t: cross(qp, s) / rxs, u: cross(qp, r) / rxs };
}

/** Segment-segment intersection test. */
export function segIntersect(a: V2, b: V2, c: V2, d: V2): { t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const res = lineIntersect(a, r, c, s);
  if (!res) return null;
  if (res.t < 0 || res.t > 1 || res.u < 0 || res.u > 1) return null;
  return res;
}

export function polygonArea(pts: V2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a * 0.5;
}

export function polygonCentroid(pts: V2[]): V2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    cx += (pts[j].x + pts[i].x) * f;
    cy += (pts[j].y + pts[i].y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / pts.length, y: sy / pts.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(x: number, y: number, pts: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point p to segment ab, plus the parameter t of the closest point. */
export function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { d: Math.hypot(px - cx, py - cy), t };
}

/** Oriented rectangle overlap test (separating axis theorem). */
export interface OBB {
  cx: number;
  cy: number;
  hw: number; // half extent along axis u
  hh: number; // half extent along axis v
  ux: number;
  uy: number;
}

export function obbCorners(b: OBB): V2[] {
  const vx = -b.uy;
  const vy = b.ux;
  return [
    { x: b.cx + b.ux * b.hw + vx * b.hh, y: b.cy + b.uy * b.hw + vy * b.hh },
    { x: b.cx - b.ux * b.hw + vx * b.hh, y: b.cy - b.uy * b.hw + vy * b.hh },
    { x: b.cx - b.ux * b.hw - vx * b.hh, y: b.cy - b.uy * b.hw - vy * b.hh },
    { x: b.cx + b.ux * b.hw - vx * b.hh, y: b.cy + b.uy * b.hw - vy * b.hh },
  ];
}

export function obbOverlap(a: OBB, b: OBB, margin = 0): boolean {
  const axes = [
    { x: a.ux, y: a.uy },
    { x: -a.uy, y: a.ux },
    { x: b.ux, y: b.uy },
    { x: -b.uy, y: b.ux },
  ];
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const ax of axes) {
    const ra = a.hw * Math.abs(ax.x * a.ux + ax.y * a.uy) + a.hh * Math.abs(-ax.x * a.uy + ax.y * a.ux);
    const rb = b.hw * Math.abs(ax.x * b.ux + ax.y * b.uy) + b.hh * Math.abs(-ax.x * b.uy + ax.y * b.ux);
    if (Math.abs(dx * ax.x + dy * ax.y) > ra + rb + margin) return false;
  }
  return true;
}

export function fmtTime(minutes: number): string {
  const m = Math.floor(minutes) % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}
