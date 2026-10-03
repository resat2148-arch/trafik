// Fixed-angle (isometric-like) perspective camera rig with smooth pan / zoom /
// rotate for mouse, touch and keyboard.

import * as THREE from 'three';
import { clamp, lerp } from '../core/math.ts';

export interface RigBounds {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  private goalTarget = new THREE.Vector3();
  dist = 260;
  private goalDist = 260;
  yaw = 0;
  private goalYaw = 0;
  pitchBias = 0;
  minDist = 22;
  maxDist = 820;
  bounds: RigBounds;
  private dom: HTMLElement;
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMode: 'none' | 'pan' | 'rotate' = 'none';
  private downPos = { x: 0, y: 0 };
  private moved = 0;
  private lastPinch = 0;
  private lastAngle = 0;
  private lastMid = { x: 0, y: 0 };
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  onClick: ((x: number, y: number, ev: PointerEvent) => void) | null = null;
  onHover: ((x: number, y: number) => void) | null = null;
  enabled = true;
  autoOrbit = false;

  constructor(dom: HTMLElement, aspect: number, bounds: RigBounds) {
    this.dom = dom;
    this.bounds = bounds;
    this.camera = new THREE.PerspectiveCamera(34, aspect, 1, 5000);
    this.yaw = this.goalYaw = -0.55;
    this.attach();
  }

  get pitch(): number {
    const t = clamp((this.dist - this.minDist) / (this.maxDist - this.minDist), 0, 1);
    return clamp(lerp(0.66, 1.08, Math.sqrt(t)) + this.pitchBias, 0.45, 1.3);
  }

  /** approximate radius of the visible ground area */
  get viewRadius(): number {
    return this.dist * 0.75;
  }

  focus(x: number, y: number, dist?: number, instant = false): void {
    this.goalTarget.set(x, 0, y);
    if (dist !== undefined) this.goalDist = clamp(dist, this.minDist, this.maxDist);
    if (instant) {
      this.target.copy(this.goalTarget);
      this.dist = this.goalDist;
    }
  }

  rotateBy(a: number): void {
    this.goalYaw += a;
  }

  zoomBy(f: number): void {
    this.goalDist = clamp(this.goalDist * f, this.minDist, this.maxDist);
  }

  update(dt: number): void {
    const panSpeed = this.dist * 0.9 * dt;
    let px = 0;
    let pz = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) pz -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) pz += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) px -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) px += 1;
      if (this.keys.has('KeyQ')) this.goalYaw -= dt * 1.4;
      if (this.keys.has('KeyE')) this.goalYaw += dt * 1.4;
      if (this.keys.has('Equal') || this.keys.has('NumpadAdd') || this.keys.has('KeyZ')) this.zoomBy(Math.pow(0.4, dt));
      if (this.keys.has('Minus') || this.keys.has('NumpadSubtract') || this.keys.has('KeyX')) this.zoomBy(Math.pow(2.5, dt));
    }
    if (px || pz) {
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      this.goalTarget.x += (px * c - pz * s) * panSpeed;
      this.goalTarget.z += (px * s + pz * c) * panSpeed;
    }
    if (this.autoOrbit) this.goalYaw += dt * 0.05;
    const b = this.bounds;
    this.goalTarget.x = clamp(this.goalTarget.x, b.minx, b.maxx);
    this.goalTarget.z = clamp(this.goalTarget.z, b.miny, b.maxy);
    const k = 1 - Math.exp(-dt * 10);
    this.target.lerp(this.goalTarget, k);
    this.dist = lerp(this.dist, this.goalDist, k);
    this.yaw = lerp(this.yaw, this.goalYaw, 1 - Math.exp(-dt * 8));
    this.apply();
  }

  apply(): void {
    const p = this.pitch;
    const h = Math.sin(p) * this.dist;
    const r = Math.cos(p) * this.dist;
    // camera sits "south" of the target when yaw = 0, looking north
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * r, h, this.target.z + Math.cos(this.yaw) * r);
    this.camera.lookAt(this.target);
    this.camera.near = Math.max(0.5, this.dist * 0.02);
    this.camera.far = Math.max(2500, this.dist * 8);
    this.camera.updateProjectionMatrix();
  }

  /** ground point under screen position (client coordinates) */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.ground, out) ? out : null;
  }

  private attach(): void {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.downPos = { x: e.clientX, y: e.clientY };
        this.moved = 0;
        this.dragMode = e.button === 2 || e.button === 1 || e.shiftKey ? 'rotate' : 'pan';
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
        this.lastAngle = Math.atan2(b.y - a.y, b.x - a.x);
        this.lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.dragMode = 'none';
        this.moved = 99;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      const prev = this.pointers.get(e.pointerId);
      if (!prev) {
        if (this.onHover) this.onHover(e.clientX, e.clientY);
        return;
      }
      const cur = { x: e.clientX, y: e.clientY };
      if (this.pointers.size === 2) {
        this.pointers.set(e.pointerId, cur);
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (this.lastPinch > 0) this.goalDist = clamp(this.goalDist * (this.lastPinch / Math.max(d, 1)), this.minDist, this.maxDist);
        let da = ang - this.lastAngle;
        if (da > Math.PI) da -= Math.PI * 2;
        if (da < -Math.PI) da += Math.PI * 2;
        this.goalYaw -= da;
        this.panBetween(this.lastMid, mid);
        this.lastPinch = d;
        this.lastAngle = ang;
        this.lastMid = mid;
        return;
      }
      this.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (this.dragMode === 'pan' && this.moved > 4) this.panBetween(prev, cur);
      else if (this.dragMode === 'rotate') {
        this.goalYaw -= (cur.x - prev.x) * 0.006;
        this.pitchBias = clamp(this.pitchBias + (cur.y - prev.y) * 0.003, -0.3, 0.25);
      }
      this.pointers.set(e.pointerId, cur);
    });
    const up = (e: PointerEvent): void => {
      const had = this.pointers.has(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (had && this.pointers.size === 0) {
        if (this.moved < 6 && this.onClick && this.dragMode !== 'none' && e.button !== 2) this.onClick(e.clientX, e.clientY, e);
        this.dragMode = 'none';
      }
      if (this.pointers.size < 2) this.lastPinch = 0;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        const f = Math.pow(1.0015, e.deltaY);
        const before = this.groundAt(e.clientX, e.clientY);
        const old = this.goalDist;
        this.goalDist = clamp(this.goalDist * f, this.minDist, this.maxDist);
        // zoom towards the cursor
        if (before) {
          const k = 1 - this.goalDist / old;
          this.goalTarget.x += (before.x - this.goalTarget.x) * k * 0.9;
          this.goalTarget.z += (before.z - this.goalTarget.z) * k * 0.9;
        }
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private panBetween(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const pa = this.groundAt(a.x, a.y);
    const pb = this.groundAt(b.x, b.y);
    if (!pa || !pb) return;
    this.goalTarget.x += pa.x - pb.x;
    this.goalTarget.z += pa.z - pb.z;
    // panning should feel immediate
    this.target.x += pa.x - pb.x;
    this.target.z += pa.z - pb.z;
  }
}
