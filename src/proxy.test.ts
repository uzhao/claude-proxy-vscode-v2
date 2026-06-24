import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, shouldRotate, pickCodexSequence } from './proxy';
import { ProxyConfig } from './config';

const withGlm: ProxyConfig = { mapping: 'glm:glm-4.6', providers: [{ name: 'glm', apiKeys: ['k1', 'k2'] }] };

test('pass / 空 mapping 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'pass', providers: [] }), null);
  assert.equal(resolveTarget({ mapping: '', providers: [] }), null);
});

test('anthropic 格式 + 有 key → 命中目标', () => {
  const t = resolveTarget(withGlm)!;
  assert.equal(t.preset.id, 'glm');
  assert.equal(t.model, 'glm-4.6');
  assert.deepEqual(t.apiKeys, ['k1', 'k2']);
  assert.equal(t.forwardable, true);
});

test('未配置 key 的 provider 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'glm:glm-4.6', providers: [] }), null);
  assert.equal(resolveTarget({ mapping: 'glm:glm-4.6', providers: [{ name: 'glm', apiKeys: [] }] }), null);
});

test('未知 provider 或缺 model 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'nope:x', providers: [{ name: 'nope', apiKeys: ['k'] }] }), null);
  assert.equal(resolveTarget({ mapping: 'glm', providers: [{ name: 'glm', apiKeys: ['k'] }] }), null);
});

test('openai 格式可转发;未知 provider 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'openai:gpt-4o', providers: [{ name: 'openai', apiKeys: ['k'] }] })!.forwardable, true);
  assert.equal(resolveTarget({ mapping: 'gemini:x', providers: [{ name: 'gemini', apiKeys: ['k'] }] }), null);
});

test('codex 无 providers.json key 仍命中 target(用 OAuth)', () => {
  const t = resolveTarget({ mapping: 'codex:gpt-5.5', providers: [] })!;
  assert.equal(t.preset.id, 'codex');
  assert.equal(t.model, 'gpt-5.5');
  assert.deepEqual(t.apiKeys, []);
});

test('model 名含冒号可正确还原', () => {
  const t = resolveTarget({ mapping: 'openrouter:vendor:model-x', providers: [{ name: 'openrouter', apiKeys: ['k'] }] })!;
  assert.equal(t.model, 'vendor:model-x');
});

test('shouldRotate 仅对 401/429/5xx 为真', () => {
  assert.equal(shouldRotate(200), false);
  assert.equal(shouldRotate(400), false);
  assert.equal(shouldRotate(401), true);
  assert.equal(shouldRotate(429), true);
  assert.equal(shouldRotate(500), true);
  assert.equal(shouldRotate(503), true);
});

test('自定义 provider 无 key 仍命中 target(keyless)', () => {
  const cfg: ProxyConfig = {
    mapping: 'ollama:llama3.2', providers: [],
    customProviders: [{ id: 'ollama', baseUrl: 'http://localhost:11434' }],
  };
  const t = resolveTarget(cfg)!;
  assert.equal(t.preset.id, 'ollama');
  assert.equal(t.preset.custom, true);
  assert.equal(t.model, 'llama3.2');
  assert.deepEqual(t.apiKeys, []);
  assert.equal(t.forwardable, true);
});

test('自定义 provider 有 key 时带上 key', () => {
  const cfg: ProxyConfig = {
    mapping: 'ollama:llama3.2',
    providers: [{ name: 'ollama', apiKeys: ['sk-x'] }],
    customProviders: [{ id: 'ollama', baseUrl: 'http://localhost:11434' }],
  };
  assert.deepEqual(resolveTarget(cfg)!.apiKeys, ['sk-x']);
});

test('pickCodexSequence 从游标起轮转并回绕', () => {
  assert.deepEqual(pickCodexSequence(3, 0), [0, 1, 2]);
  assert.deepEqual(pickCodexSequence(3, 1), [1, 2, 0]);
  assert.deepEqual(pickCodexSequence(3, 2), [2, 0, 1]);
  assert.deepEqual(pickCodexSequence(3, 5), [2, 0, 1]); // 5 % 3 = 2
  assert.deepEqual(pickCodexSequence(1, 0), [0]);
  assert.deepEqual(pickCodexSequence(0, 0), []);
});
