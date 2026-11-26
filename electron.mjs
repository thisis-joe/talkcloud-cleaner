import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { appId, loginArgument, startDesktopUpdates } from './desktop-updates.mjs';
import { PLATFORM_TOOLS_URL } from './usb.mjs';

const smoke = process.argv.includes('--smoke-test');
const sourceIcon = join(import.meta.dirname, 'build');
const iconPath = join(sourceIcon, 'icon.png');
let desktop;
let openingWindow;
let updates;
let backgroundLogin = false;
let windowRequested = false;
let started = false;
let quitting = false;

if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(appId);

if (!smoke && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', (_event, args) => {
    if (!args.includes(loginArgument)) requestWindow();
  });
  app.on('activate', () => {
    if (started && !backgroundLogin && !smoke) requestWindow();
  });
  app.whenReady().then(start).catch(startupError);
}

app.on('window-all-closed', () => {
  if (!updates) closeApp();
});
app.on('before-quit', event => {
  if (!quitting) {
    event.preventDefault();
    closeApp();
  }
});

async function start() {
  if (!app.isPackaged) app.dock?.setIcon(iconPath);
  process.env.TALKCLOUD_NO_OPEN = '1';
  process.env.TALKCLOUD_ELECTRON = '1';
  process.env.TALKCLOUD_APP_PROFILE = join(app.getPath('userData'), 'TalkCloudBrowser');
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.resourcesPath, 'cloud-browser');
    process.env.TALKCLOUD_BUNDLED_BROWSER = '1';
  }
  if (!smoke) {
    updates = await startDesktopUpdates({ openApp: requestWindow, iconPath }).catch(error => {
      console.warn('Update notifications could not start:', error.message);
    });
    if (quitting) {
      updates?.stop();
      return;
    }
    backgroundLogin = Boolean(updates?.startedAtLogin && !windowRequested);
    if (backgroundLogin) app.dock?.hide();
  }
  started = true;
  if (backgroundLogin) return;

  const window = await openMainWindow();
  if (smoke) await checkPackage(window);
}

function requestWindow() {
  windowRequested = true;
  if (!started || quitting) return;
  backgroundLogin = false;
  void openMainWindow().catch(startupError);
}

async function openMainWindow() {
  if (openingWindow) return openingWindow;
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
    return window;
  }
  openingWindow = createMainWindow().finally(() => { openingWindow = undefined; });
  return openingWindow;
}

async function createMainWindow() {
  desktop ??= import('./app.mjs');
  const { appUrl } = await desktop;
  if (quitting) return;
  const window = new BrowserWindow({
    width: 840,
    height: 630,
    minWidth: 420,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    icon: !app.isPackaged && process.platform === 'win32' ? join(sourceIcon, 'icon.ico') : undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const local = new URL(appUrl).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === PLATFORM_TOOLS_URL) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== local) event.preventDefault();
  });
  await window.loadURL(appUrl);
  if (!smoke && !quitting) {
    if (app.dock && !app.dock.isVisible()) await app.dock.show();
    window.show();
  }
  return window;
}

async function checkPackage(window) {
  const heading = await window.webContents.executeJavaScript("document.querySelector('h1')?.textContent");
  if (heading !== '톡클라우드 중복 정리') throw new Error('데스크톱 화면을 불러오지 못했습니다.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    channel: app.isPackaged ? 'chromium' : 'chrome',
  });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<title>Browser smoke test</title>');
    if (await page.title() !== 'Browser smoke test') throw new Error('동봉 브라우저가 실행되지 않았습니다.');
  } finally {
    await browser.close();
  }
  closeApp();
}

function startupError(error) {
  if (smoke) console.error(error);
  else dialog.showErrorBox('톡클라우드 중복 정리 실행 실패', error.message);
  closeApp(1);
}

function closeApp(code = 0) {
  if (quitting) return;
  quitting = true;
  const shutdown = async () => {
    updates?.stop();
    const server = await desktop?.catch(() => null);
    await server?.shutdown();
  };
  shutdown().then(() => app.exit(code), () => app.exit(1));
}
