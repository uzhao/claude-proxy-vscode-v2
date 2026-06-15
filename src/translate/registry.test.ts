import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTranslator } from './registry';

test('openai format 返回转换器,端点与认证正确', () => {
  const t = getTranslator('openai')!;
  assert.equal(t.endpointPath, '/v1/chat/completions');
  assert.deepEqual(t.authHeader('sk-1'), { Authorization: 'Bearer sk-1' });
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5');
  assert.equal(req.model, 'gpt-5');
  assert.equal(req.stream, true);
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});

test('gemini/codex 尚未实现返回 null', () => {
  assert.equal(getTranslator('gemini'), null);
});
