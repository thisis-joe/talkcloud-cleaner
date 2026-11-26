import { sha256 } from '/hash/sha2.js';

const el = id => document.getElementById(id);
const token = location.hash.slice(1);
const files = [];
const fileInput = el('files');
const folderInput = el('folder');
const send = el('send');
const reset = el('reset');
const name = el('device-name');
const status = el('phone-status');
const ua = navigator.userAgent;
name.value = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? '안드로이드 폰' : '안드로이드 태블릿')
    : /Windows/.test(ua) ? 'Windows PC' : /Macintosh/.test(ua) ? 'Mac' : '이 기기';
if (!('webkitdirectory' in folderInput)) el('folder-choice').hidden = true;
if (!/^[a-f0-9]{64}$/.test(token)) status.textContent = 'PC에서 연결 코드를 다시 열어 주세요.';

function update() {
  el('picked').textContent = files.length ? files.length + '개 선택됨' : '선택된 파일 없음';
  reset.disabled = !files.length;
  send.disabled = !files.length || !/^[a-f0-9]{64}$/.test(token);
}

for (const input of [fileInput, folderInput]) {
  input.addEventListener('change', () => {
    if (input.files.length + files.length > 50_000) {
      status.textContent = '한 번에 최대 50,000개를 비교할 수 있습니다.';
    } else {
      for (const file of input.files) files.push(file);
      status.textContent = '';
    }
    input.value = '';
    update();
  });
}

reset.onclick = () => { files.length = 0; status.textContent = ''; update(); };
send.onclick = async () => {
  if (!name.value.trim()) return name.reportValidity();
  for (const input of [fileInput, folderInput, name, reset, send]) input.disabled = true;
  try {
    const entries = [];
    const start = new TextEncoder().encode(token + ':');
    let unavailable = 0;
    for (const [index, file] of files.entries()) {
      status.textContent = (index + 1) + '/' + files.length + '개 파일 읽는 중…';
      const digest = sha256.create().update(start);
      try {
        const reader = file.stream().getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            digest.update(value);
          }
        } finally {
          reader.releaseLock();
        }
        const hash = Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
        entries.push({ hash, size: file.size });
      } catch {
        unavailable++;
      }
    }
    if (!entries.length) throw new Error('읽을 수 있는 파일이 없습니다.');
    const response = await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ name: name.value.trim(), entries }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    files.length = 0;
    status.textContent = '전송 완료 · 고유 파일 ' + result.count + '개'
      + (unavailable ? ' · 읽지 못한 파일 ' + unavailable + '개' : '') + '. PC에서 비교를 시작하세요.';
  } catch (error) {
    status.textContent = error.message;
    for (const input of [fileInput, folderInput, name, reset, send]) input.disabled = false;
  }
  update();
};
