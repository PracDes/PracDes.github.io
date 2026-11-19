import { Box, EPS, handleSize } from './geom.js';
import { isPanel, KIND } from './model.js';
import { neighbors, opora } from './opora.js';
import { placementNeighbors, relayout, BuildError } from './build.js';
import { findMaterial, materialLimits } from './material.js';

const HIDDEN_MOUNT = new Set(['Quadro V6+P2O', 'BOYARD P2O', 'BLUM TANDEM plus TIP-ON', 'BLUM TANDEM plus 19 мм TIP-ON', 'BLUM TANDEM F 19 мм TIP-ON',
  'BLUM TANDEM plus BLUMOTION', 'BLUM TANDEM plus 19 мм BLUMOTION', 'Silent System', 'Soft-Close скрытого монтажа Firmax 3D',
  'Push-to-Open скрытого монтажа Firmax 3D', 'ПВ скр.монт зам Push DTC']);
const WIDE_GAP = new Set(['Quadro V6+P2O', 'BOYARD P2O', 'BLUM TANDEM plus TIP-ON', 'BLUM TANDEM plus 19 мм TIP-ON',
  'BLUM TANDEM F 19 мм TIP-ON', 'Push-to-Open скрытого монтажа Firmax 3D', 'ПВ скр.монт зам Push DTC']);
const THIN_BOTTOM = new Set(['DB 4501ZN', 'Направляющая роликовая']);
const SIDE_AT_GUIDE = new Set(['Quadro V6+P2O', 'Silent System']);
const WITH_FRONT_WALL = new Set([...HIDDEN_MOUNT, 'ПВ скр.монт зам DTC', 'DB8881Zn']);
const SIDE_SHORTER_THAN_GUIDE = new Set([...WITH_FRONT_WALL, 'DB4461Zn']);
const HANDLELESS = new Set(['Quadro V6+P2O', 'BOYARD P2O', 'BLUM TANDEM plus TIP-ON',
  'BLUM TANDEM plus 19 мм TIP-ON', 'BLUM TANDEM F 19 мм TIP-ON',
  'Push-to-Open скрытого монтажа Firmax 3D', 'ПВ скр.монт зам Push DTC']);
const WIDTH_CLASSES = [
  { tags: ['DB4461Zn'], steps: [1400] },
  { tags: ['Soft-Close скрытого монтажа Firmax 3D', 'Push-to-Open скрытого монтажа Firmax 3D'], steps: [1200] },
  { tags: ['шариков', 'DB 4501ZN'], steps: [500, 700, 800, 900, 1200, 1400] },
  { tags: ['BLUM TANDEM plus TIP-ON', 'BLUM TANDEM plus BLUMOTION', 'BLUM TANDEM F 19 мм TIP-ON', 'BLUM TANDEM plus 19 мм TIP-ON', 'BLUM TANDEM plus 19 мм BLUMOTION', 'ПВ скр.монт зам Push DTC'], steps: [500, 700, 800, 900, 1200] },
  { tags: ['DB8881Zn', 'Направляющая роликовая', 'Quadro V6+P2O', 'BOYARD P2O', 'Silent System'], steps: [500, 700, 800, 900, 1000] },
  { tags: ['ПВ скр.монт зам DTC'], steps: [500, 700, 800, 900, 1000, 1200] },
];
const DEFAULT_STEPS = [500, 700, 800, 900];
const GUIDE_STEPS = [650, 600, 550, 500, 450, 400, 350, 300, 250];
const KREP_NONE = 26894;
const KREP_BOX_FRONT = 99295;
const KREP_BOTTOM_PAZ = 40406;
export const DRAWER_GAP = 2;
const GAP = DRAWER_GAP;
const SIDE_DROP = 50;
const BODY_LIFT = 15;
const BOTTOM_LIFT = 12;
const MIN_HEIGHT = 80.8;
const OVERLAY_FLUSH = 3;
const OVERLAY_REACH = 10;
const RECESSED_HANDLES = new Set([2482, 2483, 18728]);

