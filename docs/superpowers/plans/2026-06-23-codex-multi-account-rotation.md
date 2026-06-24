# codex 多账号轮换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 codex(ChatGPT OAuth)支持多个账号,并在转发失败时按账号轮换,同时支持粘贴凭证 JSON 导入与按单个账号登出。

**Architecture:** `CodexAuth` 的存储从单一凭证对象改为 `StoredAccount[]`(同一 SecretStorage key,向后兼容旧格式),提供按 accountId 去重的增删、按下标取有效凭证(含刷新)、以及内存游标。proxy 的 codex 分支改为从游标起、用纯函数 `pickCodexSequence` 决定的顺序轮换账号,复用现有 `shouldRotate`。UI 在 Provider 设置里给 codex 一个子菜单:逐账号登出 + OAuth 登录 + 粘贴 JSON 导入。

**Tech Stack:** TypeScript / VSCode 扩展 API / `node:test`(纯逻辑测试,编译后 `node --test out/**/*.test.js`)。

## Global Constraints

- 人类可读文本(注释/文档)用简体中文;运行时输出(log / error message)用英文。
- 测试为纯逻辑风格:`import { test } from 'node:test'` + `node:assert/strict`,不起真实 HTTP server、不打真实网络。
- 凭证只存 VSCode SecretStorage,key 固定为 `claudeProxy.codex`,不落明文磁盘。
- surgical changes:只改与本特性相关的代码,匹配现有风格。
- 验证命令统一:`npm test`(等价 `tsc -p ./ && node --test "out/**/*.test.js"`);仅编译用 `npm run compile`。

---

### Task 1: oauth 增加 email 解析

**Files:**
- Modify: `src/codex/oauth.ts`(在 `parseAccountId` 之后新增 `parseEmail`)
- Test: `src/codex/oauth.test.ts`

**Interfaces:**
- Produces: `parseEmail(idToken: string): string` —— 从 id_token(JWT,不验签)解析邮箱,失败返回 `''`。

- [ ] **Step 1: 写失败测试**

在 `src/codex/oauth.test.ts` 顶部 import 加上 `parseEmail`,并追加:

```ts
test('parseEmail 从 id_token 取邮箱(profile 优先,回退顶层 email)', () => {
  const p1 = Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email: 'p@b.c' }, email: 'top@b.c' })).toString('base64url');
  assert.equal(parseEmail(`h.${p1}.s`), 'p@b.c');
  const p2 = Buffer.from(JSON.stringify({ email: 'top@b.c' })).toString('base64url');
  assert.equal(parseEmail(`h.${p2}.s`), 'top@b.c');
  assert.equal(parseEmail('bad'), '');
});
```

把第 3 行 import 改为:

