import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageStart, contentBlockStart, contentBlockDelta, contentBlockStop,
  messageDelta, messageStop, mapStopReason, extractUsage,
} from './anthropic';

test('messageStart 含 id/model 与初始 message 结构', () => {
  const s = messageStart('msg_1', 'gpt-5');
  assert.match(s, /^event: message_start\n/);
  const data = JSON.parse(s.split('data: ')[1]);
  assert.equal(data.type, 'message_start');
  assert.equal(data.message.id, 'msg_1');
  assert.equal(data.message.model, 'gpt-5');
  assert.equal(data.message.role, 'assistant');
});

test('content_block_start/delta/stop 带 index 与负载', () => {
  assert.match(contentBlockStart(0, { type: 'text', text: '' }), /content_block_start/);
  const d = JSON.parse(contentBlockDelta(1, { type: 'text_delta', text: 'hi' }).split('data: ')[1]);
  assert.equal(d.index, 1);
  assert.equal(d.delta.text, 'hi');
  const s = JSON.parse(contentBlockStop(2).split('data: ')[1]);
  assert.equal(s.type, 'content_block_stop');
  assert.equal(s.index, 2);
});

test('messageDelta 带 stop_reason 与 usage;messageStop', () => {
  const d = JSON.parse(messageDelta('end_turn', { input_tokens: 3, output_tokens: 5 }).split('data: ')[1]);
  assert.equal(d.delta.stop_reason, 'end_turn');
  assert.equal(d.usage.output_tokens, 5);
  assert.match(messageStop(), /message_stop/);
});

test('mapStopReason 映射', () => {
  assert.equal(mapStopReason('stop'), 'end_turn');
  assert.equal(mapStopReason('length'), 'max_tokens');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
  assert.equal(mapStopReason('content_filter'), 'end_turn');
  assert.equal(mapStopReason('whatever'), 'end_turn');
});

test('extractUsage 映射 token 并扣减 cached', () => {
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 4 }),
    { input_tokens: 10, output_tokens: 4 });
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } }),
    { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 3 });
});
