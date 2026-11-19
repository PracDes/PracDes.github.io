import { AXIS_SIDES, Box, EPS, GROUP_THICK_AXIS, OPPOSITE, SIDE_AXIS, SIDE_NB, SIDES, sideMap } from './geom.js';
import { boxWalls, KIND, Part, Product } from './model.js';
import { catalogSizeLimits, cursorBox, previewBox } from './build.js';
import { findMaterial } from './material.js';
import { findNeighbors, opening } from './opora.js';
import { attachmentGap } from './krep.js';
import { constrainDelta, openingSizeLimits, partSizeLimits, resizeFaces } from './move.js';

export const ROOM_WALLS = { g: 'Задняя стена', l: 'Левая стена', r: 'Правая стена', f: 'Передняя стена' };
export const DEFAULT_WALL_COLOR = '#b9b6ae';
export const ROOM_DIMENSION = { x: 'W', y: 'H', z: 'G' };
const AXES = Object.keys(ROOM_DIMENSION);
const SILL_HEIGHT = 40;

export const roomItemSupported = ({ id }) => [KIND.ROOM_ELEMENT, KIND.POLKA, KIND.PEREG, KIND.ZAD].includes(id);
export const roomElementUsesWallColor = (element) => element.kind === KIND.ROOM_ELEMENT && (!element.tag || element.tag === 'Окно');
export const isRoomLamp = (element) => element?.tag === 'Лампочка';
export const windowSill = (room, element) => element.sillId && room.elements?.find((part) => part.id === element.sillId);
const SILL_TITLE = 'Подоконник';

export function roomMounts(element) {
  const mounts = {};
  if (element.wall) mounts[element.wall] = { supportId: element.supportId || 0, gap: 0 };
  if (element.windowId) mounts.t = { supportId: element.windowId, gap: 0 };
  return { ...mounts, ...element.attachments };
}

export function roomAxisFixed(element, axis) {
  const mounts = roomMounts(element);
  return AXIS_SIDES[axis].some((side) => mounts[side]);
}

export function roomItemSpec(db, item) {
  const title = item.name.trim();
  const tag = item.tag ?? '';
  if (item.id === KIND.ROOM_ELEMENT) {
    const wall = Object.keys(ROOM_WALLS).find((side) => title.includes(ROOM_WALLS[side]));
    const anchor = wall ?? (isRoomLamp(item) ? 't' : '');
    const dims = Object.fromEntries(AXES.map((axis) => [axis, Number(item[ROOM_DIMENSION[axis]]) || 0]));
    if (tag === 'Розетка') {
      const depth = SIDE_AXIS[anchor];
      const width = depth === 'x' ? 'z' : 'x';
      dims[width] += 8;
      dims.y = 68;
      dims[depth] = 0.9;
    }
    const spanAxis = item.group === 5 && !tag && !anchor && dims.x > 0
      ? AXES.find((axis) => !dims[axis] && AXES.every((other) => other === axis || dims[other] > 0)) : undefined;
    return { kind: item.id, title, tag, wall: anchor, dims, spanAxis, ...catalogSizeLimits(item) };
  }
  const axis = GROUP_THICK_AXIS[item.group];
  const thickness = Number(item[ROOM_DIMENSION[axis]]);
  const part = new Part({ kind: item.id, group: item.group, tag, max: { [axis]: thickness } });
  const row = item.kod ? db.get(item.kod) : findMaterial(db, {}, part);
  return row ? { kind: item.id, group: item.group, title, tag, wall: '', kod: row.kod, panel: item } : null;
}

export function roomElementBox(room, element, chain = new Set()) {
  const box = Object.assign(new Box(), element.box);
  if (chain.has(element.id)) return box;
  const mounts = roomMounts(element);
  chain.add(element.id);
  const limit = (side, low, axis) => {
    const mount = mounts[side];
    if (!mount) return null;
    const { supportId, gap } = mount;
    const target = supportId && room.elements?.find((item) => item.id === supportId);
    if (supportId && !target) return null;
    const surface = target ? roomElementBox(room, target, chain)[OPPOSITE[side]]
      : low ? 0 : room[ROOM_DIMENSION[axis]];
    return surface + (low ? gap : -gap);
  };
  for (const [axis, [lo, hi]] of Object.entries(AXIS_SIDES)) {
    const low = limit(lo, true, axis);
    const high = limit(hi, false, axis);
    if (low !== null && high !== null) { box[lo] = low; box[hi] = high; }
    else if (low !== null) box.moveSide(lo, low);
    else if (high !== null) box.moveSide(hi, high);
  }
  chain.delete(element.id);
  return box;
}

