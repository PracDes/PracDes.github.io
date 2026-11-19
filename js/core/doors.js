import { Box, handleSize } from './geom.js';
import { isFullyLocked, KIND, isPanel } from './model.js';
import { parseIdList } from './db.js';
import { neighbors } from './opora.js';
import { placementNeighbors, relayout, BuildError } from './build.js';
import { isKit } from './product.js';
import { DRAWER_KINDS, releaseDrawer, resumeDrawerCuts } from './drawers.js';

const DK = { LEAF: 4, HANDLE: 10, HINGE_IN: 18, HINGE_ON: 19, HINGE_HALF: 20, MAX_W: 31, MIN_W: 39, MAX_H: 38, MIN_H: 40 };
export const OVERLAYS = { in: 'Вкладная', full: 'Накладная', half: 'Полунакладная' };
export const HANDLE_POS = { RL: 'Слева', RR: 'Справа', RTL: 'Сверху слева', RTR: 'Сверху справа', RBL: 'Снизу слева', RBR: 'Снизу справа' };
const HINGE_KIND = { in: KIND.HINGE_IN, full: KIND.HINGE_ON, half: KIND.HINGE_HALF };
const HINGE_DK = { in: DK.HINGE_IN, full: DK.HINGE_ON, half: DK.HINGE_HALF };
const FRONT_OFFSET = 5;
const HANDLE_INSET = 40;
const HINGE_INSET = 100;
const MAX_OVERLAY_THICKNESS = 18;

function rowsOf(db, system, dk) {
  const entry = system.find((d) => d.dk === dk);
  return entry ? [...parseIdList(entry.value)].map((k) => db.get(k)).filter(Boolean) : [];
}

function limit(system, dk) {
  const v = Number(system.find((d) => d.dk === dk)?.value);
  return Number.isFinite(v) ? v : 0;
}

export function doorOptions(db, system) {
  return {
    handles: rowsOf(db, system, DK.HANDLE).filter((r) => db.forProduct(r)),
    families: [...new Set(rowsOf(db, system, DK.HINGE_IN).filter((r) => !(r.name ?? '').includes('не выбирать')).map((r) => r.sub).filter(Boolean))],
    materials: db.byPos(KIND.ZAD).filter((r) => r.group === 'ДСП-МДФ-ДВП' && r.unit === 'м2' && !isKit(r) && r.t >= 16 && r.dop === 'ДСП'),
    minW: limit(system, DK.MIN_W), maxW: limit(system, DK.MAX_W), minH: limit(system, DK.MIN_H), maxH: limit(system, DK.MAX_H),
  };
}

export function defaultDoorConfig(db, system, product) {
  const opt = doorOptions(db, system);
  const fill = db.get(product.form?.fill.kod);
  return {
    count: 1, overlay: { l: 'full', r: 'full', b: 'full', t: 'full' },
    kod: (opt.materials.includes(fill) ? fill : opt.materials[0])?.kod ?? 0,
    handle: opt.handles.find((r) => r.unit === 'шт.' && r.price > 0)?.kod ?? opt.handles[0]?.kod ?? 0,
    handlePos: 'RR', family: opt.families[0] ?? '',
  };
}

function hingeCount(height) {
  if (height < 901) return 2;
  if (height < 1601) return 3;
  if (height < 2001) return 4;
  return 5;
}

function hingeRow(db, system, overlay, family) {
  const rows = rowsOf(db, system, HINGE_DK[overlay]);
  return rows.find((r) => r.sub === family) ?? null;
}

export function doorOpeningFromParts(parts) {
  const panels = parts.filter((part) => isPanel(part) && !part.parent && !part.casper);
  const vertical = panels.filter((part) => part.group === 2);
  const horizontal = panels.filter((part) => part.group === 1);
  if (vertical.length < 2 || horizontal.length < 2) return null;
  const left = vertical.reduce((a, b) => a.box.r <= b.box.r ? a : b);
  const right = vertical.reduce((a, b) => a.box.l >= b.box.l ? a : b);
  const bottom = horizontal.reduce((a, b) => a.box.t <= b.box.t ? a : b);
  const top = horizontal.reduce((a, b) => a.box.b >= b.box.b ? a : b);
  if (left.box.r >= right.box.l || bottom.box.t >= top.box.b) return null;
  return {
    x: (left.box.r + right.box.l) / 2,
    y: (bottom.box.t + top.box.b) / 2,
    z: Math.min(left.box.f, right.box.f, bottom.box.f, top.box.f) - FRONT_OFFSET,
    sides: { x1: left.id, x2: right.id, y1: bottom.id, y2: top.id },
  };
}

