import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, shouldRotate } from './proxy';
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

test('openai 格式 Part 2a 起可转发;gemini 仍不可转发', () => {
  assert.equal(resolveTarget({ mapping: 'openai:gpt-4o', providers: [{ name: 'openai', apiKeys: ['k'] }] })!.forwardable, true);
  assert.equal(resolveTarget({ mapping: 'gemini:gemini-3-pro', providers: [{ name: 'gemini', apiKeys: ['k'] }] })!.forwardable, false);
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
