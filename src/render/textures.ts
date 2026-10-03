// Procedurally generated canvas textures (no external assets needed).

import * as THREE from 'three';
import { RNG } from '../core/rng.ts';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, rng: RNG, speckle = 0): void {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  // value noise at two scales
  const g1 = makeGrid(rng, 8);
  const g2 = makeGrid(rng, 32);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = sampleGrid(g1, 8, x / w, y / h) * 0.6 + sampleGrid(g2, 32, x / w, y / h) * 0.4;
      let v = (n - 0.5) * amp + (rng.next() - 0.5) * amp * 0.5;
      if (speckle && rng.next() < speckle) v += (rng.next() - 0.5) * amp * 3;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, base[0] + v));
      d[i + 1] = Math.max(0, Math.min(255, base[1] + v));
      d[i + 2] = Math.max(0, Math.min(255, base[2] + v));
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
}

function makeGrid(rng: RNG, n: number): Float32Array {
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  return g;
}

function sampleGrid(g: Float32Array, n: number, u: number, v: number): number {
  const x = u * n;
  const y = v * n;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const s = (a: number, b: number): number => g[((b % n + n) % n) * n + ((a % n + n) % n)];
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = s(x0, y0) * (1 - sx) + s(x0 + 1, y0) * sx;
  const b = s(x0, y0 + 1) * (1 - sx) + s(x0 + 1, y0 + 1) * sx;
  return a * (1 - sy) + b * sy;
}

export interface TextureSet {
  asphalt: THREE.Texture;
  sidewalk: THREE.Texture;
  grass: THREE.Texture;
  plaza: THREE.Texture;
  parking: THREE.Texture;
  roofFlat: THREE.Texture;
  roofTile: THREE.Texture;
  facades: THREE.Texture[]; // per style
  facadeLights: THREE.Texture[];
  glow: THREE.Texture;
  beam: THREE.Texture;
  water: THREE.Texture;
  blob: THREE.Texture;
  cobble: THREE.Texture;
  dirt: THREE.Texture;
}

export const FACADE = {
  house: 0,
  apartment: 1,
  office: 2,
  tower: 3,
  shop: 4,
  industrial: 5,
  civic: 6,
} as const;
export const FACADE_COUNT = 7;

/** world metres covered by one facade texture tile (u, v) */
export const FACADE_TILE: [number, number][] = [
  [12, 6.4], // house: 4 windows x 2 floors
  [12, 12.8], // apartment: 4 x 4 floors
  [12, 12.8], // office
  [12, 12.8], // tower
  [16, 8], // shop: shopfront + 1 floor
  [24, 10], // industrial
  [12, 13.6], // civic
];

