import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIToClaudeStream } from './response';

/** 把一串 OpenAI data 负载喂给转换器,收集所有 Anthropic 事件名 */
function run(payloads: string[]): { events: string[]; raw: string[] } {
  const s = new OpenAIToClaudeStream();
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

test('纯文本流:message_start → block_start/delta → 收尾', () => {
  const { events, raw } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"content":"Hel"}}]}',
    '{"choices":[{"delta":{"content":"lo"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    '[DONE]',
  ]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const delta = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.equal(delta.usage.output_tokens, 1);
});

test('工具调用流:累加 arguments 后在 finish 时出 tool_use + input_json_delta', () => {
  const { events, raw } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Bash","arguments":"{\\"cmd\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
    '[DONE]',
  ]);
  assert.ok(events.includes('content_block_start'));
  const startRaw = raw.find(r => r.includes('"tool_use"'))!;
  assert.equal(dataOf(startRaw).content_block.name, 'Bash');
  assert.equal(dataOf(startRaw).content_block.id, 'call_1');
  const inputRaw = raw.find(r => r.includes('input_json_delta'))!;
  assert.equal(dataOf(inputRaw).delta.partial_json, '{"cmd":"ls"}');
  const delta = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(delta.delta.stop_reason, 'tool_use');
});

test('reasoning 流:出 thinking block 并在文本前关闭', () => {
  const { events } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"reasoning_content":"think"}}]}',
    '{"choices":[{"delta":{"content":"ans"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ]);
  // thinking block 开→delta→(文本到来时)stop→文本 block 开→delta
  assert.deepEqual(events.slice(0, 6), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta',
  ]);
});

test('无 usage 时 [DONE] 兜底出 message_delta + message_stop', () => {
  const { events } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"content":"hi"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ]);
  assert.equal(events.filter(e => e === 'message_delta').length, 1);
  assert.equal(events[events.length - 1], 'message_stop');
});

test('非法 JSON 负载被忽略', () => {
  const s = new OpenAIToClaudeStream();
  assert.deepEqual(s.push('not json'), []);
});
