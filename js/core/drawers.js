import { Box, handleSize } from './geom.js';
import { KIND } from './model.js';
import { neighbors } from './opora.js';
import { placementNeighbors, relayout, BuildError } from './build.js';
import { findMaterial } from './material.js';

const HIDDEN_MOUNT = new Set(['Quadro V6+P2O', 'BOYARD P2O', 'BLUM TANDEM plus TIP-ON', 'BLUM TANDEM plus 19 мм TIP-ON', 'BLUM TANDEM F 19 мм TIP-ON',
  'BLUM TANDEM plus BLUMOTION', 'BLUM TANDEM plus 19 мм BLUMOTION', 'Silent System', 'Soft-Close скрытого монтажа Firmax 3D',
  'Push-to-Open скрытого монтажа Firmax 3D', 'ПВ скр.монт зам Push DTC']);
const WIDE_GAP = new Set(['BLUM TANDEM plus TIP-ON', 'BLUM TANDEM plus 19 мм TIP-ON', 'BLUM TANDEM F 19 мм TIP-ON', 'Push-to-Open скрытого монтажа Firmax 3D', 'ПВ скр.монт зам Push DTC']);
const THIN_BOTTOM = new Set(['DB 4501ZN', 'Направляющая роликовая']);
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

function guideSection(row) {
  return { width: row.minH || row.maxH || row.h || 13, height: row.minT || row.maxT || row.t || 45 };
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
  let changed = false;
  for (const drawer of product.parts.values()) {
    if (!DRAWER_KINDS.has(drawer.kind) || !drawer.data.drawer) continue;
    const children = drawer.children.map((id) => product.parts.get(id)).filter(Boolean);
    const facade = children.find((part) => part.kind === KIND.ZAD && part.title.startsWith('Фасад ('));
    const handle = children.find((part) => part.kind === KIND.HANDLE);
    const handleRow = handle && db.get(handle.kod);
    const handleBox = facade && handleRow && drawerHandleBox(facade.box, handleRow);
    if (handleBox) {
      for (const axis of Object.keys(handle.data.centeredAxes ?? {})) handleBox.moveCenter(axis, facade.box.center(axis));
      handle.box = handleBox;
    }
    const guides = children.filter((part) => part.kind === KIND.GUIDE).sort((a, b) => a.box.l - b.box.l);
    const sides = children.filter((part) => part.kind === KIND.PEREG && part.group === 2).sort((a, b) => a.box.l - b.box.l);
    if (guides.length !== 2 || sides.length !== 2) continue;
    const rows = guides.map((guide) => db.get(guide.kod));
    if (rows.some((row) => !row)) continue;
    const sections = rows.map(guideSection);
    const [left, right] = sides.map((part) => part.box);
    if (left.sx + right.sx + sections[0].width + sections[1].width >= drawer.box.sx) continue;
    const innerLeft = left.r;
    const innerRight = right.l;
    for (const [index, guide] of guides.entries()) {
      const { width, height } = sections[index];
      const box = guide.box;
      const side = sides[index].box;
      const outer = index === 0 ? 'l' : 'r';
      const inner = index === 0 ? 'r' : 'l';
      const position = index === 0 ? drawer.box.l : drawer.box.r - width;
      if (Math.abs(box.l - position) < 0.01 && Math.abs(box.sx - width) < 0.01 &&
          Math.abs(box.sy - height) < 0.01 && Math.abs(box.b - side.b) < 0.01) continue;
      box.l = position;
      box.r = position + width;
      box.b = side.b;
      box.t = side.b + height;
      side.moveSide(outer, box[inner]);
      changed = true;
    }
    for (const child of children) {
      if (Math.abs(child.box.l - innerLeft) < 0.01 && Math.abs(child.box.r - innerRight) < 0.01) {
        child.box.l = left.r;
        child.box.r = right.l;
      }
    }
  }
  if (changed) relayout(db, product);
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
  const lower = automatic ? drawerSupport(product, nb.y1) : nb.y1;
  const upper = automatic ? drawerSupport(product, nb.y2) : nb.y2;
  const lowerDrawer = automatic && lower.data.drawer && product.get(lower.parent);
  const lowerHandle = lowerDrawer && lowerDrawer.children.map((id) => product.get(id)).find((part) => part?.kind === KIND.HANDLE);
  const minBottom = lower.box.t + GAP + drawerHandleGap(lowerHandle?.kod);
  const maxTop = upper.box.b - GAP - (automatic ? drawerHandleGap(item.handle) : 0);
  const height = fit ? fit.top - fit.bottom : automatic ? Math.min(Number(item.MaxH) || 500, maxTop - minBottom) : h - GAP;
  if (height < MIN_HEIGHT) throw new BuildError(`Высота ящика слишком мала (${Math.round(height)})`);
  const l = nb.x1.box.r;
  const r = nb.x2.box.l;
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
  const kit = db.byPos(kind).find((row) => (row.name ?? '').includes(tag) && row.maxW === widthClass(tag, r - l));
  if (!kit) throw new BuildError(`Для проёма ${Math.round(r - l)} мм нет комплекта ящика «${tag}»`);
  const panel = panelRow(db, product, KIND.ZAD, 16);
  if (!panel) throw new BuildError('Для фасада ящика нет материала 16 мм в цвете наполнения');
  const t = panel.t;
  const dygl = WIDE_GAP.has(tag) ? 4 : GAP;
  const back = Math.max(nb.z1.box.f, real(nb.x1) ? nb.x1.box.g : 0, real(nb.x2) ? nb.x2.box.g : 0);
  let front = Math.min(nb.z2.box.g, ...[nb.x1, nb.x2].filter(real).map((p) => p.box.f));

  const cuts = [];
  let bodyFront;
  let fl = l + GAP;
  let fr = r - GAP;
  if (kind === KIND.BOX_NAKL) {
    const sides = [nb.x1, nb.x2].filter(real);
    cuts.push(...sides.filter((p) => p.stenDver === -1).map((p) => p.id));
    front = Math.min(nb.z2.box.g - t, ...sides.map((p) => p.box.f - (cuts.includes(p.id) && !p.data.yglyb ? t + dygl : 0)));
    bodyFront = front;
    if (real(nb.x1) && cuts.includes(nb.x1.id)) fl = nb.x1.box.l + GAP;
    if (real(nb.x2) && cuts.includes(nb.x2.id)) fr = nb.x2.box.r - GAP;
  } else bodyFront = front - t;

  const nzg = 5 + (HIDDEN_MOUNT.has(tag) ? 13 : 0);
  const requestedDepth = Number(item.G);
  const avail = Math.min(bodyFront - back - nzg, requestedDepth > 0 ? requestedDepth : Infinity);
  const len = GUIDE_STEPS.find((s) => s <= avail);
  if (!len) throw new BuildError(`Возникли проблемы при установке ящика :(\nДлина направляющей = ${Math.round(avail)} мм`);
  const guide = db.byPos(KIND.GUIDE).find((row) => (row.name ?? '').includes(tag) && row.minW === len)
    ?? db.byPos(KIND.GUIDE).find((row) => (row.name ?? '').includes(tag) && row.w === len);
  if (!guide) throw new BuildError(`Не найдено подходящей для глубины проёма направляющей!\nНеобходимая длина направляющей = ${len} мм`);
  const { width: gt, height: gh } = guideSection(guide);
  if (r - l <= 2 * (gt + t)) {
    throw new BuildError('Ящик не помещается в проём по ширине с выбранными направляющими');
  }
  const handle = item.handle && drawerNeedsHandle(item) ? drawerHandles(db).find((row) => row.kod === item.handle) : null;
  const facadeG = kind === KIND.BOX_NAKL ? bodyFront : front - t;
  const facadeBox = new Box(fl, fr, faceBottom, faceBottom + height, facadeG, facadeG + t);
  const handleBox = handle && drawerHandleBox(facadeBox, handle);
  if (handle && !handleBox) throw new BuildError('Ручка не помещается на фасаде ящика');
  return { tag, kind, kit, panel, t, l, r, b, height: height - (fit?.upper ?? 0) - (fit?.lower ?? 0),
    bodyHeight, back, bodyFront, cuts, dygl, nbIds, len, gt, gh, guide, facadeBox, handle, handleBox };
}

