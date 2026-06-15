import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generatePkce, randomState } from './pkce';

test('verifier 是 URL-safe base64 无填充,长度足够', () => {
  const { verifier } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43);
});

test('challenge = base64url(sha256(verifier)) 无填充', () => {
  const { verifier, challenge } = generatePkce();
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.equal(challenge.includes('='), false);
});

test('两次生成不同;state 非空 URL-safe', () => {
  assert.notEqual(generatePkce().verifier, generatePkce().verifier);
  assert.match(randomState(), /^[A-Za-z0-9_-]+$/);
});
