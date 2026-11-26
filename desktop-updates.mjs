import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, shell, Tray } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLatestUpdate, monitorUpdates } from './updates.mjs';

export const appId = 'com.thisisjoe.talkcloudcleaner';
export const loginArgument = '--login-update-check';
const title = '톡클라우드 중복 정리';

export async function startDesktopUpdates({ openApp, iconPath }) {
  const windows = process.platform === 'win32';
  if (!app.isPackaged || (!windows && process.platform !== 'darwin')) return;
  const loginOptions = windows ? { args: [loginArgument] } : {};
  const startedAtLogin = windows ? process.argv.includes(loginArgument) : app.getLoginItemSettings().wasOpenedAtLogin;
  const userData = app.getPath('userData');
  const marker = join(userData, 'update-login-configured');
  const tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: windows ? 20 : 18 }));
  tray.setToolTip(title);
  if (windows) tray.on('click', openApp);

  const loginEnabled = () => {
    const state = app.getLoginItemSettings(loginOptions);
    return state.openAtLogin && (!windows || state.executableWillLaunchAtLogin);
  };

  async function setLoginEnabled(value) {
    await mkdir(userData, { recursive: true });
    app.setLoginItemSettings({ ...loginOptions, openAtLogin: value });
    await writeFile(marker, '');
  }

  function refreshMenu() {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '앱 열기', click: openApp },
      {
        label: '로그인할 때 업데이트 확인',
        type: 'checkbox',
        checked: loginEnabled(),
        async click(item) {
          try {
            await setLoginEnabled(item.checked);
            if (item.checked !== loginEnabled()) {
              await dialog.showMessageBox({
                message: '시스템 설정에서 로그인 시 실행을 확인해 주세요.',
                detail: windows ? '설정의 시작 앱에서 TalkCloudCleaner를 확인하세요.'
                  : '시스템 설정의 로그인 항목에서 TalkCloudCleaner를 추가하거나 허용하세요.',
              });
            }
          } catch (error) {
            dialog.showErrorBox('로그인 시 실행 설정 오류', error.message);
          } finally {
            if (!tray.isDestroyed()) refreshMenu();
          }
        },
      },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]));
  }

  try {
    await readFile(marker);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await setLoginEnabled(true);
      } catch (failure) {
        console.warn('Login update check could not be enabled:', failure.message);
      }
    }
  }
  try {
    refreshMenu();
  } catch (error) {
    tray.destroy();
    throw error;
  }

  let stopped = false;
  let notification;
  const openRelease = update => shell.openExternal(update.url).catch(error => {
    if (!stopped) dialog.showErrorBox('릴리스 페이지 열기 실패', error.message);
  });

  async function showUpdate(update) {
    if (stopped) return;
    const options = {
      type: 'info',
      title,
      message: '새 버전 v' + update.version + '을 설치할 수 있습니다.',
      detail: '공식 GitHub 릴리스에서 설치 파일을 받으세요.',
      buttons: ['릴리스 열기', '나중에'],
      defaultId: 0,
      cancelId: 1,
    };
    const window = BrowserWindow.getFocusedWindow();
    const result = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    if (!stopped && result.response === 0) await openRelease(update);
  }

  function notify(update, firstSuccess) {
    const announceInWindow = () => {
      void showUpdate(update).catch(error => console.warn('Update dialog failed:', error.message));
    };
    if ((firstSuccess && startedAtLogin) || !Notification.isSupported()) {
      announceInWindow();
      return;
    }
    try {
      notification = new Notification({
        title: title + ' 업데이트',
        body: '새 버전 v' + update.version + '을 설치할 수 있습니다.',
      });
      notification.once('click', () => void openRelease(update));
      notification.once('failed', announceInWindow);
      notification.show();
    } catch {
      announceInWindow();
    }
  }

  const monitor = monitorUpdates({
    check: () => getLatestUpdate({ current: app.getVersion(), platform: process.platform, arch: process.arch }),
    notify,
  });
  powerMonitor.on('resume', monitor.checkNow);
  void monitor.checkNow();

  return {
    startedAtLogin,
    stop() {
      stopped = true;
      monitor.stop();
      powerMonitor.off('resume', monitor.checkNow);
      notification?.close();
      tray.destroy();
    },
  };
}
