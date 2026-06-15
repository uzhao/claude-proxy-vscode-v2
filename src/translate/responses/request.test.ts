import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequest } from './request';

test('基础:model/参数/input/stream', () => {
  const out = buildResponsesRequest({
    max_tokens: 100, temperature: 0.5,
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5');
  assert.equal(out.model, 'gpt-5');
  assert.equal(out.max_output_tokens, 100);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.stream, true);
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
});

test('system → developer message', () => {
  const out = buildResponsesRequest({ system: 'be brief', messages: [] }, 'm');
  assert.deepEqual(out.input[0], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] });
});

test('assistant 文本用 output_text;图片用 input_image', () => {
  const out = buildResponsesRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
    ],
  }, 'm');
  assert.deepEqual(out.input[0].content, [{ type: 'output_text', text: 'ok' }]);
  assert.deepEqual(out.input[1].content, [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }]);
});

test('tool_use → function_call;tool_result → function_call_output', () => {
  const out = buildResponsesRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ],
  }, 'm');
  assert.deepEqual(out.input[0], { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' });
  assert.deepEqual(out.input[1], { type: 'function_call_output', call_id: 'call_1', output: 'ok' });
});

test('tools → function 定义(删 $schema);tool_choice;thinking → reasoning.effort', () => {
  const out = buildResponsesRequest({
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', $schema: 'x' } }],
    tool_choice: { type: 'any' },
  }, 'm');
  assert.deepEqual(out.tools[0], { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' } });
  assert.equal(out.tool_choice, 'required');
  assert.deepEqual(out.reasoning, { effort: 'medium', summary: 'auto' });
});

test('assistant thinking 块被忽略(不发 reasoning item)', () => {
  const out = buildResponsesRequest({
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret' },
      { type: 'text', text: 'answer' },
    ] }],
  }, 'm');
  assert.equal(out.input.length, 1);
  assert.deepEqual(out.input[0].content, [{ type: 'output_text', text: 'answer' }]);
});
