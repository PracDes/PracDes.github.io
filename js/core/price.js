import { AXIS_SIDES, edgeSides, SIDE_AXIS } from './geom.js';

const M2_KIT_KINDS = new Set([6, 7, 8, 9, 16, 18, 118, 23, 24, 73, 74, 75, 78]);
const PLANE_AXES = { 0: ['x', 'y'], 1: ['x', 'z'], 2: ['y', 'z'] };

export function priceUnit(part, row) {
  if (row.unit === 'к-т' && row.unit2 === 'м2' && M2_KIT_KINDS.has(part.kind)) return 'м2';
  return row.unit ?? '';
}

function ftexSum(part, axis) {
  const [lo, hi] = AXIS_SIDES[axis];
  return part.ftex[lo] + part.ftex[hi];
}

function krSum(part, axis) {
  const [lo, hi] = AXIS_SIDES[axis];
  return part.kr[lo] + part.kr[hi];
}

export function grossSize(part) {
  const [a, b] = PLANE_AXES[part.group] ?? PLANE_AXES[0];
  return { a: part.box.size(a) + ftexSum(part, a), b: part.box.size(b) + ftexSum(part, b) };
}

export function netSize(part) {
  const [a, b] = PLANE_AXES[part.group] ?? PLANE_AXES[0];
  const g = grossSize(part);
  return { a: g.a - krSum(part, a), b: g.b - krSum(part, b) };
}

export function area(part) {
  const n = netSize(part);
  return (n.a / 1000) * (n.b / 1000);
}

export function edgeLength(part, side) {
  const [a, b] = PLANE_AXES[part.group] ?? PLANE_AXES[0];
  const along = SIDE_AXIS[side] === a ? b : a;
  return (part.box.size(along) + ftexSum(part, along)) / 1000;
}

function edgeUnitPrice(part, edgeRow) {
  return edgeRow.unit === 'м2' ? edgeRow.price * (part.thickness / 1000) : edgeRow.price;
}

export function edgeList(db, part) {
  const out = [];
  for (const side of edgeSides(part.group)) {
    if (part.kr[side] <= 0 || part.edge[side] < 0) continue;
    const row = db.get(part.edgeKod[side]);
    if (!row) continue;
    const length = edgeLength(part, side);
    out.push({ side, row, length, cost: edgeUnitPrice(part, row) * length });
  }
  return out;
}

export function edgeCost(db, part) {
  return edgeList(db, part).reduce((s, e) => s + e.cost, 0);
}

export function materialCost(db, part) {
  const row = db.get(part.kod);
  if (!row) return 0;
  const unit = priceUnit(part, row);
  if (unit === 'м2' || unit === 'кг') return row.price * area(part);
  if (unit === 'м') {
    return row.price * netSize(part).a / 1000;
  }
  return row.price;
}

export function partCost(db, part) {
  const row = db.get(part.kod);
  if (!row) return { total: 0, material: 0, edges: 0 };
  const material = materialCost(db, part);
  const edges = priceUnit(part, row) === 'шт.' ? 0 : edgeCost(db, part);
  return { total: Math.max(0, material + edges), material, edges };
}

export function itemCost(db, row, size = 0, depth = 0) {
  if (!row) return 0;
  let cost = row.price;
  if (row.unit === 'м2') cost = row.price * ((size || 20) / 1000) * (20 / 1000);
  else if (row.unit === 'м') cost = row.price * ((size || 20) / 1000);
  if (row.unit !== 'шт.' && depth < 4) {
    for (const item of db.sostav(row)) {
      const sub = db.get(Number(item));
      if (!sub) continue;
      cost += itemCost(db, sub, size, depth + 1) * (Number.isInteger(sub.qty) ? sub.qty : 1);
    }
  }
  return cost;
}
