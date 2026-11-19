import { h, openModal } from './dialogs.js';
import { batchDimensions, batchOpening, drawerBatch, panelBatch } from '../core/batch.js';
import { BuildError } from '../core/build.js';
import { roomPlacementContext } from '../core/room.js';

const number = (value, min = 0, max = Infinity) => h('input', {
  type: 'number', value, min, max: Number.isFinite(max) ? max : '', step: 'any', required: true,
});
const row = (label, input) => h('label', { class: 'batch-row' }, label, input);
const checkbox = (text, checked = false) => {
  const input = h('input', { type: 'checkbox', checked });
  return { input, row: h('label', { class: 'batch-check' }, input, text) };
};
const value = (input) => input.valueAsNumber;
const rounded = (number, digits = 0) => Number.isFinite(number) ? +number.toFixed(digits) : '';

function setAutomatic(field, enabled) {
  if (enabled === field.disabled) return;
  if (enabled) field.dataset.manualValue = field.value;
  else {
    field.type = 'number';
    field.value = field.dataset.manualValue;
  }
  field.disabled = enabled;
}

function showDimensions(field, values, title) {
  if (!field.disabled) {
    field.title = title;
    return;
  }
  const low = rounded(Math.min(...values), 2);
  const high = rounded(Math.max(...values), 2);
  const range = low !== high;
  field.type = range ? 'text' : 'number';
  field.value = range ? `${low}–${high}` : low;
  field.placeholder = '—';
  field.title = title;
}

