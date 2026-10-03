// Instanced vehicle rendering: procedural low-poly models, brake / tail /
// head / indicator / emergency lights, headlight beams and contact shadows.

import * as THREE from 'three';
import { GeoBuilder } from './geo.ts';
import { MODEL, MODEL_COUNT, MODEL_SPECS } from '../sim/vehicle.ts';
import type { Vehicle } from '../sim/vehicle.ts';
import type { Sim } from '../sim/sim.ts';
import type { TextureSet } from './textures.ts';

const GLASS = 0x1e2a33;
const TIRE = 0x161616;
const TRIM = 0x2c2f33;
const CHROME = 0x9ea4aa;

function wheel(g: GeoBuilder, x: number, z: number, r: number, w: number): void {
  // octagonal prism wheel lying along z
  g.setColor(TIRE);
  const n = 8;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([x + Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  for (const side of [-1, 1]) {
    const zz = z + (side * w) / 2;
    const c = g.v(x, r, zz, 0, 0, side, 0, 0);
    const idx = pts.map(([px, py]) => g.v(px, py, zz, 0, 0, side, 0, 0));
    for (let i = 0; i < n; i++) g.tri(c, idx[i], idx[(i + 1) % n], 0, 0, side);
  }
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    const nx = (ax + bx) / 2 - x;
    const ny = (ay + by) / 2 - r;
    const l = Math.hypot(nx, ny) || 1;
    g.quad(ax, ay, z - w / 2, bx, by, z - w / 2, bx, by, z + w / 2, ax, ay, z + w / 2, nx / l, ny / l, 0);
  }
  g.setColor(CHROME);
  for (const side of [-1, 1]) {
    const zz = z + side * (w / 2 + 0.005);
    const c = g.v(x, r, zz, 0, 0, side, 0, 0);
    const idx: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      idx.push(g.v(x + Math.cos(a) * r * 0.55, r + Math.sin(a) * r * 0.55, zz, 0, 0, side, 0, 0));
    }
    for (let i = 0; i < 6; i++) g.tri(c, idx[i], idx[(i + 1) % 6], 0, 0, side);
  }
}

/** sloped cabin: bottom from x0..x1 at y0, top from tx0..tx1 at y1; glass sides, painted roof */
function cabin(g: GeoBuilder, x0: number, x1: number, tx0: number, tx1: number, y0: number, y1: number, w: number, wt: number, roofColor = 0xffffff, glass = GLASS): void {
  const hw = w / 2;
  const ht = wt / 2;
  g.setColor(glass);
  // windshield (front) and rear window
  const nfx = y1 - y0;
  const nfy = x1 - tx1;
  const lf = Math.hypot(nfx, nfy) || 1;
  g.quad(x1, y0, -hw, x1, y0, hw, tx1, y1, ht, tx1, y1, -ht, nfx / lf, nfy / lf, 0);
  const nbx = -(y1 - y0);
  const nby = tx0 - x0;
  const lb = Math.hypot(nbx, nby) || 1;
  g.quad(x0, y0, -hw, x0, y0, hw, tx0, y1, ht, tx0, y1, -ht, nbx / lb, nby / lb, 0);
  // side windows
  for (const s of [-1, 1]) {
    g.quad(x0, y0, s * hw, x1, y0, s * hw, tx1, y1, s * ht, tx0, y1, s * ht, 0, (hw - ht) * 0.5, s);
  }
  // roof
  g.setColor(roofColor);
  g.quad(tx0, y1, -ht, tx1, y1, -ht, tx1, y1, ht, tx0, y1, ht, 0, 1, 0);
  // pillars (paint) as thin boxes at corners for definition
  g.setColor(roofColor);
  for (const s of [-1, 1]) {
    g.box((x1 + tx1) / 2, y0, s * ((hw + ht) / 2), 0.08, y1 - y0, 0.06, 1, 0);
  }
}