export const DRAWER_KINDS = new Set([KIND.BOX_NAKL, KIND.BOX_VKL]);
export const drawerNeedsHandle = (item) => !HANDLELESS.has(item.tag);
export const automaticDrawerHeight = (item) => Number(item.MinH) === 33 && Number(item.H) === 33;
export const drawerHandleGap = (code) => code === 23277 ? 28 : RECESSED_HANDLES.has(code) ? 2 : 0;

export function drawerSupport(product, support) {
  for (let part = support; part; part = product.get(part.parent)) {
    if (part.hidden && part.data.drawer) return product.get(part.children[0]) ?? support;
  }
  return support;
}

export function drawerHandles(db) {
  return db.byPos(KIND.HANDLE).filter((row) => row.objTip !== 'Не для ящиков'
    && row.objTip !== 'Торцевая ручка 3' && row.name !== 'Без ручек');
}

function widthClass(tag, width) {
  const steps = WIDTH_CLASSES.find((c) => c.tags.includes(tag))?.steps ?? DEFAULT_STEPS;
  return steps.find((s) => width <= s) ?? steps.at(-1);
}

function real(p) { return p && p.kind >= 6; }

function panelRow(db, product, kind, thick, tag = '') {
  const probe = { kind, kod: 0, color: '', tag, catalogThickness: thick };
  return findMaterial(db, product, probe);
}

function guideSection(row = {}) {
  return { width: row.minH || row.maxH || row.h || 13, height: row.minT || row.maxT || row.t || 45 };
}

function drawerKit(db, kind, tag, width) {
  return db.byPos(kind).find((row) => row.name?.includes(tag) && row.maxW === widthClass(tag, width));
}

function drawerDepth(db, tag, back, front, requested) {
  const depth = front - back;
  const available = requested > 0 ? Math.min(depth, requested) : depth - (HIDDEN_MOUNT.has(tag) ? 18 : 5);
  const limit = GUIDE_STEPS.find((length) => length <= available + EPS);
  if (!limit) throw new BuildError(`Возникли проблемы при установке ящика :(\nДлина направляющей = ${Math.round(available)} мм`);
  const rows = db.byPos(KIND.GUIDE).filter((row) => row.name?.includes(tag) && GUIDE_STEPS.includes(row.minW || row.w));
  const guide = rows.filter((row) => (row.minW || row.w) <= limit)
    .reduce((best, row) => !best || (row.minW || row.w) > (best.minW || best.w) ? row : best, null);
  if (!guide) throw new BuildError(`Не найдено подходящей для глубины проёма направляющей!\nНеобходимая длина направляющей = ${limit} мм`);
  const len = guide.minW || guide.w;
  const sideDepth = SIDE_AT_GUIDE.has(tag) ? len : SIDE_SHORTER_THAN_GUIDE.has(tag) ? len - 10 : available;
  return { guide, len, sideDepth, ...guideSection(guide) };
}

function drawerFront(kind, nb, thickness, fronts) {
  const sides = [nb.x1, nb.x2].filter(real);
  if (kind === KIND.BOX_NAKL && sides.length) {
    const boundary = real(nb.z2) ? nb.z2.box.g - thickness : Infinity;
    return Math.min(boundary, ...sides.map((side) => fronts?.get(side.id) ?? side.box.f));
  }
  return Math.min(nb.z2.box.g, ...sides.map((side) => side.box.f)) - thickness;
}

function drawerOpening(kind, nb, thickness, fronts) {
  return {
    l: nb.x1.box.r, r: nb.x2.box.l,
    back: Math.max(nb.z1.box.f, nb.x1.box.g, nb.x2.box.g),
    front: drawerFront(kind, nb, thickness, fronts),
  };
}

export function drawerFacade(product, drawer) {
  return product.get(drawer.children[0]);
}

