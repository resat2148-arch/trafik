// Builds the internal structure of junctions: lane arrows, turning connectors,
// roundabout rings and the conflict zones between connectors.

import { Path } from '../core/path.ts';
import type { V2 } from '../core/math.ts';
import { angleOf, clamp, dist, lineIntersect, normAngle } from '../core/math.ts';
import {
  ARROW_L,
  ARROW_R,
  ARROW_S,
  ARROW_U,
  Conn,
  Lane,
  Link,
  Network,
  Node,
  Seg,
  classifyTurn,
  relTurnAngle,
  turnBit,
  turnRank,
} from './network.ts';
import type { Arm, Turn } from './network.ts';

const CONFLICT_DIST = 2.35;

interface Movement {
  arm: Arm;
  link: Link;
  turn: Turn;
  rel: number;
}

/** Lateral order of turns from curb to centre: R < S < L < U */
const lateralRank = (bit: number): number => (bit === ARROW_R ? 0 : bit === ARROW_S ? 1 : bit === ARROW_L ? 2 : 3);

export function movementsFor(n: Node, A: Arm): Movement[] {
  const moves: Movement[] = [];
  const inL = A.inLink;
  if (!inL) return moves;
  const inHeading = angleOf({ x: -A.dir.x, y: -A.dir.y });
  for (const B of n.arms) {
    if (B === A) continue;
    const outL = B.outLink;
    if (!outL || outL.closed) continue;
    const rel = relTurnAngle(inHeading, B.angle);
    moves.push({ arm: B, link: outL, turn: classifyTurn(inHeading, B.angle), rel });
  }
  // only one straight movement: the one closest to 0
  const straights = moves.filter((m) => m.turn === 'S');
  if (straights.length > 1) {
    straights.sort((a, b) => Math.abs(a.rel) - Math.abs(b.rel));
    for (let i = 1; i < straights.length; i++) straights[i].turn = straights[i].rel < 0 ? 'L' : 'R';
  }
  // only one movement of each turn type per side is labelled; extra lefts stay 'L'
  if (moves.length === 0) {
    // dead end for this approach: allow U-turn back
    const outL = A.outLink;
    if (outL) moves.push({ arm: A, link: outL, turn: 'U', rel: Math.PI });
  }
  return moves;
}

export function availableBits(moves: Movement[]): number {
  let b = 0;
  for (const m of moves) b |= turnBit(m.turn);
  return b;
}

/** Default lane arrows for an approach with n lanes given available turn bits. */
export function defaultArrows(n: number, avail: number): number[] {
  const hasL = (avail & ARROW_L) !== 0;
  const hasS = (avail & ARROW_S) !== 0;
  const hasR = (avail & ARROW_R) !== 0;
  const hasU = (avail & ARROW_U) !== 0;
  const out: number[] = new Array(n).fill(0);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = avail;
    return out;
  }
  if (!hasS) {
    if (hasL && hasR) {
      const half = Math.floor(n / 2);
      for (let i = 0; i < n; i++) out[i] = i < half ? ARROW_R : ARROW_L;
      if (n % 2 === 1) out[half] = ARROW_L | ARROW_R;
    } else {
      for (let i = 0; i < n; i++) out[i] = avail;
    }
  } else if (n === 2) {
    out[0] = ARROW_S | (hasR ? ARROW_R : 0);
    out[1] = ARROW_S | (hasL ? ARROW_L : 0);
  } else {
    for (let i = 0; i < n; i++) out[i] = ARROW_S;
    if (hasR) out[0] = ARROW_S | ARROW_R;
    if (hasL) out[n - 1] = ARROW_L;
  }
  if (hasU) out[n - 1] |= ARROW_U;
  return out;
}

export function arrowsValid(arr: number[], avail: number): boolean {
  let union = 0;
  for (const a of arr) {
    if (a === 0) return false;
    if ((a & ~avail) !== 0) return false;
    union |= a;
  }
  if (union === 0) return false;
  // no crossing: lanes nearer to the curb may not turn further left than lanes nearer the centre
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const maxI = maxRank(arr[i]);
      const minJ = minRank(arr[j]);
      if (maxI > minJ) return false;
    }
  }
  return true;
}

function maxRank(mask: number): number {
  let r = -1;
  for (const b of [ARROW_R, ARROW_S, ARROW_L, ARROW_U]) if (mask & b) r = Math.max(r, lateralRank(b));
  return r;
}

