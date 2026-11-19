import { AXIS_SIDES, OPPOSITE, SIDES, SIDE_NB, SIDE_AXIS, EPS } from './geom.js';
import { KIND } from './model.js';
import { materialLimits } from './material.js';
import { opora } from './opora.js';
import { relayout, BuildError } from './build.js';
import { drawerWidthLimits } from './drawers.js';

export const DRAG_STEP = 10;
const AXES = ['x', 'y', 'z'];
const LONG = { x: new Set([6, 8, 16, 100, 102, 161]), y: new Set([7, 9, 16, 102, 161]) };
const UNLIMITED_OPENING = { x: new Set([6, 8, 16, 100, 101, 102, 161]), y: new Set([161]) };
const STILL = [0, 0];
const SHIFT = [1, 1];
const held = (part, side) => part.mount[side] || part.grab[side] !== -1;
const gap = (part, side) => part.grab[side] === -1 ? 0 : part.grab[side];

export function partSizeLimits(db, part, axis) {
  const { min, max } = materialLimits(db, part);
  return {
    min: Math.max(EPS, min[axis] ?? 0, part.min[axis] ?? 0),
    max: Math.min(max[axis] > 0 ? max[axis] : Infinity, part.max[axis] > 0 ? part.max[axis] : Infinity),
  };
}

export function openingSizeLimits(db, part, axis) {
  const { min, max } = partSizeLimits(db, part, axis);
  return { min: Math.max(1, min), max: UNLIMITED_OPENING[axis]?.has(part.kind) ? Infinity : max };
}

export function rootPart(product, part) {
  let p = part;
  while (p.parent && product.get(p.parent)) p = product.get(p.parent);
  return p;
}

export function centerHandle(product, handle, axis) {
  const assembly = product.get(handle.parent);
  if (!assembly) return false;
  const facade = assembly.data.drawer ? product.get(assembly.children[0])
    : assembly.children.map((id) => product.get(id)).find((part) =>
      part?.kind === KIND.ZAD && handle.box.cx >= part.box.l && handle.box.cx <= part.box.r);
  if (!facade) return false;
  const center = facade.box.center(axis);
  if (Math.abs(handle.box.center(axis) - center) < EPS) return false;
  handle.box.moveCenter(axis, center);
  if (assembly.data.drawer) (handle.data.centeredAxes ??= {})[axis] = true;
  return true;
}

export function canMove(product, part, axis) {
  if (part.parent || part.casper) return false;
  if (part.data.drawer) return axis === 'y';
  if (part.stenDver === -9) return true;
  if (part.stenDver !== -1) return false;
  const [lo, hi] = AXIS_SIDES[axis];
  return !part.mount[lo] && !part.mount[hi];
}

export function canResize(part, axis) {
  const [lo, hi] = AXIS_SIDES[axis];
  return !part.parent && !part.casper && !part.data.drawer && !(held(part, lo) && held(part, hi));
}

function* parallelSupports(product, part, axis) {
  for (const side of SIDES) {
    if (SIDE_AXIS[side] === axis || !held(part, side)) continue;
    const support = product.get(part.nb[SIDE_NB[side]]);
    if (support?.kind >= 6 && part.box.size(axis) <= support.box.size(axis) + EPS) yield support;
  }
}

