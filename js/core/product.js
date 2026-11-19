import { buildCorpus, BuildError } from './build.js';
import { boxWalls } from './model.js';
import { AXIS_SIDES, Box, EPS } from './geom.js';
import { edgeFits, normFirma } from './material.js';
import { roomElementBox, roomMounts } from './room.js';
import { nearestOpening } from './opora.js';

export const SLOTS = [
  { key: 'left', role: 'PL', title: 'Левая боковина', pos: 7 },
  { key: 'right', role: 'PR', title: 'Правая боковина', pos: 7 },
  { key: 'floor', role: 'PB', title: 'Пол', pos: 6 },
  { key: 'roof', role: 'PT', title: 'Крыша', pos: 6 },
  { key: 'back', role: 'PG', title: 'Задняя стенка', pos: 16 },
];
export const FILL_SLOT = { key: 'fill', title: 'Наполнение', pos: 8 };
export const BACK_TYPES = ['Паз', 'Четверть', 'Накладная', 'Вкладная'];
export const FLOOR_TYPES = { nakl: 'Накладной пол', vkl: 'Вкладной пол', podium: 'Подиум', 'podium-legs': 'Подиум с кух. ножками' };
export const ROOF_TYPES = { nakl: 'Накладная крыша', vkl: 'Вкладная крыша', kepka: 'Крыша с кепкой (сзади и спереди)' };

const PLUG_KREP = /минификс|вровинт/;

export function isKit(row) { return row.unit === 'к-т' && !!row.sostav; }

export function slotMaterials(db, slot) {
  return db.byPos(slot.pos).filter((r) => r.group === 'ДСП-МДФ-ДВП' && r.unit === 'м2' && !isKit(r) && r.t > 0);
}

export function slotEdges(db, slot, materialRow) {
  if (!materialRow) return [];
  return db.edgesFor(slot.pos).filter((r) => (r.group ?? '').includes('Кромочный матерял') && edgeFits(r, materialRow.t));
}

export function commonMaterials(db) {
  return slotMaterials(db, SLOTS[0]).filter((row) => row.posSet.has(6) && row.posSet.has(8));
}

export function setCommonMaterial(form, kod) {
  form.material = { kod, edge: 0 };
  for (const { key } of SLOTS) {
    if (key !== 'back') Object.assign(form.parts[key], form.material);
  }
  Object.assign(form.fill, form.material);
}

export function krepTypes(db, corpus) {
  const seen = new Set();
  for (const r of db.krepFor(corpus ? 6 : 8)) {
    if (!(r.podrazdel ?? '').startsWith('В списк')) continue;
    if (corpus && r.razdel === 'Полкодержатель') continue;
    if (r.sub) seen.add(r.sub);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'ru'));
}

export function krepColors(db, type, corpus) {
  if (PLUG_KREP.test(type)) {
    return db.byPos(2222).filter((r) => r.razdel === 'Заглушки').map((r) => ({ kod: r.kod, color: r.color ?? '', plug: true }));
  }
  return db.krepFor(corpus ? 6 : 8).filter((r) => r.sub === type).map((r) => ({ kod: r.kod, color: r.color ?? '', plug: false }));
}

export function defaultForm(db) {
  const material = commonMaterials(db).find((row) => row.t === 16 && row.dop === 'ДСП' &&
    normFirma(row.firma) === 'ЛАМАРТИ' && row.color === 'Береза Мраморная');
  const first = (slot) => {
    const list = slotMaterials(db, slot);
    return (list.find((r) => r.t === 16 && r.dop === 'ДСП') ?? list[0])?.kod ?? 0;
  };
  const back = slotMaterials(db, SLOTS[4]);
  const types = krepTypes(db, true);
  const krep = types.find((t) => t === 'Экцентр. стяжка (минификс)') ?? types[0] ?? '';
  const zag = krepColors(db, krep, true)[0]?.kod ?? 0;
  const panel = (slot) => ({ on: true, kod: first(slot), edge: 0 });
  const form = {
    title: 'Корпусное изделие', W: 1500, H: 2200, G: 500, count: 1, x: null, y: 0, z: 0, angle: 0,
    podvesnoi: false, useKromE: true, floorType: 'nakl', roofType: 'nakl', kepkaFront: 20, kepkaBack: 0, backType: 0, otseki: 1,
    podiumHeight: 100, podiumLegHeight: 100, podiumLeft: false, podiumRight: false,
    parts: {
      left: panel(SLOTS[0]), right: panel(SLOTS[1]), floor: panel(SLOTS[2]), roof: panel(SLOTS[3]),
      back: { on: true, kod: (back.find((r) => r.t <= 4) ?? back[0])?.kod ?? 0, edge: 0 },
    },
    fill: { kod: first(FILL_SLOT), edge: 0 },
    krepKor: krep, krepNap: krep, zag1: zag, zag2: zag,
  };
  if (material) setCommonMaterial(form, material.kod);
  return form;
}