function facadeEdge(product, support, side, inner, box, drawer, overlays) {
  const left = side === 'l';
  const facing = left ? 'x2' : 'x1';
  const sign = left ? 1 : -1;
  let edge = inner + sign * GAP;
  if (!overlays) return edge;
  edge = support.box[side] + sign * GAP;
  for (const part of product.parts.values()) {
    if (part === drawer || part.nb[facing] !== support.id) continue;
    if (part.kind === KIND.BOX_NAKL && drawerFacade(product, part)?.box.overlaps(box, 'y')) {
      edge = left ? Math.max(edge, support.box.cx + 1) : Math.min(edge, support.box.cx - 1);
    }
    if (part.kind === KIND.DOOR_ZONE && part.box.overlaps(box, 'y')) {
      const doorEdge = part.box[left ? 'r' : 'l'];
      const reach = sign * (doorEdge - support.box.cx);
      if (reach < -EPS) continue;
      const limit = reach > EPS ? inner + sign : support.box.cx + sign;
      edge = left ? Math.max(edge, limit) : Math.min(edge, limit);
    }
  }
  return edge;
}

function overlaySupport(kind, side) {
  return kind === KIND.BOX_NAKL && isPanel(side) && !side.parent;
}

function setFacadeWidth(product, nb, box, drawer, kind, options = {}) {
  const overlays = (side, key) => overlaySupport(kind, side) && (side.stenDver !== -9 || options[key]);
  box.l = facadeEdge(product, nb.x1, 'l', nb.x1.box.r, box, drawer, overlays(nb.x1, 'left'));
  box.r = facadeEdge(product, nb.x2, 'r', nb.x2.box.l, box, drawer, overlays(nb.x2, 'right'));
}

const isLevel = (part) => [KIND.POL, KIND.POLKA].includes(part.kind) && part.group === 1 && !part.parent;
const freeFront = (part) => !part.mount.f && part.grab.f === -1;
const uncut = (part) => part.stenDver === -1 && freeFront(part) && !part.data.yglyb && !part.data.yglybBy?.length;

function prepareOpening(kind, nb, thickness, dygl, options) {
  const changes = new Map();
  const questions = {};
  const levels = { lower: nb.y1, upper: nb.y2 };
  if (kind !== KIND.BOX_NAKL) return { changes, questions, levels };
  const sides = [nb.x1, nb.x2].filter((part) => overlaySupport(kind, part));
  const adjustable = sides.filter(uncut);
  questions.cutSides = adjustable.length > 0;
  questions.left = sides.includes(nb.x1) && nb.x1.stenDver === -9;
  questions.right = sides.includes(nb.x2) && nb.x2.stenDver === -9;
  const trim = options.cutSides !== false;
  const align = Math.max(...sides.map((part) => part.box.f));
  const fixed = sides.filter((part) => !adjustable.includes(part));
  const boundary = real(nb.z2) ? nb.z2.box.g - thickness : Infinity;
  const target = Math.min(boundary, align - (trim ? thickness + dygl : 0), ...fixed.map((part) => part.box.f));
  for (const part of adjustable) changes.set(part.id, target);
  for (const part of fixed) if (part.data.yglybBy?.length) changes.set(part.id, part.box.f);
  const levelCuts = Object.values(levels).filter((part) => isLevel(part) && uncut(part)
    && Math.abs(part.box.f - nb.x1.box.f) < OVERLAY_FLUSH);
  questions.cutLevels = questions.cutSides && trim && levelCuts.length > 0;
  if (questions.cutLevels && options.cutLevels) {
    for (const part of levelCuts) changes.set(part.id, Math.min(part.box.f - thickness - dygl, target));
  }
  if (options.cutLevels) {
    for (const part of Object.values(levels)) {
      if (!changes.has(part.id) && part.data.yglybBy?.length) changes.set(part.id, part.box.f);
    }
  }
  return { changes, questions, levels };
}

export function drawerOverlayAmount(thickness, mode) {
  return mode === 'full' ? thickness : mode === 'half' && thickness ? thickness / 2 + 1 : 0;
}

