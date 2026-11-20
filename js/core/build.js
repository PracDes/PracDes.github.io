import { Box, SIDES, SIDE_NB, OPPOSITE, AXIS_SIDES, GROUP_THICK_AXIS, sideMap } from './geom.js';
import { KIND, isPanel, Part } from './model.js';
import { findNeighbors, opora, neighbors, OPENING_SUPPORTS } from './opora.js';
import { applyMaterial, loadEdges, applyEdges, frontEdgeInset } from './material.js';
import { loadKrep } from './krep.js';
import { reflowDrawers } from './drawers.js';

export const KREP_PAZ = 19489;
export const KREP_CHETVERT = 22934;
export const KREP_ZAD_MINIFIX = 30640;
export const PAZ_OTSTUP = 12;
const CURSOR = 0.1;
const TUBE_KINDS = new Set([11, 13, 211, 213]);

export class BuildError extends Error {}

const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(',', '.')));

export function cursorBox(point) {
  return Box.fromCenter(point.x, point.y, point.z, CURSOR, CURSOR, CURSOR);
}

export function placementNeighbors(product, point, selfId = 0) {
  return point.supportIds ?? findNeighbors(product, cursorBox(point), selfId);
}

export function productCursorWheelDelta(product, point, delta) {
  const ids = placementNeighbors(product, point);
  const front = Math.min(...OPENING_SUPPORTS.map((side) => product.get(ids[side]).box.f));
  return delta * Math.max(0.5, Math.abs(front - cursorBox(point).f)) / 2000;
}

function defaultMounts(part, item, cur, nb) {
  const w = numOrNull(item.W);
  const h = numOrNull(item.H);
  if (part.group === 0) Object.assign(part.mount, { l: true, r: true, b: true, t: true });
  else if (part.group === 1) {
    if (w !== null) {
      const right = cur.l - nb.x1.box.r > nb.x2.box.l - cur.r;
      part.mount.l = !right; part.mount.r = right;
    } else { part.mount.l = true; part.mount.r = true; }
  } else if (part.group === 2) {
    if (h !== null) {
      const top = cur.b - nb.y1.box.t > nb.y2.box.b - cur.t;
      part.mount.b = !top; part.mount.t = top;
    } else { part.mount.b = true; part.mount.t = true; }
  } else if (part.group === 3 || part.group === 4) { part.mount.l = true; part.mount.r = true; }
}

function frontInset(part, nb) {
  const across = [nb.x1, nb.x2];
  const vertical = [nb.y1, nb.y2];
  const supports = part.group === 1 ? across : part.group === 0 ? [...across, ...vertical] : vertical;
  return Math.max(...supports.map(frontEdgeInset));
}

export function clampSize(part) {
  for (const axis of ['x', 'y', 'z']) {
    const min = part.min[axis];
    if (min > 0 && part.box.size(axis) < min) part.box.setSize(axis, min, AXIS_SIDES[axis][0]);
  }
  const { kind, group } = part;
  const longX = [6, 8, 16, 100, 102, 161].includes(kind);
  const longY = [7, 9, 16, 102, 161].includes(kind);
  if (!longX && part.max.x > 0 && part.box.sx > part.max.x) part.box.setSize('x', part.max.x, 'l');
  if (!longY && part.max.y > 0 && part.box.sy > part.max.y) part.box.setSize('y', part.max.y, 'b');
  if (part.max.z > 0 && part.box.sz > part.max.z && !(group === 0 && isPanel(part))) part.box.setSize('z', part.max.z, 'g');
}

