import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const MAX_FINGERPRINTS = 50_000;
export const fingerprintKey = ({ hash, size }) => size + ':' + hash;

export function deviceFingerprints(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_FINGERPRINTS) {
    throw new Error('파일 지문은 1~50,000개까지 받을 수 있습니다.');
  }
  return new Set(entries.map(entry => {
    if (!entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash)
        || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error('올바르지 않은 파일 지문입니다.');
    }
    return fingerprintKey(entry);
  }));
}

export async function fingerprintFile(path, salt) {
  const digest = createHash('sha256').update(salt + ':');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    digest.update(bytes);
    size += bytes.length;
  }
  return { hash: digest.digest('hex'), size };
}
