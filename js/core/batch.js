import { BuildError, placementNeighbors, planPanelInsertion } from './build.js';
import { AXIS_SIDES, EPS } from './geom.js';
import { KIND } from './model.js';
import { neighbors } from './opora.js';
import { DRAWER_GAP, drawerHandleGap, drawerSupport, drawerOverlayAmount, planDrawer } from './drawers.js';
import { planRoomElement } from './room.js';

const MAX_COUNT = 100;

export function batchOpening(product, item, point, drawer) {
  const axis = item.id === KIND.PEREG ? 'x' : 'y';
  const [lo, hi] = AXIS_SIDES[axis];
  const supportIds = { ...placementNeighbors(product, point) };
  const nb = neighbors(product, supportIds);
  const lower = nb[axis + '1'];
  const upper = nb[axis + '2'];
  const bottom = drawerSupport(product, lower);
  const top = drawerSupport(product, upper);
  const start = bottom.box[hi];
  const end = top.box[lo];
  if (drawer) {
    supportIds[axis + '1'] = bottom.id;
    supportIds[axis + '2'] = top.id;
  }
  if (end <= start) throw new BuildError('В этом месте нет свободного проёма');
  const front = Math.max(nb.x1.box.f, nb.x2.box.f);
  const canOverlay = (part) => [KIND.POL, KIND.POLKA].includes(part.kind) && part.group === 1 && !part.parent && part.box.f < front + 3;
  return {
    axis, start, end, span: end - start, supportIds,
    thickness: Number(item[axis === 'x' ? 'W' : 'H']) || 16,
    datum: axis === 'y' && product.role('PB')?.title === 'Подиум пол' ? product.role('PB').box.cy : 0,
    overlayLow: drawer && item.id === KIND.BOX_NAKL && canOverlay(lower) ? lower.box.sy : 0,
    overlayHigh: drawer && item.id === KIND.BOX_NAKL && canOverlay(upper) ? upper.box.sy : 0,
    handleGap: drawerHandleGap(item.handle),
  };
}

function checkCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new BuildError(`Укажите количество от 1 до ${MAX_COUNT}`);
}

export function panelBatch(opening, config) {
  const { axis, start, span, thickness, datum } = opening;
  const { autoGap, grid, low, high } = config;
  const available = span - (low ?? 0) - (high ?? 0);
  const fixed = Number(low != null) + Number(high != null);
  let { count, gap } = config;
  if (autoGap) {
    gap = (available - count * thickness) / (count + 1 - fixed);
    if (count === 1 && fixed === 2) gap = 0;
    if (grid) gap = Math.floor((gap + thickness) / 32) * 32 - thickness;
  } else {
    count = gap >= 0
      ? Math.floor((available + (fixed ? -thickness : thickness)) / (gap + thickness) + (fixed ? 1 : -1) + 1e-8)
      : NaN;
  }
  const remainder = span - count * thickness - (count - 1) * gap;
  let first = low ?? (high != null ? remainder - high : remainder / 2);
  if (autoGap && grid && low == null) first = Math.round((start - datum + first) / 32) * 32 - (start - datum) - thickness / 2;
  const last = remainder - first;
  return { count, gap, first, last, points(point) {
    checkCount(count);
    if (!Number.isFinite(gap) || (count > 1 && gap < 0) || first < -EPS || last < -EPS) {
      throw new BuildError('Детали с указанными отступами не помещаются в проём');
    }
    return Array.from({ length: count }, (_, i) => {
      const offset = Math.max(0, Math.min(span - thickness, Math.round(first + i * (gap + thickness))));
      return { ...point, [axis]: start + offset + thickness / 2, size: config.depth ? { G: String(config.depth) } : {} };
    });
  } };
}

export function drawerBatch(opening, point, config) {
  const { span, start, end, overlayLow, overlayHigh, handleGap, supportIds } = opening;
  const upper = drawerOverlayAmount(overlayHigh, config.upper);
  let { count, height } = config;
  if (config.autoCount) {
    count = height >= 90 && height <= 500
      ? Math.floor((span - DRAWER_GAP + drawerOverlayAmount(overlayLow, config.lower) + upper) / (height + handleGap))
      : NaN;
  }
  const lower = count > 1 ? drawerOverlayAmount(overlayLow, config.lower) : 0;
  const available = span - DRAWER_GAP + lower + upper;
  if (config.autoHeight && count > 0) height = (available - handleGap * count) / count;
  return { count, height, points() {
    checkCount(count);
    if (!(height >= (config.autoHeight ? 98 : 90)) || (!config.autoHeight && height > 500)) throw new BuildError('Высота ящика вне допустимого диапазона');
    if (height * count + (count - 1) * handleGap > available + EPS) throw new BuildError('Высота проёма слишком мала для такого количества ящиков');
    if (config.bodyHeight != null && config.bodyHeight < 50) throw new BuildError('Высота наполнения слишком мала');
    const fromBottom = count === 1 && point.y - start < end - point.y;
    return Array.from({ length: count }, (_, i) => {
      const top = fromBottom || (lower && i === count - 1)
        ? start - lower + height : end + upper - DRAWER_GAP - i * (height + handleGap);
      const bottom = top - height + DRAWER_GAP;
      return { ...point, supportIds, drawerFit: { bottom, top, upper: i === 0 ? upper : 0,
        lower: i === count - 1 ? lower : 0, bodyHeight: config.bodyHeight },
        size: { H: String(height), MinH: String(height), ...(config.depth ? { G: String(config.depth) } : {}) } };
    });
  } };
}

export function batchDimensions(db, target, item, points, roomSpec, drawer) {
  const depth = [];
  const bodyHeight = [];
  for (const point of points) {
    const spec = { ...item, ...point.size };
    if (drawer) {
      const plan = planDrawer(db, target, spec, point);
      depth.push(plan.len);
      bodyHeight.push(plan.bodyHeight);
    } else {
      const panel = roomSpec
        ? planRoomElement(target, { ...roomSpec, panel: spec }, point)
        : planPanelInsertion(db, target, spec, point);
      if (!panel || !(panel.box.sz > 0)) throw new BuildError('В этом месте деталь не помещается');
      depth.push(panel.box.sz);
    }
  }
  return { depth, bodyHeight };
}
