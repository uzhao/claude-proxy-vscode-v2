# Part 3:codex OAuth 登录 + codex 转发 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 OpenAI OAuth(PKCE)登录、token 安全存储与刷新,并把 codex 接入转发(chatgpt.com/backend-api/codex,复用 Part 2c 的 Responses 转换 + codex 专属字段/headers)。

**Architecture:** 新增 `src/codex/`(pkce/oauth 纯逻辑 + login/auth 的 VSCode 胶水)与 `src/translate/codex/request.ts`(在 Part 2c Responses 上叠加 codex 字段)。proxy 对 codex 走单 OAuth token 分支(`deps.getCodexAuth()` 注入),token 存 SecretStorage。移植自 CLIProxyAPI `internal/auth/codex`。

**Tech Stack:** TypeScript(commonjs/ES2020/strict)、Node `http`/`crypto`、VSCode SecretStorage、`node:test`。

---

## 文件结构

```
src/codex/
  pkce.ts        —— generatePkce():{verifier, challenge} + randomState();纯,可测
  oauth.ts       —— buildAuthUrl / exchangeCode / refresh / parseAccountId;纯(fetch 注入),可测
  auth.ts        —— CodexAuth 类:SecretStorage 存取 + getValidAccessToken(过期刷新);isExpired 纯函数可测
  login.ts       —— 本地 server(127.0.0.1:1455)收 callback + openExternal;VSCode 胶水
src/translate/codex/
  request.ts     —— buildCodexRequest:Part 2c buildResponsesRequest + codex 专属字段;纯,可测
```
改动:`presets.ts`(codex 真实 preset)、`registry.ts`(codex translator)、`proxy.ts`(codex 认证分支)、`extension.ts`(注入 getCodexAuth + 登录/登出命令)、`statusbar.ts`(codex 登录/登出 UI)。

---

## Task 1:codex/pkce.ts —— PKCE 生成

**Files:** Create `src/codex/pkce.ts`, `src/codex/pkce.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/codex/pkce.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generatePkce, randomState } from './pkce';

test('verifier 是 URL-safe base64 无填充,长度足够', () => {
  const { verifier } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43);
});

test('challenge = base64url(sha256(verifier)) 无填充', () => {
  const { verifier, challenge } = generatePkce();
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.equal(challenge.includes('='), false);
});

test('两次生成不同;state 非空 URL-safe', () => {
  assert.notEqual(generatePkce().verifier, generatePkce().verifier);
  assert.match(randomState(), /^[A-Za-z0-9_-]+$/);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./pkce`。

- [ ] **Step 3:实现 pkce.ts**

创建 `src/codex/pkce.ts`:

```ts
import { randomBytes, createHash } from 'node:crypto';

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

/** 生成 PKCE 码对:verifier=base64url(96 随机字节),challenge=base64url(sha256(verifier)),均无填充(RFC 7636 S256) */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(96).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** OAuth state:防 CSRF 的随机串 */
export function randomState(): string {
  return randomBytes(24).toString('base64url');
}
```

> Node 的 `base64url` 编码本身无填充,等价于 CLIProxyAPI 的 `base64.URLEncoding.WithPadding(NoPadding)`。

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/codex/pkce.ts src/codex/pkce.test.ts
git commit -m "feat: codex PKCE 码生成"
```

---

## Task 2:codex/oauth.ts —— 授权 URL / 换 token / 刷新 / 解析

**Files:** Create `src/codex/oauth.ts`, `src/codex/oauth.test.ts`

> 移植自 [openai_auth.go](../../CLIProxyAPI/internal/auth/codex/openai_auth.go) 与 [jwt_parser.go](../../CLIProxyAPI/internal/auth/codex/jwt_parser.go)。

- [ ] **Step 1:写失败测试**

创建 `src/codex/oauth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthUrl, exchangeCode, refreshToken, parseAccountId, REDIRECT_URI } from './oauth';

test('buildAuthUrl 含必需参数', () => {
  const url = new URL(buildAuthUrl('chal123', 'state456'));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), 'chal123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state456');
  assert.equal(url.searchParams.get('scope'), 'openid email profile offline_access');
});

test('exchangeCode 发送正确表单并解析 token', async () => {
  let captured: any = null;
  const fakeFetch = (async (url: string, opts: any) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  const tok = await exchangeCode('the_code', 'the_verifier', fakeFetch);
  assert.equal(captured.url, 'https://auth.openai.com/oauth/token');
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'the_code');
  assert.equal(form.get('code_verifier'), 'the_verifier');
  assert.equal(tok.accessToken, 'at');
  assert.equal(tok.refreshToken, 'rt');
  assert.equal(tok.idToken, 'idt');
  assert.equal(tok.expiresIn, 3600);
});