```ts
import { buildAuthUrl, exchangeCode, refreshToken, parseAccountId, parseEmail, REDIRECT_URI } from './oauth';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `parseEmail is not a function`(或编译报错 找不到导出 `parseEmail`)。

- [ ] **Step 3: 实现 parseEmail**

在 `src/codex/oauth.ts` 末尾、`parseAccountId` 函数之后追加:

```ts
/** 解析 id_token(JWT,不验签)取邮箱:优先 profile.email,回退顶层 email;失败返回 '' */
export function parseEmail(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return '';
    }
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/profile']?.email ?? claims?.email ?? '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS(全部测试,含新 `parseEmail` 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/codex/oauth.ts src/codex/oauth.test.ts
git commit -m "feat(codex): id_token 邮箱解析 parseEmail"
```

---

### Task 2: CodexAuth 多账号存储与导入

**Files:**
- Modify: `src/codex/auth.ts`(整体重写为多账号)
- Test: `src/codex/auth.test.ts`

**Interfaces:**
- Consumes: `refreshToken`, `parseAccountId`, `parseEmail`(来自 `./oauth`)。
- Produces:
  - `interface StoredAccount { accessToken: string; refreshToken: string; accountId: string; email: string; expiresAt: number }`
  - `isExpired(expiresAt: number, now?: number): boolean`(保持原签名)
  - `parseImportedCredential(text: string): StoredAccount`(解析 codex CLI 风格凭证 JSON;缺 access_token/refresh_token 抛错)
  - `class CodexAuth`,方法:
    - `save(t: { accessToken: string; refreshToken: string; idToken: string; expiresIn: number }): Promise<void>`(OAuth 登录用,内部走 `add`)
    - `add(account: StoredAccount): Promise<void>`(按 accountId 去重:已存在则更新)
    - `removeByAccountId(id: string): Promise<void>`
    - `logoutAll(): Promise<void>`
    - `list(): Promise<{ accountId: string; email: string }[]>`
    - `count(): Promise<number>`
    - `isLoggedIn(): Promise<boolean>`
    - `startIndex(): number` / `markSuccess(i: number): void`(内存游标)
    - `validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>`(过期则刷新写回)

- [ ] **Step 1: 写失败测试**

把 `src/codex/auth.test.ts` 整体替换为:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired, parseImportedCredential, CodexAuth } from './auth';

test('isExpired:剩余 < 60s 视为过期', () => {
  const now = 1_000_000;
  assert.equal(isExpired(now + 30_000, now), true);
  assert.equal(isExpired(now + 120_000, now), false);
  assert.equal(isExpired(now - 1, now), true);
});

test('parseImportedCredential 解析 codex CLI 凭证', () => {
  const a = parseImportedCredential(JSON.stringify({
    access_token: 'at', refresh_token: 'rt', account_id: 'acc1',
    email: 'x@b.c', expired: '2026-06-30T16:49:38Z',
  }));
  assert.equal(a.accessToken, 'at');
  assert.equal(a.refreshToken, 'rt');
  assert.equal(a.accountId, 'acc1');
  assert.equal(a.email, 'x@b.c');
  assert.equal(a.expiresAt, Date.parse('2026-06-30T16:49:38Z'));
});

test('parseImportedCredential 字段回退到 id_token / 时间无效置 0', () => {
  const idToken = `h.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'accFromTok' },
    'https://api.openai.com/profile': { email: 'tok@b.c' },
  })).toString('base64url')}.s`;
  const a = parseImportedCredential(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: idToken }));
  assert.equal(a.accountId, 'accFromTok');
  assert.equal(a.email, 'tok@b.c');
  assert.equal(a.expiresAt, 0);
});

test('parseImportedCredential 缺 access_token / refresh_token 抛错', () => {
  assert.throws(() => parseImportedCredential('{"refresh_token":"rt"}'));
  assert.throws(() => parseImportedCredential('not json'));
});

/** 内存假 SecretStorage */
function fakeSecrets() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    onDidChange: (() => ({ dispose() {} })) as any,
  } as any;
}

const acc = (over: Partial<any> = {}) => ({
  accessToken: 'at', refreshToken: 'rt', accountId: 'a1', email: 'a1@b.c',
  expiresAt: Date.now() + 3_600_000, ...over,
});

test('add 按 accountId 去重(更新而非新增)', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1', email: 'old@b.c' }));
  await auth.add(acc({ accountId: 'a2' }));
  await auth.add(acc({ accountId: 'a1', email: 'new@b.c' }));
  const list = await auth.list();
  assert.equal(list.length, 2);
  assert.equal(list.find(x => x.accountId === 'a1')!.email, 'new@b.c');
});

test('兼容读取旧单对象格式', async () => {
  const s = fakeSecrets();
  await s.store('claudeProxy.codex', JSON.stringify({ accessToken: 'at', refreshToken: 'rt', accountId: 'old', expiresAt: 123 }));
  const auth = new CodexAuth(s);
  assert.equal(await auth.count(), 1);
  assert.deepEqual(await auth.list(), [{ accountId: 'old', email: '' }]);
});

test('removeByAccountId 删除指定账号', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1' }));
  await auth.add(acc({ accountId: 'a2' }));
  await auth.removeByAccountId('a1');
  assert.deepEqual((await auth.list()).map(x => x.accountId), ['a2']);
});

test('游标 markSuccess / startIndex', () => {
  const auth = new CodexAuth(fakeSecrets());
  assert.equal(auth.startIndex(), 0);
  auth.markSuccess(2);
  assert.equal(auth.startIndex(), 2);
});

test('validAt 未过期直接返回,越界返回 null', async () => {
  const auth = new CodexAuth(fakeSecrets());
  await auth.add(acc({ accountId: 'a1', accessToken: 'tok1' }));
  assert.deepEqual(await auth.validAt(0), { accessToken: 'tok1', accountId: 'a1' });
  assert.equal(await auth.validAt(5), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `auth.ts` 尚未导出 `parseImportedCredential`,以及 `CodexAuth` 缺 `add/list/count/...` 方法(编译报错)。

- [ ] **Step 3: 重写 auth.ts**

把 `src/codex/auth.ts` 整体替换为:

```ts
import type * as vscode from 'vscode';
import { refreshToken, parseAccountId, parseEmail } from './oauth';

