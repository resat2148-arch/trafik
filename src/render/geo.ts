// Geometry builder used to merge many simple shapes into a few draw calls.
// Simulation (x, y) maps to three.js (x, height, y).

import * as THREE from 'three';
import type { V2 } from '../core/math.ts';

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private vc = 0;
  r = 1;
  g = 1;
  b = 1;

  setColor(hex: number, mul = 1): this {
    const c = new THREE.Color(hex);
    this.r = c.r * mul;
    this.g = c.g * mul;
    this.b = c.b * mul;
    return this;
  }

  setRGB(r: number, g: number, b: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }

  get vertexCount(): number {
    return this.vc;
  }

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col.push(this.r, this.g, this.b);
    return this.vc++;
  }

  /** triangle with given desired normal; flips winding if needed */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos;
    const ax = p[a * 3];
    const ay = p[a * 3 + 1];
    const az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax;
    const e1y = p[b * 3 + 1] - ay;
    const e1z = p[b * 3 + 2] - az;
    const e2x = p[c * 3] - ax;
    const e2y = p[c * 3 + 1] - ay;
    const e2z = p[c * 3 + 2] - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** quad a-b-c-d (any winding), normal given */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    u0 = 0, v0 = 0, u1 = 1, v1 = 1,
  ): void {
    const a = this.v(ax, ay, az, nx, ny, nz, u0, v0);
    const b = this.v(bx, by, bz, nx, ny, nz, u1, v0);
    const c = this.v(cx, cy, cz, nx, ny, nz, u1, v1);
    const d = this.v(dx, dy, dz, nx, ny, nz, u0, v1);
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** horizontal polygon (sim coords) at height y, facing up; uv = world xz * uvScale */
  polygon(pts: readonly V2[], y: number, uvScale = 0.1, holes: V2[][] = []): void {
    if (pts.length < 3) return;
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.y));
    const hs = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, hs);
    } catch {
      return;
    }
    const all = [...pts, ...holes.flat()];
    const base = this.vc;
    for (const p of all) this.v(p.x, y, p.y, 0, 1, 0, p.x * uvScale, p.y * uvScale);
    for (const t of tris) this.tri(base + t[0], base + t[1], base + t[2], 0, 1, 0);
  }

  /** vertical walls along a closed polygon from y0 to y1. outward: +1 if polygon is CW (positive area in sim coords) */
  walls(pts: readonly V2[], y0: number, y1: number, closed = true, uScale = 0.1, vScale = 0.1, outwardSign = 1): void {
    const n = pts.length;
    const m = closed ? n : n - 1;
    let u = 0;
    for (let i = 0; i < m; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const L = Math.hypot(dx, dy);
      if (L < 1e-4) continue;
      // left normal in sim coords (y-down): (dy, -dx); for positively oriented (CW on screen)
      // polygons the outside is on the left of travel
      const nx = (dy / L) * outwardSign;
      const nz = (-dx / L) * outwardSign;
      this.quad(p.x, y0, p.y, q.x, y0, q.y, q.x, y1, q.y, p.x, y1, p.y, nx, 0, nz, u * uScale, y0 * vScale, (u + L) * uScale, y1 * vScale);
      u += L;
    }
  }

  /** oriented box: centre (x, y=height base, z), size (length along heading, height, width), heading (hx,hz) */
  box(x: number, y: number, z: number, len: number, h: number, w: number, hx: number, hz: number, uvScale = 0): void {
    const lx = hx * len * 0.5;
    const lz = hz * len * 0.5;
    const wx = -hz * w * 0.5;
    const wz = hx * w * 0.5;
    const c = [
      [x - lx - wx, z - lz - wz],
      [x + lx - wx, z + lz - wz],
      [x + lx + wx, z + lz + wz],
      [x - lx + wx, z - lz + wz],
    ];
    const y1 = y + h;
    // top
    this.quad(c[0][0], y1, c[0][1], c[1][0], y1, c[1][1], c[2][0], y1, c[2][1], c[3][0], y1, c[3][1], 0, 1, 0);
    // sides
    const sides: [number, number, number, number][] = [
      [0, 1, -hz, hx], // left (−w side)... normals computed below
      [1, 2, hx, hz],
      [2, 3, hz, -hx],
      [3, 0, -hx, -hz],
    ];
    for (const [i, j] of sides) {
      const ax = c[i][0];
      const az = c[i][1];
      const bx = c[j][0];
      const bz = c[j][1];
      const ex = bx - ax;
      const ez = bz - az;
      const L = Math.hypot(ex, ez) || 1;
      // outward normal: points away from box centre
      let nx = ez / L;
      let nz = -ex / L;
      const mx = (ax + bx) / 2 - x;
      const mz = (az + bz) / 2 - z;
      if (nx * mx + nz * mz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const us = uvScale || 1;
      this.quad(ax, y, az, bx, y, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, 0, uvScale ? y * us : 0, uvScale ? L * us : 1, uvScale ? y1 * us : 1);
    }
  }

  /** gable roof prism on top of a box footprint; ridge along heading */
  gable(x: number, y: number, z: number, len: number, w: number, rise: number, hx: number, hz: number, overhang = 0.4): void {
    const L = len * 0.5 + overhang;
    const W = w * 0.5 + overhang;
    const lx = hx * L;
    const lz = hz * L;
    const wx = -hz * W;
    const wz = hx * W;
    const ry = y + rise;
    // ridge endpoints
    const r0 = [x - lx, z - lz];
    const r1 = [x + lx, z + lz];
    const e = [
      [x - lx - wx, z - lz - wz],
      [x + lx - wx, z + lz - wz],
      [x + lx + wx, z + lz + wz],
      [x - lx + wx, z - lz + wz],
    ];
    const slope = Math.hypot(W, rise);
    // side A (−w)
    let nx = (-wx / W) * (rise / slope);
    let ny = W / slope;
    let nz = (-wz / W) * (rise / slope);
    this.quad(e[0][0], y, e[0][1], e[1][0], y, e[1][1], r1[0], ry, r1[1], r0[0], ry, r0[1], nx, ny, nz, 0, 0, L * 0.25, slope * 0.25);
    nx = (wx / W) * (rise / slope);
    nz = (wz / W) * (rise / slope);
    this.quad(e[3][0], y, e[3][1], e[2][0], y, e[2][1], r1[0], ry, r1[1], r0[0], ry, r0[1], nx, ny, nz, 0, 0, L * 0.25, slope * 0.25);
    // gable ends (triangles)
    for (const [a, b, r, s] of [
      [e[0], e[3], r0, -1],
      [e[1], e[2], r1, 1],
    ] as [number[], number[], number[], number][]) {
      const i0 = this.v(a[0], y, a[1], hx * s, 0, hz * s, 0, 0);
      const i1 = this.v(b[0], y, b[1], hx * s, 0, hz * s, 1, 0);
      const i2 = this.v(r[0], ry, r[1], hx * s, 0, hz * s, 0.5, 0.5);
      this.tri(i0, i1, i2, hx * s, 0, hz * s);
    }
  }

  /** flat ribbon along a polyline at height y (for markings, overlays) */
  ribbon(pts: readonly V2[], width: number, y: number, offset = 0, uvScale = 0.25): void {
    const n = pts.length;
    if (n < 2) return;
    let acc = 0;
    let prevL = -1;
    let prevR = -1;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      let dx: number;
      let dy: number;
      if (i === 0) {
        dx = pts[1].x - p.x;
        dy = pts[1].y - p.y;
      } else if (i === n - 1) {
        dx = p.x - pts[i - 1].x;
        dy = p.y - pts[i - 1].y;
      } else {
        dx = pts[i + 1].x - pts[i - 1].x;
        dy = pts[i + 1].y - pts[i - 1].y;
      }
      const L = Math.hypot(dx, dy) || 1;
      const rx = -dy / L;
      const ry = dx / L;
      if (i > 0) acc += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      const cx = p.x + rx * offset;
      const cy = p.y + ry * offset;
      const l = this.v(cx - rx * width * 0.5, y, cy - ry * width * 0.5, 0, 1, 0, 0, acc * uvScale);
      const r = this.v(cx + rx * width * 0.5, y, cy + ry * width * 0.5, 0, 1, 0, 1, acc * uvScale);
      if (prevL >= 0) {
        this.tri(prevL, prevR, r, 0, 1, 0);
        this.tri(prevL, r, l, 0, 1, 0);
      }
      prevL = l;
      prevR = r;
    }
  }

  /** flat rectangle centred at (cx, cy) with length along (dx, dy) */
  quadFlat(cx: number, cy: number, dx: number, dy: number, len: number, wid: number, y: number): void {
    const lx = dx * len * 0.5;
    const ly = dy * len * 0.5;
    const wx = -dy * wid * 0.5;
    const wy = dx * wid * 0.5;
    this.quad(cx - lx - wx, y, cy - ly - wy, cx + lx - wx, y, cy + ly - wy, cx + lx + wx, y, cy + ly + wy, cx - lx + wx, y, cy - ly + wy, 0, 1, 0);
  }

  /** flat triangle ("shark tooth") with its tip pointing along -(dx, dy) */
  triFlat(cx: number, cy: number, dx: number, dy: number, len: number, wid: number, y: number): void {
    const a = this.v(cx - dy * wid * 0.5, y, cy + dx * wid * 0.5, 0, 1, 0, 0, 0);
    const b = this.v(cx + dy * wid * 0.5, y, cy - dx * wid * 0.5, 0, 1, 0, 1, 0);
    const c = this.v(cx - dx * len, y, cy - dy * len, 0, 1, 0, 0.5, 1);
    this.tri(a, b, c, 0, 1, 0);
  }

  /** ribbon whose UVs are world coordinates * scale (for tiling ground textures) */
  ribbonWorldUV(pts: readonly V2[], width: number, y: number, scale = 0.1): void {
    const n = pts.length;
    if (n < 2) return;
    let prevL = -1;
    let prevR = -1;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const rx = (-dy / L) * width * 0.5;
      const ry = (dx / L) * width * 0.5;
      const l = this.v(p.x - rx, y, p.y - ry, 0, 1, 0, (p.x - rx) * scale, (p.y - ry) * scale);
      const r = this.v(p.x + rx, y, p.y + ry, 0, 1, 0, (p.x + rx) * scale, (p.y + ry) * scale);
      if (prevL >= 0) {
        this.tri(prevL, prevR, r, 0, 1, 0);
        this.tri(prevL, r, l, 0, 1, 0);
      }
      prevL = l;
      prevR = r;
    }
  }

  merge(o: GeoBuilder): void {
    const base = this.vc;
    this.pos.push(...o.pos);
    this.nor.push(...o.nor);
    this.uv.push(...o.uv);
    this.col.push(...o.col);
    for (const i of o.idx) this.idx.push(i + base);
    this.vc += o.vc;
  }

  build(withColor = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }
}
