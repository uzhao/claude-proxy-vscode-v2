import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexQuota } from './quota';

// 固定 now,用于 reset_after_seconds 路径的确定性断言
// 2026-07-08 12:00:00 本地时间的近似;测试只比较相对结果与格式,不硬编码时区
const NOW = Date.UTC(2026, 6, 8, 4, 0, 0); // 2026-07-08T04:00:00Z

test('parseCodexQuota: 按 limit_window_seconds 分类 5h / 周 窗口', () => {
  const payload = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: 1751961600 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1752480000 },
    },
  };
  const s = parseCodexQuota(payload, NOW);
  assert.equal(s.planType, 'plus');
  assert.equal(s.primaryPercent, 40);
  assert.equal(s.secondaryPercent, 12);
  assert.equal(s.secondaryKind, 'week');
});

test('parseCodexQuota: 月度次窗口识别为 month', () => {
  const payload = {
    rate_limit: {
      primary_window: { used_percent: 5, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 60, limit_window_seconds: 2592000 }, // 30 天
    },
  };
  const s = parseCodexQuota(payload, NOW);
  assert.equal(s.secondaryKind, 'month');
  assert.equal(s.secondaryPercent, 60);
});

test('parseCodexQuota: camelCase 字段兼容', () => {
  const payload = {
    planType: 'pro',
    rateLimit: {
      primaryWindow: { usedPercent: '25', limitWindowSeconds: 18000 },
      secondaryWindow: { usedPercent: '3', limitWindowSeconds: 604800 },
    },
  };
  const s = parseCodexQuota(payload, NOW);
  assert.equal(s.planType, 'pro');
  assert.equal(s.primaryPercent, 25);
  assert.equal(s.secondaryPercent, 3);
});

test('parseCodexQuota: reset_after_seconds 路径取相对时间', () => {
  const payload = {
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 100000 },
    },
  };
  const s = parseCodexQuota(payload, NOW);
  // 取两窗口中最早的一次重置(primary 的 +3600s)→ 非 '-'
  assert.notEqual(s.resetLabel, '-');
});

test('parseCodexQuota: 无窗口时长时按 primary/secondary 顺序回退', () => {
  const payload = {
    rate_limit: {
      primary_window: { used_percent: 70 },
      secondary_window: { used_percent: 8 },
    },
  };
  const s = parseCodexQuota(payload, NOW);
  assert.equal(s.primaryPercent, 70);
  assert.equal(s.secondaryPercent, 8);
});

test('parseCodexQuota: 空 payload 返回全兜底', () => {
  const s = parseCodexQuota(null, NOW);
  assert.equal(s.planType, null);
  assert.equal(s.primaryPercent, null);
  assert.equal(s.secondaryPercent, null);
  assert.equal(s.secondaryKind, null);
  assert.equal(s.resetLabel, '-');
});
