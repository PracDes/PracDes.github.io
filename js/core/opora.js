import { AXIS_SIDES, gt, lt } from './geom.js';

export const OPENING_SUPPORTS = ['x1', 'x2', 'y1', 'y2'];

const DIRS = [
  { axis: 'y', lo: 'b', hi: 't', nb1: 'y1', nb2: 'y2', cross: ['x', 'z'] },
  { axis: 'x', lo: 'l', hi: 'r', nb1: 'x1', nb2: 'x2', cross: ['y', 'z'] },
  { axis: 'z', lo: 'g', hi: 'f', nb1: 'z1', nb2: 'z2', cross: ['x', 'y'] },
];

function blocks(cand, side) {
  return !cand.mount?.[side] || cand.stenDver === -9;
}

const supportId = (part) => part.id;
const supportPart = (part) => part;

function nearestSupports(walls, candidates, box, selfId, select) {
  const nb = {};
  for (const d of DIRS) {
    let a1 = walls[d.lo];
    let a2 = walls[d.hi];
    for (const c of candidates) {
      if (!d.cross.every((axis) => box.overlaps(c.box, axis))) continue;
      if (selfId && d.axis === 'y' && (c.nb.x1 === selfId || c.nb.x2 === selfId)) continue;
      if (c.box.center(d.axis) <= box.center(d.axis)) {
        if (gt(c.box[d.hi], a1.box[d.hi]) && blocks(c, d.hi)) a1 = c;
      } else if (lt(c.box[d.lo], a2.box[d.lo]) && blocks(c, d.lo)) a2 = c;
    }
    nb[d.nb1] = select(a1);
    nb[d.nb2] = select(a2);
  }
  return nb;
}

export function findNeighbors(product, box, selfId = 0, filter = null) {
  const candidates = [];
  for (const p of product.parts.values()) {
    if (p.id === selfId || p.casper || p.kind === -1 || (selfId && p.parent === selfId)) continue;
    if (filter && !filter(p)) continue;
    candidates.push(p);
  }
  return nearestSupports(product.walls, candidates, box, selfId, supportId);
}

export function opora(product, part) {
  if (part.casper) return part.nb;
  part.nb = findNeighbors(product, part.box, part.id);
  return part.nb;
}

export function neighbors(product, nb) {
  return Object.fromEntries(Object.entries(nb).map(([k, id]) => [k, product.get(id)]));
}

export function opening(product, nb) {
  return openingFromSupports(neighbors(product, nb));
}

export function nearestOpening(walls, candidates, box) {
  return openingFromSupports(nearestSupports(walls, candidates, box, 0, supportPart));
}

function openingFromSupports(n) {
  return {
    l: n.x1.box.r, r: n.x2.box.l, b: n.y1.box.t, t: n.y2.box.b, g: n.z1.box.f, f: n.z2.box.g,
    get w() { return this.r - this.l; },
    get h() { return this.t - this.b; },
    get d() { return this.f - this.g; },
  };
}

export function centeredOffset(product, part, axis) {
  const [lo, hi] = AXIS_SIDES[axis];
  const bounds = opening(product, part.nb);
  return (bounds[lo] + bounds[hi] - part.box.size(axis)) / 2;
}
