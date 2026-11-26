import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAndroidUsb } from './usb.mjs';

test('USB로 선택한 Android에만 포트를 연결하고 앱이 만든 연결만 닫는다', async () => {
  const commands = [];
  const connection = await connectAndroidUsb('http://127.0.0.1:42750', async args => {
    commands.push(args);
    if (args[1] === 'get-serialno') return 'Android123\r\n';
    if (args[2] === 'reverse' && args[3] === 'tcp:0') return '43180\n';
    return '';
  });
  const phoneUrl = connection.origin + '/pair.html#' + 'a'.repeat(64);
  await connection.open(phoneUrl);
  await connection.close();
  assert.equal(connection.origin, 'http://127.0.0.1:43180');
  assert.deepEqual(commands, [
    ['-d', 'get-serialno'],
    ['-s', 'Android123', 'reverse', 'tcp:0', 'tcp:42750'],
    ['-s', 'Android123', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', phoneUrl],
    ['-s', 'Android123', 'reverse', '--remove', 'tcp:43180'],
  ]);
});

test('USB 디버깅 승인이 없으면 연결하지 않고 승인 방법을 표시한다', async () => {
  await assert.rejects(connectAndroidUsb('http://127.0.0.1:42750', async args => {
    assert.deepEqual(args, ['-d', 'get-serialno']);
    throw Object.assign(new Error('adb failed'), { stderr: 'adb: device unauthorized' });
  }), /USB 디버깅을 허용/);
});
