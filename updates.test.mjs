import test from 'node:test';
import assert from 'node:assert/strict';
import { findUpdate, getLatestUpdate, monitorUpdates } from './updates.mjs';

const installers = [
  { name: 'TalkCloudCleaner-0.10.0-windows-x64.exe', state: 'uploaded' },
  { name: 'TalkCloudCleaner-0.10.0-mac-arm64.dmg', state: 'uploaded' },
];
const release = {
  tag_name: 'v0.10.0', draft: false, prerelease: false, assets: installers,
  html_url: 'https://example.com/untrusted',
};

test('현재 버전보다 최신이고 이 기기용 설치 파일이 있는 정식 릴리스만 표시한다', () => {
  const options = { current: '0.9.0', platform: 'win32', arch: 'x64' };
  assert.deepEqual(findUpdate(release, options), {
    version: '0.10.0', url: 'https://github.com/thisis-joe/talkcloud-cleaner/releases/tag/v0.10.0',
  });
  assert.equal(findUpdate(release, { ...options, current: '0.10.0' }), null);
  assert.equal(findUpdate(release, { ...options, current: '1.0.0' }), null);
  assert.equal(findUpdate(release, { ...options, platform: 'darwin' }), null);
  assert.equal(findUpdate(release, { ...options, platform: 'darwin', arch: 'arm64' })?.version, '0.10.0');
  assert.equal(findUpdate({ ...release, draft: true }, options), null);
  assert.equal(findUpdate({ ...release, prerelease: true }, options), null);
  assert.equal(findUpdate({ ...release, tag_name: 'v0.10.0/extra' }, options), null);
  assert.equal(findUpdate({ ...release, assets: [{ ...installers[0], state: 'new' }] }, options), null);
});

test('공개 GitHub API만 조회하고 임시 오류를 상위 확인 루프로 전달한다', async () => {
  const options = { current: '0.2.1', platform: 'win32', arch: 'x64' };
  const result = await getLatestUpdate(options, async (url, init) => {
    assert.equal(url, 'https://api.github.com/repos/thisis-joe/talkcloud-cleaner/releases/latest');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json(release);
  });
  assert.equal(result.version, '0.10.0');
  assert.equal(await getLatestUpdate(options, async () => new Response(null, { status: 404 })), null);
  await assert.rejects(getLatestUpdate(options, async () => new Response(null, { status: 503 })), /503/);
});

test('부팅 직후 오프라인이어도 재시도하고 같은 세션에서 같은 버전을 한 번만 알린다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const found = { version: '0.10.0' };
  const notices = [];
  let checks = 0;
  const monitor = monitorUpdates({
    async check() {
      if (++checks === 1) throw new Error('offline');
      return found;
    },
    notify: (update, firstSuccess) => notices.push([update.version, firstSuccess]),
  });
  t.after(() => monitor.stop());
  await monitor.checkNow();
  assert.equal(checks, 1);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(checks, 2);
  assert.strictEqual(monitor.checkNow(), monitor.checkNow());
  await monitor.checkNow();
  assert.deepEqual(notices, [['0.10.0', true]]);
  await monitor.checkNow();
  assert.equal(notices.length, 1);
  monitor.stop();
  t.mock.timers.tick(60 * 60_000);
  assert.equal(checks, 3);
});

test('로그인 때 최신 버전이면 이후 릴리스의 알림은 일반 실행 중 알림이다', async t => {
  const notices = [];
  let result = null;
  const monitor = monitorUpdates({
    check: async () => result,
    notify: (update, firstSuccess) => notices.push([update.version, firstSuccess]),
  });
  t.after(() => monitor.stop());
  await monitor.checkNow();
  result = { version: '0.10.0' };
  await monitor.checkNow();
  assert.deepEqual(notices, [['0.10.0', false]]);
});

test('앱이 종료된 뒤에는 진행 중이던 확인 결과를 표시하지 않는다', async () => {
  const { promise, resolve } = Promise.withResolvers();
  const monitor = monitorUpdates({
    check: () => promise,
    notify: () => assert.fail('종료 후 알림이 표시되었습니다.'),
  });
  const pending = monitor.checkNow();
  monitor.stop();
  resolve({ version: '0.10.0' });
  await pending;
});