export function makeTextures(): TextureSet {
  const rng = new RNG(77);
  // asphalt
  let [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [70, 71, 74], 16, rng, 0.04);
  // tar seams
  ctx.strokeStyle = 'rgba(30,30,32,0.35)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = rng.range(0, 256);
    let y = rng.range(0, 256);
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += rng.range(-30, 30);
      y += rng.range(-30, 30);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const asphalt = tex(c);

  // sidewalk: concrete slabs
  [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [178, 176, 170], 14, rng);
  ctx.strokeStyle = 'rgba(110,108,104,0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 64, 0);
    ctx.lineTo(i * 64, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * 64);
    ctx.lineTo(256, i * 64);
    ctx.stroke();
  }
  const sidewalk = tex(c);

  // grass
  [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [92, 128, 66], 30, rng, 0.06);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${rng.int(60, 110)},${rng.int(110, 160)},${rng.int(40, 80)},0.5)`;
    ctx.fillRect(rng.range(0, 256), rng.range(0, 256), 1.5, 3);
  }
  const grass = tex(c);

  // plaza paving
  [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [196, 186, 168], 12, rng);
  ctx.strokeStyle = 'rgba(140,128,110,0.6)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 32, 0);
    ctx.lineTo(i * 32, 256);
    ctx.stroke();
  }
  for (let j = 0; j <= 16; j++) {
    ctx.beginPath();
    ctx.moveTo(0, j * 16);
    ctx.lineTo(256, j * 16);
    ctx.stroke();
  }
  const plaza = tex(c);

  // parking lot with bay lines
  [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [82, 83, 86], 14, rng, 0.03);
  ctx.strokeStyle = 'rgba(235,235,230,0.85)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 32, 0);
    ctx.lineTo(i * 32, 100);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * 32, 156);
    ctx.lineTo(i * 32, 256);
    ctx.stroke();
  }
  const parking = tex(c);

  // flat roof gravel
  [c, ctx] = canvas(128, 128);
  noise(ctx, 128, 128, [120, 120, 118], 26, rng, 0.2);
  const roofFlat = tex(c);

  // roof tiles
  [c, ctx] = canvas(128, 128);
  noise(ctx, 128, 128, [150, 70, 52], 18, rng);
  ctx.strokeStyle = 'rgba(70,30,20,0.6)';
  for (let y = 0; y < 128; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(128, y);
    ctx.stroke();
  }
  const roofTile = tex(c);

  // cobblestone (roundabout apron)
  [c, ctx] = canvas(128, 128);
  noise(ctx, 128, 128, [150, 140, 128], 16, rng);
  ctx.strokeStyle = 'rgba(80,74,66,0.7)';
  for (let y = 0; y < 128; y += 10)
    for (let x = (y / 10) % 2 ? 0 : 7; x < 128; x += 14) ctx.strokeRect(x, y, 14, 10);
  const cobble = tex(c);

  // dirt (construction)
  [c, ctx] = canvas(128, 128);
  noise(ctx, 128, 128, [138, 112, 80], 30, rng, 0.1);
  const dirt = tex(c);

  // water
  [c, ctx] = canvas(256, 256);
  noise(ctx, 256, 256, [56, 104, 122], 22, rng);
  ctx.strokeStyle = 'rgba(200,230,240,0.18)';
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, 256);
    const y = rng.range(0, 256);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 8, y - 3, x + 18, y);
    ctx.stroke();
  }
  const water = tex(c);

  // facades
  const facades: THREE.Texture[] = [];
  const facadeLights: THREE.Texture[] = [];
  for (let s = 0; s < FACADE_COUNT; s++) {
    const [f, l] = facadeTexture(s, rng);
    facades.push(f);
    facadeLights.push(l);
  }

  // radial glow (street lamps, light pools)
  [c, ctx] = canvas(128, 128);
  let g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const glow = tex(c, false, false);

  // headlight beam: cone fading forward (texture v along beam)
  [c, ctx] = canvas(64, 128);
  for (let y = 0; y < 128; y++) {
    const t = y / 127;
    const width = 10 + t * 50;
    const alpha = Math.pow(1 - t, 1.6) * 0.9;
    const gr = ctx.createLinearGradient(32 - width / 2, 0, 32 + width / 2, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, y, 64, 1);
  }
  const beam = tex(c, false, false);

  // blob shadow
  [c, ctx] = canvas(64, 64);
  g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.45)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const blob = tex(c, false, false);

  return {
    asphalt,
    sidewalk,
    grass,
    plaza,
    parking,
    roofFlat,
    roofTile,
    facades,
    facadeLights,
    glow,
    beam,
    water,
    blob,
    cobble,
    dirt,
  };
}

/** facade + emissive night window texture for a building style */
function facadeTexture(style: number, rng: RNG): [THREE.Texture, THREE.Texture] {
  const W = 256;
  const H = style === FACADE.house ? 128 : style === FACADE.shop ? 128 : style === FACADE.industrial ? 128 : 256;
  const [c, ctx] = canvas(W, H);
  const [lc, lctx] = canvas(W, H);
  lctx.fillStyle = '#000';
  lctx.fillRect(0, 0, W, H);
  // base wall: light (tinted by vertex colour)
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, W, H);
  // subtle wall noise
  for (let i = 0; i < 2500; i++) {
    const v = rng.int(205, 250);
    ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.fillRect(rng.range(0, W), rng.range(0, H), 2, 2);
  }
  const lit = (x: number, y: number, w: number, h: number, p: number): void => {
    if (rng.next() < p) {
      const warm = rng.next();
      lctx.fillStyle = warm < 0.7 ? `rgb(255,${rng.int(190, 225)},${rng.int(120, 160)})` : `rgb(${rng.int(190, 230)},${rng.int(215, 240)},255)`;
      lctx.fillRect(x, y, w, h);
    }
  };
  const glass = (x: number, y: number, w: number, h: number, tint = 0): void => {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, tint ? '#4f6a80' : '#3b4a57');
    g.addColorStop(1, tint ? '#7d97ab' : '#58697a');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + 1, y + 1, w * 0.35, h - 2);
  };
  if (style === FACADE.house || style === FACADE.apartment || style === FACADE.civic) {
    const cols = 4;
    const rows = style === FACADE.house ? 2 : 4;
    const cw = W / cols;
    const rh = H / rows;
    for (let r = 0; r < rows; r++)
      for (let k = 0; k < cols; k++) {
        const x = k * cw + cw * 0.28;
        const y = r * rh + rh * 0.24;
        const w = cw * 0.44;
        const h = rh * 0.5;
        ctx.fillStyle = '#d0c8bc';
        ctx.fillRect(x - 3, y - 3, w + 6, h + 8);
        glass(x, y, w, h);
        ctx.fillStyle = 'rgba(240,240,235,0.9)';
        ctx.fillRect(x + w / 2 - 1, y, 2, h);
        if (style === FACADE.apartment && r > 0 && k % 2 === 0) {
          // balcony rail
          ctx.fillStyle = 'rgba(70,70,70,0.75)';
          ctx.fillRect(x - 6, y + h - 4, w + 12, 3);
        }
        lit(x, y, w, h, style === FACADE.house ? 0.5 : 0.45);
      }
    if (style === FACADE.house) {
      // door on ground floor
      ctx.fillStyle = '#6b4a33';
      ctx.fillRect(W * 0.08, H * 0.6, 22, H * 0.4);
    }
  } else if (style === FACADE.office || style === FACADE.tower) {
    // curtain wall with mullions
    const cols = style === FACADE.tower ? 8 : 6;
    const rows = 4;
    const cw = W / cols;
    const rh = H / rows;
    for (let r = 0; r < rows; r++)
      for (let k = 0; k < cols; k++) {
        const x = k * cw + 2;
        const y = r * rh + rh * 0.12;
        glass(x, y, cw - 4, rh * 0.8, style === FACADE.tower ? 1 : 0);
        lit(x, y, cw - 4, rh * 0.8, 0.35);
      }
    // spandrel bands
    ctx.fillStyle = 'rgba(200,205,210,0.9)';
    for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * rh - 3, W, 6);
  } else if (style === FACADE.shop) {
    // ground floor shop window, upper floor windows
    glass(8, H * 0.52, W - 16, H * 0.42, 1);
    lit(8, H * 0.52, W - 16, H * 0.42, 0.95);
    ctx.fillStyle = '#5a4636';
    ctx.fillRect(W * 0.44, H * 0.55, 26, H * 0.45);
    for (let k = 0; k < 4; k++) {
      const x = k * (W / 4) + 14;
      glass(x, H * 0.1, W / 4 - 28, H * 0.28);
      lit(x, H * 0.1, W / 4 - 28, H * 0.28, 0.5);
    }
  } else if (style === FACADE.industrial) {
    // corrugated panels and a band of high windows
    for (let x = 0; x < W; x += 6) {
      ctx.fillStyle = x % 12 === 0 ? 'rgba(160,160,160,0.5)' : 'rgba(255,255,255,0.25)';
      ctx.fillRect(x, 0, 3, H);
    }
    for (let k = 0; k < 6; k++) {
      glass(k * (W / 6) + 6, H * 0.12, W / 6 - 12, H * 0.16);
      lit(k * (W / 6) + 6, H * 0.12, W / 6 - 12, H * 0.16, 0.3);
    }
    ctx.fillStyle = '#7a7d80';
    ctx.fillRect(W * 0.3, H * 0.45, W * 0.32, H * 0.55);
  }
  return [tex(c), tex(lc)];
}

/** emoji / icon sprite texture */
export function iconTexture(text: string, size = 64, bg?: string): THREE.Texture {
  const [c, ctx] = canvas(size, size);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = `${Math.floor(size * 0.7)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + size * 0.04);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
