// Sky, sun / moon light, day-night cycle, fog and rain.

import * as THREE from 'three';
import { clamp, lerp } from '../core/math.ts';

interface Key {
  h: number;
  sky: number;
  fog: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  exposure: number;
}

const KEYS: Key[] = [
  { h: 0, sky: 0x0f1a2e, fog: 0x121c30, sun: 0x9fb4e0, sunI: 0.75, hemiSky: 0x5a6c9a, hemiGround: 0x23262e, hemiI: 1.0, exposure: 1.05 },
  { h: 5.2, sky: 0x1c2a44, fog: 0x1e2a42, sun: 0xa7b8e0, sunI: 0.75, hemiSky: 0x62739c, hemiGround: 0x25272e, hemiI: 1.0, exposure: 1.05 },
  { h: 6.0, sky: 0xeab48e, fog: 0xdcb49c, sun: 0xffc38a, sunI: 1.9, hemiSky: 0xdcc4b4, hemiGround: 0x5a5048, hemiI: 1.0, exposure: 1.05 },
  { h: 6.6, sky: 0xc9c6c4, fog: 0xd2cbc4, sun: 0xffd6aa, sunI: 2.2, hemiSky: 0xd2d4dc, hemiGround: 0x5e5a50, hemiI: 1.0, exposure: 1.02 },
  { h: 7.5, sky: 0xaccbe0, fog: 0xc3d3dc, sun: 0xffe2bc, sunI: 2.3, hemiSky: 0xc4d8ea, hemiGround: 0x5e5a50, hemiI: 0.95, exposure: 1.0 },
  { h: 12, sky: 0x9cc7e6, fog: 0xbcd3e2, sun: 0xfff6e8, sunI: 2.9, hemiSky: 0xcfe2f2, hemiGround: 0x67645a, hemiI: 1.05, exposure: 1.0 },
  { h: 16.5, sky: 0xa5c6dd, fog: 0xc6d2d8, sun: 0xffe7c4, sunI: 2.5, hemiSky: 0xcadbe8, hemiGround: 0x625d52, hemiI: 1.0, exposure: 1.0 },
  { h: 18.6, sky: 0xe8a073, fog: 0xd99f80, sun: 0xff9a52, sunI: 1.6, hemiSky: 0xd9a790, hemiGround: 0x4a3c34, hemiI: 0.75, exposure: 1.02 },
  { h: 19.6, sky: 0x5a4c6e, fog: 0x4f4762, sun: 0xd27a6a, sunI: 0.8, hemiSky: 0x7a6c94, hemiGround: 0x2a2830, hemiI: 0.85, exposure: 1.02 },
  { h: 20.6, sky: 0x16213a, fog: 0x1a2440, sun: 0x9fb4e0, sunI: 0.8, hemiSky: 0x5c6e9c, hemiGround: 0x24262e, hemiI: 1.0, exposure: 1.05 },
  { h: 24, sky: 0x0f1a2e, fog: 0x121c30, sun: 0x9fb4e0, sunI: 0.75, hemiSky: 0x5a6c9a, hemiGround: 0x23262e, hemiI: 1.0, exposure: 1.05 },
];

const ca = new THREE.Color();
const cb = new THREE.Color();

function mixHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  ca.setHex(a);
  cb.setHex(b);
  return out.copy(ca).lerp(cb, t);
}

export class Environment {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fog: THREE.Fog;
  background = new THREE.Color();
  night = 0;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainVel: Float32Array;
  rainAmount = 0;
  private rainMat: THREE.LineBasicMaterial;
  exposure = 1;
  shadowSize = 200;

