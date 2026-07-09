import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexQuota, formatCodexQuotaSummary, fetchCodexQuota, CODEX_USAGE_URL } from './quota';

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

test('formatCodexQuotaSummary: 完整字段拼成一行', () => {
  const line = formatCodexQuotaSummary({
    planType: 'plus',
    primaryPercent: 40,
    secondaryPercent: 12,
    secondaryKind: 'week',
    resetLabel: '07-08 14:30',
  });
  assert.equal(line, 'Plus · 5h 40% · 周 12% · 重置 07-08 14:30');
});

test('formatCodexQuotaSummary: 月度次窗口用「月」', () => {
  const line = formatCodexQuotaSummary({
    planType: 'team',
    primaryPercent: 5,
    secondaryPercent: 60,
    secondaryKind: 'month',
    resetLabel: '-',
  });
  assert.equal(line, 'Team · 5h 5% · 月 60%');
});

test('formatCodexQuotaSummary: 缺字段兜底(无 plan、百分比为 null、无重置)', () => {
  const line = formatCodexQuotaSummary({
    planType: null,
    primaryPercent: null,
    secondaryPercent: null,
    secondaryKind: null,
    resetLabel: '-',
  });
  assert.equal(line, '5h - · 周 -');
});

test('formatCodexQuotaSummary: 百分比四舍五入', () => {
  const line = formatCodexQuotaSummary({
    planType: null,
    primaryPercent: 40.6,
    secondaryPercent: 12.2,
    secondaryKind: 'week',
    resetLabel: '-',
  });
  assert.equal(line, '5h 41% · 周 12%');
});

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async (_url: string, init?: any) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    // 供断言 header
    _init: init,
  })) as unknown as typeof fetch;
}

test('fetchCodexQuota: 2xx 返回解析后的 payload,并带正确请求头', async () => {
  let seenInit: any;
  let seenUrl: any;
  const fetcher = (async (url: string, init?: any) => {
    seenUrl = url;
    seenInit = init;
    return { ok: true, status: 200, json: async () => ({ plan_type: 'plus' }), text: async () => '' };
  }) as unknown as typeof fetch;

  const payload = await fetchCodexQuota('tok-abc', 'acc-123', fetcher);
  assert.equal(payload.plan_type, 'plus');
  assert.equal(seenInit.method, 'GET');
  assert.equal(seenInit.headers['Authorization'], 'Bearer tok-abc');
  assert.equal(seenInit.headers['Chatgpt-Account-Id'], 'acc-123');
  assert.equal(seenUrl, CODEX_USAGE_URL);
  assert.equal(seenInit.headers['User-Agent'], 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal');
});

test('fetchCodexQuota: accountId 为空时不带 Chatgpt-Account-Id 头', async () => {
  let seenInit: any;
  const fetcher = (async (_url: string, init?: any) => {
    seenInit = init;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  }) as unknown as typeof fetch;

  await fetchCodexQuota('tok', '', fetcher);
  assert.equal('Chatgpt-Account-Id' in seenInit.headers, false);
});

test('fetchCodexQuota: 非 2xx 抛错且带 status', async () => {
  await assert.rejects(
    () => fetchCodexQuota('tok', 'acc', mockFetch(401, 'unauthorized')),
    (err: any) => err.status === 401,
  );
});

test('parseCodexQuota: resetLabel 取更早窗口并格式化 (reset_after_seconds 路径)', () => {
  const now = Date.UTC(2026, 6, 8, 4, 0, 0);
  const payload = {
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 7200 },   // +2h
      secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 3600 }, // +1h,更早
    },
  };
  const s = parseCodexQuota(payload, now);
  const d = new Date(Math.floor(now / 1000 + 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  assert.equal(s.resetLabel, expected);
});

test('parseCodexQuota: resetLabel 走 reset_at 路径并格式化', () => {
  const resetAt = 1752480000; // 固定 unix 秒
  const payload = {
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: resetAt + 10000 },
      secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: resetAt }, // 更早
    },
  };
  const s = parseCodexQuota(payload, Date.UTC(2026, 6, 8, 4, 0, 0));
  const d = new Date(resetAt * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const expected = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  assert.equal(s.resetLabel, expected);
});
