import { SLOTS, FILL_SLOT, BACK_TYPES, FLOOR_TYPES, ROOF_TYPES, commonMaterials, setCommonMaterial, slotMaterials, slotEdges, krepTypes, krepColors, normalizeAngle, validateForm } from '../core/product.js';
import { materialTextureUrl } from './texture-source.js';

const modals = [];
let activePicker;

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el[k] = v;
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

export function calc(text) {
  const src = String(text).replace(/,/g, '.').trim();
  if (!/^[\d\s+\-*/().]+$/.test(src)) return NaN;
  try { return Number(Function(`"use strict"; return (${src});`)()); } catch { return NaN; }
}

export function openModal({ title, body, buttons = [], onClose, anchor, anchorAlign, className, footer }) {
  const root = document.getElementById('modal-root');
  const previousFocus = document.activeElement;
  const close = (result) => {
    if (!modals.includes(close)) return;
    while (modals.at(-1) !== close) modals.at(-1)(null);
    modals.pop();
    modal.remove();
    document.removeEventListener('keydown', onKey);
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', dismiss, true);
    }
    previousFocus?.focus({ preventScroll: true });
    onClose?.(result);
  };
  const onKey = (e) => { if (e.key === 'Escape' && modals.at(-1) === close) close(null); };
  const modal = h('div', { class: ['modal', anchor && 'anchored', className].filter(Boolean).join(' '), role: 'dialog', ariaLabel: title },
    h('header', {}, h('span', {}, title), h('button', { ariaLabel: 'Закрыть', onclick: () => close(null) }, '×')),
    h('div', { class: 'body' }, body),
    footer ? h('footer', {}, footer(close)) : buttons.length
      ? h('footer', {}, buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => b.action(close) }, b.text)))
      : null);
  root.append(modal);
  modals.push(close);
  document.addEventListener('keydown', onKey);
  function position() {
    const rect = anchor.getBoundingClientRect();
    const above = rect.top;
    const below = window.innerHeight - rect.bottom;
    modal.style.maxHeight = Math.max(above, below) - 8 + 'px';
    if (anchorAlign === 'end') modal.style.setProperty('--picker-anchor-width', rect.width + 'px');
    const width = modal.offsetWidth;
    const left = anchorAlign === 'end' ? rect.right - width : rect.left;
    modal.style.left = Math.max(4, Math.min(left, window.innerWidth - width - 4)) + 'px';
    modal.style.top = below >= above ? rect.bottom + 4 + 'px' : '';
    modal.style.bottom = below < above ? window.innerHeight - rect.top + 4 + 'px' : '';
  }
  function dismiss(event) {
    if (!modal.contains(event.target) && !anchor.contains(event.target)) close(null);
  }
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true');
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', dismiss, true);
  }
  return close;
}

export function confirmDialog(title, text) {
  return new Promise((resolve) => {
    openModal({
      title, body: h('div', { style: 'white-space:pre-line;max-width:420px' }, text), onClose: (r) => resolve(r === true),
      buttons: [{ text: 'Нет', action: (close) => close(false) }, { text: 'Да', primary: true, action: (close) => close(true) }],
    });
  });
}

export function rowLabel(row) {
  return row ? `${row.name}${row.color ? ', ' + row.color : ''}` : '—';
}

const CONSTRUCTION_IMAGES = {
  floorType: { nakl: 'floor-overlay', vkl: 'floor-inset', podium: 'floor-podium', 'podium-legs': 'floor-podium-legs' },
  roofType: { nakl: 'roof-overlay', kepka: 'roof-overhang', vkl: 'roof-inset' },
};

