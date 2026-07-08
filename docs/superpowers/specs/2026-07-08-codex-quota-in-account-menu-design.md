# Codex quota 在账号菜单里显示 — 设计

日期:2026-07-08

## 目标

在 **Provider 设置 → codex** 的账号列表里,每个账号右侧一行 `description` 显示该账号
当前 quota 摘要 + 最近重置时间。示例:

```
$(account) alice@example.com    Plus · 5h 40% · 周 12% · 重置 07-08 14:30
```

## 背景

- 参考实现在 `Cli-Proxy-API-Management-Center/src/components/quota/quotaConfigs.ts`
  的 `fetchCodexQuota`,通过服务端代理 `apiCallApi.request` + `authIndex` 拉取。
- 本扩展本地就持有每个 codex 账号的 access token(见 `src/codex/auth.ts`),
  因此**直接 `fetch` 官方接口**,不需要服务端代理 / `authIndex`。

## 架构

新增单一职责、可测试的模块 **`src/codex/quota.ts`**,拆为纯函数(便于 `node:test`):

### 常量
- `CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'`
- 请求头:
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `User-Agent: codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal`
  - `Chatgpt-Account-Id: <accountId>`(accountId 为空时省略该头)

### 函数

- `fetchCodexQuota(accessToken, accountId, fetcher = fetch): Promise<CodexUsagePayload>`
  - 发 GET,非 2xx 抛错(带 status),返回解析后的 JSON。
  - 默认参数 `fetcher = fetch`,照 `src/codex/oauth.ts` 的模式,便于测试注入 mock。

- `parseCodexQuota(payload): CodexQuotaSummary`(纯函数,重点测试对象)
  - 从 `rate_limit` 的 `primary_window` / `secondary_window` 里,按
    `limit_window_seconds` 分类:
    - 主窗口 5h = 18000s
    - 次窗口 周 = 604800s;月 = 28–31 天(2419200–2678400s)
  - 兼容 snake_case 与 camelCase 字段(`used_percent`/`usedPercent` 等)。
  - 无窗口时长的旧 payload:回退到 primary/secondary 顺序。
  - reset label:分别对主/次窗口算重置时刻(优先 `reset_at` unix 秒,否则
    `reset_after_seconds` = now + delta),取两者中**最早**的一个,格式
    `MM-DD HH:mm`(24 小时制);都没有则 `-`。
  - 返回:
    ```ts
    interface CodexQuotaSummary {
      planType: string | null;
      primaryPercent: number | null;      // 5h 窗口 used_percent
      secondaryPercent: number | null;    // 周/月窗口 used_percent
      secondaryKind: 'week' | 'month' | null;
      resetLabel: string;                  // 主/次窗口中最早的那次重置时间,或 '-'
    }
    ```

- `formatCodexQuotaSummary(summary): string`
  - 拼成一行中文 description:`Plus · 5h 40% · 周 12% · 重置 07-08 14:30`
  - 各字段缺失用 `-` 兜底;plan 为空则省略该段。

## 数据流 / 接线

改 `src/statusbar.ts` 的 `manageCodex()`:

1. `codexAuth.list()` 拿账号列表;用 `codexAuth.validAt(i)` 拿到(必要时已刷新的)
   access token —— 复用现有多账号访问,`list()` 与内部 `readAll()` 同序,index 对齐。
2. 用 `vscode.window.withProgress`(通知区转圈)**并行** fetch 各账号 quota,
   每个请求 **4s 超时**,失败/超时不抛、不阻塞。
3. fetch 完成后再 `showQuickPick`,把每个账号 item 的 `description` 设为 quota 摘要。
   - **移除**原来的「点击登出此账号」提示,让 quota 独占该行(登出确认弹窗里已有说明)。
   - 登录 / 导入 / 登出等动作行为不变。

同步实现,不引入 `createQuickPick` 异步填充,保持现有 `showQuickPick` 风格。

## 错误处理

单账号 fetch 失败(401 / 网络 / 4s 超时)→ 该行 description 显示 `quota 获取失败`,
其余账号照常;整体不抛、不挡菜单。

## 测试(TDD)

`src/codex/quota.test.ts`(`node:test` + `node:assert/strict`):

- `parseCodexQuota`:
  - 5h / 周 / 月窗口分类正确(按 `limit_window_seconds`)。
  - `used_percent` 取值(snake 与 camel 两种字段)。
  - reset label:`reset_at` 路径与 `reset_after_seconds` 路径。
  - 缺窗口 / 空 payload 的兜底(返回 null / '-')。
- `formatCodexQuotaSummary`:字段缺失兜底、plan 为空时省略。
- `fetchCodexQuota`:注入 mock fetcher,测 2xx 返回解析结果、非 2xx 抛错。

## 明确不做(YAGNI)

- 不做缓存:每次开菜单实时拉,靠 4s 超时兜底。
- 不含 code review / additional 限额窗口。
- 不做主动重置额度(reset credits)相关功能。

后续需要再加。
