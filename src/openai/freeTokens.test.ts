import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePool,
  planOpenAIRequest,
  DEFAULT_OPENAI_SETTINGS,
  OpenAIOfficialSettings,
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