export function validateForm(db, form, room) {
  const errors = [];
  for (const k of ['W', 'H', 'G']) if (!(Number(form[k]) > 0)) { errors.push('Габариты изделия'); break; }
  if (room) {
    const bounds = productExtents(form);
    if (bounds.x > room.W + POSITION_EPS) errors.push(`Ширина изделия при выбранном повороте больше ширины комнаты (${room.W})`);
    if (form.H + (form.y || 0) > room.H) errors.push(`Высота изделия больше высоты комнаты (${room.H})`);
    if (bounds.z > room.G + POSITION_EPS) errors.push(`Глубина изделия при выбранном повороте больше глубины комнаты (${room.G})`);
  }
  for (const slot of SLOTS) {
    const p = form.parts[slot.key];
    if (p.on && !db.get(p.kod)) errors.push(slot.title);
  }
  if (!db.get(form.fill.kod)) errors.push('Материал наполнения');
  const back = form.parts.back;
  if (back.on) {
    if (!(form.backType in BACK_TYPES)) errors.push('Тип задней стенки');
    if (form.podvesnoi && (form.backType === 1 || form.backType === 2)) errors.push('Выбранный тип задней стенки нельзя использовать в подвесных изделиях');
    const row = db.get(back.kod);
    if (form.backType === 3 && row && row.t < 16) errors.push('Для вкладной задней стенки (минификсы) нужен материал не менее 16 мм');
  }
  if (form.podvesnoi && !back.on) errors.push('Подвесное изделие должно быть с задней стенкой');
  if (form.parts.roof.on && form.roofType === 'kepka') {
    const front = Number(form.kepkaFront);
    const back = Number(form.kepkaBack ?? 0);
    if (!(front >= 0 && back >= 0 && front + back < Number(form.G))) errors.push('Величина козырька накладной крыши');
  }
  if (form.parts.floor.on && ['podium', 'podium-legs'].includes(form.floorType)) {
    const height = Number((form.floorType === 'podium' ? form.podiumHeight : form.podiumLegHeight) ?? 100);
    const roof = form.parts.roof.on ? db.get(form.parts.roof.kod)?.t ?? 0 : 0;
    if (form.podvesnoi) errors.push('В подвесном изделии подиум недоступен');
    if (!(height >= 72 && height < Number(form.H) - roof)) errors.push('Высота подиума должна быть от 72 мм и ниже крыши');
  }
  if (!form.krepKor) errors.push('Крепление для корпуса');
  if (!form.krepNap) errors.push('Крепление для наполнения');
  if (!form.zag1) errors.push('Цвет креплений корпуса');
  if (!form.zag2) errors.push('Цвет креплений наполнения');
  return errors;
}

export function defaultFastenings(db, { krepKor, krepNap, zag1, zag2 }) {
  const color = (type, zag) => PLUG_KREP.test(type) ? '' : db.get(zag)?.color ?? '';
  return { krepKor, krepNap, zag1, zag2, krepCr1: color(krepKor, zag1), krepCr2: color(krepNap, zag2) };
}

export function productInit(db, form) {
  const fill = db.get(form.fill.kod);
  return {
    title: form.title, W: Number(form.W), H: Number(form.H), G: Number(form.G), angle: normalizeAngle(form.angle),
    count: Math.max(1, Number(form.count) || 1),
    podvesnoi: !!form.podvesnoi, useKromE: !!form.useKromE,
    ...defaultFastenings(db, form),
    nachColor: fill.color ?? '', firma: fill.firma ?? '', kromkaNap: form.fill.edge || 0,
    form: structuredClone({ ...form, material: form.material ?? form.parts.left }),
  };
}

const POSITION_EPS = 1e-7;
const ROOM_SIZE = { x: 'W', y: 'H', z: 'G' };
const ROOM_AXES = Object.keys(ROOM_SIZE);
const HORIZONTAL_AXES = ['x', 'z'];