export function drawerPreparationQuestions(db, product, item, point) {
  if (item.id !== KIND.BOX_NAKL) return {};
  const panel = panelRow(db, product, KIND.ZAD, 16);
  if (!panel) throw new BuildError('Для фасада ящика нет материала 16 мм в цвете наполнения');
  const nb = neighbors(product, placementNeighbors(product, point));
  return prepareOpening(item.id, nb, panel.t, WIDE_GAP.has(item.tag) ? 4 : GAP, point.drawerOptions ?? {}).questions;
}

function drawerHandleBox(facade, row) {
  const { sx, sy, sz } = handleSize(row, true);
  const edge = row.objTip === 'Торцевая ручка' || row.objTip === 'Торцевая ручка 2';
  if ((!edge && sx > facade.sx) || sy > facade.sy) return null;
  const y = edge || RECESSED_HANDLES.has(row.kod) ? facade.t - sy / 2 : facade.cy;
  const z = row.objTip === 'Торцевая ручка' ? facade.cz : facade.f + sz / 2;
  return Box.fromCenter(facade.cx, y, z, edge ? facade.sx : sx, sy, sz);
}

export function restoreDrawerGuides(db, product) {
  reflowDrawers(db, product, { keepInvalidDrawers: true });
}

function drawerBoxes({ b, l, r, bodyFront, len, gt, gh, t, sideDepth, bodyHeight, tag }, bottomThickness) {
  const gy = b + BODY_LIFT;
  const rear = bodyFront - sideDepth;
  const side = (x) => new Box(x, x + t, gy, gy + bodyHeight, rear, bodyFront);
  const guide = (x) => new Box(x, x + gt, gy, gy + gh, bodyFront - len, bodyFront);
  const left = side(l + gt);
  const right = side(r - gt - t);
  const frontWall = WITH_FRONT_WALL.has(tag);
  const back = new Box(left.r, right.l, gy, gy + bodyHeight, rear, rear + t);
  const frontZ = bodyFront - (frontWall ? t : 0);
  return {
    'Левая направляющая': guide(l),
    'Правая направляющая': guide(r - gt),
    'Левая боковина': left,
    'Правая боковина': right,
    'Задняя стенка': back,
    'Передняя стенка': new Box(left.r, right.l, gy, gy + bodyHeight, bodyFront - t, bodyFront),
    'Дно ящика': new Box(left.r, right.l, gy + BOTTOM_LIFT, gy + BOTTOM_LIFT + bottomThickness, back.f, frontZ),
  };
}

export function drawerWidthLimits(db, product, drawer, guideWidth) {
  let fixed = 0;
  let min = 1;
  let max = Infinity;
  for (const id of drawer.children) {
    const part = product.get(id);
    if (part?.kind === KIND.GUIDE) fixed += guideWidth ?? guideSection(db.get(part.kod) ?? undefined).width;
    if (part?.title === 'Левая боковина' || part?.title === 'Правая боковина') fixed += part.box.sx;
    if (part?.title === 'Дно ящика' || part?.title === 'Задняя стенка' || part?.title === 'Передняя стенка') {
      const limits = materialLimits(db, part);
      min = Math.max(min, part.min.x, limits.min.x ?? 0);
      if (limits.max.x > 0) max = Math.min(max, limits.max.x);
    }
  }
  return { min: fixed + min, max: fixed + max };
}