export function roomSillBox(room, element) {
  if (element.tag !== 'Окно' || !element.wall) return null;
  const box = roomElementBox(room, element);
  const across = SIDE_AXIS[element.wall] === 'x' ? 'z' : 'x';
  const [lo] = AXIS_SIDES[across];
  const extent = room[ROOM_DIMENSION[across]];
  box.setSize(across, Math.min(extent, box.size(across) + 60));
  box.moveSide(lo, Math.max(0, Math.min(extent - box.size(across), box[lo])));
  const depth = SIDE_AXIS[element.wall];
  const available = AXIS_SIDES[depth][0] === element.wall ? room[ROOM_DIMENSION[depth]] - box[element.wall] : box[element.wall];
  box.setSize(depth, Math.min(140, available), element.wall);
  box.t = box.b;
  box.b -= SILL_HEIGHT;
  return box;
}

export function addWindowSill(project, window) {
  const { room } = project;
  const box = roomSillBox(room, window);
  if (!box) return;
  window.sillId = project.newId();
  room.elements.push({ id: window.sillId, kind: KIND.ROOM_ELEMENT, title: SILL_TITLE, tag: '', wall: window.wall,
    supportId: window.supportId, windowId: window.id, wallColor: window.wallColor, box });
}

export function restoreWindowSills(project) {
  for (const window of project.room?.elements?.filter((element) => element.tag === 'Окно' && element.sillId == null) ?? []) {
    addWindowSill(project, window);
  }
}

export function roomWallSupport(room, element, box) {
  const { wall, supportId } = element;
  if (!supportId || element.windowId || (element.tag !== 'Окно' && element.title !== SILL_TITLE)) return supportId;
  const support = room.elements?.find((part) => part.id === supportId);
  if (!support) return supportId;
  const supportBox = roomElementBox(room, support);
  if (AXES.every((axis) => axis === SIDE_AXIS[wall] || box.overlaps(supportBox, axis))) return supportId;
  return undefined;
}

export function roomSillTouches(frame, sill) {
  return frame.overlaps(sill, 'x') && frame.overlaps(sill, 'z');
}

export function detachWindowSill(room, window, sill) {
  sill.box = roomElementBox(room, sill);
  sill.supportId = window.supportId;
  if (sill.attachments?.t?.supportId === window.id) sill.attachments.t = null;
  sill.windowId = 0;
  window.sillId = 0;
}

export function roomElementFits(room, element) {
  const box = roomElementBox(room, element);
  return AXES.every((axis) => {
    const [lo, hi] = AXIS_SIDES[axis];
    const sill = axis === 'y' && windowSill(room, element);
    const min = sill ? roomElementBox(room, sill).sy + (roomMounts(sill).t?.gap ?? 0) : 0;
    return box.size(axis) > 0 && box[lo] >= min - EPS && box[hi] <= room[ROOM_DIMENSION[axis]] + EPS;
  });
}

function roomSpan(boundary, point, dims, axis, bounds) {
  const box = cursorBox(point);
  for (const fixed of AXES.filter((key) => key !== axis)) {
    const [lo, hi] = AXIS_SIDES[fixed];
    if (dims[fixed] > bounds[hi] - bounds[lo] + EPS) return null;
    box.setSize(fixed, dims[fixed]);
    box.moveSide(lo, Math.max(bounds[lo], Math.min(bounds[hi] - dims[fixed], box[lo])));
  }
  const supportIds = findNeighbors(boundary, box);
  const limits = opening(boundary, supportIds);
  const [lo, hi] = AXIS_SIDES[axis];
  box[lo] = limits[lo];
  box[hi] = limits[hi];
  return box.size(axis) > EPS ? { box, supportIds: [supportIds[SIDE_NB[lo]], supportIds[SIDE_NB[hi]]] } : null;
}

function roomBoundary(room, skip) {
  const boundary = new Product(room);
  let id = -6;
  boundary.walls = boxWalls(room, () => id++);
  for (const existing of room.elements ?? []) {
    const box = roomElementBox(room, existing);
    if (skip(existing, box) || existing.tag === 'Заготовки креплений') continue;
    const mounts = roomMounts(existing);
    const mount = sideMap((side) => !!mounts[side]);
    boundary.parts.set(existing.id, new Part({ ...existing, box, mount }));
  }
  return boundary;
}

export function roomKrepContext(room, element, row) {
  const product = roomBoundary(room, () => false);
  const part = product.get(element.id);
  if (row?.t > 0) part.min[part.thickAxis] = part.max[part.thickAxis] = row.t;
  part.nb = findNeighbors(product, part.box, part.id);
  const mounts = roomMounts(element);
  for (const side of SIDES) {
    const mount = mounts[side];
    if (!mount) continue;
    const support = mount.supportId ? product.get(mount.supportId) : product.walls[side];
    if (support) part.nb[SIDE_NB[side]] = support.id;
  }
  return { product, part };
}

