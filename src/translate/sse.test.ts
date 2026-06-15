import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, sseEvent } from './sse';

test('SSEParser 提取 data 负载、忽略 event 行与空行', () => {
  const p = new SSEParser();
  const out = p.push('event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('SSEParser 跨 chunk 半行缓冲', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: {"x":'), []);
  assert.deepEqual(p.push('1}\n\n'), ['{"x":1}']);
});

test('SSEParser 识别 [DONE] 并处理 CRLF', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: [DONE]\r\n\r\n'), ['[DONE]']);
});

test('sseEvent 序列化为 event/data 两行加空行', () => {
  assert.equal(sseEvent('message_stop', { type: 'message_stop' }),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});
