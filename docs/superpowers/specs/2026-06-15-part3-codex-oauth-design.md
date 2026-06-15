# Part 3:codex OAuth 登录 + codex 转发

> 让 codex(ChatGPT 订阅)可用:实现 OpenAI OAuth(PKCE)登录、token 安全存储与刷新,并把 codex 接入转发(复用 Part 2c 的 Responses 转换 + codex 专属字段/headers/endpoint)。OAuth 与转发逻辑移植自 CLIProxyAPI 的 `internal/auth/codex` 与 `internal/runtime/executor/codex_executor.go`。

## 背景

Part 1 把 codex 留作占位(`CODEX_PLACEHOLDER_ID`,仅在 Provider 设置里提示"需登录")。Part 2c 已实现通用 OpenAI Responses 转换并剥离 codex 专属。本轮补齐 codex:OAuth 登录拿凭证 + codex 专属转发。

codex 与其它 provider 的根本不同:用 **OAuth access token**(非 API key),转发到 **`chatgpt.com/backend-api/codex/responses`**(非 api.openai.com),且请求体/headers 有 codex 专属要求。

OAuth 固定参数(codex 注册值,来自 CLIProxyAPI):
- 授权 `https://auth.openai.com/oauth/authorize`,换 token `https://auth.openai.com/oauth/token`
- `client_id=app_EMoamEEZ73f0CkXaXp7hrann`,`redirect_uri=http://localhost:1455/auth/callback`(写死)
- PKCE S256,scope `openid email profile offline_access`

## 范围

- **做**:OAuth(PKCE)登录流、token 存 SecretStorage、过期自动刷新、codex 接入转发(Responses + codex 专属)、Provider 设置里 codex 登录/登出 UI。
- **不做**:codex 的 web_search 等工具特殊处理、设备码登录(device flow)、多账号(单一 codex 登录)。

## 架构

```
src/codex/
  pkce.ts      —— 生成 code_verifier + S256 code_challenge + state(纯,可测)
  oauth.ts     —— authURL 构造、code→token 交换、refresh、解析 id_token 拿 account_id(纯 HTTP,fetch 注入可测)
  login.ts     —— VSCode 胶水:起本地 server(127.0.0.1:1455)收 callback + openExternal + 存 token
  auth.ts      —— token 存取(SecretStorage)+ getValidAccessToken(过期则刷新)
src/translate/codex/
  request.ts   —— 在 Part 2c buildResponsesRequest 之上加 codex 专属字段(纯,可测)
```
响应复用 Part 2c 的 `ResponsesToClaudeStream`(codex SSE 事件与标准 Responses 一致)。

**改动:**
- `presets.ts`:codex 从占位变真实 preset:`{ id:'codex', format:'openai', api:'responses', baseUrl:'https://chatgpt.com/backend-api/codex', forwardable:true, modelsDevId:'openai' }`。
- `registry.ts`:codex 用专属 translator(`buildCodexRequest` + `ResponsesToClaudeStream`,endpointPath `/responses`)。
- `proxy.ts`:codex target 不走 providers.json key 轮换,改用注入的 `deps.getCodexAuth()` 拿 `{accessToken, accountId}`,设 codex headers。
- `extension.ts`:注入 `getCodexAuth`(来自 `codex/auth.ts`,持有 `context.secrets`);注册登录/登出命令。
- `statusbar.ts`:Provider 设置里 codex 项 → 未登录「登录 ChatGPT」/已登录「账号 + 登出」。
- `config.ts` 或 statusbar:codex 不在 providers.json 存 key(它用 SecretStorage),`configuredProviders` 等需把 codex 的"已配置"判定改为"已登录"。

## OAuth 登录时序(login.ts)

