// Static (and occasionally rebuilt) world geometry: terrain, river, roads,
// junctions, markings, sidewalks, buildings, trees, street lamps, signals.

import * as THREE from 'three';
import type { V2 } from '../core/math.ts';
import { clamp, dist, normAngle, right } from '../core/math.ts';
import { RNG } from '../core/rng.ts';
import { arcPoints, circlePoints, offsetClosed, signedArea, simplifyClosed } from '../core/geom.ts';
import { Path } from '../core/path.ts';
import type { City, Building, Block } from '../world/citygen.ts';
import { blockCurb, cornerPoints, faceWalk, waterBlockLand } from '../world/citygen.ts';
import { ARROW_L, ARROW_R, ARROW_S, ARROW_U, CROSSWALK_W, SIG_G, SIG_P, SIG_R, SIG_Y } from '../sim/network.ts';
import type { Arm, Conn, Lane, Node, Road } from '../sim/network.ts';
import { GeoBuilder } from './geo.ts';
import type { TextureSet } from './textures.ts';
import { FACADE, FACADE_COUNT, FACADE_TILE } from './textures.ts';

const Y_MARK = 0.025;
const Y_WALK = 0.16;

export interface Quality {
  shadows: boolean;
  trees: number; // density multiplier
  pixelRatio: number;
  lampGlow: boolean;
}

function facadeStyle(b: Building): number {
  switch (b.kind) {
    case 'house':
      return FACADE.house;
    case 'apartment':
      return FACADE.apartment;
    case 'office':
      return FACADE.office;
    case 'tower':
      return FACADE.tower;
    case 'shop':
      return FACADE.shop;
    case 'industrial':
      return FACADE.industrial;
    default:
      return FACADE.civic;
  }
}

interface SignalHead {
  node: Node;
  lane: Lane;
  conns: Conn[];
  leftOnly: boolean;
  lampBase: number; // instance index of the red lamp (amber +1, green +2)
}

export class WorldView {
  group = new THREE.Group();
  city: City;
  tex: TextureSet;
  quality: Quality;
  mats: Record<string, THREE.Material> = {};
  facadeMats: THREE.MeshStandardMaterial[] = [];
  private roadMesh: THREE.Mesh | null = null;
  private markMesh: THREE.Mesh | null = null;
  private blockMeshes: THREE.Mesh[] = [];
  private buildingMeshes: THREE.Object3D[] = [];
  private islandMesh: THREE.Mesh | null = null;
  private signalGroup = new THREE.Group();
  private signalLamps: THREE.InstancedMesh | null = null;
  private stopBars: THREE.InstancedMesh | null = null;
  private heads: SignalHead[] = [];
  lampHeads: THREE.InstancedMesh | null = null;
  lampPools: THREE.InstancedMesh | null = null;
  waterMat: THREE.MeshStandardMaterial | null = null;
  day = 1;
  private blinkT = 0;

  constructor(city: City, tex: TextureSet, quality: Quality) {
    this.city = city;
    this.tex = tex;
    this.quality = quality;
    this.makeMaterials();
  }