export function createDoor(project, db, product, system, cfg, point) {
  const opt = doorOptions(db, system);
  const leafRow = db.get(cfg.kod);
  if (!leafRow) throw new BuildError('Не выбран материал двери');
  const t = leafRow.t;
  const useLocalOpening = point.supportIds || point.sides;
  const nbIds = { ...placementNeighbors(product, useLocalOpening ? point : { ...point, z: product.G - FRONT_OFFSET }), ...point.sides };
  const nb = neighbors(product, nbIds);
  const sides = { l: nb.x1, r: nb.x2, b: nb.y1, t: nb.y2 };
  const axisOf = { l: 'x', r: 'x', b: 'y', t: 'y' };
  const over = {};
  for (const s of ['l', 'r', 'b', 't']) {
    over[s] = sides[s].kind >= 6 ? cfg.overlay[s] : 'in';
    if (over[s] === 'full' && sides[s].stenDver > 0 && product.get(sides[s].stenDver)) over[s] = 'half';
    if (over[s] !== 'in' && sides[s].box.size(axisOf[s]) > MAX_OVERLAY_THICKNESS + 0.01) {
      throw new BuildError('Деталь, на которую накладывается дверь, более 18 мм!\nУстановка отменена!');
    }
  }
  const edge = (s, inner, outer, sign) => {
    if (over[s] === 'in') return inner;
    const th = sides[s].box.size(axisOf[s]);
    return over[s] === 'full' ? outer : outer + sign * th / 2;
  };
  const zl = edge('l', sides.l.box.r, sides.l.box.l, 1);
  const zr = edge('r', sides.r.box.l, sides.r.box.r, -1);
  const zb = edge('b', sides.b.box.t, sides.b.box.b, 1);
  const zt = edge('t', sides.t.box.b, sides.t.box.t, -1);
  const anyOverlay = Object.values(over).some((o) => o !== 'in');
  const fronts = Object.values(sides).filter((p) => p.kind >= 6).map((p) => p.box.f);
  const pz = fronts.length ? Math.min(...fronts) : product.G;
  const front = anyOverlay && !useLocalOpening ? product.G : pz;
  const zg = Math.max(front - t, ...Object.keys(sides)
    .filter((s) => over[s] !== 'in' && (sides[s].data.yglyb || isFullyLocked(sides[s]))).map((s) => sides[s].box.f));
  if (zr - zl <= 0 || zt - zb <= 0) throw new BuildError('Не удалось определить проём двери');

  const gap = (s) => (over[s] === 'half' ? 1 : 2);
  const count = cfg.count === 2 ? 2 : 1;
  const between = count === 2 ? 2 : 0;
  const leafW = Math.trunc(Math.round(((zr - zl - gap('l') - gap('r') - between) / count) * 10)) / 10;
  const leafH = zt - zb - gap('b') - gap('t');
  if (opt.minW && leafW <= opt.minW || opt.maxW && leafW >= opt.maxW) {
    throw new BuildError(`Ширина двери ${Math.round(leafW)} мм вне допустимых пределов (${opt.minW + 1}…${opt.maxW - 1} мм).${count === 1 ? '\nПопробуйте установить две двери.' : ''}`);
  }
  if (leafH <= 0 || opt.maxH && leafH >= opt.maxH || opt.minH && leafH <= opt.minH) throw new BuildError('Высота двери вне допустимых пределов');

  const cuts = [];
  const zone = project.addPart(product, {
    kind: KIND.DOOR_ZONE, group: 0, name: 'Двери Распашные', title: 'Двери ДСП', hidden: true, casper: true,
    box: new Box(zl, zr, zb, zt, zg, zg), nb: nbIds, data: { door: true, cfg: structuredClone(cfg), cuts },
  });
  for (const s of ['l', 'r', 'b', 't']) {
    const p = sides[s];
    if (p.kind < 6 || isFullyLocked(p)) continue;
    cuts.push({ id: p.id, f: p.box.f, stenDver: p.stenDver, overlay: over[s] });
    if (over[s] !== 'in' && !p.data.yglyb && p.box.f > zg) p.box.f = zg;
    p.stenDver = zone.id;
  }

  const handleRow = db.get(cfg.handle);
  const leaves = [];
  for (let i = 0; i < count; i++) {
    const left = count === 2 && i === 0 ? zl + gap('l') : zr - gap('r') - leafW;
    const leaf = project.addPart(product, {
      kind: KIND.ZAD, group: 0, kod: leafRow.kod, name: leafRow.name, color: leafRow.color ?? '', title: 'Фасад двери', parent: zone.id,
      box: new Box(left, left + leafW, zt - gap('t') - leafH, zt - gap('t'), zg, zg + t),
      min: { x: 0, y: 0, z: t }, max: { x: 0, y: 0, z: t }, stenDver: -9, data: { door: true },
    });
    leaves.push(leaf);
    const pos = count === 2 ? (i === 0 ? cfg.handlePos.replace('L', 'R') : cfg.handlePos.replace(/R$/, 'L')) : cfg.handlePos;
    const handleLeft = pos.endsWith('L');
    if (handleRow) addHandle(project, product, zone, leaf, handleRow, pos);
    const hingeSide = handleLeft ? 'r' : 'l';
    const hinge = hingeRow(db, system, over[hingeSide], cfg.family);
    if (hinge) addHinges(project, product, zone, leaf, hinge, HINGE_KIND[over[hingeSide]], hingeSide, sides[hingeSide], hingeCount(zt - zb));
  }
  relayout(db, product);
  return leaves[0];
}

