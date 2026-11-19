import { BuildError, refresh, relayout } from './build.js';
import { AXIS_SIDES, edgeSides, EPS, OPPOSITE, SIDE_NB } from './geom.js';
import { canUsePartMaterial, edgeChoices, normFirma, replacePartMaterial } from './material.js';
import { KIND, isPanel } from './model.js';
import { OPENING_SUPPORTS } from './opora.js';
import { defaultFastenings, resizeProductSpace, SLOTS } from './product.js';
import { rootPart, violations } from './move.js';
import { DRAWER_GAP } from './drawers.js';

export const EDGE_MODES = { V: [1.2, 3], L: [0.03, 0.97], E: [0.98, 1.19] };
const SIZE = { x: 'W', y: 'H', z: 'G' };
const SHELL = { l: 'PL', r: 'PR', b: 'PB', t: 'PT', g: 'PG' };
const FILL_KINDS = new Set([KIND.POLKA, KIND.PEREG, KIND.ZAD]);

function updateBounds(project, product, dimensions, sides, physical) {
  const oldSize = { ...product };
  const change = resizeProductSpace(project, product, dimensions, sides);
  const parts = [...product.parts.values()];
  for (const [axis, { delta, low }] of Object.entries(change)) {
    const [lo, hi] = AXIS_SIDES[axis];
    const moving = low ? lo : hi;
    const opposite = OPPOSITE[moving];
    const surface = product.role(SHELL[moving]);
    const edge = low ? 0 : oldSize[SIZE[axis]];
    const front = moving === 'f'
      ? ['PL', 'PR', 'PB', 'PT'].map((role) => product.role(role)).filter(Boolean).map((part) => part.box.f)
      : [];
    const inner = surface?.box[opposite] ?? Math.min(edge, ...front);
    const localShift = low ? delta : 0;
    const motion = low ? -delta : delta;
    const touch = (at) => low ? at <= inner + EPS : at >= inner - EPS;
    const route = new Map();
    for (const part of parts) {
      if (part.parent) continue;
      let a = localShift;
      let b = localShift;
      if (physical) {
        if (axis === 'y' && part.data.drawer) {
          const boundary = surface ?? product.walls[moving];
          const clearance = (low ? 1 : -1) * (part.box[moving] - inner);
          const shift = part.nb[SIDE_NB[moving]] !== boundary.id ? 0
            : clearance <= DRAWER_GAP + EPS ? motion
            : (low ? 1 : -1) * Math.max(0, -delta + DRAWER_GAP - clearance);
          route.set(part.id, [a + shift, b + shift]);
          continue;
        }
        const held = part.mount[moving] || part.grab[moving] >= 0;
        const follow = part === surface || touch(part.box[moving]) ||
          (held && (part.nb[SIDE_NB[moving]] === surface?.id || part.nb[SIDE_NB[moving]] === product.walls[moving].id));
        if (follow) {
          if (part === surface || part.thickAxis === axis || part.data.drawer || part.data.door || part.casper) { a += motion; b += motion; }
          else if (low) a += motion;
          else b += motion;
        }
      }
      route.set(part.id, [a, b]);
    }
    if (physical) {
      for (const part of parts) {
        if (part.parent || !(part.data.drawer || part.data.door)) continue;
        if (part.data.drawer && axis === 'y') {
          for (const side of [lo, hi]) {
            const support = product.parts.get(part.nb[SIDE_NB[side]]);
            if (!support) continue;
            const face = side === lo ? 0 : 1;
            const direction = side === lo ? 1 : -1;
            const clearance = direction * (part.box[side] - support.box[OPPOSITE[side]]);
            const shift = route.get(part.id)[face];
            const travel = route.get(rootPart(product, support).id)[1 - face];
            if (clearance + direction * (shift - travel) < Math.min(0, clearance) - EPS) {
              throw new BuildError('Ящик не помещается по высоте после изменения габаритов изделия');
            }
          }
          continue;
        }
        if (!part.data.door) continue;
        const changes = OPENING_SUPPORTS.filter((side) => side[0] === axis).map((side) => {
          const support = product.get(part.nb[side]);
          const index = side.endsWith('1') ? 1 : 0;
          return route.get(support?.id)?.[index] ?? (support === product.walls[moving] ? localShift + motion : localShift);
        });
        if (changes.some((d) => Math.abs(d - changes[0]) > EPS)) {
          throw new BuildError('Выбранное изменение габаритов меняет проём установленной двери');
        }
        if (changes.length) route.set(part.id, [changes[0], changes[0]]);
      }
    }
    for (const part of parts) {
      const [a, b] = route.get(rootPart(product, part).id);
      part.box[lo] += a;
      part.box[hi] += b;
      if (axis === 'z') {
        for (const cut of part.data.door ? part.data.cuts ?? [] : []) {
          if (typeof cut.f === 'number') cut.f += route.get(cut.id)?.[1] ?? b;
        }
      }
    }
  }
  return Object.keys(change).length > 0;
}