function constructionPanel(key, form, accept, cancel) {
  const roof = key === 'roofType';
  const options = roof ? ROOF_TYPES : FLOOR_TYPES;
  let value = form[key];
  const selection = new Map();
  const fields = new Map();
  const sides = { podiumLeft: Boolean(form.podiumLeft), podiumRight: Boolean(form.podiumRight) };
  const select = (option) => {
    value = option;
    for (const [type, tile] of selection) {
      tile.classList.toggle('active', type === value);
      tile.querySelector('button').setAttribute('aria-pressed', String(type === value));
    }
  };
  const input = (name, label, min, fallback, option) => {
    const field = h('input', { type: 'text', inputMode: 'numeric', title: label, ariaLabel: label, value: form[name] ?? fallback,
      onfocus: () => select(option) });
    fields.set(name, { field, min, option });
    return field;
  };
  const picture = (name, label, onclick) => h('button', { type: 'button', ariaLabel: label, title: label, onclick },
    h('img', { src: `img/construction/${name}.png`, alt: '' }));
  const choices = Object.entries(options).filter(([option]) => roof || !form.podvesnoi || !option.startsWith('podium')).map(([option, label]) => {
    const tile = h('div', { class: 'construction-tile' },
      picture(CONSTRUCTION_IMAGES[key][option], label, () => select(option)));
    selection.set(option, tile);
    if (option === 'kepka') {
      tile.prepend(input('kepkaBack', 'Козырёк сзади, мм', 0, 0, option));
      tile.append(input('kepkaFront', 'Козырёк спереди, мм', 0, 20, option));
      return h('div', { class: 'construction-row overhang' }, h('span', {}, label), tile);
    }
    if (option.startsWith('podium')) {
      tile.classList.add('height-in-image');
      tile.append(input(option === 'podium' ? 'podiumHeight' : 'podiumLegHeight', 'Высота подиума, мм', 72, 100, option));
    }
    if (option === 'podium-legs') {
      tile.classList.add('with-legs');
      for (const [side, name, title] of [['podiumLeft', 'left', 'Левый цоколь'], ['podiumRight', 'right', 'Правый цоколь']]) {
        const button = picture('floor-podium-' + name, title, () => {
          sides[side] = !sides[side];
          button.classList.toggle('active', sides[side]);
          button.setAttribute('aria-pressed', String(sides[side]));
          select(option);
        });
        button.classList.add('plinth-' + name);
        button.classList.toggle('active', sides[side]);
        button.setAttribute('aria-pressed', String(sides[side]));
        tile.append(button);
      }
    }
    return h('div', { class: 'construction-row' }, h('span', {}, label), tile);
  });
  select(selection.has(value) ? value : 'nakl');
  return h('section', { class: 'construction-panel', ariaLabel: roof ? 'Конструкция крыши' : 'Конструкция пола',
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } },
  }, h('div', { class: 'construction-list' }, choices), h('button', { class: 'construction-ok', onclick: () => {
    const patch = { [key]: value, ...sides };
    for (const [name, { field, min, option }] of fields) {
      if (value !== option) continue;
      const n = calc(field.value);
      if (!Number.isFinite(n) || n < min) {
        field.setCustomValidity(`Введите размер от ${min} мм`);
        field.reportValidity();
        field.setCustomValidity('');
        return;
      }
      patch[name] = n;
    }
    accept(patch);
  } }, 'ОК'));
}

function togglePicker(anchor) {
  if (!activePicker) return false;
  const same = activePicker.anchor === anchor;
  activePicker.close(null);
  return same;
}

function openPicker(options, resolve) {
  const close = openModal({
    ...options,
    className: ['picker-modal', options.className].filter(Boolean).join(' '),
    onClose: (r) => { activePicker = null; resolve(r ?? null); },
  });
  activePicker = { anchor: options.anchor, close };
  return close;
}

function revealPickerRow(list, row) {
  if (!row) return;
  const listTop = list.getBoundingClientRect().top + list.clientTop;
  const visibleTop = listTop + (list.querySelector('thead')?.offsetHeight ?? 0);
  const visibleBottom = listTop + list.clientHeight;
  const { top, bottom } = row.getBoundingClientRect();
  if (top < visibleTop) list.scrollTop += top - visibleTop;
  else if (bottom > visibleBottom) list.scrollTop += bottom - visibleBottom;
}