function carModel(kind: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const spec = MODEL_SPECS[kind];
  const L = spec.len;
  const W = spec.width;
  const hl = L / 2;
  const PAINT = 0xffffff;
  switch (kind) {
    case MODEL.sedan:
    case MODEL.taxi:
    case MODEL.police: {
      g.setColor(PAINT);
      g.box(0, 0.3, 0, L - 0.1, 0.5, W, 1, 0);
      // hood & trunk slight rise
      g.box(hl - 0.75, 0.8, 0, 1.3, 0.08, W - 0.1, 1, 0);
      g.box(-hl + 0.55, 0.8, 0, 0.9, 0.08, W - 0.1, 1, 0);
      cabin(g, -1.05, 0.95, -0.75, 0.35, 0.8, 1.38, W - 0.12, W - 0.42, kind === MODEL.police ? 0xf4f4f4 : PAINT);
      g.setColor(TRIM);
      g.box(hl - 0.05, 0.25, 0, 0.14, 0.3, W + 0.02, 1, 0);
      g.box(-hl + 0.05, 0.25, 0, 0.14, 0.3, W + 0.02, 1, 0);
      if (kind === MODEL.taxi) {
        g.setColor(0xf5f0e0);
        g.box(-0.2, 1.38, 0, 0.35, 0.22, 0.8, 1, 0);
      }
      if (kind === MODEL.police) {
        g.setColor(0x1b2a5a);
        g.box(0.2, 0.42, 0, L * 0.55, 0.32, W + 0.01, 1, 0);
        g.setColor(TRIM);
        g.box(-0.2, 1.38, 0, 0.35, 0.14, 1.25, 1, 0);
      }
      break;
    }
    case MODEL.hatch: {
      g.setColor(PAINT);
      g.box(0, 0.3, 0, L - 0.1, 0.52, W, 1, 0);
      g.box(hl - 0.6, 0.82, 0, 1.0, 0.07, W - 0.1, 1, 0);
      cabin(g, -hl + 0.15, 0.85, -hl + 0.3, 0.2, 0.82, 1.42, W - 0.12, W - 0.4);
      g.setColor(TRIM);
      g.box(hl - 0.05, 0.25, 0, 0.14, 0.3, W + 0.02, 1, 0);
      g.box(-hl + 0.05, 0.25, 0, 0.14, 0.3, W + 0.02, 1, 0);
      break;
    }
    case MODEL.suv:
    case MODEL.pickup: {
      g.setColor(PAINT);
      g.box(0, 0.38, 0, L - 0.1, 0.62, W, 1, 0);
      if (kind === MODEL.suv) {
        cabin(g, -hl + 0.2, 0.9, -hl + 0.3, 0.35, 1.0, 1.72, W - 0.1, W - 0.3);
        g.setColor(TRIM);
        g.box(-0.3, 1.72, 0, 1.6, 0.06, W - 0.5, 1, 0);
      } else {
        cabin(g, -0.6, 0.95, -0.5, 0.45, 1.0, 1.7, W - 0.1, W - 0.3);
        // bed walls
        g.setColor(PAINT);
        g.box(-hl + 1.05, 1.0, W / 2 - 0.06, 1.9, 0.38, 0.1, 1, 0);
        g.box(-hl + 1.05, 1.0, -W / 2 + 0.06, 1.9, 0.38, 0.1, 1, 0);
        g.box(-hl + 0.1, 1.0, 0, 0.12, 0.38, W, 1, 0);
      }
      g.setColor(TRIM);
      g.box(hl - 0.05, 0.3, 0, 0.16, 0.36, W + 0.04, 1, 0);
      g.box(-hl + 0.05, 0.3, 0, 0.16, 0.36, W + 0.04, 1, 0);
      break;
    }
    case MODEL.van: {
      g.setColor(PAINT);
      g.box(-0.3, 0.32, 0, L - 0.7, 1.75, W, 1, 0);
      g.box(hl - 0.45, 0.32, 0, 0.8, 0.75, W, 1, 0);
      cabin(g, hl - 1.4, hl - 0.4, hl - 1.4, hl - 1.0, 1.07, 2.0, W - 0.04, W - 0.08);
      g.setColor(GLASS);
      g.box(-0.4, 1.35, 0, 2.2, 0.45, W + 0.01, 1, 0);
      g.setColor(TRIM);
      g.box(hl - 0.05, 0.25, 0, 0.14, 0.32, W + 0.02, 1, 0);
      break;
    }
    case MODEL.truck: {
      // cab
      g.setColor(PAINT);
      g.box(hl - 1.1, 0.5, 0, 2.0, 1.25, W, 1, 0);
      cabin(g, hl - 2.0, hl - 0.15, hl - 2.0, hl - 0.45, 1.75, 2.75, W - 0.05, W - 0.15);
      // cargo box
      g.setColor(0xeeeeee);
      g.box(-1.05, 0.75, 0, L - 2.5, 2.85, W + 0.05, 1, 0);
      g.setColor(TRIM);
      g.box(-0.5, 0.35, 0, L - 1.2, 0.4, W - 0.3, 1, 0);
      g.box(hl - 0.05, 0.35, 0, 0.14, 0.4, W + 0.02, 1, 0);
      break;
    }
    case MODEL.bus: {
      g.setColor(PAINT);
      g.box(0, 0.32, 0, L, 1.05, W, 1, 0);
      g.setColor(GLASS);
      g.box(0.15, 1.37, 0, L - 0.5, 1.1, W + 0.01, 1, 0);
      g.box(hl - 0.08, 1.0, 0, 0.18, 1.5, W - 0.2, 1, 0);
      g.setColor(PAINT);
      g.box(0, 2.47, 0, L, 0.55, W, 1, 0);
      g.setColor(0xdedede);
      g.box(-1.5, 3.02, 0, 3.0, 0.3, W - 0.6, 1, 0);
      g.setColor(TRIM);
      g.box(hl - 0.04, 0.3, 0, 0.1, 0.36, W + 0.02, 1, 0);
      break;
    }
    case MODEL.ambulance: {
      g.setColor(0xf6f6f6);
      g.box(-0.5, 0.35, 0, L - 1.1, 2.25, W, 1, 0);
      g.box(hl - 0.55, 0.35, 0, 1.1, 0.85, W - 0.1, 1, 0);
      cabin(g, hl - 1.6, hl - 0.5, hl - 1.6, hl - 1.05, 1.2, 2.2, W - 0.12, W - 0.2, 0xf6f6f6);
      g.setColor(0xc8281e);
      g.box(-0.5, 1.15, 0, L - 1.0, 0.28, W + 0.02, 1, 0);
      g.box(-0.6, 2.61, 0, 0.6, 0.02, 1.6, 1, 0);
      g.box(-0.6, 2.61, 0, 1.6, 0.02, 0.6, 1, 0);
      break;
    }
    case MODEL.fire: {
      g.setColor(0xc0201a);
      g.box(hl - 1.2, 0.5, 0, 2.3, 1.6, W, 1, 0);
      cabin(g, hl - 2.3, hl - 0.15, hl - 2.3, hl - 0.4, 2.1, 2.9, W - 0.05, W - 0.15, 0xc0201a);
      g.box(-1.2, 0.5, 0, L - 2.6, 2.0, W, 1, 0);
      g.setColor(0xb8b8b8);
      g.box(-1.0, 2.5, 0, L - 2.2, 0.25, 0.9, 1, 0);
      g.setColor(0xe9e9e9);
      g.box(-1.2, 1.2, 0, L - 2.6, 0.18, W + 0.02, 1, 0);
      break;
    }
    case MODEL.tow: {
      g.setColor(0xf2f2f2);
      g.box(hl - 1.0, 0.45, 0, 1.9, 1.15, W, 1, 0);
      cabin(g, hl - 1.9, hl - 0.15, hl - 1.9, hl - 0.4, 1.6, 2.5, W - 0.05, W - 0.15, 0xf2f2f2);
      g.setColor(0x353a40);
      g.box(-1.2, 0.45, 0, L - 2.4, 0.55, W, 1, 0);
      g.setColor(0xe0a526);
      g.box(-1.6, 1.0, 0, 2.6, 0.25, 0.4, 1, 0);
      g.box(-2.8, 1.0, 0, 0.3, 1.4, 0.3, 1, 0);
      break;
    }
  }
  // wheels
  const r = kind === MODEL.bus || kind === MODEL.truck || kind === MODEL.fire ? 0.48 : kind === MODEL.suv || kind === MODEL.pickup || kind === MODEL.van || kind === MODEL.tow || kind === MODEL.ambulance ? 0.38 : 0.32;
  const wx = hl - (kind === MODEL.bus ? 2.4 : kind === MODEL.truck || kind === MODEL.fire ? 1.4 : 0.85);
  const rx = -hl + (kind === MODEL.bus ? 2.6 : kind === MODEL.truck || kind === MODEL.fire ? 1.8 : 0.85);
  for (const x of [wx, rx]) for (const s of [-1, 1]) wheel(g, x, s * (W / 2 - 0.12), r, 0.26);
  if (kind === MODEL.truck || kind === MODEL.fire) for (const s of [-1, 1]) wheel(g, rx + 1.05, s * (W / 2 - 0.12), r, 0.26);
  return g.build();
}

