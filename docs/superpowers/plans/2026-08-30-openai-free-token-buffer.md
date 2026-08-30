# OpenAI 免费额度预留缓冲防擦边扣费 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当使用 OpenAI 每日免费额度时，记录各池上一次请求的实际 token 用量作为当前规模估计值；若对应池剩余额度低于该值，则提前停用免费放行，彻底防止超出 1M/10M 上限发生擦边扣费。

**Architecture:**
- 在 `src/openai/freeTokens.ts` 的 `planOpenAIRequest` 中增加 `estimate: (p: Pool) => number` 参数，余量低于估计值时即判定免费额度耗尽（`isFree = false`）。
- 在 `src/proxy.ts` 的 `OpenAIAccess` 接口中加入 `estimate(p: Pool): number`。
- 在 `src/extension.ts` 中维护内存会话级 `lastTokens: Record<Pool, number>`，并在 `add(pool, tokens)` 时同步记录，VS Code 退出或重载时自然清零。

**Tech Stack:** TypeScript, Node.js `node:test`, VS Code Extension API

## Global Constraints
- 分池独立记录：'1M' 池与 '10M' 池分别记录各自的 lastTokens。
- 会话生命周期：内存变量存储，程序退出时自然清零；运行期间跨 UTC 天保留上次经验值。
- 向后兼容：`estimate` 参数缺省为 `() => 0`，不影响现有调用方。

---

### Task 1: 升级 `planOpenAIRequest` 判定逻辑并补充核心单测 (TDD)

**Files:**
- Modify: `src/openai/freeTokens.ts:64-74`
- Test: `src/openai/freeTokens.test.ts`

**Interfaces:**
- Consumes:
  - `POOL_LIMIT: Record<Pool, number>`
  - `resolvePool(model: string): Pool | null`
- Produces:
  - `planOpenAIRequest(model: string, settings: OpenAIOfficialSettings, used: (p: Pool) => number, estimate?: (p: Pool) => number): OpenAIPlan`

- [ ] **Step 1: 编写失败的单元测试**