export function batchDialog(app, target, tool, item, point, drawer, preferences) {
  let opening;
  try {
    if (tool.room) {
      const { boundary, supportIds } = roomPlacementContext(target, point);
      opening = batchOpening(boundary, item, { ...point, supportIds }, false);
    } else opening = batchOpening(target, item, point, drawer);
  }
  catch (error) { app.toast(error.message); return; }
  const horizontal = opening.axis === 'x';
  const names = drawer ? 'ящиков' : horizontal ? 'перегородок' : 'полок';
  const autoDepth = checkbox('Определить глубину автоматически', true);
  const autoSize = checkbox(drawer ? 'Определить высоту автоматически' : 'Определить отступ автоматически', !drawer);
  const autoCount = checkbox('Определить кол-во автоматически');
  const automaticBody = checkbox('Определить высоту наполнения автоматически', true);
  const depth = number(Number(item.G) || 350, 1);
  const size = number(150);
  const count = number(1, 1, 100);
  const bodyHeight = number(50, 50);
  const grid = h('select', { ariaLabel: 'Кратность отступов' },
    h('option', {}, 'Без кратности 32 мм'), h('option', {}, 'С кратностью 32 мм'));
  const lower = checkbox(horizontal ? 'Отступ слева' : 'Отступ снизу');
  const upper = checkbox(horizontal ? 'Отступ справа' : 'Отступ сверху');
  const low = number(200);
  const high = number(200);
  const error = h('div', { class: 'error', role: 'alert', hidden: true });
  const overlays = ['сверху', 'снизу'].map((where, i) => {
    const available = i ? opening.overlayLow : opening.overlayHigh;
    const choices = ['полностью', 'на половину'].map((mode) => checkbox(`Наложить ${where} ${mode}`));
    choices.forEach(({ input }, j) => {
      input.disabled = !available;
      input.addEventListener('change', () => { if (input.checked) choices[1 - j].input.checked = false; });
    });
    return choices;
  });
  const overlay = (choices) => choices[0].input.checked ? 'full' : choices[1].input.checked ? 'half' : '';
  const fields = { depth, size, count, bodyHeight, grid, low, high };
  const checks = { autoDepth, autoSize, autoCount, automaticBody, lower, upper };
  const read = (position = point) => {
    const config = { count: value(count), depth: autoDepth.input.checked ? null : value(depth) };
    return drawer ? drawerBatch(opening, position, { ...config, autoHeight: autoSize.input.checked, autoCount: autoCount.input.checked,
      height: value(size), bodyHeight: automaticBody.input.checked ? null : value(bodyHeight),
      upper: overlay(overlays[0]), lower: overlay(overlays[1]) })
      : panelBatch(opening, { ...config, autoGap: autoSize.input.checked, gap: value(size), grid: grid.selectedIndex === 1,
        low: lower.input.checked ? value(low) : null, high: upper.input.checked ? value(high) : null });
  };
  const refresh = () => {
    error.hidden = true;
    setAutomatic(depth, autoDepth.input.checked);
    setAutomatic(bodyHeight, automaticBody.input.checked);
    const plan = read(tool.prepare ? { ...point, drawerOptions: { cutLevels: true } } : point);
    size.disabled = autoSize.input.checked;
    count.disabled = autoCount.input.checked;
    grid.hidden = !autoSize.input.checked;
    if (size.disabled) size.value = rounded(drawer ? plan.height : plan.gap, 2);
    if (count.disabled) count.value = rounded(plan.count);
    if (!drawer) {
      if (!lower.input.checked) low.value = rounded(plan.first);
      if (!upper.input.checked) high.value = rounded(plan.last);
    }
    let calculated;
    let unavailable = '';
    if (depth.disabled || (drawer && bodyHeight.disabled)) {
      try {
        calculated = batchDimensions(app.db, target, item, plan.points(point), tool.room, drawer);
      } catch (failure) {
        if (!(failure instanceof BuildError)) throw failure;
        unavailable = failure.message;
      }
    }
    showDimensions(depth, calculated?.depth ?? [], unavailable || (drawer ? 'Длина направляющей, мм' : 'Глубина детали, мм'));
    if (drawer) showDimensions(bodyHeight, calculated?.bodyHeight ?? [], unavailable || 'Высота боковины ящика, мм');
  };
  const changeMode = (own, other) => own.input.addEventListener('change', () => {
    if (own.input.checked || !drawer) other.input.checked = !own.input.checked;
  });
  changeMode(autoSize, autoCount);
  changeMode(autoCount, autoSize);
  const offset = (check, field, first) => {
    const align = (delta) => {
      check.input.checked = true;
      const at = (first ? opening.start : opening.end) - opening.datum;
      const distance = (value(field) || 0) + delta;
      const direction = first ? 1 : -1;
      const snapped = Math.round((at + direction * distance) / 32) * 32;
      field.value = Math.max(0, Math.round(direction * (snapped - at) - opening.thickness / 2));
      refresh();
    };
    return h('div', { class: 'batch-offset' }, check.row,
      [[-32, '<'], [0, 'К32'], [32, '>']].map(([delta, text]) => h('button', { type: 'button', onclick: () => align(delta) }, text)), field);
  };
  const defaults = {
    fields: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])),
    checks: Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.input.checked])),
  };
  const restore = (settings) => {
    setAutomatic(depth, false);
    setAutomatic(bodyHeight, false);
    for (const [key, field] of Object.entries(fields)) field.value = settings.fields[key];
    for (const [key, check] of Object.entries(checks)) check.input.checked = settings.checks[key];
    refresh();
  };
  if (preferences.current) restore(preferences.current);
  const body = h('div', { class: 'batch-form', oninput: (event) => { if (event.target.type === 'number') refresh(); }, onchange: refresh },
    !drawer && h('button', { type: 'button', onclick: () => restore(defaults) }, 'Сброс настроек'),
    autoDepth.row, row(drawer ? 'Глубина ящиков' : 'Глубина полок', depth), autoSize.row, row(drawer ? 'Высота ящиков' : 'Между полками', size),
    autoCount.row, row(`Количество ${names}`, count),
    drawer ? [automaticBody.row, row('Высота наполнения', bodyHeight), h('div', { class: 'batch-overlays' },
      overlays.map((choices) => h('div', {}, choices.map((choice) => choice.row))))]
      : [grid, offset(upper, high, false), offset(lower, low, true)], error);
  refresh();
  let applying = false;
  openModal({ title: drawer ? 'Добавление ящиков' : 'Установка полок',
    className: `batch-modal ${drawer ? 'drawer-batch' : 'panel-batch'}`, body,
    buttons: [{ text: 'Установить', action: async (close) => {
      if (applying) return;
      const invalid = Object.values(fields).find((field) => !field.disabled && !field.validity.valid);
      if (invalid) { invalid.reportValidity(); return; }
      applying = true;
      try {
        const draft = tool.prepare ? await tool.prepare(target, item, { ...point, supportIds: opening.supportIds }, false) : point;
        if (!draft) return;
        const points = read(draft).points(point);
        if (tool.prepare) batchDimensions(app.db, target, item, points, null, drawer);
        if (app.placeBatch(tool, target.id, item, points)) {
          preferences.current = {
            fields: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key,
              field.disabled && field.dataset.manualValue !== undefined ? field.dataset.manualValue : field.value])),
            checks: Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.input.checked])),
          };
          close();
        }
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally { applying = false; }
    } }],
  });
}