  private makeMaterials(): void {
    const t = this.tex;
    const std = (o: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(o);
    this.mats.asphalt = std({ map: t.asphalt, roughness: 0.93, metalness: 0 });
    this.mats.sidewalk = std({ map: t.sidewalk, roughness: 0.95, vertexColors: true });
    this.mats.grass = std({ map: t.grass, roughness: 1 });
    this.mats.plaza = std({ map: t.plaza, roughness: 0.9 });
    this.mats.parking = std({ map: t.parking, roughness: 0.93 });
    this.mats.dirt = std({ map: t.dirt, roughness: 1 });
    this.mats.cobble = std({ map: t.cobble, roughness: 0.95 });
    this.mats.mark = std({ vertexColors: true, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.mats.concrete = std({ color: 0xb1aca3, roughness: 0.9 });
    this.mats.roofFlat = std({ map: t.roofFlat, vertexColors: true, roughness: 0.95 });
    this.mats.roofTile = std({ map: t.roofTile, vertexColors: true, roughness: 0.85 });
    this.mats.plain = std({ vertexColors: true, roughness: 0.8 });
    this.mats.metal = std({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 });
    this.mats.tree = std({ vertexColors: true, roughness: 0.9 });
    this.mats.lampHead = std({ color: 0x222222, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 });
    this.mats.glass = std({ color: 0x9fc3d9, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.45 });
    this.mats.scaffold = std({ color: 0xd9a441, roughness: 0.7, transparent: true, opacity: 0.85 });
    this.waterMat = std({ map: t.water, color: 0xa9cdd8, roughness: 0.12, metalness: 0.15 });
    for (let s = 0; s < FACADE_COUNT; s++) {
      this.facadeMats.push(
        std({
          map: t.facades[s],
          emissiveMap: t.facadeLights[s],
          emissive: 0xffffff,
          emissiveIntensity: 0,
          vertexColors: true,
          roughness: s === FACADE.office || s === FACADE.tower ? 0.45 : 0.85,
          metalness: s === FACADE.tower ? 0.25 : 0,
        }),
      );
    }
  }

  build(day: number): void {
    this.day = day;
    this.buildTerrain();
    this.buildRoads();
    this.buildMarkings();
    this.buildBlocks();
    this.buildBuildings();
    this.buildIslands();
    this.buildTrees();
    this.buildLamps();
    this.buildBusStops();
    this.group.add(this.signalGroup);
    this.buildSignals();
  }

  private add(mesh: THREE.Object3D, cast = false, receive = true): void {
    mesh.castShadow = cast && this.quality.shadows;
    mesh.receiveShadow = receive && this.quality.shadows;
    mesh.traverse((o) => {
      o.castShadow = mesh.castShadow;
      o.receiveShadow = mesh.receiveShadow;
    });
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------------
  // terrain & river

  private buildTerrain(): void {
    const c = this.city;
    const S = 2600;
    const gb = new GeoBuilder();
    const river = c.river;
    if (river) {
      gb.polygon(
        [
          { x: -S, y: -S },
          { x: S, y: -S },
          { x: S, y: river.yTop },
          { x: -S, y: river.yTop },
        ],
        -0.03,
        0.05,
      );
      gb.polygon(
        [
          { x: -S, y: river.yBot },
          { x: S, y: river.yBot },
          { x: S, y: S },
          { x: -S, y: S },
        ],
        -0.03,
        0.05,
      );
    } else {
      gb.polygon(
        [
          { x: -S, y: -S },
          { x: S, y: -S },
          { x: S, y: S },
          { x: -S, y: S },
        ],
        -0.03,
        0.05,
      );
    }
    const ground = new THREE.Mesh(gb.build(false), this.mats.grass);
    this.add(ground, false, true);
    if (river) {
      const wb = new GeoBuilder();
      wb.polygon(
        [
          { x: -S, y: river.yTop },
          { x: S, y: river.yTop },
          { x: S, y: river.yBot },
          { x: -S, y: river.yBot },
        ],
        -1.7,
        0.03,
      );
      const water = new THREE.Mesh(wb.build(false), this.waterMat!);
      water.receiveShadow = this.quality.shadows;
      this.group.add(water);
      // embankment walls
      const eb = new GeoBuilder();
      eb.setColor(0x9b968d);
      eb.quad(-S, -1.8, river.yTop, S, -1.8, river.yTop, S, 0.15, river.yTop, -S, 0.15, river.yTop, 0, 0, 1);
      eb.quad(-S, -1.8, river.yBot, S, -1.8, river.yBot, S, 0.15, river.yBot, -S, 0.15, river.yBot, 0, 0, -1);
      // stone coping
      eb.setColor(0xc9c3b8);
      eb.quad(-S, 0.16, river.yTop - 0.6, S, 0.16, river.yTop - 0.6, S, 0.16, river.yTop, -S, 0.16, river.yTop, 0, 1, 0);
      eb.quad(-S, 0.16, river.yBot, S, 0.16, river.yBot, S, 0.16, river.yBot + 0.6, -S, 0.16, river.yBot + 0.6, 0, 1, 0);
      this.add(new THREE.Mesh(eb.build(), this.mats.plain), false, true);
    }
  }

  // ---------------------------------------------------------------------------
  // road surfaces

  junctionPolygon(n: Node): V2[] {
    const pts: V2[] = [];
    const k = n.arms.length;
    for (let i = 0; i < k; i++) {
      const A = n.arms[i];
      const B = n.arms[(i + 1) % k];
      const r = right(A.dir);
      const t = A.trim;
      pts.push({ x: n.x + A.dir.x * t - r.x * A.hw, y: n.y + A.dir.y * t - r.y * A.hw });
      pts.push({ x: n.x + A.dir.x * t + r.x * A.hw, y: n.y + A.dir.y * t + r.y * A.hw });
      if (k > 1) {
        const cp = cornerPoints(n, B, A).slice().reverse();
        for (const p of cp) pts.push(p);
      }
    }
    return simplifyClosed(pts, 0.05, 0.0005);
  }

  private buildRoads(): void {
    if (this.roadMesh) {
      this.group.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
    }
    const gb = new GeoBuilder();
    const net = this.city.net;
    for (const r of net.roads) {
      const s0 = r.armA.trim;
      const s1 = r.length - r.armB.trim;
      const pts = r.center.sub(s0, s1).points();
      // extend gateway roads towards the horizon
      if (r.b.gateway) {
        const d = r.center.endDir();
        const e = pts[pts.length - 1];
        pts.push({ x: e.x + d.x * 700, y: e.y + d.y * 700 });
      }
      if (r.a.gateway) {
        const d = r.center.startDir();
        const e = pts[0];
        pts.unshift({ x: e.x - d.x * 700, y: e.y - d.y * 700 });
      }
      roadStrip(gb, pts, r.width, 0);
    }
    for (const n of net.nodes) {
      if (n.gateway || n.arms.length < 2) continue;
      const poly = this.junctionPolygon(n);
      if (n.ra) {
        // full circle of asphalt for the ring
        gb.polygon(circlePoints(n.x, n.y, n.ra.ro + 0.4, 1.2), 0.004, 0.1);
      }
      gb.polygon(poly, 0.0, 0.1);
    }
    this.roadMesh = new THREE.Mesh(gb.build(false), this.mats.asphalt);
    this.add(this.roadMesh, false, true);
    if (!this.bridgesBuilt) this.buildBridges();
  }

  private bridgesBuilt = false;

  private buildBridges(): void {
    this.bridgesBuilt = true;
    const river = this.city.river;
    if (!river) return;
    const gb = new GeoBuilder();
    for (const r of this.city.net.roads) {
      if (!r.bridge) continue;
      const a = r.center.start();
      const b = r.center.end();
      const L = dist(a, b);
      const dx = (b.x - a.x) / L;
      const dy = (b.y - a.y) / L;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const w = r.width + 2 * r.sidewalk;
      gb.setColor(0xb8b2a8);
      // deck slab below road level
      gb.box(cx, -1.25, cy, L, 1.25, w + 0.6, dx, dy);
      // sidewalks on the bridge
      const rx = -dy;
      const ry = dx;
      gb.setColor(0xc9c5bd);
      for (const side of [-1, 1]) {
        const off = (r.width / 2 + r.sidewalk / 2) * side;
        gb.box(cx + rx * off, 0, cy + ry * off, L, Y_WALK, r.sidewalk, dx, dy);
        // parapet / railing
        const po = (w / 2 + 0.1) * side;
        gb.setColor(0x7c7f84);
        gb.box(cx + rx * po, Y_WALK, cy + ry * po, L, 1.0, 0.25, dx, dy);
        gb.setColor(0xc9c5bd);
      }
      // piers
      gb.setColor(0x9e988e);
      const span = river.yBot - river.yTop;
      const n = Math.max(1, Math.round(span / 25));
      for (let i = 1; i <= n; i++) {
        const py = river.yTop + (span * i) / (n + 1);
        // find point on bridge at this y
        const t = (py - a.y) / (b.y - a.y || 1);
        const px = a.x + (b.x - a.x) * t;
        gb.box(px, -2.2, py, 2.5, 1.0, w * 0.8, dx, dy);
      }
    }
    if (!gb.empty) this.add(new THREE.Mesh(gb.build(), this.mats.plain), true, true);
  }

  // ---------------------------------------------------------------------------
  // markings

  buildMarkings(): void {
    if (this.markMesh) {
      this.group.remove(this.markMesh);
      this.markMesh.geometry.dispose();
    }
    const gb = new GeoBuilder();
    const net = this.city.net;
    const WHITE = 0xf2f2ee;
    const YELLOW = 0xf2c230;
    for (const r of net.roads) {
      const s0 = r.armA.trim;
      const s1 = r.length - r.armB.trim;
      const base = r.center.sub(s0, s1);
      const L = base.length;
      const nAB = r.lanesAB;
      const nBA = r.lanesBA;
      const w = (r.width - r.median) / Math.max(1, nAB + nBA);
      const gwA = r.a.gateway;
      const gwB = r.b.gateway;
      const ext = (pts: V2[]): V2[] => {
        if (gwB) {
          const d = r.center.endDir();
          const e = pts[pts.length - 1];
          pts.push({ x: e.x + d.x * 700, y: e.y + d.y * 700 });
        }
        if (gwA) {
          const d = r.center.startDir();
          const e = pts[0];
          pts.unshift({ x: e.x - d.x * 700, y: e.y - d.y * 700 });
        }
        return pts;
      };
      // centre line
      if (nAB > 0 && nBA > 0 && r.median === 0) {
        const off = -r.width / 2 + nBA * w;
        const p = ext(base.offset(off).points());
        gb.setColor(YELLOW);
        gb.ribbon(p, 0.12, Y_MARK, -0.12);
        gb.ribbon(p, 0.12, Y_MARK, 0.12);
      }
      // lane lines
      gb.setColor(WHITE);
      for (const link of [r.ab, r.ba]) {
        const lanes = link.lanes;
        for (let i = 0; i < lanes.length - 1; i++) {
          const off = (lanes[i].offset + lanes[i + 1].offset) / 2;
          const p = base.offset(off);
          // dashed until 22 m before the stop line, then solid
          const solidLen = Math.min(22, L * 0.4);
          const dashFrom = link.forward ? 1 : solidLen;
          const dashTo = link.forward ? L - solidLen : L - 1;
          for (let s = dashFrom; s < dashTo; s += 9) {
            const e = Math.min(s + 3, dashTo);
            gb.ribbon(p.sub(s, e).points(), 0.13, Y_MARK);
          }
          const sp = link.forward ? p.sub(L - solidLen, L - 0.6) : p.sub(0.6, solidLen);
          gb.ribbon(sp.points(), 0.13, Y_MARK);
        }
        // bus lane tint
        for (const lane of lanes) {
          if (!lane.busOnly) continue;
          gb.setColor(0xa33a2e);
          gb.ribbon(lane.path.points(), lane.width - 0.3, Y_MARK - 0.004);
          gb.setColor(WHITE);
          gb.ribbon(lane.path.offset(-lane.width / 2 + 0.15).points(), 0.22, Y_MARK);
        }
      }
      // median curbs drawn by island builder
    }
    // per junction: stop lines, crosswalks, arrows, box junction, yield teeth
    for (const n of net.nodes) {
      if (n.gateway || n.arms.length < 2) continue;
      const junction = n.arms.length >= 3;
      for (const arm of n.arms) {
        const inL = arm.inLink;
        const r = arm.road;
        // crosswalk
        if (junction) {
          const center = n.ra ? arm.trim + 4.5 : arm.trim - 1.2 - CROSSWALK_W / 2;
          const p = { x: n.x + arm.dir.x * center, y: n.y + arm.dir.y * center };
          const rr = right(arm.dir);
          gb.setColor(WHITE);
          const half = arm.hw - 0.4;
          for (let o = -half; o < half; o += 1.1) {
            const cx = p.x + rr.x * (o + 0.3);
            const cy = p.y + rr.y * (o + 0.3);
            gb.quadFlat(cx, cy, arm.dir.x, arm.dir.y, CROSSWALK_W, 0.55, Y_MARK);
          }
        }
        if (!inL) continue;
        const lanes = inL.lanes;
        const ctrl = n.control;
        const needStopLine = junction && (ctrl === 'signal' || ctrl === 'allstop' || (ctrl === 'priority' && !n.majorRoads.has(r.id)));
        // stop line across inbound lanes
        const first = lanes[0];
        const de = first.path.endDir();
        const rr = right(de);
        const span = lanes.length * first.width;
        // midpoint of the inbound lane group at the stop line
        let mx = 0;
        let my = 0;
        for (const l of lanes) {
          const e = l.path.end();
          mx += e.x;
          my += e.y;
        }
        mx /= lanes.length;
        my /= lanes.length;
        if (needStopLine) {
          gb.setColor(WHITE);
          gb.quadFlat(mx - de.x * 0.25, my - de.y * 0.25, rr.x, rr.y, span, 0.45, Y_MARK);
        } else if (ctrl === 'roundabout' || (ctrl === 'priority' && junction)) {
          // give-way "shark teeth"
          gb.setColor(WHITE);
          for (let o = -span / 2 + 0.4; o < span / 2 - 0.3; o += 0.9) {
            const cx = mx + rr.x * o - de.x * 0.6;
            const cy = my + rr.y * o - de.y * 0.6;
            gb.triFlat(cx, cy, de.x, de.y, 0.6, 0.9, Y_MARK);
          }
        }
        // turn arrows
        gb.setColor(WHITE);
        for (const l of lanes) {
          if (!junction) break;
          if (l.len < 14) continue;
          const mask = n.ra ? ARROW_S : l.arrows;
          arrowGlyph(gb, l.path, l.len - 7.5, mask);
          if (l.len > 46) arrowGlyph(gb, l.path, l.len - 30, mask);
        }
      }
      // yellow box junction
      if (n.box && !n.ra) {
        const poly = this.junctionPolygon(n);
        gb.setColor(YELLOW);
        boxHatch(gb, poly, n);
      }
    }
    this.markMesh = new THREE.Mesh(gb.build(), this.mats.mark);
    this.markMesh.receiveShadow = this.quality.shadows;
    this.group.add(this.markMesh);
  }

  // ---------------------------------------------------------------------------
  // blocks: sidewalks and lots

  buildBlocks(): void {
    for (const m of this.blockMeshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.blockMeshes = [];
    const walk = new GeoBuilder();
    const grass = new GeoBuilder();
    const plaza = new GeoBuilder();
    const parking = new GeoBuilder();
    const c = this.city;
    // recompute curb polygons (roundabouts change corners)
    const faces = faceWalk(c.net);
    const curbs = faces.map((f) => blockCurb(f)).filter((p) => signedArea(p) > 50);
    // map to blocks by centroid proximity
    for (const b of c.blocks) {
      let best: V2[] | null = null;
      let bd = Infinity;
      for (const p of curbs) {
        const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
        const cy = p.reduce((s, q) => s + q.y, 0) / p.length;
        const d = Math.hypot(cx - b.centroid.x, cy - b.centroid.y);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best && bd < 25) b.curb = best;
    }
    for (const b of c.blocks) {
      const parts: V2[][] = b.water && c.river ? waterBlockLand(b, c.river) : [b.curb];
      for (const curb of parts) {
        const lot = b.water ? null : simplifyClosed(offsetClosed(curb, 3.2), 0.2, 0.002);
        // curb face
        walk.setColor(0x9a978f);
        walk.walls(curb, -0.02, Y_WALK, true, 0.5, 0.5, 1);
        walk.setColor(0xffffff);
        if (lot && lot.length >= 3 && signedArea(lot) > 20) {
          walk.polygon(curb, Y_WALK, 0.25, [lot]);
          const target = b.plaza ? plaza : b.park ? grass : b.zone === 'ind' || b.zone === 'off' || b.zone === 'com' ? plaza : grass;
          target.polygon(lot, Y_WALK - 0.005, b.plaza || target === plaza ? 0.12 : 0.06);
        } else {
          walk.polygon(curb, Y_WALK, 0.25);
        }
      }
      for (const pk of b.parking) {
        const pts = [
          { x: pk.cx - pk.ux * pk.hw + pk.uy * pk.hh, y: pk.cy - pk.uy * pk.hw - pk.ux * pk.hh },
          { x: pk.cx + pk.ux * pk.hw + pk.uy * pk.hh, y: pk.cy + pk.uy * pk.hw - pk.ux * pk.hh },
          { x: pk.cx + pk.ux * pk.hw - pk.uy * pk.hh, y: pk.cy + pk.uy * pk.hw + pk.ux * pk.hh },
          { x: pk.cx - pk.ux * pk.hw - pk.uy * pk.hh, y: pk.cy - pk.uy * pk.hw + pk.ux * pk.hh },
        ];
        parking.polygon(pts, Y_WALK + 0.01, 0.12);
      }
    }
    // boulevard medians
    for (const r of c.net.roads) {
      if (r.median <= 0) continue;
      const s0 = r.armA.trim + 2;
      const s1 = r.length - r.armB.trim - 2;
      if (s1 - s0 < 4) continue;
      const base = r.center.sub(s0, s1);
      const left = base.offset(-r.median / 2 + 0.2).points();
      const rightP = base.offset(r.median / 2 - 0.2).points();
      const poly = [...left, ...rightP.reverse()];
      walk.setColor(0x9a978f);
      walk.walls(poly, -0.02, Y_WALK, true, 0.5, 0.5, signedArea(poly) > 0 ? 1 : -1);
      walk.setColor(0xffffff);
      grass.polygon(simplifyClosed(offsetClosed(poly, signedArea(poly) > 0 ? 0.4 : -0.4)), Y_WALK + 0.01, 0.06);
      walk.polygon(poly, Y_WALK, 0.25);
    }
    const mk = (g: GeoBuilder, m: THREE.Material, color: boolean): void => {
      if (g.empty) return;
      const mesh = new THREE.Mesh(g.build(color), m);
      mesh.receiveShadow = this.quality.shadows;
      this.group.add(mesh);
      this.blockMeshes.push(mesh);
    };
    mk(walk, this.mats.sidewalk, true);
    mk(grass, this.mats.grass, false);
    mk(plaza, this.mats.plaza, false);
    mk(parking, this.mats.parking, false);
  }

  // ---------------------------------------------------------------------------
  // buildings

  buildBuildings(): void {
    for (const m of this.buildingMeshes) {
      this.group.remove(m);
      m.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      });
    }
    this.buildingMeshes = [];
    const walls: GeoBuilder[] = [];
    for (let i = 0; i < FACADE_COUNT; i++) walls.push(new GeoBuilder());
    const roofs = new GeoBuilder();
    const tiles = new GeoBuilder();
    const plain = new GeoBuilder();
    const dirt = new GeoBuilder();
    const scaffold = new GeoBuilder();
    const rng = new RNG(4242);
    for (const b of this.city.buildings) {
      if (b.day > this.day + 1) continue;
      if (b.day === this.day + 1) {
        // construction site for tomorrow
        const corners = footprint(b, 0.8);
        dirt.polygon(corners, Y_WALK + 0.02, 0.2);
        const h = Math.min(b.h * 0.45, 24);
        scaffold.box(b.x, Y_WALK, b.y, b.w * 0.9, h, b.d * 0.9, b.ux, b.uy);
        if (b.w > 18) {
          // tower crane
          plain.setColor(0xe0a526);
          const cx = b.x + b.uy * b.d * 0.6;
          const cy = b.y - b.ux * b.d * 0.6;
          const mh = h + 18;
          plain.box(cx, 0, cy, 1.2, mh, 1.2, 1, 0);
          plain.box(cx + b.ux * 8, mh - 1, cy + b.uy * 8, 26, 1.0, 1.0, b.ux, b.uy);
          plain.setColor(0x777777);
          plain.box(cx - b.ux * 4, mh - 2.5, cy - b.uy * 4, 3, 2.5, 2, b.ux, b.uy);
        }
        continue;
      }
      const style = facadeStyle(b);
      const g = walls[style];
      g.setColor(b.color);
      const [tu, tv] = FACADE_TILE[style];
      const uOff = Math.floor(b.tier * 7) * 0.25;
      const pts = footprint(b, 0);
      // walls with facade UVs
      let u = uOff;
      for (let i = 0; i < 4; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % 4];
        const L = dist(p, q);
        const mx = (p.x + q.x) / 2 - b.x;
        const my = (p.y + q.y) / 2 - b.y;
        const ml = Math.hypot(mx, my) || 1;
        g.quad(p.x, Y_WALK, p.y, q.x, Y_WALK, q.y, q.x, b.h, q.y, p.x, b.h, p.y, mx / ml, 0, my / ml, u / tu, 0, (u + L) / tu, (b.h - Y_WALK) / tv);
        u += L;
      }
      if (b.roof === 'gable') {
        tiles.setColor(rng.pick([0xb5654a, 0x8f4a3a, 0x6b6560, 0x9a5b45, 0x5b4f4a]));
        const along = b.w >= b.d;
        const hx = along ? b.ux : -b.uy;
        const hy = along ? b.uy : b.ux;
        tiles.gable(b.x, b.h, b.y, along ? b.w : b.d, along ? b.d : b.w, Math.min(b.w, b.d) * 0.38, hx, hy, 0.45);
      } else {
        roofs.setColor(b.kind === 'hospital' ? 0xdddddd : 0xffffff);
        roofs.polygon(pts, b.h, 0.25);
        // parapet
        if (b.kind !== 'industrial') {
          plain.setColor(b.color, 0.85);
          const inner = offsetClosed(pts, signedArea(pts) > 0 ? 0.35 : -0.35);
          for (let i = 0; i < 4; i++) {
            const p = pts[i];
            const q = pts[(i + 1) % 4];
            const mx = (p.x + q.x) / 2;
            const my = (p.y + q.y) / 2;
            const L = dist(p, q);
            plain.box(mx, b.h, my, L, 0.7, 0.35, (q.x - p.x) / L, (q.y - p.y) / L);
          }
          void inner;
        }
        // rooftop details
        const area = b.w * b.d;
        if (area > 250 && b.kind !== 'hospital') {
          const n = Math.min(4, Math.floor(area / 300) + 1);
          for (let k = 0; k < n; k++) {
            const ox = rng.range(-0.3, 0.3) * b.w;
            const oy = rng.range(-0.3, 0.3) * b.d;
            const cx = b.x + b.ux * ox - b.uy * oy;
            const cy = b.y + b.uy * ox + b.ux * oy;
            plain.setColor(rng.pick([0x9a9a9a, 0xb0b0b0, 0x8a8f94]));
            plain.box(cx, b.h, cy, rng.range(2, 4), rng.range(1.2, 2.2), rng.range(1.5, 3), b.ux, b.uy);
          }
        }
        if (b.kind === 'tower' && b.floors > 20) {
          // crown / mechanical penthouse
          walls[style].setColor(b.color, 0.9);
          walls[style].box(b.x, b.h, b.y, b.w * 0.55, 6, b.d * 0.55, b.ux, b.uy, 0.08);
          plain.setColor(0x666666);
          plain.box(b.x, b.h + 6, b.y, 0.4, 10, 0.4, 1, 0);
        }
        if (b.kind === 'hospital') {
          plain.setColor(0xd23a32);
          plain.box(b.x, b.h + 0.02, b.y, 8, 0.08, 2.4, b.ux, b.uy);
          plain.box(b.x, b.h + 0.02, b.y, 2.4, 0.08, 8, b.ux, b.uy);
        }
      }
      if (b.kind === 'shop') {
        // awning / sign band over the shopfront
        plain.setColor(rng.pick([0xc0392b, 0x2e86c1, 0x27ae60, 0xd68910, 0x8e44ad, 0x34495e, 0xe74c3c]));
        const fx = b.x - b.uy * (b.d / 2 + 0.6);
        const fy = b.y + b.ux * (b.d / 2 + 0.6);
        // frontage faces the road: the side opposite to the inward normal
        const fx2 = b.x + b.uy * (b.d / 2 + 0.6);
        const fy2 = b.y - b.ux * (b.d / 2 + 0.6);
        const roadSide = this.nearerRoadSide(b, fx, fy, fx2, fy2);
        plain.box(roadSide.x, 3.2, roadSide.y, b.w * 0.92, 0.6, 1.2, b.ux, b.uy);
      }
      if (b.kind === 'fire') {
        plain.setColor(0xeeeeee);
        const fx = b.x - b.uy * (b.d / 2 + 0.05);
        const fy = b.y + b.ux * (b.d / 2 + 0.05);
        const fx2 = b.x + b.uy * (b.d / 2 + 0.05);
        const fy2 = b.y - b.ux * (b.d / 2 + 0.05);
        const s = this.nearerRoadSide(b, fx, fy, fx2, fy2);
        for (const o of [-0.25, 0.25]) plain.box(s.x + b.ux * o * b.w, Y_WALK, s.y + b.uy * o * b.w, b.w * 0.35, 4.2, 0.2, b.ux, b.uy);
      }
    }
    const mk = (g: GeoBuilder, m: THREE.Material, cast = true): void => {
      if (g.empty) return;
      const mesh = new THREE.Mesh(g.build(), m);
      mesh.castShadow = cast && this.quality.shadows;
      mesh.receiveShadow = this.quality.shadows;
      this.group.add(mesh);
      this.buildingMeshes.push(mesh);
    };
    walls.forEach((g, i) => mk(g, this.facadeMats[i]));
    mk(roofs, this.mats.roofFlat);
    mk(tiles, this.mats.roofTile);
    mk(plain, this.mats.plain);
    mk(dirt, this.mats.dirt, false);
    mk(scaffold, this.mats.scaffold);
  }

  private nearerRoadSide(b: Building, x1: number, y1: number, x2: number, y2: number): V2 {
    const r = b.road.center;
    const d1 = r.project(x1, y1).d;
    const d2 = r.project(x2, y2).d;
    return d1 < d2 ? { x: x1, y: y1 } : { x: x2, y: y2 };
  }

  setDay(day: number): void {
    if (day === this.day) return;
    this.day = day;
    this.buildBuildings();
  }

  // ---------------------------------------------------------------------------
  // roundabout islands

  buildIslands(): void {
    if (this.islandMesh) {
      this.group.remove(this.islandMesh);
      this.islandMesh.geometry.dispose();
      this.islandMesh = null;
    }
    const gb = new GeoBuilder();
    const cob = new GeoBuilder();
    for (const n of this.city.net.nodes) {
      if (!n.ra) continue;
      const ri = n.ra.ri;
      const apron = circlePoints(n.x, n.y, ri, 0.8);
      const grassR = Math.max(1, ri - 1.6);
      const inner = circlePoints(n.x, n.y, grassR, 0.8);
      cob.polygon(apron, 0.08, 0.25, [inner]);
      gb.setColor(0x9a978f);
      gb.walls(apron, 0, 0.08, true, 0.5, 0.5, signedArea(apron) > 0 ? 1 : -1);
      gb.walls(inner, 0.08, 0.32, true, 0.5, 0.5, signedArea(inner) > 0 ? 1 : -1);
      gb.setColor(0x6f9a4c);
      gb.polygon(inner, 0.32, 0.1);
      // central feature: a small monument / tree base
      gb.setColor(0xbdb6a8);
      gb.box(n.x, 0.32, n.y, 1.6, 1.4, 1.6, 1, 0);
      gb.setColor(0xd9d2c3);
      gb.box(n.x, 1.72, n.y, 0.6, 2.6, 0.6, 1, 0);
      // splitter islands on each arm
      for (const arm of n.arms) {
        const t0 = arm.trim - 0.5;
        const t1 = arm.trim + 7;
        const p0 = { x: n.x + arm.dir.x * t0, y: n.y + arm.dir.y * t0 };
        const lanesIn = arm.inLink?.lanes.length ?? 0;
        const lanesOut = arm.outLink?.lanes.length ?? 0;
        if (!lanesIn || !lanesOut) continue;
        // divider between in and out lanes
        const inLane = arm.inLink!.lanes[arm.inLink!.lanes.length - 1];
        const off = inLane.offset + (arm.atA ? 1 : -1) * 0;
        void off;
        const rr = right(arm.dir);
        // lateral position of the boundary between directions (relative to arm dir)
        const outLane = arm.outLink!.lanes[arm.outLink!.lanes.length - 1];
        const pIn = inLane.path.point(inLane.len - 1);
        const pOut = outLane.path.point(1);
        const mid = { x: (pIn.x + pOut.x) / 2, y: (pIn.y + pOut.y) / 2 };
        const lat = (mid.x - n.x) * rr.x + (mid.y - n.y) * rr.y;
        const wHalf = 0.9;
        const q = (t: number, w: number): V2 => ({ x: n.x + arm.dir.x * t + rr.x * (lat + w), y: n.y + arm.dir.y * t + rr.y * (lat + w) });
        const poly = [q(t0, -wHalf * 1.6), q(t0, wHalf * 1.6), q(t1, wHalf * 0.5), q(t1, -wHalf * 0.5)];
        void p0;
        gb.setColor(0xc9c5bd);
        gb.polygon(poly, Y_WALK, 0.2);
        gb.setColor(0x9a978f);
        gb.walls(poly, 0, Y_WALK, true, 0.5, 0.5, signedArea(poly) > 0 ? 1 : -1);
      }
    }
    if (gb.empty && cob.empty) return;
    const grp = new THREE.Group();
    if (!gb.empty) grp.add(new THREE.Mesh(gb.build(), this.mats.plain));
    if (!cob.empty) grp.add(new THREE.Mesh(cob.build(false), this.mats.cobble));
    grp.traverse((o) => {
      o.receiveShadow = this.quality.shadows;
      o.castShadow = this.quality.shadows;
    });
    this.islandMesh = grp as unknown as THREE.Mesh;
    this.group.add(grp);
  }

  // ---------------------------------------------------------------------------
  // vegetation

  private buildTrees(): void {
    const c = this.city;
    const rng = new RNG(99);
    const spots: { x: number; y: number; s: number; kind: number }[] = [];
    const dens = this.quality.trees;
    for (const b of c.blocks) {
      for (const t of b.trees) if (rng.next() < dens) spots.push({ x: t.x, y: t.y, s: rng.range(0.8, 1.35), kind: rng.chance(0.2) ? 1 : 0 });
    }
    // street trees along local streets and boulevard medians
    for (const r of c.net.roads) {
      if (r.a.gateway || r.b.gateway || r.bridge) continue;
      const s0 = r.armA.trim + 6;
      const s1 = r.length - r.armB.trim - 6;
      const p = { x: 0, y: 0, dx: 1, dy: 0 };
      const step = r.cls === 'local' ? 13 : 16;
      for (let s = s0; s < s1; s += step) {
        r.center.sample(s, p);
        const rx = -p.dy;
        const ry = p.dx;
        for (const side of [-1, 1]) {
          if (!rng.chance(r.cls === 'local' ? 0.7 * dens : 0.45 * dens)) continue;
          const off = (r.width / 2 + 1.3) * side;
          const x = p.x + rx * off;
          const y = p.y + ry * off;
          if (this.nearBuilding(x, y, 2.2)) continue;
          spots.push({ x, y, s: rng.range(0.75, 1.1), kind: 0 });
        }
        if (r.median > 2) spots.push({ x: p.x, y: p.y, s: rng.range(0.8, 1.1), kind: rng.chance(0.3) ? 1 : 0 });
      }
    }
    // forest / countryside around the city
    const bx = c.bounds;
    const margin = 70;
    for (let i = 0; i < 2600 * dens; i++) {
      const x = rng.range(bx.minx - 700, bx.maxx + 700);
      const y = rng.range(bx.miny - 700, bx.maxy + 700);
      if (x > bx.minx - margin && x < bx.maxx + margin && y > bx.miny - margin && y < bx.maxy + margin) continue;
      if (c.river && y > c.river.yTop - 4 && y < c.river.yBot + 4) continue;
      // keep gateway roads clear
      let nearRoad = false;
      for (const g of c.gateways) {
        const a = g.arms[0];
        if (!a) continue;
        const o = a.other;
        const dx = g.x - o.x;
        const dy = g.y - o.y;
        const L = Math.hypot(dx, dy);
        const ux = dx / L;
        const uy = dy / L;
        const t = (x - o.x) * ux + (y - o.y) * uy;
        const lat = Math.abs(-(x - o.x) * uy + (y - o.y) * ux);
        if (t > 0 && lat < 14) nearRoad = true;
      }
      if (nearRoad) continue;
      spots.push({ x, y, s: rng.range(0.9, 1.6), kind: rng.chance(0.45) ? 1 : 0 });
    }
    const decid = treeGeometry(0);
    const conif = treeGeometry(1);
    for (const kind of [0, 1]) {
      const list = spots.filter((s) => s.kind === kind);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(kind === 0 ? decid : conif, this.mats.tree, list.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const col = new THREE.Color();
      list.forEach((t, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
        m.compose(new THREE.Vector3(t.x, Y_WALK, t.y), q, new THREE.Vector3(t.s, t.s * rng.range(0.9, 1.15), t.s));
        mesh.setMatrixAt(i, m);
        const tint = rng.range(0.75, 1.15);
        col.setRGB(tint * rng.range(0.9, 1.05), tint, tint * rng.range(0.85, 1.0));
        mesh.setColorAt(i, col);
      });
      mesh.castShadow = this.quality.shadows;
      mesh.receiveShadow = false;
      this.group.add(mesh);
    }
  }

  private buildingGrid: Map<string, Building[]> | null = null;

  private nearBuilding(x: number, y: number, r: number): boolean {
    if (!this.buildingGrid) {
      this.buildingGrid = new Map();
      for (const b of this.city.buildings) {
        const k = `${Math.floor(b.x / 40)},${Math.floor(b.y / 40)}`;
        let a = this.buildingGrid.get(k);
        if (!a) this.buildingGrid.set(k, (a = []));
        a.push(b);
      }
    }
    const gx = Math.floor(x / 40);
    const gy = Math.floor(y / 40);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const a = this.buildingGrid.get(`${gx + i},${gy + j}`);
        if (!a) continue;
        for (const b of a) {
          const dx = x - b.x;
          const dy = y - b.y;
          const lu = Math.abs(dx * b.ux + dy * b.uy);
          const lv = Math.abs(-dx * b.uy + dy * b.ux);
          if (lu < b.w / 2 + r && lv < b.d / 2 + r) return true;
        }
      }
    return false;
  }

  // ---------------------------------------------------------------------------
  // street lamps

  private buildLamps(): void {
    const c = this.city;
    const spots: { x: number; y: number; hx: number; hy: number }[] = [];
    const p = { x: 0, y: 0, dx: 1, dy: 0 };
    for (const r of c.net.roads) {
      if (r.a.gateway || r.b.gateway) continue;
      const s0 = r.armA.trim + 2;
      const s1 = r.length - r.armB.trim - 2;
      const step = r.cls === 'local' ? 30 : 26;
      let k = 0;
      for (let s = s0 + 4; s < s1; s += step, k++) {
        r.center.sample(s, p);
        const rx = -p.dy;
        const ry = p.dx;
        const side = r.cls === 'local' ? (k % 2 === 0 ? 1 : -1) : 0;
        const sides = side === 0 ? [-1, 1] : [side];
        for (const sd of sides) {
          const off = (r.width / 2 + 0.55) * sd;
          spots.push({ x: p.x + rx * off, y: p.y + ry * off, hx: -rx * sd, hy: -ry * sd });
        }
      }
    }
    const pole = new GeoBuilder();
    pole.setColor(0x3b3f45);
    pole.box(0, Y_WALK, 0, 0.22, 7.2, 0.22, 1, 0);
    pole.box(0.8, 7.0, 0, 1.8, 0.14, 0.14, 1, 0);
    const poleGeo = pole.build();
    const head = new GeoBuilder();
    head.setColor(0xffffff);
    head.box(1.6, 6.85, 0, 0.9, 0.18, 0.4, 1, 0);
    const headGeo = head.build();
    const poles = new THREE.InstancedMesh(poleGeo, this.mats.plain, spots.length);
    const heads = new THREE.InstancedMesh(headGeo, this.mats.lampHead, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    spots.forEach((s, i) => {
      q.setFromAxisAngle(up, -Math.atan2(s.hy, s.hx));
      m.compose(new THREE.Vector3(s.x, 0, s.y), q, new THREE.Vector3(1, 1, 1));
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
    });
    poles.castShadow = this.quality.shadows;
    this.group.add(poles, heads);
    this.lampHeads = heads;
    if (this.quality.lampGlow) {
      // light pools on the ground at night
      const g = new THREE.PlaneGeometry(13, 13);
      g.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex.glow,
        color: 0xffc47a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const pools = new THREE.InstancedMesh(g, mat, spots.length);
      spots.forEach((s, i) => {
        m.makeTranslation(s.x + s.hx * 1.6, 0.06, s.y + s.hy * 1.6);
        pools.setMatrixAt(i, m);
      });
      pools.renderOrder = 2;
      this.lampPools = pools;
      this.group.add(pools);
    }
  }

  private buildBusStops(): void {
    const gb = new GeoBuilder();
    for (const line of this.city.busLines) {
      for (const st of line.stops) {
        const lane = st.link.lanes[0];
        if (!lane) continue;
        const p = lane.path.sample(st.s, { x: 0, y: 0, dx: 1, dy: 0 });
        const rx = -p.dy;
        const ry = p.dx;
        const off = lane.width / 2 + 1.6;
        const x = p.x + rx * off;
        const y = p.y + ry * off;
        gb.setColor(0x3d4650);
        gb.box(x, Y_WALK, y, 4.2, 0.12, 1.6, p.dx, p.dy);
        gb.box(x, Y_WALK + 2.5, y, 4.4, 0.12, 1.8, p.dx, p.dy);
        gb.setColor(0x9fc3d9);
        gb.box(x + rx * 0.75, Y_WALK, y + ry * 0.75, 4.2, 2.5, 0.08, p.dx, p.dy);
        gb.setColor(line.color);
        gb.box(x - p.dx * 2.6, Y_WALK, y - p.dy * 2.6, 0.12, 3.0, 0.12, 1, 0);
        gb.box(x - p.dx * 2.6, Y_WALK + 2.6, y - p.dy * 2.6, 0.7, 0.7, 0.1, p.dx, p.dy);
      }
    }
    if (!gb.empty) this.add(new THREE.Mesh(gb.build(), this.mats.plain), true, true);
  }

  // ---------------------------------------------------------------------------
  // traffic signals and signs (rebuilt when junction controls change)

  buildSignals(): void {
    for (const ch of [...this.signalGroup.children]) {
      this.signalGroup.remove(ch);
      const mesh = ch as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this.heads = [];
    const gb = new GeoBuilder();
    const net = this.city.net;
    let lampCount = 0;
    interface LampPos {
      x: number;
      y: number;
      z: number;
      hx: number;
      hz: number;
    }
    const lamps: LampPos[] = [];
    for (const n of net.nodes) {
      if (n.gateway || n.arms.length < 3) continue;
      for (const arm of n.arms) {
        const inL = arm.inLink;
        if (!inL) continue;
        const lanes = inL.lanes;
        const curb = lanes[0];
        const e = curb.path.end();
        const d = curb.path.endDir();
        const rr = right(d);
        const poleOff = curb.width / 2 + 1.0;
        const px = e.x + rr.x * poleOff - d.x * 0.6;
        const py = e.y + rr.y * poleOff - d.y * 0.6;
        if (n.control === 'signal') {
          // pole + mast arm across the inbound lanes
          const span = poleOff + (lanes.length - 0.5) * curb.width;
          gb.setColor(0x3b3f45);
          gb.box(px, 0, py, 0.3, 6.4, 0.3, d.x, d.y);
          gb.box(px - rr.x * span * 0.5, 6.0, py - rr.y * span * 0.5, span, 0.22, 0.22, -rr.x, -rr.y);
          // one head per lane, facing approaching traffic (-d)
          for (const lane of lanes) {
            const le = lane.path.end();
            const hx = le.x - d.x * 0.6;
            const hy = le.y - d.y * 0.6;
            gb.setColor(0x1d1f22);
            gb.box(hx, 4.65, hy, 0.42, 1.35, 0.5, d.x, d.y);
            gb.setColor(0xe8c94a);
            gb.box(hx + d.x * 0.24, 4.6, hy + d.y * 0.24, 0.05, 1.45, 0.7, d.x, d.y);
            const conns = lane.outs.filter((c) => !(c as Conn).dead) as Conn[];
            const leftOnly = conns.length > 0 && conns.every((c) => c.turn === 'L' || c.turn === 'U');
            this.heads.push({ node: n, lane, conns, leftOnly, lampBase: lampCount });
            for (let k = 0; k < 3; k++) {
              lamps.push({ x: hx - d.x * 0.27, y: 5.12 - k * 0.43, z: hy - d.y * 0.27, hx: -d.x, hz: -d.y });
              lampCount++;
            }
          }
        } else {
          const stop = n.control === 'allstop' || (n.control === 'priority' && !n.majorRoads.has(arm.road.id) && n.stopMinor);
          const yieldSign = n.control === 'roundabout' || (n.control === 'priority' && !n.majorRoads.has(arm.road.id) && !n.stopMinor);
          if (!stop && !yieldSign) continue;
          gb.setColor(0x8e9399);
          gb.box(px, 0, py, 0.1, 2.6, 0.1, 1, 0);
          if (stop) {
            gb.setColor(0xc0261d);
            octagon(gb, px - d.x * 0.08, 2.55, py - d.y * 0.08, 0.42, -d.x, -d.y);
            gb.setColor(0xffffff);
            gb.box(px - d.x * 0.11, 2.52, py - d.y * 0.11, 0.02, 0.07, 0.5, -d.x, -d.y);
          } else {
            gb.setColor(0xffffff);
            triangleSign(gb, px - d.x * 0.08, 2.4, py - d.y * 0.08, 0.55, -d.x, -d.y);
            gb.setColor(0xc0261d);
            triangleSign(gb, px - d.x * 0.06, 2.4, py - d.y * 0.06, 0.7, -d.x, -d.y);
          }
        }
      }
    }
    if (!gb.empty) {
      const mesh = new THREE.Mesh(gb.build(), this.mats.plain);
      mesh.castShadow = this.quality.shadows;
      this.signalGroup.add(mesh);
    }
    if (lampCount > 0) {
      const g = new THREE.CircleGeometry(0.16, 10);
      const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
      const inst = new THREE.InstancedMesh(g, mat, lampCount);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const col = new THREE.Color(0, 0, 0);
      lamps.forEach((l, i) => {
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(l.hx, 0, l.hz));
        m.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, col);
      });
      this.signalLamps = inst;
      this.signalGroup.add(inst);
      // glowing stop-line bars: signal state readable from any zoom level
      const bg = new THREE.PlaneGeometry(1, 1);
      bg.rotateX(-Math.PI / 2);
      const bars = new THREE.InstancedMesh(
        bg,
        new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }),
        this.heads.length,
      );
      const up = new THREE.Vector3(0, 1, 0);
      this.heads.forEach((hd, i) => {
        const e = hd.lane.path.end();
        const d = hd.lane.path.endDir();
        q.setFromAxisAngle(up, -Math.atan2(d.y, d.x));
        m.compose(new THREE.Vector3(e.x - d.x * 0.9, 0.05, e.y - d.y * 0.9), q, new THREE.Vector3(1.1, 1, hd.lane.width * 0.86));
        bars.setMatrixAt(i, m);
        bars.setColorAt(i, col);
      });
      bars.renderOrder = 3;
      this.stopBars = bars;
      this.signalGroup.add(bars);
    } else {
      this.signalLamps = null;
      this.stopBars = null;
    }
  }

