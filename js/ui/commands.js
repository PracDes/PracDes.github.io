import { confirmDialog, openModal, h } from './dialogs.js';
import { DRAG_STEP, rootPart } from '../core/move.js';
import { canLockPart, KIND } from '../core/model.js';
import { AXIS_SIDES } from '../core/geom.js';
import { isRoomLamp, roomAxisFixed, roomElementBox } from '../core/room.js';
import { bindTouchGestures } from './touch.js';

const ARROWS = {
  ArrowLeft: ['x', -1], ArrowRight: ['x', 1],
  ArrowUp: ['y', 1], ArrowDown: ['y', -1],
};

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function bindCommands(app, viewport, panels) {
  const toast = document.getElementById('toast');
  let timer = 0;
  app.addEventListener('toast', (e) => {
    toast.textContent = e.detail;
    toast.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove('show'), 4500);
  });

  const fileInput = document.getElementById('file-open');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try { app.loadData(JSON.parse(await file.text())); } catch { app.toast('Файл проекта не прочитан'); }
  });

  const removeProduct = async (product = app.product) => {
    if (product && await confirmDialog('Удалить изделие', `Удалить изделие «${product.num}. ${product.title}»?`)) app.removeProduct(product);
  };
  const removeOtherProducts = async (product) => {
    const title = 'Удалить все изделия, кроме активного';
    if (await confirmDialog(title, `В комнате останется изделие «${product.num}. ${product.title}». Продолжить?`)) app.removeOtherProducts(product);
  };
  const outlineButton = document.getElementById('part-outline');
  const updateOutlineButton = () => {
    const { color, label } = viewport.partOutlineMode;
    outlineButton.title = `Обводка деталей · ${label}`;
    outlineButton.setAttribute('aria-pressed', String(color !== null));
    outlineButton.setAttribute('aria-label', outlineButton.title);
  };
  updateOutlineButton();
  const commands = {
    new: async () => { if (await confirmDialog('Новый проект', 'Текущий проект будет очищен.\nПродолжить?')) app.newProject(); },
    save: () => download('Проект НП.json', new Blob([JSON.stringify(app.project)], { type: 'application/json' })),
    open: () => fileInput.click(),
    info: () => {
      const info = { ...app.project.info };
      const input = (key, label) => h('label', { style: 'display:grid;gap:3px;margin-bottom:8px' }, label,
        h('input', { type: 'text', value: info[key] ?? '', style: 'width:360px', oninput: (e) => { info[key] = e.target.value; } }));
      openModal({
        title: 'Данные договора', body: h('div', {}, input('number', 'Номер договора'), input('note', 'Дополнительно')),
        buttons: [{ text: 'Отмена', action: (c) => c(null) }, { text: 'Сохранить', primary: true, action: (c) => { app.mutate(() => { app.project.info = info; }); c(true); } }],
      });
    },
    undo: () => app.undo(),
    redo: () => app.redo(),
    delete: () => app.deleteSelected(),
    settings: () => panels.editProduct(),
    'remove-product': () => removeProduct(),
    'view-front': () => viewport.view('front'),
    'view-top': () => viewport.view('top'),
    'view-iso': () => viewport.view('iso'),
    'boundary-color': () => viewport.cycleBoundaryColor(),
    'part-outline': () => { viewport.cyclePartOutline(); updateOutlineButton(); },
    'toggle-doors': () => { viewport.showDoors = !viewport.showDoors; viewport.sync(); },
    'toggle-walls': () => { viewport.showWalls = !viewport.showWalls; viewport.sync(); },
    'report-xlsx': async () => {
      const { exportReport } = await import('./xlsx.js');
      exportReport(app, download);
    },
  };
  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => commands[b.dataset.cmd]?.()));
  const undoButtons = document.querySelectorAll('[data-cmd="undo"]');
  const redoButtons = document.querySelectorAll('[data-cmd="redo"]');
  const updateHistory = () => {
    undoButtons.forEach((button) => { button.disabled = !app.canUndo; });
    redoButtons.forEach((button) => { button.disabled = !app.canRedo; });
  };
  for (const event of ['change', 'history', 'placement']) app.addEventListener(event, updateHistory);
  updateHistory();

  const menu = document.getElementById('context-menu');
  const canvas = viewport.renderer.domElement;
  bindTouchGestures(canvas, viewport);
  const closeMenu = () => { menu.hidden = true; menu.replaceChildren(); };
  const openMenu = (event, items) => {
    menu.replaceChildren(...items.map(([label, action, { checked, disabled } = {}]) => h('button', {
      role: checked == null ? 'menuitem' : 'menuitemcheckbox', ariaLabel: checked == null ? null : label,
      ariaChecked: checked == null ? null : String(checked),
      type: 'button', disabled,
      onclick: () => { closeMenu(); action(); },
    }, label)));
    menu.hidden = false;
    menu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight)) + 'px';
    menu.querySelector('button:enabled')?.focus({ preventScroll: true });
  };
  const productMenu = (event, product) => openMenu(event, [
    ['Настройки изделия…', () => panels.editProduct(product)],
    ['Переместить в комнате', () => { app.activate(product.id, 'room'); app.setMoveMode(true); canvas.focus(); }],
    ['Удалить изделие…', () => removeProduct(product)],
  ]);
  document.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (target === document.activeElement && target.matches('input:not(:read-only), textarea:not(:read-only)')) return;
    e.preventDefault();
  }, { capture: true });
  app.addEventListener('scene-context', ({ detail: e }) => {
    const { target } = e;
    if (target?.roomId && app.editingRoom) {
      app.selectRoom(target.roomId);
      const element = app.roomSelected;
      if (!element) return;
      const lamp = app.project.room.activeLamp === element.id;
      openMenu(e, [
        ['Размеры и положение', () => panels.showPartPanel()],
        ...(isRoomLamp(element) ? [[lamp ? 'Выключить лампочку' : 'Включить лампочку', () => app.toggleRoomLamp(element)]] : []),
        ['Удалить элемент комнаты', commands.delete],
      ]);
      return;
    }
    const product = app.project.products.find((p) => p.id === target?.productId);
    if (!product) { closeMenu(); return; }
    const part = product.parts.get(target.partId);
    if (app.mode === 'room' || !part) { productMenu(e, product); return; }
    if (app.product !== product) return;
    if (!app.selectedIds.has(part.id)) app.select(part.id);
    const root = rootPart(product, part);
    const caption = app.selectedRoots.length > 1 ? 'Удалить выделенное' : root.kind === KIND.DOOR_ZONE ? 'Удалить дверь'
      : root !== part || root.children.length > 0 ? 'Удалить комплект' : 'Удалить деталь';
    const locks = canLockPart(part) ? part.stenDver === -1 ? [
      ['Блокировать частично', () => app.setPartLock(0)],
      ['Блокировать полностью', () => app.setPartLock(-9)],
    ] : [[part.stenDver === -9 ? 'Разблокировать [полностью]' : 'Разблокировать', () => app.setPartLock(-1)]] : [];
    openMenu(e, [
      ['Крепления и размеры', () => panels.showPartPanel()],
      ...locks,
      [caption, commands.delete],
    ]);
  });
  const tabMenu = (event, product) => openMenu(event, [
      ['Сквозное изделие', () => app.setProductThrough(product, !product.through), { checked: product.through }],
      ['Настройки изделия…', () => panels.editProduct(product)],
      ['Копировать изделие', () => app.copyProduct(product)],
      ['Удалить изделие…', () => removeProduct(product)],
      ['Удалить все изделия, кроме активного', () => removeOtherProducts(product), { disabled: app.project.products.length < 2 }],
  ]);
  const tabContext = (e) => {
    const tab = e.target.closest('[data-product]');
    if (!tab) return;
    const id = Number(tab.dataset.product);
    const product = app.project.products.find((p) => p.id === id);
    if (!product || app.placement) { closeMenu(); return; }
    if (app.product !== product || app.mode !== 'product') app.activate(id);
    tabMenu(e, product);
  };
  document.getElementById('tabs').addEventListener('contextmenu', tabContext);
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  });
  window.addEventListener('resize', closeMenu);

  document.addEventListener('keydown', (e) => {
    if (!menu.hidden) {
      const buttons = [...menu.querySelectorAll('button:enabled')];
      const index = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
      return;
    }
    if (e.target.matches('input, select, textarea') || document.getElementById('modal-root').childElementCount) return;
    if (e.key === 'Delete') commands.delete();
    else if (e.key === 'Escape') app.cancelPlacement();
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) commands.redo();
      else commands.undo();
    }
    else if (e.target === viewport.renderer.domElement && Object.hasOwn(ARROWS, e.key) && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      const [axis, direction] = ARROWS[e.key];
      const step = e.altKey ? 1 : DRAG_STEP;
      if (app.editingRoom) {
        const element = app.roomSelected;
        if (!element) return;
        const move = axis === 'x' && roomAxisFixed(element, 'x') || axis === 'y' && (e.shiftKey || roomAxisFixed(element, 'y')) ? 'z' : axis;
        const box = roomElementBox(app.project.room, element);
        app.moveRoomElement({ [move]: box[AXIS_SIDES[move][0]] + step * (axis === 'y' && move === 'z' ? -direction : direction) });
      } else if (app.mode === 'room' || app.moveMode) app.nudgeProduct(axis === 'y' && !e.shiftKey ? 'z' : axis, (axis === 'y' && !e.shiftKey ? -direction : direction) * step);
      else if (axis === 'y' && e.shiftKey) app.nudgeSelected('z', -direction * step);
      else app.nudgeSelected(axis, direction * step);
    }
  });
}
