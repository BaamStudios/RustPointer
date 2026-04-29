'use strict';

let windowManager = null;
try {
  ({ windowManager } = require('node-window-manager'));
} catch (err) {
  console.warn('[window-finder] node-window-manager not loaded:', err.message);
}

const POLL_INTERVAL_MS = 100;

const state = {
  targetTitle: 'RustDesk',
  manualWindowId: null,
  lastBounds: null,
  onBoundsChanged: null,
  timer: null
};

function boundsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function findWindow() {
  if (!windowManager) return null;
  const wins = windowManager.getWindows().filter((w) => {
    try { return w.isVisible() && w.getTitle && w.getTitle().length > 0; }
    catch { return false; }
  });

  if (state.manualWindowId !== null && state.manualWindowId !== undefined) {
    const manual = wins.find((w) => String(w.id) === String(state.manualWindowId));
    if (manual) return manual;
  }

  const titleLower = state.targetTitle.toLowerCase();
  return wins.find((w) => {
    try { return w.getTitle().toLowerCase().includes(titleLower); }
    catch { return false; }
  }) || null;
}

function tick() {
  let bounds = null;
  try {
    const win = findWindow();
    if (win) {
      const b = win.getBounds();
      if (b && b.width > 0 && b.height > 0) {
        bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
  } catch (err) {
    // ignore – wir versuchen nächsten Tick
  }

  if (!boundsEqual(bounds, state.lastBounds)) {
    state.lastBounds = bounds;
    if (state.onBoundsChanged) state.onBoundsChanged(bounds);
  }
}

function start({ targetTitle, onBoundsChanged } = {}) {
  if (targetTitle) state.targetTitle = targetTitle;
  state.onBoundsChanged = onBoundsChanged || null;
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function setTargetTitle(title) {
  state.targetTitle = String(title || 'RustDesk');
  state.lastBounds = null;
  tick();
}

function setManualWindowId(id) {
  state.manualWindowId = id;
  state.lastBounds = null;
  tick();
}

function listWindows() {
  if (!windowManager) return [];
  try {
    return windowManager.getWindows()
      .filter((w) => {
        try { return w.isVisible() && w.getTitle && w.getTitle().length > 0; }
        catch { return false; }
      })
      .map((w) => {
        let title = '';
        let bounds = null;
        try { title = w.getTitle(); } catch {}
        try { bounds = w.getBounds(); } catch {}
        return { id: w.id, title, bounds };
      });
  } catch (err) {
    console.warn('[window-finder] listWindows failed:', err.message);
    return [];
  }
}

function getCurrentBounds() {
  return state.lastBounds;
}

module.exports = {
  start,
  stop,
  setTargetTitle,
  setManualWindowId,
  listWindows,
  getCurrentBounds
};