export function fit(product, part) {
  if (part.casper || part.stenDver === -9) return;
  opora(product, part);
  const nb = neighbors(product, part.nb);
  const grab = (s) => (part.grab[s] !== -1 ? part.grab[s] : 0);
  const held = (s) => part.mount[s] || part.grab[s] !== -1;
  const spans = { x: ['l', 'r', nb.x1, nb.x2], y: ['b', 't', nb.y1, nb.y2], z: ['g', 'f', nb.z1, nb.z2] };
  for (const [axis, [lo, hi, n1, n2]] of Object.entries(spans)) {
    const free = n2.box[lo] - n1.box[hi] - grab(lo) - grab(hi);
    if (free <= 0) { if (held(lo) && held(hi)) part.box.setSize(axis, 0, lo); continue; }
    if (part.box.size(axis) > free || (held(lo) && held(hi))) part.box.setSize(axis, free, lo);
  }
  clampSize(part);
  for (const [, [lo, hi, n1, n2]] of Object.entries(spans)) {
    if (held(hi)) part.box.moveSide(hi, n2.box[lo] - grab(hi));
    if (held(lo)) part.box.moveSide(lo, n1.box[hi] + grab(lo));
  }
}

export function refresh(db, product, part) {
  opora(product, part);
  loadKrep(db, product, part);
  loadEdges(db, product, part);
  applyEdges(product, part);
}

export function relayout(db, product, options) {
  for (let pass = 0; pass < 2; pass++) {
    for (const part of product.parts.values()) {
      if (part.kind >= 6 && !part.parent) fit(product, part);
    }
  }
  reflowDrawers(db, product, options);
  for (const part of product.parts.values()) if (part.kind >= 6) refresh(db, product, part);
}

export function catalogSizeLimits(item) {
  const limits = (prefix) => Object.fromEntries([['x', 'W'], ['y', 'H'], ['z', 'G']]
    .map(([axis, key]) => [axis, numOrNull(item[prefix + key]) ?? 0]));
  return { min: limits('Min'), max: limits('Max') };
}

function preparePanel(db, product, { kind, group, kod = 0, tag = '', name = '', title = '', item = {}, parent = 0 }) {
  const part = new Part({ kind, group, kod, tag, name, title, parent, ...catalogSizeLimits(item) });
  if (kod > 0) {
    const row = db.get(kod);
    if (!row) throw new BuildError(`Материал с кодом ${kod} не найден в прайсе`);
    const axis = GROUP_THICK_AXIS[group];
    part.min[axis] = row.t; part.max[axis] = row.t;
  }
  if (!applyMaterial(db, product, part)) {
    const what = product.nachColor ? ` (цвет «${product.nachColor}», толщина ${part.catalogThickness} мм)` : '';
    throw new BuildError(`Для «${item.name ?? title}» нет материала в прайсе${what}`);
  }
  const row = db.get(part.kod);
  if (row.unit === 'к-т' && row.sostav) {
    throw new BuildError(`«${row.name}» — составная склейка, на сайте пока не поддерживается`);
  }
  if (isPanel(part) && (product.kromkaNap > 0) && !kod) for (const s of SIDES) part.edge[s] = product.kromkaNap;
  return part;
}

function newPanel(project, db, product, spec) {
  return project.addPart(product, preparePanel(db, product, spec));
}

function depthSpan(part, nb, spanning) {
  let g = nb.z1.box.f;
  let f = nb.z2.box.g;
  const limit = (p) => { g = Math.max(g, p.box.g); f = Math.min(f, p.box.f); };
  if (spanning) {
    for (const [side, other] of [[nb.x1, nb.y1], [nb.x2, nb.y2]]) {
      if (TUBE_KINDS.has(side.kind)) continue;
      limit(side);
      if (part.group !== 1) limit(other);
    }
  } else { limit(nb.y1); limit(nb.y2); }
  return { g, f };
}

const THICK_KEY = { 0: 'G', 1: 'H', 2: 'W' };

