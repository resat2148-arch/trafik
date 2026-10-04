// Orchestrates the three.js scene: world, vehicles, environment, overlays.

import * as THREE from 'three';
import type { City } from '../world/citygen.ts';
import type { Sim } from '../sim/sim.ts';
import { CameraRig } from './camera.ts';
import { Environment } from './environment.ts';
import { Overlays } from './overlays.ts';
import { makeTextures } from './textures.ts';
import type { TextureSet } from './textures.ts';
import { VehicleView } from './vehicles.ts';
import { Pedestrians } from './pedestrians.ts';
import { WorldView } from './world.ts';
import type { Quality } from './world.ts';

export type QualityLevel = 'low' | 'medium' | 'high';

export function qualityPreset(level: QualityLevel): Quality & { shadowRes: number } {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  switch (level) {
    case 'low':
      return { shadows: false, trees: 0.45, pixelRatio: Math.min(dpr, 1), lampGlow: false, shadowRes: 1024 };
    case 'medium':
      return { shadows: true, trees: 0.75, pixelRatio: Math.min(dpr, 1.5), lampGlow: true, shadowRes: 1536 };
    default:
      return { shadows: true, trees: 1, pixelRatio: Math.min(dpr, 2), lampGlow: true, shadowRes: 2048 };
  }
}

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig: CameraRig;
  env: Environment;
  world!: WorldView;
  vehicles!: VehicleView;
  overlays = new Overlays();
  peds: Pedestrians | null = null;
  tex: TextureSet;
  city: City | null = null;
  quality: Quality & { shadowRes: number };
  level: QualityLevel;
  container: HTMLElement;
  private lastW = 0;
  private lastH = 0;

  constructor(container: HTMLElement, level: QualityLevel) {
    this.container = container;
    this.level = level;
    this.quality = qualityPreset(level);
    // asking for a stencil buffer gets a 24-bit depth buffer on GPUs that otherwise hand out 16 bits
    this.renderer = new THREE.WebGLRenderer({ antialias: level !== 'low', powerPreference: 'high-performance', stencil: true });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.tex = makeTextures();
    this.env = new Environment(this.scene, this.quality.shadows, this.quality.shadowRes);
    this.rig = new CameraRig(this.renderer.domElement, 1, { minx: -500, miny: -500, maxx: 500, maxy: 500 });
    this.scene.add(this.overlays.group);
    this.resize();
  }

  private disposeWorld(): void {
    if (!this.world) return;
    this.scene.remove(this.world.group);
    // geometry and materials belong to this world view; textures are shared and stay
    this.world.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
  }

  /** rebuild the static world after its geometry changed (a road was widened) */
  rebuildWorld(day: number): void {
    if (!this.city) return;
    this.disposeWorld();
    this.world = new WorldView(this.city, this.tex, this.quality);
    this.world.build(day);
    this.scene.add(this.world.group);
    this.peds?.build(this.city);
    this.overlays.buildTraffic(this.city.net);
  }

  setCity(city: City, sim: Sim, day: number): void {
    this.disposeWorld();
    if (this.vehicles) this.scene.remove(this.vehicles.group);
    this.city = city;
    this.world = new WorldView(city, this.tex, this.quality);
    this.world.build(day);
    this.scene.add(this.world.group);
    this.vehicles = new VehicleView(this.tex, this.quality.shadows);
    this.scene.add(this.vehicles.group);
    if (this.peds) this.scene.remove(this.peds.group);
    this.peds = new Pedestrians(this.quality.shadows ? 420 : 200);
    this.peds.build(city);
    this.scene.add(this.peds.group);
    this.overlays.buildTraffic(city.net);
    const b = city.bounds;
    this.rig.bounds = { minx: b.minx - 60, miny: b.miny - 60, maxx: b.maxx + 60, maxy: b.maxy + 60 };
    const span = Math.max(b.maxx - b.minx, b.maxy - b.miny);
    this.rig.maxDist = Math.max(500, span * 1.35);
    this.rig.focus(city.center.x, city.center.y, span * 0.75, true);
    void sim;
  }

  /** switch graphics quality live (antialiasing stays as created) */
  setQuality(level: QualityLevel, sim: Sim | null, day: number): void {
    this.level = level;
    this.quality = qualityPreset(level);
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.env.setShadows(this.quality.shadows, this.quality.shadowRes);
    this.lastW = 0;
    this.resize();
    if (!this.city || !sim) return;
    const rig = this.rig;
    const target = rig.target.clone();
    const dist = rig.dist;
    this.setCity(this.city, sim, day);
    rig.focus(target.x, target.z, dist, true);
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  frame(dt: number, hour: number, rain: number, sim: Sim): void {
    this.resize();
    this.rig.update(dt);
    this.env.rainAmount += (rain - this.env.rainAmount) * Math.min(1, dt * 0.5);
    this.env.update(hour, this.rig.target, this.rig.viewRadius, dt, this.rig.camera.position);
    this.renderer.toneMappingExposure = this.env.exposure;
    const night = this.env.night;
    if (this.world) {
      this.world.update(dt, night);
      const wet = this.env.rainAmount;
      const asphalt = this.world.mats.asphalt as THREE.MeshStandardMaterial;
      asphalt.roughness = 0.93 - wet * 0.55;
      asphalt.color.setScalar(1 - wet * 0.35);
    }
    if (this.vehicles) {
      sim.updatePoses();
      this.vehicles.update(sim, dt, night);
    }
    this.peds?.update(dt, night, this.rig.target, this.rig.viewRadius);
    this.overlays.update(dt, sim, night);
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** project a world point to screen pixels (for HTML labels) */
  toScreen(x: number, y: number, h = 0): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, h, y).project(this.rig.camera);
    const w = this.lastW;
    const hh = this.lastH;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * hh, visible: v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1 };
  }
}
