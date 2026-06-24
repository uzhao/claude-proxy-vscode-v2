# OpenAI 官方 endpoint flex / 每日免费额度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给内置 `openai` provider 增加 flex 档位、每日免费额度计量与超额停用三个开关。

**Architecture:** 纯逻辑(模型→池、决策、用量状态、usage 解析)集中在新文件 `src/openai/freeTokens.ts` 并用 `node:test` 单测;proxy.ts 在 openai 转发路径上做前置检查 / flex 注入 / usage 回写,只做薄胶水;extension.ts 用 `globalState` 实现 `OpenAIAccess` 并注入;statusbar.ts 加三个开关 UI。

**Tech Stack:** TypeScript、VSCode Extension API、`node:test` + `node:assert/strict`。

## Global Constraints

- 代码注释/文档用简体中文;运行时 print / log / error message 用英文。
- 测试框架:`node:test` + `node:assert/strict`,文件名 `*.test.ts`,编译后由 `node --test "out/**/*.test.js"` 运行。
- 构建/测试命令统一:`npm test`(= `tsc -p ./ && node --test "out/**/*.test.js"`)。
- 仅作用于内置 `openai` provider(`api.openai.com`);codex / 自定义 provider / 其他内置 provider 不受影响。
- 默认三个开关全部关闭(`DEFAULT_OPENAI_SETTINGS`)。
- 计量口径:`usage.input_tokens + usage.output_tokens`(input 已含缓存)。
- 用量按 UTC 天归零,不使用定时器,读/写时按当前 UTC 日期判断。

---

### Task 1: 免费额度核心(模型→池 + 决策纯函数)

**Files:**
- Create: `src/openai/freeTokens.ts`
- Test: `src/openai/freeTokens.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type Pool = '1M' | '10M'`
  - `const POOL_LIMIT: Record<Pool, number>`
  - `function resolvePool(model: string): Pool | null`
  - `interface OpenAIOfficialSettings { flex: boolean; freeTokens: boolean; freeTokensOnly: boolean }`
  - `const DEFAULT_OPENAI_SETTINGS: OpenAIOfficialSettings`
  - `interface OpenAIPlan { allowed: boolean; flex: boolean; pool: Pool | null }`
  - `function planOpenAIRequest(model: string, settings: OpenAIOfficialSettings, used: (p: Pool) => number): OpenAIPlan`
  - `const OPENAI_SETTINGS_KEY = 'claudeProxy.openaiSettings'`
  - `const OPENAI_USAGE_KEY = 'claudeProxy.openaiUsage'`

- [ ] **Step 1: 写失败测试**

创建 `src/openai/freeTokens.test.ts`:

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 编译失败或断言失败(`freeTokens` 模块/导出不存在)。

- [ ] **Step 3: 写最小实现**

创建 `src/openai/freeTokens.ts`(本步只写到 `planOpenAIRequest`,用量与 usage 解析在 Task 2 追加):

