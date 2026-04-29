'use strict';

let windowManager = null;
let loadError = null;
try {
  ({ windowManager } = require('node-window-manager'));
} catch (err) {
  loadError = err.message;
  console.warn('[window-finder] node-window-manager not loaded:', err.message);
}

// Selbsttest: Modul lädt, aber addon.node fehlt erst beim ersten Aufruf
if (windowManager) {
  try {
    windowManager.getWindows();
  } catch (err) {
    loadError = err.message;
    console.warn('[window-finder] node-window-manager call failed:', err.message);
    windowManager = null;
  }
}

const psFallback = require('./window-finder-ps');
const useFallback = !windowManager;

const POLL_INTERVAL_MS = useFallback ? 250 : 100;

const state = {
  targetTitle: 'RustDesk',
  manualWindowId: null,
  lastBounds: null,
  onBoundsChanged: null,
  onLog: null,
  timer: null,
  lastNotFoundLog: 0,
  ticking: false
};

function emitLog(level, message) {
  if (state.onLog) state.onLog({ level, message });
}

function boundsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function snapshotNative() {
  if (!windowManager) return [];
  const wins = [];
  for (const w of windowManager.getWindows()) {
    let visible = false;
    let title = '';
    let bounds = null;
    try { visible = w.isVisible(); } catch { continue; }
    if (!visible) continue;
    try { title = w.getTitle(); } catch { continue; }
    if (!title || !title.length) continue;
    try { bounds = w.getBounds(); } catch { continue; }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
    wins.push({
      id: w.id,
      title,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    });
  }
  return wins;
}

async function snapshotAsync() {
  if (windowManager) {
    try { return snapshotNative(); }
    catch (err) {
      emitLog('err', `node-window-manager Aufruf fehlgeschlagen: ${err.message} — wechsle auf PowerShell-Fallback`);
      windowManager = null;
    }
  }
  return await psFallback.listWindowsAsync();
}

function pickWindow(list) {
  if (state.manualWindowId !== null && state.manualWindowId !== undefined) {
    const manual = list.find((w) => String(w.id) === String(state.manualWindowId));
    if (manual) return manual;
  }
  const titleLower = state.targetTitle.toLowerCase();
  return list.find((w) => w.title.toLowerCase().includes(titleLower)) || null;
}

async function tick() {
  if (state.ticking) return;
  state.ticking = true;
  let bounds = null;
  let list = [];
  try {
    list = await snapshotAsync();
    const win = pickWindow(list);
    if (win && win.bounds && win.bounds.width > 0 && win.bounds.height > 0) {
      bounds = win.bounds;
    }
  } catch (err) {
    // ignore – nächster Tick
  } finally {
    state.ticking = false;
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
      diagnose(list);
    }
  }
}

function diagnose(list) {
  if (state.manualWindowId !== null && state.manualWindowId !== undefined) {
    emitLog('err', `Kein Fenster mit ID ${state.manualWindowId} (manuelle Auswahl). ${list.length} sichtbare Fenster gesamt.`);
    return;
  }
  if (list.length === 0) {
    emitLog('warn', 'Keine sichtbaren Fenster ermittelt.');
    return;
  }
  const titleLower = state.targetTitle.toLowerCase();
  const matched = list.filter((w) => w.title.toLowerCase().includes(titleLower));
  if (matched.length === 0) {
    const sample = list.slice(0, 8).map((w) => `"${w.title.slice(0, 40)}"`).join(', ');
    emitLog('warn', `Kein Fenster mit Titel-Substring "${state.targetTitle}" gefunden. Sichtbare Fenster (Top ${Math.min(8, list.length)} von ${list.length}): ${sample}`);
    return;
  }
  emitLog('warn', `Fenster "${matched[0].title}" gefunden, aber ohne gültige Bounds (minimiert?).`);
}

function start({ targetTitle, onBoundsChanged, onLog } = {}) {
  if (targetTitle) state.targetTitle = targetTitle;
  state.onBoundsChanged = onBoundsChanged || null;
  state.onLog = onLog || null;
  if (state.timer) clearInterval(state.timer);

  if (useFallback) {
    if (loadError) {
      emitLog('warn', `node-window-manager nicht verfügbar (${loadError.split('\\n')[0]}) — nutze PowerShell-Fallback.`);
    } else {
      emitLog('warn', 'PowerShell-Fallback aktiv (langsamer, ~250ms Polling).');
    }
  } else {
    emitLog('info', `Window-Finder gestartet (native). Ziel-Titel: "${state.targetTitle}"`);
  }

  state.timer = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);
  tick().catch(() => {});
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
  tick().catch(() => {});
}

function setManualWindowId(id) {
  state.manualWindowId = id;
  state.lastBounds = null;
  state.lastNotFoundLog = 0;
  emitLog('info', id ? `Manuelle Fenster-Auswahl: ID ${id}` : 'Manuelle Fenster-Auswahl aufgehoben');
  tick().catch(() => {});
}

async function listWindows() {
  try {
    return await snapshotAsync();
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
