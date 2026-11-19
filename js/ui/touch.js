const HOLD_MS = 500;
const TAP_DISTANCE = 6;
const fromTouch = (event) => event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents;
const moved = (event, start) => Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > TAP_DISTANCE;

function sceneEvent(event, type, button = 0) {
  const { pointerId, clientX, clientY, shiftKey, ctrlKey, altKey } = event;
  const pressed = type === 'pointerdown' || type === 'pointermove';
  return { type, pointerId, clientX, clientY, shiftKey, ctrlKey, altKey, pointerType: 'mouse', isPrimary: true,
    button: type === 'pointermove' ? -1 : button, buttons: pressed ? (button === 2 ? 2 : 1) : 0 };
}

export function bindTouchGestures(canvas, viewport) {
  const targetFor = (element) => element === canvas ? canvas : element.closest?.('[data-touch-menu]');
  let gesture;
  let releasedHold;

  const stop = (type, event) => {
    const current = gesture;
    if (!current) return;
    gesture = null;
    const { start, target, held, button, timer } = current;
    clearTimeout(timer);
    if (held) releasedHold = { start, time: performance.now() };
    if (button != null) {
      viewport.onUp(sceneEvent(event ?? start, type, button));
    } else if (!held && type === 'pointerup' && target === canvas && !moved(event, start)) {
      viewport.onDown(sceneEvent(start, 'pointerdown'), false);
      viewport.onUp(sceneEvent(event, 'pointerup'));
    }
  };

  const hold = () => {
    const { start, target } = gesture;
    if (!target.isConnected) return;
    gesture.held = true;
    if (target === canvas) {
      viewport.onDown(sceneEvent(start, 'pointerdown', 2), false);
      if (viewport.app.placement) gesture.button = 2;
      else viewport.onUp(sceneEvent(start, 'pointerup', 2));
    } else {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
        clientX: start.clientX, clientY: start.clientY }));
    }
  };

  document.addEventListener('pointerdown', (event) => {
    stop('pointercancel');
    if (!event.isPrimary) return;
    releasedHold = null;
    if (event.pointerType !== 'touch' || viewport.down) return;
    const target = targetFor(event.target);
    if (target) gesture = { start: event, target, timer: setTimeout(hold, HOLD_MS) };
  }, true);

  document.addEventListener('pointermove', (event) => {
    if (gesture?.start.pointerId !== event.pointerId) return;
    if (gesture.button == null) {
      if (gesture.held || !moved(event, gesture.start)) return;
      if (gesture.target !== canvas) { stop('pointercancel'); return; }
      clearTimeout(gesture.timer);
      gesture.button = 0;
      viewport.onDown(sceneEvent(gesture.start, 'pointerdown'), false);
    }
    viewport.onMove(sceneEvent(event, 'pointermove', gesture.button));
  }, true);

  const finish = (event) => {
    if (gesture?.start.pointerId === event.pointerId) stop(event.type, event);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, finish, true);
  window.addEventListener('blur', () => stop('pointercancel'));

  const recentHold = (event) => releasedHold && performance.now() - releasedHold.time <= HOLD_MS && !moved(event, releasedHold.start);
  document.addEventListener('contextmenu', (event) => {
    const target = targetFor(event.target);
    if (!target) return;
    const holding = target === gesture?.target && !moved(event, gesture.start);
    if (!fromTouch(event) && !(event.isTrusted && (holding || recentHold(event)))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  for (const type of ['click', 'dblclick']) document.addEventListener(type, (event) => {
    if (!recentHold(event) || !fromTouch(event) && (event.pointerType || !event.detail)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