```ts
// OpenAI 官方 endpoint 每日免费额度:模型→池、决策纯函数。

export type Pool = '1M' | '10M';

/** 两个共享池每日上限(token) */
export const POOL_LIMIT: Record<Pool, number> = {
  '1M': 1_000_000,
  '10M': 10_000_000,
};

/** 1M 池(大模型) */
const POOL_1M_MODELS = [
  'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5',
  'gpt-5-codex', 'gpt-5-chat-latest', 'gpt-4.1', 'gpt-4o', 'o1', 'o3',
];

/** 10M 池(mini/nano) */
const POOL_10M_MODELS = [
  'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini', 'o1-mini', 'o3-mini', 'o4-mini',
  'codex-mini-latest',
];

/** 模型属于哪个免费池;不在任何列表返回 null */
export function resolvePool(model: string): Pool | null {
  if (POOL_1M_MODELS.includes(model)) {
    return '1M';
  }
  if (POOL_10M_MODELS.includes(model)) {
    return '10M';
  }
  return null;
}

export interface OpenAIOfficialSettings {
  /** 请求体注入 service_tier: "flex"(仅对付费请求生效) */
  flex: boolean;
  /** 账号参与每日免费额度计划:开启后按 UTC 天计量两个共享池 */
  freeTokens: boolean;
  /** 只用免费额度:对应池用尽 / 模型不在免费列表时,该请求停用 */
  freeTokensOnly: boolean;
}

export const DEFAULT_OPENAI_SETTINGS: OpenAIOfficialSettings = {
  flex: false,
  freeTokens: false,
  freeTokensOnly: false,
};

/** globalState key:设置对象 / 当日用量(放无 vscode 依赖的本文件,避免 extension↔statusbar 循环引用) */
export const OPENAI_SETTINGS_KEY = 'claudeProxy.openaiSettings';
export const OPENAI_USAGE_KEY = 'claudeProxy.openaiUsage';

export interface OpenAIPlan {
  /** false → 该请求停用,返回错误 */
  allowed: boolean;
  /** true → 注入 service_tier: "flex" */
  flex: boolean;
  /** 命中的免费池(用于成功后计量) */
  pool: Pool | null;
}

/** 依据设置与当前用量决定:是否放行、是否 flex、计量到哪个池 */
export function planOpenAIRequest(
  model: string,
  settings: OpenAIOfficialSettings,
  used: (p: Pool) => number,
): OpenAIPlan {
  const pool = resolvePool(model);
  const isFree = settings.freeTokens && pool != null && used(pool) < POOL_LIMIT[pool];
  const allowed = !settings.freeTokensOnly || isFree;
  const flex = settings.flex && !isFree;
  return { allowed, flex, pool };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 上述 9 个用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/openai/freeTokens.ts src/openai/freeTokens.test.ts
git commit -m "feat(openai): 免费额度模型→池与请求决策纯函数"
```

---

### Task 2: 当日用量状态 + usage 解析

**Files:**
- Modify: `src/openai/freeTokens.ts`(追加)
- Modify: `src/openai/freeTokens.test.ts`(追加)

**Interfaces:**
- Consumes: `Pool`(Task 1)
- Produces:
  - `interface OpenAIUsageState { utcDate: string; used: { '1M': number; '10M': number } }`
  - `function utcDateOf(now: number): string`
  - `function readUsage(state: OpenAIUsageState | undefined, pool: Pool, now: number): number`
  - `function addUsage(state: OpenAIUsageState | undefined, pool: Pool, tokens: number, now: number): OpenAIUsageState`
  - `function extractResponsesUsage(payload: string): number | null`

- [ ] **Step 1: 写失败测试**

在 `src/openai/freeTokens.test.ts` 末尾追加(并把 import 改为包含新符号):

```ts
import {
  utcDateOf,
  readUsage,
  addUsage,
  extractResponsesUsage,
  OpenAIUsageState,
} from './freeTokens';

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 编译失败(新导出不存在)。

- [ ] **Step 3: 写最小实现**

在 `src/openai/freeTokens.ts` 末尾追加:

```ts
export interface OpenAIUsageState {
  utcDate: string; // 'YYYY-MM-DD'(UTC)
  used: { '1M': number; '10M': number };
}

/** epoch ms → UTC 'YYYY-MM-DD' */
export function utcDateOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 读某池当日用量;state 缺失或非今日(UTC)视为 0 */
export function readUsage(state: OpenAIUsageState | undefined, pool: Pool, now: number): number {
  if (!state || state.utcDate !== utcDateOf(now)) {
    return 0;
  }
  return state.used[pool] ?? 0;
}

/** 累加某池用量,返回新 state;跨 UTC 天先归零 */
export function addUsage(
  state: OpenAIUsageState | undefined,
  pool: Pool,
  tokens: number,
  now: number,
): OpenAIUsageState {
  const today = utcDateOf(now);
  const base: OpenAIUsageState =
    state && state.utcDate === today ? state : { utcDate: today, used: { '1M': 0, '10M': 0 } };
  return {
    utcDate: today,
    used: { ...base.used, [pool]: (base.used[pool] ?? 0) + tokens },
  };
}