function movement(product, root, axis, rootShift = SHIFT, resize = null) {
  const [lo, hi] = AXIS_SIDES[axis];
  const dependents = new Map();
  for (const part of product.realParts()) {
    if (part === root || (part.casper && !part.parent)) continue;
    const supports = part.parent ? [part.parent] : SIDES.filter((side) => held(part, side)).map((side) => part.nb[SIDE_NB[side]]);
    for (const id of new Set(supports)) {
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id).push(part);
    }
  }
  const shifts = new Map([[root.id, rootShift]]);
  const motion = (id) => shifts.get(id) ?? STILL;
  const travels = (id) => motion(id).every(Boolean);
  const axialStop = (part, side) => {
    const other = OPPOSITE[side];
    const support = product.get(part.nb[SIDE_NB[side]]) ?? product.walls[side];
    const direction = side === lo ? 1 : -1;
    return !motion(support.id)[side === lo ? 1 : 0]
      && direction * (part.box[side] - support.box[other]) <= gap(part, side) + EPS;
  };
  const displacement = (part) => {
    if (part.parent) return travels(part.parent) ? SHIFT : STILL;
    const low = held(part, lo);
    const high = held(part, hi);
    const a = low ? motion(part.nb[SIDE_NB[lo]])[1] : 0;
    const b = high ? motion(part.nb[SIDE_NB[hi]])[0] : 0;
    if (low && high) return [a, b];
    if (low || high) {
      if (!a && !b) return STILL;
      const free = low ? hi : lo;
      if (resize?.face === OPPOSITE[free] && part.box.size(axis) > partSizeLimits(resize.db, part, axis).min + EPS
        && axialStop(part, free)) return [a, b];
      return SHIFT;
    }
    return SIDES.some((side) => held(part, side) && travels(part.nb[SIDE_NB[side]])) ? SHIFT : STILL;
  };
  const followEdge = (part, base) => {
    if (!resize || part.parent || part.casper || part.data.drawer || part.stenDver !== -1) return base;
    const { face, db } = resize;
    const edge = face === lo ? 0 : 1;
    if (base[edge] || held(part, face)) return base;
    const atEdge = [...parallelSupports(product, part, axis)].some((support) =>
      motion(support.id)[edge] && Math.abs(part.box[face] - support.box[face]) < EPS);
    if (!atEdge) return base;
    const other = OPPOSITE[face];
    const { min } = partSizeLimits(db, part, axis);
    if (part.box.size(axis) > min + EPS) return face === lo ? [1, base[1]] : [base[0], 1];
    return held(part, other) ? base : SHIFT;
  };
  const pending = [root.id];
  for (const id of pending) {
    for (const part of dependents.get(id) ?? []) {
      const before = motion(part.id);
      const next = followEdge(part, displacement(part));
      const after = resize ? [Math.max(before[0], next[0]), Math.max(before[1], next[1])] : next;
      if (before[0] === after[0] && before[1] === after[1]) {
        if (resize && !shifts.has(part.id)) shifts.set(part.id, STILL);
        continue;
      }
      shifts.set(part.id, after);
      pending.push(part.id);
    }
  }
  return shifts;
}

export function constrainDelta(range, rate, value, min = 0, max = Infinity) {
  if (!rate) return;
  const lower = Math.min(0, min - value);
  const upper = Math.max(0, max - value);
  range.min = Math.max(range.min, rate > 0 ? lower : -upper);
  range.max = Math.min(range.max, rate > 0 ? upper : -lower);
}

function movementRange(db, product, axis, shifts, resized = null) {
  const [lo, hi] = AXIS_SIDES[axis];
  const range = { min: -Infinity, max: Infinity };
  for (const [id, [a, b]] of shifts) {
    const part = product.get(id);
    if (part.parent || part.casper) continue;
    const lower = product.get(part.nb[SIDE_NB[lo]]) ?? product.walls[lo];
    const upper = product.get(part.nb[SIDE_NB[hi]]) ?? product.walls[hi];
    const innerLow = lower.box[hi] + gap(part, lo);
    const innerHigh = upper.box[lo] - gap(part, hi);
    const before = shifts.get(lower.id)?.[1] ?? 0;
    const after = shifts.get(upper.id)?.[0] ?? 0;
    if (a !== b && part !== resized) {
      const full = held(part, lo) && held(part, hi);
      const size = part.data.drawer && axis === 'x' ? drawerWidthLimits(db, product, part)
        : full ? openingSizeLimits(db, part, axis) : partSizeLimits(db, part, axis);
      constrainDelta(range, b - a, full ? innerHigh - innerLow : part.box.size(axis), size.min, size.max);
    }
    const clearance = part.data.drawer ? 2 : 0;
    constrainDelta(range, a - before, part.box[lo] - innerLow, clearance);
    constrainDelta(range, after - b, innerHigh - part.box[hi], clearance);
    for (const holder of parallelSupports(product, part, axis)) {
      const [start, end] = shifts.get(holder.id) ?? STILL;
      constrainDelta(range, a - start, part.box[lo] - holder.box[lo]);
      constrainDelta(range, end - b, holder.box[hi] - part.box[hi]);
    }
  }
  return range;
}

export function moveRange(db, product, part, axis) {
  opora(product, part);
  const { min, max } = movementRange(db, product, axis, movement(product, part, axis));
  const start = part.box[AXIS_SIDES[axis][0]];
  return { min: start + min, max: start + max };
}

export function violations(product) {
  const out = [];
  for (const part of product.parts.values()) {
    if (part.kind < 6 || part.casper) continue;
    for (const axis of AXES) {
      const size = part.box.size(axis);
      const min = Math.max(part.min[axis], EPS);
      if (size < min - EPS) out.push({ part, axis, kind: 'min', limit: part.min[axis] });
      const max = part.max[axis];
      if (max > 0 && size > max + EPS && !LONG[axis]?.has(part.kind) && !part.parent) out.push({ part, axis, kind: 'max', limit: max });
    }
  }
  return out;
}