  /** update signal lamp colours, night lights */
  update(dt: number, night: number): void {
    this.blinkT += dt;
    const blinkOn = Math.floor(this.blinkT * 1.6) % 2 === 0;
    const inst = this.signalLamps;
    if (inst) {
      const col = new THREE.Color();
      const dim = 0.07;
      for (let hi = 0; hi < this.heads.length; hi++) {
        const h = this.heads[hi];
        let best = SIG_R;
        for (const c of h.conns) {
          if (c.sig === SIG_G) best = SIG_G;
          else if (c.sig === SIG_P && best !== SIG_G) best = SIG_P;
          else if (c.sig === SIG_Y && best === SIG_R) best = SIG_Y;
        }
        const red = best === SIG_R;
        const amber = best === SIG_Y || (h.leftOnly && best === SIG_P && blinkOn);
        const green = best === SIG_G || (best === SIG_P && !h.leftOnly);
        col.setRGB(red ? 3.2 : dim * 1.5, red ? 0.18 : dim * 0.2, red ? 0.12 : dim * 0.2);
        inst.setColorAt(h.lampBase, col);
        col.setRGB(amber ? 3.2 : dim * 1.5, amber ? 1.7 : dim, amber ? 0.1 : dim * 0.1);
        inst.setColorAt(h.lampBase + 1, col);
        col.setRGB(green ? 0.15 : dim * 0.3, green ? 3.0 : dim * 1.2, green ? 1.4 : dim * 0.8);
        inst.setColorAt(h.lampBase + 2, col);
        if (this.stopBars) {
          if (red) col.setRGB(1.0, 0.1, 0.08);
          else if (amber) col.setRGB(1.0, 0.62, 0.05);
          else col.setRGB(0.12, 0.95, 0.35);
          this.stopBars.setColorAt(hi, col);
        }
      }
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      if (this.stopBars?.instanceColor) this.stopBars.instanceColor.needsUpdate = true;
    }
    (this.mats.lampHead as THREE.MeshStandardMaterial).emissiveIntensity = night * 2.2;
    if (this.lampPools) (this.lampPools.material as THREE.MeshBasicMaterial).opacity = night * 0.55;
    for (const m of this.facadeMats) m.emissiveIntensity = night * 1.15;
    if (this.waterMat && this.waterMat.map) this.waterMat.map.offset.x = (this.waterMat.map.offset.x + dt * 0.004) % 1;
  }

