// Overlays: live traffic layer (speed colouring per lane), selection rings,
// route preview of a selected vehicle and emoji bubbles above vehicles.

import * as THREE from 'three';
import type { V2 } from '../core/math.ts';
import { clamp } from '../core/math.ts';
import { Path } from '../core/path.ts';
import { GeoBuilder } from './geo.ts';
import { iconTexture } from './textures.ts';
import type { Lane, Network, Node, Road } from '../sim/network.ts';
import type { Sim } from '../sim/sim.ts';
import type { Vehicle } from '../sim/vehicle.ts';

interface LaneRange {
  lane: Lane;
  start: number;
  count: number;
}

export type Selection = { kind: 'node'; node: Node } | { kind: 'road'; road: Road } | { kind: 'vehicle'; v: Vehicle } | null;

export class Overlays {
  group = new THREE.Group();
  private traffic: THREE.Mesh | null = null;
  private ranges: LaneRange[] = [];
  trafficOn = false;
  private waveSel: THREE.Mesh | null = null;
  private sel: THREE.Mesh;
  private hover: THREE.Mesh;
  private roadSel: THREE.Mesh | null = null;
  private route: THREE.Mesh | null = null;
  private routeFor: Vehicle | null = null;
  private routeT = 0;
  selection: Selection = null;
  hoverNode: Node | null = null;
  private emojiTex = new Map<string, THREE.Texture>();
  private sprites: THREE.Sprite[] = [];
  private t = 0;
  private trafficT = 0;
  private hintRings: THREE.Mesh[] = [];