function dependsOn(room, element, id, seen = new Set()) {
  if (element.id === id) return true;
  if (seen.has(element.id)) return false;
  seen.add(element.id);
  return Object.values(roomMounts(element)).some((mount) => {
    const support = mount?.supportId && room.elements.find((candidate) => candidate.id === mount.supportId);
    return support && dependsOn(room, support, id, seen);
  });
}

function roomAttachment(box, side, support) {
  const axis = SIDE_AXIS[side];
  const delta = box[side] - support.box[OPPOSITE[side]];
  const gap = Math.max(0, side === AXIS_SIDES[axis][0] ? delta : -delta);
  return { supportId: Math.max(0, support.id), gap };
}

export function setRoomAttachmentKrep(db, element, side, kod) {
  const mount = roomMounts(element)[side];
  const gap = mount && attachmentGap(db, side, kod, mount.gap);
  const resized = !!mount && gap !== mount.gap;
  const changed = (element.krep?.[side] ?? 0) !== kod;
  if (resized) (element.attachments ??= {})[side] = { ...mount, gap };
  if (changed) (element.krep ??= {})[side] = kod;
  return resized || changed;
}

export function toggleRoomAttachment(room, element, side) {
  const box = roomElementBox(room, element);
  if (roomMounts(element)[side]) {
    if (side === 't' && element.windowId) {
      const window = room.elements.find((part) => part.id === element.windowId);
      if (window) detachWindowSill(room, window, element);
    }
    element.box = box;
    (element.attachments ??= {})[side] = null;
    if (element.krep && element.tag !== 'Розетка') element.krep[side] = 0;
    return true;
  }
  const boundary = roomBoundary(room, (part) => part === element || dependsOn(room, part, element.id));
  const support = boundary.get(findNeighbors(boundary, box)[SIDE_NB[side]]);
  if (!support) return false;
  element.box = box;
  (element.attachments ??= {})[side] = roomAttachment(box, side, support);
  if (side === 't' && element.title === SILL_TITLE) {
    const window = room.elements.find((part) => part.id === support.id && part.tag === 'Окно' && !part.sillId);
    if (window) { window.sillId = element.id; element.windowId = window.id; }
  }
  return true;
}

export function windowMoveBounds(room, element, box, sill, sillBox) {
  if (element.tag !== 'Окно' && element.title !== SILL_TITLE) return [];
  const boundary = roomBoundary(room, (part) => part === element || part === sill);
  const boxes = sill ? [box, sillBox] : [box];
  return boxes.map((box) => ({ box, bounds: opening(boundary, findNeighbors(boundary, box)) }));
}

export function roomDependentRange(db, room, element, axis, carriedSill, rootShift = [1, 1]) {
  const [lo, hi] = AXIS_SIDES[axis];
  const parts = new Map(room.elements.map((part) => [part.id, { part, mounts: roomMounts(part) }]));
  const shifts = new Map([[element.id, rootShift]]);
  if (carriedSill) shifts.set(carriedSill.id, [1, 1]);
  const motion = (id) => {
    if (shifts.has(id)) return shifts.get(id);
    const candidate = parts.get(id);
    if (!candidate) return [0, 0];
    const { mounts } = candidate;
    shifts.set(id, [0, 0]);
    const a = mounts[lo] ? motion(mounts[lo].supportId)[1] : undefined;
    const b = mounts[hi] ? motion(mounts[hi].supportId)[0] : undefined;
    const shift = [a ?? b ?? 0, b ?? a ?? 0];
    shifts.set(id, shift);
    return shift;
  };
  const range = { min: -Infinity, max: Infinity };
  for (const { part } of parts.values()) {
    if (part === element || part === carriedSill) continue;
    const [a, b] = motion(part.id);
    if (!a && !b) continue;
    const box = roomElementBox(room, part);
    if (a !== b) {
      const limits = openingSizeLimits(db, new Part(part), axis);
      constrainDelta(range, b - a, box.size(axis), limits.min, limits.max);
    }
    constrainDelta(range, a, box[lo]);
    constrainDelta(range, -b, room[ROOM_DIMENSION[axis]] - box[hi]);
  }
  return range;
}

