import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProxyConfig, getProvider, configuredProviders, addKey, removeKey, setMapping,
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
