import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, CODEX_PLACEHOLDER_ID } from './presets';

test('包含 8 个可配置 preset,且不含 codex 占位', () => {
  const ids = PRESETS.map(p => p.id);
  assert.deepEqual(ids, ['openai', 'gemini', 'openrouter', 'nvidia', 'glm', 'kimi', 'deepseek', 'minimax']);
  assert.equal(ids.includes(CODEX_PLACEHOLDER_ID), false);
});

test('国产四家为 anthropic 格式且 forwardable', () => {
  for (const id of ['glm', 'kimi', 'deepseek', 'minimax']) {
    const p = getPreset(id)!;
    assert.equal(p.format, 'anthropic');
    assert.equal(p.forwardable, true);
  }
});

test('openai/gemini/openrouter/nvidia 非 anthropic 且 Part 1 不可转发', () => {
  for (const id of ['openai', 'gemini', 'openrouter', 'nvidia']) {
    assert.equal(getPreset(id)!.forwardable, false);
  }
});

test('preset 映射到正确的 models.dev id', () => {
  assert.equal(getPreset('glm')!.modelsDevId, 'zhipuai');
  assert.equal(getPreset('kimi')!.modelsDevId, 'moonshotai');
  assert.equal(getPreset('gemini')!.modelsDevId, 'google');
});

test('getPreset 未知返回 undefined', () => {
  assert.equal(getPreset('nope'), undefined);
});
