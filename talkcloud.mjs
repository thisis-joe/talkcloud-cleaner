import { fingerprintFile, fingerprintKey } from './match.mjs';

export const CLOUD = 'https://talkcloud.kakao.com';
const keyPattern = /^[a-f0-9]{24}$/i;
const timeout = 12_000;

export class TalkCloud {
  constructor(page, { origin = CLOUD, onProgress = () => {}, platform = process.platform } = {}) {
    this.page = page;
    this.origin = origin;
    this.progress = onProgress;
    this.modifier = platform === 'darwin' ? 'Meta' : 'Control';
  }

  scope() {
    const url = new URL(this.page.url());
    if (url.origin !== this.origin) throw new Error('톡클라우드에 로그인하고 비교할 목록을 열어 주세요.');
    const drive = /^\/drive\/(?:all|[a-f0-9]{24})\/?$/i.test(url.pathname);
    const backup = /^\/(?:file|photo)(?:\/[^/]+)?\/?$/.test(url.pathname);
    if (!drive && !backup) throw new Error('드라이브 폴더, 파일 또는 사진/동영상 목록을 열어 주세요.');
    return {
      url: url.href,
      drive,
      rows: drive ? 'ul.list_table li[data-target="drive"]' : 'ul.list_album > li',
      scroll: drive ? '.scroll_table' : '.scroll_talk',
    };
  }

  assertScope(scope) {
    if (this.page.isClosed() || this.page.url() !== scope.url) {
      throw new Error('톡클라우드 화면이 바뀌어 중단했습니다. 목록을 다시 비교해 주세요.');
    }
  }

  row(scope, id) {
    if (!keyPattern.test(id)) throw new Error('유효하지 않은 클라우드 항목입니다.');
    return this.page.locator(scope.rows + ':has(> input.inp_check[id="' + id + '"])');
  }

  async setOffset(scope, top) {
    this.assertScope(scope);
    const list = this.page.locator(scope.scroll).first();
    return list.evaluate(async (node, offset) => {
      node.scrollTop = offset;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { top: node.scrollTop, height: node.clientHeight, end: node.scrollHeight };
    }, top, { timeout });
  }

  async visibleRows(scope) {
    this.assertScope(scope);
    return this.page.locator(scope.rows).evaluateAll(nodes => nodes.flatMap(row => {
      const input = row.querySelector(':scope > input.inp_check');
      const action = row.querySelector(':scope > a.link_item, :scope > div.link_item');
      const name = action?.querySelector('.txt_tit')?.textContent?.trim();
      const kind = action?.querySelector('.ico_folder, .folder, [class*="ico_folder"]');
      if (!input || !action || !name || kind) return [];
      return [{ id: input.id, name }];
    }));
  }