export function applyProductSettings(project, db, product, settings) {
  const { form } = product;
  const { title, titleGroup, positionGroup, cutNote, count, hard, useKromE, edgeMode, materialEdges, entries } = settings;
  const previous = new Set(violations(product).map(({ part, axis, kind }) => `${part.id}:${axis}:${kind}`));
  Object.assign(product, { title, titleGroup, positionGroup, cutNote, count, hard, useKromE });
  if (settings.num !== product.num) {
    project.products.splice(project.products.indexOf(product), 1);
    project.products.splice(settings.num - 1, 0, product);
    project.products.forEach((item, i) => { item.num = i + 1; });
  }
  Object.assign(form, { title, count, useKromE });
  if (project.room && settings.surfaceMaterials) project.room.surfaceMaterials = settings.surfaceMaterials;
  if (settings.allEdges) for (const other of project.products) {
    other.useKromE = useKromE;
    if (other.form) other.form.useKromE = useKromE;
    if (other !== product) for (const part of other.realParts()) refresh(db, other, part);
  }
  const resized = settings.resize && updateBounds(project, product, settings.dimensions, settings.sides, settings.physical);
  Object.assign(form, { W: product.W, H: product.H, G: product.G, x: product.x, y: product.y, z: product.z });
  if (settings.krep) {
    for (const target of settings.krep.all ? project.products : [product]) {
      const { krepKor, krepNap, zag1, zag2 } = settings.krep;
      Object.assign(target, defaultFastenings(db, settings.krep));
      if (target.form) Object.assign(target.form, { krepKor, krepNap, zag1, zag2 });
    }
  }
  const [min, max] = EDGE_MODES[edgeMode];
  let skipped = 0;
  let materialChanged = false;
  const change = (part, row, entry, stored, anchor) => {
    if (row && row.kod !== part.kod) {
      if (!canUsePartMaterial(db, product, part, row)) throw new BuildError(`Материал несовместим с деталью «${part.title}»`);
      replacePartMaterial(part, row, anchor);
      if (stored) stored.kod = row.kod;
      materialChanged = true;
    }
    const edge = entry.edge;
    const compatible = edge && edgeChoices(db, part).some((row) => row.kod === edge);
    for (const side of edgeSides(part.group)) {
      if (part.edge[side] < 0) continue;
      if (materialEdges) part.edge[side] = 0;
      else if (compatible && part.kr[side] > min && part.kr[side] < max) part.edge[side] = edge;
    }
    if (stored && (materialEdges || compatible)) stored.edge = materialEdges ? 0 : edge;
  };
  for (const slot of SLOTS) {
    const part = product.role(slot.role);
    const entry = entries[slot.key];
    const podium = slot.role === 'PB' && form.floorType.startsWith('podium');
    const anchor = podium ? 't' : Object.keys(SHELL).find((side) => SHELL[side] === slot.role);
    if (part && entry.checked) change(part, db.get(entry.kod), entry, form.parts[slot.key], anchor);
  }
  const fill = entries.fill;
  const fillRow = fill.checked && db.get(fill.kod);
  if (fillRow) {
    Object.assign(product, { nachColor: fillRow.color ?? '', firma: fillRow.firma ?? '' });
    form.fill.kod = fillRow.kod;
  }
  if (fill.edge && edgeMode === 'V') product.kromkaNap = form.fill.edge = fill.edge;
  if (fill.checked || fill.edge) for (const part of product.realParts()) {
    if (!FILL_KINDS.has(part.kind) || product.isCorpus(part) || !isPanel(part)) continue;
    const parent = product.get(part.parent);
    if (parent && !(parent.data.drawer && parent.children[0] === part.id)) continue;
    let row = null;
    if (fillRow && part.catalogThickness === fillRow.t) {
      row = db.byPos(part.kind).find((candidate) => candidate.unit === 'м2' && candidate.color === fillRow.color &&
        candidate.t === part.catalogThickness && normFirma(candidate.firma) === normFirma(fillRow.firma));
      if (!row) { skipped++; continue; }
    }
    change(part, row, fill);
  }
  if ((resized && settings.physical) || materialChanged) relayout(db, product);
  else for (const part of product.realParts()) refresh(db, product, part);
  if (settings.checkSizes || materialChanged) {
    const bad = violations(product).find(({ part, axis, kind }) => !previous.has(`${part.id}:${axis}:${kind}`));
    if (bad) throw new BuildError(`Изменится допустимый размер детали «${bad.part.title || bad.part.name}»`);
    if (resized && settings.physical) {
      const invalid = [...product.realParts()].find((part) => !part.parent && !part.casper &&
        Object.entries(AXIS_SIDES).some(([axis, [lo, hi]]) => part.box[lo] < -EPS || part.box[hi] > product[SIZE[axis]] + EPS));
      if (invalid) throw new BuildError(`Деталь «${invalid.title || invalid.name}» выходит за габариты изделия`);
    }
  }
  return skipped;
}
