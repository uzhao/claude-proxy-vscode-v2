# OpenAI 官方 endpoint:flex / 每日免费额度 设计

日期:2026-06-24

## 背景

内置 `openai` provider(`api.openai.com`,Responses API `/v1/responses`)已经能转发。
OpenAI 官方对参与数据共享计划的账号,按 UTC 天提供两档**共享**免费 token 额度;
同时官方支持 `service_tier: "flex"`(更便宜、更慢)。

本设计给官方 endpoint 增加三个开关,并实现每日免费额度的计量与超额停用。

## 范围

- **仅**针对内置 `openai` provider(`api.openai.com`)。
- codex、自定义 provider、其余内置 provider **不受影响**。
- 不做用量的 UI 展示(后续再加)。

## 三个开关

存储在 `globalState`,默认全部关闭:

```ts
interface OpenAIOfficialSettings {
  /** 请求体注入 service_tier: "flex"(仅对付费请求生效) */
  flex: boolean;
  /** 账号参与每日免费额度计划:开启后按 UTC 天计量两个共享池 */
  freeTokens: boolean;
  /** 只用免费额度:对应池用尽 / 模型不在免费列表时,该请求停用(返回错误) */
  freeTokensOnly: boolean;
}
```

### 开关语义

- `freeTokensOnly` 只在 `freeTokens` 为真时有意义;`freeTokens` 关时全部按付费透传,不计量。
- `flex` 与免费额度的关系:**判定为免费的请求不带 flex,只有付费请求才注入 flex**。

## 免费额度池

两个共享池,各覆盖一组模型(精确匹配模型名):

- **1M 池**(每日 1,000,000 token):
  `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5`,
  `gpt-5-codex`, `gpt-5-chat-latest`, `gpt-4.1`, `gpt-4o`, `o1`, `o3`
- **10M 池**(每日 10,000,000 token):
  `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.1-codex-mini`, `gpt-5-mini`, `gpt-5-nano`,
  `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-mini`, `o1-mini`, `o3-mini`, `o4-mini`,
  `codex-mini-latest`

`resolvePool(model) → '1M' | '10M' | null`(不在任何列表 → `null`)。

### 计量口径

每次成功响应,把 `response.completed` 的 `usage.input_tokens + usage.output_tokens`
累加进该模型所属池(`input_tokens` 已含缓存输入,无需另算)。
模型 `pool === null` 时不计量。

计量发生在响应**结束**时,因此可能出现「最后一次请求把池冲过限额」的轻微超额,接受此误差。

## 当日用量存储

存 `globalState`:

```ts
interface OpenAIUsageState {
  utcDate: string;            // 'YYYY-MM-DD'(UTC)
  used: { '1M': number; '10M': number };
}
```

读取时若 `utcDate` ≠ 今天(UTC)→ 视为全 0(并在下次写入时落盘新日期)。
不需要定时器:每次读/写都基于当前 UTC 日期判断,跨天自动归零。

## 核心决策(纯函数)

```ts
type Pool = '1M' | '10M';

interface OpenAIPlan {
  allowed: boolean;   // false → 该请求停用,返回错误
  flex: boolean;      // true  → 注入 service_tier: "flex"
  pool: Pool | null;  // 命中的免费池(用于成功后计量)
}

function planOpenAIRequest(
  model: string,
  settings: OpenAIOfficialSettings,
  used: (p: Pool) => number,
): OpenAIPlan;
```

逻辑:

```
pool   = resolvePool(model)
isFree = settings.freeTokens && pool != null && used(pool) < LIMIT[pool]
allowed = !settings.freeTokensOnly || isFree
flex    = settings.flex && !isFree
```

真值表要点:

| freeTokens | freeTokensOnly | pool | 池剩余 | flex 开关 | allowed | flex 注入 | isFree |
|---|---|---|---|---|---|---|---|
| 关 | - | 任意 | - | 关 | true | false | false |
| 关 | - | 任意 | - | 开 | true | true | false |
| 开 | 关 | 1M | 有 | 开 | true | false | true |
| 开 | 关 | 1M | 无 | 开 | true | true | false |
| 开 | 关 | null | - | 开 | true | true | false |
| 开 | 开 | 1M | 有 | 开 | true | false | true |
| 开 | 开 | 1M | 无 | 开 | **false** | - | false |
| 开 | 开 | null | - | 开 | **false** | - | false |

## proxy 接入

依赖注入沿用 codex 的模式,给 `ProxyServerDeps` 增加可选成员:

```ts
interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
}
// ProxyServerDeps 增加 openai?: OpenAIAccess
```

在 `openai` 目标(`target.preset.id === 'openai'`)的转发路径上:

1. **前置检查**:用 `planOpenAIRequest` 算 `plan`。
   `plan.allowed === false` → 返回 Anthropic 格式错误并结束:
   - 池用尽:`OpenAI 今日免费额度已用尽(<pool> 池),UTC 0 点重置`
   - 模型不在免费列表:`模型 <model> 不在 OpenAI 免费额度列表`
2. **flex 注入**:`plan.flex` 时,在 `buildResponsesRequest` 产出的上游请求体上加
   `service_tier: "flex"`,再序列化为 `targetBody`。
3. **用量回写**:流式转发过程中捕获 `response.completed` 的 `usage`,
   `plan.pool != null` 时调用 `openai.add(plan.pool, input + output)`。

实现方式:在现有泛型 translator 转发循环里加针对 openai 的条件分支
(前置检查 + flex 注入在进入 `tryKeys` 循环前;usage 捕获在 SSE payload 循环里
解析 `response.completed`),不新开独立分支以减少重复代码。

`openai` provider 仍需至少一个 API key,沿用现有 key 轮换逻辑。

## UI(statusbar)

在 openai provider 的设置子菜单里加三个可切换开关:`flex` / `freeTokens` / `freeTokensOnly`,
复用现有 `providerSettings` 的展开方式,切换即写 `globalState`。
不展示用量。

## extension 装配

- 用 `globalState` 实现 `OpenAIAccess`:`settings()` 读设置对象,
  `used()/add()` 读写用量对象(读时按 UTC 日期判断是否归零)。
- 在 `createProxyServer({ getConfig, codex, openai })` 注入。

## 测试

- `resolvePool`:1M / 10M / null 各取样。
- `planOpenAIRequest`:覆盖上面真值表的各组合。
- 用量 store:跨 UTC 日期归零、累加、读写往返。
- proxy 层(沿用 `proxy.test` 模式):
  - `freeTokensOnly` 超额 → 返回错误、不发上游。
  - `flex` 注入:免费请求不带 flex、付费请求带 flex。
  - 成功响应后 `usage` 正确累加到对应池。

## 不做(YAGNI)

- 用量 UI 展示。
- 跨设备/跨窗口共享用量(globalState 已是机器级,足够)。
- 用户自定义池模型列表或限额(用内置常量;官方变动时改常量即可)。
- 对 codex / 自定义 provider 套用同一机制。

## 涉及文件

- 新增 `src/openai/freeTokens.ts`:常量、`resolvePool`、`planOpenAIRequest`、用量 store 辅助。
- `src/proxy.ts`:`ProxyServerDeps.openai`、openai 路径的前置检查 / flex 注入 / usage 回写。
- `src/config.ts` 或就近模块:`OpenAIOfficialSettings` 类型(如需)。
- `src/extension.ts`:globalState 实现 + 注入。
- `src/statusbar.ts`:三个开关 UI。
