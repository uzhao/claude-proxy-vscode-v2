import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePool,
  planOpenAIRequest,
  DEFAULT_OPENAI_SETTINGS,
  OpenAIOfficialSettings,
} from './freeTokens';

import {
  utcDateOf,
  readUsage,
  addUsage,
  extractResponsesUsage,
  OpenAIUsageState,
} from './freeTokens';

const zero = () => 0;
const set = (s: Partial<OpenAIOfficialSettings>): OpenAIOfficialSettings => ({ ...DEFAULT_OPENAI_SETTINGS, ...s });

test('resolvePool 命中 1M / 10M / null', () => {
  assert.equal(resolvePool('gpt-5.5'), '1M');
  assert.equal(resolvePool('o3'), '1M');
  assert.equal(resolvePool('gpt-5.4-mini'), '10M');
  assert.equal(resolvePool('codex-mini-latest'), '10M');
  assert.equal(resolvePool('gpt-9-unknown'), null);
});

test('全部关闭:允许、不 flex、pool 仍按模型解析', () => {
  const p = planOpenAIRequest('gpt-5.5', DEFAULT_OPENAI_SETTINGS, zero);
  assert.deepEqual(p, { allowed: true, flex: false, pool: '1M' });
});

test('flex 开 + 无免费:付费请求注入 flex', () => {
  const p = planOpenAIRequest('gpt-5.5', set({ flex: true }), zero);
  assert.deepEqual(p, { allowed: true, flex: true, pool: '1M' });
});

test('freeTokens 开 + 池有余:免费请求不带 flex', () => {
  const p = planOpenAIRequest('gpt-5.5', set({ flex: true, freeTokens: true }), zero);
  assert.deepEqual(p, { allowed: true, flex: false, pool: '1M' });
});

test('freeTokens 开 + 池用尽:转付费、带 flex', () => {
  const used = () => 1_000_000;
  const p = planOpenAIRequest('gpt-5.5', set({ flex: true, freeTokens: true }), used);
  assert.deepEqual(p, { allowed: true, flex: true, pool: '1M' });
});

test('freeTokens 开 + 模型不在列表:转付费、带 flex', () => {
  const p = planOpenAIRequest('gpt-9-unknown', set({ flex: true, freeTokens: true }), zero);
  assert.deepEqual(p, { allowed: true, flex: true, pool: null });
});

test('freeTokensOnly 开 + 池有余:允许、免费', () => {
  const p = planOpenAIRequest('gpt-5.5', set({ freeTokens: true, freeTokensOnly: true }), zero);
  assert.deepEqual(p, { allowed: true, flex: false, pool: '1M' });
});

test('freeTokensOnly 开 + 池用尽:停用', () => {
  const used = () => 1_000_000;
  const p = planOpenAIRequest('gpt-5.5', set({ flex: true, freeTokens: true, freeTokensOnly: true }), used);
  assert.equal(p.allowed, false);
});

test('freeTokensOnly 开 + 模型不在列表:停用', () => {
  const p = planOpenAIRequest('gpt-9-unknown', set({ freeTokens: true, freeTokensOnly: true }), zero);
  assert.equal(p.allowed, false);
});

const T0 = Date.UTC(2026, 5, 24, 10, 0, 0); // 2026-06-24
const T1 = Date.UTC(2026, 5, 25, 1, 0, 0);  // 2026-06-25(跨天)

test('utcDateOf 输出 YYYY-MM-DD(UTC)', () => {
  assert.equal(utcDateOf(T0), '2026-06-24');
});

test('readUsage:undefined / 同日 / 跨日归零', () => {
  assert.equal(readUsage(undefined, '1M', T0), 0);
  const s: OpenAIUsageState = { utcDate: '2026-06-24', used: { '1M': 500, '10M': 7 } };
  assert.equal(readUsage(s, '1M', T0), 500);
  assert.equal(readUsage(s, '1M', T1), 0); // 跨天视为 0
});

test('addUsage:同日累加 / 跨日重置后再累加', () => {
  const s1 = addUsage(undefined, '1M', 100, T0);
  assert.deepEqual(s1, { utcDate: '2026-06-24', used: { '1M': 100, '10M': 0 } });
  const s2 = addUsage(s1, '1M', 50, T0);
  assert.equal(s2.used['1M'], 150);
  const s3 = addUsage(s2, '1M', 30, T1); // 跨天先归零
  assert.deepEqual(s3, { utcDate: '2026-06-25', used: { '1M': 30, '10M': 0 } });
});

test('extractResponsesUsage:仅 response.completed 返回 input+output', () => {
  const completed = JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: 120, output_tokens: 30 } },
  });
  assert.equal(extractResponsesUsage(completed), 150);
  assert.equal(extractResponsesUsage(JSON.stringify({ type: 'response.output_text.delta', delta: 'x' })), null);
  assert.equal(extractResponsesUsage('not json'), null);
  assert.equal(extractResponsesUsage(JSON.stringify({ type: 'response.completed', response: {} })), 0);
});