test('refreshToken 用 refresh_token 授权类型', async () => {
  let body = '';
  const fakeFetch = (async (_url: string, opts: any) => {
    body = opts.body;
    return { ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'newrt', id_token: 'i', expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  const tok = await refreshToken('old_rt', fakeFetch);
  const form = new URLSearchParams(body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old_rt');
  assert.equal(tok.accessToken, 'new');
});

test('exchangeCode 失败抛错', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 400, text: async () => 'bad' })) as unknown as typeof fetch;
  await assert.rejects(() => exchangeCode('c', 'v', fakeFetch), /400/);
});

test('parseAccountId 从 id_token 取 chatgpt_account_id', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1' }, email: 'a@b.c' })).toString('base64url');
  const idToken = `header.${payload}.sig`;
  assert.equal(parseAccountId(idToken), 'acc_1');
  assert.equal(parseAccountId('bad'), '');
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./oauth`。

- [ ] **Step 3:实现 oauth.ts**

创建 `src/codex/oauth.ts`:

```ts
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';

export interface CodexToken {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

/** 构造 OAuth 授权 URL(PKCE S256) */
export function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** 用授权码换 token */
export async function exchangeCode(code: string, verifier: string, fetcher: typeof fetch = fetch): Promise<CodexToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  return postToken(body, fetcher);
}

/** 用 refresh token 换新 token */
export async function refreshToken(refresh: string, fetcher: typeof fetch = fetch): Promise<CodexToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refresh,
    scope: 'openid profile email',
  });
  return postToken(body, fetcher);
}

async function postToken(body: URLSearchParams, fetcher: typeof fetch): Promise<CodexToken> {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  } as any);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token request failed: ${res.status} ${text}`);
  }
  const j: any = await res.json();
  return {
    accessToken: j.access_token ?? '',
    refreshToken: j.refresh_token ?? '',
    idToken: j.id_token ?? '',
    expiresIn: typeof j.expires_in === 'number' ? j.expires_in : 3600,
  };
}

/** 解析 id_token(JWT,不验签)取 chatgpt_account_id;失败返回 '' */
export function parseAccountId(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return '';
    }
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/codex/oauth.ts src/codex/oauth.test.ts
git commit -m "feat: codex OAuth 授权/换token/刷新/解析"
```

---

## Task 3:translate/codex/request.ts —— codex 专属请求 + registry 接入

**Files:** Create `src/translate/codex/request.ts`, `src/translate/codex/request.test.ts`; Modify `src/translate/registry.ts`, `src/translate/registry.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/translate/codex/request.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexRequest } from './request';

test('在 Responses 基础上叠加 codex 专属字段', () => {
  const out = buildCodexRequest({
    max_tokens: 64,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5-codex');
  // 复用 Responses 的字段
  assert.equal(out.model, 'gpt-5-codex');
  assert.equal(out.stream, true);
  assert.equal(out.max_output_tokens, 64);
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  // codex 专属
  assert.equal(out.instructions, '');
  assert.equal(out.store, false);
  assert.deepEqual(out.include, ['reasoning.encrypted_content']);
  assert.equal(out.reasoning.effort, 'medium');
  assert.equal(out.reasoning.summary, 'auto');
});

test('无 thinking 时也带 reasoning.summary(codex 要求)', () => {
  const out = buildCodexRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'm');
  assert.equal(out.reasoning.summary, 'auto');
  assert.equal(out.store, false);
});
```

在 `src/translate/registry.test.ts` 末尾追加:

```ts
import { getPreset as getPresetForCodex } from '../presets';

test('codex preset → responses 端点 + codex 请求(带 store:false)', () => {
  const t = getTranslator(getPresetForCodex('codex')!)!;
  assert.equal(t.endpointPath, '/responses');
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5-codex');
  assert.equal(req.store, false);
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});
```

> 注:此测试依赖 codex preset 存在,该 preset 在 Task 6 加入。为让 Task 3 可独立验证,本步先在 registry 里用 `preset.id === 'codex'` 分发(见 Step 3),codex preset 的 `getPreset('codex')` 在 Task 6 才返回非空——因此本条 registry 测试在 Task 6 完成后才会通过。**本 Task 验证以 `request.test.ts` 为准**;registry 的 codex 用例可先写、待 Task 6 转绿。

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./request`(codex)。

- [ ] **Step 3:实现 request.ts + registry 接入**

创建 `src/translate/codex/request.ts`:

```ts
import { buildResponsesRequest } from '../responses/request';

