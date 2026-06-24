import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProxyConfig, getProvider, configuredProviders, addKey, removeKey, setMapping,
  CustomProvider, addCustomProvider, updateCustomProvider, removeCustomProvider, normalizeBaseUrl,
} from './config';

test('addKey 新建与追加', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  cfg = addKey(cfg, 'glm', 'k1');
  cfg = addKey(cfg, 'glm', 'k2');
  assert.deepEqual(getProvider(cfg, 'glm')!.apiKeys, ['k1', 'k2']);
});

test('removeKey 删除指定 key', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [{ name: 'glm', apiKeys: ['k1', 'k2'] }] };
  cfg = removeKey(cfg, 'glm', 'k1');
  assert.deepEqual(getProvider(cfg, 'glm')!.apiKeys, ['k2']);
});

test('configuredProviders 仅含有 key 的', () => {
  const cfg: ProxyConfig = { mapping: 'pass', providers: [
    { name: 'glm', apiKeys: ['k'] },
    { name: 'kimi', apiKeys: [] },
  ] };
  assert.deepEqual(configuredProviders(cfg).map(p => p.name), ['glm']);
});

test('setMapping 不可变更新', () => {
  const cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  assert.equal(setMapping(cfg, 'glm:glm-5').mapping, 'glm:glm-5');
  assert.equal(cfg.mapping, 'pass');
});

test('addCustomProvider 新增', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  cfg = addCustomProvider(cfg, { id: 'ollama', baseUrl: 'http://localhost:11434' });
  assert.deepEqual(cfg.customProviders, [{ id: 'ollama', baseUrl: 'http://localhost:11434' }]);
});

test('addCustomProvider 同 id 覆盖', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = addCustomProvider(cfg, { id: 'ollama', baseUrl: 'http://b' });
  assert.deepEqual(cfg.customProviders, [{ id: 'ollama', baseUrl: 'http://b' }]);
});

test('updateCustomProvider 改 baseUrl', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = updateCustomProvider(cfg, 'ollama', 'http://b');
  assert.equal(cfg.customProviders![0].baseUrl, 'http://b');
});

test('removeCustomProvider 连带摘 key', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [{ name: 'ollama', apiKeys: ['k'] }], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = removeCustomProvider(cfg, 'ollama');
  assert.deepEqual(cfg.customProviders, []);
  assert.deepEqual(cfg.providers, []);
});

test('normalizeBaseUrl 去尾斜杠与 /v1', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('https://api.x.com/v1/'), 'https://api.x.com');
  assert.equal(normalizeBaseUrl('https://example.com/api'), 'https://example.com/api');
});
