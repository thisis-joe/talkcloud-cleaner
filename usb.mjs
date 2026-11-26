import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

export const PLATFORM_TOOLS_URL = 'https://developer.android.com/tools/releases/platform-tools';
const exec = promisify(execFile);

async function adbExecutable() {
  const home = homedir();
  const sdkPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    join(home, 'Library', 'Android', 'sdk'),
  ];
  const locations = [
    ...sdkPaths.filter(Boolean).map(sdk => join(sdk, 'platform-tools')),
    join(home, 'platform-tools'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH || '').split(delimiter).map(path => path.replace(/^"|"$/g, '')),
  ];
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const path of new Set(locations.filter(isAbsolute))) {
    const candidate = join(path, executable);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('PC에 Android Platform-Tools를 설치해 주세요.');
}

export async function connectAndroidUsb(localOrigin, run) {
  if (!run) {
    const adb = await adbExecutable();
    const env = { ...process.env };
    for (const key of ['ADB_SERVER_SOCKET', 'ADB_SERVER_PORT', 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT']) {
      delete env[key];
    }
    run = async args => (await exec(adb, args, { env, timeout: 8000, windowsHide: true })).stdout;
  }
  const localPort = new URL(localOrigin).port;
  try {
    const serial = (await run(['-d', 'get-serialno'])).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(serial) || serial === 'unknown') {
      throw new Error('USB로 연결된 Android를 확인해 주세요.');
    }
    const device = ['-s', serial];
    const phonePort = (await run([...device, 'reverse', 'tcp:0', 'tcp:' + localPort])).trim();
    if (!/^\d{1,5}$/.test(phonePort) || Number(phonePort) < 1 || Number(phonePort) > 65535) {
      throw new Error('USB 연결을 열지 못했습니다. 최신 Android Platform-Tools로 다시 시도하세요.');
    }
    return {
      origin: 'http://127.0.0.1:' + phonePort,
      async open(url) {
        const result = await run([...device, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url])
          .catch(() => { throw new Error('Android에서 브라우저를 열 수 없습니다.'); });
        if (/^Error:/mi.test(result)) throw new Error('Android에서 브라우저를 열 수 없습니다.');
      },
      async close() {
        await run([...device, 'reverse', '--remove', 'tcp:' + phonePort]).catch(() => {});
      },
    };
  } catch (error) {
    const detail = error.stderr || '';
    if (/unauthorized/i.test(detail)) throw new Error('휴대폰의 잠금을 해제하고 USB 디버깅을 허용해 주세요.');
    if (/more than one/i.test(detail)) throw new Error('비교할 Android 한 대만 USB로 연결해 주세요.');
    if (/no devices|no usb|not found|offline/i.test(detail)) {
      throw new Error('USB 데이터 케이블과 휴대폰의 USB 디버깅 설정을 확인해 주세요.');
    }
    if (error.stderr !== undefined || error.killed) throw new Error('USB 연결을 열지 못했습니다. 연결 상태를 확인해 주세요.');
    throw error;
  }
}
