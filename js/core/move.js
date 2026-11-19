import { AXIS_SIDES, OPPOSITE, SIDES, SIDE_NB, SIDE_AXIS, EPS } from './geom.js';
import { KIND } from './model.js';
import { materialLimits } from './material.js';
import { opora } from './opora.js';
import { fit, relayout, BuildError } from './build.js';

export const DRAG_STEP = 10;
const AXES = ['x', 'y', 'z'];
const LONG = { x: new Set([6, 8, 16, 100, 102, 161]), y: new Set([7, 9, 16, 102, 161]) };
const UNLIMITED_OPENING = { x: new Set([6, 8, 16, 100, 101, 102, 161]), y: new Set([161]) };
const STILL = [0, 0];
const SHIFT = [1, 1];
const held = (part, side) => part.mount[side] || part.grab[side] !== -1;
const gap = (part, side) => part.grab[side] === -1 ? 0 : part.grab[side];

export function openingSizeLimits(db, part, axis) {
  const { min, max } = materialLimits(db, part);
  const least = Math.max(1, min[axis] ?? 0, part.min[axis] ?? 0);
  const most = UNLIMITED_OPENING[axis]?.has(part.kind) ? Infinity
    : Math.min(max[axis] > 0 ? max[axis] : Infinity, part.max[axis] > 0 ? part.max[axis] : Infinity);
  return { min: least, max: most };
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
  return !part.parent && !part.casper && !part.data.drawer && !(part.mount[lo] && part.mount[hi]);
}

function movement(product, root, axis) {
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
  const shifts = new Map([[root.id, SHIFT]]);
  const motion = (id) => shifts.get(id) ?? STILL;
  const travels = (id) => motion(id).every(Boolean);
  const displacement = (part) => {
    if (part.parent) return travels(part.parent) ? SHIFT : STILL;
    const low = held(part, lo);
    const high = held(part, hi);
    const a = low ? motion(part.nb[SIDE_NB[lo]])[1] : 0;
    const b = high ? motion(part.nb[SIDE_NB[hi]])[0] : 0;
    if (low && high) return [a, b];
    if (low || high) return a || b ? SHIFT : STILL;
    return SIDES.some((side) => held(part, side) && travels(part.nb[SIDE_NB[side]])) ? SHIFT : STILL;
  };
  const pending = [root.id];
  for (const id of pending) {
    for (const part of dependents.get(id) ?? []) {
      const before = motion(part.id);
      const after = displacement(part);
      if (before[0] === after[0] && before[1] === after[1]) continue;
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

function movementRange(db, product, axis, shifts) {
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
    if (a !== b) {
      if (part.data.drawer) return { min: 0, max: 0 };
      const size = openingSizeLimits(db, part, axis);
      constrainDelta(range, b - a, innerHigh - innerLow, size.min, size.max);
    }
    const clearance = part.data.drawer ? 2 : 0;
    constrainDelta(range, a - before, part.box[lo] - innerLow, clearance);
    constrainDelta(range, after - b, innerHigh - part.box[hi], clearance);
    for (const side of SIDES) {
      if (SIDE_AXIS[side] === axis || !held(part, side)) continue;
      const holder = product.get(part.nb[SIDE_NB[side]]);
      if (!holder || holder.kind < 6 || part.box.size(axis) > holder.box.size(axis) + EPS) continue;
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
  return [...product.parts.values()].map((p) => [p, p.box.clone(), { ...p.nb }]);
}

function rollback(saved) {
  for (const [p, box, nb] of saved) { p.box = box; p.nb = nb; }
}

function guarded(db, product, action) {
  const saved = snapshot(product);
  action();
  relayout(db, product);
  const bad = violations(product);
  if (!bad.length) return;
  rollback(saved);
  relayout(db, product);
  const v = bad[0];
  const what = v.kind === 'min' ? 'меньше минимального' : 'больше максимального';
  throw new BuildError(`Размер детали «${v.part.title || v.part.name}» станет ${what} (${v.limit} мм)`);
}

export function movePart(db, product, part, axis, lo) {
  if (!canMove(product, part, axis)) throw new BuildError('Деталь закреплена с двух сторон и по этой оси не двигается');
  opora(product, part);
  const [low, high] = AXIS_SIDES[axis];
  const shifts = movement(product, part, axis);
  const { min, max } = movementRange(db, product, axis, shifts);
  const delta = Math.max(min, Math.min(max, lo - part.box[low]));
  if (!Number.isFinite(delta) || Math.abs(delta) < EPS) return false;
  guarded(db, product, () => {
    for (const [id, [a, b]] of shifts) {
      const { box } = product.get(id);
      box[low] += a * delta;
      box[high] += b * delta;
    }
  });
  return true;
}

export function resizePart(db, product, part, axis, size, keepHigh = false) {
  if (part.parent) throw new BuildError('Размер составной детали задаётся её комплектом');
  if (!(size > 0)) throw new BuildError('Размер должен быть больше нуля');
  const [lo, hi] = AXIS_SIDES[axis];
  if (part.mount[lo] && part.mount[hi]) throw new BuildError('Деталь закреплена с двух сторон: размер определяется проёмом. Снимите крепление с одной стороны.');
  if (Math.abs(part.box.size(axis) - size) < EPS) return false;
  const anchor = part.mount[hi] && !part.mount[lo] ? hi : part.mount[lo] ? lo : keepHigh ? hi : lo;
  guarded(db, product, () => {
    part.box.setSize(axis, size, anchor);
    fit(product, part);
  });
  return true;
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
