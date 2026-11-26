import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceFingerprints, fingerprintKey } from './match.mjs';

test('기기 이름과 파일 이름 없이 내용과 길이의 일치만 판별한다', () => {
  const a = { hash: 'a'.repeat(64), size: 51 };
  const b = { hash: 'b'.repeat(64), size: 51 };
  const c = { hash: 'c'.repeat(64), size: 51 };
  const result = deviceFingerprints([a, b, b]);
  assert.equal(result.size, 2);
  assert.ok(result.has(fingerprintKey(a)));
  assert.ok(!result.has(fingerprintKey(c)));
  assert.ok(!result.has(fingerprintKey({ ...a, size: 50 })));
});

test('위조된 형식과 빈 목록은 거부한다', () => {
  for (const entries of [[], [{ hash: 'x'.repeat(64), size: 1 }], [{ hash: 'a'.repeat(64), size: -1 }]]) {
    assert.throws(() => deviceFingerprints(entries));
  }
});
