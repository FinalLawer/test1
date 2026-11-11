'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onBearing: (cb) => ipcRenderer.on('bearing', (_e, payload) => cb(payload)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode))
});
