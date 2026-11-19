import { AXIS_SIDES, OPPOSITE, SIDES, SIDE_NB, SIDE_AXIS, EPS } from './geom.js';
import { isFullyLocked, KIND } from './model.js';
import { frontEdgeInset, materialLimits } from './material.js';
import { opora } from './opora.js';
import { relayout, BuildError } from './build.js';
import { drawerWidthLimits } from './drawers.js';

export const DRAG_STEP = 10;
const AXES = ['x', 'y', 'z'];
const LONG = { x: new Set([6, 8, 16, 100, 102, 161]), y: new Set([7, 9, 16, 102, 161]) };
const UNLIMITED_OPENING = { x: new Set([6, 8, 16, 100, 101, 102, 161]), y: new Set([161]) };
const STILL = [0, 0];
const SHIFT = [1, 1];
const EDGE_SUPPORTS = new Set([KIND.POL, KIND.BOK, KIND.POLKA, KIND.PEREG, 101]);
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
  if (part.stenDver !== -1) return false;
  const [lo, hi] = AXIS_SIDES[axis];
  return !part.mount[lo] && !part.mount[hi];
}

export function canResize(part, axis) {
  const [lo, hi] = AXIS_SIDES[axis];
  return !part.parent && !part.casper && !part.data.drawer && (isFullyLocked(part) || !(held(part, lo) && held(part, hi)));
}

export function canSetGapDirectly(part, axis) {
  return Boolean(part && !part.parent && !part.casper && (!part.data.drawer || axis === 'y'));
}

function mountedFrontInset(product, part, support, side) {
  if (!part.mount[side] || held(part, 'f') || part.stenDver !== -1 || part.data.yglyb || part.parent) return 0;
  const { PL, PR, PT } = product.roles;
  if (part.id === PL || part.id === PR || part.id === PT) return 0;
  if (!EDGE_SUPPORTS.has(support.kind) || support.kind === 101) return 0;
  if (!EDGE_SUPPORTS.has(part.kind) && !(part.kind === KIND.ZAD && SIDE_AXIS[side] === 'y')) return 0;
  return frontEdgeInset(support);
}

function* parallelSupports(product, part, axis, withEdge) {
  if (part.stenDver === 0) return;
  for (const side of SIDES) {
    if (SIDE_AXIS[side] === axis || !held(part, side)) continue;
    const support = product.get(part.nb[SIDE_NB[side]]);
    if (!(support?.kind >= 6)) continue;
    const inset = withEdge && axis === 'z' ? mountedFrontInset(product, part, support, side) : 0;
    if (inset || part.box.size(axis) <= support.box.size(axis) + EPS) yield { support, inset };
  }
}

function dependentsOf(product) {
  const dependents = new Map();
  for (const part of product.realParts()) {
    if (part.casper && !part.parent) continue;
    const supports = part.parent ? [part.parent] : SIDES.filter((side) => held(part, side)).map((side) => part.nb[SIDE_NB[side]]);
    for (const id of new Set(supports)) {
      if (!dependents.has(id)) dependents.set(id, []);
      dependents.get(id).push(part);
    }
  }
  return dependents;
}

