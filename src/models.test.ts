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

test('isFeatured:claude 4/5 两代均命中', () => {
  assert.equal(isFeatured('claude-opus-4-8'), true);
  assert.equal(isFeatured('claude-haiku-4-5-20251001'), true);
  assert.equal(isFeatured('claude-sonnet-5'), true);
  assert.equal(isFeatured('claude-fable-5'), true);
});

test('isFeatured:gpt 只认 gpt-5 系,不误收带 5 的老模型', () => {
  assert.equal(isFeatured('gpt-5.6'), true);
  assert.equal(isFeatured('gpt-5.3-codex'), true);
  assert.equal(isFeatured('gpt-3.5-turbo'), false);
  assert.equal(isFeatured('gpt-4o-2024-05-13'), false);
  assert.equal(isFeatured('gpt-image-1.5'), false);
});

test('isFeatured:meta muse-spark(含中转站的 vendor 前缀形式)', () => {
  assert.equal(isFeatured('muse-spark-1.1'), true);
  assert.equal(isFeatured('meta/muse-spark-1.1'), true);
  assert.equal(isFeatured('muse-spark-2'), true);
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

import { getCatalog, CatalogCache } from './models';

function memCache(initial: any = null): CatalogCache & { written: any } {
  const box: any = { value: initial, written: null };
  return {
    read: () => box.value,
    write: (c: any) => { box.value = c; box.written = c; },
    get written() { return box.written; },
  } as any;
}

test('getCatalog 命中缓存时不拉取', async () => {
  const cache = memCache({ a: 1 });
  let called = 0;
  const fakeFetch = (async () => { called++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
  assert.deepEqual(await getCatalog(cache, fakeFetch), { a: 1 });
  assert.equal(called, 0);
});

test('getCatalog 未命中则拉取并写缓存', async () => {
  const cache = memCache(null);
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ b: 2 }) })) as unknown as typeof fetch;
  assert.deepEqual(await getCatalog(cache, fakeFetch), { b: 2 });
  assert.deepEqual(cache.written, { b: 2 });
});

test('getCatalog 拉取失败抛错', async () => {
  const cache = memCache(null);
  const fakeFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => getCatalog(cache, fakeFetch), /500/);
});

import { parseEndpointModels, fetchEndpointModels } from './models';

test('parseEndpointModels 解析 data[].id 并按 id 升序', () => {
  const json = { data: [{ id: 'qwen2.5' }, { id: 'llama3.2' }] };
  assert.deepEqual(parseEndpointModels(json).map(m => m.id), ['llama3.2', 'qwen2.5']);
});

test('parseEndpointModels name=id 且 releaseDate 为空', () => {
  assert.deepEqual(parseEndpointModels({ data: [{ id: 'llama3.2' }] })[0], { id: 'llama3.2', name: 'llama3.2', releaseDate: '' });
});

test('parseEndpointModels 非数组/缺字段降级', () => {
  assert.deepEqual(parseEndpointModels({}), []);
  assert.deepEqual(parseEndpointModels({ data: 'x' }), []);
  assert.deepEqual(parseEndpointModels({ data: [{ foo: 1 }, { id: 'ok' }] }).map(m => m.id), ['ok']);
});

test('fetchEndpointModels 带 key 时加 Bearer 并拼对 URL', async () => {
  let seenUrl = '';
  let seenAuth: any = '';
  const fakeFetch = (async (url: string, init: any) => {
    seenUrl = url;
    seenAuth = init?.headers?.Authorization;
    return { ok: true, json: async () => ({ data: [{ id: 'llama3.2' }] }) };
  }) as unknown as typeof fetch;
  const models = await fetchEndpointModels('http://localhost:11434', 'sk-x', fakeFetch);
  assert.equal(seenUrl, 'http://localhost:11434/v1/models');
  assert.equal(seenAuth, 'Bearer sk-x');
  assert.deepEqual(models.map(m => m.id), ['llama3.2']);
});

test('fetchEndpointModels 非 2xx 抛错', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchEndpointModels('http://x', undefined, fakeFetch), /404/);
});