export function pickRow({ title, rows, current, groupBy = (r) => r.name, label = (r) => r.color || r.art || r.name,
  extra = [], anchor, anchorAlign, withModifiers = false, confirmSelection = false }) {
  if (togglePicker(anchor)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const groups = new Map();
    for (const r of rows) { const g = groupBy(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const cur = rows.find((r) => r.kod === current);
    const appliedGroup = cur ? groupBy(cur) : undefined;
    let extraSelected = !cur && extra.some((entry) => entry.value === current);
    let group = cur ? appliedGroup : extraSelected ? undefined : groups.keys().next().value;
    let selectedCode = current;
    let filter = '';
    const left = h('div', { class: 'list' });
    const right = h('div', { class: 'list' });
    const swatch = h('div', { class: 'swatch' });
    const showSwatch = (row) => {
      const url = materialTextureUrl(row?.tex);
      swatch.style.backgroundImage = url ? `url("${url}")` : '';
    };
    const search = h('input', { class: 'picker-search', type: 'search', placeholder: 'Поиск по цвету / артикулу', oninput: () => { filter = search.value.toLowerCase(); draw(); } });
    const choose = (value, event) => close(withModifiers ? { value, ctrlKey: event.ctrlKey } : value);
    const item = (props, text, action, commit = action) => h('div', { ...props, role: 'button', tabIndex: 0, onclick: action,
      onkeydown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (event.key === 'Enter') commit(event);
        else action(event);
      },
    }, text);
    const rowClass = (applied, selected) => [applied && 'applied', selected && 'selected'].filter(Boolean).join(' ');
    const selectRow = (row, element) => {
      right.querySelector('.selected')?.classList.remove('selected');
      element.classList.add('selected');
      selectedCode = row.kod;
      showSwatch(row);
    };
    const draw = () => {
      left.replaceChildren(...extra.map((x) => item({ class: rowClass(x.value === current, extraSelected && x.value === current) },
        h('i', {}, x.text), (event) => choose(x.value, event))),
        ...[...groups].map(([g, entries]) => item({ class: rowClass(g === appliedGroup, g === group) }, `${g} (${entries.length})`, (event) => {
          group = g;
          extraSelected = false;
          selectedCode = current;
          draw();
          if (event.type === 'keydown') left.querySelector('.selected')?.focus({ preventScroll: true });
        })));
      const list = (groups.get(group) ?? []).filter((r) => !filter || `${r.color ?? ''} ${r.art ?? ''}`.toLowerCase().includes(filter))
        .sort((a, b) => label(a).localeCompare(label(b), 'ru'));
      const selected = list.find((r) => r.kod === selectedCode) ?? (confirmSelection ? list[0] : undefined);
      showSwatch(selected);
      right.replaceChildren(...list.map((r) => {
        const commit = (event) => choose(r.kod, event);
        const select = (event) => selectRow(r, event.currentTarget);
        return item({
          class: rowClass(r.kod === current, r === selected), title: `${r.name} ${r.art ?? ''}`,
          onmouseenter: () => showSwatch(r),
          ...(confirmSelection ? { onfocus: select, ondblclick: commit } : {}),
        }, label(r), confirmSelection ? select : commit, commit);
      }));
      revealPickerRow(left, left.querySelector('.selected'));
      revealPickerRow(right, right.querySelector('.selected'));
    };
    const close = openPicker({
      title, anchor, anchorAlign, body: h('div', {}, search, h('div', { class: 'picker' }, left, right, swatch)),
    }, resolve);
    draw();
    search.focus({ preventScroll: true });
  });
}