  constructor() {
    const rg = new THREE.RingGeometry(0.86, 1, 64);
    rg.rotateX(-Math.PI / 2);
    this.sel = new THREE.Mesh(
      rg,
      new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.sel.visible = false;
    this.sel.renderOrder = 5;
    this.hover = new THREE.Mesh(
      rg.clone(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.hover.visible = false;
    this.hover.renderOrder = 5;
    this.group.add(this.sel, this.hover);
    for (let i = 0; i < 60; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
      sp.visible = false;
      sp.renderOrder = 10;
      this.sprites.push(sp);
      this.group.add(sp);
    }
  }

  private emoji(e: string): THREE.Texture {
    let t = this.emojiTex.get(e);
    if (!t) {
      t = iconTexture(e, 64);
      this.emojiTex.set(e, t);
    }
    return t;
  }

  buildTraffic(net: Network): void {
    if (this.traffic) {
      this.group.remove(this.traffic);
      this.traffic.geometry.dispose();
    }
    const gb = new GeoBuilder();
    this.ranges = [];
    for (const l of net.links) {
      for (const lane of l.lanes) {
        const start = gb.vertexCount;
        const pts = lane.path.points();
        if (pts.length < 2) continue;
        gb.setRGB(0.2, 0.9, 0.3);
        gb.ribbon(pts, Math.max(1.2, lane.width * 0.42), 0.07, 0);
        this.ranges.push({ lane, start, count: gb.vertexCount - start });
      }
    }
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
    this.traffic = new THREE.Mesh(gb.build(), mat);
    this.traffic.renderOrder = 4;
    this.traffic.visible = this.trafficOn;
    this.group.add(this.traffic);
    this.updateTraffic();
  }

  setTraffic(on: boolean): void {
    this.trafficOn = on;
    if (this.traffic) this.traffic.visible = on;
    if (on) this.updateTraffic();
  }

  updateTraffic(): void {
    if (!this.traffic) return;
    const col = this.traffic.geometry.attributes.color as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    for (const r of this.ranges) {
      const lane = r.lane;
      let sum = 0;
      let n = 0;
      let stopped = 0;
      for (const v of lane.vehs) {
        sum += v.v;
        n++;
        if (v.v < 1) stopped++;
      }
      let cr: number;
      let cg: number;
      let cb: number;
      if (n === 0) {
        cr = 0.18;
        cg = 0.85;
        cb = 0.35;
      } else {
        const ratio = clamp(sum / n / Math.max(3, lane.vmax), 0, 1);
        const occ = clamp(stopped / Math.max(1, lane.len / 7), 0, 1);
        const bad = clamp(1 - ratio + occ * 0.6, 0, 1);
        // green -> yellow -> orange -> red -> dark red
        if (bad < 0.35) {
          const t = bad / 0.35;
          cr = 0.18 + t * 0.8;
          cg = 0.85;
          cb = 0.35 - t * 0.25;
        } else if (bad < 0.7) {
          const t = (bad - 0.35) / 0.35;
          cr = 0.98;
          cg = 0.85 - t * 0.55;
          cb = 0.1;
        } else {
          const t = (bad - 0.7) / 0.3;
          cr = 0.98 - t * 0.38;
          cg = 0.3 - t * 0.25;
          cb = 0.1;
        }
      }
      for (let i = r.start; i < r.start + r.count; i++) {
        arr[i * 3] = cr;
        arr[i * 3 + 1] = cg;
        arr[i * 3 + 2] = cb;
      }
    }
    col.needsUpdate = true;
  }

  /** green band along the green-wave streets of the selected junction */
  setWaves(roads: Road[]): void {
    if (this.waveSel) {
      this.group.remove(this.waveSel);
      this.waveSel.geometry.dispose();
      this.waveSel = null;
    }
    if (!roads.length) return;
    const gb = new GeoBuilder();
    gb.setRGB(0.24, 0.92, 0.48);
    for (const r of roads) gb.ribbon(r.center.points(), 2.4, 0.11);
    this.waveSel = new THREE.Mesh(gb.build(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.6, depthWrite: false }));
    this.waveSel.renderOrder = 4;
    this.group.add(this.waveSel);
  }

  setSelection(s: Selection): void {
    this.selection = s;
    if (this.roadSel) {
      this.group.remove(this.roadSel);
      this.roadSel.geometry.dispose();
      this.roadSel = null;
    }
    if (s && s.kind === 'road') {
      const r = s.road;
      const gb = new GeoBuilder();
      gb.setRGB(0.2, 0.8, 1);
      const pts = r.center.sub(r.armA.trim, r.length - r.armB.trim).points();
      // along both curbs, just above the sidewalks so raised kerbs never hide it
      gb.ribbon(pts, 0.5, 0.21, -r.width / 2);
      gb.ribbon(pts, 0.5, 0.21, r.width / 2);
      this.roadSel = new THREE.Mesh(gb.build(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }));
      this.roadSel.renderOrder = 5;
      this.group.add(this.roadSel);
    } else if (s && s.kind === 'node' && s.node.control === 'priority') {
      // the major road through a priority junction (it may turn a corner)
      const n = s.node;
      const major = n.arms.filter((a) => n.majorRoads.has(a.road.id));
      if (major.length === 2) {
        const [A, B] = major;
        const at = (a: typeof A, d: number): V2 => ({ x: n.x + a.dir.x * d, y: n.y + a.dir.y * d });
        const path = Path.bezier(at(A, A.trim + 8), at(A, A.trim * 0.3), at(B, B.trim * 0.3), at(B, B.trim + 8));
        const gb = new GeoBuilder();
        gb.setRGB(1, 0.76, 0.23);
        gb.ribbon(path.points(), 2.4, 0.1);
        this.roadSel = new THREE.Mesh(gb.build(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.55, depthWrite: false }));
        this.roadSel.renderOrder = 5;
        this.group.add(this.roadSel);
      }
    }
    if (!s || s.kind !== 'vehicle') this.clearRoute();
  }

  private clearRoute(): void {
    if (this.route) {
      this.group.remove(this.route);
      this.route.geometry.dispose();
      this.route = null;
    }
    this.routeFor = null;
  }

