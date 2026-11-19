import { KIND, Project, isPanel } from '../core/model.js';
import { place, relayout, BuildError } from '../core/build.js';
import { canMove, canResize, centerHandle, movePart, resizePart, setGap, rootPart, violations } from '../core/move.js';
import { SLOTS, createProduct, moveProductInRoom, normalizeAngle, productCenter, productPosition, productPositionDetails, productPositionError, wallPosition } from '../core/product.js';
import { centeredOffset, opora } from '../core/opora.js';
import { createDoor, doorOpeningFromParts, removeAssemblies } from '../core/doors.js';
import { createDrawer, restoreDrawerGuides } from '../core/drawers.js';
import { AXIS_SIDES, OPPOSITE, SIDES, SIDE_AXIS, SIDE_NB, edgeSides } from '../core/geom.js';
import { attachmentGap, loadKrep } from '../core/krep.js';
import { canUsePartMaterial, edgeChoices, replacePartMaterial } from '../core/material.js';
import { addWindowSill, clampRoomOffset, detachWindowSill, isRoomLamp, planRoomElement, restoreWindowSills, roomAxisFixed, roomElementBox,
  roomDependentRange, roomElementFits, roomElementUsesWallColor, roomKrepContext, roomMounts, roomSillTouches, roomWallSupport, setRoomAttachmentKrep, toggleRoomAttachment,
  windowMoveBounds, windowSill } from '../core/room.js';
import { applyProductSettings } from '../core/product-settings.js';

const STORAGE_KEY = 'np-web-project';
const PRODUCT_FORM_KEY = 'np-web-last-product-form';
const UNDO_LIMIT = 40;

function attachmentGrab(db, product, part, side, kod) {
  const nb = product.get(part.nb[SIDE_NB[side]]);
  if (!nb) throw new BuildError('С этой стороны нет опоры');
  const delta = part.box[side] - nb.box[OPPOSITE[side]];
  const current = Math.max(0, side === AXIS_SIDES[SIDE_AXIS[side]][0] ? delta : -delta);
  return attachmentGap(db, side, kod, current) || -1;
}

function setMount(db, product, part, side, enabled) {
  part.mount[side] = enabled;
  part.grab[side] = -1;
  if (!enabled) {
    part.krep[side] = 0;
    return;
  }
  opora(product, part);
  loadKrep(db, product, part, side);
  part.grab[side] = attachmentGrab(db, product, part, side, part.krep[side]);
}

function defaultRoomKrep(db, { product, part }, side) {
  part.krep = { ...part.krep, [side]: 0 };
  loadKrep(db, product, part, side);
  return part.krep[side];
}

export class App extends EventTarget {
  constructor(db, catalog, doors) {
    super();
    this.db = db;
    this.catalog = catalog;
    this.doorSystems = doors;
    this.project = new Project();
    this.activeId = 0;
    this.selectedIds = new Set();
    this.mode = 'room';
    this.roomFill = false;
    this.roomSelectedId = 0;
    this.sub = 'overview';
    this.tool = null;
    this.placement = null;
    this.positionToObjects = false;
    this.moveMode = false;
    this.undoStack = [];
    this.redoStack = [];
    this.lastProductForm = null;
  }