/** 解析一条 Responses SSE data 负载:response.completed → input+output;否则 null */
export function extractResponsesUsage(payload: string): number | null {
  let root: any;
  try {
    root = JSON.parse(payload);
  } catch {
    return null;
  }
  if (root?.type !== 'response.completed') {
    return null;
  }
  const u = root.response?.usage ?? {};
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 新增 4 个用例 + Task 1 的 9 个全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/openai/freeTokens.ts src/openai/freeTokens.test.ts
git commit -m "feat(openai): 当日用量状态(UTC 归零)与 Responses usage 解析"
```

---

### Task 3: proxy 接入(前置检查 / flex 注入 / usage 回写)

**Files:**
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: `planOpenAIRequest`, `extractResponsesUsage`, `Pool`, `OpenAIOfficialSettings`(Task 1/2)
- Produces:
  - `interface OpenAIAccess { settings(): OpenAIOfficialSettings; used(p: Pool): number; add(p: Pool, tokens: number): void }`
  - `ProxyServerDeps` 增加可选成员 `openai?: OpenAIAccess`

> 说明:proxy 的流式转发路径未在仓库里做 HTTP 级单测(`proxy.test.ts` 只测纯函数),
> 本任务的逻辑均为对 Task 1/2 已测纯函数的薄胶水,验证以 `npm test` 通过(编译 + 既有测试不回归)为准。

- [ ] **Step 1: 引入依赖与类型**

在 `src/proxy.ts` 顶部 import 区追加:

```ts
import { planOpenAIRequest, extractResponsesUsage, OpenAIPlan, Pool, OpenAIOfficialSettings } from './openai/freeTokens';
```

在 `CodexAccess` 接口之后、`ProxyServerDeps` 之前新增:

```ts
/** openai 官方免费额度访问:读设置 / 读当日用量 / 累加用量 */
export interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
}
```

把 `ProxyServerDeps` 改为:

```ts
export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** codex 多账号凭证访问;未登录时 count() 返回 0 */
  codex?: CodexAccess;
  /** openai 官方免费额度访问;未注入则不做额度限制 */
  openai?: OpenAIAccess;
}
```

- [ ] **Step 2: 计算 plan + 前置检查 + flex 注入**

在 `src/proxy.ts` 的 translator 请求体构造分支里(当前):

```ts
          if (translator) {
            // 格式转换路径(openai 系):换端点 + 请求体转换
            targetUrl = `${target.preset.baseUrl}${translator.endpointPath}`;
            const upstreamBody = translator.buildRequest(requestBody ?? {}, target.model);
            targetBody = Buffer.from(JSON.stringify(upstreamBody), 'utf8');
          } else {
```

改为(新增 openai plan 检查与 flex 注入;`openaiPool` 在更外层声明以供流式回写使用):

```ts
          if (translator) {
            // 格式转换路径(openai 系):换端点 + 请求体转换
            targetUrl = `${target.preset.baseUrl}${translator.endpointPath}`;
            const upstreamBody = translator.buildRequest(requestBody ?? {}, target.model);
            // openai 官方:免费额度决策(停用 / flex 注入 / 计量池)
            if (target.preset.id === 'openai' && deps.openai) {
              const plan: OpenAIPlan = planOpenAIRequest(
                target.model, deps.openai.settings(), (p) => deps.openai!.used(p),
              );
              if (!plan.allowed) {
                const msg = plan.pool
                  ? `OpenAI daily free quota exhausted (${plan.pool} pool), resets at UTC 00:00.`
                  : `Model "${target.model}" is not eligible for OpenAI free quota.`;
                console.warn(`[proxy] openai blocked: ${msg}`);
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(anthropicError('rate_limit_error', msg));
                return;
              }
              openaiPool = plan.pool;
              if (plan.flex) {
                (upstreamBody as any).service_tier = 'flex';
              }
            }
            targetBody = Buffer.from(JSON.stringify(upstreamBody), 'utf8');
          } else {
```

在 `if (target) {` 这一块**之前**(`let apiKeys: string[] = [];` 附近)声明:

```ts
        let openaiPool: Pool | null = null;
```

- [ ] **Step 3: 流式响应里回写用量**

在泛型 key 轮换路径的 translator 流式循环里(当前):

```ts
                  for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    for (const event of stream.push(payload)) {
```

改为(在喂给 stream 之前抓 usage;此循环位于 `tryKeys` 内、非 codex 分支):

```ts
                  for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    if (openaiPool && deps.openai) {
                      const u = extractResponsesUsage(payload);
                      if (u != null) {
                        deps.openai.add(openaiPool, u);
                      }
                    }
                    for (const event of stream.push(payload)) {
```

> 注意:codex 分支有它自己的流式循环,**不要**改动;openai 只走泛型 `tryKeys` 路径。

- [ ] **Step 4: 运行测试 + 编译确认通过**

Run: `npm test`
Expected: 编译通过,既有全部测试不回归(无新增失败)。

- [ ] **Step 5: 提交**

```bash
git add src/proxy.ts
git commit -m "feat(proxy): openai 免费额度前置检查/flex 注入/usage 回写"
```

---

### Task 4: extension 装配(globalState 实现 OpenAIAccess)

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `OpenAIAccess`(Task 3);`OpenAIOfficialSettings`, `DEFAULT_OPENAI_SETTINGS`, `OpenAIUsageState`, `readUsage`, `addUsage`, `OPENAI_SETTINGS_KEY`, `OPENAI_USAGE_KEY`(Task 1/2)
- Produces:无对外接口

> 说明:extension 装配无单测(依赖 vscode 运行时),验证以 `npm test` 编译通过为准。

- [ ] **Step 1: 引入依赖**

在 `src/extension.ts` import 区追加:

```ts
import {
  OpenAIOfficialSettings, DEFAULT_OPENAI_SETTINGS, OpenAIUsageState, readUsage, addUsage,
  OPENAI_SETTINGS_KEY, OPENAI_USAGE_KEY,
} from './openai/freeTokens';
```

- [ ] **Step 2: 构造 OpenAIAccess 并注入**

在 `createProxyServer({ ... })` 调用前定义:

```ts
  // openai 官方免费额度:settings/usage 均存 globalState;used/add 按当前 UTC 日期判断
  const openaiAccess = {
    settings: (): OpenAIOfficialSettings =>
      context.globalState.get<OpenAIOfficialSettings>(OPENAI_SETTINGS_KEY, DEFAULT_OPENAI_SETTINGS),
    used: (p: '1M' | '10M'): number =>
      readUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, Date.now()),
    add: (p: '1M' | '10M', tokens: number): void => {
      const next = addUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, tokens, Date.now());
      void context.globalState.update(OPENAI_USAGE_KEY, next);
    },
  };
```

把 `createProxyServer` 的入参改为包含 `openai`:

```ts
  server = createProxyServer({
      getConfig,
      codex: {
        count: () => codexAuth.count(),
        startIndex: () => codexAuth.startIndex(),
        validAt: (i) => codexAuth.validAt(i),
        markSuccess: (i) => codexAuth.markSuccess(i),
      },
      openai: openaiAccess,
    });
```

- [ ] **Step 3: 编译确认通过**

Run: `npm test`
Expected: 编译通过,既有测试不回归。

- [ ] **Step 4: 提交**

```bash
git add src/extension.ts
git commit -m "feat(extension): globalState 装配 openai 免费额度访问并注入 proxy"
```

---

### Task 5: statusbar 三个开关 UI

**Files:**
- Modify: `src/statusbar.ts`

**Interfaces:**
- Consumes: `OpenAIOfficialSettings`, `DEFAULT_OPENAI_SETTINGS`, `OPENAI_SETTINGS_KEY`(Task 1)
- Produces:无对外接口(纯 UI)

> 说明:statusbar UI 在仓库里无单测,验证以 `npm test` 编译通过 + 手动确认为准。

- [ ] **Step 1: 引入依赖**

在 `src/statusbar.ts` import 区追加:

```ts
import { OpenAIOfficialSettings, DEFAULT_OPENAI_SETTINGS, OPENAI_SETTINGS_KEY } from './openai/freeTokens';
```

- [ ] **Step 2: openai 选项进入专属子菜单**

在 `providerSettings()` 末尾处理 `picked.id` 的分支:

```ts
    if (picked.id) {
      await this.manageKeys(picked.id);
    }
```

改为:

```ts
    if (picked.id === 'openai') {
      await this.manageOpenAI();
      return;
    }
    if (picked.id) {
      await this.manageKeys(picked.id);
    }
```

- [ ] **Step 3: 新增 manageOpenAI 子菜单**

在 `manageCodex()` 方法之后新增:

```ts
  // ---- openai 官方:管理 key + flex / 免费额度三开关 ----
  private async manageOpenAI(): Promise<void> {
    type OItem = vscode.QuickPickItem & { keys?: boolean; toggle?: keyof OpenAIOfficialSettings };
    const ctx = this.deps.context;
    const s = ctx.globalState.get<OpenAIOfficialSettings>(OPENAI_SETTINGS_KEY, DEFAULT_OPENAI_SETTINGS);
    const mark = (b: boolean) => (b ? '$(check) 开' : '$(circle-slash) 关');
    const items: OItem[] = [
      { label: '$(key) 管理 API key', keys: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'flex 档位', description: mark(s.flex), toggle: 'flex' },
      { label: '每日免费额度', description: mark(s.freeTokens), toggle: 'freeTokens' },
      { label: '仅用免费额度', description: mark(s.freeTokensOnly), toggle: 'freeTokensOnly' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'openai 官方设置' });
    if (!picked) {
      return;
    }
    if (picked.keys) {
      await this.manageKeys('openai');
      return;
    }
    if (picked.toggle) {
      const next: OpenAIOfficialSettings = { ...s, [picked.toggle]: !s[picked.toggle] };
      await ctx.globalState.update(OPENAI_SETTINGS_KEY, next);
      await this.manageOpenAI(); // 切换后刷新菜单
    }
  }
```

- [ ] **Step 4: 编译确认通过**

Run: `npm test`
Expected: 编译通过,既有测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/statusbar.ts
git commit -m "feat(statusbar): openai 官方 flex/免费额度三开关子菜单"
```

---

## Self-Review

- **Spec coverage:**
  - 三开关 + 默认全关 → Task 1(类型/默认)、Task 5(UI)。
  - 两共享池 + 模型列表 + 计量口径 → Task 1(`resolvePool`/`POOL_LIMIT`)、Task 2(`extractResponsesUsage`)。
  - UTC 归零用量 → Task 2(`readUsage`/`addUsage`)、Task 4(globalState 装配)。
  - 决策(allowed/flex/pool、flex 仅付费、freeTokensOnly 停用)→ Task 1(`planOpenAIRequest`)。
  - proxy 前置检查 / flex 注入 / usage 回写 → Task 3。
  - 仅作用于内置 openai → Task 3(`target.preset.id === 'openai'` 守卫)。
  - 不做用量 UI → 已在范围内排除,无对应任务(符合预期)。
- **Placeholder scan:** 无 TBD/TODO;所有代码步骤均给出完整代码。
- **Type consistency:** `Pool`('1M'|'10M')、`OpenAIOfficialSettings`、`OpenAIPlan`、`OpenAIUsageState`、`OpenAIAccess`、`OPENAI_SETTINGS_KEY`/`OPENAI_USAGE_KEY`、`planOpenAIRequest`/`readUsage`/`addUsage`/`extractResponsesUsage` 在各任务间签名一致。