在 `src/openai/freeTokens.test.ts` 中添加针对 `estimate` 的测试用例：
```ts
test('freeTokensOnly 开 + 余量充足(>= estimate):允许、免费', () => {
  // 1M 池上限 1000k，已用 900k，余量 100k >= 50k
  const p = planOpenAIRequest(
    'gpt-5.5',
    set({ freeTokens: true, freeTokensOnly: true }),
    (pool) => (pool === '1M' ? 900_000 : 0),
    (pool) => (pool === '1M' ? 50_000 : 0),
  );
  assert.deepEqual(p, { allowed: true, flex: false, pool: '1M' });
});

test('freeTokensOnly 开 + 余量不足上次用量(< estimate):提前停用防擦边', () => {
  // 1M 池上限 1000k，已用 980k，余量 20k < 上次用量 30k
  const p = planOpenAIRequest(
    'gpt-5.5',
    set({ freeTokens: true, freeTokensOnly: true }),
    (pool) => (pool === '1M' ? 980_000 : 0),
    (pool) => (pool === '1M' ? 30_000 : 0),
  );
  assert.deepEqual(p, { allowed: false, flex: false, pool: '1M' });
});

test('freeTokens 开 + freeTokensOnly 关 + 余量不足上次用量:转付费并带 flex', () => {
  // 1M 池上限 1000k，已用 980k，余量 20k < 上次用量 30k，允许付费
  const p = planOpenAIRequest(
    'gpt-5.5',
    set({ flex: true, freeTokens: true, freeTokensOnly: false }),
    (pool) => (pool === '1M' ? 980_000 : 0),
    (pool) => (pool === '1M' ? 30_000 : 0),
  );
  assert.deepEqual(p, { allowed: true, flex: true, pool: '1M' });
});

test('estimate 缺省时兼容旧行为(只要余量 > 0 即免费)', () => {
  const p = planOpenAIRequest(
    'gpt-5.5',
    set({ freeTokens: true, freeTokensOnly: true }),
    (pool) => (pool === '1M' ? 999_999 : 0),
  );
  assert.deepEqual(p, { allowed: true, flex: false, pool: '1M' });
});

test('两池隔离:1M 池余量不足停用不影响 10M 池正常使用', () => {
  const used = (pool: '1M' | '10M') => (pool === '1M' ? 990_000 : 100_000);
  const est = (pool: '1M' | '10M') => (pool === '1M' ? 20_000 : 5_000);
  const p1M = planOpenAIRequest('gpt-5.5', set({ freeTokens: true, freeTokensOnly: true }), used, est);
  const p10M = planOpenAIRequest('gpt-5-mini', set({ freeTokens: true, freeTokensOnly: true }), used, est);
  assert.equal(p1M.allowed, false);
  assert.equal(p10M.allowed, true);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`npm test`
预期：编译/断言失败（`planOpenAIRequest` 目前未按 `estimate` 判定）。

- [ ] **Step 3: 实现 `planOpenAIRequest` 缓冲判定逻辑**

在 `src/openai/freeTokens.ts` 中更新实现：
```ts
export function planOpenAIRequest(
  model: string,
  settings: OpenAIOfficialSettings,
  used: (p: Pool) => number,
  estimate: (p: Pool) => number = () => 0,
): OpenAIPlan {
  const pool = resolvePool(model);
  const est = pool != null ? estimate(pool) : 0;
  const isFree = settings.freeTokens && pool != null && (POOL_LIMIT[pool] - used(pool)) >= est;
  const allowed = !settings.freeTokensOnly || isFree;
  const flex = settings.flex && !isFree;
  return { allowed, flex, pool };
}
```

- [ ] **Step 4: 运行测试验证全部通过**

运行：`npm test`
预期：全部 187+ 个测试 PASS。

- [ ] **Step 5: 提交代码**

```bash
git add src/openai/freeTokens.ts src/openai/freeTokens.test.ts
git commit -m "feat(openai): planOpenAIRequest 增加上次 token 用量估计缓冲防擦边扣费"
```

---

### Task 2: 扩展 `OpenAIAccess` 接口并在代理转发与扩展中串联状态

**Files:**
- Modify: `src/proxy.ts:185-190, 449-453`
- Modify: `src/extension.ts:152-162`
- Test: `src/proxy.test.ts`

**Interfaces:**
- Consumes:
  - `planOpenAIRequest` (from `freeTokens.ts`)
  - `extractResponsesUsage` (from `freeTokens.ts`)
- Produces:
  - `OpenAIAccess` with `estimate(p: Pool): number`

- [ ] **Step 1: 编写集成测试**

在 `src/proxy.test.ts` 中添加测试验证代理中 `deps.openai.estimate` 触发 429 拦截：
```ts
test('openai 目标在剩余额度低于 estimate 时返回 429 额度耗尽', async () => {
  const server = createProxyServer({
    getConfig: () => ({
      mapping: 'openai:gpt-5.5',
      providers: [{ name: 'openai', apiKeys: ['sk-mock'] }],
    }),
    openai: {
      settings: () => ({ flex: false, freeTokens: true, freeTokensOnly: true }),
      used: () => 990_000,
      add: () => {},
      estimate: () => 20_000, // 余量 10k < 估计 20k
    },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await post(port, { model: 'claude-x', messages: [] });
    assert.equal(res.status, 429);
    const body = JSON.parse(res.body);
    assert.equal(body.error.type, 'rate_limit_error');
    assert.match(body.error.message, /OpenAI daily free quota exhausted/);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`npm test`
预期：类型检查或测试失败（`OpenAIAccess` 缺少 `estimate`）。

- [ ] **Step 3: 修改 `src/proxy.ts` 与 `src/extension.ts`**

1. 在 `src/proxy.ts` 中：
```ts
export interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
  estimate(p: Pool): number;
}
```
并且在代理请求规划处：
```ts
const plan: OpenAIPlan = planOpenAIRequest(
  target.model,
  deps.openai.settings(),
  (p) => deps.openai!.used(p),
  (p) => deps.openai!.estimate(p),
);
```

2. 在 `src/extension.ts` 中：
```ts
  const lastTokens: Record<'1M' | '10M', number> = { '1M': 0, '10M': 0 };

  // openai 官方免费额度:settings/usage 均存 globalState;used/add 按当前 UTC 日期判断;lastTokens 会话内存
  const openaiAccess = {
    settings: (): OpenAIOfficialSettings =>
      context.globalState.get<OpenAIOfficialSettings>(OPENAI_SETTINGS_KEY, DEFAULT_OPENAI_SETTINGS),
    used: (p: '1M' | '10M'): number =>
      readUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, Date.now()),
    add: (p: '1M' | '10M', tokens: number): void => {
      lastTokens[p] = tokens;
      const next = addUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, tokens, Date.now());
      void context.globalState.update(OPENAI_USAGE_KEY, next);
    },
    estimate: (p: '1M' | '10M'): number => lastTokens[p] ?? 0,
  };
```

- [ ] **Step 4: 运行测试验证全部通过**

运行：`npm test`
预期：所有测试通过无报错。

- [ ] **Step 5: 提交代码**

```bash
git add src/proxy.ts src/extension.ts src/proxy.test.ts
git commit -m "feat(openai): 接入 OpenAIAccess.estimate 并在 add 时记录上一次 token 用量"
```