  async save(scope, item, salt) {
    this.assertScope(scope);
    const row = this.row(scope, item.id);
    if (await row.count() !== 1) throw new Error('다운로드할 파일을 다시 찾지 못했습니다.');
    const anchor = scope.drive ? row : row.locator(':scope > a.link_item');
    await anchor.click({ button: 'right', timeout });
    const controls = this.page.getByRole('link', { name: '저장하기', exact: true });
    // A row context menu and the one-item toolbar can both expose this action.
    // Require that the site's selection agrees with the row before downloading.
    await controls.last().waitFor({ state: 'visible', timeout });
    await this.assertSelection([item]);
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: 45_000 }),
      controls.last().click({ timeout }),
    ]);
    try {
      this.assertScope(scope);
      const path = await download.path();
      if (!path) throw new Error('원본 다운로드가 완료되지 않았습니다.');
      return await fingerprintFile(path, salt);
    } finally {
      await download.delete().catch(() => {});
    }
  }

  async scan(device, limit) {
    const scope = this.scope();
    const seen = new Set();
    const matches = [];
    const skipped = [];
    let offset = 0;
    let bottomWaits = 0;
    const sizes = device.sizes;
    while (seen.size < limit) {
      const scroll = await this.setOffset(scope, offset);
      const rows = await this.visibleRows(scope);
      for (const row of rows) {
        if (!keyPattern.test(row.id) || seen.has(row.id)) continue;
        seen.add(row.id);
        this.progress(seen.size + '개 확인 중');
        const item = { ...row, offset: scroll.top };
        try {
          if (scope.drive) await this.setOffset(scope, scroll.top);
          const sizeText = scope.drive
            ? await this.row(scope, item.id).evaluate(node =>
              Array.from(node.querySelectorAll('span')).map(element => element.textContent.trim())
                .find(content => /^\d+B$/.test(content)))
            : undefined;
          if (sizeText && !sizes.has(Number(sizeText.slice(0, -1)))) {
            if (seen.size >= limit) break;
            continue;
          }
          const fingerprint = await this.save(scope, item, device.salt);
          if (device.keys.has(fingerprintKey(fingerprint))) matches.push({ ...item, fingerprint });
        } catch (error) {
          this.assertScope(scope);
          skipped.push(item.name);
          await this.clearSelection();
        }
        if (seen.size >= limit) break;
      }
      if (seen.size >= limit || !scroll.height) break;
      const next = scroll.top + Math.max(100, Math.floor(scroll.height * 0.7));
      const atBottom = scroll.top + scroll.height >= scroll.end - 2;
      if (atBottom) {
        if (++bottomWaits >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 750));
      } else {
        bottomWaits = 0;
      }
      offset = next;
    }
    if (!seen.size) throw new Error('목록에서 읽을 수 있는 파일을 찾지 못했습니다.');
    return { scope, matches, skipped, checked: seen.size, capped: seen.size >= limit };
  }

  async clearSelection() {
    if (this.page.isClosed()) return;
    await this.page.keyboard.press('Escape').catch(() => {});
    const cancel = this.page.getByRole('button', { name: /개 선택됨\s*선택 취소/ });
    if (await cancel.count() === 1 && await cancel.isVisible()) await cancel.click({ timeout });
  }

  async assertSelection(items, checkToolbar = true) {
    const all = await this.page.locator('input.inp_check:checked').evaluateAll(inputs =>
      inputs.map(node => node.id).filter(id => /^[a-f0-9]{24}$/i.test(id)));
    const exact = all.length === items.length && items.every(item => all.includes(item.id));
    const count = this.page.getByRole('button', { name: new RegExp('^' + items.length + ' 개 선택됨') });
    if (!exact || (checkToolbar && await count.count() !== 1)) {
      throw new Error('선택한 항목 수 또는 식별자가 일치하지 않습니다.');
    }
  }

  async putInTrash(scope, items) {
    this.assertScope(scope);
    await this.clearSelection();
    if (scope.drive) {
      const select = async modifier => {
        for (const [index, item] of items.entries()) {
          await this.row(scope, item.id).click({ modifiers: index ? [modifier] : [], timeout });
        }
        await this.assertSelection(items);
      };
      try {
        await select(this.modifier);
      } catch (error) {
        if (items.length < 2) throw error;
        this.assertScope(scope);
        await this.clearSelection();
        await select(this.modifier === 'Meta' ? 'Control' : 'Meta');
      }
    } else {
      if (items.length !== 1) throw new Error('채팅 백업은 한 항목씩 확인해야 합니다.');
      await this.row(scope, items[0].id).locator(':scope > a.link_item').click({ button: 'right', timeout });
    }
    await this.assertSelection(items);
    const remove = this.page.getByRole('link', { name: '삭제하기', exact: true }).last();
    await remove.click({ timeout });
    const prompt = this.page.getByText('휴지통으로 이동', { exact: true });
    const confirm = this.page.getByRole('button', { name: '확인', exact: true });
    try {
      await prompt.waitFor({ state: 'visible', timeout: 4_000 });
      this.assertScope(scope);
      await this.assertSelection(items, false);
      if (await confirm.count() !== 1) throw new Error('휴지통 확인 버튼이 하나가 아닙니다.');
    } catch (error) {
      const cancel = this.page.getByRole('button', { name: '취소', exact: true });
      if (await cancel.count() === 1 && await cancel.isVisible()) await cancel.click({ timeout });
      throw error;
    }
    await confirm.click({ timeout });
    // A timeout after clicking Confirm has unknown effects. Never retry it.
    await Promise.all(items.map(item => this.row(scope, item.id).waitFor({ state: 'detached', timeout })));
  }

  async trash(plan, device) {
    const { scope, matches } = plan;
    const moved = [];
    const excluded = [];
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      await this.putInTrash(scope, pending);
      moved.push(...pending.map(item => item.name));
      pending = [];
    };
    try {
      for (const [index, item] of matches.entries()) {
        this.progress((index + 1) + '/' + matches.length + '개 원본 다시 확인 중');
        if (pending.length && (!scope.drive || item.offset !== pending[0].offset || pending.length >= 30)) {
          await flush();
        }
        await this.setOffset(scope, item.offset);
        let current;
        try {
          current = await this.save(scope, item, device.salt);
        } catch {
          this.assertScope(scope);
          await this.clearSelection();
        }
        if (!current || fingerprintKey(current) !== fingerprintKey(item.fingerprint)
            || !device.keys.has(fingerprintKey(current))) {
          excluded.push(item.name);
          continue;
        }
        pending.push(item);
      }
      await flush();
      return { moved, excluded };
    } catch (error) {
      return { moved, excluded, error: error.message, uncertain: pending.map(item => item.name) };
    } finally {
      if (!this.page.isClosed() && this.page.url() === scope.url) await this.clearSelection().catch(() => {});
    }
  }
}