function minRank(mask: number): number {
  let r = 99;
  for (const b of [ARROW_R, ARROW_S, ARROW_L, ARROW_U]) if (mask & b) r = Math.min(r, lateralRank(b));
  return r;
}

/** Enumerate valid arrow combos for one lane given its neighbours (for UI cycling). */
export function arrowOptions(arr: number[], laneIdx: number, avail: number): number[] {
  const opts: number[] = [];
  const bits = [ARROW_L, ARROW_S, ARROW_R, ARROW_U].filter((b) => avail & b);
  const nb = bits.length;
  for (let m = 1; m < 1 << nb; m++) {
    let mask = 0;
    for (let i = 0; i < nb; i++) if (m & (1 << i)) mask |= bits[i];
    const test = arr.slice();
    test[laneIdx] = mask;
    if (arrowsValid(test, avail)) opts.push(mask);
  }
  return opts;
}

// ---------------------------------------------------------------------------

function connPath(p0: V2, d0: V2, p3: V2, d3: V2, uturn = false): Path {
  const D = dist(p0, p3);
  let k0: number;
  let k3: number;
  if (uturn) {
    k0 = k3 = Math.max(4, D * 0.9);
  } else {
    const hit = lineIntersect(p0, d0, p3, { x: -d3.x, y: -d3.y });
    if (hit && hit.t > 0.3 && hit.u > 0.3 && hit.t < D * 2.5 && hit.u < D * 2.5) {
      k0 = hit.t * 0.55;
      k3 = hit.u * 0.55;
    } else {
      k0 = k3 = D * 0.38;
    }
  }
  return Path.bezier(
    p0,
    { x: p0.x + d0.x * k0, y: p0.y + d0.y * k0 },
    { x: p3.x - d3.x * k3, y: p3.y - d3.y * k3 },
    p3,
    0.7,
  );
}

function curveSpeed(path: Path, aLat: number, cap: number): number {
  const r = path.minRadius();
  const v = Number.isFinite(r) ? Math.sqrt(aLat * r) : cap;
  return clamp(Math.min(v, cap), 2.5, 30);
}

function makeMoveConn(n: Node, from: Lane, to: Lane, turn: Turn, inArm: Arm, outArm: Arm): Conn {
  const path = connPath(from.path.end(), from.path.endDir(), to.path.start(), to.path.startDir(), turn === 'U');
  const cap = Math.min(from.vmax, to.vmax);
  const c = new Conn(n, turn === 'U' ? 'uturn' : 'move', path, turn === 'S' ? Math.min(cap, curveSpeed(path, 2.6, cap)) : curveSpeed(path, 2.2, cap));
  c.turn = turn;
  c.rank = turnRank(turn);
  c.fromLane = from;
  c.toLane = to;
  c.inArm = inArm;
  c.outArm = outArm;
  c.inHeading = angleOf(from.path.endDir());
  c.laneIndex = from.index;
  c.ins = [from];
  c.outs = [to];
  return c;
}

/** Remove this node's connectors from lanes and keep occupied ones alive as "dying". */
function detachConns(n: Node): void {
  for (const c of n.conns) {
    if (c.vehs.length > 0) {
      c.dead = true;
      n.dying.push(c);
    } else {
      c.dead = true;
    }
  }
  n.conns = [];
  for (const arm of n.arms) {
    const inL = arm.inLink;
    if (inL) {
      for (const lane of inL.lanes) {
        lane.moves.clear();
        lane.outs = [];
      }
    }
    const outL = arm.outLink;
    if (outL) {
      for (const lane of outL.lanes) lane.ins = lane.ins.filter((s) => !(s instanceof Conn && s.node === n));
    }
  }
}

export function buildJunction(net: Network, n: Node): void {
  detachConns(n);
  n.ra = null;
  n.stopQueue = [];
  if (n.gateway || n.arms.length < 2) {
    n.control = 'none';
  } else if (n.control === 'roundabout' && n.arms.length >= 3 && n.maxRoundaboutR >= 9) {
    buildRoundabout(n);
  } else {
    if (n.control === 'roundabout') n.control = 'priority';
    buildCrossing(n);
  }
  computeConflicts(n);
  computeSiblings(n);
  n.version++;
  net.version++;
}