function planReflow(db, product, drawer) {
  const children = drawer.children.map((id) => product.parts.get(id)).filter(Boolean);
  const facade = drawerFacade(product, drawer);
  const handle = children.find((part) => part.kind === KIND.HANDLE);
  const guide = children.find((part) => part.kind === KIND.GUIDE);
  const side = children.find((part) => part.title === 'Левая боковина');
  const bottom = children.find((part) => part.title === 'Дно ящика');
  if (!facade || !guide || !side) return null;
  const nb = neighbors(product, opora(product, drawer));
  const { tag, kind } = drawer;
  const { l, r, back, front } = drawerOpening(kind, nb, facade.box.sz);
  const depth = drawerDepth(db, tag, back, front, drawer.data.requestedDepth ?? guide.box.sz);
  const kit = drawerKit(db, kind, tag, r - l);
  const limits = drawerWidthLimits(db, product, drawer, depth.width);
  if (!kit || r - l < limits.min - EPS || r - l > limits.max + EPS) throw new BuildError('Ящик не помещается в проём по ширине');
  const box = facade.box.clone().moveSide('g', front);
  setFacadeWidth(product, nb, box, drawer, kind, drawer.data.overlay);
  const handleRow = handle && db.get(handle.kod);
  const handleBox = handleRow && drawerHandleBox(box, handleRow);
  if (handleRow && !handleBox) throw new BuildError('Ручка не помещается на фасаде ящика');
  const boxes = drawerBoxes({ b: drawer.box.b, l, r, bodyFront: front, len: depth.len, gt: depth.width, gh: depth.height,
    t: side.box.sx, sideDepth: depth.sideDepth, bodyHeight: side.box.sy, tag }, bottom?.box.sy ?? 0);
  return { drawer, box, facade, handle, handleBox, children, boxes, kit, guide: depth.guide, l, r, back, front };
}

export function reflowDrawers(db, product, { keepInvalidDrawers = false } = {}) {
  const updates = [];
  for (const drawer of product.parts.values()) {
    if (!DRAWER_KINDS.has(drawer.kind) || !drawer.data.drawer) continue;
    try {
      const update = planReflow(db, product, drawer);
      if (update) updates.push(update);
    } catch (error) {
      if (!(error instanceof BuildError) || !keepInvalidDrawers) throw error;
    }
  }
  for (const update of updates) {
    const { drawer, box, facade, handle, handleBox, children, boxes, kit, guide, l, r, back, front } = update;
    Object.assign(drawer.box, { l, r, g: back, f: front });
    Object.assign(drawer, { kod: kit.kod, name: kit.name, title: kit.name });
    facade.box = box;
    facade.title = `Фасад (${kit.name})`;
    if (handleBox) {
      for (const axis of Object.keys(handle.data.centeredAxes ?? {})) handleBox.moveCenter(axis, box.center(axis));
      handle.box = handleBox;
    }
    for (const child of children) {
      if (boxes[child.title]) child.box = boxes[child.title];
      if (child.kind === KIND.GUIDE) Object.assign(child, { kod: guide.kod, name: guide.name });
    }
  }
}

