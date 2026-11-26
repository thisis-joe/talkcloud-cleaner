const el = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem('desktop-key');
if (token) sessionStorage.setItem('desktop-key', token);
history.replaceState(null, '', '/');

let model;
let pendingAction = '';
let failure = '';
let stateFailure = '';
let stateRequest;
let method = 'wifi';
let stage = 0;
let newestDevice;
const stagePanels = ['connect-step', 'folder-step', 'compare-step'].map(el);
const steps = [...document.querySelectorAll('.steps li')];

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

function showStage(index) {
  stage = index;
  failure = '';
  stagePanels.forEach((panel, i) => { panel.hidden = i !== index; });
  steps.forEach((step, i) => {
    if (i === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  render();
  stagePanels[index].querySelector('h2').focus();
}

function render() {
  const status = el('status');
  const message = failure || stateFailure || (model?.status.error || model?.busy || stage === 2
    ? model?.status.message : '') || '';
  if (status.textContent !== message) status.textContent = message;
  status.toggleAttribute('data-error', Boolean(failure || stateFailure || model?.status.error));
  if (!model) {
    el('connection-status').textContent = stateFailure ? '앱 상태를 가져오지 못했습니다.' : '준비 중…';
    return;
  }

  const wifi = method === 'wifi';
  el('choose-wifi').setAttribute('aria-pressed', String(wifi));
  el('choose-usb').setAttribute('aria-pressed', String(!wifi));
  el('wifi-panel').hidden = !wifi;
  el('usb-panel').hidden = wifi;

  syncSelect(el('network'), model.addresses.map(ip => [ip, ip]), 'Wi-Fi 주소 없음');
  el('network-choice').hidden = model.addresses.length < 2;
  const devices = [...model.devices].reverse();
  syncSelect(el('device'), devices.map(d => [
    d.id, d.name + ' · ' + d.count + '개 · ' + new Date(d.received).toLocaleTimeString('ko-KR'),
  ]), '연결된 기기 없음');
  if (devices[0]?.id !== newestDevice) {
    newestDevice = devices[0]?.id;
    if (newestDevice) el('device').value = newestDevice;
  }

  const wifiPair = model.pair?.method === 'wifi';
  const usbPair = model.pair?.method === 'usb';
  el('pairing').hidden = !wifiPair;
  el('qr').hidden = !wifiPair;
  el('end-usb').hidden = !usbPair;
  if (wifiPair && el('pair-url').href !== model.pair.url) {
    el('pair-url').href = model.pair.url;
    el('qr').src = model.pair.qr;
  }
  const selected = devices.find(device => device.id === el('device').value);
  let connection = selected ? selected.name + ' · 파일 ' + selected.count + '개 준비됨' : '연결 대기 중';
  if (wifi && !model.addresses.length) connection = 'PC의 Wi-Fi 연결을 확인해 주세요.';
  if ((wifi && wifiPair) || (!wifi && usbPair)) connection = '휴대폰에서 파일을 선택하고 지문을 보내세요.';
  if (pendingAction === '/pair') connection = '연결 준비 중…';
  if (el('connection-status').textContent !== connection) el('connection-status').textContent = connection;

  const busy = model.busy || Boolean(pendingAction);
  el('choose-wifi').disabled = busy;
  el('choose-usb').disabled = busy;
  el('pair').disabled = busy || !el('network').value;
  el('pair-usb').disabled = busy;
  el('end-pair').disabled = busy;
  el('end-usb').disabled = busy;
  el('to-folder').disabled = busy || !selected;
  el('open').disabled = busy;
  el('to-compare').disabled = busy || !model.cloudOpen || !selected;
  el('scan').disabled = busy || !model.cloudOpen || !selected;
  el('back-to-connect').disabled = busy;
  el('back-to-folder').disabled = busy;
  el('trash').disabled = busy || !model.cloudOpen;
  const plan = model.plan?.deviceId === selected?.id ? model.plan : null;
  el('review').hidden = !plan;
  if (plan) {
    const { device, names, checked, skipped, capped } = plan;
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

function poll() {
  if (stateRequest) return stateRequest;
  stateRequest = request('/state').then(state => {
    model = state;
    stateFailure = '';
    render();
  }).catch(error => {
    stateFailure = error.message;
    render();
  }).finally(() => { stateRequest = undefined; });
  return stateRequest;
}

async function launch(path, body) {
  if (pendingAction) return;
  pendingAction = path;
  failure = '';
  render();
  try {
    await request(path, body);
  } catch (error) {
    failure = error.message;
  } finally {
    await stateRequest;
    await poll();
    pendingAction = '';
    render();
  }
}

el('choose-wifi').onclick = () => { method = 'wifi'; failure = ''; render(); };
el('choose-usb').onclick = () => { method = 'usb'; failure = ''; render(); };
el('pair').onclick = () => launch('/pair', { method: 'wifi', host: el('network').value });
el('pair-usb').onclick = () => launch('/pair', { method: 'usb' });
el('end-pair').onclick = () => launch('/cancel-pair', {});
el('end-usb').onclick = () => launch('/cancel-pair', {});
el('to-folder').onclick = () => showStage(1);
el('back-to-connect').onclick = () => showStage(0);
el('to-compare').onclick = () => showStage(2);
el('back-to-folder').onclick = () => showStage(1);
el('open').onclick = () => launch('/open', {});
el('device').onchange = render;
el('scan').onclick = () => launch('/scan', { device: el('device').value, limit: el('limit').value });
el('trash').onclick = () => {
  const plan = model?.plan;
  if (plan?.deviceId === el('device').value && plan.names.length && confirm(plan.device + '에 있는 것과 내용이 일치한 클라우드 파일 '
      + plan.names.length + '개를 휴지통으로 옮길까요?\n이동한 파일의 공유 및 중요 표시가 해제될 수 있습니다.')) {
    launch('/trash', { plan: plan.id });
  }
};
await poll();
setInterval(poll, 1200);
