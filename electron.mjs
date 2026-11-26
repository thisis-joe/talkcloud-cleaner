import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';

const smoke = process.argv.includes('--smoke-test');
let stopServer;
let quitting = false;

if (!smoke && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(start).catch(error => {
    if (smoke) console.error(error);
    else dialog.showErrorBox('톡클라우드 중복 정리 실행 실패', error.message);
    app.exit(1);
  });
}

app.on('window-all-closed', closeApp);
app.on('before-quit', event => {
  if (!quitting) {
    event.preventDefault();
    closeApp();
  }
});

async function start() {
  process.env.TALKCLOUD_NO_OPEN = '1';
  process.env.TALKCLOUD_ELECTRON = '1';
  process.env.TALKCLOUD_APP_PROFILE = join(app.getPath('userData'), 'TalkCloudBrowser');
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.resourcesPath, 'cloud-browser');
    process.env.TALKCLOUD_BUNDLED_BROWSER = '1';
  }
  const { appUrl, shutdown } = await import('./app.mjs');
  stopServer = shutdown;
  const window = new BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 420,
    minHeight: 500,
    show: !smoke,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const local = new URL(appUrl).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== local) event.preventDefault();
  });
  await window.loadURL(appUrl);
  if (smoke) {
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
}

function closeApp() {
  if (quitting) return;
  quitting = true;
  Promise.resolve(stopServer?.()).then(() => app.exit(0), () => app.exit(1));
}