export function planDrawer(db, product, item, point) {
  const tag = item.tag ?? '';
  const kind = item.id;
  const h = Number(item.H);
  const fit = point.drawerFit;
  const automatic = !fit && automaticDrawerHeight(item);
  if (!fit && !(h > 0)) throw new BuildError('Не задана высота ящика');
  const nbIds = placementNeighbors(product, point);
  const nb = neighbors(product, nbIds);
  const options = point.drawerOptions ?? {};
  const lower = automatic ? drawerSupport(product, nb.y1) : nb.y1;
  const upper = automatic ? drawerSupport(product, nb.y2) : nb.y2;
  const lowerDrawer = automatic && lower.data.drawer && product.get(lower.parent);
  const lowerHandle = lowerDrawer && lowerDrawer.children.map((id) => product.get(id)).find((part) => part?.kind === KIND.HANDLE);
  const minBottom = lower.box.t + GAP + drawerHandleGap(lowerHandle?.kod);
  const maxTop = upper.box.b - GAP - (automatic ? drawerHandleGap(item.handle) : 0);
  const height = fit ? fit.top - fit.bottom : automatic ? Math.min(Number(item.MaxH) || 500, maxTop - minBottom) : h - GAP;
  if (height < MIN_HEIGHT) throw new BuildError(`Высота ящика слишком мала (${Math.round(height)})`);
  const fromTop = upper.box.b - point.y < point.y - lower.box.t;
  const faceBottom = fit?.bottom ?? (fromTop ? maxTop - height : minBottom);
  const b = faceBottom + (fit?.lower ?? 0);
  const bodyHeight = fit?.bodyHeight ?? height - SIDE_DROP - (fit?.upper ?? 0) - (fit?.lower ?? 0);
  if (faceBottom < lower.box.t - (fit?.lower ?? 0) - 0.01 || faceBottom + height > upper.box.b + (fit?.upper ?? 0) + 0.01) {
    throw new BuildError('Ящик не помещается в проём по высоте');
  }
  if (!(bodyHeight > 0) || bodyHeight > height - BODY_LIFT - (fit?.upper ?? 0) - (fit?.lower ?? 0)) {
    throw new BuildError('Высота наполнения ящика не помещается за фасадом');
  }
  const panel = panelRow(db, product, KIND.ZAD, 16);
  if (!panel) throw new BuildError('Для фасада ящика нет материала 16 мм в цвете наполнения');
  const t = panel.t;
  const dygl = WIDE_GAP.has(tag) ? 4 : GAP;
  const { changes, questions, levels } = prepareOpening(kind, nb, t, dygl, options);
  const { l, r, back, front: bodyFront } = drawerOpening(kind, nb, t, changes);
  const kit = drawerKit(db, kind, tag, r - l);
  if (!kit) throw new BuildError(`Для проёма ${Math.round(r - l)} мм нет комплекта ящика «${tag}»`);
  const requestedDepth = Number(item.G) || 0;
  const { guide, len, sideDepth, width: gt, height: gh } = drawerDepth(db, tag, back, bodyFront, requestedDepth);
  if (r - l <= 2 * (gt + t)) {
    throw new BuildError('Ящик не помещается в проём по ширине с выбранными направляющими');
  }
  const handle = item.handle && drawerNeedsHandle(item) ? drawerHandles(db).find((row) => row.kod === item.handle) : null;
  const facadeBox = new Box(l, r, faceBottom, faceBottom + height, bodyFront, bodyFront + t);
  for (const [key, part] of Object.entries(levels)) {
    const edge = key === 'lower' ? 'b' : 't';
    const facing = key === 'lower' ? 't' : 'b';
    const front = changes.get(part.id) ?? part.box.f;
    const flush = [nb.x1, nb.x2].every((side) => Math.abs(front - (changes.get(side.id) ?? side.box.f)) < OVERLAY_FLUSH);
    const reach = Math.abs(facadeBox[edge] - part.box[facing]) < OVERLAY_REACH;
    const clears = front <= bodyFront + EPS || (freeFront(part) && front < bodyFront + OVERLAY_FLUSH);
    questions[key] = kind === KIND.BOX_NAKL && isLevel(part) && flush && reach && clears;
    const batchAmount = fit?.[key] ?? 0;
    if (batchAmount && (!isLevel(part) || front > bodyFront + EPS)) {
      throw new BuildError(`Чтобы наложить фасад ${key === 'lower' ? 'снизу' : 'сверху'}, сначала уменьшите глубину опоры`);
    }
    const amount = drawerOverlayAmount(part.box.sy, options[key]);
    if (questions[key] && amount) {
      facadeBox[edge] = part.box[facing] + (key === 'lower' ? -1 : 1) * (amount - GAP);
      if (front > bodyFront) changes.set(part.id, bodyFront);
    }
  }
  setFacadeWidth(product, nb, facadeBox, null, kind, options);
  const handleBox = handle && drawerHandleBox(facadeBox, handle);
  if (handle && !handleBox) throw new BuildError('Ручка не помещается на фасаде ящика');
  return { tag, kind, kit, panel, t, l, r, b, height: height - (fit?.upper ?? 0) - (fit?.lower ?? 0),
    bodyHeight, back, bodyFront, changes, questions, nbIds, len, gt, gh, guide, sideDepth, requestedDepth, facadeBox, handle, handleBox };
}