```
1. pkce = generatePKCE();  state = random()
2. server = http.createServer 监听 127.0.0.1:1455,路由 /auth/callback
3. vscode.env.openExternal(buildAuthURL(pkce, state))  → 浏览器打开 ChatGPT 登录
4. 用户授权 → 浏览器重定向 http://localhost:1455/auth/callback?code=...&state=...
5. callback:校验 state;向浏览器回一个"登录成功,可关闭本页"的 HTML
6. exchangeCodeForTokens(code, pkce.verifier) → { access_token, refresh_token, id_token, expires_in }
7. accountId = parseJwt(id_token).chatgpt_account_id(或 organizations 中提取)
8. 存 SecretStorage:{ accessToken, refreshToken, accountId, expiresAt = now + expires_in*1000 }
9. server.close();刷新状态栏
```
超时/取消:server 设一个整体超时(如 5 分钟)未回调则放弃并提示。

## token 存储与刷新(auth.ts)

- 存:`context.secrets.store('claudeProxy.codex', JSON.stringify({accessToken, refreshToken, accountId, expiresAt}))`。
- `getValidAccessToken()`:读 secret;若 `expiresAt - now < 60s`,用 refresh_token 调 token endpoint(`grant_type=refresh_token`)换新 access(可能含新 refresh),回存;返回 `{accessToken, accountId}`。刷新失败(refresh 失效)→ 返回 null(UI 提示重新登录)。
- 登出:`context.secrets.delete('claudeProxy.codex')`。

## codex 请求(translate/codex/request.ts)

在 `buildResponsesRequest(body, model)` 结果上叠加 codex 专属(参考 [codex_claude_request.go](../../CLIProxyAPI/internal/translator/codex/claude/codex_claude_request.go)):
- `instructions: ''`(codex 要求该字段存在;留空)
- `store: false`
- `include: ['reasoning.encrypted_content']`
- `reasoning.summary: 'auto'`(buildResponsesRequest 已设 reasoning.effort,补 summary)

> 通用 Responses(Part 2c)与 codex 的请求差异仅这几个顶层字段;消息/工具/图片映射完全复用。

## codex 转发(proxy.ts)

codex target(`preset.id === 'codex'`)特殊分支:
- URL:`${preset.baseUrl}/responses`(= `https://chatgpt.com/backend-api/codex/responses`)。
- 认证:`const auth = await deps.getCodexAuth()`;为空 → 返回 Anthropic 错误"codex 未登录"。
- headers:`Authorization: Bearer ${auth.accessToken}`、`Chatgpt-Account-Id: ${auth.accountId}`、`Originator: codex-tui`、`Content-Type: application/json`、`Accept: text/event-stream`。
- body:`buildCodexRequest(requestBody, target.model)`。
- 响应:`ResponsesToClaudeStream`(同 Part 2c)。
- 不轮换(单一 OAuth token);401 → 提示重新登录(Anthropic 错误)。

`ProxyServerDeps` 增加:`getCodexAuth?: () => Promise<{ accessToken: string; accountId: string } | null>`。

## UI(statusbar.ts)

- Provider 设置列表里 codex 项:
  - 未登录:`codex —— 登录 ChatGPT`,点击 → 执行登录命令(login.ts 流程,带进度提示)。
  - 已登录:`codex —— 已登录(<account 摘要>)`,点击 → 选「登出」。
- 登录后,codex 出现在状态栏一级菜单的可切换 provider 中(`configuredProviders` 视 codex 已登录为已配置),可选其模型(models.dev 的 openai 模型里 codex 系,或直接用 gpt-5-codex)。

## 测试

**纯逻辑(node:test):**
- `pkce.ts`:verifier 长度/字符集、challenge = base64url(sha256(verifier))、S256。
- `oauth.ts`:authURL 含全部必需参数;exchange/refresh 用注入 fetch 断言请求体(grant_type/code/code_verifier)与响应解析;parseJwt 从 id_token 取 account_id。
- `translate/codex/request.ts`:在 Responses body 上正确叠加 instructions/store/include/reasoning.summary,且不破坏消息/工具映射。

**手动冒烟(F5):** Provider 设置 → codex → 登录 → 浏览器授权 → 回调成功 → 状态栏选 codex 模型 → Claude Code 对话验证文本/工具;放置到 token 过期附近验证刷新;登出后再用应提示未登录。

## 范围外

- device code 登录、多 codex 账号、codex web_search/其它专属工具、非流式。
