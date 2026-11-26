import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { deviceFingerprints } from './match.mjs';
import { CLOUD, TalkCloud } from './talkcloud.mjs';
import { connectAndroidUsb } from './usb.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const auth = randomBytes(32).toString('hex');
const devices = new Map();
let status = { message: '' };
let pairing;
let pairingSetup;
let browser;
let cloudPage;
let plan;
let busy = false;
let stopping = false;

const dataHome = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || homedir())
  : join(homedir(), 'Library', 'Application Support');
const profile = process.env.TALKCLOUD_APP_PROFILE || join(dataHome, 'TalkCloudCleaner', 'Browser');

function privateInterfaces() {
  const addresses = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal);
  return Array.from(new Set(addresses.map(x => x.address)
    .filter(address => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address))));
}

function reply(res, statusCode, data, type = 'application/json; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function jsonBody(req, maxBytes) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('JSON 요청만 지원합니다.');
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw new Error('요청 데이터가 너무 큽니다.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve('http://' + host + ':' + server.address().port);
    });
  });
}

async function closePairing(session = pairing) {
  if (!session || session !== pairing) return;
  pairing = undefined;
  session.used = true;
  clearTimeout(session.timer);
  session.server.close();
  await session.usb?.close();
}

const mobileAssets = new Map([
  ['/pair.html', ['public/pair.html', 'text/html; charset=utf-8']],
  ['/phone.mjs', ['public/phone.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ...['sha2.js', '_md.js', 'utils.js', '_u64.js'].map(name =>
    ['/hash/' + name, ['node_modules/@noble/hashes/' + name, 'text/javascript; charset=utf-8']]),
]);

async function serveAsset(res, entry) {
  if (!entry) return reply(res, 404, { error: '페이지가 없습니다.' });
  return reply(res, 200, await readFile(join(root, entry[0])), entry[1]);
}

async function startPairing(method, host) {
  if (pairingSetup || stopping) throw new Error('연결 준비가 끝날 때까지 기다려 주세요.');
  if (method !== 'wifi' && method !== 'usb') throw new Error('연결 방식을 선택해 주세요.');
  if (method === 'wifi' && !privateInterfaces().includes(host)) {
    throw new Error('PC의 Wi-Fi 주소를 선택해 주세요.');
  }
  pairingSetup = preparePairing(method, host);
  try {
    await pairingSetup;
  } finally {
    pairingSetup = undefined;
  }
}

async function preparePairing(method, host) {
  await closePairing();
  const token = randomBytes(32).toString('hex');
  const registration = { expires: Date.now() + 20 * 60_000, used: false, origin: '' };
  registration.server = createServer(async (req, res) => {
    try {
      if (!registration.origin || req.headers.host !== new URL(registration.origin).host) {
        return reply(res, 403, { error: '페어링 주소가 일치하지 않습니다.' });
      }
      if (req.method === 'GET') return await serveAsset(res, mobileAssets.get(req.url));
      if (req.method !== 'POST' || req.url !== '/submit' || req.headers.origin !== registration.origin
          || req.headers.authorization !== 'Bearer ' + token
          || registration.used || Date.now() > registration.expires) {
        return reply(res, 403, { error: '연결이 만료되었습니다. PC에서 다시 연결해 주세요.' });
      }
      const data = await jsonBody(req, 6_000_000);
      if (registration.used || Date.now() > registration.expires) throw new Error('연결이 만료되었습니다.');
      const name = typeof data.name === 'string' && data.name.trim().slice(0, 48);
      if (!name) throw new Error('기기 이름을 입력해 주세요.');
      const keys = deviceFingerprints(data.entries);
      const id = randomBytes(12).toString('hex');
      registration.used = true;
      devices.set(id, {
        id, name, method, keys, salt: token, sizes: new Set(data.entries.map(entry => entry.size)), received: Date.now(),
      });
      while (devices.size > 10) devices.delete(devices.keys().next().value);
      reply(res, 200, { count: keys.size });
      void closePairing(registration);
    } catch (error) {
      if (!res.headersSent) reply(res, 400, { error: error.message });
    }
  });
  pairing = registration;
  try {
    const local = await listen(registration.server, method === 'usb' ? '127.0.0.1' : host);
    if (method === 'usb') registration.usb = await connectAndroidUsb(local);
    if (stopping) throw new Error('앱을 닫는 중입니다.');
    registration.origin = registration.usb?.origin || local;
    const url = registration.origin + '/pair.html#' + token;
    const qr = method === 'wifi' ? await QRCode.toDataURL(url, { width: 224, margin: 2 }) : undefined;
    await registration.usb?.open(url);
    if (pairing === registration) {
      registration.presentation = { method, url, qr };
      registration.timer = setTimeout(() => void closePairing(registration), registration.expires - Date.now());
    }
  } catch (error) {
    await closePairing(registration);
    throw error;
  }
}

async function openCloud() {
  if (cloudPage && !cloudPage.isClosed()) {
    await cloudPage.bringToFront();
    return;
  }
  if (!browser) {
    await mkdir(profile, { recursive: true });
    browser = await chromium.launchPersistentContext(profile, {
      ...(process.env.TALKCLOUD_BUNDLED_BROWSER === '1' ? {} : { channel: 'chrome' }),
      headless: false,
      acceptDownloads: true,
      chromiumSandbox: true,
    });
    browser.on('close', () => { browser = undefined; cloudPage = undefined; plan = undefined; });
  }
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(CLOUD + '/product/DRIVE', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  plan = undefined;
  cloudPage = page;
}

const progress = message => { status = { ...status, message }; };

function run(job) {
  if (busy) throw new Error('진행 중인 작업을 기다려 주세요.');
  busy = true;
  status = { message: '시작 중…' };
  Promise.resolve().then(job).catch(error => {
    status = { message: error.message.split('\n')[0], error: true };
  }).finally(() => { busy = false; });
}

function state() {
  return {
    busy, status, pair: pairing?.presentation, addresses: privateInterfaces(),
    cloudOpen: Boolean(cloudPage && !cloudPage.isClosed()),
    devices: Array.from(devices.values())
      .filter(device => Date.now() - device.received <= 2 * 60 * 60_000)
      .map(({ id, name, method, keys, received }) => ({ id, name, method, count: keys.size, received })),
    plan: plan ? {
      id: plan.id, deviceId: plan.device.id, device: plan.device.name, names: plan.result.matches.map(item => item.name),
      checked: plan.result.checked, skipped: plan.result.skipped, capped: plan.result.capped,
    } : null,
  };
}

const desktopAssets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/desktop.mjs', ['public/desktop.mjs', 'text/javascript; charset=utf-8']],
  ['/desktop.css', ['public/desktop.css', 'text/css; charset=utf-8']],
  ['/icon.png', ['build/icon.png', 'image/png']],
]);

