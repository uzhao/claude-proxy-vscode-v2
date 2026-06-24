import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired, parseImportedCredential, CodexAuth } from './auth';

test('isExpired:剩余 < 60s 视为过期', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now + 30_000, now), true);
  assert.equal(isExpired(now + 120_000, now), false);
  assert.equal(isExpired(now - 1, now), true);
});

test('parseImportedCredential 解析 codex CLI 凭证', () => {
  const a = parseImportedCredential(JSON.stringify({
    access_token: 'at', refresh_token: 'rt', account_id: 'acc1',
    email: 'x@b.c', expired: '2026-06-30T16:49:38Z',
  }));
  assert.equal(a.accessToken, 'at');
  assert.equal(a.refreshToken, 'rt');
  assert.equal(a.accountId, 'acc1');
  assert.equal(a.email, 'x@b.c');
  assert.equal(a.expiresAt, Date.parse('2026-06-30T16:49:38Z'));
});

test('parseImportedCredential 字段回退到 id_token / 时间无效置 0', () => {
  const idToken = `h.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'accFromTok' },
    'https://api.openai.com/profile': { email: 'tok@b.c' },
  })).toString('base64url')}.s`;
  const a = parseImportedCredential(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: idToken }));
  assert.equal(a.accountId, 'accFromTok');
  assert.equal(a.email, 'tok@b.c');
  assert.equal(a.expiresAt, 0);
});

test('parseImportedCredential 缺 access_token / refresh_token 抛错', () => {
  assert.throws(() => parseImportedCredential('{"refresh_token":"rt"}'));
  assert.throws(() => parseImportedCredential('not json'));
});

/** 内存假 SecretStorage */
function fakeSecrets() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    onDidChange: (() => ({ dispose() {} })) as any,
  } as any;
}

const acc = (over: Partial<any> = {}) => ({
  accessToken: 'at', refreshToken: 'rt', accountId: 'a1', email: 'a1@b.c',
  expiresAt: Date.now() + 3_600_000, ...over,
});

test('add 按 accountId 去重(更新而非新增)', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1', email: 'old@b.c' }));
  await auth.add(acc({ accountId: 'a2' }));
  await auth.add(acc({ accountId: 'a1', email: 'new@b.c' }));
  const list = await auth.list();
  assert.equal(list.length, 2);
  assert.equal(list.find(x => x.accountId === 'a1')!.email, 'new@b.c');
});

test('兼容读取旧单对象格式', async () => {
  const s = fakeSecrets();
  await s.store('claudeProxy.codex', JSON.stringify({ accessToken: 'at', refreshToken: 'rt', accountId: 'old', expiresAt: 123 }));
  const auth = new CodexAuth(s);
  assert.equal(await auth.count(), 1);
  assert.deepEqual(await auth.list(), [{ accountId: 'old', email: '' }]);
});

test('removeByAccountId 删除指定账号', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1' }));
  await auth.add(acc({ accountId: 'a2' }));
  await auth.removeByAccountId('a1');
  assert.deepEqual((await auth.list()).map(x => x.accountId), ['a2']);
});

test('游标 markSuccess / startIndex', () => {
  const auth = new CodexAuth(fakeSecrets());
  assert.equal(auth.startIndex(), 0);
  auth.markSuccess(2);
  assert.equal(auth.startIndex(), 2);
});

test('validAt 未过期直接返回,越界返回 null', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1', accessToken: 'tok1' }));
  assert.deepEqual(await auth.validAt(0), { accessToken: 'tok1', accountId: 'a1' });
  assert.equal(await auth.validAt(5), null);
});