export function pickPartCatalog({ title, anchor, current, rows, modes, initialMode = 0, onModeChange,
  replacing = false, replaceLabel = 'Заменить во всём изделии' }) {
  if (togglePicker(anchor)) return Promise.resolve(null);
  const hardware = Boolean(modes);
  const families = [
    ['Весь материал', () => true],
    ['ДСП', (row) => /дсп/i.test(row.name)],
    ['ДВП', (row) => /двп|хдф/i.test(row.name)],
    ['Фанера', (row) => /фанера/i.test(row.name)],
  ];
  const matches = (text, query) => String(text ?? '').toLowerCase().includes(query);
  const sortNames = new Intl.Collator('ru', { numeric: true }).compare;
  return new Promise((resolve) => {
    let name = current?.name;
    let code = current?.kod;
    let mode = initialMode;
    if (hardware && current && !modes[mode][1].some((row) => row.kod === code)) {
      const matchingMode = modes.findIndex(([, entries]) => entries.some((row) => row.kod === code));
      if (matchingMode >= 0) mode = matchingMode;
    }
    let family = current ? Math.max(0, families.findIndex(([, test], i) => i > 0 && test(current))) : 0;
    const field = (label) => h('input', { type: 'search', ariaLabel: label, placeholder: label, oninput: () => draw() });
    const search = field('Наименование');
    const color = hardware ? null : field('Цвет');
    const article = hardware ? null : field('Артикул');
    const nameRows = h('tbody');
    const variantRows = h('tbody');
    const preview = hardware ? null : h('div', { class: 'swatch' });
    const description = hardware ? null : h('div', { class: 'part-catalog-description' });
    const replacement = replacing ? h('input', { type: 'checkbox' }) : null;
    const switches = (items, select) => items.map(([label], index) => h('button', { type: 'button', onclick: () => { select(index); draw(); } }, label));
    const modeButtons = hardware ? switches(modes, (index) => {
      mode = index;
      name = current?.name;
      code = current?.kod;
      onModeChange?.(index);
    }) : [];
    const familyButtons = hardware ? [] : switches(families, (index) => { family = index; });
    const table = (columns, body) => h('div', { class: 'part-catalog-table' },
      h('table', {}, h('thead', {}, h('tr', {}, columns.map((label) => h('th', { scope: 'col' }, label)))), body));
    const choose = (row) => close({ kod: row.kod, replace: Boolean(replacement?.checked) });
    const draw = () => {
      const source = hardware ? modes[mode][1] : rows;
      const nameQuery = search.value.trim().toLowerCase();
      const colorQuery = color?.value.trim().toLowerCase();
      const articleQuery = article?.value.trim().toLowerCase();
      const groups = new Map();
      for (const row of source) {
        if (!matches(row.name, nameQuery)) continue;
        if (!hardware && (!families[family][1](row) || !matches(row.color, colorQuery) || !matches(row.art, articleQuery))) continue;
        if (!groups.has(row.name)) groups.set(row.name, []);
        groups.get(row.name).push(row);
      }
      const names = [...groups.keys()].sort(sortNames);
      if (!groups.has(name)) name = names[0];
      const variants = (groups.get(name) ?? []).sort((a, b) => sortNames(a.color ?? '', b.color ?? '') || sortNames(a.art ?? '', b.art ?? ''));
      if (!variants.some((row) => row.kod === code)) code = variants[0]?.kod;
      nameRows.replaceChildren(...names.map((value) =>
        h('tr', { class: value === current?.name ? 'applied' : '' }, h('td', {}, h('button', { type: 'button', ariaPressed: String(value === name),
          onclick: () => { name = value; draw(); nameRows.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }); },
        }, value)))));
      const selectVariant = (row, target) => {
        code = row.kod;
        variantRows.querySelector('.selected')?.classList.remove('selected');
        target.classList.add('selected');
        if (preview) {
          const url = materialTextureUrl(row.tex);
          preview.style.backgroundImage = url ? `url("${url}")` : '';
          description.textContent = [rowLabel(row), row.art].filter(Boolean).join(' · ');
        }
      };
      variantRows.replaceChildren(...variants.map((row) =>
        h('tr', { tabIndex: 0, class: [row.kod === code && 'selected', row.kod === current?.kod && 'applied'].filter(Boolean).join(' '),
          onfocus: (event) => selectVariant(row, event.currentTarget),
          onclick: (event) => selectVariant(row, event.currentTarget),
          ondblclick: () => choose(row),
          onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); choose(row); } },
        }, h('td', {}, row.color || '—'), h('td', {}, row.art || '—'),
        h('td', {}, row.price == null ? '—' : row.price.toLocaleString('ru-RU')))));
      const selected = variants.find((row) => row.kod === code);
      const selectedRow = variantRows.querySelector('.selected');
      if (selected) {
        selectVariant(selected, selectedRow);
        revealPickerRow(variantRows.closest('.part-catalog-table'), selectedRow);
      } else if (preview) {
        preview.style.backgroundImage = '';
        description.textContent = '';
      }
      const selectedName = nameRows.querySelector('button[aria-pressed="true"]');
      revealPickerRow(nameRows.closest('.part-catalog-table'), selectedName?.closest('tr'));
      modeButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === mode)));
      familyButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === family)));
    };
    const body = h('section', { class: 'part-catalog' },
      description,
      h('div', { class: 'part-catalog-filters' }, search, color, article, ...modeButtons,
        replacement ? h('label', {}, replacement, replaceLabel) : null),
      h('div', { class: 'part-catalog-grid' }, table(['Наименование'], nameRows), table(['Цвет', 'Артикул', 'Цена'], variantRows), preview),
      hardware ? null : h('div', { class: 'part-catalog-families' }, familyButtons));
    const close = openPicker({
      title, anchor, anchorAlign: 'end', body,
      className: `part-catalog-dialog${hardware ? ' part-catalog-krep' : ''}`,
      footer: hardware ? (done) => h('button', { type: 'button', onclick: () => done({ kod: 0, replace: Boolean(replacement?.checked) }) }, 'Крепление по умолчанию') : null,
    }, resolve);
    draw();
    search.focus({ preventScroll: true });
  });
}

