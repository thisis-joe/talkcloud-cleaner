const releaseApi = 'https://api.github.com/repos/thisis-joe/talkcloud-cleaner/releases/latest';
const releasePage = 'https://github.com/thisis-joe/talkcloud-cleaner/releases/tag/';
const interval = 30 * 60_000;
const retryDelays = [60_000, 5 * 60_000, interval];
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const installerSuffixes = {
  win32: { x64: 'windows-x64.exe' },
  darwin: { arm64: 'mac-arm64.dmg', x64: 'mac-x64.dmg' },
};

export function findUpdate(release, { current, platform, arch }) {
  const suffix = installerSuffixes[platform]?.[arch];
  if (!suffix || !release || release.draft !== false || release.prerelease !== false) return null;
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  const latest = versionPattern.exec(version);
  const installed = versionPattern.exec(current);
  if (!latest || !installed) return null;
  const difference = latest.slice(1).map((part, index) => Number(part) - Number(installed[index + 1]))
    .find(part => part !== 0);
  if (!(difference > 0)) return null;
  const name = 'TalkCloudCleaner-' + version + '-' + suffix;
  if (!Array.isArray(release.assets)
      || !release.assets.some(asset => asset?.name === name && asset.state === 'uploaded')) return null;
  return { version, url: releasePage + tag };
}

export async function getLatestUpdate(options, fetchRelease = fetch) {
  const response = await fetchRelease(releaseApi, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TalkCloudCleaner' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('GitHub release check failed (' + response.status + ')');
  return findUpdate(await response.json(), options);
}

export function monitorUpdates({ check, notify }) {
  let firstSuccess = true;
  let failures = 0;
  let stopped = false;
  let timer;
  let pending;
  const announced = new Set();

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(checkNow, delay);
    timer.unref();
  }

  function checkNow() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    pending = Promise.resolve().then(check).then(update => {
      if (stopped) return;
      failures = 0;
      const initial = firstSuccess;
      firstSuccess = false;
      if (update && !announced.has(update.version)) {
        announced.add(update.version);
        notify(update, initial);
      }
      schedule(interval);
    }, () => {
      const retry = retryDelays[Math.min(failures, retryDelays.length - 1)];
      failures++;
      schedule(retry);
    }).finally(() => { pending = undefined; });
    return pending;
  }

  return {
    checkNow,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
