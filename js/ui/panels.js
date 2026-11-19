import { h, calc, pickRow, pickPartCatalog, rowLabel, productDialog, confirmDialog } from './dialogs.js';
import { canMove, canResize, canSetGapDirectly } from '../core/move.js';
import { defaultForm, productPositionError } from '../core/product.js';
import { AXIS_SIDES, edgeSides, SIDE_LABEL, SIDE_NB, SIDE_AXIS, OPPOSITE } from '../core/geom.js';
import { canUsePartMaterial, edgeChoices, materialLimits } from '../core/material.js';
import { krepChoices, krepForPart } from '../core/krep.js';
import { partCost, netSize } from '../core/price.js';
import { isFullyLocked, isPanel } from '../core/model.js';
import { DEFAULT_WALL_COLOR, ROOM_DIMENSION, roomAxisFixed, roomElementBox, roomElementUsesWallColor,
  roomItemSpec, roomItemSupported, roomKrepContext, roomMounts } from '../core/room.js';
import { projectTotal } from '../core/report.js';
import { doorOptions, defaultDoorConfig, doorOpeningFromParts, OVERLAYS, HANDLE_POS } from '../core/doors.js';
import { startRoomTool, TOOLS } from './tools.js';
import { productSettingsDialog } from './product-settings.js';

const $ = (id) => document.getElementById(id);
const LO_SIDES = new Set(['l', 'b', 'g']);
const AXIS_LABEL = { x: 'Ширина', y: 'Высота', z: 'Глубина' };
const GAP_LABEL = { l: 'Слева', r: 'Справа', b: 'Снизу', t: 'Сверху', g: 'Сзади', f: 'Спереди' };
const RESIZE_ARROW = { l: '←', r: '→', b: '↓', t: '↑', g: '↑', f: '↓' };
const RESIZE_FACE = { l: 'левую', r: 'правую', b: 'нижнюю', t: 'верхнюю', g: 'заднюю', f: 'переднюю' };
const MOUNT_LABEL = { l: 'Л', r: 'П', b: 'Низ', t: 'Верх', g: 'Зад', f: 'Перед' };
const money = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round = (value) => Math.round(value * 10) / 10;

export class Panels {
  constructor(app) {
    this.app = app;
    this.expanded = new Set();
    this.roomItems = new WeakMap();
    this.presetOn = false;
    this.krepMode = 0;
    this.resizeSides = { x: 'r', y: 't', z: 'f' };
    this.bind();
    app.addEventListener('change', () => this.refresh());
    app.addEventListener('mode', () => this.refresh());
    app.addEventListener('select', () => {
      this.drawPartMaterial();
      this.drawRight();
      if (app.mode === 'product' && app.sub === 'doors') this.drawCatalog();
    });
    app.addEventListener('tool', () => this.drawCatalog());
    app.addEventListener('placement', () => this.drawStatus());
    app.addEventListener('room-element-position', () => this.drawRight());
    for (const event of ['placement', 'placement-position', 'move-mode', 'product-position', 'position-reference']) {
      app.addEventListener(event, () => this.drawProductControls());
    }
    this.refresh();
  }

  roomInput() {
    return { W: Number($('room-w').value), H: Number($('room-h').value), G: Number($('room-g').value) };
  }