export function planBox(product, item, point, self = null) {
  const cur = cursorBox(point);
  const nb = neighbors(product, placementNeighbors(product, point, self?.id ?? 0));
  const probe = self ?? { group: item.group, mount: sideMap(false), max: { x: 0, y: numOrNull(item.MaxH) ?? 0, z: 0 }, id: 0, casper: false };
  defaultMounts(probe, item, cur, nb);
  const inset = frontInset(probe, nb);
  const w = numOrNull(item.W);
  const h = numOrNull(item.H);
  const g = numOrNull(item.G);
  let sx = w === null ? nb.x2.box.l - nb.x1.box.r : w;
  let sy = h === null ? nb.y2.box.b - nb.y1.box.t : h;
  if (item.group === 2 && probe.max.y > 0 && sy > probe.max.y) sy = probe.max.y;
  const b = w === null && h !== null ? point.y - sy / 2 : nb.y1.box.t;
  const l = h === null && w !== null ? point.x - sx / 2 : nb.x1.box.r;
  const box = new Box(l, l + sx, b, b + sy, point.z - CURSOR / 2, point.z + CURSOR / 2);
  const own = neighbors(product, findNeighbors(product, box, probe.id));
  const spanning = w === null;
  const span = depthSpan(probe, own, spanning);
  const fixed = spanning
    ? (own.x1.kind !== KIND.WALL && probe.mount.l) || (own.x2.kind !== KIND.WALL && probe.mount.r)
    : (own.y1.kind !== KIND.FLOOR_WALL && probe.mount.b) || (own.y2.kind !== KIND.WALL && probe.mount.t);
  const sz = g !== null ? g : span.f - span.g - (fixed ? inset : 0);
  box.g = span.g; box.f = span.g + sz;
  if (w !== null && h !== null) {
    box.moveCenter('x', point.x).moveCenter('y', point.y);
    if (g !== null) box.moveCenter('z', point.z);
  }
  if (item.id === KIND.ZAD) {
    const back = Math.max(own.z1.box.f, own.x1.box.g, own.x2.box.g, own.y1.box.g, own.y2.box.g);
    box.moveSide('g', back);
  }
  if (item.anchorSide) {
    const side = item.anchorSide;
    box.moveSide(side, nb[SIDE_NB[side]].box[OPPOSITE[side]]);
    const front = span.f - (fixed ? inset : 0);
    box.f = front;
    box.g = Math.max(span.g, front - sz);
  }
  return { box, mount: probe.mount, valid: box.sx >= 1 && box.sy >= 1 && box.sz >= 1 };
}

export function previewBox(product, item, point) {
  const key = THICK_KEY[item.group];
  const sized = item[key] ? item : { ...item, [key]: item['Max' + key] };
  return planBox(product, sized, point);
}

const TITLES = { [KIND.ZAD]: 'Задний щит', [KIND.POLKA]: 'Полка', [KIND.PEREG]: 'Перегородка', [KIND.BOK]: 'Боковой щит' };

export function planPanelInsertion(db, product, item, point) {
  const part = preparePanel(db, product, { kind: item.id, group: item.group, tag: item.tag ?? '', name: item.name, item, kod: numOrNull(item.kod) ?? 0 });
  const key = THICK_KEY[item.group];
  const plan = planBox(product, { ...item, [key]: item[key] || String(part.catalogThickness) }, point, part);
  if (!plan.valid) throw new BuildError('В этом месте деталь не помещается');
  part.box = plan.box;
  part.title = item.title ?? TITLES[item.id] ?? item.name.trim();
  if (item.edge > 0) for (const side of SIDES) part.edge[side] = item.edge;
  if (item.id === KIND.ZAD && part.thickness < 15) for (const s of ['l', 'r', 'b', 't']) part.krep[s] = KREP_PAZ;
  fit(product, part);
  return part;
}

export function place(project, db, product, item, point) {
  const part = project.addPart(product, planPanelInsertion(db, product, item, point));
  try {
    relayout(db, product);
    return part;
  } catch (e) {
    project.removePart(product, part);
    relayout(db, product);
    throw e;
  }
}

function setEdges(db, product, part, code) {
  for (const s of ['f', 'l', 'r', 'b', 't']) part.edge[s] = code;
  part.edge.g = 0;
  loadEdges(db, product, part);
  opora(product, part);
  applyEdges(product, part);
}

