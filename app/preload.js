'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenter', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getState: () => ipcRenderer.invoke('get-state'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  togglePresenter: () => ipcRenderer.invoke('toggle-presenter'),
  setTargetTitle: (title) => ipcRenderer.invoke('set-target-title', title),
  setManualWindow: (id) => ipcRenderer.invoke('set-manual-window', id),
  listWindows: () => ipcRenderer.invoke('list-windows'),
  reportConnectionStatus: (status) => ipcRenderer.invoke('connection-status', status),

  sendCursorIncoming: (payload) => ipcRenderer.send('cursor-incoming', payload),
  notifyOverlayReady: () => ipcRenderer.send('overlay-ready'),

  onStateChanged: (cb) => {
    const listener = (_evt, s) => cb(s);
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  },
  onCursorSend: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('cursor-send', listener);
    return () => ipcRenderer.removeListener('cursor-send', listener);
  },
  onCursor: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('cursor', listener);
    return () => ipcRenderer.removeListener('cursor', listener);
  }
});
