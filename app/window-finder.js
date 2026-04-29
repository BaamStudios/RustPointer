'use strict';

let windowManager = null;
let loadError = null;
try {
  ({ windowManager } = require('node-window-manager'));
} catch (err) {
  loadError = err.message;
  console.warn('[window-finder] node-window-manager not loaded:', err.message);
}

const POLL_INTERVAL_MS = 100;

const state = {
  targetTitle: 'RustDesk',
  manualWindowId: null,
  lastBounds: null,
  onBoundsChanged: null,
  onLog: null,
  timer: null,
  lastNotFoundLog: 0
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

function emitLog(level, message) {
  if (state.onLog) state.onLog({ level, message });
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
    if (bounds) {
      emitLog('info', `Fenster gefunden: ${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})`);
    }
  }

  if (!bounds) {
    const now = Date.now();
    if (now - state.lastNotFoundLog > 5000) {
      state.lastNotFoundLog = now;
      diagnose();
    }
  }
}

function diagnose() {
  if (loadError) {
    emitLog('err', `node-window-manager nicht geladen: ${loadError}`);
    return;
  }
  if (!windowManager) {
    emitLog('err', 'node-window-manager nicht verfügbar');
    return;
  }
  let wins = [];
  try { wins = windowManager.getWindows(); }
  catch (err) {
    emitLog('err', `getWindows() fehlgeschlagen: ${err.message}`);
    return;
  }
  const visible = wins.filter((w) => {
    try { return w.isVisible() && w.getTitle && w.getTitle().length > 0; }
    catch { return false; }
  });
  const titleLower = state.targetTitle.toLowerCase();
  const matching = visible.filter((w) => {
    try { return w.getTitle().toLowerCase().includes(titleLower); }
    catch { return false; }
  });
  if (state.manualWindowId !== null && state.manualWindowId !== undefined) {
    emitLog('err', `Kein Fenster mit ID ${state.manualWindowId} (manuelle Auswahl). ${visible.length} sichtbare Fenster gesamt.`);
    return;
  }
  if (matching.length === 0) {
    const sample = visible.slice(0, 8).map((w) => {
      try { return `"${w.getTitle().slice(0, 40)}"`; } catch { return '?'; }
    });
    emitLog('warn', `Kein Fenster mit Titel-Substring "${state.targetTitle}" gefunden. Sichtbare Fenster (Top ${sample.length} von ${visible.length}): ${sample.join(', ')}`);
    return;
  }
  // matched aber bounds == null → vermutlich width/height 0 (minimiert?)
  const w = matching[0];
  let title = '?';
  try { title = w.getTitle(); } catch {}
  emitLog('warn', `Fenster "${title}" gefunden, aber ohne gültige Bounds (minimiert?).`);
}

function start({ targetTitle, onBoundsChanged, onLog } = {}) {
  if (targetTitle) state.targetTitle = targetTitle;
  state.onBoundsChanged = onBoundsChanged || null;
  state.onLog = onLog || null;
  if (state.timer) clearInterval(state.timer);

  if (loadError) {
    emitLog('err', `node-window-manager Lade-Fehler: ${loadError} — vermutlich nicht für Electron neu kompiliert. Versuche: npm rebuild node-window-manager`);
  } else if (!windowManager) {
    emitLog('err', 'node-window-manager nicht verfügbar.');
  } else {
    emitLog('info', `Window-Finder gestartet. Ziel-Titel: "${state.targetTitle}"`);
  }

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
  state.lastNotFoundLog = 0;
  emitLog('info', `Ziel-Titel geändert auf "${state.targetTitle}"`);
  tick();
}

function setManualWindowId(id) {
  state.manualWindowId = id;
  state.lastBounds = null;
  state.lastNotFoundLog = 0;
  emitLog('info', id ? `Manuelle Fenster-Auswahl: ID ${id}` : 'Manuelle Fenster-Auswahl aufgehoben');
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