function corpusPanel(project, db, product, { kind, group, kod, title, role, edge }) {
  const part = newPanel(project, db, product, { kind, group, kod, title });
  part.role = role;
  product.roles[role] = part.id;
  const { W, H, G } = product;
  const t = part.catalogThickness;
  const c = cursorBox({ x: W / 2, y: H / 2, z: G / 2 });
  const nb = neighbors(product, findNeighbors(product, c));
  if (kind === KIND.POL) {
    part.box = new Box(nb.x1.box.r, nb.x2.box.l, H / 2 - t / 2, H / 2 + t / 2, c.g, c.f);
    opora(product, part);
    const own = neighbors(product, part.nb);
    part.box.g = own.z1.box.f; part.box.f = own.z2.box.g;
    part.mount.l = true; part.mount.r = true;
  } else if (kind === KIND.BOK) {
    part.box = new Box(W / 2 - t / 2, W / 2 + t / 2, nb.y1.box.t, nb.y2.box.b, c.g, c.f);
    opora(product, part);
    const own = neighbors(product, part.nb);
    part.box.g = own.z1.box.f; part.box.f = own.z2.box.g;
    part.mount.b = true; part.mount.t = true;
  }
  if (edge !== undefined) setEdges(db, product, part, edge);
  return part;
}

function real(part) { return part && part.kind >= 6; }

export function buildCorpus(project, db, product, form) {
  const { W, H, G } = product;
  const P = form.parts;
  const podium = form.floorType === 'podium';
  const withLegs = form.floorType === 'podium-legs';
  const kepka = form.roofType === 'kepka' ? { vylet: Number(form.kepkaFront) || 0, zad: Number(form.kepkaBack) || 0 } : null;
  const roles = () => ({ PL: product.role('PL'), PR: product.role('PR'), PB: product.role('PB'), PT: product.role('PT') });
  const sideDepthInset = (support) => support.kr.f > 1.1 ? support.kr.f : 0;

  if (P.floor.on && (form.floorType === 'nakl' || withLegs)) {
    const pb = corpusPanel(project, db, product, { kind: KIND.POL, group: 1, kod: P.floor.kod, title: 'Пол', role: 'PB', edge: P.floor.edge });
    pb.mount.l = false; pb.mount.r = false;
    if (withLegs) pb.box.moveSide('t', Number(form.podiumLegHeight ?? 100));
    else pb.box.moveSide('b', 0);
    if (kepka) { pb.box.g += kepka.zad; pb.box.f = G - kepka.vylet; }
    setEdges(db, product, pb, P.floor.edge);
  }
  if (P.roof.on && form.roofType !== 'vkl') {
    const pt = corpusPanel(project, db, product, { kind: KIND.POL, group: 1, kod: P.roof.kod, title: 'Крыша', role: 'PT', edge: P.roof.edge });
    pt.mount.l = false; pt.mount.r = false;
    pt.box.moveSide('t', H);
    setEdges(db, product, pt, P.roof.edge);
  }
  for (const [key, role, title] of [['left', 'PL', 'Левая боковина'], ['right', 'PR', 'Правая боковина']]) {
    if (!P[key].on) continue;
    const side = corpusPanel(project, db, product, { kind: KIND.BOK, group: 2, kod: P[key].kod, title, role, edge: P[key].edge });
    const { PB, PT } = roles();
    const own = neighbors(product, side.nb);
    side.mount.b = real(own.y1); side.mount.t = real(own.y2);
    const outer = key === 'left' ? 'l' : 'r';
    const shift = (real(PB) ? PB.kr[outer] : 0) || (real(PT) ? PT.kr[outer] : 0);
    side.box.moveSide(outer, key === 'left' ? shift : W - shift);
    const g0 = side.box.g;
    let tj = 0;
    if (real(PT)) {
      tj = kepka ? kepka.vylet + kepka.zad : sideDepthInset(PT);
      const sz = PT.box.f - g0 - tj;
      side.box.g = g0 + (kepka ? kepka.zad : 0);
      side.box.f = side.box.g + sz;
    }
    if (real(PB) && tj === 0 && (form.floorType === 'nakl' || withLegs)) side.box.f = PB.box.f - sideDepthInset(PB);
    setEdges(db, product, side, P[key].edge);
  }
  if (P.roof.on && form.roofType === 'vkl') {
    const pt = corpusPanel(project, db, product, { kind: KIND.POL, group: 1, kod: P.roof.kod, title: 'Крыша', role: 'PT', edge: P.roof.edge });
    const own = neighbors(product, pt.nb);
    for (const [n, s] of [[own.x1, 'l'], [own.x2, 'r']]) {
      if (!real(n)) { pt.mount[s] = false; continue; }
      n.edge.t = 0; n.edgeForce.t = true;
      pt.box.g = n.box.g; pt.box.f = n.box.f;
    }
    pt.box.moveSide('t', H);
    setEdges(db, product, pt, P.roof.edge);
  }
  if (P.floor.on && (form.floorType === 'vkl' || podium)) {
    const pb = corpusPanel(project, db, product, { kind: KIND.POL, group: 1, kod: P.floor.kod, title: podium ? 'Подиум пол' : 'Пол', role: 'PB', edge: P.floor.edge });
    const own = neighbors(product, pb.nb);
    pb.box.moveSide('b', Math.max(0, real(own.x1) ? own.x1.box.b : 0, real(own.x2) ? own.x2.box.b : 0));
    for (const [n, s] of [[own.x1, 'l'], [own.x2, 'r']]) {
      if (!real(n)) { pb.mount[s] = false; continue; }
      if (product.podvesnoi) { n.edge.b = 0; n.edgeForce.b = true; }
      pb.box.g = Math.max(pb.box.g, n.box.g); pb.box.f = Math.min(pb.box.f, n.box.f);
    }
    if (podium) pb.box.moveSide('t', Number(form.podiumHeight ?? 100));
    setEdges(db, product, pb, P.floor.edge);
  }
  if (P.back.on) buildBack(project, db, product, form);

  const n = Math.max(1, Number(form.otseki) || 1);
  if (n > 1) buildOtseki(project, db, product, n);
  if (P.floor.on && (podium || withLegs)) buildPlinth(project, db, product, form, withLegs);
  relayout(db, product);
}

