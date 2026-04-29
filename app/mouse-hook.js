'use strict';

let uIOhook = null;
let UiohookMouseButton = null;
try {
  const mod = require('uiohook-napi');
  uIOhook = mod.uIOhook;
  UiohookMouseButton = mod.UiohookMouseButton;
} catch (err) {
  console.warn('[mouse-hook] uiohook-napi not loaded:', err.message);
}

const SEND_INTERVAL_MS = 16; // ~60 fps cap

const state = {
  presenterActive: false,
  bounds: null,
  pressed: false,
  onCursor: null,
  started: false,
  lastSent: 0,
  lastPayload: null
};

function isInside(x, y, b) {
  if (!b) return false;
  return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
}

function emitCursor(payload, force = false) {
  if (!state.onCursor) return;
  const now = Date.now();
  if (!force && now - state.lastSent < SEND_INTERVAL_MS) return;
  state.lastSent = now;
  state.lastPayload = payload;
  state.onCursor(payload);
}

function buildPayload(x, y, pressed) {
  const b = state.bounds;
  if (!b) return null;
  const rx = (x - b.x) / b.width;
  const ry = (y - b.y) / b.height;
  return {
    x: Math.max(0, Math.min(1, rx)),
    y: Math.max(0, Math.min(1, ry)),
    pressed: !!pressed,
    t: Date.now()
  };
}

function handleMouseMove(e) {
  if (!state.presenterActive) return;
  if (!state.pressed) return;
  if (!state.bounds) return;
  if (!isInside(e.x, e.y, state.bounds)) return;
  const payload = buildPayload(e.x, e.y, true);
  if (payload) emitCursor(payload);
}

function handleMouseDown(e) {
  if (!state.presenterActive) return;
  if (!UiohookMouseButton) return;
  if (e.button !== UiohookMouseButton.Left) return;
  if (!state.bounds) return;
  if (!isInside(e.x, e.y, state.bounds)) return;
  state.pressed = true;
  const payload = buildPayload(e.x, e.y, true);
  if (payload) emitCursor(payload, true);
}

function handleMouseUp(e) {
  if (!UiohookMouseButton) return;
  if (e.button !== UiohookMouseButton.Left) return;
  if (!state.pressed) return;
  state.pressed = false;
  const last = state.lastPayload;
  if (last) {
    emitCursor({ x: last.x, y: last.y, pressed: false, t: Date.now() }, true);
  } else if (state.bounds) {
    const p = buildPayload(e.x, e.y, false);
    if (p) emitCursor(p, true);
  }
}

function start({ onCursor } = {}) {
  state.onCursor = onCursor || null;
  if (state.started) return;
  if (!uIOhook) {
    console.warn('[mouse-hook] uIOhook not available – sender disabled');
    return;
  }
  uIOhook.on('mousemove', handleMouseMove);
  uIOhook.on('mousedown', handleMouseDown);
  uIOhook.on('mouseup', handleMouseUp);
  uIOhook.on('mousedrag', handleMouseMove);
  try {
    uIOhook.start();
    state.started = true;
  } catch (err) {
    console.warn('[mouse-hook] start failed:', err.message);
  }
}

function stop() {
  if (!state.started || !uIOhook) return;
  try { uIOhook.stop(); } catch (err) {
    console.warn('[mouse-hook] stop failed:', err.message);
  }
  state.started = false;
}

function setPresenterActive(active) {
  state.presenterActive = !!active;
  if (!state.presenterActive && state.pressed) {
    state.pressed = false;
    if (state.lastPayload) {
      emitCursor({ x: state.lastPayload.x, y: state.lastPayload.y, pressed: false, t: Date.now() }, true);
    }
  }
}

function setBounds(bounds) {
  state.bounds = bounds || null;
}

module.exports = {
  start,
  stop,
  setPresenterActive,
  setBounds
};
