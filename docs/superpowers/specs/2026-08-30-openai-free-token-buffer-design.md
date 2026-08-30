# OpenAI 免费额度预留缓冲防擦边扣费设计规范

## 1. 背景与目标

### 1.1 背景
OpenAI 官方账号每日为指定模型提供共享免费额度池（大模型 1M 池与 mini/nano 10M 池）。
当前代理在放行判定时使用 `used(pool) < POOL_LIMIT[pool]` 规则：
只要当前已用量未严格达到池上限（例如上限 1M，已用 995k），该请求就会作为免费请求放行。
然而，单次请求通常消耗数千至数万 tokens，该请求结束后总用量将超出 1M（例如达到 1,005k），超出的 5k tokens 会被 OpenAI 直接计入付费账单从绑卡扣费（即“擦边扣费”）。

### 1.2 目标
- 记录每个池（1M 池与 10M 池）上一次请求实际消耗的 token 用量作为当前请求的规模预估值。
- 当对应池的剩余额度（`POOL_LIMIT[pool] - used(pool)`）小于该预估值时，即认定免费额度已耗尽，提前停用，杜绝擦边扣费。
- 该估算值存储在扩展会话内存中，VS Code 退出或重载时自然清零；运行期跨 UTC 天保留上次经验值。

---

## 2. 核心架构与设计

### 2.1 统计维度与生命周期
- **分池独立记录**：
  - 1M 池（gpt-5.5, o3 等高消耗模型）与 10M 池（mini/nano 等轻量模型）分别维护独立的上次用量值 `lastTokens['1M']` 与 `lastTokens['10M']`。
- **内存会话生命周期**：
  - 在 VS Code 扩展运行期内存中维护，无需持久化到 `globalState`。
  - 初始值均为 0。
  - 程序退出或重载窗口时自动清零重置。
  - 运行中即使 UTC 00:00 刷新每日用量，估计值依然保留上一次的合理经验值。

### 2.2 决策判定逻辑 (`src/openai/freeTokens.ts`)
纯函数 `planOpenAIRequest` 增加 `estimate: (p: Pool) => number` 回调（缺省为 `() => 0`）：

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

- 当 `remaining < est` 时：
  - 若开启 `settings.freeTokensOnly`：`allowed = false`，请求被代理直接拦截。
  - 若未开启 `settings.freeTokensOnly`：`allowed = true, isFree = false`，平滑降级为付费请求（若开 `flex` 则携带 flex 标志）。

### 2.3 接口与运行时管理

#### 2.3.1 `OpenAIAccess` 接口扩展 (`src/proxy.ts`)
```ts
export interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
  estimate(p: Pool): number;
}
```

#### 2.3.2 `extension.ts` 中的状态封装
```ts
const lastTokens: Record<Pool, number> = { '1M': 0, '10M': 0 };

const openaiAccess: OpenAIAccess = {
  settings: () =>
    context.globalState.get<OpenAIOfficialSettings>(OPENAI_SETTINGS_KEY, DEFAULT_OPENAI_SETTINGS),
  used: (p: Pool): number =>
    readUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, Date.now()),
  add: (p: Pool, tokens: number): void => {
    lastTokens[p] = tokens;
    const next = addUsage(context.globalState.get<OpenAIUsageState>(OPENAI_USAGE_KEY), p, tokens, Date.now());
    void context.globalState.update(OPENAI_USAGE_KEY, next);
  },
  estimate: (p: Pool): number => lastTokens[p] ?? 0,
};
```

#### 2.3.3 代理转发拦截 (`src/proxy.ts`)
代理收到请求时：
```ts
const plan: OpenAIPlan = planOpenAIRequest(
  target.model,
  deps.openai.settings(),
  (p) => deps.openai!.used(p),
  (p) => deps.openai!.estimate(p),
);
```
若 `!plan.allowed`，向客户端返回 429：
```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "OpenAI daily free quota exhausted (1M pool), resets at UTC 00:00."
  }
}
```

---

## 3. 测试与验证策略

### 3.1 单元测试 (`src/openai/freeTokens.test.ts`)
- **测试 1**：余量大于 estimate 时，正常放行（`allowed = true, isFree = true`）。
- **测试 2**：余量大于 0 但小于 estimate 时，开启 `freeTokensOnly`，判定为耗尽并停用（`allowed = false`）。
- **测试 3**：余量大于 0 但小于 estimate 时，未开启 `freeTokensOnly`，降级为付费（`allowed = true, isFree = false, flex = true`）。
- **测试 4**：estimate 为 0（冷启动）时向后兼容，余量大于 0 即可放行。
- **测试 5**：1M 池余量不足停用时，10M 池独立不受影响。

### 3.2 代理集成测试 (`src/proxy.test.ts` 或 `src/proxy.nonstream.test.ts`)
- 注入 mock `deps.openai`，当 `estimate` 大于当前余量时，验证代理返回 429 且不发起任何网络请求。
- 验证代理正常响应 SSE 并在 `response.completed` 后更新 `add(pool, tokens)`。
