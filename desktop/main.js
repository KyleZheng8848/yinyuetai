'use strict';

const path = require('path');
const { app, BrowserWindow, Menu, shell } = require('electron');
const { createLauncher } = require('../server/launcher');
const { createLocalSecretCodec } = require('../server/local-secret-codec');

// The studio UI is lightweight; software rendering avoids GPU-process crashes
// on remote desktops and managed macOS environments without weakening sandboxing.
app.disableHardwareAcceleration();

let mainWindow = null;
let launcher = null;
let appUrl = null;

async function createWindow() {
  if (!launcher) {
    const runtimeDir = path.join(app.getPath('userData'), 'runtime');
    launcher = createLauncher({
      port: Number(process.env.YYT_DESKTOP_PORT || 18799), runtimeDir, desktop: true,
      secretCodec: createLocalSecretCodec(runtimeDir),
    });
    const result = await launcher.listen();
    appUrl = result.baseUrl;
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#11120f',
    title: '音悦台 Studio',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(appUrl);
}

app.setName('音悦台 Studio');
app.whenReady().then(async () => {
  await createWindow();
  const about = { label: '关于音悦台 Studio', click: () => {
    mainWindow?.show();
    mainWindow?.webContents.send('show-about');
  } };
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), copyright: '© 2026 SofunAI Studio and Yinyuetai contributors' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.getName(), submenu: [about, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [about, { label: 'GitHub 开源主页', click: () => shell.openExternal('https://github.com/KyleZheng8848/yinyuetai') }] },
  ]));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('before-quit', () => {
  launcher?.manager.stopAll();
  if (launcher?.server.listening) launcher.server.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