function buildPlinth(project, db, product, form, withLegs) {
  const floor = product.role('PB');
  const { l, r, b, g, f } = floor.box;
  const t = floor.catalogThickness;
  const board = (title, box, group = 0) => {
    const part = newPanel(project, db, product, { kind: group === 2 ? KIND.PEREG : KIND.ZAD, group,
      kod: floor.kod, title, parent: floor.id });
    part.box = box;
    part.stenDver = -9;
    setEdges(db, product, part, form.parts.floor.edge);
  };
  const front = f - 10;
  board('Лицевой цоколь', new Box(l, r, 0, b, front - t, front));
  if (!withLegs && product.G >= 599.9) {
    const rear = g + 50;
    board('Задний цоколь', new Box(l, r, 0, b, rear, rear + t));
    board('Перегородка подиума', new Box(floor.box.cx - t / 2, floor.box.cx + t / 2, 0, b, rear + t, front - t), 2);
  }
  if (!withLegs) return;
  if (form.podiumLeft) board('Левый цоколь', new Box(l, l + t, 0, b, g, front - t), 2);
  if (form.podiumRight) board('Правый цоколь', new Box(r - t, r, 0, b, g, front - t), 2);
  const leg = db.get(b > 100.1 ? 26752 : 2606);
  if (!leg) return;
  const legSize = 24;
  const inside = Math.min(50 + legSize / 2, (r - l) / 2);
  const support = [l + inside, r - inside];
  const backInset = Math.min(50 + legSize / 2, (f - g) / 2);
  const count = Math.floor((r - l) / 1000);
  for (let i = 1; i <= count; i++) support.push(l + (r - l) * i / (count + 1));
  for (const x of new Set(support)) {
    for (const z of new Set([g + backInset, f - backInset])) {
      project.addPart(product, { kind: KIND.HARDWARE, parent: floor.id, casper: true, kod: leg.kod, name: leg.name,
        title: leg.name, box: Box.fromCenter(x, b / 2, z, legSize, b, legSize) });
    }
  }
}