interface LightSpec {
  head: [number, number, number][]; // along, lateral, height
  tail: [number, number, number][];
  bar: number; // light bar height (0 = none)
}

function lightSpec(kind: number): LightSpec {
  const s = MODEL_SPECS[kind];
  const hl = s.len / 2;
  const hw = s.width / 2;
  const tall = kind === MODEL.bus || kind === MODEL.truck || kind === MODEL.fire;
  const h = tall ? 0.85 : kind === MODEL.van || kind === MODEL.suv || kind === MODEL.ambulance || kind === MODEL.tow ? 0.8 : 0.66;
  const spec: LightSpec = {
    head: [
      [hl + 0.02, hw - 0.3, h],
      [hl + 0.02, -hw + 0.3, h],
    ],
    tail: [
      [-hl - 0.02, hw - 0.22, h + 0.08],
      [-hl - 0.02, -hw + 0.22, h + 0.08],
    ],
    bar: 0,
  };
  if (kind === MODEL.police) spec.bar = 1.5;
  if (kind === MODEL.ambulance) spec.bar = 2.66;
  if (kind === MODEL.fire) spec.bar = 2.95;
  if (kind === MODEL.tow) spec.bar = 2.55;
  return spec;
}

export class VehicleView {
  group = new THREE.Group();
  meshes: THREE.InstancedMesh[] = [];
  private lights: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private blobs: THREE.InstancedMesh;
  private specs: LightSpec[] = [];
  private cap: number[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YZX');
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private col = new THREE.Color();
  private time = 0;
  shadows: boolean;

  constructor(tex: TextureSet, shadows: boolean) {
    this.shadows = shadows;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 });
    for (let k = 0; k < MODEL_COUNT; k++) {
      const cap = k === MODEL.sedan ? 700 : k === MODEL.hatch || k === MODEL.suv ? 450 : k === MODEL.bus ? 60 : 200;
      const mesh = new THREE.InstancedMesh(carModel(k), mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = shadows;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.cap.push(cap);
      this.specs.push(lightSpec(k));
      this.group.add(mesh);
    }
    const lg = new THREE.BoxGeometry(0.08, 0.16, 0.32);
    this.lights = new THREE.InstancedMesh(lg, new THREE.MeshBasicMaterial({ toneMapped: false }), 9000);
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    this.group.add(this.lights);
    const bg = new THREE.PlaneGeometry(1, 1);
    bg.rotateX(-Math.PI / 2);
    bg.translate(0.5, 0, 0);
    this.beams = new THREE.InstancedMesh(
      bg,
      new THREE.MeshBasicMaterial({
        map: rotateBeam(tex.beam),
        color: 0xfff1d0,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      2400,
    );
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 3;
    this.group.add(this.beams);
    const sg = new THREE.PlaneGeometry(1, 1);
    sg.rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(
      sg,
      new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, opacity: 0.55, depthWrite: false, color: 0x000000 }),
      2400,
    );
    this.blobs.count = 0;
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    this.group.add(this.blobs);
  }