const SECRET_KEY = 'claudeProxy.codex';

interface StoredAccount {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string;
  expiresAt: number; // epoch ms
}

/** access token 是否需要刷新(剩余不足 60s) */
export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now < 60_000;
}

/** 解析 codex CLI 风格凭证 JSON → StoredAccount;缺 access_token/refresh_token 抛错 */
export function parseImportedCredential(text: string): StoredAccount {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('invalid credential JSON');
  }
  const accessToken = j?.access_token;
  const refreshTok = j?.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshTok !== 'string' || !refreshTok) {
    throw new Error('missing access_token or refresh_token');
  }
  const idToken = typeof j?.id_token === 'string' ? j.id_token : '';
  const accountId = (typeof j?.account_id === 'string' && j.account_id) || parseAccountId(idToken);
  const email = (typeof j?.email === 'string' && j.email) || parseEmail(idToken);
  const ts = j?.expired ? Date.parse(j.expired) : NaN;
  const expiresAt = Number.isFinite(ts) ? ts : 0;
  return { accessToken, refreshToken: refreshTok, accountId, email, expiresAt };
}

/** codex 凭证管理:多账号,基于 VSCode SecretStorage;转发前确保 access token 有效 */
export class CodexAuth {
  private cursor = 0;

  constructor(private secrets: vscode.SecretStorage) {}

  /** OAuth 登录成功后保存(token 来自 exchangeCode) */
  async save(t: { accessToken: string; refreshToken: string; idToken: string; expiresIn: number }): Promise<void> {
    await this.add({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accountId: parseAccountId(t.idToken),
      email: parseEmail(t.idToken),
      expiresAt: Date.now() + t.expiresIn * 1000,
    });
  }

  /** 按 accountId 去重新增/更新 */
  async add(account: StoredAccount): Promise<void> {
    const list = await this.readAll();
    const i = account.accountId ? list.findIndex(a => a.accountId === account.accountId) : -1;
    if (i >= 0) {
      list[i] = account;
    } else {
      list.push(account);
    }
    await this.writeAll(list);
  }

  async removeByAccountId(id: string): Promise<void> {
    const list = (await this.readAll()).filter(a => a.accountId !== id);
    await this.writeAll(list);
  }