  bind() {
    const { app } = this;
    document.querySelectorAll('#left button[data-mode]').forEach((b) => b.addEventListener('click', () => {
      if (app.placement) return app.toast('Завершите установку изделия или нажмите «Отмена»');
      if (b.dataset.mode === 'product' && !app.product) return app.toast('Сначала добавьте изделие');
      if (b.dataset.mode === 'room' && app.editingRoom) return app.setRoomFill(false);
      app.setMode(b.dataset.mode, b.dataset.sub);
    }));
    const tabs = $('tabs');
    tabs.addEventListener('wheel', (e) => {
      if (e.ctrlKey || !e.deltaY || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || tabs.scrollWidth <= tabs.clientWidth) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tabs.clientWidth : 1;
      e.preventDefault();
      tabs.scrollLeft += e.deltaY * unit;
    }, { passive: false });
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-product]');
      if (!tab) return;
      if (app.placement) return app.toast('Завершите установку изделия или нажмите «Отмена»');
      const id = Number(tab.dataset.product);
      if (id && (id !== app.activeId || app.mode !== 'product')) app.activate(id);
      if (!id) {
        if (app.mode !== 'room') app.setMode('room');
        app.setRoomFill(true);
      }
    });
    tabs.addEventListener('dblclick', (e) => {
      if (app.placement) return;
      const id = Number(e.target.closest('[data-product]')?.dataset.product);
      const product = app.project.products.find((p) => p.id === id);
      if (product) this.editProduct(product);
    });
    $('product-move').addEventListener('click', () => app.setMoveMode(!app.moveMode));
    this.turnButtons = [...$('product-actions').querySelectorAll('[data-turn]')];
    this.turnButtons.forEach((b) => b.addEventListener('click', () => app.rotateProduct(Number(b.dataset.turn), true)));
    $('placement-confirm').addEventListener('click', () => app.confirmPlacement());
    $('position-reference').addEventListener('click', () => app.togglePositionReference());
    $('part-material').addEventListener('click', (e) => this.pickPartMaterial(e.currentTarget));
    const bindPosition = (field, change) => {
      field.addEventListener('keydown', (event) => { if (event.key === 'Enter') field.blur(); });
      field.addEventListener('change', () => {
        const value = calc(field.value);
        if (Number.isFinite(value)) change(value);
        this.drawProductControls();
      });
    };
    bindPosition($('product-angle'), (value) => app.rotateProduct(value));
    this.offsetFields = ['x', 'z', 'y'].flatMap((axis) => AXIS_SIDES[axis].map((side, index) => {
      const focus = () => app.emit('position-field', { side, gap: calc(field.value) });
      const field = h('input', { type: 'text', inputMode: 'decimal', enterKeyHint: 'done',
        onfocus: focus, oninput: focus, onblur: () => app.emit('position-field', null),
        onkeydown: (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          this.applyPositionFields(index);
          field.blur();
          if (event.ctrlKey) app.emit('position-center');
        },
      });
      $('product-offsets').append(h('label', { class: 'position-field' }, axis.toUpperCase() + (index + 1), field));
      return { axis, side, index, field };
    }));
    $('room-create').addEventListener('click', async () => {
      const room = this.roomInput();
      if (!(room.W >= 500 && room.H >= 500 && room.G >= 300)) return app.toast('Проверьте размеры комнаты');
      if ((app.project.products.length || app.project.room?.elements?.length) && !(await confirmDialog('Создать комнату', 'Текущий проект будет очищен.\nПродолжить?'))) return;
      app.createRoom(room);
    });
    $('room-apply').addEventListener('click', () => app.resizeRoom(this.roomInput()));
    $('product-add').addEventListener('click', () => this.addProduct());
    $('room-fill').addEventListener('click', () => app.setRoomFill(true));
    $('room-wall-color').addEventListener('change', (e) => this.changeWallColor(e.target.value));
    $('room-wall-default').addEventListener('click', () => this.changeWallColor(null));
    $('catalog-search').addEventListener('input', () => this.drawCatalog());
    $('preset-on').addEventListener('click', (e) => {
      this.presetOn = !this.presetOn;
      e.currentTarget.classList.toggle('active', this.presetOn);
      e.currentTarget.setAttribute('aria-pressed', String(this.presetOn));
    });
    $('left-toggle').addEventListener('click', () => {
      $('left').hidden = !$('left').hidden;
      if ($('left').hidden && this.app.tool) this.app.cancelPlacement();
      this.drawPanelToggle('left');
    });
    this.drawPanelToggle('left');
    $('right-toggle').addEventListener('click', () => {
      this.rightVisible = !this.rightVisible;
      this.drawRight();
    });
  }

  async addProduct() {
    const { app } = this;
    if (!app.project.room) return app.toast('Сначала создайте комнату');
    const previous = app.previousProductForm;
    const base = previous ? { ...previous, x: null, z: 0 } : defaultForm(app.db);
    const form = await productDialog(app, base, { hasPrevious: Boolean(previous) });
    if (form) app.beginPlacement(form);
  }

  async changeWallColor(color) {
    const { app } = this;
    const room = app.project.room;
    if (!room) return;
    const hasElements = room.elements?.some(roomElementUsesWallColor);
    const recolor = hasElements && await confirmDialog('Цвет стен проекта', 'Задать такой же цвет для элементов комнаты?');
    if (room === app.project.room) app.setWallColor(color, recolor);
  }

  editProduct(product = this.app.product) {
    if (product) productSettingsDialog(this.app, product);
  }

  presets() {
    if (!this.presetOn) return null;
    const value = (id) => {
      const field = $(id);
      return field.validity.valid ? field.valueAsNumber || 0 : 0;
    };
    return { a: value('preset-1'), b: value('preset-2') };
  }

  refresh() {
    const { app } = this;
    const room = app.project.room;
    document.querySelectorAll('#left button[data-mode]').forEach((b) => {
      const active = b.dataset.mode === app.mode && (!b.dataset.sub || b.dataset.sub === app.sub);
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    $('pane-room').hidden = app.mode !== 'room' || app.editingRoom;
    $('pane-product').hidden = app.mode !== 'product' && !app.editingRoom;
    $('room-wall-color').value = room?.wallColor ?? DEFAULT_WALL_COLOR;
    if (room && document.activeElement?.closest('#pane-room') == null) {
      $('room-w').value = room.W; $('room-h').value = room.H; $('room-g').value = room.G;
    }
    this.drawTabs();
    this.drawProductControls();
    this.drawPartMaterial();
    this.drawCatalog();
    this.drawRight();
    this.drawStatus();
  }

  drawProductControls() {
    const { app } = this;
    const { placement } = app;
    const room = app.project.room;
    const product = placement ?? app.product;
    $('product-add').disabled = $('room-apply').disabled = !room || !!placement;
    $('room-fill').disabled = $('room-wall-color').disabled = $('room-wall-default').disabled = !room || !!placement;
    $('room-create').disabled = !!placement;
    const position = app.positionDetails;
    const hasPosition = !!position;
    $('product-position').inert = !hasPosition;
    const reference = $('position-reference');
    reference.textContent = app.positionToObjects ? 'До объекта' : 'До комнаты';
    reference.setAttribute('aria-pressed', String(app.positionToObjects));
    this.turnButtons.forEach((button) => { button.disabled = !hasPosition; });
    $('placement-confirm').hidden = !placement;
    $('placement-confirm').disabled = !!placement && !!productPositionError(app.project, placement);
    $('product-move').disabled = !hasPosition || !!placement;
    $('product-move').classList.toggle('active', app.moveMode);
    $('product-move').setAttribute('aria-pressed', String(app.moveMode));
    if (!position) { app.emit('position-measurements', null); return; }
    $('product-angle').value = round(product.angle ?? 0);
    const { box, bounds } = position;
    const gaps = {};
    const toObjects = app.positionToObjects && !product.through;
    let focused = null;
    for (const { side, index, field } of this.offsetFields) {
      const gap = round(index ? bounds[side] - box[side] : box[side] - bounds[side]);
      field.value = gaps[side] = gap;
      field.title = `${GAP_LABEL[side]} до ${toObjects ? 'ближайшего объекта или стены' : 'границы комнаты'}, мм`;
      if (document.activeElement === field) focused = { side, gap };
    }
    app.emit('position-measurements', { box, gaps, focused });
  }

  applyPositionFields(index) {
    const { app } = this;
    const position = app.positionDetails;
    if (!position) return;
    const { box, bounds } = position;
    const target = {};
    for (const { axis, side, index: face, field } of this.offsetFields) {
      if (face !== index) continue;
      const gap = calc(field.value);
      const current = index ? bounds[side] - box[side] : box[side] - bounds[side];
      if (Number.isFinite(gap) && gap !== round(current)) target[axis] = index ? bounds[side] - box.size(axis) - gap : bounds[side] + gap;
    }
    if (Object.keys(target).length) app.moveProductToOffsets(target);
    this.drawProductControls();
  }

  drawPartMaterial() {
    const { app } = this;
    const part = app.mode === 'product' ? app.selected : null;
    const caption = $('part-material-caption');
    $('part-material').disabled = app.mode !== 'product' || !app.selectedPanel;
    if (!part) { caption.textContent = ''; return; }
    const row = app.db.get(part.kod);
    const description = [rowLabel(row), row?.art].filter(Boolean).join(' · ');
    caption.textContent = `Изд: ${app.product.num} | ${part.title || part.name} · ${description} (Кол-во: ${part.qty})`;
  }

  async pickPartMaterial(anchor) {
    const { app } = this;
    const { product, db, selectedParts } = app;
    const parts = selectedParts.filter(isPanel);
    if (!parts.length) return;
    const rows = [...new Set(parts.flatMap((part) => db.byPos(part.kind).filter((row) => canUsePartMaterial(db, product, part, row))))];
    const result = await pickPartCatalog({ title: 'Материал детали', rows, current: db.get(parts[0].kod), anchor });
    if (result && app.product === product && app.selected === selectedParts[0]) app.setMaterial(result.kod);
  }

  drawTabs() {
    const { app } = this;
    const tabs = $('tabs');
    const activeId = app.mode === 'room' ? 0 : app.activeId;
    const entries = app.project.products.map((p) => [p.id, `${String(p.num).padStart(2, '0')}. ${p.title}${p.through ? ' [СКВОЗНОЕ]' : ''}`]);
    if (app.project.room) entries.unshift([0, 'Комната']);
    const content = JSON.stringify(entries);
    if (this.tabsContent === content && this.tabActiveId === activeId) return;
    if (this.tabsContent !== content) {
      const focusedId = tabs.contains(document.activeElement) ? document.activeElement.dataset.product : null;
      tabs.replaceChildren(...entries.map(([id, caption]) => h('button', { type: 'button', dataset: id ? { product: id, touchMenu: '' } : { product: id },
        title: id ? 'Двойной щелчок — настройки изделия' : '',
      }, caption)));
      if (focusedId != null) tabs.querySelector(`[data-product="${focusedId}"]`)?.focus({ preventScroll: true });
    }
    for (const tab of tabs.children) {
      const active = Number(tab.dataset.product) === activeId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    }
    tabs.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.tabsContent = content;
    this.tabActiveId = activeId;
  }

  drawStatus() {
    const { app } = this;
    const { room } = app.project;
    const product = app.mode === 'product' ? app.product : null;
    const { W = 0, H = 0, G = 0 } = product ?? room ?? {};
    const size = [W, H, G].map((value) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1, useGrouping: false }));
    const dimensions = `Ширина: ${size[0]}  |  Высота: ${size[1]}  |  Глубина: ${size[2]}`;
    $('status-shop').textContent = app.db.meta.shop || 'Деталировка';
    const status = $('status-size');
    status.textContent = app.placement ? 'Установка макета.' : dimensions;
    status.classList.toggle('busy', Boolean(app.placement));
    status.title = status.textContent;
    $('price-info').textContent = app.project.products.length ? `Стоимость проекта: ${money(projectTotal(app.db, app.project))} руб.` : '';
  }

  drawCatalog() {
    const { app } = this;
    const host = $('catalog');
    const sub = app.editingRoom ? 'room' : app.sub;
    if (app.mode !== 'product' && !app.editingRoom) return;
    const overview = sub === 'overview';
    $('product-settings').hidden = !overview;
    $('product-settings').disabled = !app.product;
    $('product-remove').hidden = !overview;
    $('product-remove').disabled = !app.product;
    host.hidden = overview;
    const search = $('catalog-search');
    search.hidden = document.querySelector('.preset').hidden = sub === 'doors' || overview;
    search.setAttribute('aria-label', sub === 'room' ? 'Поиск по наполнению комнаты' : 'Поиск по наполнению');
    host.setAttribute('aria-label', sub === 'room' ? 'Элементы комнаты' : 'Наполнение изделия');
    if (overview) return;
    if (sub === 'doors') { this.drawDoors(host); return; }
    this.drawFillTree(host, search, sub);
  }

  drawFillTree(host, search, section) {
    const { app } = this;
    const isRoom = section === 'room';
    const filter = search.value.trim().toLowerCase();
    const nodeLabel = (node) => node.children ? node.name.replace(/^\d+,\s*-*\s*/, '') : node.name.replace(/^\d+\.\s*/, '');
    const filterTree = (nodes, inherited = false) => nodes.flatMap((node) => {
      const matched = inherited || nodeLabel(node).toLowerCase().includes(filter);
      if (node.children) {
        const children = filterTree(node.children, matched);
        return children.length ? [{ ...node, children }] : [];
      }
      const items = matched ? node.items : node.items.filter((item) => item.name.toLowerCase().includes(filter));
      return items.length ? [{ ...node, items }] : [];
    });
    const rows = [];
    const containsItem = (node, item) => node.items?.includes(item) || node.children?.some((child) => containsItem(child, item));
    const toggle = (key, node) => {
      const closing = this.expanded.delete(key);
      if (!closing) this.expanded.add(key);
      if (closing && app.tool && containsItem(node, app.tool.item)) app.cancelPlacement();
      else this.drawCatalog();
      host.querySelector(`[data-tree-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    };
    const walk = (nodes, path, depth) => {
      for (const node of nodes) {
        const key = path + '/' + node.name;
        const open = !!filter || this.expanded.has(key);
        rows.push(h('button', { class: `cat-row ${node.children ? 'folder' : 'file'}${open ? ' open' : ''}`, type: 'button',
          style: `--depth:${depth}`, dataset: { treeKey: key }, ariaLabel: nodeLabel(node), ariaExpanded: String(open),
          onclick: () => { if (!filter) toggle(key, node); },
        }, nodeLabel(node)));
        if (!open) continue;
        if (node.children) { walk(node.children, key, depth + 1); continue; }
        for (const item of node.items) {
          if (isRoom && !this.roomItems.has(item)) this.roomItems.set(item, roomItemSupported(item) ? roomItemSpec(app.db, item) : null);
          const tool = isRoom ? this.roomItems.get(item) : TOOLS.find((candidate) => candidate.accepts(item, app.sub));
          const active = app.tool?.item === item;
          rows.push(h('button', {
            class: 'cat-row item' + (tool ? '' : ' off') + (active ? ' selected' : ''),
            type: 'button', disabled: !tool, style: `--depth:${depth + 1}`, ariaPressed: String(active),
            title: tool ? `Выберите и укажите место ${isRoom ? 'в комнате' : 'в изделии'}` : 'Пока не поддерживается на сайте',
            onclick: () => {
              if (active) app.cancelPlacement();
              else if (isRoom) startRoomTool(app, item, tool, () => this.presets());
              else tool.start(app, item, () => this.presets());
            },
          }, item.name.trim()));
        }
      }
    };
    const nodes = app.catalog[section] ?? [];
    walk(filter ? filterTree(nodes) : nodes, section, 0);
    host.replaceChildren(...rows);
  }

  drawDoors(host) {
    const { app } = this;
    const { db } = app;
    const system = app.doorSystems['ДСП'];
    const product = app.product;
    if (!product || !system) { host.replaceChildren(); return; }
    const opt = doorOptions(db, system);
    const cfg = this.doorCfg ??= defaultDoorConfig(db, system, product);
    const redraw = () => this.drawCatalog();
    const select = (value, options, onchange) => h('select', { style: 'width:100%', onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
    const line = (label, control) => h('div', { class: 'rp-row', style: 'grid-template-columns:76px 1fr;padding:0 4px' }, h('label', {}, label), control);
    const pickLeaf = async () => {
      const kod = await pickRow({ title: 'Материал двери', rows: opt.materials, current: cfg.kod, confirmSelection: true });
      if (kod != null) { cfg.kod = kod; redraw(); }
    };
    const pickHandle = async () => {
      const kod = await pickRow({ title: 'Ручка', rows: opt.handles, current: cfg.handle, groupBy: (r) => r.sub ?? r.name, label: (r) => `${r.name} ${r.art ?? ''} ${r.color ?? ''}` });
      if (kod != null) { cfg.handle = kod; redraw(); }
    };
    const start = () => {
      app.select(0);
      app.setTool({ item: cfg, depth: (p) => p.G - 5, place: (a, p, point) => a.placeDoor(p, structuredClone(cfg), point) });
    };
    const sideNames = { l: 'Слева', r: 'Справа', b: 'Снизу', t: 'Сверху' };
    host.replaceChildren(
      h('div', { class: 'rp-head' }, 'Распашные двери, монолит ДСП'),
      line('Дверей', select(cfg.count, [[1, '1'], [2, '2']], (v) => { cfg.count = Number(v); })),
      line('Материал', h('button', { class: 'pick', style: 'width:100%;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis', onclick: pickLeaf }, rowLabel(db.get(cfg.kod)))),
      h('div', { class: 'rp-head' }, 'Наложение на детали проёма'),
      ...Object.entries(sideNames).map(([s, text]) => line(text, select(cfg.overlay[s], Object.entries(OVERLAYS), (v) => { cfg.overlay[s] = v; }))),
      h('div', { class: 'rp-head' }, 'Фурнитура'),
      line('Ручка', h('button', { class: 'pick', style: 'width:100%;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis', onclick: pickHandle }, rowLabel(db.get(cfg.handle)))),
      line('Положение', select(cfg.handlePos, Object.entries(HANDLE_POS), (v) => { cfg.handlePos = v; })),
      line('Петли', select(cfg.family, opt.families.map((f) => [f, f]), (v) => { cfg.family = v; })),
      h('div', { class: 'rp-sub', style: 'padding:6px' }, `Ширина одной двери: от ${opt.minW + 1} до ${opt.maxW - 1} мм. Петли ставятся со стороны, противоположной ручке.`),
      h('button', { class: 'big' + (app.tool?.item === cfg ? ' active' : ''), style: 'width:100%', onclick: start }, 'Установить в проём'),
      h('button', { class: 'big', style: 'width:100%', disabled: !doorOpeningFromParts(app.selectedParts),
        onclick: () => app.placeDoorInSelection(cfg) }, 'Установить по выделенным деталям'));
  }

  drawPanelToggle(side) {
    const visible = !$(side).hidden;
    const toggle = $(side + '-toggle');
    toggle.classList.toggle('active', visible);
    toggle.setAttribute('aria-expanded', String(visible));
  }

  drawRight() {
    const { app } = this;
    const host = $('right');
    const { product } = app;
    const context = app.editingRoom ? 'room' : app.mode === 'product' && product ? app.sub : null;
    if (this.rightContext !== context) {
      this.rightContext = context;
      this.rightVisible = context === 'fill' || context === 'room';
    }
    host.hidden = !this.rightVisible;
    this.drawPanelToggle('right');
    if (host.hidden) return;
    if (context === 'room') { this.drawRoomElement(host); return; }
    const part = context ? app.selected : null;
    if (!part) {
      host.replaceChildren(h('div', { class: 'rp-sub' }, context ? 'Выберите деталь в 3D.' : 'Перейдите к редактированию изделия.'));
      return;
    }
    const { db } = app;
    const root = app.movable;
    const drawer = root.data.drawer;
    const positionPart = drawer ? root : part;
    const gap = (side) => {
      const nb = product.get(positionPart.nb[SIDE_NB[side]]);
      if (!nb) return 0;
      const d = LO_SIDES.has(side) ? positionPart.box[side] - nb.box[OPPOSITE[side]] : nb.box[OPPOSITE[side]] - positionPart.box[side];
      return Math.round(d * 10) / 10;
    };
    const { selectedParts, selectedPanel, selectedRoots } = app;
    const gapInput = (side) => {
      const axis = SIDE_AXIS[side];
      const value = gap(side);
      const direct = canSetGapDirectly(positionPart, axis);
      const smart = selectedRoots.some((p) => canMove(product, p, axis) || isFullyLocked(p));
      const apply = (input, withAlt) => {
        const distance = calc(input.value);
        input.value = String(value);
        if (Number.isFinite(distance) && (withAlt ? direct : smart)) app.setGap(side, distance, { direct: withAlt });
      };
      let submitOnEnter = false;
      return h('input', {
        type: 'text', inputMode: 'decimal', value, disabled: !direct && !smart,
        title: 'Расстояние до соседней детали · Alt+Enter — задать напрямую',
        onkeydown: (e) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          e.preventDefault();
          submitOnEnter = true;
          apply(e.currentTarget, e.altKey);
          e.currentTarget.blur();
          submitOnEnter = false;
        },
        onchange: (e) => { if (!submitOnEnter) apply(e.currentTarget, false); },
      });
    };
    const cost = partCost(db, part);
    const net = netSize(part);

    const edges = selectedPanel ? edgeChoices(db, selectedPanel) : [];
    const edgeRows = selectedPanel ? edgeSides(selectedPanel.group).map((side) => {
      const title = `Кромка: ${SIDE_LABEL[side]}`;
      const code = selectedPanel.edge[side];
      const applied = selectedPanel.kr[side] > 0 ? db.get(selectedPanel.edgeKod[side]) : null;
      const automatic = applied && code === 0 ? `Авто: ${rowLabel(applied)}` : 'Авто (по стандарту)';
      const current = code < 0 ? 'Без кромки' : code === 0 ? automatic : rowLabel(db.get(code));
      const choose = async (event) => {
        const result = await pickRow({ title, anchor: event.currentTarget, rows: edges, current: code < 0 ? -2 : code || applied?.kod || 0,
          withModifiers: true,
          extra: [{ text: automatic, value: 0 }, { text: 'Без кромки', value: -2 }],
          label: (row) => [row.color, row.art].filter(Boolean).join(' · ') || row.name,
        });
        if (result && app.product === product && app.selectedPanel === selectedPanel) {
          app.setEdge(side, result.value, { allSides: result.ctrlKey });
        }
      };
      return h('div', { class: 'rp-row' }, h('label', {}, SIDE_LABEL[side]),
        h('button', { title: `${current} · Выбор с Ctrl — для всех сторон`, ariaLabel: title,
          ariaHasPopup: 'dialog', ariaExpanded: 'false', onclick: choose }, current));
    }) : [];

    const sizeRows = Object.keys(AXIS_SIDES).map((axis) => this.dimensionRow(axis, part.box.size(axis),
      !selectedParts.some((p) => canResize(p, axis)), (value, keepHigh) => app.resizeSelected(axis, value, keepHigh),
      gapInput, (side) => app.setGap(side, 0)));

    const { min, max } = materialLimits(db, part);
    const limitsTable = h('table', { class: 'rp-limits', ariaLabel: 'Минимальные и максимальные размеры, мм' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'min'), h('th', { scope: 'col' }, 'мм'), h('th', { scope: 'col' }, 'max'))),
      h('tbody', {}, Object.entries(AXIS_LABEL).map(([axis, label]) => h('tr', {},
        h('td', {}, min[axis] > 0 ? round(min[axis]) : '—'),
        h('th', { scope: 'row' }, label),
        h('td', {}, max[axis] > 0 ? round(max[axis]) : '—')))));

    const contents = [
      ...sizeRows,
      isPanel(part) ? h('div', { class: 'rp-sub rp-area' },
        `Площадь: ${(net.a * net.b / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 3 })} м²`) : null,
      ...this.mountControls(selectedPanel, () => ({ product, part: selectedPanel }),
        () => !app.editingRoom && app.product === product && app.selectedPanel === selectedPanel),
      isPanel(part) ? h('div', { class: 'rp-sub', style: 'margin-top:4px' }, `Деталь без кромки: ${Math.round(net.a * 10) / 10} × ${Math.round(net.b * 10) / 10}`) : null,
      limitsTable,
      edgeRows.length ? h('div', { class: 'rp-head' }, 'Кромка') : null, ...edgeRows,
      h('div', { class: 'rp-head' }, 'Стоимость детали'),
      h('div', { class: 'rp-sub' }, `${money(cost.total)} руб. (материал ${money(cost.material)}, кромка ${money(cost.edges)})`),
      h('div', { class: 'rp-actions' }, h('button', { class: 'danger', onclick: () => app.deleteSelected() },
        selectedRoots.length > 1 ? 'Удалить выделенное' : 'Удалить')),
    ];
    host.replaceChildren(...contents.filter(Boolean));
  }

  dimensionRow(axis, size, disabled, resize, gapInput, zeroGap) {
    const [lo, hi] = AXIS_SIDES[axis];
    const label = AXIS_LABEL[axis];
    const value = round(size);
    const keepFieldFocus = (event) => { if (event.button === 0) event.preventDefault(); };
    const input = h('input', {
      type: 'text', inputMode: 'decimal', enterKeyHint: 'done', value, disabled, ariaLabel: label,
      title: 'Enter — применить с учётом доступного места. Shift+Enter — сначала двигать левую, нижнюю или заднюю грань.',
      onkeydown: (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        const control = event.currentTarget;
        const next = calc(control.value);
        if (Number.isFinite(next)) resize(next, event.shiftKey || this.resizeSides[axis] === lo);
        control.value = value;
      },
    });
    const buttons = [lo, hi].map((side) => {
      const caption = `Двигать ${RESIZE_FACE[side]} грань`;
      return h('button', { type: 'button', class: 'rp-resize-arrow', ariaLabel: caption,
        ariaPressed: String(this.resizeSides[axis] === side),
        title: `${caption} при изменении размера · двойной щелчок — придвинуть к опоре`,
        onpointerdown: keepFieldFocus,
        onclick: () => {
          this.resizeSides[axis] = side;
          for (const [index, button] of buttons.entries()) button.setAttribute('aria-pressed', String([lo, hi][index] === side));
        },
        ondblclick: () => zeroGap(side),
      }, RESIZE_ARROW[side]);
    });
    const gap = (side) => {
      const control = gapInput(side);
      control.setAttribute('aria-label', GAP_LABEL[side]);
      return control;
    };
    return h('div', { class: 'rp-grid', role: 'group', ariaLabel: label },
      buttons[0], h('button', { class: 'rp-size-title', type: 'button',
        title: 'Расположить по центру между опорами', onpointerdown: keepFieldFocus,
        onclick: () => {
          const field = document.activeElement;
          if (field instanceof HTMLInputElement && $('right').contains(field)) field.blur();
          this.app.centerSelected(axis);
        } }, label),
      buttons[1], gap(lo), input, gap(hi));
  }

  mountControls(part, catalogContext, isCurrent, replaceLabel) {
    const { app } = this;
    const { db } = app;
    const configure = async (side, anchor) => {
      if (!part) return;
      const sides = side ? [side] : Object.keys(MOUNT_LABEL).filter((s) => part.mount[s]);
      const title = side ? `Крепление: ${SIDE_LABEL[side]}` : 'Крепления для всех закреплённых сторон';
      const current = sides.map((s) => part.krep[s]).find((kod) => kod > 0);
      const context = catalogContext();
      const modes = [
        ['Стандартный', krepChoices(db, context.product, context.part, side)],
        ['Расширенный', krepForPart(db, context.part)],
        ['Все', db.krepCatalog()],
      ];
      const result = await pickPartCatalog({ title, modes, current: db.get(current), anchor, replacing: !!side && current > 0, replaceLabel,
        initialMode: this.krepMode, onModeChange: (mode) => { this.krepMode = mode; },
      });
      if (result && isCurrent()) app.setKrep(side, result.kod, { replace: result.replace });
    };
    const buttons = Object.entries(MOUNT_LABEL).map(([side, label]) => {
      const row = db.get(part?.krep[side]);
      const title = row ? `${SIDE_LABEL[side]}: ${rowLabel(row)}` : SIDE_LABEL[side];
      const mounted = !!part?.mount[side];
      const choose = (event) => { event.stopPropagation(); configure(side, event.currentTarget); };
      return h('button', {
        class: `mount-${side}${mounted ? ' mounted' : ''}`, ariaPressed: String(mounted),
        dataset: { touchMenu: '' },
        title: `${title} · ПКМ — выбрать крепление · двойной щелчок — прикрепить или открепить`, ariaLabel: SIDE_LABEL[side],
        onclick: (event) => { if (event.detail === 0) app.toggleMount(side); },
        ondblclick: () => app.toggleMount(side),
        oncontextmenu: choose,
      }, label);
    });
    const choose = (event) => configure(null, event.currentTarget);
    return [h('div', { class: 'rp-head' }, 'Крепления'),
      h('div', { class: 'krep-cross', role: 'group', ariaLabel: 'Стороны крепления', dataset: { touchMenu: '' },
        oncontextmenu: choose }, buttons)];
  }

  drawRoomElement(host) {
    const { app } = this;
    const element = app.roomSelected;
    if (!element) {
      host.replaceChildren(h('div', { class: 'rp-sub' }, 'Выберите элемент комнаты в 3D.'));
      return;
    }
    const { room } = app.project;
    const box = roomElementBox(room, element);
    const mounts = roomMounts(element);
    const field = (value, disabled, apply) => h('input', {
      type: 'text', inputMode: 'decimal', value: round(value), disabled, title: 'Расстояние до границы комнаты',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.currentTarget.blur();
      },
      onchange: (event) => {
        const input = event.currentTarget;
        const value = calc(input.value);
        if (!Number.isFinite(value) || !apply(value)) this.drawRight();
      },
    });
    host.replaceChildren(h('div', { class: 'rp-head' }, [element.tag, element.title].filter((value, i, values) => value && values.indexOf(value) === i).join(' · ')),
      ...Object.entries(AXIS_SIDES).map(([axis, [lo, hi]]) => {
        const free = room[ROOM_DIMENSION[axis]] - box.size(axis);
        const fixed = roomAxisFixed(element, axis);
        const gapInput = (side) => side === lo
          ? field(box[lo], fixed, (value) => app.moveRoomElement({ [axis]: value }))
          : field(free - box[lo], fixed, (value) => app.moveRoomElement({ [axis]: free - value }));
        return this.dimensionRow(axis, box.size(axis), element.tag === 'Розетка' || !!(mounts[lo] && mounts[hi]),
          (value, keepHigh) => app.resizeRoomElement(axis, value, keepHigh), gapInput, (side) => app.zeroRoomGap(side));
      }),
      ...this.mountControls({ mount: mounts, krep: element.krep ?? {} },
        () => roomKrepContext(room, element, app.db.get(element.kod)),
        () => app.editingRoom && app.project.room === room && app.roomSelected === element, 'Заменить во всей комнате'),
      h('div', { class: 'rp-actions' }, h('button', { class: 'danger', onclick: () => app.deleteSelected() }, 'Удалить')));
  }

  showPartPanel() {
    this.rightContext = this.app.editingRoom ? 'room' : this.app.sub;
    this.rightVisible = true;
    this.drawRight();
  }
}