  /** full refresh after a junction / road change */
  refresh(opts: { blocks?: boolean; roads?: boolean } = {}): void {
    if (opts.roads) this.buildRoads();
    if (opts.blocks) this.buildBlocks();
    this.buildMarkings();
    this.buildIslands();
    this.buildSignals();
  }
}

// ---------------------------------------------------------------------------
// helpers

function footprint(b: Building, grow: number): V2[] {
  const hw = b.w / 2 + grow;
  const hd = b.d / 2 + grow;
  const vx = -b.uy;
  const vy = b.ux;
  return [
    { x: b.x - b.ux * hw - vx * hd, y: b.y - b.uy * hw - vy * hd },
    { x: b.x + b.ux * hw - vx * hd, y: b.y + b.uy * hw - vy * hd },
    { x: b.x + b.ux * hw + vx * hd, y: b.y + b.uy * hw + vy * hd },
    { x: b.x - b.ux * hw + vx * hd, y: b.y - b.uy * hw + vy * hd },
  ];
}

function roadStrip(gb: GeoBuilder, pts: V2[], width: number, y: number): void {
  gb.ribbonWorldUV(pts, width, y, 0.1);
}

function treeGeometry(kind: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.setColor(0x5b4430);
  g.box(0, 0, 0, 0.35, 2.4, 0.35, 1, 0);
  const geoms: THREE.BufferGeometry[] = [g.build()];
  if (kind === 0) {
    const crowns: [number, number, number, number][] = [
      [0, 3.6, 0, 2.2],
      [0.7, 3.1, 0.4, 1.5],
      [-0.6, 3.3, -0.5, 1.6],
    ];
    for (const [x, y, z, r] of crowns) {
      const s = new THREE.IcosahedronGeometry(r, 1);
      s.scale(1, 0.85, 1);
      s.translate(x, y, z);
      paint(s, 0x4f7f3a);
      geoms.push(s.index ? s.toNonIndexed() : s);
    }
  } else {
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.ConeGeometry(1.9 - i * 0.45, 2.4, 7);
      cone.translate(0, 2.6 + i * 1.3, 0);
      paint(cone, 0x2f5d38);
      geoms.push(cone.index ? cone.toNonIndexed() : cone);
    }
  }
  return mergeGeoms(geoms);
}