function addHandle(project, product, zone, leaf, row, pos) {
  const horizontal = pos.length === 3;
  const { sx, sy, sz } = handleSize(row, horizontal);
  const left = pos.endsWith('L') ? leaf.box.l + HANDLE_INSET : leaf.box.r - HANDLE_INSET - sx;
  let bottom = leaf.box.cy - sy / 2;
  if (pos[1] === 'B') bottom = leaf.box.b + HANDLE_INSET;
  if (pos[1] === 'T') bottom = leaf.box.t - HANDLE_INSET - sy;
  project.addPart(product, {
    kind: KIND.HANDLE, group: horizontal ? 1 : 2, kod: row.kod, name: row.name, color: row.color ?? '', title: row.name, parent: zone.id, casper: true,
    box: new Box(left, left + sx, bottom, bottom + sy, leaf.box.f, leaf.box.f + sz), data: { door: true },
  });
}

function addHinges(project, product, zone, leaf, row, kind, side, holder, count) {
  const x = side === 'l' ? (holder.kind >= 6 ? holder.box.r : leaf.box.l) : (holder.kind >= 6 ? holder.box.l : leaf.box.r) - 40;
  const top = leaf.box.t - HINGE_INSET;
  const bottom = leaf.box.b + HINGE_INSET;
  for (let i = 0; i < count; i++) {
    const cy = count === 1 ? leaf.box.cy : top - ((top - bottom) * i) / (count - 1);
    project.addPart(product, {
      kind, group: 2, kod: row.kod, name: row.name, color: row.color ?? '', parent: zone.id, casper: true,
      title: `${row.name} ( ${side === 'l' ? 'левые' : 'правые'} )`,
      box: new Box(x, x + 40, cy - 25, cy + 25, leaf.box.g - 12, leaf.box.g), data: { door: true },
    });
  }
}

export function removeAssembly(project, db, product, root) {
  removeAssemblies(project, db, product, [root]);
}

export function removeAssemblies(project, db, product, roots) {
  const ordered = [...roots].sort((a, b) => b.id - a.id);
  const doors = ordered.some((part) => part.kind === KIND.DOOR_ZONE)
    ? [...product.parts.values()].filter((part) => part.kind === KIND.DOOR_ZONE)
    : [];
  for (const root of ordered) {
    if (root.kind === KIND.DOOR_ZONE) {
      for (const cut of root.data.cuts ?? []) {
        const p = product.get(cut.id);
        if (!p) continue;
        const next = doors.filter((door) => product.parts.has(door.id))
          .flatMap((door) => door.data.cuts ?? []).find((entry) => entry.id === cut.id && entry.stenDver === root.id);
        if (next) {
          next.f = Math.max(next.f, cut.f);
          next.stenDver = cut.stenDver;
        } else {
          p.box.f = Math.max(p.box.f, cut.f);
          p.stenDver = cut.stenDver;
          resumeDrawerCuts(product, p);
        }
      }
    }
    if (DRAWER_KINDS.has(root.kind)) releaseDrawer(product, root);
    project.removePart(product, root);
  }
  relayout(db, product);
}
