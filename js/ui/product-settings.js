import { AXIS_SIDES, SIDE_LABEL } from '../core/geom.js';
import { commonMaterials, FILL_SLOT, krepColors, krepTypes, SLOTS, slotEdges, slotMaterials } from '../core/product.js';
import { EDGE_MODES } from '../core/product-settings.js';
import { confirmDialog, h, openModal, pickRow, rowLabel } from './dialogs.js';

const check = (text, props = {}) => h('label', { class: 'settings-check' }, h('input', { type: 'checkbox', ...props }), text);
const edit = (value, ariaLabel, props = {}) => h('input', { value, ariaLabel, ...props });
const number = (value, label, props) => edit(value, label, { type: 'number', min: 1, required: true, ...props });
const select = (ariaLabel, options, props = {}) => h('select', { ariaLabel, ...props },
  options.map(([value, text]) => h('option', { value }, text)));
const fixed = (title, text) => select(title, [[text, text]], { disabled: true, title: 'Недоступно в веб-версии' });

export function productSettingsDialog(app, product) {
  const { db, project } = app;
  const { form } = product;
  const id = product.id;
  const name = edit(product.title, 'Имя изделия');
  const groups = h('datalist', { id: 'settings-product-groups' },
    [...new Set(project.products.map((item) => item.titleGroup).filter(Boolean))].map((value) => h('option', { value })));
  const group = edit(product.titleGroup ?? '', 'Группа изделия');
  group.setAttribute('list', groups.id);
  const groupNumber = edit(product.positionGroup ?? '', '№ объединения', { inputMode: 'numeric', pattern: '[0-9]*' });
  const cut = edit(product.cutNote ?? '', '№ цеха', { inputMode: 'numeric', pattern: '[0-9]*' });
  const order = number(product.num, 'Номер', { max: project.products.length });
  const count = number(product.count, 'Количество');
  const hard = check('Учет работ', { checked: product.hard, disabled: true });
  const lacquer = check('Свой лак', { disabled: true });
  const useKromE = check('E кромка - основная', { checked: product.useKromE });
  const materialEdges = check('Испол. кромку материала');
  const entries = {};
  const targets = [];
  const material = h('div', { class: 'settings-material-column' }, h('span', {}, 'Материал'));
  const edgeRadios = Object.keys(EDGE_MODES).sort().map((key) => [key,
    check(key, { type: 'radio', name: 'settings-edge-mode', checked: key === 'V' })]);
  const edges = h('div', { class: 'settings-material-column' }, h('div', { class: 'settings-edge-heading' },
    check('Лак', { type: 'radio', disabled: true }), h('span', {}, 'Кромка'), edgeRadios.map(([, label]) => label)));
  const mode = () => edgeRadios.find(([, label]) => label.firstChild.checked)[0];
  const updates = [];
  const sync = () => updates.forEach((update) => update());
  const common = { kod: 0, edge: 0 };
  const picker = (slot, entry, isEdge) => {
    const all = !slot;
    const fill = slot === FILL_SLOT;
    const title = isEdge ? `Кромка · ${slot?.title ?? 'Задать все позиции'}` : slot?.title ?? 'Задать все позиции';
    const key = isEdge ? 'edge' : 'kod';
    const button = h('button', { type: 'button', class: 'settings-pick', ariaLabel: title, ariaHasPopup: 'dialog',
      onclick: async () => {
        const listSlot = slot ?? SLOTS[0];
        const rows = isEdge ? slotEdges(db, listSlot, db.get(entry.kod || form.parts.left.kod))
          : all ? commonMaterials(db) : slotMaterials(db, slot);
        const kod = await pickRow({ title, rows, current: entry[key], anchor: button, confirmSelection: !isEdge });
        if (kod == null) return;
        entry[key] = kod;
        const change = (target, definition) => {
          if (isEdge && !slotEdges(db, definition, db.get(target.kod)).some((row) => row.kod === kod)) return;
          if (!isEdge && definition !== FILL_SLOT && !db.get(kod)?.posSet.has(definition.pos)) return;
          target[key] = kod;
          if (!isEdge || definition !== FILL_SLOT) target.control.checked = true;
          if (!isEdge) target.edge = 0;
        };
        if (all) {
          for (const [target, definition] of targets) if (!target.control.disabled) change(target, definition);
        } else change(entry, slot);
        if (!isEdge) materialEdges.firstChild.checked = true;
        if (isEdge) materialEdges.firstChild.checked = false;
        sync();
      },
    }, h('span'));
    updates.push(() => {
      const row = db.get(entry[key]);
      const caption = row ? (fill ? row.color : rowLabel(row)) : isEdge ? 'Кромка по стандарту' : '';
      button.firstChild.textContent = caption;
      button.title = caption;
      button.disabled = !!entry.control?.disabled;
    });
    return button;
  };
  const labels = h('div', { class: 'settings-material-labels' }, h('span', {}, 'Задать все позиции'));
  material.append(picker(null, common, false));
  edges.append(picker(null, common, true));
  for (const slot of [FILL_SLOT, ...SLOTS]) {
    const part = product.role(slot.role);
    const fill = slot === FILL_SLOT;
    const label = check(fill ? 'Цвет наполнения' : slot.title, { disabled: !fill && !part });
    const entry = { kod: fill ? form.fill.kod : part?.kod ?? 0, edge: 0, control: label.firstChild };
    entries[slot.key] = entry;
    targets.push([entry, slot]);
    labels.append(label);
    material.append(picker(slot, entry, false));
    edges.append(picker(slot, entry, true));
  }
  edges.append(h('button', { type: 'button', disabled: true }, 'Задать колер / эмаль / патину'));

  const defaults = check('Настройки креплений по умолчанию');
  const allDefaults = check('Для всех изделий');
  const fixings = {};
  const defaultsControls = (corpus) => {
    const typeKey = corpus ? 'krepKor' : 'krepNap';
    const colorKey = corpus ? 'zag1' : 'zag2';
    const title = corpus ? 'Для корпуса' : 'Для наполнения';
    const types = [...new Set([product[typeKey], ...krepTypes(db, corpus)])];
    const type = select(title, types.map((name) => [name, name]));
    const color = select(`Цвет · ${title}`, []);
    type.value = product[typeKey];
    const update = (kod) => {
      const colors = krepColors(db, type.value, corpus);
      color.replaceChildren(...colors.map((row) => h('option', { value: row.kod }, row.color || '—')));
      if (colors.some((row) => row.kod === kod)) color.value = kod;
    };
    type.addEventListener('change', () => {
      update();
      const fillType = type.value === 'Экцентр. стяжка (минификс) + Шкант' ? 'Экцентр. стяжка (минификс)' : type.value;
      if (corpus && [...fixings.krepNap.options].some((option) => option.value === fillType)) {
        fixings.krepNap.value = fillType;
        fixings.krepNap.dispatchEvent(new Event('change'));
      }
    });
    update(product[colorKey]);
    fixings[typeKey] = type;
    fixings[colorKey] = color;
    return h('div', { class: 'settings-krep-column' }, h('label', {}, title, type), h('label', {}, 'Цвет', color));
  };
  const krep = h('section', { class: 'settings-krep' }, h('div', {}, defaults, allDefaults),
    h('div', {}, defaultsControls(true), defaultsControls(false)));
  const toggleDefaults = () => {
    const enabled = defaults.firstChild.checked;
    for (const control of Object.values(fixings)) control.disabled = !enabled;
    allDefaults.firstChild.disabled = !enabled;
  };
  defaults.firstChild.addEventListener('change', toggleDefaults);
  toggleDefaults();

  const dimensions = Object.fromEntries([['W', 'Ширина'], ['H', 'Высота'], ['G', 'Глубина']].map(([key, title]) =>
    [key, number(product[key], title, { step: 'any' })]));
  const physical = check('Изменить габариты изделия');
  const resize = check('Изменить габариты пространства изделия');
  const checkSizes = check('Проверка размеров деталей', { checked: true });
  const syncResize = () => { for (const input of Object.values(dimensions)) input.disabled = !resize.firstChild.checked; };
  physical.firstChild.addEventListener('change', () => {
    if (physical.firstChild.checked) resize.firstChild.checked = true;
    syncResize();
  });
  resize.firstChild.addEventListener('change', () => {
    if (!resize.firstChild.checked) physical.firstChild.checked = false;
    syncResize();
  });
  syncResize();
  const sideCheck = Object.fromEntries(['l', 'r', 't', 'b', 'f', 'g'].map((side) => [side, check(SIDE_LABEL[side])]));
  for (const [first, second] of Object.values(AXIS_SIDES)) {
    for (const [side, opposite] of [[first, second], [second, first]]) {
      sideCheck[side].firstChild.addEventListener('change', (e) => { if (e.target.checked) sideCheck[opposite].firstChild.checked = false; });
    }
  }
  const surfaces = [
    ['floor', 'Пол', ['Обычный', 'Мягкий']],
    ['ceiling', 'Потолок', ['Обычный', 'Подвесной']],
    ['walls', 'Стены', ['Обычный']],
  ].map(([key, title, options]) => {
    const control = select(title, options.map((value) => [value, value]), { disabled: !project.room });
    control.value = project.room?.surfaceMaterials?.[key] ?? options[0];
    return { key, control, label: h('label', {}, title, control) };
  });
  const body = h('div', { class: 'settings-form' },
    h('section', { class: 'settings-materials' },
      h('div', { class: 'settings-head' }, hard, lacquer, h('label', {}, '№ объединения:', groupNumber),
        h('label', {}, '№ цеха:', cut), h('label', {}, 'Номер:', order)),
      h('div', { class: 'settings-name' }, h('span', {}, 'Имя / Группа изделия'), name, group, groups),
      h('div', { class: 'settings-matrix' }, labels, material, edges),
      h('div', { class: 'settings-edge-flags' }, materialEdges, useKromE)),
    krep,
    h('section', { class: 'settings-room' },
      h('div', {}, h('span', {}, 'Магазин'), h('div', { class: 'settings-shop-frame' }, fixed('Магазин', 'Деталировка'))),
      h('div', {}, h('span', {}, 'Настройки материала комнаты'),
        h('div', { class: 'settings-room-surfaces' }, surfaces.map(({ label }) => label)))),
    h('div', { class: 'settings-sides' }, h('span', {}, 'Передвигать:'), Object.values(sideCheck), checkSizes),
    h('div', { class: 'settings-resize' }, physical, resize));
  sync();
  let applying = false;
  openModal({ title: 'Настройки изделия', className: 'settings-modal', body,
    footer: (close) => [h('button', { class: 'settings-info', type: 'button', disabled: true, title: 'Информация о заготовке' }, 'ⓘ'),
      h('div', { class: 'settings-dimensions' }, [...Object.values(dimensions), count].map((input) => h('label', {}, input.ariaLabel, input))),
      h('button', { class: 'settings-apply', type: 'button', onclick: async () => {
        if (applying) return;
        const invalid = [order, count, groupNumber, cut, ...Object.values(dimensions)].find((input) => !input.validity.valid);
        if (invalid) { invalid.reportValidity(); return; }
        const sides = Object.fromEntries(Object.entries(AXIS_SIDES).map(([axis, values]) =>
          [axis, values.find((side) => sideCheck[side].firstChild.checked)]));
        const settings = {
          title: name.value, titleGroup: group.value, positionGroup: groupNumber.value, cutNote: cut.value,
          num: order.valueAsNumber, count: count.valueAsNumber, hard: hard.firstChild.checked,
          useKromE: useKromE.firstChild.checked, edgeMode: mode(), materialEdges: materialEdges.firstChild.checked,
          entries: Object.fromEntries(Object.entries(entries).map(([key, { kod, edge, control }]) => [key, { kod, edge, checked: control.checked }])),
          krep: defaults.firstChild.checked ? {
            krepKor: fixings.krepKor.value, krepNap: fixings.krepNap.value, zag1: +fixings.zag1.value, zag2: +fixings.zag2.value,
            all: allDefaults.firstChild.checked,
          } : null,
          physical: physical.firstChild.checked, resize: resize.firstChild.checked, checkSizes: checkSizes.firstChild.checked, sides,
          dimensions: Object.fromEntries(Object.entries(dimensions).map(([key, input]) => [key, input.valueAsNumber])),
          surfaceMaterials: Object.fromEntries(surfaces.map(({ key, control }) => [key, control.value])),
        };
        applying = true;
        try {
          if (settings.useKromE !== product.useKromE && app.project.products.length > 1) {
            settings.allEdges = await confirmDialog('Изменение кромки', 'Изменить параметр кромки для всех изделий проекта?');
          }
          if (app.updateProductSettings(id, settings)) close();
        } finally { applying = false; }
      } }, 'Применить')],
  });
}