function movement(product, root, axis, rootShift = SHIFT, resize = null, dependents = dependentsOf(product)) {
  const [lo, hi] = AXIS_SIDES[axis];
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
    if (isFullyLocked(part)) return STILL;
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
    const atEdge = [...parallelSupports(product, part, axis, true)].some(({ support, inset }) =>
      motion(support.id)[edge] && (face === lo
        ? part.box[face] - support.box[face]
        : support.box[face] - inset - part.box[face]) <= EPS);
    if (!atEdge) return base;
    const other = OPPOSITE[face];
    const { min } = partSizeLimits(db, part, axis);
    if (part.box.size(axis) > min + EPS) return face === lo ? [1, base[1]] : [base[0], 1];
    return held(part, other) ? base : SHIFT;
  };
  const pending = [root.id];
  for (const id of pending) {
    for (const part of dependents.get(id) ?? []) {
      if (part === root) continue;
      const before = motion(part.id);
      const next = followEdge(part, displacement(part));
      const after = resize ? [Math.max(before[0], next[0]), Math.max(before[1], next[1])] : next;
      if (before[0] === after[0] && before[1] === after[1]) {
        if ((resize || isFullyLocked(part)) && !shifts.has(part.id)) shifts.set(part.id, STILL);
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
    const locked = isFullyLocked(part);
    const innerLow = lower.box[hi] + (locked ? 0 : gap(part, lo));
    const innerHigh = upper.box[lo] - (locked ? 0 : gap(part, hi));
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
    if (locked) continue;
    for (const { support, inset } of parallelSupports(product, part, axis, Boolean(resized))) {
      const [start, end] = shifts.get(support.id) ?? STILL;
      constrainDelta(range, a - start, part.box[lo] - support.box[lo]);
      constrainDelta(range, end - b, support.box[hi] - inset - part.box[hi]);
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
    if (part.kind < 6 || part.casper || isFullyLocked(part)) continue;
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

export function movePart(db, product, part, axis, lo, { manual = false } = {}) {
  if (!canMove(product, part, axis) && !(manual && isFullyLocked(part))) {
    throw new BuildError(isFullyLocked(part) ? 'Деталь заблокирована' : 'Деталь закреплена с двух сторон и по этой оси не двигается');
  }
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

function shiftResizeFace(db, product, part, axis, face, requested, motion, dependents) {
  const [lo] = AXIS_SIDES[axis];
  const resize = (face === lo ? requested > 0 : requested < 0) ? { face, db } : null;
  let remaining = requested;
  while (Math.abs(remaining) >= EPS) {
    const shifts = movement(product, part, axis, motion, resize, dependents);
    const { min, max } = movementRange(db, product, axis, shifts, part);
    const delta = Math.max(Math.min(0, min), Math.min(Math.max(0, max), remaining));
    if (Math.abs(delta) < EPS) break;
    applyMovement(product, axis, shifts, delta);
    remaining -= delta;
  }
  return Math.abs(requested - remaining) >= EPS;
}

function fitMountedFrontEdges(db, product, root, dependents) {
  const connected = new Set([root]);
  let changed = false;
  for (const part of connected) {
    for (const child of dependents.get(part.id) ?? []) connected.add(child);
    let front = part.box.f;
    for (const { support, inset } of parallelSupports(product, part, 'z', true)) {
      if (inset) front = Math.min(front, support.box.f - inset);
    }
    if (front >= part.box.f - EPS) continue;
    const limit = Math.max(front, part.box.g + partSizeLimits(db, part, 'z').min);
    if (limit < part.box.f - EPS) {
      changed = shiftResizeFace(db, product, part, 'z', 'f', limit - part.box.f, [0, 1], dependents) || changed;
    }
  }
  return changed;
}

function resizeLockedPart(product, part, axis, size, keepHigh) {
  const [lo, hi] = AXIS_SIDES[axis];
  const box = part.box.clone().setSize(axis, size, keepHigh ? hi : lo);
  const positionWithin = (lower, upper) => {
    if (lower && box[lo] < lower.box[hi]) box.moveSide(lo, lower.box[hi]);
    if (upper && box[hi] > upper.box[lo]) box.moveSide(hi, upper.box[lo]);
  };
  positionWithin(product.get(part.nb[SIDE_NB[lo]]), product.get(part.nb[SIDE_NB[hi]]));
  positionWithin(product.walls[lo], product.walls[hi]);
  if (!(box.size(axis) > 0 && Number.isFinite(box.size(axis)))) return false;
  if (Math.abs(box[lo] - part.box[lo]) < EPS && Math.abs(box[hi] - part.box[hi]) < EPS) return false;
  part.box = box;
  return true;
}

export function resizePart(db, product, part, axis, size, keepHigh = false) {
  if (part.parent || part.casper || part.data.drawer) throw new BuildError('Размер составной детали задаётся её комплектом');
  if (!Number.isFinite(size)) return false;
  const [lo, hi] = AXIS_SIDES[axis];
  if (isFullyLocked(part)) {
    if (!(size > 0)) return false;
    opora(product, part);
    return guarded(db, product, () => {
      if (!resizeLockedPart(product, part, axis, size, keepHigh)) return false;
      fitMountedFrontEdges(db, product, part, dependentsOf(product));
      return true;
    });
  }
  const fixedLow = held(part, lo);
  const fixedHigh = held(part, hi);
  if (fixedLow && fixedHigh) throw new BuildError('Деталь закреплена с двух сторон: размер определяется проёмом. Снимите крепление с одной стороны.');
  const { min, max } = partSizeLimits(db, part, axis);
  if (min > max) return false;
  const target = Math.min(max, Math.max(min, size));
  opora(product, part);
  const dependents = dependentsOf(product);
  return guarded(db, product, () => {
    const fitted = fitMountedFrontEdges(db, product, part, dependents);
    return resizeFaces(part.box, axis, target, { keepHigh, fixedLow, fixedHigh }, (face, requested, motion) => {
      shiftResizeFace(db, product, part, axis, face, requested, motion, dependents);
    }) || fitted;
  });
}

export function setGap(db, product, part, side, distance, { direct = false } = {}) {
  const axis = SIDE_AXIS[side];
  if (!axis || !Number.isFinite(distance) || (direct && !canSetGapDirectly(part, axis))) return false;
  opora(product, part);
  const nb = product.get(part.nb[SIDE_NB[side]]);
  if (!nb) return false;
  const [lo] = AXIS_SIDES[axis];
  const target = nb.box[OPPOSITE[side]] + (side === lo ? distance : -distance);
  if (!direct) return movePart(db, product, part, axis, target - (side === lo ? 0 : part.box.size(axis)), { manual: true });
  const delta = target - part.box[side];
  if (!Number.isFinite(target) || Math.abs(delta) < EPS) return false;
  const moving = part.data.drawer ? [part, ...part.children.map((id) => product.get(id)).filter(Boolean)] : [part];
  const boxes = moving.map((item) => item.box.clone().moveSide(side, item === part ? target : item.box[side] + delta));
  for (const box of boxes) {
    if (!Number.isFinite(box.size(axis)) || box.size(axis) <= 0) return false;
  }
  moving.forEach((item, i) => { item.box = boxes[i]; });
  for (const other of product.realParts()) opora(product, other);
  return true;
}