  async logoutAll(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  async list(): Promise<{ accountId: string; email: string }[]> {
    return (await this.readAll()).map(a => ({ accountId: a.accountId, email: a.email }));
  }

  async count(): Promise<number> {
    return (await this.readAll()).length;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  startIndex(): number {
    return this.cursor;
  }

  markSuccess(i: number): void {
    this.cursor = i;
  }

  /** 取第 i 个账号有效凭证;过期则刷新并写回;未登录/刷新失败返回 null */
  async validAt(i: number): Promise<{ accessToken: string; accountId: string } | null> {
    const list = await this.readAll();
    const cur = list[i];
    if (!cur) {
      return null;
    }
    if (!isExpired(cur.expiresAt)) {
      return { accessToken: cur.accessToken, accountId: cur.accountId };
    }
    try {
      const fresh = await refreshToken(cur.refreshToken);
      const next: StoredAccount = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || cur.refreshToken,
        accountId: parseAccountId(fresh.idToken) || cur.accountId,
        email: parseEmail(fresh.idToken) || cur.email,
        expiresAt: Date.now() + fresh.expiresIn * 1000,
      };
      // 写回:重新读取后按 accountId 定位(刷新期间列表可能已变)
      const latest = await this.readAll();
      const idx = next.accountId ? latest.findIndex(a => a.accountId === next.accountId) : i;
      if (idx >= 0) {
        latest[idx] = next;
      } else {
        latest[i] = next;
      }
      await this.writeAll(latest);
      return { accessToken: next.accessToken, accountId: next.accountId };
    } catch (e) {
      console.error('codex token refresh failed', e);
      return null;
    }
  }

  /** 读取账号数组,兼容旧单对象格式 */
  private async readAll(): Promise<StoredAccount[]> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((a) => a && typeof a.accessToken === 'string');
      }
      if (parsed && typeof parsed.accessToken === 'string') {
        return [{
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken ?? '',
          accountId: parsed.accountId ?? '',
          email: parsed.email ?? '',
          expiresAt: parsed.expiresAt ?? 0,
        }];
      }
      return [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: StoredAccount[]): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(list));
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS(含 auth.test.ts 全部新用例)。

- [ ] **Step 5: 提交**

```bash
git add src/codex/auth.ts src/codex/auth.test.ts
git commit -m "feat(codex): CodexAuth 多账号存储/去重/导入/游标"
```

---

### Task 3: proxy 按账号轮换

**Files:**
- Modify: `src/proxy.ts`(新增 `pickCodexSequence`;改 `ProxyServerDeps`;重写 codex 分支)
- Test: `src/proxy.test.ts`

**Interfaces:**
- Consumes: `shouldRotate`(已存在)。
- Produces:
  - `pickCodexSequence(count: number, startIndex: number): number[]` —— 从 `startIndex`(对 count 取模)起、长度 count 的轮转下标序列。
  - `interface CodexAccess { count(): Promise<number>; startIndex(): number; validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>; markSuccess(i: number): void }`
  - `ProxyServerDeps` 用 `codex?: CodexAccess` 取代旧的 `getCodexAuth?`。

- [ ] **Step 1: 写失败测试**

在 `src/proxy.test.ts` 第 3 行 import 加上 `pickCodexSequence`:

```ts
import { resolveTarget, shouldRotate, pickCodexSequence } from './proxy';
```

并在文件末尾追加:

```ts
test('pickCodexSequence 从游标起轮转并回绕', () => {
  assert.deepEqual(pickCodexSequence(3, 0), [0, 1, 2]);
  assert.deepEqual(pickCodexSequence(3, 1), [1, 2, 0]);
  assert.deepEqual(pickCodexSequence(3, 2), [2, 0, 1]);
  assert.deepEqual(pickCodexSequence(3, 5), [2, 0, 1]); // 5 % 3 = 2
  assert.deepEqual(pickCodexSequence(1, 0), [0]);
  assert.deepEqual(pickCodexSequence(0, 0), []);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `pickCodexSequence` 未导出(编译报错)。

- [ ] **Step 3a: 新增 pickCodexSequence 并改 deps 接口**

在 `src/proxy.ts` 的 `shouldRotate` 函数之后追加:

```ts
/** 从 startIndex(对 count 取模)起、长度 count 的轮转下标序列;count<=0 返回 [] */
export function pickCodexSequence(count: number, startIndex: number): number[] {
  if (count <= 0) {
    return [];
  }
  const start = ((startIndex % count) + count) % count;
  const seq: number[] = [];
  for (let off = 0; off < count; off++) {
    seq.push((start + off) % count);
  }
  return seq;
}
```

把 `ProxyServerDeps` 接口(及其上方 codex 相关注释)改为:

```ts
/** codex 多账号访问接口:计数 / 游标 / 按下标取有效凭证 / 标记成功 */
export interface CodexAccess {
  count(): Promise<number>;
  startIndex(): number;
  validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>;
  markSuccess(i: number): void;
}

