// 官方 usage 接口 payload 的宽松类型(兼容 snake_case 与 camelCase)
export interface CodexUsageWindow {
  used_percent?: number | string;
  usedPercent?: number | string;
  limit_window_seconds?: number | string;
  limitWindowSeconds?: number | string;
  reset_after_seconds?: number | string;
  resetAfterSeconds?: number | string;
  reset_at?: number | string;
  resetAt?: number | string;
}

export interface CodexRateLimitInfo {
  primary_window?: CodexUsageWindow | null;
  primaryWindow?: CodexUsageWindow | null;
  secondary_window?: CodexUsageWindow | null;
  secondaryWindow?: CodexUsageWindow | null;
}

export interface CodexUsagePayload {
  plan_type?: string;
  planType?: string;
  rate_limit?: CodexRateLimitInfo | null;
  rateLimit?: CodexRateLimitInfo | null;
}

export interface CodexQuotaSummary {
  planType: string | null;
  primaryPercent: number | null;
  secondaryPercent: number | null;
  secondaryKind: 'week' | 'month' | null;
  resetLabel: string;
}

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CODEX_USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const MIN_MONTH_SECONDS = 28 * 24 * 60 * 60; // 2419200
const MAX_MONTH_SECONDS = 31 * 24 * 60 * 60; // 2678400

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function windowSeconds(w: CodexUsageWindow): number | null {
  return toNumber(w.limit_window_seconds ?? w.limitWindowSeconds);
}

function isMonthly(w: CodexUsageWindow): boolean {
  const s = windowSeconds(w);
  return s !== null && s >= MIN_MONTH_SECONDS && s <= MAX_MONTH_SECONDS;
}

function usedPercent(w: CodexUsageWindow): number | null {
  return toNumber(w.used_percent ?? w.usedPercent);
}

function windowResetEpoch(w: CodexUsageWindow, nowMs: number): number | null {
  const resetAt = toNumber(w.reset_at ?? w.resetAt);
  if (resetAt !== null && resetAt > 0) {
    return resetAt;
  }
  const after = toNumber(w.reset_after_seconds ?? w.resetAfterSeconds);
  if (after !== null && after > 0) {
    return Math.floor(nowMs / 1000 + after);
  }
  return null;
}

function formatUnixSeconds(sec: number): string {
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) {
    return '-';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseCodexQuota(
  payload: CodexUsagePayload | null | undefined,
  nowMs: number = Date.now(),
): CodexQuotaSummary {
  const empty: CodexQuotaSummary = {
    planType: null,
    primaryPercent: null,
    secondaryPercent: null,
    secondaryKind: null,
    resetLabel: '-',
  };
  if (!payload || typeof payload !== 'object') {
    return empty;
  }

  const planRaw = payload.plan_type ?? payload.planType;
  const planType = typeof planRaw === 'string' && planRaw.trim() ? planRaw.trim() : null;

  const rl = payload.rate_limit ?? payload.rateLimit ?? null;
  const primary = rl?.primary_window ?? rl?.primaryWindow ?? null;
  const secondary = rl?.secondary_window ?? rl?.secondaryWindow ?? null;

  let fiveHour: CodexUsageWindow | null = null;
  let longWindow: CodexUsageWindow | null = null;
  for (const w of [primary, secondary]) {
    if (!w) {
      continue;
    }
    const s = windowSeconds(w);
    if (s === FIVE_HOUR_SECONDS && !fiveHour) {
      fiveHour = w;
    } else if ((s === WEEK_SECONDS || isMonthly(w)) && !longWindow) {
      longWindow = w;
    }
  }
  // 旧 payload 无窗口时长:回退到 primary/secondary 顺序
  if (!fiveHour && primary && primary !== longWindow) {
    fiveHour = primary;
  }
  if (!longWindow && secondary && secondary !== fiveHour) {
    longWindow = secondary;
  }

  const secondaryKind: 'week' | 'month' | null = longWindow
    ? (isMonthly(longWindow) ? 'month' : 'week')
    : null;

  const resets: number[] = [];
  for (const w of [fiveHour, longWindow]) {
    if (!w) {
      continue;
    }
    const e = windowResetEpoch(w, nowMs);
    if (e !== null) {
      resets.push(e);
    }
  }
  const resetLabel = resets.length ? formatUnixSeconds(Math.min(...resets)) : '-';

  return {
    planType,
    primaryPercent: fiveHour ? usedPercent(fiveHour) : null,
    secondaryPercent: longWindow ? usedPercent(longWindow) : null,
    secondaryKind,
    resetLabel,
  };
}

export function formatCodexQuotaSummary(s: CodexQuotaSummary): string {
  const parts: string[] = [];
  if (s.planType) {
    parts.push(s.planType.charAt(0).toUpperCase() + s.planType.slice(1));
  }
  const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v)}%`);
  parts.push(`5h ${pct(s.primaryPercent)}`);
  const secLabel = s.secondaryKind === 'month' ? '月' : '周';
  parts.push(`${secLabel} ${pct(s.secondaryPercent)}`);
  if (s.resetLabel && s.resetLabel !== '-') {
    parts.push(`重置 ${s.resetLabel}`);
  }
  return parts.join(' · ');
}

export async function fetchCodexQuota(
  accessToken: string,
  accountId: string,
  fetcher: typeof fetch = fetch,
): Promise<CodexUsagePayload> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': CODEX_USER_AGENT,
  };
  if (accountId) {
    headers['Chatgpt-Account-Id'] = accountId;
  }
  const res = await fetcher(CODEX_USAGE_URL, { method: 'GET', headers } as any);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`codex usage request failed: ${res.status} ${text}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as CodexUsagePayload;
}