/** Anthropic 请求 → codex 的 Responses 请求:在通用 Responses 基础上叠加 codex 专属字段 */
export function buildCodexRequest(body: any, model: string): any {
  const out = buildResponsesRequest(body, model);
  out.instructions = '';
  out.store = false;
  out.include = ['reasoning.encrypted_content'];
  if (!out.reasoning) {
    out.reasoning = { effort: 'medium' };
  }
  out.reasoning.summary = 'auto';
  return out;
}
```

在 `src/translate/registry.ts` 顶部追加 import:

```ts
import { buildCodexRequest } from './codex/request';
```

并新增 codex translator 常量(放在 `RESPONSES_TRANSLATOR` 之后):

```ts
const CODEX_TRANSLATOR: Translator = {
  buildRequest: buildCodexRequest,
  createStreamTranslator: () => new ResponsesToClaudeStream(),
  endpointPath: '/responses',
  authHeader: () => ({}), // codex 认证由 proxy 用 OAuth token 注入,这里留空
};
```

把 `getTranslator` 改为优先识别 codex:

```ts
export function getTranslator(preset: Preset): Translator | null {
  if (preset.id === 'codex') {
    return CODEX_TRANSLATOR;
  }
  if (preset.format !== 'openai') {
    return null;
  }
  return preset.api === 'responses' ? RESPONSES_TRANSLATOR : CHAT_TRANSLATOR;
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: `request.test.ts` 全部通过;`registry.test.ts` 的 codex 用例因 codex preset 尚未加入(Task 6)而失败 —— 这是预期,Task 6 转绿。其余测试通过。

> 若希望本 Task 即全绿,可暂时跳过 registry 的 codex 用例(给它加 `{ skip: true }`),Task 6 再去掉 skip。实现者择一,在报告中说明。

- [ ] **Step 5:提交**

```bash
git add src/translate/codex/request.ts src/translate/codex/request.test.ts src/translate/registry.ts src/translate/registry.test.ts
git commit -m "feat: codex 专属请求 + registry 接入"
```

---

## Task 4:codex/auth.ts —— token 存储与刷新

**Files:** Create `src/codex/auth.ts`, `src/codex/auth.test.ts`

> SecretStorage 存取是 VSCode 胶水;过期判断 `isExpired` 抽成纯函数单测。

- [ ] **Step 1:写失败测试**

创建 `src/codex/auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from './auth';

test('isExpired:剩余 < 60s 视为过期', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now + 30_000, now), true);   // 30s 后过期 → 需刷新
  assert.equal(isExpired(now + 120_000, now), false); // 2min 后过期 → 有效
  assert.equal(isExpired(now - 1, now), true);        // 已过期
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./auth`。

- [ ] **Step 3:实现 auth.ts**

创建 `src/codex/auth.ts`:

```ts
import type * as vscode from 'vscode';
import { refreshToken, parseAccountId } from './oauth';

const SECRET_KEY = 'claudeProxy.codex';

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number; // epoch ms
}

/** access token 是否需要刷新(剩余不足 60s) */
export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now < 60_000;
}

/** codex 凭证管理:基于 VSCode SecretStorage,转发前确保 access token 有效 */
export class CodexAuth {
  constructor(private secrets: vscode.SecretStorage) {}

  async save(t: { accessToken: string; refreshToken: string; idToken: string; expiresIn: number }): Promise<void> {
    const stored: StoredToken = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accountId: parseAccountId(t.idToken),
      expiresAt: Date.now() + t.expiresIn * 1000,
    };
    await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
  }

  async logout(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async accountId(): Promise<string> {
    return (await this.read())?.accountId ?? '';
  }

  /** 返回有效的 {accessToken, accountId};未登录或刷新失败返回 null */
  async getValid(): Promise<{ accessToken: string; accountId: string } | null> {
    const cur = await this.read();
    if (!cur) {
      return null;
    }
    if (!isExpired(cur.expiresAt)) {
      return { accessToken: cur.accessToken, accountId: cur.accountId };
    }
    try {
      const fresh = await refreshToken(cur.refreshToken);
      const next: StoredToken = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || cur.refreshToken,
        accountId: parseAccountId(fresh.idToken) || cur.accountId,
        expiresAt: Date.now() + fresh.expiresIn * 1000,
      };
      await this.secrets.store(SECRET_KEY, JSON.stringify(next));
      return { accessToken: next.accessToken, accountId: next.accountId };
    } catch (e) {
      console.error('codex token refresh failed', e);
      return null;
    }
  }

  private async read(): Promise<StoredToken | null> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS(`isExpired` 用例);`npm run compile` 无错。

- [ ] **Step 5:提交**

```bash
git add src/codex/auth.ts src/codex/auth.test.ts
git commit -m "feat: codex token 存储(SecretStorage)与刷新"
```

---

## Task 5:codex/login.ts —— OAuth 登录流(本地回调)

**Files:** Create `src/codex/login.ts`

> 纯 VSCode/Node 胶水(本地 server + 浏览器),以编译 + Task 8 手动冒烟验证。

- [ ] **Step 1:实现 login.ts**

创建 `src/codex/login.ts`:

```ts
import * as vscode from 'vscode';
import * as http from 'http';
import { generatePkce, randomState } from './pkce';
import { buildAuthUrl, exchangeCode } from './oauth';
import { CodexAuth } from './auth';

const CALLBACK_PORT = 1455;
const TIMEOUT_MS = 5 * 60 * 1000;

/** 走完整 OAuth 登录:起本地 server 收 callback、开浏览器、换 token、存储。成功返回 true。 */
export async function loginCodex(auth: CodexAuth): Promise<boolean> {
  const pkce = generatePkce();
  const state = randomState();

  const codePromise = waitForCallback(state);
  await vscode.env.openExternal(vscode.Uri.parse(buildAuthUrl(pkce.challenge, state)));

  let code: string;
  try {
    code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '等待 ChatGPT 授权…', cancellable: true },
      (_progress, token) => Promise.race([
        codePromise.promise,
        new Promise<string>((_, reject) => token.onCancellationRequested(() => reject(new Error('用户取消')))),
      ]),
    );
  } catch (e) {
    codePromise.close();
    vscode.window.showWarningMessage(`Codex 登录未完成: ${String((e as any)?.message ?? e)}`);
    return false;
  }

  try {
    const tok = await exchangeCode(code, pkce.verifier);
    await auth.save(tok);
    vscode.window.showInformationMessage('Codex 登录成功');
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Codex 换取 token 失败: ${String((e as any)?.message ?? e)}`);
    return false;
  }
}

interface Pending {
  promise: Promise<string>;
  close: () => void;
}

/** 起本地 server 监听 1455/auth/callback,校验 state 后 resolve code */
function waitForCallback(expectedState: string): Pending {
  let server: http.Server;
  let timer: NodeJS.Timeout;
  const promise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (!code || state !== expectedState) {
        res.end('<h3>登录失败:state 校验未通过,可关闭本页。</h3>');
        reject(new Error('state 校验失败或缺少 code'));
        return;
      }
      res.end('<h3>Codex 登录成功,可关闭本页返回编辑器。</h3>');
      resolve(code);
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT, '127.0.0.1');
    timer = setTimeout(() => reject(new Error('授权超时')), TIMEOUT_MS);
  });
  const close = () => {
    clearTimeout(timer);
    server?.close();
  };
  // 无论成功失败都关 server
  promise.then(close, close);
  return { promise, close };
}
```

- [ ] **Step 2:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 3:提交**

```bash
git add src/codex/login.ts
git commit -m "feat: codex OAuth 登录流(本地回调 + 浏览器)"
```

---

## Task 6:presets + proxy + extension 接入

**Files:** Modify `src/presets.ts`, `src/proxy.ts`, `src/extension.ts`

- [ ] **Step 1:presets 加 codex 真实 preset**

在 `src/presets.ts` 的 PRESETS 数组末尾追加:

```ts
  { id: 'codex',      format: 'openai',    baseUrl: 'https://chatgpt.com/backend-api/codex',      modelsDevId: 'openai',     forwardable: true,  api: 'responses' },
```

> `CODEX_PLACEHOLDER_ID` 常量保留(statusbar 仍用它判断 codex 项),但 codex 现在是真实 preset。

- [ ] **Step 2:proxy 增加 codex 认证分支**

在 `src/proxy.ts` 的 `ProxyServerDeps` 接口加:

```ts
  /** 获取有效的 codex OAuth 凭证;未登录返回 null */
  getCodexAuth?: () => Promise<{ accessToken: string; accountId: string } | null>;
```

在请求处理中,定位到计算 `tryKeys` 之前(`const tryKeys = ...` 那行之前),插入 codex 专属转发分支:

```ts
        // codex:用 OAuth token 单次转发(不走 providers.json key 轮换)
        if (target && target.preset.id === 'codex') {
          const auth = deps.getCodexAuth ? await deps.getCodexAuth() : null;
          if (!auth) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(anthropicError('authentication_error', 'codex 未登录,请在 Provider 设置中登录 ChatGPT。'));
            return;
          }
          const codexHeaders: Record<string, any> = {
            ...baseHeaders,
            'authorization': `Bearer ${auth.accessToken}`,
            'chatgpt-account-id': auth.accountId,
            'originator': 'codex-tui',
            'accept': 'text/event-stream',
          };
          try {
            const upstream = await fetch(targetUrl, { method: 'POST', headers: codexHeaders as any, body: targetBody });
            console.log(`[proxy] codex upstream status ${upstream.status}`);
            if (upstream.status >= 400) {
              const errText = await upstream.text();
              res.writeHead(upstream.status, { 'content-type': 'application/json' });
              res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
              return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const parser = new SSEParser();
            const stream = translator!.createStreamTranslator();
            const reader = upstream.body?.getReader();
            const decoder = new TextDecoder();
            if (reader) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                  for (const event of stream.push(payload)) {
                    if (!res.write(event)) {
                      await new Promise<void>(resolve => res.once('drain', resolve));
                    }
                  }
                }
              }
            }
            res.end();
            return;
          } catch (err) {
            console.error('[proxy] codex error:', err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(anthropicError('api_error', String((err as any)?.message ?? err)));
            return;
          }
        }
```

> 该分支在 `targetUrl`/`targetBody`/`baseHeaders`/`translator` 都已计算之后、key 轮换循环之前。codex 的 `targetUrl` = `https://chatgpt.com/backend-api/codex/responses`(baseUrl + translator.endpointPath),`targetBody` 已由 codex translator 的 buildRequest 生成。

- [ ] **Step 3:extension 注入 getCodexAuth + 登录/登出命令**

在 `src/extension.ts` 顶部 import 追加:

```ts
import { CodexAuth } from './codex/auth';
import { loginCodex } from './codex/login';
```

在 `activate` 内构造 CodexAuth(在 server 创建之前):

```ts
  const codexAuth = new CodexAuth(context.secrets);
```

把 `createProxyServer({ getConfig, isJsonLogging })` 改为:

```ts
  server = createProxyServer({ getConfig, isJsonLogging, getCodexAuth: () => codexAuth.getValid() });
```

注册登录/登出命令(在其它 registerCommand 旁):

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.codexLogin', () => loginCodex(codexAuth)),
    vscode.commands.registerCommand('claudeProxy.codexLogout', async () => {
      await codexAuth.logout();
      vscode.window.showInformationMessage('已登出 Codex');
    }),
  );