function buildCrossing(n: Node): void {
  for (const A of n.arms) {
    const inL = A.inLink;
    if (!inL) continue;
    const moves = movementsFor(n, A);
    const avail = availableBits(moves);
    const cur = inL.lanes.map((l) => l.arrows & avail);
    if (!arrowsValid(cur, avail)) {
      const def = defaultArrows(inL.lanes.length, avail);
      inL.lanes.forEach((l, i) => (l.arrows = def[i]));
    } else {
      inL.lanes.forEach((l, i) => (l.arrows = cur[i]));
    }
    for (const m of moves) {
      const bit = turnBit(m.turn);
      const src = inL.lanes.filter((l) => (l.arrows & bit) !== 0);
      if (src.length === 0) continue; // movement banned
      const tgt = m.link.lanes;
      if (tgt.length === 0) continue;
      const k = src.length;
      const mCount = tgt.length;
      for (let j = 0; j < k; j++) {
        let ti: number;
        if (m.turn === 'R') ti = Math.min(j, mCount - 1);
        else if (m.turn === 'L' || m.turn === 'U') ti = Math.max(0, mCount - k + j);
        else ti = Math.min(j, mCount - 1);
        // general traffic prefers not to be dumped into a bus lane when another lane exists
        if (tgt[ti].busOnly && mCount > 1) ti = Math.min(ti + 1, mCount - 1);
        const from = src[j];
        const to = tgt[ti];
        const c = makeMoveConn(n, from, to, m.turn, A, m.arm);
        n.conns.push(c);
        from.outs.push(c);
        to.ins.push(c);
        from.moves.set(m.link.id, [c, to]);
      }
    }
  }
}

function ringTangent(phi: number): V2 {
  // circulation runs towards decreasing angle (counter-clockwise on screen)
  return { x: Math.sin(phi), y: -Math.cos(phi) };
}

