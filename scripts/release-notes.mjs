import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const platforms = ['windows-x64', 'mac-arm64', 'mac-x64'];
const noticeStart = '<!-- installer-security-notice:start -->';
const noticeEnd = '<!-- installer-security-notice:end -->';
const defaultNotes = 'Windows x64 · macOS Apple Silicon · macOS Intel.\n';

export function renderReleaseNotes(notes, checks) {
  for (const platform of platforms) {
    if (!['verified', 'unverified'].includes(checks[platform])) {
      throw new Error('Missing or invalid installer security result for ' + platform);
    }
  }

  const start = notes.indexOf(noticeStart);
  const end = notes.indexOf(noticeEnd);
  if (start !== -1 || end !== -1) {
    if (start === -1 || end < start
        || notes.includes(noticeStart, start + noticeStart.length)
        || notes.includes(noticeEnd, end + noticeEnd.length)) {
      throw new Error('Malformed installer security notice in existing release notes');
    }
    notes = notes.slice(0, start) + notes.slice(end + noticeEnd.length).replace(/^(?:\r?\n){1,2}/, '');
  }

  const warnings = [];
  if (checks['windows-x64'] === 'unverified') {
    warnings.push('- **Windows** · 설치 파일의 게시자 서명이 확인되지 않아 Microsoft Defender SmartScreen이 경고할 수 있습니다.');
  }

  const macs = [];
  if (checks['mac-arm64'] === 'unverified') macs.push('Apple Silicon');
  if (checks['mac-x64'] === 'unverified') macs.push('Intel');
  if (macs.length) {
    warnings.push('- **macOS (' + macs.join(', ') + ')** · 앱의 Developer ID 서명 또는 Apple 공증 티켓이 확인되지 않아 Gatekeeper가 경고하거나 실행을 차단할 수 있습니다.');
  }

  if (!warnings.length) return notes;
  return [
    noticeStart,
    '',
    '### 첫 실행 시 보안 경고',
    '',
    ...warnings,
    '',
    noticeEnd,
    '',
    notes,
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [checksDirectory, existingNotes] = process.argv.slice(2);
  if (!checksDirectory) throw new Error('An installer artifact directory is required');
  const checks = await Promise.all(platforms.map(async platform => [
    platform,
    (await readFile(join(checksDirectory, 'signing-status-' + platform + '.txt'), 'utf8')).trim(),
  ]));
  const notes = existingNotes ? await readFile(existingNotes, 'utf8') : defaultNotes;
  process.stdout.write(renderReleaseNotes(notes, Object.fromEntries(checks)));
}