  constructor(scene: THREE.Scene, shadows: boolean, shadowRes: number) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(0xcfe2f2, 0x67645a, 1.0);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.setShadows(shadows, shadowRes);
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.fog = new THREE.Fog(0xbcd3e2, 600, 2400);
    scene.fog = this.fog;
    scene.background = this.background;
    // rain streaks
    const N = 3500;
    this.rainPos = new Float32Array(N * 6);
    this.rainVel = new Float32Array(N);
    for (let i = 0; i < N; i++) this.rainVel[i] = 28 + Math.random() * 12;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.0, depthWrite: false });
    this.rain = new THREE.LineSegments(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
  }

  update(hour: number, target: THREE.Vector3, viewRadius: number, dt: number, camPos: THREE.Vector3): void {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = clamp((hour - a.h) / Math.max(0.001, b.h - a.h), 0, 1);
    const wet = this.rainAmount;
    mixHex(a.sky, b.sky, t, this.background);
    // rain greys out the sky
    this.background.lerp(new THREE.Color(0x8b949c).multiplyScalar(0.4 + 0.6 * (1 - this.nightFrom(hour))), wet * 0.55);
    mixHex(a.fog, b.fog, t, this.fog.color);
    this.fog.color.lerp(this.background, wet * 0.5);
    mixHex(a.sun, b.sun, t, this.sun.color);
    this.sun.intensity = lerp(a.sunI, b.sunI, t) * (1 - wet * 0.55);
    mixHex(a.hemiSky, b.hemiSky, t, this.hemi.color);
    mixHex(a.hemiGround, b.hemiGround, t, this.hemi.groundColor);
    this.hemi.intensity = lerp(a.hemiI, b.hemiI, t) * (1 - wet * 0.15);
    this.exposure = lerp(a.exposure, b.exposure, t);
    this.night = this.nightFrom(hour);
    // fog distance follows the zoom so the horizon always fades nicely
    const near = Math.max(250, viewRadius * 2.2) * (1 - wet * 0.45);
    this.fog.near = near;
    this.fog.far = near * 3.2 + 400;
    // sun position: east (morning) -> south -> west (evening); moon at night
    let ang: number;
    let elev: number;
    if (hour >= 5.5 && hour <= 20.2) {
      ang = ((hour - 6) / 13) * Math.PI;
      elev = Math.max(0.12, Math.sin(clamp(ang, 0.05, Math.PI - 0.05))) * 1.0;
    } else {
      const hn = hour > 20 ? hour - 20 : hour + 4;
      ang = (hn / 10) * Math.PI;
      elev = 0.7;
    }
    const dir = new THREE.Vector3(Math.cos(ang) * 0.85, 0.35 + elev * 0.9, 0.55).normalize();
    this.sun.position.copy(target).addScaledVector(dir, 400);
    this.sun.target.position.copy(target);
    this.shadowSize = clamp(viewRadius * 1.35, 60, 520);
    const sc = this.sun.shadow.camera;
    sc.left = -this.shadowSize;
    sc.right = this.shadowSize;
    sc.top = this.shadowSize;
    sc.bottom = -this.shadowSize;
    sc.updateProjectionMatrix();
    this.updateRain(dt, camPos, target);
  }

  setShadows(on: boolean, res: number): void {
    this.sun.castShadow = on;
    if (!on) return;
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== res) {
      sh.mapSize.set(res, res);
      sh.map?.dispose();
      sh.map = null;
    }
    sh.bias = -0.0004;
    sh.normalBias = 0.04;
    sh.camera.near = 1;
    sh.camera.far = 900;
    sh.radius = 2;
  }

  nightFrom(hour: number): number {
    if (hour < 5.2 || hour > 20.6) return 1;
    if (hour < 6.6) return clamp((6.6 - hour) / 1.4, 0, 1);
    if (hour > 18.8) return clamp((hour - 18.8) / 1.8, 0, 1);
    return 0;
  }

  private updateRain(dt: number, cam: THREE.Vector3, target: THREE.Vector3): void {
    const on = this.rainAmount > 0.02;
    this.rain.visible = on;
    if (!on) return;
    this.rainMat.opacity = this.rainAmount * 0.55;
    const p = this.rainPos;
    const N = this.rainVel.length;
    const active = Math.floor(N * this.rainAmount);
    // particles live in a box between the camera and the target
    const cx = (cam.x + target.x) / 2;
    const cz = (cam.z + target.z) / 2;
    const R = Math.max(60, cam.distanceTo(target) * 0.7);
    const top = Math.min(cam.y, 220);
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      if (i >= active) {
        p[o + 1] = -1000;
        p[o + 4] = -1000;
        continue;
      }
      let y = p[o + 1];
      if (y < 0 || y > top + 5 || Math.abs(p[o] - cx) > R || Math.abs(p[o + 2] - cz) > R) {
        p[o] = cx + (Math.random() * 2 - 1) * R;
        p[o + 2] = cz + (Math.random() * 2 - 1) * R;
        y = Math.random() * top;
      }
      y -= this.rainVel[i] * dt;
      const len = 1.4;
      p[o + 1] = y;
      p[o + 3] = p[o] + 0.15;
      p[o + 4] = y + len;
      p[o + 5] = p[o + 2] + 0.1;
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
