import { SIDES, edgeSides } from './geom.js';
import { KIND } from './model.js';
import { DRAWER_KINDS } from './drawers.js';
import { grossSize, netSize, partCost, edgeList, priceUnit, itemCost } from './price.js';
import { resolveSostav, kitCost, krepCount } from './krep.js';

const REPORT_NO = 2;

const fmt = (v, digits) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
export const money = (v) => fmt(v, 2);
const qty3 = (v) => fmt(v, 3);
const size = (v) => String(Math.round(v * 10) / 10).replace('.', ',');

function inReport(row) {
  const flags = row?.reports ?? '';
  return flags.length < REPORT_NO || flags[REPORT_NO - 1] === '1';
}

function uniqueJoin(values) {
  return [...new Set(values.filter(Boolean))].join(', ');
}

function detailKey(part, gross) {
  const edges = edgeSides(part.group).map((s) => `${part.kr[s] > 0 ? part.edgeKod[s] : 0}`).join('.');
  return [part.kod, part.title, part.group, size(gross.a), size(gross.b), edges, SIDES.map((s) => part.ftex[s]).join('.')].join('|');
}

function collectDetails(db, product) {
  const groups = new Map();
  for (const part of product.realParts()) {
    const row = db.get(part.kod);
    if (!row || part.excluded || (part.hidden && !DRAWER_KINDS.has(part.kind))) continue;
    if (!inReport(row)) continue;
    const gross = grossSize(part);
    const key = detailKey(part, gross);
    let g = groups.get(key);
    if (!g) { g = { part, row, gross, count: 0 }; groups.set(key, g); }
    g.count += part.qty * product.count;
  }
  return [...groups.values()];
}

function collectKrep(db, product) {
  const groups = new Map();
  for (const part of product.realParts()) {
    if (part.excluded) continue;
    for (const side of SIDES) {
      if (!part.mount[side] || !part.krep[side]) continue;
      const row = db.get(part.krep[side]);
      if (!row) continue;
      const sostav = resolveSostav(db, product, part, row);
      const key = [row.kod, [...sostav].map(([k, n]) => `${k}x${n}`).join(',')].join('|');
      let g = groups.get(key);
      if (!g) { g = { row, part, sostav, count: 0 }; groups.set(key, g); }
      g.count += krepCount(db, part, side) * part.qty * product.count;
    }
  }
  return [...groups.values()].filter((g) => g.count > 0);
}

export function productReport(db, product, prefix) {
  const rows = [];
  let total = 0;
  let pos = 0;
  for (const d of collectDetails(db, product)) {
    pos += 1;
    const num = prefix + pos;
    const hardware = d.part.kind >= 1000 || d.part.kind === KIND.GUIDE || DRAWER_KINDS.has(d.part.kind);
    const cost = hardware ? { total: kitCost(db, product, d.part, d.row), edges: 0 } : partCost(db, d.part);
    const sum = cost.total * d.count;
    total += sum;
    const sized = d.row.unit !== 'шт.' && !hardware;
    rows.push({
      type: 'row', cells: [num, d.part.title || d.row.name, d.row.art ?? '', sized ? size(d.gross.a) : '', sized ? size(d.gross.b) : '', d.row.color ?? '',
        hardware ? d.row.unit ?? 'шт.' : 'шт.', String(d.count), money(sum)],
    });
    if (hardware) {
      let m = 0;
      const length = Math.max(d.part.box.sx, d.part.box.sy, d.part.box.sz);
      const subRow = (sub, n, sum) => {
        m += 1;
        const metric = sub.unit === 'м';
        rows.push({ type: 'sub', cells: [`${num}.${m}`, sub.name, sub.art ?? '', metric ? size(length) : '', '', sub.color ?? '', sub.unit ?? 'шт.', metric ? qty3(n * length / 1000) : String(n), money(sum)] });
      };
      for (const [code, times] of resolveSostav(db, product, d.part, d.row)) {
        const sub = db.get(code);
        const n = (Number.isInteger(sub.qty) ? sub.qty : 1) * times * d.count;
        subRow(sub, n, itemCost(db, sub, length) * n);
      }
      for (const [code, times] of db.komplekt(d.row)) {
        const sub = db.get(code);
        const n = times * d.count;
        const sum = itemCost(db, sub, length) * n;
        total += sum;
        subRow(sub, n, sum);
      }
      continue;
    }
    const edges = edgeList(db, d.part);
    const edgeSum = cost.edges * d.count;
    if (edges.length && edgeSum > 0) {
      rows.push({
        type: 'sub', cells: [num + '.0', uniqueJoin(edges.map((e) => e.row.name)), uniqueJoin(edges.map((e) => e.row.art)), '', '',
          uniqueJoin(edges.map((e) => e.row.color)), 'м', qty3(edges.reduce((s, e) => s + e.length, 0) * d.count), money(edgeSum)],
      });
    }
    if (priceUnit(d.part, d.row) === 'м2') {
      const net = netSize(d.part);
      const matSum = sum - edgeSum;
      if (matSum > 0.005) {
        rows.push({
          type: 'sub', cells: [num + '.1', d.part.title || d.row.name, d.row.art ?? '', '', '', d.row.color ?? '', 'м2',
            qty3(d.count * (net.a / 1000) * (net.b / 1000)), money(matSum)],
        });
      }
    }
  }
  for (const k of collectKrep(db, product)) {
    const main = inReport(k.row);
    let num = '';
    if (main) {
      pos += 1;
      num = `${product.num}-${pos}`;
      const sum = kitCost(db, product, k.part, k.row) * k.count;
      total += sum;
      rows.push({
        type: 'row', cells: [num, k.row.name, k.row.art ?? '', k.row.w != null ? size(k.row.w) : '', k.row.h != null ? size(k.row.h) : '', k.row.color ?? '',
          k.row.unit ?? '', String(k.count), money(sum)],
      });
    }
    let m = 0;
    for (const [code, times] of k.sostav) {
      const sub = db.get(code);
      const n = (Number.isInteger(sub.qty) ? sub.qty : 1) * times * k.count;
      const sum = itemCost(db, sub) * n;
      m += 1;
      if (main) {
        rows.push({ type: 'sub', cells: [`${num}.${m}`, sub.name, sub.art ?? '', '', '', sub.color ?? '', 'шт.', String(n), money(sum)] });
      } else {
        pos += 1;
        total += sum;
        rows.push({ type: 'row', cells: [`${product.num}-${pos}`, sub.name, sub.art ?? '', '', '', sub.color ?? '', 'шт.', String(n), money(sum)] });
      }
    }
  }
  return { rows, total };
}

export function projectReport(db, project) {
  const many = project.products.length > 1;
  const blocks = [];
  let grand = 0;
  for (const product of project.products) {
    const r = productReport(db, product, many ? `${product.num}-` : '');
    grand += r.total;
    blocks.push({ product, rows: r.rows, total: r.total });
  }
  return { blocks, total: grand };
}

export function projectTotal(db, project) {
  return projectReport(db, project).total;
}