```

并把 `codexAuth` 通过 StatusBar 依赖传入(供 UI 用)——在 `new StatusBar({...})` 的依赖对象里加 `codexAuth`(StatusBarDeps 在 Task 7 扩展)。

- [ ] **Step 4:编译 + 测试**

Run: `npm test && npm run compile`
Expected: PASS(含 Task 3 里 registry 的 codex 用例现在转绿,因 codex preset 已存在);无 TS 错误。

> 若 Task 3 给 registry codex 用例加了 `{ skip: true }`,在此移除 skip 并确认通过。

- [ ] **Step 5:提交**

```bash
git add src/presets.ts src/proxy.ts src/extension.ts
git commit -m "feat: codex preset + proxy OAuth 转发分支 + extension 接入"
```

---

## Task 7:statusbar.ts —— codex 登录/登出 UI

**Files:** Modify `src/statusbar.ts`

> VSCode UI 胶水,以编译 + Task 8 手动冒烟验证。

- [ ] **Step 1:扩展 StatusBarDeps + 接入 codex**

在 `src/statusbar.ts` 顶部 import 追加:

```ts
import { CodexAuth } from './codex/auth';
```

在 `StatusBarDeps` 接口加:

```ts
  codexAuth: CodexAuth;
```

在 `providerSettings()` 里,把现有 codex 占位项的处理替换为登录/登出流程。定位到处理 `picked.codex` 的分支,替换为:

```ts
    if (picked.codex) {
      const loggedIn = await this.deps.codexAuth.isLoggedIn();
      if (loggedIn) {
        const pick = await vscode.window.showQuickPick(['登出 Codex'], { placeHolder: 'codex 已登录' });
        if (pick === '登出 Codex') {
          await vscode.commands.executeCommand('claudeProxy.codexLogout');
        }
      } else {
        await vscode.commands.executeCommand('claudeProxy.codexLogin');
      }
      return;
    }
