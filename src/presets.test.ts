import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, CODEX_PLACEHOLDER_ID } from './presets';

test('包含 8 个可配置 preset,codex 已成为正式 preset', () => {
  const ids = PRESETS.map(p => p.id);
  assert.deepEqual(ids, ['openai', 'openrouter', 'nvidia', 'glm', 'kimi', 'deepseek', 'minimax', 'codex']);
  // codex 已升格为正式 preset,CODEX_PLACEHOLDER_ID 仅保留常量供外部引用
  assert.equal(getPreset(CODEX_PLACEHOLDER_ID)?.id, 'codex');
});

test('国产四家为 anthropic 格式且 forwardable', () => {
  for (const id of ['glm', 'kimi', 'deepseek', 'minimax']) {
    const p = getPreset(id)!;
    assert.equal(p.format, 'anthropic');
    assert.equal(p.forwardable, true);
  }
});

test('openai 系可转发', () => {
  for (const id of ['openai', 'openrouter', 'nvidia']) {
    assert.equal(getPreset(id)!.forwardable, true);
  }
});

test('preset 映射到正确的 models.dev id', () => {
  assert.equal(getPreset('glm')!.modelsDevId, 'zhipuai');
  assert.equal(getPreset('kimi')!.modelsDevId, 'moonshotai');
  assert.equal(getPreset('deepseek')!.modelsDevId, 'deepseek');
});

test('getPreset 未知返回 undefined', () => {
  assert.equal(getPreset('nope'), undefined);
});
