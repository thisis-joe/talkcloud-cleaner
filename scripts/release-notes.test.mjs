import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReleaseNotes } from './release-notes.mjs';

const verified = {
  'windows-x64': 'verified',
  'mac-arm64': 'verified',
  'mac-x64': 'verified',
};
const existing = '기존 릴리스 설명\n\n- 변경 사항\n';

test('미확인 설치 파일을 운영체제별로 릴리스 설명 맨 위에 표시한다', () => {
  const body = renderReleaseNotes(existing, {
    ...verified,
    'windows-x64': 'unverified',
    'mac-x64': 'unverified',
  });

  assert.match(body, /첫 실행 시 보안 경고[\s\S]*SmartScreen[\s\S]*macOS \(Intel\)[\s\S]*Gatekeeper/u);
  assert.doesNotMatch(body, /Apple Silicon/u);
  assert.ok(body.indexOf('첫 실행 시 보안 경고') < body.indexOf('기존 릴리스 설명'));
  assert.ok(body.endsWith(existing));
});

test('모든 플랫폼이 확인되면 기존 설명에서 자동 경고를 제거한다', () => {
  const checks = { ...verified, 'mac-arm64': 'unverified' };
  const body = renderReleaseNotes(existing, checks);
  assert.match(body, /macOS \(Apple Silicon\)/u);
  assert.doesNotMatch(body, /SmartScreen/u);
  assert.equal(renderReleaseNotes(body, checks), body);
  assert.equal(renderReleaseNotes(body, verified), existing);
  assert.equal(renderReleaseNotes(existing, verified), existing);
});

test('서명 검증 결과가 누락되었거나 유효하지 않으면 릴리스 설명 생성을 중단한다', () => {
  assert.throws(() => renderReleaseNotes(existing, { 'windows-x64': 'verified' }), /mac-arm64/);
  assert.throws(() => renderReleaseNotes(existing, { ...verified, 'windows-x64': '' }), /windows-x64/);
});
