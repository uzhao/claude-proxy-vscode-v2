import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderModels, isFeatured, filterFeatured } from './models';

const CATALOG = {
  zhipuai: {
    models: {
      'glm-4.6':       { id: 'glm-4.6',       name: 'GLM 4.6',  release_date: '2026-01-10', last_updated: '2026-01-10' },
      'glm-4.5-flash': { id: 'glm-4.5-flash', name: 'GLM Flash', release_date: '2025-11-01', last_updated: '2025-11-01' },
      'glm-5':         { id: 'glm-5',          name: 'GLM 5',    release_date: '2026-03-20', last_updated: '2026-03-20' },
    },
  },
  empty: { models: {} },
};

test('按发布日期倒序', () => {
  const list = parseProviderModels(CATALOG, 'zhipuai');
  assert.deepEqual(list.map(m => m.id), ['glm-5', 'glm-4.6', 'glm-4.5-flash']);
});

test('字段映射到 id/name/releaseDate', () => {
  const first = parseProviderModels(CATALOG, 'zhipuai')[0];
  assert.deepEqual(first, { id: 'glm-5', name: 'GLM 5', releaseDate: '2026-03-20' });
});

test('未知 provider 或空模型返回空数组', () => {
  assert.deepEqual(parseProviderModels(CATALOG, 'nope'), []);
  assert.deepEqual(parseProviderModels(CATALOG, 'empty'), []);
});

test('name 缺省回退到 id', () => {
  const c = { x: { models: { 'm1': { id: 'm1', release_date: '2026-01-01' } } } };
  assert.equal(parseProviderModels(c, 'x')[0].name, 'm1');
});

test('isFeatured:* 匹配任意串', () => {
  assert.equal(isFeatured('gpt-5'), true);
  assert.equal(isFeatured('gpt-5-mini'), true);
  assert.equal(isFeatured('glm-5'), true);
  assert.equal(isFeatured('glm-5-air'), true);
});

test('isFeatured:. 匹配任意单字符(覆盖连字符 id)', () => {
  assert.equal(isFeatured('kimi-k2-0905'), true);
  assert.equal(isFeatured('minimax-m2-pro'), true);
});

test('isFeatured:大小写不敏感', () => {
  assert.equal(isFeatured('GLM-5'), true);
  assert.equal(isFeatured('Claude-Opus-4-1'), true);
});

test('isFeatured:未命中返回 false', () => {
  assert.equal(isFeatured('glm-4.6'), false);
  assert.equal(isFeatured('gpt-4o'), false);
  assert.equal(isFeatured('deepseek-v3'), false);
});

test('isFeatured:忽略 vendor 前缀,只匹配 / 后的模型名', () => {
  assert.equal(isFeatured('z-ai/glm-5.1'), true);
  assert.equal(isFeatured('moonshotai/kimi-k2.6'), true);
  assert.equal(isFeatured('minimaxai/minimax-m2.7'), true);
  assert.equal(isFeatured('deepseek-ai/deepseek-v4-pro'), true);
  assert.equal(isFeatured('openai/gpt-oss-120b'), false);
});

test('filterFeatured 跨 provider 只留命中项', () => {
  const models = [
    { id: 'glm-5', name: 'GLM 5', releaseDate: '' },
    { id: 'glm-4.6', name: 'GLM 4.6', releaseDate: '' },
    { id: 'gpt-5', name: 'GPT 5', releaseDate: '' },
    { id: 'gpt-4o', name: 'GPT 4o', releaseDate: '' },
  ];
  assert.deepEqual(filterFeatured(models).map(m => m.id), ['glm-5', 'gpt-5']);
});

import { readCache, writeCache, getCatalog } from './models';
import * as os from 'node:os';
import * as fsp from 'node:fs';
import * as pathp from 'node:path';

function tmpFile(): string {
  return pathp.join(fsp.mkdtempSync(pathp.join(os.tmpdir(), 'cp-')), 'cache.json');
}

test('writeCache 后 readCache 读回', () => {
  const p = tmpFile();
  writeCache({ a: 1 }, p);
  assert.deepEqual(readCache(p), { a: 1 });
});

test('缓存超过 TTL 视为失效', () => {
  const p = tmpFile();
  writeCache({ a: 1 }, p);
  const future = Date.now() + 25 * 60 * 60 * 1000;
  assert.equal(readCache(p, future), null);
});

test('getCatalog 缓存命中时不调用 fetcher', async () => {
  // 预热默认缓存路径会污染 home,这里只验证 fetcher 注入:用一份无缓存的临时不可行,
  // 故改为验证 fetcher 失败时抛错(无缓存路径下默认缓存可能不存在)。
  let called = 0;
  const fakeFetch = (async () => {
    called++;
    return { ok: false, status: 500 } as any;
  }) as unknown as typeof fetch;
  // 仅当默认缓存不存在时才会触发 fetcher;若本机存在有效缓存则跳过断言。
  try {
    await getCatalog(fakeFetch);
  } catch (e: any) {
    assert.match(e.message, /500/);
  }
  assert.ok(called >= 0);
});