export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** codex 多账号凭证访问;未登录时 count() 返回 0 */
  codex?: CodexAccess;
}
```

- [ ] **Step 3b: 重写 codex 分支**

把 `src/proxy.ts` 中 `// codex:用 OAuth token 单次转发...` 整个 `if (target && target.preset.id === 'codex') { ... }` 块(原约 144–195 行)替换为:

```ts
        // codex:多账号轮换(从游标起,遇 401/429/5xx 换下一个账号)
        if (target && target.preset.id === 'codex') {
          const codex = deps.codex;
          const n = codex ? await codex.count() : 0;
          if (!codex || n === 0) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(anthropicError('authentication_error', 'codex 未登录,请在 Provider 设置中登录 ChatGPT。'));
            return;
          }
          const seq = pickCodexSequence(n, codex.startIndex());
          let lastErr: any = null;
          for (let s = 0; s < seq.length; s++) {
            const idx = seq[s];
            const auth = await codex.validAt(idx);
            if (!auth) {
              lastErr = new Error(`codex account #${idx} unavailable`);
              continue;
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
              console.log(`[proxy] codex upstream status ${upstream.status} (account #${idx})`);

              if (shouldRotate(upstream.status) && s < seq.length - 1) {
                console.warn(`[proxy] codex account #${idx} failed (${upstream.status}), rotating`);
                await upstream.body?.cancel();
                continue;
              }

              if (upstream.status >= 400) {
                const errText = await upstream.text();
                res.writeHead(upstream.status, { 'content-type': 'application/json' });
                res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
                return;
              }

              codex.markSuccess(idx);
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
              lastErr = err;
              if (s < seq.length - 1) {
                console.warn(`[proxy] codex account #${idx} network error, rotating`, err);
                continue;
              }
            }
          }

          console.error('[proxy] codex all accounts failed:', lastErr);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(anthropicError('api_error', String(lastErr?.message ?? lastErr)));
          return;
        }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS(含 `pickCodexSequence` 用例;其余测试不回归)。

- [ ] **Step 5: 提交**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat(proxy): codex 多账号按游标轮换"
```

---

### Task 4: extension 接线(命令 + proxy 装配)

**Files:**
- Modify: `src/extension.ts:98-103`(命令注册)、`src/extension.ts:107`(createProxyServer 装配)、顶部 import。

**Interfaces:**
- Consumes: `CodexAuth.{count,startIndex,validAt,markSuccess,removeByAccountId,logoutAll,add}`、`parseImportedCredential`、`CodexAccess`(proxy)。
- Produces:
  - 命令 `claudeProxy.codexLogout`:带可选 `accountId` 参数 → 有则按账号删,无则全删。
  - 命令 `claudeProxy.codexImport`:`showInputBox` 收 JSON → `parseImportedCredential` → `add`。

- [ ] **Step 1: 改 import**

把 `src/extension.ts` 顶部 `import { CodexAuth } from './codex/auth';` 改为:

```ts
import { CodexAuth, parseImportedCredential } from './codex/auth';
```

- [ ] **Step 2: 改命令注册**

把 `src/extension.ts` 的这段(约 97–103 行):

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.codexLogin', () => loginCodex(codexAuth)),
    vscode.commands.registerCommand('claudeProxy.codexLogout', async () => {
      await codexAuth.logout();
      vscode.window.showInformationMessage('已登出 Codex');
    }),
  );
```

