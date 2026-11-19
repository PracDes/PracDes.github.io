import { KIND, PANEL_KINDS } from '../core/model.js';
import { previewBox } from '../core/build.js';
import { DRAWER_KINDS, automaticDrawerHeight, drawerHandles, drawerNeedsHandle, drawerPreparationQuestions, planDrawer, previewDrawer } from '../core/drawers.js';
import { h, openModal, pickRow } from './dialogs.js';
import { batchDialog } from './batch-dialog.js';

const panelBatchSettings = {};
const drawerBatchSettings = {};
const hasPanelOptions = (item) => item.id === KIND.POLKA || item.id === KIND.PEREG;

function drawerQuestion(text, no = 'Нет', yes = 'Да') {
  return new Promise((resolve) => openModal({
    title: 'Установка накладного ящика', body: h('div', {}, text), onClose: resolve,
    buttons: [{ text: no, action: (close) => close(false) }, { text: yes, primary: true, action: (close) => close(true) }],
  }));
}

async function prepareDrawer(app, product, item, point, single) {
  const options = { cutSides: false, ...point.drawerOptions };
  const draft = { ...point, drawerOptions: options };
  let questions = drawerPreparationQuestions(app.db, product, item, draft);
  if (questions.cutSides) {
    options.cutSides = await drawerQuestion('Необходимо ли уменьшить ширину боковин на толщину фасада?');
    if (options.cutSides == null) return null;
  }
  questions = drawerPreparationQuestions(app.db, product, item, draft);
  if (questions.cutLevels) {
    options.cutLevels = await drawerQuestion('Необходимо ли уменьшить ширину полки сверху / снизу на толщину фасада?');
    if (options.cutLevels == null) return null;
  }
  for (const [key, text] of [['left', 'левую'], ['right', 'правую']]) {
    if (!questions[key]) continue;
    options[key] = await drawerQuestion(`Наложить на ${text} боковину?`);
    if (options[key] == null) return null;
  }
  if (!single) return draft;
  questions = planDrawer(app.db, product, item, draft).questions;
  for (const [key, direction] of [['lower', 'снизу'], ['upper', 'сверху']]) {
    if (!questions[key]) continue;
    const overlay = await drawerQuestion(`Наложить фасад ящика ${direction}?`);
    if (overlay == null) return null;
    if (!overlay) continue;
    const full = await drawerQuestion('Наложить полностью?', 'На половину', 'Полностью');
    if (full == null) return null;
    options[key] = full ? 'full' : 'half';
  }
  return draft;
}

function startTool(app, item, sized, place, preview, batch, drawer = false) {
  app.select(0);
  const tool = {
    item,
    place: (a, product, point, spec = sized()) => place(a, product, spec, point),
    preview: (product, point) => preview(product, sized(), point),
  };
  if (item.id === KIND.BOX_NAKL) {
    tool.prepare = (product, spec, point, single) => prepareDrawer(app, product, spec, point, single);
    tool.spec = sized;
  }
  if (batch) tool.options = (point) => batchDialog(app, app.product, tool, sized(), point, drawer, batch);
  app.setTool(tool);
}

export function withPresets(item, readPresets) {
  const presets = readPresets();
  if (!presets || (!presets.a && !presets.b)) return item;
  const out = { ...item };
  const set = (key, value) => { if (value > 0) out[key] = String(value); };
  if (DRAWER_KINDS.has(item.id)) {
    if (automaticDrawerHeight(item)) {
      set('H', presets.a);
      set('MinH', presets.a);
    }
    set('G', presets.b);
    return out;
  }
  if (item.group === 1) set('W', presets.a);
  else if (item.group === 2) set('H', presets.a);
  else { set('W', presets.a); set('H', presets.b); }
  if (item.group !== 0) set('G', presets.b);
  return out;
}

const panelTool = {
  accepts: (item, sub) => sub === 'fill' && PANEL_KINDS.has(item.id),
  start(app, item, readPresets) {
    const batch = hasPanelOptions(item) ? panelBatchSettings : null;
    startTool(app, item, () => withPresets(item, readPresets),
      (a, product, spec, point) => a.placeItem(product, spec, point), previewBox, batch);
  },
};

export function startRoomTool(app, item, spec, readPresets) {
  const tool = { item, room: spec.panel ? { ...spec, panel: withPresets(spec.panel, readPresets) } : spec };
  if (spec.panel && hasPanelOptions(item)) {
    tool.options = (point) => batchDialog(app, app.project.room, tool, tool.room.panel, point, false, panelBatchSettings);
  }
  app.selectRoom(0);
  app.setTool(tool);
}

const drawerTool = {
  accepts: (item, sub) => sub === 'fill' && DRAWER_KINDS.has(item.id),
  async start(app, item, readPresets) {
    const product = app.product;
    const handle = drawerNeedsHandle(item) ? await pickRow({
      title: 'Выбор ручки',
      rows: drawerHandles(app.db),
      groupBy: (row) => row.name,
      label: (row) => [row.art, row.color].filter(Boolean).join(' · '),
      extra: [{ text: 'Без ручки', value: 0 }],
    }) : 0;
    if (handle == null || app.product !== product || app.mode !== 'product' || app.sub !== 'fill') return;
    const sized = () => ({ ...withPresets(item, readPresets), handle });
    startTool(app, item, sized, (a, p, spec, point) => a.placeDrawer(p, spec, point),
      (p, spec, point) => previewDrawer(app.db, p, spec, point), drawerBatchSettings, true);
  },
};

const FILLER_SIDES = { Левая: 'l', Правая: 'r', Нижняя: 'b', Верхняя: 't' };

const fillerTool = {
  accepts: (item, sub) => sub === 'fill' && item.id === 660 && item.tag === 'I-образная',
  start(app, item) {
    const material = app.product.form?.material ?? app.product.form?.parts.left;
    const row = app.db.get(material?.kod);
    if (!row) return app.toast('Задайте материал изделия');
    const title = item.name.replace(/\s+I\s*$/, '');
    const anchorSide = FILLER_SIDES[title.split(' ')[0]];
    const vertical = anchorSide === 'l' || anchorSide === 'r';
    const sized = {
      id: vertical ? KIND.PEREG : KIND.POLKA, group: vertical ? 2 : 1,
      name: title, title, kod: row.kod, edge: material.edge, anchorSide,
      [vertical ? 'W' : 'H']: String(row.t), G: '100',
    };
    app.select(0);
    app.setTool({
      item, depth: (product) => product.G - Math.min(50, product.G / 2),
      place: (a, product, point) => a.placeItem(product, sized, point),
      preview: (product, point) => previewBox(product, sized, point),
    });
  },
};

export const TOOLS = [panelTool, drawerTool, fillerTool];
