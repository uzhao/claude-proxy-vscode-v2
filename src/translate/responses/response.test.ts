import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesToClaudeStream } from './response';

function run(payloads: string[]): { events: string[]; raw: string[] } {
  const s = new ResponsesToClaudeStream();
  const raw: string[] = [];
  for (const p of payloads) {
    raw.push(...s.push(p));
  }
  const events = raw.map(e => e.slice('event: '.length, e.indexOf('\n')));
  return { events, raw };
}

function dataOf(raw: string): any {
  return JSON.parse(raw.split('data: ')[1]);
}

test('纯文本流:created→part.added→text.delta→part.done→completed', () => {
  const { events, raw } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.content_part.added"}',
    '{"type":"response.output_text.delta","delta":"Hel"}',
    '{"type":"response.output_text.delta","delta":"lo"}',
    '{"type":"response.content_part.done"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}',
  ]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const md = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.equal(md.usage.output_tokens, 1);
});

test('工具调用流:output_item.added(function_call)→args.delta→item.done→completed', () => {
  const { events, raw } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}',
    '{"type":"response.function_call_arguments.delta","delta":"{\\"cmd\\":\\"ls\\"}"}',
    '{"type":"response.output_item.done","item":{"type":"function_call"}}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
  ]);
  const startRaw = raw.find(r => r.includes('"tool_use"'))!;
  assert.equal(dataOf(startRaw).content_block.name, 'Bash');
  assert.equal(dataOf(startRaw).content_block.id, 'call_1');
  const inputRaw = raw.find(r => r.includes('input_json_delta'))!;
  assert.equal(dataOf(inputRaw).delta.partial_json, '{"cmd":"ls"}');
  const md = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(md.delta.stop_reason, 'tool_use');
});

test('reasoning 流:summary_part.added→summary_text.delta→(content_part)关 thinking', () => {
  const { events } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.reasoning_summary_part.added"}',
    '{"type":"response.reasoning_summary_text.delta","delta":"think"}',
    '{"type":"response.reasoning_summary_part.done"}',
    '{"type":"response.content_part.added"}',
    '{"type":"response.output_text.delta","delta":"ans"}',
    '{"type":"response.content_part.done"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
  ]);
  assert.deepEqual(events.slice(0, 5), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start',
  ]);
});

test('error 事件 → Anthropic 错误', () => {
  const { raw } = run([
    '{"type":"error","error":{"type":"invalid_request","message":"bad"}}',
  ]);
  const ev = dataOf(raw[0]);
  assert.equal(ev.type, 'error');
  assert.equal(ev.error.message, 'bad');
});

test('非法 JSON 负载被忽略', () => {
  const s = new ResponsesToClaudeStream();
  assert.deepEqual(s.push('[DONE]'), []);
  assert.deepEqual(s.push('not json'), []);
});