function snapshot(product) {
  return [...product.parts.values()].map((p) => [p, p.box.clone(), { ...p.nb }, p.kod, p.name, p.title]);
}

function rollback(saved) {
  for (const [p, box, nb, kod, name, title] of saved) Object.assign(p, { box, nb, kod, name, title });
}

function guarded(db, product, action) {
  const saved = snapshot(product);
  try {
    if (action() === false) return false;
    relayout(db, product);
    const [v] = violations(product);
    if (!v) return true;
    const what = v.kind === 'min' ? 'меньше минимального' : 'больше максимального';
    throw new BuildError(`Размер детали «${v.part.title || v.part.name}» станет ${what} (${v.limit} мм)`);
  } catch (error) {
    rollback(saved);
    relayout(db, product, { keepInvalidDrawers: true });
    throw error;
  }
}

function applyMovement(product, axis, shifts, delta) {
  const [lo, hi] = AXIS_SIDES[axis];
  for (const [id, [a, b]] of shifts) {
    const { box } = product.get(id);
    box[lo] += a * delta;
    box[hi] += b * delta;
  }
}

export function movePart(db, product, part, axis, lo) {
  if (!canMove(product, part, axis)) throw new BuildError('Деталь закреплена с двух сторон и по этой оси не двигается');
  opora(product, part);
  const [low] = AXIS_SIDES[axis];
  const shifts = movement(product, part, axis);
  const { min, max } = movementRange(db, product, axis, shifts);
  const delta = Math.max(min, Math.min(max, lo - part.box[low]));
  if (!Number.isFinite(delta) || Math.abs(delta) < EPS) return false;
  return guarded(db, product, () => applyMovement(product, axis, shifts, delta));
}

export function resizeFaces(box, axis, size, { keepHigh, fixedLow, fixedHigh }, shiftFace) {
  const [lo, hi] = AXIS_SIDES[axis];
  const face = fixedLow ? hi : fixedHigh || keepHigh ? lo : hi;
  const previous = box.size(axis);
  const adjust = (side) => {
    const delta = (side === lo ? -1 : 1) * (size - box.size(axis));
    if (Math.abs(delta) >= EPS) shiftFace(side, delta, side === lo ? [1, 0] : [0, 1]);
  };
  adjust(face);
  if (!fixedLow && !fixedHigh) adjust(OPPOSITE[face]);
  return Math.abs(box.size(axis) - previous) >= EPS;
}

export function resizePart(db, product, part, axis, size, keepHigh = false) {
  if (part.parent || part.casper || part.data.drawer) throw new BuildError('Размер составной детали задаётся её комплектом');
  if (!Number.isFinite(size)) return false;
  const [lo, hi] = AXIS_SIDES[axis];
  const fixedLow = held(part, lo);
  const fixedHigh = held(part, hi);
  if (fixedLow && fixedHigh) throw new BuildError('Деталь закреплена с двух сторон: размер определяется проёмом. Снимите крепление с одной стороны.');
  const { min, max } = partSizeLimits(db, part, axis);
  if (min > max) return false;
  const target = Math.min(max, Math.max(min, size));
  if (Math.abs(part.box.size(axis) - target) < EPS) return false;
  opora(product, part);
  return guarded(db, product, () => resizeFaces(part.box, axis, target, { keepHigh, fixedLow, fixedHigh }, (face, requested, motion) => {
    const resize = target < part.box.size(axis) ? { face, db } : null;
    let remaining = requested;
    while (Math.abs(remaining) >= EPS) {
      const shifts = movement(product, part, axis, motion, resize);
      const { min, max } = movementRange(db, product, axis, shifts, part);
      const delta = Math.max(Math.min(0, min), Math.min(Math.max(0, max), remaining));
      if (Math.abs(delta) < EPS) break;
      applyMovement(product, axis, shifts, delta);
      remaining -= delta;
    }
  }));
}

export function setGap(db, product, part, side, gap) {
  opora(product, part);
  const nb = product.get(part.nb[SIDE_NB[side]]);
  if (!nb) return false;
  const axis = SIDE_AXIS[side];
  const [lo, hi] = AXIS_SIDES[axis];
  const target = side === lo ? nb.box[hi] + gap : nb.box[lo] - gap - part.box.size(axis);
  return movePart(db, product, part, axis, target);
}