function buildRoundabout(n: Node): void {
  const k = n.arms.length;
  const ro = n.maxRoundaboutR;
  const laneW = clamp(ro * 0.36, 4.6, 6.2);
  const rr = ro - laneW / 2;
  const ri = rr - laneW / 2;
  n.ra = { ro, rr, ri, laneW };
  const arms = n.arms;
  // entry / exit points sit well to the side of each arm so that the entry and
  // exit curves are gentle right turns (flared, tangential design)
  const delta: number[] = arms.map((a) => Math.asin(clamp((a.hw * 0.75 + 3.0) / rr, 0.25, 0.85)));
  // keep entry of arm i above exit of arm i-1
  for (let i = 0; i < k; i++) {
    const prev = (i - 1 + k) % k;
    let gap = arms[i].angle - arms[prev].angle;
    if (gap <= 0) gap += Math.PI * 2;
    const need = delta[i] + delta[prev] + 0.12;
    if (need > gap) {
      const s = (gap - 0.12) / (delta[i] + delta[prev]);
      delta[i] *= s;
      delta[prev] *= s;
    }
  }
  const exitAng = arms.map((a, i) => a.angle + delta[i]);
  const entryAng = arms.map((a, i) => a.angle - delta[i]);
  const ringV = clamp(Math.sqrt(3.0 * rr), 4, 9);
  const pt = (phi: number): V2 => ({ x: n.x + Math.cos(phi) * rr, y: n.y + Math.sin(phi) * rr });

  const inner: Conn[] = [];
  const between: Conn[] = [];
  for (let i = 0; i < k; i++) {
    const c = new Conn(n, 'ring', Path.arc(n.x, n.y, rr, exitAng[i], entryAng[i], 0.7), ringV);
    c.rank = 4;
    inner.push(c);
  }
  for (let i = 0; i < k; i++) {
    const prev = (i - 1 + k) % k;
    let end = exitAng[prev];
    while (end >= entryAng[i]) end -= Math.PI * 2;
    const c = new Conn(n, 'ring', Path.arc(n.x, n.y, rr, entryAng[i], end, 0.7), ringV);
    c.rank = 4;
    between.push(c);
  }
  for (let i = 0; i < k; i++) {
    const prev = (i - 1 + k) % k;
    inner[i].outs = [between[i]];
    between[i].ins.push(inner[i]);
    between[i].outs = [inner[prev]];
    inner[prev].ins.push(between[i]);
  }
  const exits: (Conn | null)[] = [];
  for (let i = 0; i < k; i++) {
    const A = arms[i];
    const outL = A.outLink;
    if (!outL || outL.closed) {
      exits.push(null);
      continue;
    }
    const to = outL.lanes[0];
    const p0 = pt(exitAng[i]);
    const path = connPath(p0, ringTangent(exitAng[i]), to.path.start(), to.path.startDir());
    const c = new Conn(n, 'exit', path, curveSpeed(path, 2.6, 10));
    c.toLane = to;
    c.outArm = A;
    c.rank = 4;
    c.outs = [to];
    to.ins.push(c);
    // the ring segment arriving at X_i is between[(i+1)%k]
    const arriving = between[(i + 1) % k];
    arriving.outs.push(c);
    c.ins = [arriving];
    exits.push(c);
  }
  const entries: Conn[][] = [];
  for (let i = 0; i < k; i++) {
    const A = arms[i];
    const inL = A.inLink;
    const list: Conn[] = [];
    if (inL) {
      for (const lane of inL.lanes) {
        lane.arrows = ARROW_L | ARROW_S | ARROW_R | ARROW_U;
        const p3 = pt(entryAng[i]);
        const path = connPath(lane.path.end(), lane.path.endDir(), p3, ringTangent(entryAng[i]));
        const c = new Conn(n, 'entry', path, curveSpeed(path, 2.4, 10));
        c.fromLane = lane;
        c.inArm = A;
        c.rank = 1 - lane.index * 0.1;
        c.laneIndex = lane.index;
        c.inHeading = angleOf(lane.path.endDir());
        c.ins = [lane];
        c.outs = [between[i]];
        between[i].ins.push(c);
        lane.outs.push(c);
        list.push(c);
      }
    }
    entries.push(list);
  }
  n.conns.push(...inner, ...between, ...(exits.filter((e) => e) as Conn[]));
  for (const l of entries) n.conns.push(...l);

  // movements
  for (let i = 0; i < k; i++) {
    const A = arms[i];
    const inL = A.inLink;
    if (!inL) continue;
    for (const ent of entries[i]) {
      const lane = ent.fromLane!;
      for (let j = 0; j < k; j++) {
        const ex = exits[j];
        if (!ex) continue;
        const seq: Seg[] = [ent, between[i]];
        let cur = (i - 1 + k) % k;
        let guard = 0;
        while (cur !== j && guard++ < k + 1) {
          seq.push(inner[cur], between[cur]);
          cur = (cur - 1 + k) % k;
        }
        seq.push(ex, ex.toLane!);
        lane.moves.set(arms[j].outLink!.id, seq);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// conflicts

interface Sampled {
  c: Conn;
  xs: Float64Array;
  ys: Float64Array;
  ss: Float64Array;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

function sampleConn(c: Conn, step = 0.5): Sampled {
  const n = Math.max(2, Math.ceil(c.len / step) + 1);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ss = new Float64Array(n);
  const pose = { x: 0, y: 0, dx: 0, dy: 0 };
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = (c.len * i) / (n - 1);
    c.path.sample(s, pose);
    xs[i] = pose.x;
    ys[i] = pose.y;
    ss[i] = s;
    if (pose.x < minx) minx = pose.x;
    if (pose.y < miny) miny = pose.y;
    if (pose.x > maxx) maxx = pose.x;
    if (pose.y > maxy) maxy = pose.y;
  }
  return { c, xs, ys, ss, minx, miny, maxx, maxy };
}

export function computeConflicts(n: Node): void {
  const all = [...n.conns, ...n.dying];
  for (const c of all) c.conflicts = [];
  const samples = all.map((c) => sampleConn(c));
  const D2 = CONFLICT_DIST * CONFLICT_DIST;
  for (let a = 0; a < samples.length; a++) {
    const A = samples[a];
    for (let b = a + 1; b < samples.length; b++) {
      const B = samples[b];
      const ca = A.c;
      const cb = B.c;
      if (ca.outs.includes(cb) || cb.outs.includes(ca)) continue;
      const sa = ca.path.start();
      const sb = cb.path.start();
      if (dist(sa, sb) < 0.6) continue; // diverging from the same point
      if (A.maxx + CONFLICT_DIST < B.minx || B.maxx + CONFLICT_DIST < A.minx) continue;
      if (A.maxy + CONFLICT_DIST < B.miny || B.maxy + CONFLICT_DIST < A.miny) continue;
      let aMin = Infinity;
      let aMax = -Infinity;
      let bMin = Infinity;
      let bMax = -Infinity;
      for (let i = 0; i < A.xs.length; i++) {
        const x = A.xs[i];
        const y = A.ys[i];
        for (let j = 0; j < B.xs.length; j++) {
          const dx = x - B.xs[j];
          const dy = y - B.ys[j];
          if (dx * dx + dy * dy < D2) {
            const s1 = A.ss[i];
            const s2 = B.ss[j];
            if (s1 < aMin) aMin = s1;
            if (s1 > aMax) aMax = s1;
            if (s2 < bMin) bMin = s2;
            if (s2 > bMax) bMax = s2;
          }
        }
      }
      if (aMin === Infinity) continue;
      const ea = ca.path.end();
      const eb = cb.path.end();
      const merge = dist(ea, eb) < 0.8;
      const ka = {
        other: cb,
        sIn: Math.max(0, aMin - 0.5),
        sOut: merge ? ca.len : Math.min(ca.len, aMax + 0.5),
        oIn: Math.max(0, bMin - 0.5),
        oOut: merge ? cb.len : Math.min(cb.len, bMax + 0.5),
        merge,
      };
      const kb = { other: ca, sIn: ka.oIn, sOut: ka.oOut, oIn: ka.sIn, oOut: ka.sOut, merge };
      ca.conflicts.push(ka);
      cb.conflicts.push(kb);
    }
  }
  for (const c of all) c.conflicts.sort((p, q) => p.sIn - q.sIn);
}

function computeSiblings(n: Node): void {
  const groups = new Map<Seg, Seg[]>();
  for (const c of n.conns) {
    const from = c.ins[0];
    if (!from) continue;
    let g = groups.get(from);
    if (!g) groups.set(from, (g = []));
    g.push(c);
  }
  for (const c of n.conns) c.siblings = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const c of g) c.siblings = g.filter((o) => o !== c);
  }
}

/** Remove dying connectors that have been vacated. */
export function cleanupDying(n: Node): void {
  if (n.dying.length === 0) return;
  const gone = n.dying.filter((c) => c.vehs.length === 0);
  if (gone.length === 0) return;
  n.dying = n.dying.filter((c) => c.vehs.length > 0);
  for (const c of n.conns) c.conflicts = c.conflicts.filter((k) => !gone.includes(k.other));
  for (const c of n.dying) c.conflicts = c.conflicts.filter((k) => !gone.includes(k.other));
}

/** Rebuild routing adjacency (which links can follow which). */
export function updateLinkNexts(net: Network): void {
  for (const l of net.links) {
    const set = new Set<number>();
    l.nexts = [];
    for (const lane of l.lanes) for (const id of lane.moves.keys()) set.add(id);
    for (const id of set) l.nexts.push(net.links[id]);
  }
}

/**
 * Network validity: all internal links must be mutually reachable, every entry
 * link from a gateway must reach the city and every exit link must be reachable.
 */
export function stronglyConnected(net: Network): boolean {
  const links = net.links.filter((l) => l.lanes.length > 0 && !l.closed);
  if (links.length === 0) return true;
  const idx = new Map<number, number>();
  links.forEach((l, i) => idx.set(l.id, i));
  const fwd: number[][] = links.map(() => []);
  const bwd: number[][] = links.map(() => []);
  links.forEach((l, i) => {
    for (const nx of l.nexts) {
      const j = idx.get(nx.id);
      if (j === undefined) continue;
      fwd[i].push(j);
      bwd[j].push(i);
    }
  });
  const internal: number[] = [];
  links.forEach((l, i) => {
    if (!l.from.gateway && !l.to.gateway) internal.push(i);
  });
  if (!internal.length) return true;
  const reach = (start: number, adj: number[][]): Uint8Array => {
    const seen = new Uint8Array(links.length);
    const st = [start];
    seen[start] = 1;
    while (st.length) {
      const u = st.pop()!;
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = 1;
          st.push(v);
        }
      }
    }
    return seen;
  };
  const s0 = internal[0];
  const f = reach(s0, fwd);
  const b = reach(s0, bwd);
  for (const i of internal) if (!f[i] || !b[i]) return false;
  // gateways: entries must lead into the strongly connected core, exits be reachable from it
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (l.from.gateway && !b[i]) {
      // entry link: must reach the core
      const r = reach(i, fwd);
      if (!r[s0]) return false;
    }
    if (l.to.gateway && !f[i]) return false;
  }
  return true;
}

export function normTurnAngle(a: number): number {
  return normAngle(a);
}
