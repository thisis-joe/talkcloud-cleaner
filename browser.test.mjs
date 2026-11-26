import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { TalkCloud } from './talkcloud.mjs';
import { deviceFingerprints } from './match.mjs';

function localAddress(server) {
  return 'http://127.0.0.1:' + server.address().port;
}

const names = ['a.txt', 'b.txt', 'c.txt'];
const originals = ['stable-a', 'stable-b', 'stable-c'];
const ids = names.map((_, i) => (i + 1).toString().padStart(24, '0'));
const content = (name, body) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });

test('휴대폰 브라우저의 지문으로 Drive에서 정확히 두 행을 휴지통으로 이동한다', { timeout: 60_000 }, async t => {
  const chrome = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => chrome.close());
  const child = spawn(process.execPath, ['app.mjs'], {
    env: { ...process.env, TALKCLOUD_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  const address = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(data.toString().match(/http:\/\/\S+/)?.[0]));
    child.once('error', reject);
    child.once('exit', code => reject(new Error('앱 서버 시작 실패 ' + code)));
  });
  assert.ok(address);
  const desktop = await chrome.newPage();
  await desktop.goto(address);
  await desktop.getByRole('heading', { name: '톡클라우드 중복 정리' }).waitFor();
  const desktopUrl = new URL(address);
  const headers = { Authorization: 'Bearer ' + desktopUrl.hash.slice(1) };
  const response = await fetch(desktopUrl.origin + '/state', { headers });
  const initial = await response.json();
  assert.deepEqual(initial.devices, []);
  assert.equal((await fetch(desktopUrl.origin + '/state')).status, 403);
  assert.ok(initial.addresses.length, '테스트에 사설 IPv4 인터페이스가 필요합니다.');
  await desktop.getByRole('button', { name: '연결 코드 만들기' }).click();
  const pairLink = desktop.getByRole('link', { name: '연결 주소' });
  await pairLink.waitFor();
  const pairUrl = await pairLink.getAttribute('href');
  const salt = new URL(pairUrl).hash.slice(1);
  const phone = await chrome.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto(pairUrl);
  await phone.getByRole('textbox', { name: '기기 이름' }).fill('테스트 휴대폰');
  const phoneFiles = [content('renamed-a.txt', originals[0]), content('b.txt', originals[1]), content('c.txt', 'changed-c')];
  await phone.locator('#files').setInputFiles(phoneFiles);
  const send = phone.waitForRequest(req => req.url().endsWith('/submit') && req.method() === 'POST');
  await phone.getByRole('button', { name: '지문 보내기' }).click();
  await phone.getByText(/전송 완료 · 고유 파일 3개/).waitFor();
  await desktop.locator('#device option').filter({ hasText: '테스트 휴대폰' }).waitFor({ state: 'attached' });

  const submitted = (await send).postDataJSON();
  assert.deepEqual(submitted.entries, phoneFiles.map(({ buffer }) => ({
    hash: createHash('sha256').update(salt + ':').update(buffer).digest('hex'), size: buffer.length,
  })));
  assert.deepEqual(Object.keys(submitted.entries[0]).sort(), ['hash', 'size']);

  const fixture = createServer((req, res) => {
    const i = names.indexOf(req.url.slice(1));
    if (i >= 0) {
      res.writeHead(200, { 'Content-Disposition': 'attachment; filename="' + names[i] + '"' });
      return res.end(originals[i]);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><main><div class="scroll_table" style="height:300px;overflow:auto"><ul class="list_table">'
      + names.map((name, index) => '<li data-target="drive" data-name="' + name + '"><input class="inp_check" type="checkbox" id="'
          + ids[index] + '"><div class="link_item"><span class="txt_tit">' + name + '</span></div></li>').join('')
      + '</ul></div><div id="actions"></div><div id="confirm"></div><output id="trash"></output></main>'
      + '<script>(' + fakeTalkCloud.toString() + ')()</script>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => fixture.close());
  const cloudPage = await chrome.newPage({ acceptDownloads: true });
  await cloudPage.goto(localAddress(fixture) + '/drive/all');
  const cloud = new TalkCloud(cloudPage, { origin: localAddress(fixture) });
  const device = {
    salt, keys: deviceFingerprints(submitted.entries), sizes: new Set(submitted.entries.map(x => x.size)),
  };
  const plan = await cloud.scan(device, 3);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.matches.map(x => x.name), ['a.txt', 'b.txt']);
  const result = await cloud.trash(plan, device);
  assert.deepEqual(result, { moved: ['a.txt', 'b.txt'], excluded: [] });
  assert.equal(await cloudPage.locator('#trash').innerText(), 'a.txt,b.txt');
  assert.equal(await cloudPage.locator('.txt_tit').innerText(), 'c.txt');

  await cloudPage.reload();
  const secondPlan = await cloud.scan(device, 3);
  const originalB = originals[1];
  try {
    originals[1] = 'changed-b';
    const afterChange = await cloud.trash(secondPlan, device);
    assert.deepEqual(afterChange, { moved: ['a.txt'], excluded: ['b.txt'] });
    assert.deepEqual(await cloudPage.locator('.txt_tit').allTextContents(), ['b.txt', 'c.txt']);
  } finally {
    originals[1] = originalB;
  }
});

function fakeTalkCloud() {
  let selected = [];
  const actions = document.querySelector('#actions');
  const confirm = document.querySelector('#confirm');
  function update() {
    document.querySelectorAll('li').forEach(row => {
      row.querySelector('input').checked = selected.includes(row);
    });
    actions.replaceChildren();
    if (!selected.length) return;
    const cancel = document.createElement('button');
    cancel.textContent = selected.length + ' 개 선택됨 선택 취소';
    cancel.onclick = () => { selected = []; update(); };
    actions.append(cancel);
    if (selected.length === 1) {
      const save = document.createElement('a');
      save.href = '/' + selected[0].dataset.name;
      save.textContent = '저장하기';
      save.onclick = () => setTimeout(() => { selected = []; update(); }, 50);
      actions.append(save);
    }
    const remove = document.createElement('a');
    remove.href = '#remove';
    remove.textContent = '삭제하기';
    remove.onclick = event => {
      event.preventDefault();
      confirm.innerHTML = '<strong>휴지통으로 이동</strong><button>확인</button>';
      confirm.querySelector('button').onclick = () => {
        document.querySelector('#trash').textContent = selected.map(row => row.dataset.name).join(',');
        selected.forEach(row => row.remove());
        confirm.replaceChildren();
        selected = [];
        update();
      };
    };
    actions.append(remove);
  }
  document.querySelectorAll('li').forEach(row => {
    row.oncontextmenu = event => { event.preventDefault(); selected = [row]; update(); };
    row.onclick = event => { selected = event.ctrlKey || event.metaKey ? [...selected, row] : [row]; update(); };
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { selected = []; update(); }
  });
}
