import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIRequest } from './request';

test('基础:model/参数/纯文本 messages/stream', () => {
  const out = buildOpenAIRequest({
    max_tokens: 100, temperature: 0.5, stop_sequences: ['X'],
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5');
  assert.equal(out.model, 'gpt-5');
  assert.equal(out.max_completion_tokens, 100);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.stop, 'X');
  assert.equal(out.stream, true);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
});

test('system(string)置于首条 system 消息', () => {
  const out = buildOpenAIRequest({ system: 'be brief', messages: [] }, 'm');
  assert.deepEqual(out.messages[0], { role: 'system', content: [{ type: 'text', text: 'be brief' }] });
});

test('图片块 → image_url(data URI)', () => {
  const out = buildOpenAIRequest({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ] }],
  }, 'm');
  assert.deepEqual(out.messages[0].content, [
    { type: 'text', text: 'see' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
});

test('tools 声明 → functions;tool_choice 映射', () => {
  const out = buildOpenAIRequest({
    messages: [],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  }, 'm');
  assert.deepEqual(out.tools[0], { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object' } } });
  assert.equal(out.tool_choice, 'required');
});

test('assistant tool_use → tool_calls;user tool_result → tool 消息(先于内容)', () => {
  const out = buildOpenAIRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ],
  }, 'm');
  assert.deepEqual(out.messages[0], {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
  });
  assert.deepEqual(out.messages[1], { role: 'tool', tool_call_id: 'call_1', content: 'ok' });
});

test('assistant thinking → reasoning_content;不发 reasoning_effort', () => {
  const out = buildOpenAIRequest({
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer' },
    ] }],
  }, 'm');
  assert.equal(out.reasoning_effort, undefined);
  assert.equal(out.messages[0].reasoning_content, 'hmm');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'answer' }]);
});
