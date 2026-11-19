import { SIDES, SIDE_NB, SIDE_AXIS } from './geom.js';
import { itemCost } from './price.js';

const TYPED_KINDS = new Set([6, 7, 8, 9, 16, 100, 101]);
const DEFAULT_KREP = { type: 'Евровинт', color: 'Натуральный', zag: 23005 };
export const ZAG_FALLBACK = 23006;

export function attachmentGap(db, side, kod, current) {
  const row = db.get(kod);
  if (!row) return SIDE_AXIS[side] === 'z' ? 0 : current;
  return row.krepGap === 'current' ? current : row.krepGap ?? 0;
}

export function productKrep(product, part) {
  const corpus = ['PL', 'PR', 'PB', 'PT'].some((r) => product.roles[r] === part.id);
  const type = corpus ? product.krepKor : product.krepNap;
  const color = corpus ? product.krepCr1 : product.krepCr2;
  if (!type && !color) return DEFAULT_KREP;
  return { type, color };
}

function matchesPart(row, part) {
  return row.krepForSet?.has(part.kind) && (!row.krepForKodSet || row.krepForKodSet.has(part.kod));
}

function nbAllowed(row, nb) {
  if (row.krepToSet && !(nb && row.krepToSet.has(nb.kod))) return false;
  if (row.krepToIdSet && !(nb && row.krepToIdSet.has(nb.kind))) return false;
  return true;
}

function penetration(row, part, nb, side) {
  const tw = row.techW;
  if (tw === '9999') return part.group === 0 || part.group === 2 ? part.thickness : 0;
  if (tw === '99945') return nb ? nb.box.size(SIDE_AXIS[side]) : 0;
  const n = Number(String(tw ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function loadKrep(db, product, part, only = null) {
  const wanted = TYPED_KINDS.has(part.kind) ? productKrep(product, part) : { type: '', color: '' };
  let candidates;
  for (const side of only === null ? SIDES : [only]) {
    part.ftex[side] = 0;
    if (!part.mount[side]) continue;
    const nb = product.get(part.nb[SIDE_NB[side]]);
    let row = db.get(part.krep[side]);
    if (!part.krep[side]) {
      candidates ??= db.krepFor(part.kind).filter((entry) =>
        matchesPart(entry, part) && entry.objTip !== 'Креп 0'
        && (!(entry.lMinT > 0) || part.min[part.thickAxis] >= entry.lMinT)
        && (!(entry.lMaxT > 0) || part.max[part.thickAxis] <= entry.lMaxT));
      for (const entry of candidates) {
        if (side === 'g' ? entry.objTip === 'Креп 1' : side !== 'f' && entry.objTip === 'Креп 2') continue;
        if (!nbAllowed(entry, nb)) continue;
        const preferred = wanted.type && entry.sub === wanted.type
          && (!wanted.color || entry.color === wanted.color) && entry.podrazdel !== 'Ручное';
        if (!row || preferred) row = entry;
      }
      if (row) part.krep[side] = row.kod;
    }
    if (row) part.ftex[side] = penetration(row, part, nb, side);
  }
}

export function krepForPart(db, part) {
  const catalog = db.krepCatalog();
  const names = new Set(catalog.filter((row) => matchesPart(row, part)).map((row) => row.name));
  return catalog.filter((row) => names.has(row.name));
}

export function krepChoices(db, product, part, side) {
  const nb = side ? product.get(part.nb[SIDE_NB[side]]) : null;
  const thickness = part.min[part.thickAxis];
  const rows = db.krepFor(part.kind).filter((row) => matchesPart(row, part));
  const names = new Set(rows.filter((row) =>
    (!(row.lMinT > 0) || row.lMinT < thickness)
    && (!(row.lMaxT > 0) || row.lMaxT > thickness)
    && (!side || nbAllowed(row, nb))).map((row) => row.name));
  return rows.filter((row) => names.has(row.name));
}

const EUROVINT_ARTS = new Set(['KON 5,0*50 IB', 'KON 5,0*50 IB + Шкант']);
const EUROVINT_ZAG = 8949;

export function resolveSostav(db, product, part, row) {
  const counts = new Map();
  const thin = part.thickness <= 14.01;
  for (let item of db.sostav(row)) {
    if (item === '22854' && !thin) continue;
    if (item === 'Заглушка') {
      let zag = product.isCorpus(part) ? product.zag1 : product.zag2;
      const zagRow = zag ? db.get(zag) : null;
      const eurovint = EUROVINT_ARTS.has(row.art);
      if (zagRow && zagRow.razdel !== 'Заглушки') zag = eurovint ? EUROVINT_ZAG : ZAG_FALLBACK;
      else if (zagRow && eurovint) zag = zagRow.link1 ?? 0;
      item = String(zag || 0);
    }
    const code = Number(item);
    if (Number.isInteger(code) && code > 0 && db.get(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

export function krepCount(db, part, side) {
  const row = db.get(part.krep[side]);
  if (!row) return 0;
  return Number.isInteger(row.qty) ? row.qty : 1;
}

export function kitCost(db, product, part, row, size = 0) {
  let cost = itemCost(db, { ...row, sostav: '' }, size);
  if (row.unit === 'шт.') return cost;
  for (const [code, times] of resolveSostav(db, product, part, row)) {
    const sub = db.get(code);
    cost += itemCost(db, sub, size) * (Number.isInteger(sub.qty) ? sub.qty : 1) * times;
  }
  return cost;
}
