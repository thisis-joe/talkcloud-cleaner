const el = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('desktop-key');
if (token) sessionStorage.setItem('desktop-key', token);
history.replaceState(null, '', '/');

let model;
let actionPending = false;
let failure = '';
let ticking = false;

async function request(path, body) {
  const headers = { Authorization: 'Bearer ' + token };
  const options = { headers };
  if (body) {
    options.method = 'POST';
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function syncSelect(select, choices, empty) {
  const before = select.value;
  const next = JSON.stringify(choices);
  if (select.dataset.choices === next) return;
  select.dataset.choices = next;
  select.replaceChildren(...(choices.length
    ? choices.map(([key, name]) => new Option(name, key))
    : [new Option(empty, '')]));
  if (choices.some(([key]) => key === before)) select.value = before;
}

function list(id, values) {
  el(id).replaceChildren(...values.map(value => {
    const item = document.createElement('li');
    item.textContent = value;
    return item;
  }));
}

function render() {
  if (!model) {
    el('status').textContent = failure;
    return;
  }
  syncSelect(el('network'), model.addresses.map(ip => [ip, ip]), 'Wi-Fi 주소 없음');
  syncSelect(el('device'), model.devices.map(d => [
    d.id, d.name + ' · ' + d.count + '개 · ' + new Date(d.received).toLocaleTimeString('ko-KR'),
  ]), '연결된 기기 없음');
  el('pairing').hidden = !model.pair;
  if (model.pair && el('pair-url').href !== model.pair.url) {
    el('pair-url').href = model.pair.url;
    el('qr').src = model.pair.qr;
  }
  const busy = model.busy || actionPending;
  el('pair').disabled = busy || !el('network').value;
  el('open').disabled = busy;
  el('scan').disabled = busy || !el('device').value;
  el('trash').disabled = busy;
  el('status').textContent = failure || model.status.message;
  el('review').hidden = !model.plan;
  if (model.plan) {
    const { device, names, checked, skipped, capped } = model.plan;
    el('summary').textContent = device + ' 기준으로 ' + checked + '개를 확인해 ' + names.length
      + '개가 일치했습니다.' + (capped ? ' 설정한 비교 개수까지 확인했습니다.' : '');
    list('matches', names);
    list('skipped-list', skipped);
    el('skipped').hidden = !skipped.length;
    el('trash').hidden = !names.length;
  }
  const result = model.status.result;
  el('outcome').hidden = !result;
  if (result) {
    el('outcome-summary').textContent = '이동 확인 ' + result.moved.length + '개 · 제외 '
      + result.excluded.length + '개' + (result.error ? ' · ' + result.error.split('\n')[0] : '');
    list('uncertain', (result.uncertain || []).map(name => '상태 확인 필요 · ' + name));
  }
}

async function poll() {
  if (ticking) return;
  ticking = true;
  try {
    model = await request('/state');
    render();
  } catch (error) {
    el('status').textContent = error.message;
  } finally {
    ticking = false;
  }
}

async function launch(path, body) {
  if (actionPending) return;
  actionPending = true;
  failure = '';
  render();
  try {
    await request(path, body);
  } catch (error) {
    failure = error.message;
  } finally {
    actionPending = false;
    await poll();
    render();
  }
}

el('pair').onclick = () => launch('/pair', { host: el('network').value });
el('end-pair').onclick = () => launch('/cancel-pair', {});
el('open').onclick = () => launch('/open', {});
el('scan').onclick = () => launch('/scan', { device: el('device').value, limit: el('limit').value });
el('trash').onclick = () => {
  const plan = model?.plan;
  if (plan?.names.length && confirm(plan.device + '에 있는 것과 내용이 일치한 클라우드 파일 '
      + plan.names.length + '개를 휴지통으로 옮길까요?\n이동한 파일의 공유 및 중요 표시가 해제될 수 있습니다.')) {
    launch('/trash', { plan: plan.id });
  }
};
await poll();
setInterval(poll, 1200);
