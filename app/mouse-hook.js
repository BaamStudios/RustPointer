'use strict';

let uIOhook = null;
let loadError = null;
try {
  ({ uIOhook } = require('uiohook-napi'));
} catch (err) {
  loadError = err.message;
  console.warn('[mouse-hook] uiohook-napi not loaded:', err.message);
}

// libuiohook button-codes — uiohook-napi exportiert dafür kein Enum.
const MOUSE_BUTTON_LEFT = 1;

const SEND_INTERVAL_MS = 16; // ~60 fps cap

const state = {
  presenterActive: false,
  bounds: null,
  pressed: false,
  onCursor: null,
  onLog: null,
  started: false,
  lastSent: 0,
  lastPayload: null,
  lastNoBoundsLog: 0,
  lastOutsideLog: 0,
  lastInactiveLog: 0
};

function emitLog(level, message) {
  if (state.onLog) state.onLog({ level, message });
}

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

function isLeftButton(e) {
  // libuiohook nutzt 1 für links. Manche Versionen liefern es als Number,
  // andere als Object — beide Fälle abdecken.
  return e.button === MOUSE_BUTTON_LEFT || Number(e.button) === MOUSE_BUTTON_LEFT;
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
  if (!isLeftButton(e)) return;

  if (!state.presenterActive) {
    const now = Date.now();
    if (now - state.lastInactiveLog > 5000) {
      state.lastInactiveLog = now;
      emitLog('muted', 'Linksklick erkannt, aber Presenter-Modus ist AUS — bitte aktivieren.');
    }
    return;
  }
  if (!state.bounds) {
    const now = Date.now();
    if (now - state.lastNoBoundsLog > 3000) {
      state.lastNoBoundsLog = now;
      emitLog('warn', 'Linksklick erkannt, aber kein Ziel-Fenster bekannt (Bounds fehlen).');
    }
    return;
  }
  if (!isInside(e.x, e.y, state.bounds)) {
    const now = Date.now();
    if (now - state.lastOutsideLog > 3000) {
      state.lastOutsideLog = now;
      const b = state.bounds;
      emitLog('muted', `Linksklick (${e.x}, ${e.y}) außerhalb des Ziel-Fensters [${b.x},${b.y} ${b.width}×${b.height}].`);
    }
    return;
  }

  state.pressed = true;
  const payload = buildPayload(e.x, e.y, true);
  if (payload) emitCursor(payload, true);
}

function handleMouseUp(e) {
  if (!isLeftButton(e)) return;
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

function start({ onCursor, onLog } = {}) {
  state.onCursor = onCursor || null;
  state.onLog = onLog || null;
  if (state.started) return;
  if (!uIOhook) {
    emitLog('err', `uiohook-napi nicht verfügbar: ${loadError || 'unbekannter Fehler'}`);
    return;
  }
  uIOhook.on('mousemove', handleMouseMove);
  uIOhook.on('mousedown', handleMouseDown);
  uIOhook.on('mouseup', handleMouseUp);
  try {
    uIOhook.start();
    state.started = true;
    emitLog('info', 'Mouse-Hook gestartet (uiohook-napi).');
  } catch (err) {
    emitLog('err', `Mouse-Hook start fehlgeschlagen: ${err.message}`);
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
  const next = !!active;
  if (next === state.presenterActive) return;
  state.presenterActive = next;
  emitLog('info', `Presenter-Modus: ${next ? 'EIN' : 'AUS'}`);
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