export function resizedRoomElementBox(db, room, element, axis, size, keepHigh) {
  const [lo, hi] = AXIS_SIDES[axis];
  const mounts = roomMounts(element);
  const fixedLow = !!mounts[lo];
  const fixedHigh = !!mounts[hi];
  if (fixedLow && fixedHigh) return null;
  const box = roomElementBox(room, element);
  const { min, max } = partSizeLimits(db, new Part(element), axis);
  if (min > max) return null;
  const target = Math.min(max, Math.max(min, size));
  if (Math.abs(box.size(axis) - target) < EPS) return null;
  const sill = windowSill(room, element);
  const boundary = roomBoundary(room, (part) => part === sill || part.id === element.windowId);
  const bounds = opening(boundary, findNeighbors(boundary, box, element.id));
  const resized = { ...element, box };
  const layout = { ...room, elements: room.elements.map((part) => part === element ? resized : part) };
  const changed = resizeFaces(box, axis, target, { keepHigh, fixedLow, fixedHigh }, (side, requested, motion) => {
    const range = roomDependentRange(db, layout, resized, axis, false, motion);
    const min = Math.min(0, Math.max(range.min, side === lo ? bounds[lo] - box[lo] : -Infinity));
    const max = Math.max(0, Math.min(range.max, side === hi ? bounds[hi] - box[hi] : Infinity));
    box[side] += Math.max(min, Math.min(max, requested));
  });
  return changed ? box : null;
}

export function roomPlacementContext(room, point, spec) {
  const cursor = cursorBox(point);
  const boundary = roomBoundary(room, (_, box) => containsCursor(box, cursor));
  const supportIds = findNeighbors(boundary, cursor);
  const bounds = opening(boundary, supportIds);
  const span = spec?.spanAxis ? roomSpan(boundary, point, spec.dims, spec.spanAxis, bounds) : null;
  return { boundary, supportIds, bounds, span };
}

export function planRoomElement(room, spec, point, { boundary, supportIds, bounds, span } = roomPlacementContext(room, point, spec)) {
  const { panel, dims, spanAxis, ...element } = spec;
  if (spanAxis) return span && { ...element, box: span.box };
  if (panel) {
    const { box, valid, mount } = previewBox(boundary, panel, { ...point, supportIds });
    if (valid && (box.sz > 500 || panel.G)) {
      const rear = panel.G ? bounds.g : Math.max(bounds.g, box.g);
      const front = panel.G ? bounds.f : Math.min(bounds.f, box.f);
      const depth = Math.min(500, front - rear, box.sz);
      box.setSize('z', depth, 'g').moveSide('g', Math.max(rear, Math.min(front - depth, point.z - depth / 2)));
    }
    if (!valid) return null;
    const supports = findNeighbors(boundary, box);
    const attachments = Object.fromEntries(SIDES.filter((side) => mount[side]).map((side) =>
      [side, roomAttachment(box, side, boundary.get(supports[SIDE_NB[side]]))]));
    const planned = { ...element, box, attachments, ...catalogSizeLimits(panel) };
    planned.box = roomElementBox(room, planned);
    return roomElementFits(room, planned) ? planned : null;
  }
  const window = element.tag === 'Окно';
  const size = AXES.map((axis) => {
    const [lo, hi] = AXIS_SIDES[axis];
    const space = bounds[hi] - (window && axis === 'y' ? Math.max(SILL_HEIGHT, bounds[lo]) : bounds[lo]);
    return Math.min(dims[axis] || space, space);
  });
  if (size.some((value) => value <= 0)) return null;
  const box = Box.fromCenter(point.x, point.y, point.z, ...size);
  if (window) box.moveSide('b', bounds.b + 1200);
  if (element.tag === 'Проем' || !dims.y) box.moveSide('b', bounds.b);
  for (const axis of AXES) {
    const [lo, hi] = AXIS_SIDES[axis];
    const min = window && axis === 'y' ? Math.max(bounds[lo], SILL_HEIGHT) : bounds[lo];
    box.moveSide(lo, Math.max(min, Math.min(bounds[hi] - box.size(axis), box[lo])));
  }
  if (element.wall) {
    box.moveSide(element.wall, bounds[element.wall]);
    const supportId = supportIds[SIDE_NB[element.wall]];
    if (supportId > 0) element.supportId = supportId;
  }
  return { ...element, box };
}

const containsCursor = (box, cursor) => AXES.every((axis) => box.overlaps(cursor, axis));

export function roomCursorOverlaps(room, point) {
  const cursor = cursorBox(point);
  return room.elements?.some((element) => element.tag !== 'Заготовки креплений' && containsCursor(roomElementBox(room, element), cursor));
}

export function clampRoomOffset(room, element, axis, position) {
  const sill = axis === 'y' && windowSill(room, element);
  const min = sill ? roomElementBox(room, sill).sy + (roomMounts(sill).t?.gap ?? 0) : 0;
  return Math.max(min, Math.min(room[ROOM_DIMENSION[axis]] - element.box.size(axis), position));
}
