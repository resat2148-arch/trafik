// Tiny DOM helpers and an inline SVG icon set.

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(inner: string, size = 24, vb = '0 0 24 24', cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = `ico ${cls}`;
  s.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return s;
}

export const ICON = {
  signal: '<rect x="8" y="2" width="8" height="16" rx="2.5" fill="currentColor" stroke="none" opacity=".25"/><rect x="8" y="2" width="8" height="16" rx="2.5"/><circle cx="12" cy="6" r="1.6" fill="#ff5a4e" stroke="none"/><circle cx="12" cy="10" r="1.6" fill="#ffc23a" stroke="none"/><circle cx="12" cy="14" r="1.6" fill="#3ee07a" stroke="none"/><path d="M12 18v4"/>',
  stop: '<path d="M8.5 2h7L22 8.5v7L15.5 22h-7L2 15.5v-7z" fill="#d63a2f" stroke="#fff" stroke-width="1.4"/><path d="M7 12h10" stroke="#fff" stroke-width="2.2"/>',
  yield: '<path d="M3 4h18L12 20z" fill="#fff" stroke="#d63a2f" stroke-width="2.4"/>',
  priority: '<path d="M12 2l10 10-10 10L2 12z" fill="#ffd23a" stroke="#fff" stroke-width="1.6"/><path d="M12 6l6 6-6 6-6-6z" fill="#ffd23a" stroke="#555" stroke-width="1"/>',
  roundabout: '<circle cx="12" cy="12" r="7"/><path d="M12 5a7 7 0 0 1 6.6 4.6" stroke="#3ee07a"/><path d="M17.5 7.6l1.2 2.1 2.1-1.2" stroke="#3ee07a"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>',
  grade: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 16l4-9 4 9M9.5 13h5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  fast: '<path d="M3 5l9 7-9 7z" fill="currentColor"/><path d="M12 5l9 7-9 7z" fill="currentColor"/>',
  faster: '<path d="M1 5l7 7-7 7z" fill="currentColor"/><path d="M8.5 5l7 7-7 7z" fill="currentColor"/><path d="M16 5l7 7-7 7z" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v.01M18 15v.01"/>',
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="8" cy="17" r="2" fill="currentColor"/><circle cx="16" cy="17" r="2" fill="currentColor"/><path d="M5 12h14"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 13l4-5"/><circle cx="12" cy="13" r="1.4" fill="currentColor"/>',
  star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" fill="currentColor"/>',
  warn: '<path d="M12 3l10 18H2z" fill="#ffb020" stroke="#fff" stroke-width="1.4"/><path d="M12 10v5M12 18v.01" stroke="#222"/>',
  tow: '<path d="M2 16h11V9h4l3 4v3h2"/><circle cx="6" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/><path d="M2 12l6-6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16"/><circle cx="8" cy="15" r="1" fill="currentColor"/><circle cx="16" cy="15" r="1" fill="currentColor"/><path d="M7 18v2M17 18v2"/>',
  policy: '<path d="M4 4h12l4 4v12H4z"/><path d="M8 10h8M8 14h8M8 18h5"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="1" stroke="#ffc23a"/><path d="M3 9l6-6M3 15L15 3M3 21L21 3M9 21l12-12M15 21l6-6" stroke="#ffc23a" stroke-width="1.4"/>',
  wave: '<path d="M2 12c3-6 6-6 9 0s6 6 9 0"/><circle cx="20" cy="12" r="1.6" fill="#3ee07a" stroke="none"/>',
  auto: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4.5" fill="#ffc23a" stroke="#ffc23a"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="#ffc23a"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="#cfd8ff" stroke="#cfd8ff"/>',
  rain: '<path d="M20 15a4 4 0 0 0-4-6 6 6 0 0 0-11.7 2A3.5 3.5 0 0 0 5 18h11"/><path d="M8 20l-1 2M12 20l-1 2M16 20l-1 2"/>',
  siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M4 18h16v3H4z" fill="currentColor"/><path d="M12 2v2M4 6l1.5 1.5M20 6l-1.5 1.5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  sound: '<path d="M11 5L6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4z" fill="currentColor"/><path d="M23 9l-6 6M17 9l6 6"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  city: '<path d="M3 21V9l6-3v15M9 21V3l8 4v14M17 21v-9l4 2v7M2 21h20"/>',
  play2: '<circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z" fill="currentColor"/>',
};

/** lane arrow glyph (mask bits: 1=L, 2=S, 4=R, 8=U) as an SVG string */
export function arrowSvg(mask: number, size = 26): string {
  const parts: string[] = [];
  const stroke = 'stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  if (mask & 2) parts.push(`<path d="M12 21V5" ${stroke}/><path d="M7.5 9.5L12 4.5l4.5 5" ${stroke}/>`);
  if (mask & 1) parts.push(`<path d="M12 21v-7a4 4 0 0 0-4-4H4.5" ${stroke}/><path d="M8 6.5L4.2 10 8 13.5" ${stroke}/>`);
  if (mask & 4) parts.push(`<path d="M12 21v-7a4 4 0 0 1 4-4h3.5" ${stroke}/><path d="M16 6.5l3.8 3.5-3.8 3.5" ${stroke}/>`);
  if (mask & 8) parts.push(`<path d="M14 21V9a4 4 0 0 0-8 0v6" ${stroke}/><path d="M3 12.5l3 3.5 3-3.5" ${stroke}/>`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${parts.join('')}</svg>`;
}

export function fmtSec(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function losColor(g: string): string {
  return g === 'A' ? '#2ecc71' : g === 'B' ? '#7bd84a' : g === 'C' ? '#d8d83a' : g === 'D' ? '#f0a030' : g === 'E' ? '#f06a30' : '#e8413a';
}
