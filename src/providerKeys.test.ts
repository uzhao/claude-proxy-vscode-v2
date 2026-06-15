import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProviderKeyStore, normalizeProviderKeys } from './providerKeys';

/** 内存版 fake SecretStorage */
function fakeSecrets(): any {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    _map: m,
  };
}

test('normalizeProviderKeys 丢弃非法', () => {
  assert.deepEqual(normalizeProviderKeys(null), {});
  assert.deepEqual(normalizeProviderKeys({ glm: ['k1', 2], bad: 'x' }), { glm: ['k1'] });
});

test('save 后 load 往返', async () => {
  const s = fakeSecrets();
  const store = new ProviderKeyStore(s);
  await store.save({ glm: ['k1', 'k2'] });
  assert.deepEqual(await store.load(), { glm: ['k1', 'k2'] });
});

test('load 空时返回 {}', async () => {
  assert.deepEqual(await new ProviderKeyStore(fakeSecrets()).load(), {});
});

test('migrateLegacy 把旧 providers.json 的 key 合并并删文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const legacy = path.join(dir, 'providers.json');
  fs.writeFileSync(legacy, JSON.stringify({ providers: [{ name: 'glm', apiKeys: ['k1'] }] }));
  const s = fakeSecrets();
  const store = new ProviderKeyStore(s);
  const merged = await store.migrateLegacy({}, legacy);
  assert.deepEqual(merged, { glm: ['k1'] });
  assert.deepEqual(await store.load(), { glm: ['k1'] });
  assert.equal(fs.existsSync(legacy), false);
});

test('migrateLegacy 无旧文件时原样返回', async () => {
  const store = new ProviderKeyStore(fakeSecrets());
  assert.deepEqual(await store.migrateLegacy({ kimi: ['k'] }, '/no/such/file.json'), { kimi: ['k'] });
});
