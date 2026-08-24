// 把 Anthropic SSE 事件序列聚合回非流式 Messages 响应的测试。
// 客户端发 stream:false 时,代理上游仍走流式(复用 translator),再由 collectMessage 还原成一个 JSON 响应。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMessage } from './collect';
import * as A from './anthropic';
import { sseEvent } from './sse';

test('纯文本流聚合为单个 text 内容块', () => {
  const events = [
    A.messageStart('msg_1', 'gpt-5'),
    A.contentBlockStart(0, { type: 'text', text: '' }),
    A.contentBlockDelta(0, { type: 'text_delta', text: 'Hello' }),
    A.contentBlockDelta(0, { type: 'text_delta', text: ', world' }),
    A.contentBlockStop(0),
    A.messageDelta('end_turn', { input_tokens: 7, output_tokens: 3 }),
    A.messageStop(),
  ];
  const { status, body } = collectMessage(events);
  assert.equal(status, 200);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.id, 'msg_1');
  assert.equal(body.model, 'gpt-5');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hello, world' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.stop_sequence, null);
  assert.deepEqual(body.usage, { input_tokens: 7, output_tokens: 3 });
});

test('thinking 与 text 两个块按 index 顺序还原', () => {
  const events = [
    A.messageStart('msg_2', 'glm'),
    A.contentBlockStart(0, { type: 'thinking', thinking: '' }),
    A.contentBlockDelta(0, { type: 'thinking_delta', thinking: '让我想想' }),
    A.contentBlockStop(0),
    A.contentBlockStart(1, { type: 'text', text: '' }),
    A.contentBlockDelta(1, { type: 'text_delta', text: '答案是 42' }),
    A.contentBlockStop(1),
    A.messageDelta('end_turn', { input_tokens: 1, output_tokens: 2 }),
    A.messageStop(),
  ];
  const { body } = collectMessage(events);
  assert.deepEqual(body.content, [
    { type: 'thinking', thinking: '让我想想' },
    { type: 'text', text: '答案是 42' },
  ]);
});

test('tool_use 块把 input_json_delta 拼回 input 对象', () => {
  const events = [
    A.messageStart('msg_3', 'kimi'),
    A.contentBlockStart(0, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
    A.contentBlockDelta(0, { type: 'input_json_delta', partial_json: '{"file_' }),
    A.contentBlockDelta(0, { type: 'input_json_delta', partial_json: 'path":"/a.ts"}' }),
    A.contentBlockStop(0),
    A.messageDelta('tool_use', { input_tokens: 5, output_tokens: 9 }),
    A.messageStop(),
  ];
  const { body } = collectMessage(events);
  assert.deepEqual(body.content, [
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } },
  ]);
  assert.equal(body.stop_reason, 'tool_use');
});

test('tool_use 的 partial_json 非法时退化为空 input,不抛异常', () => {
  const events = [
    A.messageStart('msg_4', 'kimi'),
    A.contentBlockStart(0, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }),
    A.contentBlockDelta(0, { type: 'input_json_delta', partial_json: '{"cmd":' }), // 被截断
    A.contentBlockStop(0),
    A.messageStop(),
  ];
  const { body } = collectMessage(events);
  assert.deepEqual(body.content, [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }]);
});

test('error 事件 → 非 200 状态与 Anthropic 错误体', () => {
  const events = [
    A.messageStart('msg_5', 'x'),
    sseEvent('error', { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
  ];
  const { status, body } = collectMessage(events);
  assert.equal(status, 429);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.message, 'slow down');
});

test('空事件列表 → 502 与可诊断的错误信息', () => {
  const { status, body } = collectMessage([]);
  assert.equal(status, 502);
  assert.equal(body.type, 'error');
  assert.match(body.error.message, /no/i);
});

test('缺 message_delta 时 stop_reason 兜底为 end_turn,usage 归零', () => {
  const events = [
    A.messageStart('msg_6', 'm'),
    A.contentBlockStart(0, { type: 'text', text: '' }),
    A.contentBlockDelta(0, { type: 'text_delta', text: 'hi' }),
    A.contentBlockStop(0),
    A.messageStop(),
  ];
  const { status, body } = collectMessage(events);
  assert.equal(status, 200);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0 });
});

test('ping 帧被忽略,不影响聚合结果', () => {
  const events = [
    'event: ping\ndata: {"type":"ping"}\n\n',
    A.messageStart('msg_7', 'm'),
    'event: ping\ndata: {"type":"ping"}\n\n',
    A.contentBlockStart(0, { type: 'text', text: '' }),
    A.contentBlockDelta(0, { type: 'text_delta', text: 'ok' }),
    A.contentBlockStop(0),
    A.messageStop(),
  ];
  const { body } = collectMessage(events);
  assert.deepEqual(body.content, [{ type: 'text', text: 'ok' }]);
});

test('多个事件拼在一个字符串里也能解析(转发时按块写出)', () => {
  const blob = [
    A.messageStart('msg_8', 'm'),
    A.contentBlockStart(0, { type: 'text', text: '' }),
    A.contentBlockDelta(0, { type: 'text_delta', text: 'a' }),
    A.contentBlockStop(0),
    A.messageStop(),
  ].join('');
  const { body } = collectMessage([blob]);
  assert.equal(body.id, 'msg_8');
  assert.deepEqual(body.content, [{ type: 'text', text: 'a' }]);
});

test('cache_read_input_tokens 透传到非流式 usage', () => {
  const events = [
    A.messageStart('msg_9', 'm'),
    A.messageDelta('end_turn', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 40 }),
    A.messageStop(),
  ];
  const { body } = collectMessage(events);
  assert.equal(body.usage.cache_read_input_tokens, 40);
});
