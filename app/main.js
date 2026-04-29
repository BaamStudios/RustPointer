'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');

// .env aus mehreren Standorten laden (erste Treffer gewinnt):
// 1. neben der ausführbaren Datei (User legt .env neben Presenter-Cursor.exe)
// 2. userData/.env (persistente Config in %APPDATA%)
// 3. process.resourcesPath/.env.example (initial vom Build mitgeliefert)
// 4. __dirname/.env (Dev-Modus)
function loadEnv() {
  const userDataEnv = path.join(app.getPath('userData'), '.env');
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), '.env'),
    userDataEnv,
    path.join(__dirname, '.env')
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      require('dotenv').config({ path: p });
      return p;
    }
  }
  // Erstes Mal gepackte App ohne .env: .env.example -> userData/.env kopieren
  const exampleSrc = path.join(process.resourcesPath || '', '.env.example');
  if (fs.existsSync(exampleSrc)) {
    try {
      fs.mkdirSync(path.dirname(userDataEnv), { recursive: true });
      fs.copyFileSync(exampleSrc, userDataEnv);
      require('dotenv').config({ path: userDataEnv });
      return userDataEnv;
    } catch {}
  }
  return null;
}
const loadedEnvPath = loadEnv();

const mouseHook = require('./mouse-hook');
const windowFinder = require('./window-finder');

const ENV = {
  signalServerUrl: (process.env.SIGNAL_SERVER_URL || 'ws://localhost:3000').trim(),
  roomId: (process.env.ROOM_ID || '').trim(),
  targetTitle: (process.env.TARGET_WINDOW_TITLE || 'RustDesk').trim(),
  defaultMode: ['sender', 'receiver', 'both'].includes((process.env.DEFAULT_MODE || '').trim())
    ? process.env.DEFAULT_MODE.trim()
    : 'sender',
  turnUrl: (process.env.TURN_URL || '').trim(),
  turnUsername: (process.env.TURN_USERNAME || '').trim(),
  turnCredential: (process.env.TURN_CREDENTIAL || '').trim()
};

const logBuffer = [];
let controlReady = false;

function logToControl(level, message) {
  if (!controlReady || !controlWindow || controlWindow.isDestroyed()) {
    logBuffer.push({ level, message });
    if (logBuffer.length > 200) logBuffer.shift();
    return;
  }
  controlWindow.webContents.send('log', { level, message });
}

function flushLogBuffer() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  while (logBuffer.length) {
    controlWindow.webContents.send('log', logBuffer.shift());
  }
}

let controlWindow = null;
let overlayWindow = null;
let tray = null;

const state = {
  presenterActive: false,
  connected: false,
  mode: ENV.defaultMode,
  targetTitle: ENV.targetTitle,
  manualWindowId: null,
  rustDeskBounds: null,
  displayBounds: null
};

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 520,
    height: 640,
    title: 'Presenter-Cursor',
    show: false,
    autoHideMenuBar: true,
    icon: resolveAssetPath('icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  controlWindow.loadFile(path.join(__dirname, 'control.html'));

  controlWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      controlWindow.hide();
    }
  });

  controlWindow.webContents.on('did-finish-load', () => {
    controlReady = true;
    flushLogBuffer();
  });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

function showOverlay() {
  const w = createOverlayWindow();
  if (!w.isVisible()) w.showInactive();
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
  }
}

function resolveAssetPath(rel) {
  // Im Dev-Modus: build-resources/ neben main.js
  // Gepackt: Resources werden via electron-builder mit-eingepackt (asar oder als Datei)
  const candidates = [
    path.join(__dirname, 'build-resources', rel),
    path.join(process.resourcesPath || '', 'app.asar', 'build-resources', rel),
    path.join(process.resourcesPath || '', 'build-resources', rel)
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return candidates[0];
}

let trayIconActive = null;
let trayIconInactive = null;
function loadTrayIcons() {
  try {
    trayIconActive = nativeImage.createFromPath(resolveAssetPath('tray-active.png'));
    trayIconInactive = nativeImage.createFromPath(resolveAssetPath('tray-inactive.png'));
  } catch (err) {
    console.warn('[tray] icon load failed:', err.message);
  }
}

function trayIconImage() {
  if (!trayIconActive || !trayIconInactive) loadTrayIcons();
  const img = state.presenterActive ? trayIconActive : trayIconInactive;
  if (img && !img.isEmpty()) return img;
  // Fallback: simples Quadrat
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const color = state.presenterActive ? [255, 60, 60, 255] : [160, 160, 160, 255];
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = color[0];
    buf[i * 4 + 1] = color[1];
    buf[i * 4 + 2] = color[2];
    buf[i * 4 + 3] = color[3];
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayIconImage());

  const tooltip = state.presenterActive
    ? 'Presenter-Cursor – Pointer AKTIV (klicken zum Ausschalten)'
    : 'Presenter-Cursor – Pointer aus (klicken zum Einschalten)';
  tray.setToolTip(tooltip);

  const menu = Menu.buildFromTemplate([
    {
      label: state.presenterActive ? 'Pointer AUS' : 'Pointer EIN',
      click: () => togglePresenter()
    },
    { type: 'separator' },
    {
      label: 'Modus',
      submenu: [
        { label: 'Sender', type: 'radio', checked: state.mode === 'sender', click: () => setMode('sender') },
        { label: 'Receiver', type: 'radio', checked: state.mode === 'receiver', click: () => setMode('receiver') },
        { label: 'Bidirektional', type: 'radio', checked: state.mode === 'both', click: () => setMode('both') }
      ]
    },
    { label: 'Verbindung & Einstellungen…', click: () => showControl() },
    { type: 'separator' },
    {
      label: state.connected ? 'Verbunden' : 'Nicht verbunden',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Beenden', click: () => quitApp() }
  ]);
  tray.setContextMenu(menu);
}

function showControl() {
  if (!controlWindow) createControlWindow();
  controlWindow.show();
  controlWindow.focus();
}

function quitApp() {
  app.isQuitting = true;
  try { mouseHook.stop(); } catch {}
  try { windowFinder.stop(); } catch {}
  app.quit();
}

function setMode(mode) {
  state.mode = mode;
  applyModeChange();
  updateTray();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('state-changed', publicState());
  }
}