const PRODUCT_SLOTS = ['left', 'right', 'roof', 'floor', 'back'].map((key) => SLOTS.find((slot) => slot.key === key));

export function productDialog(app, form, { hasPrevious = false } = {}) {
  return new Promise((resolve) => {
    const { db } = app;
    const f = structuredClone(form);
    f.material ??= { kod: f.parts.left.kod, edge: 0 };
    f.y ??= 0;
    f.otseki ??= 1;
    const previous = hasPrevious ? structuredClone(f) : null;
    const error = h('div', { class: 'error', role: 'alert', hidden: true });
    const updates = [];
    const refresh = () => {
      for (const update of updates) update();
      error.hidden = true;
    };
    const fields = new Map();
    const field = (key, props) => {
      const control = h('input', { value: f[key], ...props,
        oninput: (e) => { f[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value; },
      });
      fields.set(key, control);
      return control;
    };
    const number = (key, min = 1, props) => field(key, { type: 'number', min, required: true, ...props });
    const wall = (angle, cls, label, caption = label) => {
      const button = h('button', { type: 'button', class: cls, title: label, ariaLabel: label, onclick: () => {
        f.angle = angle;
        refresh();
      } }, caption);
      updates.push(() => {
        const selected = normalizeAngle(f.angle) === angle;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      return button;
    };
    const choice = (label, props) => h('label', { class: 'product-choice', title: props.disabled ? 'Недоступно в веб-версии' : '' },
      h('input', { type: 'checkbox', ...props }), label);
    const check = (label, target, key, after) => {
      const control = choice(label, { onchange: (e) => { target()[key] = e.target.checked; after?.(); } });
      updates.push(() => { control.firstElementChild.checked = Boolean(target()[key]); });
      return control;
    };
    const options = (items) => items.map(([value, label]) => h('option', { value }, label));
    const name = field('title', { type: 'text', ariaLabel: 'Наименование изделия' });
    const heightLabel = h('label', { class: 'product-parameter' }, 'Высота от пола', number('y', 0, { step: 'any' }));
    const bays = number('otseki', 1, { id: 'product-door-bays' });
    const dimensions = [['W', 'Ширина'], ['H', 'Высота'], ['G', 'Глубина'], ['count', 'Количество']]
      .map(([key, label]) => h('label', {}, label, key === 'count' ? number(key) : number(key, 0, { step: 'any' })));

    const targetFor = (slot) => slot === FILL_SLOT ? f.fill : f.parts[slot.key];
    const pick = (slot, { edge = false, common = false } = {}) => {
      const caption = common ? (edge ? 'Кромка' : 'Материал (включая зашивки)') : `${slot.title}: ${edge ? 'кромка' : 'материал'}`;
      const target = () => common ? f.material : targetFor(slot);
      const button = h('button', { class: 'product-pick', type: 'button', ariaLabel: caption, ariaHasPopup: 'dialog', ariaExpanded: 'false',
        onclick: async () => {
          const entry = target();
          const rows = edge ? slotEdges(db, slot, db.get(entry.kod)) : common ? commonMaterials(db) : slotMaterials(db, slot);
          const kod = await pickRow({
            title: caption, rows, current: edge ? entry.edge : entry.kod, anchor: button, confirmSelection: !edge,
            extra: edge ? [{ text: 'Кромка по стандарту', value: 0 }] : [],
          });
          if (kod == null) return;
          if (edge) {
            entry.edge = kod;
            if (common) {
              for (const item of [...PRODUCT_SLOTS.filter((part) => part.key !== 'back'), FILL_SLOT]) {
                const part = targetFor(item);
                if (!kod || slotEdges(db, item, db.get(part.kod)).some((row) => row.kod === kod)) part.edge = kod;
              }
            }
          } else if (common) setCommonMaterial(f, kod);
          else Object.assign(entry, { kod, edge: 0 });
          refresh();
        },
      }, h('span'));
      updates.push(() => {
        const { kod, edge: edgeKod } = target();
        const row = db.get(edge ? edgeKod : kod);
        const value = edge && !edgeKod ? 'Кромка по стандарту'
          : slot === FILL_SLOT && !edge && row?.color ? row.color : rowLabel(row);
        button.firstElementChild.textContent = value;
        button.title = value;
        button.disabled = !common && slot !== FILL_SLOT && !target().on;
      });
      return button;
    };

    const constructions = h('div', { class: 'construction-controls' });
    let activeConstruction;
    const closeConstruction = (focus = false) => {
      if (!activeConstruction) return;
      const { button, popup } = activeConstruction;
      activeConstruction = null;
      button.setAttribute('aria-expanded', 'false');
      popup.remove();
      if (focus) button.focus();
    };
    const construction = (key, caption, part) => {
      const button = h('button', { class: 'construction-open', type: 'button', ariaExpanded: 'false', onclick: () => {
        const same = activeConstruction?.key === key;
        closeConstruction();
        if (same) return;
        const popup = constructionPanel(key, f, (patch) => {
          Object.assign(f, patch);
          closeConstruction(true);
          refresh();
        }, () => closeConstruction(true));
        activeConstruction = { key, button, popup };
        button.setAttribute('aria-expanded', 'true');
        constructions.append(popup);
        popup.querySelector('button[aria-pressed=true]')?.focus();
      } }, caption);
      updates.push(() => {
        button.disabled = !f.parts[part].on;
        if (button.disabled && activeConstruction?.key === key) closeConstruction();
      });
      return button;
    };
    constructions.append(
      construction('roofType', 'Выбрать конструкцию крыши', 'roof'),
      construction('floorType', 'Выбрать конструкцию пола', 'floor'));

    const backType = h('select', { id: 'product-back-type', onchange: (e) => { f.backType = Number(e.target.value); } },
      options(BACK_TYPES.map((label, index) => [index, label])));
    const legs = h('select', { disabled: true, title: 'Ножки задаются конструкцией пола' }, h('option'));
    updates.push(() => {
      heightLabel.hidden = !f.podvesnoi;
      backType.value = f.backType;
      backType.disabled = !f.parts.back.on;
      legs.options[0].textContent = f.parts.floor.on && f.floorType === 'podium-legs' ? 'Кухонные ножки' : 'Без ножек';
    });
    const stepBays = (delta, caption, label) => h('button', { type: 'button', ariaLabel: label, onclick: () => {
      if (delta < 0) bays.stepDown();
      else bays.stepUp();
      f.otseki = Number(bays.value);
    } }, caption);
    const krepRefresh = [];
    const krep = (typeKey, zagKey, caption, corpus) => {
      const type = h('select', { ariaLabel: caption, onchange: (e) => { f[typeKey] = e.target.value; syncColors(); } },
        options(krepTypes(db, corpus).map((label) => [label, label])));
      const color = h('select', { ariaLabel: `Цвет креплений: ${caption.toLowerCase()}`,
        onchange: (e) => { f[zagKey] = Number(e.target.value); } });
      const syncColors = () => {
        const colors = krepColors(db, f[typeKey], corpus);
        color.replaceChildren(...options(colors.map((c) => [c.kod, c.color || '—'])));
        if (!colors.some((c) => c.kod === f[zagKey])) f[zagKey] = colors[0]?.kod ?? 0;
        color.value = f[zagKey];
      };
      krepRefresh.push(() => { type.value = f[typeKey]; syncColors(); });
      return h('div', { class: 'product-krep' }, h('label', {}, caption, type), h('label', {}, 'Цвет', color));
    };
    const restore = () => {
      closeConstruction();
      Object.assign(f, structuredClone(previous));
      for (const [key, control] of fields) control.value = f[key];
      for (const reset of krepRefresh) reset();
      refresh();
    };

    const room = app.project.room;
    const body = h('div', { class: 'product-form', tabIndex: -1 },
      h('button', { class: 'product-previous', disabled: !previous, onclick: restore }, 'Предыдущие настройки'),
      h('div', { class: 'product-heading' },
        h('div', { class: 'product-room-size' }, room && `Параметры комнаты:   Ширина = ${room.W}   Высота = ${room.H}   Глубина = ${room.G}`),
        h('div', { class: 'product-name' }, name, h('input', { value: '0', readOnly: true, tabIndex: -1, ariaLabel: 'Отступ' }))),
      h('aside', { class: 'product-rail' },
        h('div', { class: 'product-room-plan', role: 'group', ariaLabel: 'Расположение изделия в помещении' },
          wall(0, 'rear', 'Задняя стена'), wall(270, '', 'Левая стена', 'Л'),
          h('div', { class: 'centre' }, 'Расположение изделия в помещении'),
          wall(90, '', 'Правая стена', 'П'), wall(180, 'front', 'Передняя стена'))),
      h('div', { class: 'product-settings' },
        h('section', { class: 'product-extra' },
          h('h2', {}, 'Дополнительные параметры'),
          h('div', { class: 'product-parameters' },
            h('label', { class: 'product-parameter' }, 'Тип', h('select', {}, h('option', {}, 'Шкаф'))),
            choice('Из ДСП', { type: 'radio', checked: true }),
            choice('Из шпона', { type: 'radio', disabled: true }),
            choice('Сложный', { disabled: true }),
            check('Подвесной', () => f, 'podvesnoi', () => {
              if (f.podvesnoi && activeConstruction?.key === 'floorType') closeConstruction();
              if (f.podvesnoi && f.floorType.startsWith('podium')) f.floorType = 'nakl';
              refresh();
            }),
            choice('Корпоративный', { disabled: true }), heightLabel)),
        h('section', { class: 'product-material-settings' },
          h('h2', {}, 'Настройки материала'),
          h('div', { class: 'product-materials' },
            h('span', { class: 'product-facade-label' }, 'Фасад / мат / толщ'),
            h('div', { class: 'product-material-main product-frame' },
              h('div', {}, 'Материал (включая зашивки)'), pick(SLOTS[0], { common: true })),
            h('div', { class: 'product-edge-main product-frame' },
              h('div', {}, 'Кромка', check('E кромка — основная', () => f, 'useKromE')),
              pick(SLOTS[0], { edge: true, common: true })),
            h('div', { class: 'product-slot-labels product-slot-rows' },
              PRODUCT_SLOTS.map((slot) => check(slot.title, () => targetFor(slot), 'on', refresh)),
              h('span', {}, 'Наполн / мат / толщ'), h('label', { htmlFor: backType.id }, 'Тип задней стенки')),
            h('div', { class: 'product-slot-materials product-frame product-slot-rows' },
              [...PRODUCT_SLOTS, FILL_SLOT].map((slot) => pick(slot)), backType),
            h('div', { class: 'product-slot-edges product-frame product-slot-rows' },
              [...PRODUCT_SLOTS, FILL_SLOT].map((slot) => pick(slot, { edge: true })),
              h('label', { class: 'product-leg-row' }, 'Ножки', legs),
              h('div', { class: 'product-bay-row' },
                h('label', { htmlFor: bays.id }, 'Дверных отсеков'),
                h('div', { class: 'product-stepper' },
                  stepBays(-1, '◂', 'Уменьшить число дверных отсеков'), bays, stepBays(1, '▸', 'Увеличить число дверных отсеков')))),
            h('div', { class: 'product-cornice' }, choice('С карнизами', { disabled: true })), constructions)),
        h('section', { class: 'product-krep-settings' },
          h('h2', {}, 'Настройки креплений'),
          h('div', { class: 'product-krep-columns' }, krep('krepKor', 'zag1', 'Для корпуса', true), krep('krepNap', 'zag2', 'Для наполнения', false))),
        error));
    for (const reset of krepRefresh) reset();
    refresh();
    openModal({
      className: 'product-modal',
      title: 'Добавление изделия', body, onClose: (r) => resolve(r ?? null),
      footer: (close) => [h('div', { class: 'product-dimensions' }, dimensions),
        h('button', { class: 'product-place', onclick: () => {
          if (activeConstruction) {
            activeConstruction.popup.querySelector('button[aria-pressed=true]')?.focus();
            return;
          }
          const invalid = [...fields.values()].find((input) => !input.closest('[hidden]') && !input.validity.valid);
          if (invalid) { invalid.reportValidity(); return; }
          const errors = validateForm(db, f, app.project.room);
          if (errors.length) {
            error.textContent = 'Заданы не все позиции!\n' + errors.join('\n');
            error.hidden = false;
            error.scrollIntoView({ block: 'nearest' });
            return;
          }
          close(f);
        } }, 'Разместить в комнате')],
    });
    body.focus({ preventScroll: true });
  });
}
