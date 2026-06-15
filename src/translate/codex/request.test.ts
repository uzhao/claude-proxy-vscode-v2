import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexRequest } from './request';

test('在 Responses 基础上叠加 codex 专属字段', () => {
  const out = buildCodexRequest({
    max_tokens: 64,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5-codex');
  assert.equal(out.model, 'gpt-5-codex');
  assert.equal(out.stream, true);
  assert.equal(out.max_output_tokens, undefined); // codex 后端不接受,已删除
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  assert.equal(out.instructions, '');
  assert.equal(out.store, false);
  assert.deepEqual(out.include, ['reasoning.encrypted_content']);
  assert.equal(out.reasoning.effort, 'medium');
  assert.equal(out.reasoning.summary, 'auto');
});

test('无 thinking 时也带 reasoning.summary(codex 要求)', () => {
  const out = buildCodexRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'm');
  assert.equal(out.reasoning.summary, 'auto');
  assert.equal(out.store, false);
});