function paint(g: THREE.BufferGeometry, hex: number): void {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = 0.85 + Math.random() * 0.3;
    arr[i * 3] = c.r * v;
    arr[i * 3 + 1] = c.g * v;
    arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

export function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    if (!g.attributes.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array as Float32Array, o * 3);
    else col.fill(1, o * 3, (o + n) * 3);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

function octagon(gb: GeoBuilder, x: number, y: number, z: number, r: number, nx: number, nz: number): void {
  // vertical octagon facing (nx, nz)
  const rx = -nz;
  const rz = nx;
  const c = gb.v(x, y, z, nx, 0, nz, 0.5, 0.5);
  const idx: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    idx.push(gb.v(x + rx * Math.cos(a) * r, y + Math.sin(a) * r, z + rz * Math.cos(a) * r, nx, 0, nz, 0, 0));
  }
  for (let i = 0; i < 8; i++) gb.tri(c, idx[i], idx[(i + 1) % 8], nx, 0, nz);
}

function triangleSign(gb: GeoBuilder, x: number, y: number, z: number, s: number, nx: number, nz: number): void {
  const rx = -nz;
  const rz = nx;
  const a = gb.v(x - rx * s * 0.5, y + s * 0.43, z - rz * s * 0.5, nx, 0, nz, 0, 0);
  const b = gb.v(x + rx * s * 0.5, y + s * 0.43, z + rz * s * 0.5, nx, 0, nz, 1, 0);
  const c = gb.v(x, y - s * 0.43, z, nx, 0, nz, 0.5, 1);
  gb.tri(a, b, c, nx, 0, nz);
}