替换为:

```ts
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.codexLogin', async () => {
      const ok = await loginCodex(codexAuth);
      if (ok) {
        statusBar.refresh();
      }
    }),
    vscode.commands.registerCommand('claudeProxy.codexLogout', async (accountId?: string) => {
      if (accountId) {
        await codexAuth.removeByAccountId(accountId);
      } else {
        await codexAuth.logoutAll();
      }
      statusBar.refresh();
      vscode.window.showInformationMessage('codex account logged out');
    }),
    vscode.commands.registerCommand('claudeProxy.codexImport', async () => {
      const text = await vscode.window.showInputBox({
        prompt: '粘贴 codex 凭证 JSON',
        placeHolder: '{"access_token":"...","refresh_token":"...",...}',
        ignoreFocusOut: true,
        password: true,
      });
      if (!text) {
        return;
      }
      try {
        await codexAuth.add(parseImportedCredential(text));
        statusBar.refresh();
        vscode.window.showInformationMessage('codex credential imported');
      } catch (e) {
        vscode.window.showErrorMessage(`codex import failed: ${String((e as any)?.message ?? e)}`);
      }
    }),
  );
```

- [ ] **Step 3: 改 proxy 装配**

把 `src/extension.ts:107`:

```ts
  server = createProxyServer({ getConfig, getCodexAuth: () => codexAuth.getValid() });
```

替换为:

```ts
  server = createProxyServer({
    getConfig,
    codex: {
      count: () => codexAuth.count(),
      startIndex: () => codexAuth.startIndex(),
      validAt: (i) => codexAuth.validAt(i),
      markSuccess: (i) => codexAuth.markSuccess(i),
    },
  });
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无类型错误(`getValid`/`logout` 已不再被引用;`codex` 装配类型匹配 `CodexAccess`)。

- [ ] **Step 5: 提交**

```bash
git add src/extension.ts
git commit -m "feat(extension): codex 单账号登出/JSON 导入命令 + proxy 多账号装配"
```

---

### Task 5: 状态栏 codex 子菜单

**Files:**
- Modify: `src/statusbar.ts`(主菜单 codex 描述显示账号数;Provider 设置 codex 条目改为打开子菜单;新增 `manageCodex` 方法)。

**Interfaces:**
- Consumes: `CodexAuth.{count,list}`;命令 `claudeProxy.codexLogin` / `claudeProxy.codexLogout`(带 accountId)/ `claudeProxy.codexImport`。

- [ ] **Step 1: 主菜单显示账号数**

把 `src/statusbar.ts` 的(约 61、70–72 行):

```ts
    const codexIn = await this.deps.codexAuth.isLoggedIn();
```
…
```ts
      if (codexIn && !shownNames.includes('codex')) {
        items.push({ label: `$(server) codex`, description: '已登录', action: 'provider', value: 'codex' });
      }
```

分别改为:

```ts
    const codexCount = await this.deps.codexAuth.count();
    const codexIn = codexCount > 0;
```
…
```ts
      if (codexIn && !shownNames.includes('codex')) {
        items.push({ label: `$(server) codex`, description: `已登录 ${codexCount} 个账号`, action: 'provider', value: 'codex' });
      }
```

- [ ] **Step 2: Provider 设置 codex 条目改为子菜单**

把 `src/statusbar.ts` 的(约 185–186 行):

```ts
    const codexIn = await this.deps.codexAuth.isLoggedIn();
    items.push({ label: CODEX_PLACEHOLDER_ID, description: codexIn ? '已登录(点击登出)' : '未登录(点击登录 ChatGPT)', codex: true });