function applyModeChange() {
  const wantsReceiver = state.mode === 'receiver' || state.mode === 'both';
  const wantsSender = state.mode === 'sender' || state.mode === 'both';

  if (wantsReceiver && state.connected) showOverlay();
  else hideOverlay();

  if (!wantsSender && state.presenterActive) {
    state.presenterActive = false;
    mouseHook.setPresenterActive(false);
  }
}

function togglePresenter() {
  if (state.mode !== 'sender' && state.mode !== 'both') return;
  state.presenterActive = !state.presenterActive;
  mouseHook.setPresenterActive(state.presenterActive);
  updateTray();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('state-changed', publicState());
  }
}

function publicState() {
  return {
    mode: state.mode,
    presenterActive: state.presenterActive,
    connected: state.connected,
    targetTitle: state.targetTitle,
    manualWindowId: state.manualWindowId,
    rustDeskBounds: state.rustDeskBounds,
    displayBounds: state.displayBounds
  };
}

function forwardCursorToOverlay(payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('cursor', payload);
}

ipcMain.handle('get-config', () => ({
  signalServerUrl: ENV.signalServerUrl,
  roomId: ENV.roomId,
  targetTitle: ENV.targetTitle,
  defaultMode: ENV.defaultMode,
  turnUrl: ENV.turnUrl,
  turnUsername: ENV.turnUsername,
  turnCredential: ENV.turnCredential
}));

ipcMain.handle('get-state', () => publicState());

ipcMain.handle('set-mode', (_evt, mode) => {
  if (['sender', 'receiver', 'both'].includes(mode)) setMode(mode);
  return publicState();
});

ipcMain.handle('toggle-presenter', () => {
  togglePresenter();
  return publicState();
});

ipcMain.handle('set-target-title', (_evt, title) => {
  state.targetTitle = String(title || '').trim() || 'RustDesk';
  windowFinder.setTargetTitle(state.targetTitle);
  return publicState();
});

ipcMain.handle('set-manual-window', (_evt, id) => {
  state.manualWindowId = id || null;
  windowFinder.setManualWindowId(state.manualWindowId);
  return publicState();
});

ipcMain.handle('list-windows', () => {
  return windowFinder.listWindows();
});

ipcMain.handle('connection-status', (_evt, status) => {
  state.connected = !!status.connected;
  applyModeChange();
  updateTray();
  return publicState();
});

ipcMain.on('cursor-incoming', (_evt, payload) => {
  forwardCursorToOverlay(payload);
});

ipcMain.on('cursor-outgoing', (_evt, payload) => {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.send('cursor-send', payload);
});

ipcMain.on('overlay-ready', () => {
  if (state.connected && (state.mode === 'receiver' || state.mode === 'both')) {
    showOverlay();
  }
});

ipcMain.on('control-ready', () => {
  controlReady = true;
  flushLogBuffer();
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('Presenter-Cursor');

  try {
    const primary = screen.getPrimaryDisplay();
    state.displayBounds = { x: primary.bounds.x, y: primary.bounds.y, width: primary.bounds.width, height: primary.bounds.height };
  } catch {} 

  createControlWindow();

  if (loadedEnvPath) {
    logToControl('muted', `[Config] .env geladen aus: ${loadedEnvPath}`);
  } else {
    logToControl('warn', '[Config] Keine .env gefunden — Standardwerte werden verwendet.');
  }

  tray = new Tray(trayIconImage());
  tray.on('click', () => {
    if (state.mode === 'sender' || state.mode === 'both') togglePresenter();
    else showControl();
  });
  tray.on('right-click', () => tray.popUpContextMenu());
  updateTray();

  windowFinder.start({
    targetTitle: state.targetTitle,
    onBoundsChanged: (bounds) => {
      state.rustDeskBounds = bounds;
      mouseHook.setBounds(bounds);
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('state-changed', publicState());
      }
    },
    onFocusChanged: (focused) => {
      mouseHook.setFocused(focused);
    },
    onLog: ({ level, message }) => {
      logToControl(level, `[Fenster] ${message}`);
    }
  });

  mouseHook.start({
    onCursor: (payload) => {
      if (!controlWindow || controlWindow.isDestroyed()) return;
      controlWindow.webContents.send('cursor-send', payload);
    },
    onLog: ({ level, message }) => {
      logToControl(level, `[Maus] ${message}`);
    }
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { mouseHook.stop(); } catch {}
  try { windowFinder.stop(); } catch {}
});
