import { AXIS_SIDES, edgeSides, SIDE_NB, EPS, OPPOSITE } from './geom.js';
import { KIND, isPanel } from './model.js';

const NACH_COLOR_KINDS = new Set([8, 9, 16, 26, 100, 101, 102]);
const FIRMA_TAG_KINDS = new Set([8, 9, 16]);
const E_EDGE_DOP = new Set(['ДСП', 'ДСП не в крое', 'Монолит']);
const EDGE_CLASS = { 19: 1, 28: 2, 29: 2, 35: 3 };
const MATERIAL_AXES = {
  0: { x: 'W', y: 'H', z: 'T' },
  1: { x: 'H', y: 'T', z: 'W' },
  2: { x: 'T', y: 'H', z: 'W' },
};

export function normFirma(firma) {
  if (firma === 'ЛАМАРТИ СТАНДАРТ' || firma === 'ЛАМАРТИ ЗАКАЗ') return 'ЛАМАРТИ';
  if (firma === 'ЭГГЕР ЗАКАЗ') return 'ЭГГЕР';
  return firma ?? '';
}

export function findMaterial(db, product, part) {
  if (part.kod > 0) return db.get(part.kod);
  let color = part.color;
  let tag = normFirma(part.tag);
  if (!color && NACH_COLOR_KINDS.has(part.kind) && product.nachColor) {
    const ownTag = FIRMA_TAG_KINDS.has(part.kind) && tag && tag !== '#' && tag !== normFirma(product.firma);
    if (!ownTag) {
      color = product.nachColor;
      if (part.kind < 100) tag = tag === '#' ? '' : normFirma(product.firma);
    }
  }
  if (tag === '#') tag = '';
  const thick = Math.round(part.catalogThickness * 100) / 100;
  for (const row of db.byPos(part.kind)) {
    if (color && row.color !== color) continue;
    if (tag && !(row.name ?? '').includes(tag)) continue;
    if (row.t === thick) return row;
  }
  return null;
}

export function applyMaterial(db, product, part) {
  const row = findMaterial(db, product, part);
  if (!row) return null;
  part.kod = row.kod;
  part.name = row.name;
  part.color = row.color ?? '';
  return row;
}

export function materialLimits(db, part) {
  const row = isPanel(part) && db.get(part.kod);
  const axes = MATERIAL_AXES[part.group];
  if (!row || !axes) return { min: part.min, max: part.max };
  const limits = (key) => Object.fromEntries(Object.entries(axes).map(([axis, field]) =>
    [axis, row[key + field] ?? part[key][axis]]));
  return { min: limits('min'), max: limits('max') };
}

export function replacePartMaterial(part, row, anchor) {
  const axis = part.thickAxis;
  if (row.t !== part.catalogThickness) {
    const [lo, hi] = AXIS_SIDES[axis];
    part.box.setSize(axis, row.t, anchor ?? (part.mount[hi] ? hi : lo));
    part.min[axis] = part.max[axis] = row.t;
  }
  part.kod = row.kod;
  part.name = row.name;
  part.color = row.color ?? '';
  part.tag = '';
}

export function defaultEdges(row, useKromE) {
  let s2 = row.krom2 ?? 0;
  let s = 0;
  if (useKromE && E_EDGE_DOP.has(row.dop) && row.krom3) { s = row.krom3; s2 = s; }
  if (s === 0 || !useKromE || !E_EDGE_DOP.has(row.dop)) s = row.krom1 ?? 0;
  if (s2 === 0) s2 = s;
  return { main: s, back: s2 };
}

export function edgeFits(edgeRow, thick) {
  const kM = Math.trunc(thick / 10);
  const cls = edgeRow.h === 999 ? kM : EDGE_CLASS[edgeRow.h] ?? -100;
  return cls === kM && thick > 10.001;
}

export function loadEdges(db, product, part) {
  const row = db.get(part.kod);
  if (!row) return;
  const def = defaultEdges(row, product.useKromE);
  const thick = part.catalogThickness;
  const allowed = db.edgesFor(part.kind);
  for (const side of edgeSides(part.group)) {
    part.fixKr[side] = 0;
    part.edgeKod[side] = 0;
    let code = part.edge[side];
    if (code < 0) continue;
    if (code === 0) code = side === 'g' ? def.back : def.main;
    const edgeRow = db.get(code);
    if (!edgeRow || !allowed.includes(edgeRow) || !edgeFits(edgeRow, thick)) continue;
    part.edgeKod[side] = edgeRow.kod;
    part.fixKr[side] = edgeRow.t ?? 0;
  }
}

export function applyEdges(product, part) {
  const thinBack = part.kind === KIND.ZAD && part.thickness < 7;
  for (const side of edgeSides(part.group)) {
    part.kr[side] = 0;
    if (thinBack || part.edge[side] < 0 || !part.edgeKod[side]) continue;
    const nb = product.get(part.nb[SIDE_NB[side]]);
    const touching = nb && nb.kind >= 6 && Math.abs(part.box[side] - nb.box[OPPOSITE[side]]) < EPS;
    if (touching && !part.edgeForce[side]) continue;
    part.kr[side] = part.fixKr[side];
  }
}

export function edgeChoices(db, part) {
  const thick = part.catalogThickness;
  return db.edgesFor(part.kind).filter((r) => edgeFits(r, thick));
}

export const frontEdgeInset = (part) => part.kr.f >= 1.9 ? part.kr.f : 0;

export function canUsePartMaterial(db, product, part, row) {
  if (!isPanel(part) || !row?.posSet?.has(part.kind) || !db.forProduct(row) || row.unit !== 'м2' || !(row.t > 0)) return false;
  if (row.t === part.catalogThickness) return true;
  const [lo, hi] = AXIS_SIDES[part.thickAxis];
  if (part.parent || part.stenDver !== -1 || (part.mount[lo] && part.mount[hi])) return false;
  for (const other of product.parts.values()) {
    if (other.data.drawer && !other.parent && Object.values(other.nb).includes(part.id)) return false;
  }
  return true;
}
