# Codex quota 在账号菜单里显示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Provider 设置 → codex 账号列表里,每个账号一行显示当前 quota 摘要 + 最近重置时间。

**Architecture:** 新增单一职责模块 `src/codex/quota.ts`(纯解析/格式化函数 + 一个直连官方 usage 接口的 fetch),再在 `src/statusbar.ts` 的 `manageCodex()` 里同步拉取并填进每个账号 QuickPick item 的 `description`。本扩展本地持有各账号 access token,直接 `fetch` 官方接口,不走参考实现的服务端代理。

**Tech Stack:** TypeScript (CommonJS, ES2020),VSCode Extension API,测试用 `node:test` + `node:assert/strict`。

## Global Constraints

- 测试框架:`node:test` + `node:assert/strict`,文件名 `*.test.ts`,`import { test } from 'node:test'`。
- 网络请求可注入:fetch 函数用默认参数 `fetcher: typeof fetch = fetch`(照 `src/codex/oauth.ts` 模式)以便测试。
- 严格模式 TS(`strict: true`),编译命令 `npm run compile`,测试命令 `npm test`。
- 官方接口常量:`CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'`;User-Agent `codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal`。
- 不做缓存、不含 code review / additional 限额、不做重置额度(YAGNI)。

---

### Task 1: quota 类型 + `parseCodexQuota` 纯函数

**Files:**
- Create: `src/codex/quota.ts`
- Test: `src/codex/quota.test.ts`

**Interfaces:**
- Consumes: 无(叶子模块)。
- Produces:
  - `interface CodexUsageWindow`、`interface CodexRateLimitInfo`、`interface CodexUsagePayload`(官方接口 payload 的宽松类型,兼容 snake_case 与 camelCase)。
  - `interface CodexQuotaSummary { planType: string | null; primaryPercent: number | null; secondaryPercent: number | null; secondaryKind: 'week' | 'month' | null; resetLabel: string; }`
  - `function parseCodexQuota(payload: CodexUsagePayload | null | undefined, nowMs?: number): CodexQuotaSummary`

- [ ] **Step 1: 写失败测试**

在 `src/codex/quota.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL —— 编译或运行报 `parseCodexQuota` 未导出 / 模块 `./quota` 不存在。

- [ ] **Step 3: 写最小实现**

在 `src/codex/quota.ts`:

```ts
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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS —— 上述 6 个 `parseCodexQuota` 测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/codex/quota.ts src/codex/quota.test.ts
git commit -m "feat(codex): parseCodexQuota 解析官方 usage payload"
```

---

### Task 2: `formatCodexQuotaSummary` 纯函数

**Files:**
- Modify: `src/codex/quota.ts`
- Test: `src/codex/quota.test.ts`

**Interfaces:**
- Consumes: `CodexQuotaSummary`(Task 1)。
- Produces: `function formatCodexQuotaSummary(s: CodexQuotaSummary): string` —— 生成一行中文 description,如 `Plus · 5h 40% · 周 12% · 重置 07-08 14:30`。

- [ ] **Step 1: 写失败测试**

追加到 `src/codex/quota.test.ts`(顶部 import 改为 `import { parseCodexQuota, formatCodexQuotaSummary } from './quota';`):

```ts
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL —— `formatCodexQuotaSummary` 未导出。

- [ ] **Step 3: 写最小实现**

在 `src/codex/quota.ts` 末尾追加:

```ts
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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS —— Task 1 与 Task 2 全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/codex/quota.ts src/codex/quota.test.ts
git commit -m "feat(codex): formatCodexQuotaSummary 生成 quota 摘要文案"
```

---

### Task 3: `fetchCodexQuota` 直连官方 usage 接口

**Files:**
- Modify: `src/codex/quota.ts`
- Test: `src/codex/quota.test.ts`

**Interfaces:**
- Consumes: `CodexUsagePayload`(Task 1)。
- Produces:
  - `const CODEX_USAGE_URL: string`
  - `function fetchCodexQuota(accessToken: string, accountId: string, fetcher?: typeof fetch): Promise<CodexUsagePayload>` —— GET usage 接口,非 2xx 抛带 `status` 的错误,2xx 返回解析后的 JSON。

- [ ] **Step 1: 写失败测试**

追加到 `src/codex/quota.test.ts`(import 追加 `fetchCodexQuota`):

```ts
import { fetchCodexQuota } from './quota';

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
  const fetcher = (async (_url: string, init?: any) => {
    seenInit = init;
    return { ok: true, status: 200, json: async () => ({ plan_type: 'plus' }), text: async () => '' };
  }) as unknown as typeof fetch;

  const payload = await fetchCodexQuota('tok-abc', 'acc-123', fetcher);
  assert.equal(payload.plan_type, 'plus');
  assert.equal(seenInit.method, 'GET');
  assert.equal(seenInit.headers['Authorization'], 'Bearer tok-abc');
  assert.equal(seenInit.headers['Chatgpt-Account-Id'], 'acc-123');
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: FAIL —— `fetchCodexQuota` / `CODEX_USAGE_URL` 未导出。

- [ ] **Step 3: 写最小实现**

在 `src/codex/quota.ts` 顶部(类型下方)加常量,并在末尾追加函数:

```ts
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CODEX_USER_AGENT = 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal';

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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS —— 3 个 `fetchCodexQuota` 测试通过,quota.test.ts 整体全绿。

