'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  onShowAbout(callback) {
    if (typeof callback !== 'function') return;
    const listener = () => callback();
    ipcRenderer.on('show-about', listener);
    return () => ipcRenderer.removeListener('show-about', listener);
  },
}));