export function previewDrawer(db, product, item, point) {
  try {
    const { facadeBox, l, r, bodyFront, len, sideDepth, handleBox } = planDrawer(db, product, item, point);
    const box = new Box(Math.min(l, facadeBox.l), Math.max(r, facadeBox.r), facadeBox.b, facadeBox.t,
      bodyFront - Math.max(len, sideDepth), Math.max(facadeBox.f, handleBox?.f ?? 0));
    return { box, valid: true };
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    return { valid: false, error: error.message };
  }
}

export function createDrawer(project, db, product, item, point) {
  const { tag, kind, kit, panel, t, l, r, b, height, bodyHeight, back, bodyFront, changes, nbIds, len, gt, gh,
    guide, sideDepth, requestedDepth, facadeBox, handle, handleBox } = planDrawer(db, product, item, point);
  const cuts = [...changes.keys()].filter((id) => {
    const part = product.get(id);
    return Math.abs(part.box.f - changes.get(id)) >= EPS || part.data.yglybBy?.length;
  });
  for (const [id, front] of changes) {
    const part = product.get(id);
    const depth = part.box.f - front;
    const min = Math.max(part.min.z, materialLimits(db, part).min.z ?? 0, EPS);
    const max = Math.min(part.max.z || Infinity, materialLimits(db, part).max.z || Infinity);
    if ((depth > EPS && front - part.box.g < min - EPS) || (depth < -EPS && front - part.box.g > max + EPS)) {
      throw new BuildError(`Невозможно изменить глубину детали «${part.title || part.name}» для установки ящика`);
    }
  }
  const { left, right, cutSides } = point.drawerOptions ?? {};
  const ja = project.addPart(product, {
    kind, group: 3, kod: kit.kod, name: kit.name, title: kit.name, tag, hidden: true, stenDver: -9, nb: nbIds,
    box: new Box(l, r, b, b + height, back, bodyFront), mount: { l: true, r: true, b: false, t: false, g: false, f: false },
    data: { drawer: true, cuts, tag, requestedDepth, overlay: { left, right, cutSides } },
  });
  for (const id of cuts) {
    const part = product.get(id);
    cutDrawerSupport(part, ja.id, part.box.f - changes.get(id));
  }
  const child = (init) => project.addPart(product, { parent: ja.id, stenDver: -9, data: { drawer: true }, ...init });
  const fix = (thick, axis) => ({ min: { x: 0, y: 0, z: 0, [axis]: thick }, max: { x: 0, y: 0, z: 0, [axis]: thick } });
  const board = (title, box, group, extra = {}) => child({
    kind: group === 2 ? KIND.PEREG : KIND.ZAD, group, kod: panel.kod, name: panel.name, color: panel.color ?? '', title, box,
    ...fix(t, group === 2 ? 'x' : 'z'), ...extra,
  });

  const facade = board(`Фасад (${kit.name})`, facadeBox, 0, { edgeForce: { l: true, r: true, b: true, t: true, g: false, f: false } });
  if (handle) {
    if (handle.objTip?.startsWith('Торцевая ручка')) facade.edge.t = -2;
    child({ kind: KIND.HANDLE, group: 1, kod: handle.kod, name: handle.name, color: handle.color,
      title: handle.name, casper: true, box: handleBox });
  }
  const bottomRow = THIN_BOTTOM.has(tag) ? db.byPos(KIND.POL).find((row) => row.name === 'ХДФ 4мм' && row.t === 4) : panel;
  const boxes = drawerBoxes({ b, l, r, bodyFront, len, gt, gh, t, sideDepth, bodyHeight, tag }, bottomRow?.t ?? 0);
  for (const title of ['Левая направляющая', 'Правая направляющая']) {
    child({ kind: KIND.GUIDE, group: 1, kod: guide.kod, name: guide.name, title, excluded: true, casper: true, box: boxes[title] });
  }
  const edgeAll = { edgeForce: { l: false, r: false, b: true, t: true, g: true, f: true } };
  board('Левая боковина', boxes['Левая боковина'], 2, { ...edgeAll, mount: { l: false, r: false, b: false, t: false, g: false, f: true }, krep: { l: KREP_NONE, r: 0, b: 0, t: 0, g: 0, f: KREP_BOX_FRONT } });
  board('Правая боковина', boxes['Правая боковина'], 2, { ...edgeAll, mount: { l: false, r: false, b: false, t: false, g: false, f: true }, krep: { l: 0, r: KREP_NONE, b: 0, t: 0, g: 0, f: KREP_BOX_FRONT } });
  const wallMount = { mount: { l: true, r: true, b: false, t: false, g: false, f: false } };
  board('Задняя стенка', boxes['Задняя стенка'], 0, wallMount);
  if (WITH_FRONT_WALL.has(tag)) board('Передняя стенка', boxes['Передняя стенка'], 0, wallMount);
  if (bottomRow) {
    const bt = bottomRow.t;
    child({
      kind: KIND.POLKA, group: 1, kod: bottomRow.kod, name: bottomRow.name, color: bottomRow.color ?? '', title: 'Дно ящика', ...fix(bt, 'y'),
      box: boxes['Дно ящика'],
      mount: { l: true, r: true, b: false, t: false, g: true, f: true }, edge: { l: -2, r: -2, b: -2, t: -2, g: -2, f: -2 },
      krep: { l: KREP_BOTTOM_PAZ, r: KREP_BOTTOM_PAZ, b: 0, t: 0, g: KREP_BOTTOM_PAZ, f: KREP_BOTTOM_PAZ },
    });
  }
  relayout(db, product);
  return facade;
}

