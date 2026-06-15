import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTranslator } from './registry';
import { getPreset } from '../presets';
import { getPreset as getPresetForCodex } from '../presets';

test('openai(api=responses)→ responses 端点', () => {
  const t = getTranslator(getPreset('openai')!)!;
  assert.equal(t.endpointPath, '/v1/responses');
  assert.deepEqual(t.authHeader('sk-1'), { Authorization: 'Bearer sk-1' });
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5');
  assert.deepEqual(req.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});

test('openrouter/nvidia(api=chat)→ chat completions 端点', () => {
  for (const id of ['openrouter', 'nvidia']) {
    const t = getTranslator(getPreset(id)!)!;
    assert.equal(t.endpointPath, '/v1/chat/completions');
    const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'm');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'hi' }]);
  }
});

test('anthropic 格式 preset 无 translator(原样转发)', () => {
  assert.equal(getTranslator(getPreset('glm')!), null);
});

test('codex preset → responses 端点 + codex 请求(带 store:false)', () => {
  const t = getTranslator(getPresetForCodex('codex')!)!;
  assert.equal(t.endpointPath, '/responses');
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5-codex');
  assert.equal(req.store, false);
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});