export function previewDrawer(db, product, item, point) {
  try {
    const { facadeBox, l, r, bodyFront, len, handleBox } = planDrawer(db, product, item, point);
    const box = new Box(Math.min(l, facadeBox.l), Math.max(r, facadeBox.r), facadeBox.b, facadeBox.t,
      bodyFront - len, Math.max(facadeBox.f, handleBox?.f ?? 0));
    return { box, valid: true };
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    return { valid: false, error: error.message };
  }
}

export function createDrawer(project, db, product, item, point) {
  const { tag, kind, kit, panel, t, l, r, b, height, bodyHeight, back, bodyFront, cuts, dygl, nbIds, len, gt, gh,
    guide, facadeBox, handle, handleBox } = planDrawer(db, product, item, point);
  for (const id of cuts) {
    const side = product.get(id);
    if (!side.data.yglyb) { side.data.yglyb = t + dygl; side.box.f -= t + dygl; }
  }

  const ja = project.addPart(product, {
    kind, group: 3, kod: kit.kod, name: kit.name, title: kit.name, tag, hidden: true, stenDver: -9, nb: nbIds,
    box: new Box(l, r, b, b + height, back, bodyFront), mount: { l: true, r: true, b: false, t: false, g: false, f: false },
    data: { drawer: true, cuts, tag },
  });
  for (const id of cuts) { const side = product.get(id); (side.data.yglybBy ??= []).push(ja.id); }
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
  const gy = b + BODY_LIFT;
  for (const [title, x] of [['Левая направляющая', l], ['Правая направляющая', r - gt]]) {
    child({ kind: KIND.GUIDE, group: 1, kod: guide.kod, name: guide.name, title, excluded: true, casper: true, box: new Box(x, x + gt, gy, gy + gh, bodyFront - len, bodyFront) });
  }
  const sideH = bodyHeight;
  const sideD = len - 10;
  const sideBox = (x) => new Box(x, x + t, gy, gy + sideH, bodyFront - sideD, bodyFront);
  const edgeAll = { edgeForce: { l: false, r: false, b: true, t: true, g: true, f: true } };
  const left = board('Левая боковина', sideBox(l + gt), 2, { ...edgeAll, mount: { l: false, r: false, b: false, t: false, g: false, f: true }, krep: { l: KREP_NONE, r: 0, b: 0, t: 0, g: 0, f: KREP_BOX_FRONT } });
  const right = board('Правая боковина', sideBox(r - gt - t), 2, { ...edgeAll, mount: { l: false, r: false, b: false, t: false, g: false, f: true }, krep: { l: 0, r: KREP_NONE, b: 0, t: 0, g: 0, f: KREP_BOX_FRONT } });
  const inner = { l: left.box.r, r: right.box.l };
  const wallMount = { mount: { l: true, r: true, b: false, t: false, g: false, f: false } };
  const backWall = board('Задняя стенка', new Box(inner.l, inner.r, gy, gy + sideH, left.box.g, left.box.g + t), 0, wallMount);
  let frontZ = bodyFront;
  if (HIDDEN_MOUNT.has(tag) || tag === 'DB8881Zn') {
    board('Передняя стенка', new Box(inner.l, inner.r, gy, gy + sideH, bodyFront - t, bodyFront), 0, wallMount);
    frontZ = bodyFront - t;
  }
  const thin = THIN_BOTTOM.has(tag);
  const bottomRow = thin ? db.byPos(KIND.POL).find((row) => row.name === 'ХДФ 4мм' && row.t === 4) : panel;
  if (bottomRow) {
    const bt = bottomRow.t;
    child({
      kind: KIND.POLKA, group: 1, kod: bottomRow.kod, name: bottomRow.name, color: bottomRow.color ?? '', title: 'Дно ящика', ...fix(bt, 'y'),
      box: new Box(inner.l, inner.r, gy + BOTTOM_LIFT, gy + BOTTOM_LIFT + bt, backWall.box.f, frontZ),
      mount: { l: true, r: true, b: false, t: false, g: true, f: true }, edge: { l: -2, r: -2, b: -2, t: -2, g: -2, f: -2 },
      krep: { l: KREP_BOTTOM_PAZ, r: KREP_BOTTOM_PAZ, b: 0, t: 0, g: KREP_BOTTOM_PAZ, f: KREP_BOTTOM_PAZ },
    });
  }
  relayout(db, product);
  return facade;
}

function restoreCut(product, sideId, drawerId) {
  const side = product.get(sideId);
  if (!side) return;
  side.data.yglybBy = (side.data.yglybBy ?? []).filter((id) => id !== drawerId);
  if (side.data.yglybBy.length || !side.data.yglyb) return;
  side.box.f += side.data.yglyb;
  delete side.data.yglyb;
}

export function releaseDrawer(product, ja) {
  for (const id of ja.data.cuts ?? []) restoreCut(product, id, ja.id);
}