let origin;
const desktop = createServer(async (req, res) => {
  try {
    if (!origin || req.headers.host !== new URL(origin).host) return reply(res, 403, { error: '잘못된 주소입니다.' });
    if (req.method === 'GET' && desktopAssets.has(req.url)) return await serveAsset(res, desktopAssets.get(req.url));
    if (req.headers.authorization !== 'Bearer ' + auth) return reply(res, 403, { error: '앱에 표시된 주소를 다시 열어 주세요.' });
    if (req.method === 'GET' && req.url === '/state') return reply(res, 200, state());
    if (req.method !== 'POST' || req.headers.origin !== origin) return reply(res, 403, { error: '잘못된 요청입니다.' });
    const input = await jsonBody(req, 4096);
    switch (req.url) {
      case '/pair':
        await startPairing(input.method ?? 'wifi', input.host);
        break;
      case '/cancel-pair':
        if (pairingSetup) throw new Error('연결 준비가 끝날 때까지 기다려 주세요.');
        await closePairing();
        break;
      case '/open':
        run(async () => {
          await openCloud();
          progress('톡클라우드에서 비교할 폴더나 목록을 열어 주세요.');
        });
        break;
      case '/scan': {
        const device = devices.get(input.device);
        if (!device || Date.now() - device.received > 2 * 60 * 60_000) throw new Error('기기 파일을 다시 확인해 주세요.');
        if (!cloudPage || cloudPage.isClosed()) throw new Error('톡클라우드 창을 먼저 열어 주세요.');
        const limit = Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('비교 개수는 1~1,000개로 지정해 주세요.');
        run(async () => {
          plan = undefined;
          const cloud = new TalkCloud(cloudPage, { onProgress: progress });
          const result = await cloud.scan(device, limit);
          plan = { id: randomBytes(16).toString('hex'), result, device };
          progress('비교 완료');
        });
        break;
      }
      case '/trash': {
        if (!plan || plan.id !== input.plan || !plan.result.matches.length) throw new Error('비교 결과를 다시 확인해 주세요.');
        if (!cloudPage || cloudPage.isClosed()) throw new Error('톡클라우드 창을 열고 다시 비교해 주세요.');
        if (Date.now() - plan.device.received > 2 * 60 * 60_000) throw new Error('기기 파일을 다시 확인해 주세요.');
        run(async () => {
          const current = plan;
          plan = undefined;
          const cloud = new TalkCloud(cloudPage, { onProgress: progress });
          const result = await cloud.trash(current.result, current.device);
          status = { message: result.error ? '이동을 중단했습니다.' : '휴지통 이동 완료', result };
        });
        break;
      }
      default:
        return reply(res, 404, { error: '올바르지 않은 경로입니다.' });
    }
    reply(res, 200, { ok: true });
  } catch (error) {
    if (!res.headersSent) reply(res, 400, { error: error.message.split('\n')[0] });
  }
});

origin = await listen(desktop, '127.0.0.1');
export const appUrl = origin + '/#' + auth;
if (process.env.TALKCLOUD_ELECTRON !== '1') console.log('톡클라우드 중복 정리: ' + appUrl);
if (process.env.TALKCLOUD_NO_OPEN !== '1') {
  const opener = process.platform === 'win32' ? 'explorer.exe' : 'open';
  spawn(opener, [appUrl], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
}

export async function shutdown() {
  if (stopping) return;
  stopping = true;
  desktop.close();
  await pairingSetup?.catch(() => {});
  await closePairing();
  await browser?.close().catch(() => {});
}
if (process.env.TALKCLOUD_ELECTRON !== '1') {
  const stop = () => shutdown().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