- [ ] **Step 5: 提交**

```bash
git add src/codex/quota.ts src/codex/quota.test.ts
git commit -m "feat(codex): fetchCodexQuota 直连官方 usage 接口"
```

---

### Task 4: 接线到 `manageCodex()` 账号菜单

**Files:**
- Modify: `src/statusbar.ts`(顶部 import;`manageCodex()` 方法 line 223-256;文件末尾加模块级 `withTimeout` helper)

**Interfaces:**
- Consumes: `fetchCodexQuota`、`parseCodexQuota`、`formatCodexQuotaSummary`(Task 1-3);`this.deps.codexAuth.list()` 与 `this.deps.codexAuth.validAt(i)`(现有)。
- Produces: 无对外接口(UI 行为)。

- [ ] **Step 1: 顶部加 import**

在 `src/statusbar.ts` 现有 import 区(第 6 行 `OpenAIOfficialSettings` import 之后)加:

```ts
import { fetchCodexQuota, parseCodexQuota, formatCodexQuotaSummary } from './codex/quota';
```

- [ ] **Step 2: 改写 `manageCodex()` 的账号列表构建**

把 `manageCodex()` 开头(现 line 224-230)从:

```ts
    type CItem = vscode.QuickPickItem & { accountId?: string; login?: boolean; import?: boolean };
    const accounts = await this.deps.codexAuth.list();
    const items: CItem[] = accounts.map(a => ({
      label: `$(account) ${a.email || a.accountId || '(unknown)'}`,
      description: '点击登出此账号',
      accountId: a.accountId,
    }));
```

改为:

```ts
    type CItem = vscode.QuickPickItem & { accountId?: string; login?: boolean; import?: boolean };
    const accounts = await this.deps.codexAuth.list();

    // 并行拉取各账号 quota(每个 4s 超时,失败不阻塞菜单),显示在 description 行
    const descriptions = accounts.length
      ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '获取 codex quota…' },
          () => Promise.all(accounts.map((_, i) => this.codexQuotaDescription(i))),
        )
      : [];

    const items: CItem[] = accounts.map((a, i) => ({
      label: `$(account) ${a.email || a.accountId || '(unknown)'}`,
      description: descriptions[i],
      accountId: a.accountId,
    }));
```

`manageCodex()` 其余部分(分隔符、登录/导入项、picked 分支处理)保持不变。

- [ ] **Step 3: 在 `manageCodex()` 之后加私有方法 `codexQuotaDescription`**

在 `manageCodex()` 方法结束的 `}` 之后、`manageOpenAI()` 之前,插入:

```ts
  /** 取第 i 个账号的 quota 摘要文案;任何失败(未登录/网络/超时)返回提示文案 */
  private async codexQuotaDescription(index: number): Promise<string> {
    try {
      const cred = await this.deps.codexAuth.validAt(index);
      if (!cred) {
        return 'quota 获取失败';
      }
      const payload = await withTimeout(fetchCodexQuota(cred.accessToken, cred.accountId), 4000);
      return formatCodexQuotaSummary(parseCodexQuota(payload));
    } catch {
      return 'quota 获取失败';
    }
  }
```

- [ ] **Step 4: 文件末尾加 `withTimeout` helper**

在 `src/statusbar.ts` 末尾的 `function mask(...)` 旁边(模块级,class 外)追加:

```ts
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
```

- [ ] **Step 5: 编译,确认通过**

Run: `npm run compile`
Expected: 无 TS 报错,`out/` 生成成功。

- [ ] **Step 6: 跑全量测试,确认无回归**

Run: `npm test`
Expected: PASS —— 包含 quota.test.ts 在内的所有测试通过。

- [ ] **Step 7: 手动冒烟(需真实 codex 账号)**

在 VSCode 里按 F5 启动扩展宿主 → 状态栏点 Claude Proxy → `$(gear) Provider 设置` → 选 `codex` →
预期:通知区短暂出现「获取 codex quota…」转圈,随后账号列表每个账号右侧显示形如
`Plus · 5h 40% · 周 12% · 重置 07-08 14:30` 的摘要;拉取失败的账号显示「quota 获取失败」。
登录/导入/登出动作行为与之前一致。

- [ ] **Step 8: 提交**

```bash
git add src/statusbar.ts
git commit -m "feat(codex): 账号菜单显示各账号 quota 摘要"
```

---

## 附:实现完成后

功能完成、`npm test` 与 `npm run compile` 均通过后,用 superpowers:finishing-a-development-branch
决定合并/PR/清理。