```

> codex 项的 description 也据登录态显示:在构造 providerSettings 的 items 时,codex 那条 `description` 由原"需登录(后续支持)"改为根据 `await this.deps.codexAuth.isLoggedIn()` 显示「已登录」/「未登录,点击登录」。如该方法当前是同步构造 items,可先 `const codexIn = await this.deps.codexAuth.isLoggedIn();` 再构造。

- [ ] **Step 2:一级菜单纳入已登录的 codex**

在 `openMenu()` 里,`configuredProviders(cfg)` 得到的列表之外,若 codex 已登录则补进可切换 provider。定位到列出 provider 段的代码,在其后追加:

```ts
    if (await this.deps.codexAuth.isLoggedIn() && !provs.some(p => p.name === 'codex')) {
      items.push({ label: `$(server) codex`, description: '已登录', action: 'provider', value: 'codex' });
    }
```

(`provs` 为 `configuredProviders(cfg)` 的结果变量名;若实际变量名不同,按实际调整。)

- [ ] **Step 3:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 4:提交**

```bash
git add src/statusbar.ts
git commit -m "feat: 状态栏 codex 登录/登出 UI"
```

---

## Task 8:手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1:全量测试 + 编译**

Run: `npm test && npm run compile`
Expected: 全部 PASS,无 TS 错误。

- [ ] **Step 2:登录冒烟**

F5 启动扩展宿主(先关旧宿主):
1. 状态栏 → ⚙ Provider 设置 → codex(未登录)→ 触发登录。
2. 浏览器打开 ChatGPT 授权页,登录授权。
3. 回调成功,页面提示"登录成功",编辑器弹"Codex 登录成功"。

Expected:SecretStorage 写入凭证;无端口报错(1455 可用)。

- [ ] **Step 3:codex 转发冒烟**

状态栏 → codex 出现在可切换 provider → 选 codex 模型(如 gpt-5-codex)→ 重启宿主里的 Claude Code 会话 → 发对话。

Expected:正常文本回复 + 工具调用;Debug Console 有 `[proxy] codex upstream status 200`。

- [ ] **Step 4:刷新与登出冒烟**

- 等到接近 token 过期(或临时改短 expiresAt 验证)再发请求 → 应自动刷新、继续可用。
- Provider 设置 → codex(已登录)→ 登出 → 再发 codex 请求 → 应返回"codex 未登录"的 Anthropic 错误,Claude Code 正常报错。

---

## Self-Review 记录

- **Spec OAuth(PKCE)登录流**:Task 1(pkce)+ Task 2(oauth)+ Task 5(login 本地回调/浏览器)。
- **Spec token 存储/刷新**:Task 4(auth + SecretStorage + getValid 刷新)。
- **Spec codex 请求(专属字段)**:Task 3(buildCodexRequest)。
- **Spec codex 转发(endpoint/headers/复用 ResponsesToClaudeStream)**:Task 3(registry codex translator)+ Task 6(proxy codex 分支 + headers)。
- **Spec presets codex 真实 preset**:Task 6 Step 1。
- **Spec extension 注入 getCodexAuth + 命令**:Task 6 Step 3。
- **Spec UI 登录/登出**:Task 7。
- **类型一致性**:`generatePkce`/`randomState`(pkce.ts)、`buildAuthUrl`/`exchangeCode`/`refreshToken`/`parseAccountId`/`REDIRECT_URI`/`CodexToken`(oauth.ts)、`CodexAuth`/`isExpired`(auth.ts)、`loginCodex`(login.ts)、`buildCodexRequest`(codex/request.ts)、`getCodexAuth`(ProxyServerDeps)跨 Task 一致;codex translator 复用 `ResponsesToClaudeStream`(Part 2c)。
- **占位符扫描**:无 TBD/TODO;VSCode 胶水(login/auth 存取/proxy/statusbar/extension)以 Task 8 手动冒烟覆盖,代码完整给出。

## 范围外

- device code 登录、多 codex 账号、codex web_search/其它专属工具、非流式。
