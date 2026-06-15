import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderModels, topN } from './models';

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

test('topN 截取前 N 个', () => {
  const list = parseProviderModels(CATALOG, 'zhipuai');
  assert.deepEqual(topN(list, 2).map(m => m.id), ['glm-5', 'glm-4.6']);
});

test('name 缺省回退到 id', () => {
  const c = { x: { models: { 'm1': { id: 'm1', release_date: '2026-01-01' } } } };
  assert.equal(parseProviderModels(c, 'x')[0].name, 'm1');
});