export function normalizeAngle(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

function footprint(product) {
  const angle = normalizeAngle(product.angle);
  const rad = angle * Math.PI / 180;
  const cos = angle % 90 === 0 ? [1, 0, -1, 0][angle / 90] : Math.cos(rad);
  const sin = angle % 90 === 0 ? [0, 1, 0, -1][angle / 90] : Math.sin(rad);
  const u = { x: cos, z: sin };
  const v = { x: -sin, z: cos };
  const x = product.W / 2;
  const z = product.G / 2;
  const extents = { x: 2 * (Math.abs(cos) * x + Math.abs(sin) * z), y: Number(product.H),
    z: 2 * (Math.abs(sin) * x + Math.abs(cos) * z) };
  return { u, v, x, z, extents };
}

export function productExtents(product) {
  return footprint(product).extents;
}

export function productCenter(product) {
  const size = productExtents(product);
  return { x: product.x + size.x / 2, y: product.y + size.y / 2, z: product.z + size.z / 2 };
}

function productPositionBox(product) {
  const size = productExtents(product);
  const { x, y, z } = product;
  return new Box(x, x + size.x, y, y + size.y, z, z + size.z);
}

export function productPositionDetails(project, product, toObjects = false) {
  const { room } = project;
  const box = productPositionBox(product);
  if (!toObjects || product.through) return { box, bounds: new Box(0, room.W, 0, room.H, 0, room.G) };
  const candidates = [];
  for (const other of project.products) {
    if (other === product || other.through || (product.id && other.id === product.id)) continue;
    candidates.push({ box: productPositionBox(other) });
  }
  for (const obstacle of roomObstacles(room)) {
    candidates.push({ box: obstacle.box, mount: roomMounts(obstacle.element) });
  }
  return { box, bounds: nearestOpening(boxWalls(room, () => 0), candidates, box) };
}

export function resizeProductSpace(project, product, dimensions, sides) {
  const old = footprint(product);
  const sizes = Object.fromEntries(ROOM_AXES.map((axis) => [axis, Number(dimensions[ROOM_SIZE[axis]])]));
  const change = {};
  for (const axis of ROOM_AXES) {
    const size = sizes[axis];
    if (!Number.isFinite(size) || size <= 0) throw new BuildError('Габариты изделия должны быть больше нуля');
    const delta = size - product[ROOM_SIZE[axis]];
    if (Math.abs(delta) < EPS) continue;
    const [lo, hi] = AXIS_SIDES[axis];
    if (![lo, hi].includes(sides[axis])) throw new BuildError('Необходимо указать, какую сторону изделия следует передвинуть');
    change[axis] = { delta, low: sides[axis] === lo };
  }
  if (!Object.keys(change).length) return change;
  const offset = (axis) => change[axis] ? (change[axis].low ? -1 : 1) * change[axis].delta / 2 : 0;
  const center = productCenter(product);
  Object.assign(product, { W: sizes.x, H: sizes.y, G: sizes.z });
  const { extents } = footprint(product);
  product.x = center.x + offset('x') * old.u.x + offset('z') * old.v.x - extents.x / 2;
  product.y = center.y + offset('y') - extents.y / 2;
  product.z = center.z + offset('x') * old.u.z + offset('z') * old.v.z - extents.z / 2;
  const error = productPositionError(project, product);
  if (error) throw new BuildError(error);
  const walls = boxWalls(product, (side) => product.walls[side].id);
  for (const [side, wall] of Object.entries(walls)) product.walls[side].box = wall.box;
  return change;
}

export function nextSlotX(project, width) {
  let x = 0;
  for (const p of project.products) x = Math.max(x, p.x + productExtents(p).x);
  return project.room && x + width > project.room.W ? Math.max(0, project.room.W - width) : x;
}

export function productPosition(project, form, point, bounds = null) {
  const { room } = project;
  const size = productExtents(form);
  if (!room || (!form.through && ROOM_AXES.some((axis) => size[axis] > room[ROOM_SIZE[axis]] + POSITION_EPS))) return null;
  const clamp = (axis, pos) => {
    if (form.through) return pos;
    if (bounds) {
      const [lo, hi] = AXIS_SIDES[axis];
      pos = Math.min(bounds[hi] - size[axis], Math.max(bounds[lo], pos));
    }
    return Math.max(0, Math.min(room[ROOM_SIZE[axis]] - size[axis], pos));
  };
  return {
    x: clamp('x', point.x - size.x / 2),
    y: clamp('y', point.y ?? (Number(form.y) || 0)),
    z: clamp('z', point.z - size.z / 2),
  };
}

export function wallPosition(project, form) {
  const { room } = project;
  if (!room) return null;
  const corners = [[0, 0], [room.W, 0], [room.W, room.G], [0, room.G]];
  const wall = Math.round(normalizeAngle(form.angle) / 90) % 4;
  const [x, z] = corners[wall];
  return productPosition(project, form, { x, z });
}

function dot(a, b) { return a.x * b.x + a.z * b.z; }

function collisionRange(a, b, axis) {
  if (a.through || b.through) return null;
  const p = footprint(a);
  const q = footprint(b);
  const d = { x: a.x - b.x + (p.extents.x - q.extents.x) / 2, z: a.z - b.z + (p.extents.z - q.extents.z) / 2 };
  let lo = -Infinity;
  let hi = Infinity;
  const intersect = (offset, radius, speed) => {
    if (Math.abs(speed) < POSITION_EPS) return Math.abs(offset) + POSITION_EPS < radius;
    const first = (-radius - offset) / speed;
    const last = (radius - offset) / speed;
    lo = Math.max(lo, Math.min(first, last));
    hi = Math.min(hi, Math.max(first, last));
    return lo < hi;
  };
  const dy = a.y - b.y + (p.extents.y - q.extents.y) / 2;
  if (!intersect(dy, (p.extents.y + q.extents.y) / 2, Number(axis === 'y'))) return null;
  for (const dir of [p.u, p.v, q.u, q.v]) {
    const radius = (shape) => Math.abs(dot(shape.u, dir)) * shape.x + Math.abs(dot(shape.v, dir)) * shape.z;
    if (!intersect(dot(d, dir), radius(p) + radius(q), dir[axis] ?? 0)) return null;
  }
  return [lo, hi];
}

function* roomObstacles(room) {
  for (const element of room?.elements ?? []) {
    if (element.tag === 'Заготовки креплений' || element.tag === 'Камера') continue;
    const box = roomElementBox(room, element);
    if (box.sx > 0 && box.sy > 0 && box.sz > 0) {
      yield { x: box.l, y: box.b, z: box.g, W: box.sx, H: box.sy, G: box.sz, box, element };
    }
  }
}

export function productPositionError(project, product) {
  const { room } = project;
  const size = productExtents(product);
  if (room && ROOM_AXES.some((axis) => {
    const pos = product[axis];
    return !Number.isFinite(pos) || (!product.through && (pos < -POSITION_EPS || pos + size[axis] > room[ROOM_SIZE[axis]] + POSITION_EPS));
  })) return 'Изделие выходит за границы комнаты';
  if (project.products.some((other) => other !== product && (!product.id || other.id !== product.id) && collisionRange(product, other))) {
    return 'В этом месте изделие пересекается с другим изделием';
  }
  if (!product.through) {
    for (const obstacle of roomObstacles(room)) {
      if (collisionRange(product, obstacle)) return 'В этом месте изделие пересекается с элементом комнаты';
    }
  }
  return '';
}

export function moveProductInRoom(project, product, target) {
  const { room } = project;
  if (!room) return false;
  const size = productExtents(product);
  const obstacles = product.through ? [] : [...project.products, ...roomObstacles(room)];
  let moved = false;
  for (const axis of ROOM_AXES) {
    if (!Number.isFinite(target[axis])) continue;
    const from = product[axis];
    let min = product.through ? -Infinity : -from;
    let max = product.through ? Infinity : room[ROOM_SIZE[axis]] - size[axis] - from;
    for (const other of obstacles) {
      if (other === product) continue;
      const range = collisionRange(product, other, axis);
      if (!range) continue;
      const [lo, hi] = range;
      if (hi <= 0) min = Math.max(min, hi);
      else if (lo >= 0) max = Math.min(max, lo);
      else if (target[axis] - from < 0 && -lo > hi) min = Math.max(min, 0);
      else if (target[axis] - from > 0 && hi > -lo) max = Math.min(max, 0);
    }
    if (min > max) continue;
    const delta = Math.max(min, Math.min(max, target[axis] - from));
    if (Math.abs(delta) <= POSITION_EPS) continue;
    const next = from + delta;
    product[axis] = Math.abs(next - Math.round(next)) <= POSITION_EPS ? Math.round(next) : next;
    moved = true;
  }
  return moved;
}
export function createProduct(project, db, form, { through = false } = {}) {
  const errors = validateForm(db, form, through ? null : project.room);
  if (errors.length) throw new BuildError('Заданы не все позиции!\n\n' + errors.join('\n'));
  const init = productInit(db, form);
  const position = { ...init, through, x: form.x ?? nextSlotX(project, productExtents(init).x), y: Number(form.y) || 0, z: Number(form.z) || 0 };
  if (form.x != null) {
    const error = productPositionError(project, position);
    if (error) throw new BuildError(error);
  }
  const product = project.addProduct(position);
  try {
    buildCorpus(project, db, product, form);
  } catch (e) {
    project.removeProduct(product);
    throw e;
  }
  return product;
}