  get product() { return this.project.products.find((p) => p.id === this.activeId) ?? null; }
  get editingRoom() { return this.mode === 'room' && this.roomFill && !!this.project.room; }
  get roomSelected() { return this.project.room?.elements?.find((element) => element.id === this.roomSelectedId) ?? null; }
  get selected() { return this.product?.parts.get(this.selectedIds.values().next().value) ?? null; }
  get selectedParts() {
    const parts = this.product?.parts;
    return [...this.selectedIds].map((id) => parts?.get(id)).filter(Boolean);
  }
  get selectedPanel() { return this.selectedParts.find(isPanel) ?? null; }
  get selectedRoots() {
    const { product } = this;
    return [...new Set(this.selectedParts.map((part) => rootPart(product, part)))];
  }
  get movable() { const p = this.selected; return p ? rootPart(this.product, p) : null; }
  get canUndo() { return !this.dragSnap && !this.placement && this.undoStack.length > 0; }
  get canRedo() { return !this.dragSnap && !this.placement && this.redoStack.length > 0; }
  get previousProductForm() { return this.lastProductForm ?? this.project.products.at(-1)?.form ?? null; }
  get positionDetails() {
    const product = this.placement ?? this.product;
    if (!product || !this.project.room || this.editingRoom) return null;
    return productPositionDetails(this.project, product, this.positionToObjects);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  toast(text) { this.emit('toast', text); }

  snapshot() { return JSON.stringify({ project: this.project, activeId: this.activeId }); }

  restore(snap) {
    const data = JSON.parse(snap);
    this.project = Project.fromJSON(data.project);
    restoreWindowSills(this.project);
    if (this.activeId !== data.activeId) this.selectedIds.clear();
    this.activeId = data.activeId;
    this.pruneSelection();
    if (!this.roomSelected) this.roomSelectedId = 0;
  }

  recordHistory(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  mutate(fn, { skipUnchanged = false } = {}) {
    const snap = this.snapshot();
    try {
      const result = fn();
      if (skipUnchanged && result === false) return result;
      const current = this.snapshot();
      if (current !== snap) this.recordHistory(snap);
      this.changed(current);
      return result;
    } catch (e) {
      this.restore(snap);
      this.changed();
      if (!(e instanceof BuildError)) console.error(e);
      this.toast(e instanceof BuildError ? e.message : 'Ошибка: ' + e.message);
      return null;
    }
  }

  stepHistory(from, to) {
    if (this.dragSnap || this.placement) return;
    const snap = from.pop();
    if (!snap) return;
    const previousId = this.activeId;
    to.push(this.snapshot());
    this.restore(snap);
    if (!this.product) {
      if (this.mode === 'product') this.setMode('room');
      else this.setMoveMode(false);
    } else if (!previousId) {
      this.setMode('product');
    } else if (this.activeId !== previousId) {
      this.setTool(null);
    }
    this.changed();
  }

  undo() { this.stepHistory(this.undoStack, this.redoStack); }
  redo() { this.stepHistory(this.redoStack, this.undoStack); }

  changed(snap = this.snapshot()) {
    try { localStorage.setItem(STORAGE_KEY, snap); } catch { /* хранилище недоступно */ }
    this.emit('change');
  }

  loadSaved() {
    try {
      const snap = localStorage.getItem(STORAGE_KEY);
      if (snap) this.restore(snap);
    } catch { this.project = new Project(); }
    try {
      const form = JSON.parse(localStorage.getItem(PRODUCT_FORM_KEY));
      if (form?.fill && SLOTS.every(({ key }) => form.parts?.[key])) this.lastProductForm = form;
    } catch {}
    for (const product of this.project.products) restoreDrawerGuides(this.db, product);
    if (this.project.room && !this.product && this.project.products.length) this.activeId = this.project.products[0].id;
    this.setMode(this.product ? 'product' : 'room');
  }

  loadData(data) {
    this.mutate(() => {
      this.project = Project.fromJSON(data);
      restoreWindowSills(this.project);
      for (const product of this.project.products) restoreDrawerGuides(this.db, product);
      this.activeId = this.project.products[0]?.id ?? 0;
      this.selectedIds.clear();
      this.roomSelectedId = 0;
    });
    this.setMode(this.product ? 'product' : 'room');
  }

  newProject() {
    this.mutate(() => { this.project = new Project(); this.activeId = 0; this.selectedIds.clear(); this.roomSelectedId = 0; });
    this.setMode('room');
  }

  setMode(mode, sub = this.sub) {
    const changed = this.mode !== mode || this.sub !== sub;
    if (mode !== this.mode || !this.project.room) {
      this.roomFill = false;
      this.roomSelectedId = 0;
    }
    this.mode = mode;
    this.sub = sub;
    this.setPlacement(null);
    this.setTool(null);
    if (changed) this.setMoveMode(mode === 'room' && !!this.product);
    this.emit('mode');
  }

  setMoveMode(enabled) {
    if (this.moveMode === enabled) return;
    this.moveMode = enabled;
    if (enabled) this.setTool(null);
    this.emit('move-mode');
  }

  setTool(tool) { if (tool) this.setMoveMode(false); this.tool = tool; this.emit('tool'); }

  cancelPlacement() {
    this.setPlacement(null);
    this.setTool(null);
    this.setMoveMode(false);
    this.select(0);
    this.selectRoom(0);
  }

  setRoomFill(enabled) {
    if (this.mode !== 'room' || !this.project.room || this.placement || this.roomFill === enabled) return;
    this.roomFill = enabled;
    this.setTool(null);
    this.setMoveMode(!enabled && !!this.product);
    this.selectRoom(0);
    this.emit('mode');
  }

  selectRoom(id) {
    if (id === this.roomSelectedId) return;
    this.roomSelectedId = id;
    this.emit('select');
  }

  select(id, { toggle = false } = {}) {
    if (id && !this.product?.parts.has(id)) return;
    if (toggle && id) {
      if (!this.selectedIds.delete(id)) this.selectedIds.add(id);
    } else {
      if (this.selectedIds.size === (id ? 1 : 0) && (!id || this.selectedIds.has(id))) return;
      this.selectedIds.clear();
      if (id) this.selectedIds.add(id);
    }
    this.emit('select');
  }

  pruneSelection() {
    const parts = this.product?.parts;
    for (const id of this.selectedIds) if (!parts?.has(id)) this.selectedIds.delete(id);
  }

  activate(id, mode = 'product') {
    const changed = this.activeId !== id;
    this.activeId = id;
    this.selectedIds.clear();
    this.setMode(mode);
    if (mode === 'room' && changed) this.setMoveMode(!!this.product);
    this.emit('change');
  }

  createRoom(room) {
    this.mutate(() => {
      this.project = new Project();
      this.project.room = room;
      this.activeId = 0;
      this.selectedIds.clear();
      this.roomSelectedId = 0;
    });
    this.setTool(null);
  }

  resizeRoom(room) {
    if (!this.project.room) return this.createRoom(room);
    const emptyRoom = { room, products: [] };
    const fits = this.project.products.every((p) => !productPositionError(emptyRoom, p));
    if (!fits) return this.toast('Изделия не помещаются в комнату таких размеров');
    const resized = { ...this.project.room, ...room };
    if (resized.elements?.some((element) => !roomElementFits(resized, element))) {
      return this.toast('Элементы наполнения не помещаются в комнату таких размеров');
    }
    return this.mutate(() => { this.project.room = resized; });
  }

  setWallColor(color, applyToElements) {
    const { room } = this.project;
    if (!room) return;
    this.mutate(() => {
      room.wallColor = color;
      if (applyToElements) for (const element of room.elements ?? []) if (roomElementUsesWallColor(element)) element.wallColor = color;
    });
  }

  placeRoomElement(point) {
    const { room } = this.project;
    const element = this.editingRoom && this.tool?.room && planRoomElement(room, this.tool.room, point);
    if (!element) return this.toast('В этом месте элемент не помещается');
    return this.mutate(() => this.addRoomElement(element));
  }

  addRoomElement(element) {
    const { room } = this.project;
    element.id = this.project.newId();
    (room.elements ??= []).push(element);
    addWindowSill(this.project, element);
    if (isRoomLamp(element)) room.activeLamp = element.id;
    return element;
  }

  toggleRoomLamp(element) {
    const { room } = this.project;
    if (this.editingRoom && isRoomLamp(element) && room.elements?.includes(element)) {
      this.mutate(() => { room.activeLamp = room.activeLamp === element.id ? 0 : element.id; });
    }
  }

  moveRoomElement(target, dragging = false) {
    const element = this.roomSelected;
    const { room } = this.project;
    if (!this.editingRoom || !element || (this.dragSnap && !dragging)) return false;
    const box = roomElementBox(room, element);
    const sill = windowSill(room, element);
    const sillBox = sill && roomElementBox(room, sill);
    const sillMounts = sill && roomMounts(sill);
    const limits = windowMoveBounds(room, element, box, sill, sillBox);
    let moved = false;
    for (const [axis, value] of Object.entries(target)) {
      if (roomAxisFixed(element, axis) || !Number.isFinite(value) || !AXIS_SIDES[axis]) continue;
      const [lo, hi] = AXIS_SIDES[axis];
      const carriesSill = !sill || [lo, hi].every((side) => !sillMounts[side] || sillMounts[side].supportId === element.id);
      const axisLimits = carriesSill ? limits : limits.filter((entry) => entry.box !== sillBox);
      const next = clampRoomOffset(room, { ...element, box }, axis, value);
      const dependent = roomDependentRange(this.db, room, element, axis, carriesSill && sill);
      const min = Math.max(dependent.min, ...axisLimits.map(({ box, bounds }) => bounds[lo] - box[lo]));
      const max = Math.min(dependent.max, ...axisLimits.map(({ box, bounds }) => bounds[hi] - box[hi]));
      if (min > max) continue;
      const delta = Math.max(Math.min(0, min), Math.min(Math.max(0, max), next - box[lo]));
      if (!delta) continue;
      box.moveSide(lo, box[lo] + delta);
      if (sill && carriesSill) sillBox.moveSide(lo, sillBox[lo] + delta);
      moved = true;
    }
    if (!moved) return false;
    const move = () => {
      if (sill) sill.box = sillBox;
      this.setRoomElementBox(room, element, box);
      return true;
    };
    if (dragging) {
      move();
      this.emit('room-element-position');
      return true;
    }
    return this.mutate(move);
  }

  setRoomElementBox(room, element, box) {
    const sill = windowSill(room, element);
    const window = element.windowId && room.elements.find((part) => part.id === element.windowId);
    const oldSupport = element.supportId;
    element.supportId = roomWallSupport(room, element, box);
    element.box = roomElementBox(room, { ...element, box });
    if (sill && sill.supportId === oldSupport && sill.wall === element.wall) sill.supportId = element.supportId;
    if (sill && !roomSillTouches(element.box, roomElementBox(room, sill))) {
      detachWindowSill(room, element, sill);
    }
    if (window && !roomSillTouches(roomElementBox(room, window), element.box)) {
      detachWindowSill(room, window, element);
    }
  }

  resizeRoomElement(axis, size, fromOpposite = false) {
    const element = this.roomSelected;
    const { room } = this.project;
    if (!this.editingRoom || !element || element.tag === 'Розетка' || !Number.isFinite(size) || size <= 0) return false;
    const box = roomElementBox(room, element);
    const mounts = roomMounts(element);
    const [lo, hi] = AXIS_SIDES[axis];
    if (mounts[lo] && mounts[hi]) return false;
    const side = mounts[lo] || !mounts[hi] && !fromOpposite ? lo : hi;
    box.setSize(axis, size, side);
    if (!roomElementFits(room, { ...element, box })) { this.toast('Элемент выходит за границы комнаты'); return false; }
    return this.mutate(() => { this.setRoomElementBox(room, element, box); return true; });
  }

  zeroRoomGap(side) {
    const { room } = this.project;
    const element = this.roomSelected;
    const axis = SIDE_AXIS[side];
    if (!this.editingRoom || !element || roomAxisFixed(element, axis)) return false;
    const { product, part } = roomKrepContext(room, element, this.db.get(element.kod));
    const support = product.get(part.nb[SIDE_NB[side]]);
    const delta = support.box[OPPOSITE[side]] - part.box[side];
    return this.moveRoomElement({ [axis]: part.box[AXIS_SIDES[axis][0]] + delta });
  }

  centerSelected(axis) {
    if (!AXIS_SIDES[axis] || this.dragSnap || this.placement) return false;
    if (this.editingRoom) {
      const element = this.roomSelected;
      if (!element || roomAxisFixed(element, axis)) return false;
      const { product, part } = roomKrepContext(this.project.room, element, this.db.get(element.kod));
      return this.moveRoomElement({ [axis]: centeredOffset(product, part, axis) });
    }
    if (this.mode !== 'product') return false;
    const { db, product, selectedParts } = this;
    if (!product || !selectedParts.length) return false;
    const handles = selectedParts.filter((part) => part.kind === KIND.HANDLE);
    const roots = [...new Set(selectedParts.filter((part) => part.kind !== KIND.HANDLE).map((part) => rootPart(product, part)))];
    return this.mutate(() => {
      const targets = roots.filter((part) => canMove(product, part, axis)).map((part) => {
        opora(product, part);
        return { part, offset: centeredOffset(product, part, axis) };
      });
      let changed = false;
      for (const { part, offset } of targets) changed = movePart(db, product, part, axis, offset) || changed;
      for (const handle of handles) changed = centerHandle(product, handle, axis) || changed;
      return changed;
    }, { skipUnchanged: true });
  }

  setPlacement(form) {
    if (this.placement === form) return;
    this.placement = form;
    this.emit('placement');
  }

  beginPlacement(form) {
    const position = wallPosition(this.project, form);
    if (!position) return this.toast('Изделие не помещается в комнате');
    this.lastProductForm = structuredClone({ ...form, x: null, z: 0 });
    try { localStorage.setItem(PRODUCT_FORM_KEY, JSON.stringify(this.lastProductForm)); } catch {}
    this.positionToObjects = false;
    this.setMode('room');
    this.setRoomFill(false);
    this.setMoveMode(false);
    this.setPlacement({ ...form, ...position });
  }

  movePlacement(point) {
    const draft = this.placement;
    if (!draft) return;
    const bounds = this.positionToObjects ? this.positionDetails?.bounds : null;
    const position = productPosition(this.project, draft, point, bounds);
    if (!position || Object.keys(position).every((axis) => position[axis] === draft[axis])) return;
    Object.assign(draft, position);
    this.emit('placement-position');
  }

  confirmPlacement() {
    if (this.placement) return this.addProduct(this.placement);
  }

  togglePositionReference() {
    this.positionToObjects = !this.positionToObjects;
    this.emit('position-reference');
    if (this.positionToObjects && !this.placement && this.product?.through) {
      this.toast('Активное изделие сквозное. Расстояния показываются до стен комнаты.');
    }
  }

  rotateProduct(value, relative = false) {
    const target = this.placement ?? this.product;
    if (!target || this.dragSnap || !Number.isFinite(value)) return;
    const angle = normalizeAngle(relative ? (target.angle ?? 0) + value : value);
    if (angle === normalizeAngle(target.angle)) return;
    const rotated = { ...target, angle };
    const position = productPosition(this.project, rotated, { ...productCenter(target), y: target.y });
    if (!position) return this.toast('Изделие не помещается в комнате при таком повороте');
    Object.assign(rotated, position);
    if (this.placement) {
      Object.assign(target, rotated);
      this.emit('placement-position');
      return;
    }
    const error = productPositionError(this.project, rotated);
    if (error) return this.toast(error);
    this.mutate(() => Object.assign(target, position, { angle }));
  }

  addProduct(form) {
    const product = this.mutate(() => {
      const p = createProduct(this.project, this.db, form);
      this.activeId = p.id;
      this.selectedIds.clear();
      return p;
    });
    if (product) this.setMode('product');
    return product;
  }

  updateProductSettings(id, settings) {
    const product = this.project.products.find((item) => item.id === id);
    if (!product) return false;
    const skipped = this.mutate(() => applyProductSettings(this.project, this.db, product, settings));
    if (skipped > 0) this.toast(`Нет выбранного цвета для деталей: ${skipped}`);
    return skipped !== null;
  }

  copyProduct(product) {
    if (this.placement || !this.project.products.includes(product)) return;
    const copy = this.mutate(() => {
      const copy = this.project.copyProduct(product);
      moveProductInRoom(this.project, copy, { z: product.z + product.G });
      this.activeId = copy.id;
      this.selectedIds.clear();
      return copy;
    });
    if (copy) this.setMode('product');
    return copy;
  }

  setProductThrough(product, through) {
    if (this.placement || !this.project.products.includes(product) || product.through === through) return;
    this.mutate(() => { product.through = through; });
  }

  removeOtherProducts(keep = this.product) {
    if (!keep || this.placement || this.project.products.length < 2 || keep !== this.product) return;
    this.mutate(() => {
      this.project.products = [keep];
      keep.num = 1;
      this.selectedIds.clear();
    });
  }

  removeProduct(product) {
    if (!this.project.products.includes(product)) return;
    this.mutate(() => {
      this.project.removeProduct(product);
      if (this.activeId === product.id) {
        this.activeId = this.project.products[0]?.id ?? 0;
        this.selectedIds.clear();
      }
    });
    if (!this.product) this.setMode('room');
  }

  placeAt(point) {
    const { tool, product } = this;
    if (!tool || !product) return null;
    return this.mutate(() => tool.place(this, product, point));
  }

  placeBatch(tool, productId, item, points) {
    const { product } = this;
    if (tool !== this.tool || (tool.room ? !this.editingRoom : productId !== product?.id)) return false;
    return this.mutate(() => {
      for (const point of points) {
        const spec = { ...item, ...point.size };
        if (!tool.room) { tool.place(this, product, point, spec); continue; }
        const element = planRoomElement(this.project.room, { ...tool.room, panel: spec }, point);
        if (!element) throw new BuildError('В этом месте элемент не помещается');
        this.addRoomElement(element);
      }
      return true;
    });
  }

  placeDoor(product, cfg, point) {
    return createDoor(this.project, this.db, product, this.doorSystems['ДСП'], cfg, point);
  }

  placeDoorInSelection(cfg) {
    const point = doorOpeningFromParts(this.selectedParts);
    if (!point) return this.toast('Выделите две боковые и две горизонтальные опоры проёма');
    this.mutate(() => this.placeDoor(this.product, structuredClone(cfg), point));
  }

  placeDrawer(product, item, point) {
    return createDrawer(this.project, this.db, product, item, point);
  }

  placeItem(product, item, point) {
    return place(this.project, this.db, product, item, point);
  }

  deleteSelected() {
    if (this.editingRoom) {
      if (!this.roomSelected) return;
      this.mutate(() => {
        const { room } = this.project;
        const selected = this.roomSelected;
        const sill = windowSill(room, selected);
        if (sill) detachWindowSill(room, selected, sill);
        if (selected.windowId) {
          const window = room.elements.find((element) => element.id === selected.windowId);
          if (window) window.sillId = 0;
        }
        for (const element of room.elements) {
          const mounts = roomMounts(element);
          const sides = SIDES.filter((side) => mounts[side]?.supportId === selected.id);
          if (!sides.length) continue;
          element.box = roomElementBox(room, element);
          for (const side of sides) (element.attachments ??= {})[side] = null;
        }
        room.elements = room.elements.filter((element) => element.id !== this.roomSelectedId);
        if (room.activeLamp === this.roomSelectedId) room.activeLamp = 0;
        this.roomSelectedId = 0;
      });
      return;
    }
    const { product, selectedRoots } = this;
    if (!selectedRoots.length) return;
    this.mutate(() => {
      removeAssemblies(this.project, this.db, product, selectedRoots);
      this.pruneSelection();
    });
  }

  beginDrag() {
    this.dragSnap = this.snapshot();
    this.emit('history');
  }

  dragTo(axis, lo) {
    const { product, movable: part } = this;
    if (!product || !part) return false;
    try {
      if (!movePart(this.db, product, part, axis, lo)) return false;
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      this.emit('hint', e.message);
      return false;
    }
    this.emit('change');
    return true;
  }

  dragProductTo(target) {
    if (!this.product || !moveProductInRoom(this.project, this.product, target)) return false;
    this.emit('product-position', this.product);
    return true;
  }

  nudgeProduct(axis, delta) {
    const product = this.placement ?? this.product;
    if (!product || this.dragSnap) return;
    return this.moveProductTo(axis, product[axis] + delta);
  }

  moveProductTo(axis, value) {
    return this.moveProductToOffsets({ [axis]: value });
  }

  moveProductToOffsets(target) {
    const { product, placement } = this;
    if (placement) {
      const center = { ...productCenter(placement), y: placement.y };
      for (const [axis, value] of Object.entries(target)) center[axis] += value - placement[axis];
      this.movePlacement(center);
    } else if (product && !this.dragSnap) {
      return this.mutate(() => moveProductInRoom(this.project, product, target), { skipUnchanged: true });
    }
  }

  endDrag(moved) {
    const snap = this.dragSnap;
    this.dragSnap = null;
    if (moved && snap) {
      const current = this.snapshot();
      if (current !== snap) this.recordHistory(snap);
      this.changed(current);
    }
    this.emit('history');
  }

  nudgeSelected(axis, delta) {
    if (this.mode !== 'product' || this.tool || this.dragSnap) return;
    const { product, selectedRoots } = this;
    const [side] = AXIS_SIDES[axis];
    const targets = selectedRoots.filter((part) => canMove(product, part, axis))
      .map((part) => ({ part, position: part.box[side] + delta }))
      .sort((a, b) => Math.sign(delta) * (b.position - a.position));
    if (!targets.length) return;
    return this.mutate(() => targets.reduce((changed, { part, position }) =>
      movePart(this.db, product, part, axis, position) || changed, false), { skipUnchanged: true });
  }

  resizeSelected(axis, size, keepHigh = false) {
    const { product, selectedParts } = this;
    const targets = selectedParts.filter((part) => canResize(part, axis));
    if (!targets.length) return this.toast('Размер определяется проёмом или комплектом');
    this.mutate(() => targets.reduce((changed, part) =>
      resizePart(this.db, product, part, axis, size, keepHigh) || changed, false), { skipUnchanged: true });
  }

  setGap(side, gap) {
    const { product, selectedRoots } = this;
    const targets = selectedRoots.filter((part) => canMove(product, part, SIDE_AXIS[side]));
    if (!targets.length) return;
    this.mutate(() => targets.reduce((changed, part) =>
      setGap(this.db, product, part, side, gap) || changed, false), { skipUnchanged: true });
  }

  toggleMount(side) {
    if (this.editingRoom) {
      const element = this.roomSelected;
      if (!element || !SIDES.includes(side) || this.dragSnap) return false;
      const { room } = this.project;
      return this.mutateRoomAttachments(() => {
        const changed = toggleRoomAttachment(room, element, side);
        if (changed && roomMounts(element)[side]) {
          const kod = element.krep?.[side] || defaultRoomKrep(this.db, roomKrepContext(room, element, this.db.get(element.kod)), side);
          setRoomAttachmentKrep(this.db, element, side, kod);
        }
        return changed;
      });
    }
    const { product, selectedPanel, selectedParts } = this;
    if (!selectedPanel) return;
    const enabled = !selectedPanel.mount[side];
    const targets = selectedParts.filter((part) => isPanel(part) && part.mount[side] !== enabled);
    if (!targets.length) return;
    this.mutate(() => {
      for (const part of targets) setMount(this.db, product, part, side, enabled);
      relayout(this.db, product);
    });
  }

  setKrep(side, kod, { replace = false } = {}) {
    const { db, product, selectedPanel, selectedParts } = this;
    if (!(this.editingRoom ? this.roomSelected : selectedPanel)) return;
    if (kod !== 0 && !db.krepCatalog().includes(db.get(kod))) return this.toast('Крепление не найдено в прайсе');
    if (this.editingRoom) return this.setRoomKrep(side, kod, replace);
    const old = replace && side ? selectedPanel.krep[side] : 0;
    const targets = new Map(selectedParts.filter(isPanel).map((part) => [
      part, new Set(side ? [side] : SIDES.filter((s) => part.mount[s])),
    ]));
    if (old > 0) {
      for (const part of product.parts.values()) {
        if (!isPanel(part)) continue;
        for (const s of SIDES) {
          if (part.krep[s] !== old) continue;
          if (!targets.has(part)) targets.set(part, new Set());
          targets.get(part).add(s);
        }
      }
    }
    return this.mutate(() => {
      let changed = false;
      let mounted = false;
      for (const [part, sides] of targets) {
        for (const s of sides) {
          const previousKod = part.krep[s];
          const previousGrab = part.grab[s];
          const previousAllowance = part.ftex[s];
          part.krep[s] = kod;
          loadKrep(db, product, part, s);
          if (part.mount[s]) part.grab[s] = attachmentGrab(db, product, part, s, part.krep[s]);
          if (part.krep[s] === previousKod && part.grab[s] === previousGrab && part.ftex[s] === previousAllowance) continue;
          mounted ||= part.mount[s];
          changed = true;
        }
      }
      if (mounted) relayout(db, product);
      return changed;
    }, { skipUnchanged: true });
  }

  setRoomKrep(side, kod, replace) {
    const element = this.roomSelected;
    if (!element) return;
    const { db } = this;
    const { room } = this.project;
    const old = replace && side ? element.krep?.[side] : 0;
    return this.mutateRoomAttachments(() => {
      let changed = false;
      for (const part of old > 0 ? room.elements : [element]) {
        const mounts = roomMounts(part);
        let context;
        for (const face of SIDES) {
          const direct = part === element && (side ? side === face : mounts[face]);
          const current = part.krep?.[face] ?? 0;
          if (!direct && !(old > 0 && current === old)) continue;
          let next = kod;
          if (!next && mounts[face]) {
            context ??= roomKrepContext(room, part, db.get(part.kod));
            next = defaultRoomKrep(db, context, face);
          }
          changed = setRoomAttachmentKrep(db, part, face, next) || changed;
        }
      }
      return changed;
    });
  }

  mutateRoomAttachments(update) {
    const { room } = this.project;
    const invalidBefore = new Set(room.elements.filter((part) => !roomElementFits(room, part)));
    return this.mutate(() => {
      const changed = update();
      if (changed && room.elements.some((part) => !invalidBefore.has(part) && !roomElementFits(room, part))) {
        throw new BuildError('Крепление выводит элемент за границы комнаты');
      }
      return changed;
    }, { skipUnchanged: true });
  }

  setEdge(side, code, { allSides = false } = {}) {
    const { product } = this;
    if (!product || !this.selectedIds.size) return;
    const force = code > 0;
    let skipped = 0;
    const updates = [];
    for (const id of this.selectedIds) {
      const part = product.get(id);
      const sides = part && isPanel(part) ? edgeSides(part.group).filter((s) => allSides || s === side) : [];
      if (!sides.length || (force && !edgeChoices(this.db, part).some((row) => row.kod === code))) {
        skipped++;
        continue;
      }
      const changed = sides.filter((s) => part.edge[s] !== code || part.edgeForce[s] !== force);
      if (changed.length) updates.push({ part, sides: changed });
    }
    if (updates.length) {
      const result = this.mutate(() => {
        for (const { part, sides } of updates) {
          for (const s of sides) {
            part.edge[s] = code;
            part.edgeForce[s] = force;
          }
        }
        relayout(this.db, product);
      });
      if (result === null) return;
    }
    if (skipped) this.toast(`Кромка не изменена для деталей: ${skipped} (несовместимый материал или сторона)`);
  }

  setMaterial(kod) {
    const { db, product, selectedParts } = this;
    const row = db.get(kod);
    const targets = selectedParts.filter((part) => canUsePartMaterial(db, product, part, row));
    const changed = targets.filter((part) => part.kod !== row.kod);
    const result = changed.length ? this.mutate(() => {
      const previous = new Set(violations(product).map(({ part, axis, kind }) => `${part.id}:${axis}:${kind}`));
      for (const part of changed) {
        replacePartMaterial(part, row);
        const slot = SLOTS.find(({ role }) => product.roles[role] === part.id);
        const settings = slot && product.form?.parts?.[slot.key];
        if (settings) settings.kod = row.kod;
      }
      relayout(db, product);
      const invalid = violations(product).find(({ part, axis, kind }) => !previous.has(`${part.id}:${axis}:${kind}`));
      if (invalid) throw new BuildError(`Материал меняет допустимый размер детали «${invalid.part.title || invalid.part.name}»`);
    }) : undefined;
    if (result !== null && selectedParts.length > targets.length) this.toast(`Материал несовместим с деталями: ${selectedParts.length - targets.length}`);
  }
}
