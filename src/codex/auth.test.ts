import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from './auth';

test('isExpired:剩余 < 60s 视为过期', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now + 30_000, now), true);
  assert.equal(isExpired(now + 120_000, now), false);
  assert.equal(isExpired(now - 1, now), true);
});