function buildBack(project, db, product, form) {
  const { W, H, G } = product;
  const P = form.parts;
  const pg = newPanel(project, db, product, { kind: KIND.ZAD, group: 0, kod: P.back.kod, title: 'Задняя стенка' });
  pg.role = 'PG';
  product.roles.PG = pg.id;
  Object.assign(pg.mount, { l: true, r: true, b: true, t: true });
  let tj = 0;
  for (const r of ['PL', 'PR', 'PB', 'PT']) { const p = product.role(r); if (real(p)) tj = Math.max(tj, p.box.g); }
  const krep = { 0: KREP_PAZ, 1: KREP_CHETVERT, 3: KREP_ZAD_MINIFIX }[form.backType] ?? 0;
  if (form.backType === 0) tj += PAZ_OTSTUP;
  for (const s of ['l', 'r', 'b', 't']) pg.krep[s] = krep;
  const t = pg.catalogThickness;
  pg.box = new Box(W / 2 - 1, W / 2 + 1, H / 2 - 1, H / 2 + 1, tj, tj + t);
  for (const s of SIDES) pg.edge[s] = P.back.edge;
  fit(product, pg);
  if (form.backType === 2) zadToNaklad(product, pg);
  return pg;
}

function zadToNaklad(product, pg) {
  opora(product, pg);
  const nb = neighbors(product, pg.nb);
  const over = {};
  let tz = null;
  for (const [side, n, axis] of [['l', nb.x1, 'x'], ['r', nb.x2, 'x'], ['b', nb.y1, 'y'], ['t', nb.y2, 'y']]) {
    over[side] = pg.mount[side] && real(n) ? n.box.size(axis) - 2 : 0;
    if (over[side] > 0) tz = tz === null ? n.box.g : Math.min(tz, n.box.g);
  }
  if (tz === null) return;
  tz += pg.thickness;
  pg.box.l -= over.l; pg.box.r += over.r; pg.box.b -= over.b; pg.box.t += over.t;
  pg.box.moveSide('f', tz);
  for (const [side, n] of [['l', nb.x1], ['r', nb.x2], ['b', nb.y1], ['t', nb.y2]]) {
    if (over[side] <= 0) continue;
    pg.mount[side] = false; pg.krep[side] = 0;
    n.box.g = tz;
  }
}

function buildOtseki(project, db, product, n) {
  const { W, H, G } = product;
  const c = cursorBox({ x: W / 2, y: H / 2, z: G / 2 });
  const nb = neighbors(product, findNeighbors(product, c));
  const start = nb.x1.box.r;
  const te = nb.x2.box.l - nb.x1.box.r;
  const item = { id: KIND.PEREG, group: 2, name: 'Перегородка', W: '16', MinW: '16', MinH: '5', MinG: '5', MaxW: '16', MaxH: '2780', MaxG: '1000' };
  for (let i = 2; i <= n; i++) {
    const guess = start + ((te - 8 * (n - 2)) / n) * (i - 1) + 8;
    const part = place(project, db, product, item, { x: guess, y: H / 2, z: G / 2 });
    const sx = part.box.sx;
    part.box.moveCenter('x', start + ((te - (sx / 2) * (n - 2)) / n) * (i - 1) + (i - 2) * (sx / 2));
    const { PL, PR } = { PL: product.role('PL'), PR: product.role('PR') };
    for (const side of [PL, PR]) if (real(side)) part.box.f = Math.min(part.box.f, side.box.f);
  }
}