/** painted arrow(s) on a lane at arc length s */
function arrowGlyph(gb: GeoBuilder, path: Path, s: number, mask: number): void {
  const p = path.sample(Math.max(0, s), { x: 0, y: 0, dx: 1, dy: 0 });
  const fx = p.dx;
  const fy = p.dy;
  const rx = -fy;
  const ry = fx;
  const P = (along: number, lat: number): V2 => ({ x: p.x + fx * along + rx * lat, y: p.y + fy * along + ry * lat });
  const shaft = (pts: V2[]): void => gb.ribbon(pts, 0.28, Y_MARK, 0, 1);
  const head = (tip: V2, dirx: number, diry: number): void => {
    const bx = tip.x - dirx * 1.3;
    const by = tip.y - diry * 1.3;
    const a = gb.v(bx - diry * 0.6, Y_MARK, by + dirx * 0.6, 0, 1, 0, 0, 0);
    const b = gb.v(bx + diry * 0.6, Y_MARK, by - dirx * 0.6, 0, 1, 0, 1, 0);
    const c = gb.v(tip.x, Y_MARK, tip.y, 0, 1, 0, 0.5, 1);
    gb.tri(a, b, c, 0, 1, 0);
  };
  const back = -2.4;
  if (mask & ARROW_S) {
    shaft([P(back, 0), P(1.3, 0)]);
    head(P(2.6, 0), fx, fy);
  }
  if (mask & ARROW_R) {
    shaft([P(back, 0), P(-0.2, 0), P(0.5, 0.35), P(0.7, 0.75)]);
    const tip = P(0.85, 1.75);
    head(tip, rx, ry);
  }
  if (mask & ARROW_L) {
    shaft([P(back, 0), P(-0.2, 0), P(0.5, -0.35), P(0.7, -0.75)]);
    const tip = P(0.85, -1.75);
    head(tip, -rx, -ry);
  }
  if (mask & ARROW_U) {
    shaft([P(back, 0), P(0.6, 0), P(1.1, -0.4), P(0.8, -0.9), P(-0.4, -1.0)]);
    head(P(-1.4, -1.0), -fx, -fy);
  }
}