  update(sim: Sim, dt: number, night: number): void {
    this.time += dt;
    const counts = new Array(MODEL_COUNT).fill(0);
    let li = 0;
    let bi = 0;
    let si = 0;
    const blink = Math.floor(this.time * 2.6) % 2 === 0;
    const strobe = Math.floor(this.time * 6) % 2 === 0;
    const lights = this.lights;
    const beamsOn = night > 0.25;
    for (const v of sim.vehicles) {
      if (v.state === 'gone') continue;
      const k = v.model;
      const idx = counts[k];
      if (idx >= this.cap[k]) continue;
      counts[k]++;
      const mesh = this.meshes[k];
      const yaw = Math.atan2(-v.hy, v.hx);
      const pitch = Math.max(-0.04, Math.min(0.03, v.acc * 0.011));
      this.e.set(0, yaw, v.state === 'crashed' ? 0.0 : pitch);
      this.q.setFromEuler(this.e);
      let sc = 1;
      if (v.state === 'park' && v.stateT > 0.8) sc = Math.max(0.01, 1 - (v.stateT - 0.8) / 0.8);
      if (v.state === 'crashed') {
        // crashed cars sit at an odd angle
        this.e.set(0, yaw + ((v.id % 7) - 3) * 0.12, 0);
        this.q.setFromEuler(this.e);
      }
      this.s.set(sc, sc, sc);
      this.p.set(v.x, 0, v.y);
      this.m.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(idx, this.m);
      if (k === MODEL.ambulance || k === MODEL.fire || k === MODEL.police || k === MODEL.tow) this.col.setRGB(1, 1, 1);
      else this.col.setHex(v.color);
      if (v.state === 'crashed') this.col.multiplyScalar(0.6);
      mesh.setColorAt(idx, this.col);
      // contact shadow
      if (si < 2400) {
        const spec = MODEL_SPECS[k];
        this.e.set(0, yaw, 0);
        this.q.setFromEuler(this.e);
        this.s.set((spec.len + 0.5) * sc, 1, (spec.width + 0.5) * sc);
        this.p.set(v.x, 0.03, v.y);
        this.m.compose(this.p, this.q, this.s);
        this.blobs.setMatrixAt(si++, this.m);
      }
      if (sc < 0.5) continue;
      // lights
      const ls = this.specs[k];
      const hx = v.hx;
      const hy = v.hy;
      const rx = -hy;
      const ry = hx;
      const put = (along: number, lat: number, h: number, r: number, g: number, b: number, sx = 1): void => {
        if (li >= 9000) return;
        this.p.set(v.x + hx * along + rx * lat, h, v.y + hy * along + ry * lat);
        this.e.set(0, yaw, 0);
        this.q.setFromEuler(this.e);
        this.s.set(sx, 1, 1);
        this.m.compose(this.p, this.q, this.s);
        lights.setMatrixAt(li, this.m);
        this.col.setRGB(r, g, b);
        lights.setColorAt(li, this.col);
        li++;
      };
      const braking = v.brake || v.state === 'park';
      for (const [a, lat, h] of ls.tail) {
        const tail = braking ? 3.0 : 0.4 + night * 0.9;
        put(a, lat, h, tail, tail * 0.05, tail * 0.04);
      }
      for (const [a, lat, h] of ls.head) {
        const hv = 0.55 + night * 2.2;
        put(a, lat, h, hv, hv * 0.97, hv * 0.85);
      }
      const hazard = v.hazard || v.state === 'crashed';
      if ((v.blink !== 0 || hazard) && blink) {
        const sides = hazard ? [1, -1] : [v.blink];
        for (const sd of sides) {
          const lat = (MODEL_SPECS[k].width / 2 - 0.12) * sd;
          put(ls.tail[0][0] + 0.02, lat, ls.tail[0][2] - 0.14, 3.2, 1.5, 0.1);
          put(ls.head[0][0] - 0.02, lat, ls.head[0][2] + 0.12, 3.2, 1.5, 0.1);
        }
      }
      if (ls.bar > 0 && (v.siren || v.tow)) {
        const a = strobe;
        if (v.tow) {
          put(-0.2, 0.35, ls.bar, a ? 3.2 : 0.4, a ? 1.6 : 0.2, 0.05, 1.6);
          put(-0.2, -0.35, ls.bar, !a ? 3.2 : 0.4, !a ? 1.6 : 0.2, 0.05, 1.6);
        } else {
          put(-0.1, 0.4, ls.bar, a ? 3.5 : 0.3, 0.05, 0.05, 1.6);
          put(-0.1, -0.4, ls.bar, 0.05, 0.1, !a ? 3.8 : 0.3, 1.6);
        }
      }
      if (beamsOn && bi < 2400 && v.state !== 'crashed') {
        const len = k === MODEL.bus || k === MODEL.truck ? 16 : 13;
        this.e.set(0, yaw, 0);
        this.q.setFromEuler(this.e);
        this.s.set(len, 1, 5.5);
        this.p.set(v.x + hx * MODEL_SPECS[k].len * 0.5, 0.05, v.y + hy * MODEL_SPECS[k].len * 0.5);
        this.m.compose(this.p, this.q, this.s);
        this.beams.setMatrixAt(bi++, this.m);
      }
    }
    for (let k = 0; k < MODEL_COUNT; k++) {
      const mesh = this.meshes[k];
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    lights.count = li;
    lights.instanceMatrix.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
    this.beams.count = beamsOn ? bi : 0;
    this.beams.instanceMatrix.needsUpdate = true;
    (this.beams.material as THREE.MeshBasicMaterial).opacity = Math.max(0, night - 0.2) * 0.42;
    this.blobs.count = si;
    this.blobs.instanceMatrix.needsUpdate = true;
  }
}

function rotateBeam(t: THREE.Texture): THREE.Texture {
  // beam texture is drawn along +v; plane is along +x after translation -> rotate texture 90°
  const c = t.clone();
  c.center.set(0.5, 0.5);
  c.rotation = Math.PI / 2;
  c.needsUpdate = true;
  return c;
}

export type { Vehicle };
