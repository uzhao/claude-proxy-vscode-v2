# codex 多账号轮换 — 设计

## 背景与目标

当前 codex（ChatGPT OAuth）只支持单一账号:凭证存于 SecretStorage 的 `claudeProxy.codex`,
proxy 每次请求只取这一个账号转发,没有轮换。普通 provider 的 API key 已有「遇 401/429/5xx 自动换下一个」
的轮换逻辑(`src/proxy.ts`)。

目标:让 codex 支持登录/导入多个账号,并在转发失败时按账号轮换,复用现有 key 轮换的「失败即切换」语义,
用于分摊订阅额度、规避限流。

## 关键决策(已与用户确认)

- **轮换策略**:失败即切换。单次请求内遇 401/429/5xx 就换下一个账号重试,直到成功或账号用尽。
- **轮换起点**:记住上次成功的账号下标(内存游标),下次请求从它开始。被限流的账号自然被「跳过到最后」。
  游标**不持久化**,扩展重载后从 0 开始。
- **登出**:按单个账号登出(以 accountId 为键)。
- **添加账号的两种方式并存**:
  1. 现有 ChatGPT OAuth 登录流程(不改动)。
  2. 新增「粘贴凭证 JSON」——把 codex CLI 风格的凭证 JSON 文本粘进输入框导入。

## 1. 存储模型(`src/codex/auth.ts`)

把单一凭证改为账号数组,仍存在同一个 SecretStorage key `claudeProxy.codex`。

```ts
interface StoredAccount {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string;        // 新增,用于 UI 展示;OAuth 从 id_token 解析,导入从字段取
  expiresAt: number;    // epoch ms
}
```

- 存储值从「单个对象」变为 `StoredAccount[]`。
- **向后兼容读取**:读到旧的单对象(无数组)时自动包成单元素数组;下次保存即写成新数组格式,无需迁移脚本。
- **去重**:以 `accountId` 为唯一键。重复登录/导入同一账号 → 更新该条目而非新增。

`CodexAuth` 方法调整:

- `list(): Promise<{ accountId: string; email: string }[]>` — 给 UI。
- `count(): Promise<number>`。
- `add(account: StoredAccount): Promise<void>` — 按 accountId 去重合并(OAuth 与导入共用)。
- `removeByAccountId(id: string): Promise<void>`。
- `getValidAt(index: number): Promise<{ accessToken: string; accountId: string } | null>`
  — 取第 index 个账号,过期则刷新并按账号写回(保留现有刷新逻辑);未登录/刷新失败返回 null。
- 内存游标 `cursor`:`startIndex(): number`、`markSuccess(index: number): void`(设游标=index)。

`email` 的来源:
- OAuth:`save()`/`add()` 时从 `id_token` 的 `https://api.openai.com/profile.email` 解析(新增解析,
  与现有 `parseAccountId` 同风格)。
- 导入:直接取 JSON 的 `email` 字段,缺失时回退到 id_token 解析。

## 2. 导入凭证解析(`src/codex/auth.ts`)

`parseImportedCredential(text: string): StoredAccount` — 解析 codex CLI 风格 JSON:

```json
{
  "access_token": "...", "refresh_token": "rt.1...", "id_token": "...",
  "account_id": "302c9db1-...", "email": "adhocjyzhao@gmail.com",
  "expired": "2026-06-30T16:49:38Z", "type": "codex", "disabled": false
}
```

映射规则:
- `accessToken ← access_token`,`refreshToken ← refresh_token`(二者缺失 → 抛错)。
- `accountId ← account_id`,缺失则 `parseAccountId(id_token)`。
- `email ← email`,缺失则从 id_token 的 profile.email 解析。
- `expiresAt ← Date.parse(expired)`;解析不出则置 0(视作已过期,下次转发触发刷新)。

解析失败或缺关键字段时抛出带说明的错误,由命令层捕获并 `showErrorMessage`。

## 3. Proxy 轮换逻辑(`src/proxy.ts`)

`ProxyServerDeps` 把 codex 凭证接口从「取单个」改为带游标与按需刷新的小接口:

```ts
codex?: {
  count(): Promise<number>;
  startIndex(): number;
  validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>;
  markSuccess(i: number): void;
};
```

(由 `extension.ts` 用 `CodexAuth` 实例的方法装配。)

codex 请求分支改为从游标起轮换,复用现有 `shouldRotate(status)`:

```
n = await codex.count()
if n === 0 → 401 未登录(沿用现有错误体)
start = codex.startIndex()
lastErr = null
for off in 0..n-1:
    i = (start + off) % n
    auth = await codex.validAt(i)
    if !auth: continue                       // 此账号刷新失败/损坏 → 视作可轮换
    发请求(authorization + chatgpt-account-id + 现有头)
    if shouldRotate(status) 且 off < n-1:     // 还有下一个账号
        cancel upstream.body; continue
    if status >= 400: 返回 Anthropic 错误(最后一个也失败时走到这)
    成功 → codex.markSuccess(i); 流式回译返回; return
全部失败 → 500
```

关键不变量:codex 路径**先判 `status >= 400` 再 `writeHead(200)`**,轮换全部发生在开始流式之前,
不会出现写到一半再切账号。语义与现有 key 轮换一致。

## 4. UI(`src/statusbar.ts` + `src/extension.ts`)

**主菜单**:codex 那条 description 由「已登录」改为「已登录 N 个账号」(N>0 时)。

**Provider 设置 → codex 子菜单**(替换现在「只能登出」的逻辑):
- 逐个列出账号 `$(account) <email>` → 选中 → 「登出此账号」(按 accountId)。
- `$(sign-in) 登录新账号(ChatGPT OAuth)` → 现有 `claudeProxy.codexLogin`。
- `$(clippy) 粘贴凭证 JSON…` → `claudeProxy.codexImport`(`showInputBox` 收整段 JSON)。
- 当前 0 个账号时,子菜单仅显示后两项。

**`extension.ts`**:
- `claudeProxy.codexLogout` 改为按 accountId 登出单个账号(命令参数传 accountId)。
- 新增 `claudeProxy.codexImport`:弹 `showInputBox`,`parseImportedCredential` → `codexAuth.add()`,
  成功/失败给 message。
- `createProxyServer` 的 `getCodexAuth` 接线换成新的 `codex` 接口对象。

## 测试(`node:test` 风格)

- `auth.test.ts`:
  - 旧单对象兼容读取 → 单元素数组。
  - `add` 按 accountId 去重(更新而非新增)。
  - `removeByAccountId`。
  - 游标 `markSuccess` / `startIndex` 与 wrap。
  - `parseImportedCredential`:正常解析、ISO 时间转换、account_id/email 字段缺失回退、缺 access_token 抛错。
- `proxy.test.ts`(mock fetch,复用现有 key 轮换套路):
  - 多账号 429 → 切换 → 成功。
  - 成功后游标更新到命中账号。
  - 全部账号失败 → 返回错误。
  - 0 账号 → 401 未登录。

## 不做(YAGNI)

- 不做 429 冷却时间窗/持久化健康状态(仅内存游标)。
- 不读取文件(改为粘贴 JSON 文本)。
- 不为导入做迁移脚本(向后兼容读取已覆盖旧单账号)。