function cutDrawerSupport(side, drawerId, depth) {
  side.data.yglyb = (side.data.yglyb ?? 0) + depth;
  side.box.f -= depth;
  (side.data.yglybBy ??= []).push(drawerId);
}

export function resumeDrawerCuts(product, side) {
  if (side.stenDver !== -1 || !isPanel(side) || side.group !== 2) return;
  for (const drawer of product.parts.values()) {
    if (drawer.kind !== KIND.BOX_NAKL || (drawer.nb.x1 !== side.id && drawer.nb.x2 !== side.id)) continue;
    if (drawer.data.overlay?.cutSides === false) continue;
    const cuts = drawer.data.cuts ??= [];
    if (cuts.includes(side.id)) continue;
    const facade = drawerFacade(product, drawer);
    if (!facade) continue;
    cuts.push(side.id);
    const depth = side.data.yglybBy?.length ? 0 : facade.box.sz + (WIDE_GAP.has(drawer.tag) ? 4 : GAP);
    cutDrawerSupport(side, drawer.id, depth);
  }
}

function restoreCut(product, sideId, drawerId) {
  const side = product.get(sideId);
  if (!side) return;
  side.data.yglybBy = (side.data.yglybBy ?? []).filter((id) => id !== drawerId);
  if (side.data.yglybBy.length) return;
  const depth = side.data.yglyb ?? 0;
  delete side.data.yglyb;
  if (!depth) return;
  let front = side.box.f + depth;
  for (const door of product.parts.values()) {
    if (door.kind !== KIND.DOOR_ZONE) continue;
    const cut = door.data.cuts?.find((entry) => entry.id === sideId);
    if (!cut) continue;
    if (cut.stenDver === -1) cut.f += depth;
    const sideName = Object.entries({ x1: 'l', x2: 'r', y1: 'b', y2: 't' }).find(([key]) => door.nb[key] === sideId)?.[1];
    const overlay = cut.overlay ?? door.data.cfg?.overlay?.[sideName];
    if (overlay && overlay !== 'in') front = Math.min(front, door.box.g);
  }
  side.box.f = front;
}

export function releaseDrawer(product, ja) {
  for (const id of ja.data.cuts ?? []) restoreCut(product, id, ja.id);
}
