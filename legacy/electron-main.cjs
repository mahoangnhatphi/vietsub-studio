// Historical Electron entry. Not part of the static client build.
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');

const smokeTest = process.argv.includes('--smoke');

// The app name must be set before any getPath('userData') call, otherwise
// Electron derives the folder from package.json's name instead of the product.
app.setName('VietSub Studio');

// Packaged builds read UI + tools from resources/ and write job files to userData.
if (app.isPackaged) {
  process.env.VTS_ROOT = process.resourcesPath;
  process.env.VTS_DATA_DIR = path.join(app.getPath('userData'), 'storage');
}
// Let the local server pick a free port so it never fights with `npm start`.
if (!process.env.PORT) process.env.PORT = '0';

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let serverOrigin = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 880,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#f7f3e9',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const openExternal = (event, url) => {
    if (/^https?:/i.test(url) && (!serverOrigin || !url.startsWith(serverOrigin))) {
      event.preventDefault();
      shell.openExternal(url);
    }
  };
  mainWindow.webContents.on('will-navigate', openExternal);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

app.whenReady().then(async () => {
  createWindow();
  const problems = [];
  mainWindow.webContents.on('console-message', (...args) => {
    const detail = args.find((arg) => arg && typeof arg === 'object' && typeof arg.message === 'string');
    const message = detail ? detail.message : args[1];
    if (typeof message === 'string' && /uncaught|is not a function|Cannot read|undefined is not/i.test(message)) problems.push(message);
  });
  try {
    const { ready } = require(path.join(__dirname, '..', 'server.js'));
    const port = await ready;
    serverOrigin = `http://127.0.0.1:${port}`;
    await mainWindow.loadURL(`${serverOrigin}/`);
    if (smokeTest) {
      const health = await fetch(`${serverOrigin}/api/health`).then((r) => r.json());
      const probe = await mainWindow.webContents.executeJavaScript(`(() => {
        const click = document.querySelector('#tab-link');
        click.click();
        const linkVisible = !document.querySelector('#mode-link').classList.contains('hidden');
        click.previousElementSibling.click();
        const uploadVisible = !document.querySelector('#mode-upload').classList.contains('hidden');
        return { title: document.title, linkVisible, uploadVisible, player: Boolean(document.querySelector('#player')) };
      })()`);
      const ok = health.ok === true && probe.linkVisible && probe.uploadVisible && problems.length === 0;
      console.log('SMOKE', JSON.stringify({ ok, health: health.ok, probe, problems }));
      app.exit(ok ? 0 : 1);
      return;
    }
  } catch (error) {
    console.error('Không khởi động được server:', error);
    if (smokeTest) app.exit(1);
    dialog.showErrorBox('VietSub Studio', `Không khởi động được server:\n${error.message}`);
    app.quit();
  }
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
