// Pedestrians strolling around the blocks on the sidewalks (visual life).

import * as THREE from 'three';
import type { V2 } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import { offsetClosed, signedArea } from '../core/geom.ts';
import type { City } from '../world/citygen.ts';
import { GeoBuilder } from './geo.ts';

interface Walker {
  color: THREE.Color;
  loop: number;
  s: number;
  speed: number;
  dir: 1 | -1;
  phase: number;
  nightOK: boolean;
  pause: number;
}

interface Loop {
  pts: V2[];
  cum: number[];
  len: number;
}

const CLOTHES = [0x2f4f8f, 0xa83232, 0x3a7d44, 0xd9a441, 0x6b3fa0, 0x2b2b2b, 0xe0e0e0, 0x4f8fbf, 0xc46a2b, 0x8a8a8a, 0xb04a7a, 0x1f6b6b];

export class Pedestrians {
  group = new THREE.Group();
  private body: THREE.InstancedMesh;
  private rest: THREE.InstancedMesh;
  private loops: Loop[] = [];
  private walkers: Walker[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3(1.08, 1.08, 1.08);
  private up = new THREE.Vector3(0, 1, 0);
  private max: number;

  constructor(max: number) {
    this.max = max;
    const b = new GeoBuilder();
    b.setColor(0xffffff);
    b.box(0, 0.82, 0, 0.26, 0.62, 0.42, 1, 0);
    const r = new GeoBuilder();
    r.setColor(0x2a2d33);
    r.box(0, 0, 0, 0.22, 0.84, 0.32, 1, 0);
    r.setColor(0xe0b393);
    r.box(0, 1.46, 0, 0.22, 0.24, 0.2, 1, 0);
    r.setColor(0x3b2a20);
    r.box(-0.01, 1.66, 0, 0.24, 0.07, 0.22, 1, 0);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.body = new THREE.InstancedMesh(b.build(), mat, max);
    this.rest = new THREE.InstancedMesh(r.build(), mat, max);
    for (const im of [this.body, this.rest]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
    }
    this.group.add(this.body, this.rest);
  }

  build(city: City): void {
    const rng = new RNG(321);
    this.loops = [];
    this.walkers = [];
    const center = city.center;
    for (const bl of city.blocks) {
      if (bl.water) continue;
      const curb = bl.curb;
      const sign = signedArea(curb) > 0 ? 1 : -1;
      const mid = offsetClosed(curb, 1.2 * sign);
      const cum: number[] = [0];
      for (let i = 1; i <= mid.length; i++) {
        const a = mid[i - 1];
        const b = mid[i % mid.length];
        cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const len = cum[cum.length - 1];
      if (len < 40) continue;
      const li = this.loops.length;
      this.loops.push({ pts: mid, cum, len });
      const d = Math.hypot(bl.centroid.x - center.x, bl.centroid.y - center.y);
      const busy = bl.zone === 'off' || bl.zone === 'com' ? 1.4 : bl.park ? 1.1 : bl.zone === 'ind' ? 0.35 : 0.8;
      const n = Math.round((len / 30) * busy * (d < 200 ? 1.3 : 1));
      for (let k = 0; k < n; k++) {
        this.walkers.push({
          color: new THREE.Color(CLOTHES[rng.int(0, CLOTHES.length - 1)]),
          loop: li,
          s: rng.range(0, len),
          speed: rng.range(1.0, 1.6),
          dir: rng.chance(0.5) ? 1 : -1,
          phase: rng.range(0, 6.28),
          nightOK: rng.chance(0.3),
          pause: 0,
        });
      }
    }
    // cap
    rng.shuffle(this.walkers);
    this.walkers.length = Math.min(this.walkers.length, this.max);
  }

  update(dt: number, night: number, camTarget: THREE.Vector3, viewR: number): void {
    let n = 0;
    const visR = viewR * 1.6 + 40;
    for (const w of this.walkers) {
      const L = this.loops[w.loop];
      if (w.pause > 0) w.pause -= dt;
      else {
        w.s += w.speed * w.dir * dt;
        if (Math.random() < dt * 0.01) w.pause = 2 + Math.random() * 5;
      }
      if (w.s < 0) w.s += L.len;
      if (w.s >= L.len) w.s -= L.len;
      if (night > 0.6 && !w.nightOK) continue;
      // locate segment
      const cum = L.cum;
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= w.s) lo = mid;
        else hi = mid;
      }
      const a = L.pts[lo];
      const b = L.pts[(lo + 1) % L.pts.length];
      const sl = cum[lo + 1] - cum[lo] || 1;
      const t = (w.s - cum[lo]) / sl;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (Math.abs(x - camTarget.x) > visR || Math.abs(y - camTarget.z) > visR) continue;
      let hx = (b.x - a.x) / sl;
      let hy = (b.y - a.y) / sl;
      if (w.dir < 0) {
        hx = -hx;
        hy = -hy;
      }
      w.phase += dt * w.speed * 5.5 * (w.pause > 0 ? 0 : 1);
      const bob = w.pause > 0 ? 0 : Math.abs(Math.sin(w.phase)) * 0.05;
      this.q.setFromAxisAngle(this.up, Math.atan2(-hy, hx));
      // keep to the right of the walking direction
      const off = 0.32;
      this.p.set(x - hy * off, 0.16 + bob, y + hx * off);
      this.m.compose(this.p, this.q, this.sc);
      this.body.setMatrixAt(n, this.m);
      this.body.setColorAt(n, w.color);
      this.rest.setMatrixAt(n, this.m);
      n++;
    }
    this.body.count = n;
    this.rest.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.rest.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
  }
}