  private buildRoute(v: Vehicle): void {
    this.clearRoute();
    const pts: V2[] = [];
    const seg = v.seg;
    const p = { x: 0, y: 0, dx: 1, dy: 0 };
    for (let s = v.s; s < seg.len; s += 2) {
      seg.path.sample(s, p);
      pts.push({ x: p.x, y: p.y });
    }
    for (const nx of v.plan) for (const q of nx.path.points()) pts.push(q);
    // remaining links: centre line of the lane 0
    const startLink = v.ri + 1 + (v.plan.length ? 1 : 0);
    for (let i = startLink; i < v.route.length; i++) {
      const l = v.route[i];
      const lane = l.lanes[Math.min(l.lanes.length - 1, 0)];
      if (!lane) continue;
      for (const q of lane.path.points()) pts.push(q);
    }
    if (v.dest) {
      const dl = v.dest.link.lanes[v.dest.lane];
      if (dl) {
        // trim the final lane at the destination point
        const end = dl.path.point(v.dest.s);
        pts.push(end);
      }
    }
    if (pts.length < 2) return;
    const gb = new GeoBuilder();
    gb.setRGB(0.25, 0.85, 1);
    gb.ribbon(pts, 0.7, 0.1, 0);
    this.route = new THREE.Mesh(gb.build(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false }));
    this.route.renderOrder = 6;
    this.group.add(this.route);
    this.routeFor = v;
  }

  /** pulsing rings to guide the player (tutorial / hot spots) */
  setHints(nodes: Node[]): void {
    for (const r of this.hintRings) this.group.remove(r);
    this.hintRings = [];
    for (const n of nodes) {
      const g = new THREE.RingGeometry(0.8, 1, 48);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false, toneMapped: false }));
      const r = Math.max(...n.arms.map((a) => a.trim)) + 3;
      m.position.set(n.x, 0.12, n.y);
      m.scale.set(r, 1, r);
      m.userData.r = r;
      m.renderOrder = 7;
      this.hintRings.push(m);
      this.group.add(m);
    }
  }

  update(dt: number, sim: Sim, night: number): void {
    this.t += dt;
    const s = this.selection;
    if (s) {
      let x = 0;
      let y = 0;
      let r = 4;
      if (s.kind === 'node') {
        x = s.node.x;
        y = s.node.y;
        r = Math.max(...s.node.arms.map((a) => a.trim)) + 2;
      } else if (s.kind === 'vehicle') {
        if (s.v.state === 'gone') {
          this.setSelection(null);
          return;
        }
        x = s.v.x;
        y = s.v.y;
        r = s.v.len * 0.75;
        this.routeT -= dt;
        if (this.routeFor !== s.v || this.routeT <= 0) {
          this.buildRoute(s.v);
          this.routeT = 0.5;
        }
      }
      if (s.kind !== 'road') {
        this.sel.visible = true;
        const pulse = 1 + Math.sin(this.t * 4) * 0.04;
        this.sel.position.set(x, 0.12, y);
        this.sel.scale.set(r * pulse, 1, r * pulse);
      } else this.sel.visible = false;
    } else this.sel.visible = false;
    if (this.hoverNode && (!s || s.kind !== 'node' || s.node !== this.hoverNode)) {
      const n = this.hoverNode;
      const r = Math.max(...n.arms.map((a) => a.trim)) + 2;
      this.hover.visible = true;
      this.hover.position.set(n.x, 0.11, n.y);
      this.hover.scale.set(r, 1, r);
    } else this.hover.visible = false;
    for (const h of this.hintRings) {
      const k = 1 + ((this.t * 0.8) % 1) * 0.6;
      h.scale.set(h.userData.r * k, 1, h.userData.r * k);
      (h.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - ((this.t * 0.8) % 1));
    }
    // emoji bubbles
    let i = 0;
    for (const v of sim.vehicles) {
      if (i >= this.sprites.length) break;
      let e = '';
      if (v.state === 'crashed') e = v.stateT < 25 ? '💥' : '⚠️';
      else if (v.mood > 0.55) e = v.mood > 0.85 ? '🤬' : '😠';
      else if (v.hornFlash > 0) e = '📢';
      if (!e) continue;
      const sp = this.sprites[i++];
      sp.visible = true;
      const m = sp.material as THREE.SpriteMaterial;
      const tex = this.emoji(e);
      if (m.map !== tex) {
        m.map = tex;
        m.needsUpdate = true;
      }
      const bob = Math.sin(this.t * 3 + v.id) * 0.25;
      sp.position.set(v.x, 4.6 + bob, v.y);
      const sc = v.state === 'crashed' ? 5 : 3.4;
      sp.scale.set(sc, sc, 1);
      m.opacity = 1;
    }
    for (; i < this.sprites.length; i++) this.sprites[i].visible = false;
    this.trafficT += dt;
    if (this.trafficOn && this.trafficT > 0.5) {
      this.trafficT = 0;
      this.updateTraffic();
    }
    void night;
  }
}