/** yellow cross hatch inside a junction polygon */
function boxHatch(gb: GeoBuilder, poly: V2[], n: Node): void {
  // border
  const inset = simplifyClosed(offsetClosed(poly, signedArea(poly) > 0 ? 0.6 : -0.6), 0.1, 0.002);
  const closed = [...inset, inset[0]];
  gb.ribbon(closed, 0.2, Y_MARK + 0.002);
  // diagonals clipped to polygon
  const R = 40;
  for (const ang of [Math.PI / 4, -Math.PI / 4]) {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const nx = -dy;
    const ny = dx;
    for (let o = -R; o <= R; o += 2.6) {
      const a = { x: n.x + nx * o - dx * R, y: n.y + ny * o - dy * R };
      const b = { x: n.x + nx * o + dx * R, y: n.y + ny * o + dy * R };
      const ts: number[] = [];
      for (let i = 0; i < inset.length; i++) {
        const p = inset[i];
        const q = inset[(i + 1) % inset.length];
        const den = (b.x - a.x) * (q.y - p.y) - (b.y - a.y) * (q.x - p.x);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((p.x - a.x) * (q.y - p.y) - (p.y - a.y) * (q.x - p.x)) / den;
        const u = ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.sort((x, y) => x - y);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const p0 = { x: a.x + (b.x - a.x) * ts[i], y: a.y + (b.y - a.y) * ts[i] };
        const p1 = { x: a.x + (b.x - a.x) * ts[i + 1], y: a.y + (b.y - a.y) * ts[i + 1] };
        if (dist(p0, p1) > 0.8) gb.ribbon([p0, p1], 0.16, Y_MARK + 0.002);
      }
    }
  }
}

export { clamp, normAngle };
export type { Arm, Block, Road };