```

替换为:

```ts
    const codexCount = await this.deps.codexAuth.count();
    items.push({ label: CODEX_PLACEHOLDER_ID, description: codexCount > 0 ? `已登录 ${codexCount} 个账号` : '未登录(点击登录 ChatGPT)', codex: true });
```

把 codex 分支(约 203–213 行):

```ts
    if (picked.codex) {
      if (codexIn) {
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

替换为:

```ts
    if (picked.codex) {
      await this.manageCodex();
      return;
    }
```

- [ ] **Step 3: 新增 manageCodex 方法**

在 `src/statusbar.ts` 的 `providerSettings` 方法之后(同一类内)新增:

```ts
  // ---- codex 账号管理:逐账号登出 / OAuth 登录 / 粘贴 JSON 导入 ----
  private async manageCodex(): Promise<void> {
    type CItem = vscode.QuickPickItem & { accountId?: string; login?: boolean; import?: boolean };
    const accounts = await this.deps.codexAuth.list();
    const items: CItem[] = accounts.map(a => ({
      label: `$(account) ${a.email || a.accountId || '(unknown)'}`,
      description: '点击登出此账号',
      accountId: a.accountId,
    }));
    if (accounts.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: '$(sign-in) 登录新账号(ChatGPT OAuth)', login: true });
    items.push({ label: '$(clippy) 粘贴凭证 JSON…', import: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'codex 账号管理' });
    if (!picked) {
      return;
    }
    if (picked.login) {
      await vscode.commands.executeCommand('claudeProxy.codexLogin');
      return;
    }
    if (picked.import) {
      await vscode.commands.executeCommand('claudeProxy.codexImport');
      return;
    }
    if (picked.accountId !== undefined) {
      const name = picked.label.replace(/^\$\(account\) /, '');
      const confirm = await vscode.window.showWarningMessage(`登出 codex 账号 ${name}?`, '登出');
      if (confirm === '登出') {
        await vscode.commands.executeCommand('claudeProxy.codexLogout', picked.accountId);
      }
    }
  }
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/statusbar.ts
git commit -m "feat(statusbar): codex 多账号子菜单(逐账号登出/登录/导入)"
```

---

## 验证(全量)

- [ ] **运行完整测试套件**

Run: `npm test`
Expected: 全部 PASS,无回归。

- [ ] **手动冒烟(F5 扩展开发宿主)**

1. Provider 设置 → codex → 粘贴凭证 JSON 导入一个账号 → 列表显示该 email。
2. 再「登录新账号」OAuth 登录第二个 → 主菜单显示「已登录 2 个账号」。
3. 选 codex 模型,发一次 Claude Code 请求,确认 log 打印 `codex upstream status ... (account #x)` 且正常返回。
4. 逐账号登出其一 → 列表只剩另一个。

---

## Self-Review 记录

- **Spec coverage**:存储模型(Task 2)、向后兼容读取(Task 2 readAll)、去重(Task 2 add)、导入解析(Task 2)、email 解析(Task 1)、proxy 轮换+游标(Task 3)、deps 接口(Task 3/4)、单账号登出(Task 4/5)、粘贴导入入口(Task 4/5)、主菜单账号数(Task 5)、测试(Task 1/2/3)均有对应任务。
- **测试范围说明**:proxy 端到端「429→切换→成功」依赖真实 fetch,本仓库测试为纯逻辑、无 fetch mock 基建,故轮换顺序以纯函数 `pickCodexSequence` 覆盖,游标/刷新/去重以 `CodexAuth` 单测覆盖,端到端行为由手动冒烟兜底——与现有测试风格一致。
- **类型一致性**:`CodexAccess` 在 proxy 定义、extension 装配、CodexAuth 方法签名三处一致(`count/startIndex/validAt/markSuccess`)。`StoredAccount` 字段(含新增 `email`)在 readAll/add/validAt/save/parseImportedCredential 间一致。
- **占位符**:无 TBD/TODO,每个代码步骤均含完整代码。
```
