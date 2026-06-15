import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ProxyConfig, normalize, readConfig, writeConfig, ensureConfig,
  getProvider, configuredProviders, addKey, removeKey, setMapping,
} from './config';

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'providers.json');
}

test('normalize 容错非法输入', () => {
  assert.deepEqual(normalize(null), { mapping: 'pass', providers: [] });
  assert.deepEqual(normalize({ mapping: 5, providers: 'x' }), { mapping: 'pass', providers: [] });
  assert.deepEqual(
    normalize({ mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k1', 2] }, { bad: 1 }] }),
    { mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k1'] }] },
  );
});

test('ensureConfig 不存在时写默认模板', () => {
  const p = tmp();
  fs.rmSync(p, { force: true });
  const cfg = ensureConfig(p);
  assert.deepEqual(cfg, { mapping: 'pass', providers: [] });
  assert.equal(fs.existsSync(p), true);
});

test('writeConfig + readConfig 往返', () => {
  const p = tmp();
  const cfg: ProxyConfig = { mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k'] }] };
  writeConfig(cfg, p);
  assert.deepEqual(readConfig(p), cfg);
});

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
