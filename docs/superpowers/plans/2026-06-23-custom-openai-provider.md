# 自定义 OpenAI 兼容 Provider 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在扩展内自行添加 OpenAI 兼容(Chat Completions)的 provider(如本地 Ollama / LM Studio / vLLM),填 baseUrl 即可用,模型从 `/v1/models` 自动拉取、拉不到可手填,key 可选。

**Architecture:** 自定义项以 `CustomProvider {id, baseUrl}` 存 globalState,挂在 `ProxyConfig.customProviders`(可选字段)上;用纯函数 `customToPreset` 派生成 `Preset(format:'openai', api:'chat', custom:true)`,`resolvePreset` 合并内置 + 自定义查找。转发因命中现有 `CHAT_TRANSLATOR` 而零改动,只需在 `resolveTarget` 放开"自定义项可 0 key"。选模型与增删改走 statusbar 的 QuickPick。

**Tech Stack:** TypeScript、VSCode Extension API、`node:test` + `node:assert/strict`(编译后 `node --test out/**/*.test.js`)。

## Global Constraints

- 语言:注释/文档/面向用户的 QuickPick 文案用简体中文;`console.log/warn/error` 等运行时输出用英文。
- 协议仅 **OpenAI Chat Completions**(`format:'openai', api:'chat'`);不做 responses/anthropic 自定义项。
- 自定义 provider 的 **key 可选**;baseUrl **不含 `/v1`**,保存前规范化(去尾部 `/` 与尾部 `/v1`)。
- `ProxyConfig.customProviders` 为**可选字段**(`customProviders?: CustomProvider[]`),代码内一律 `cfg.customProviders ?? []`,保证现有构造点零改动。
- 不改内置 provider 行为、不改 `.claude/settings.json` 注入机制、不加新 package.json 命令。
- 测试命令统一 `npm test`(= `tsc -p ./ && node --test "out/**/*.test.js"`);新函数未实现时该命令会因 tsc 报错而 FAIL(即 TDD 的 red)。

---

### Task 1: config.ts —— CustomProvider 类型、纯助手与 normalizeBaseUrl

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: 既有 `ProxyConfig`、`ProviderEntry`。
- Produces:
  - `interface CustomProvider { id: string; baseUrl: string }`
  - `ProxyConfig.customProviders?: CustomProvider[]`
  - `addCustomProvider(cfg: ProxyConfig, cp: CustomProvider): ProxyConfig`(同 id 覆盖)
  - `updateCustomProvider(cfg: ProxyConfig, id: string, baseUrl: string): ProxyConfig`
  - `removeCustomProvider(cfg: ProxyConfig, id: string): ProxyConfig`(连带从 `providers` 摘同名项)
  - `normalizeBaseUrl(url: string): string`

- [ ] **Step 1: 写失败测试**

在 `src/config.test.ts` 的 import 中追加新符号,并在文件末尾追加用例:

```typescript
import {
  ProxyConfig, getProvider, configuredProviders, addKey, removeKey, setMapping,
  CustomProvider, addCustomProvider, updateCustomProvider, removeCustomProvider, normalizeBaseUrl,
} from './config';

test('addCustomProvider 新增', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  cfg = addCustomProvider(cfg, { id: 'ollama', baseUrl: 'http://localhost:11434' });
  assert.deepEqual(cfg.customProviders, [{ id: 'ollama', baseUrl: 'http://localhost:11434' }]);
});

test('addCustomProvider 同 id 覆盖', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = addCustomProvider(cfg, { id: 'ollama', baseUrl: 'http://b' });
  assert.deepEqual(cfg.customProviders, [{ id: 'ollama', baseUrl: 'http://b' }]);
});

test('updateCustomProvider 改 baseUrl', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = updateCustomProvider(cfg, 'ollama', 'http://b');
  assert.equal(cfg.customProviders![0].baseUrl, 'http://b');
});

test('removeCustomProvider 连带摘 key', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [{ name: 'ollama', apiKeys: ['k'] }], customProviders: [{ id: 'ollama', baseUrl: 'http://a' }] };
  cfg = removeCustomProvider(cfg, 'ollama');
  assert.deepEqual(cfg.customProviders, []);
  assert.deepEqual(cfg.providers, []);
});

test('normalizeBaseUrl 去尾斜杠与 /v1', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('https://api.x.com/v1/'), 'https://api.x.com');
  assert.equal(normalizeBaseUrl('https://example.com/api'), 'https://example.com/api');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— tsc 报错 `Module '"./config"' has no exported member 'addCustomProvider'` 等。

- [ ] **Step 3: 实现**

在 `src/config.ts` 顶部 `ProxyConfig` 之上加类型,并在 `ProxyConfig` 接口里加可选字段,文件末尾加助手:

```typescript
export interface CustomProvider {
  /** 用作 mapping 前缀,同时是 SecretStorage 中的 key 索引名 */
  id: string;
  /** 转发目标 base url,不含 /v1 */
  baseUrl: string;
}
```

`ProxyConfig` 接口内追加(放在 `providers` 之后):

```typescript
  /** 用户自定义的 OpenAI 兼容 provider(运行时从 globalState 填充) */
  customProviders?: CustomProvider[];
```

文件末尾追加:

```typescript
export function addCustomProvider(cfg: ProxyConfig, cp: CustomProvider): ProxyConfig {
  const rest = (cfg.customProviders ?? []).filter(c => c.id !== cp.id);
  return { ...cfg, customProviders: [...rest, cp] };
}

export function updateCustomProvider(cfg: ProxyConfig, id: string, baseUrl: string): ProxyConfig {
  const customProviders = (cfg.customProviders ?? []).map(c => (c.id === id ? { ...c, baseUrl } : c));
  return { ...cfg, customProviders };
}

export function removeCustomProvider(cfg: ProxyConfig, id: string): ProxyConfig {
  const customProviders = (cfg.customProviders ?? []).filter(c => c.id !== id);
  const providers = cfg.providers.filter(p => p.name !== id);
  return { ...cfg, customProviders, providers };
}

/** 规范化用户填的 base url:去尾部斜杠,再去误带的尾部 /v1(转发时由 endpointPath 统一补 /v1/...) */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新用例 + 现有用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: config 增加 CustomProvider 类型与增删改/规范化助手"
```

---

### Task 2: presets.ts —— Preset.custom、customToPreset、resolvePreset

**Files:**
- Modify: `src/presets.ts`
- Test: `src/presets.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CustomProvider`、`ProxyConfig`;既有 `Preset`、`PRESETS`、`getPreset`。
- Produces:
  - `Preset.custom?: boolean`
  - `customToPreset(cp: CustomProvider): Preset`
  - `resolvePreset(cfg: ProxyConfig, name: string): Preset | undefined`(内置优先,内部复用 `getPreset`)

- [ ] **Step 1: 写失败测试**

在 `src/presets.test.ts` 末尾追加:

```typescript
import { customToPreset, resolvePreset } from './presets';
import { ProxyConfig } from './config';

test('customToPreset 产出 openai/chat 且 custom=true', () => {
  const p = customToPreset({ id: 'ollama', baseUrl: 'http://localhost:11434' });
  assert.equal(p.id, 'ollama');
  assert.equal(p.format, 'openai');
  assert.equal(p.api, 'chat');
  assert.equal(p.forwardable, true);
  assert.equal(p.custom, true);
  assert.equal(p.baseUrl, 'http://localhost:11434');
});

const cfgWithCustom: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'ollama', baseUrl: 'http://localhost:11434' }] };

test('resolvePreset 命中内置(非 custom)', () => {
  const p = resolvePreset(cfgWithCustom, 'glm')!;
  assert.equal(p.id, 'glm');
  assert.equal(p.custom, undefined);
});

test('resolvePreset 命中自定义', () => {
  const p = resolvePreset(cfgWithCustom, 'ollama')!;
  assert.equal(p.id, 'ollama');
  assert.equal(p.custom, true);
});

test('resolvePreset 内置优先于同名自定义', () => {
  const cfg: ProxyConfig = { mapping: 'pass', providers: [], customProviders: [{ id: 'glm', baseUrl: 'http://x' }] };
  assert.equal(resolvePreset(cfg, 'glm')!.format, 'anthropic');
});

test('resolvePreset 未知返回 undefined', () => {
  assert.equal(resolvePreset(cfgWithCustom, 'nope'), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— tsc 报 `customToPreset` / `resolvePreset` 未导出。

- [ ] **Step 3: 实现**

`src/presets.ts` 顶部加 import(放在文件首行):

```typescript
import { CustomProvider, ProxyConfig } from './config';
```

`Preset` 接口内追加字段(放在 `api` 之后):

```typescript
  /** 用户自定义 provider(来自 CustomProvider),区别于内置 PRESETS */
  custom?: boolean;
```

文件末尾(`getPreset` 之后)追加:

```typescript
/** 把自定义 provider 派生成内置 Preset 同形:固定 openai / chat / 可转发 */
export function customToPreset(cp: CustomProvider): Preset {
  return { id: cp.id, format: 'openai', baseUrl: cp.baseUrl, modelsDevId: '', forwardable: true, api: 'chat', custom: true };
}

/** 合并查找:先内置 PRESETS,再 cfg.customProviders(内置优先) */
export function resolvePreset(cfg: ProxyConfig, name: string): Preset | undefined {
  const builtin = getPreset(name);
  if (builtin) {
    return builtin;
  }
  const cp = (cfg.customProviders ?? []).find(c => c.id === name);
  return cp ? customToPreset(cp) : undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/presets.ts src/presets.test.ts
git commit -m "feat: presets 增加 custom 标记与 customToPreset/resolvePreset"
```

---

### Task 3: proxy.ts —— resolveTarget 改用 resolvePreset 并放开自定义项 keyless

**Files:**
- Modify: `src/proxy.ts:2-3,32-42`
- Test: `src/proxy.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolvePreset`、`Preset.custom`。
- Produces: `resolveTarget` 对自定义项的解析(keyless 也返回 target;有 key 则带 key)。

- [ ] **Step 1: 写失败测试**

在 `src/proxy.test.ts` 末尾追加:

```typescript
test('自定义 provider 无 key 仍命中 target(keyless)', () => {
  const cfg: ProxyConfig = {
    mapping: 'ollama:llama3.2', providers: [],
    customProviders: [{ id: 'ollama', baseUrl: 'http://localhost:11434' }],
  };
  const t = resolveTarget(cfg)!;
  assert.equal(t.preset.id, 'ollama');
  assert.equal(t.preset.custom, true);
  assert.equal(t.model, 'llama3.2');
  assert.deepEqual(t.apiKeys, []);
  assert.equal(t.forwardable, true);
});

test('自定义 provider 有 key 时带上 key', () => {
  const cfg: ProxyConfig = {
    mapping: 'ollama:llama3.2',
    providers: [{ name: 'ollama', apiKeys: ['sk-x'] }],
    customProviders: [{ id: 'ollama', baseUrl: 'http://localhost:11434' }],
  };
  assert.deepEqual(resolveTarget(cfg)!.apiKeys, ['sk-x']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `resolveTarget` 用 `getPreset` 找不到 `ollama`,返回 `null`,`t!` 解引用报错 / 断言失败。

- [ ] **Step 3: 实现**

`src/proxy.ts` 第 3 行 import 由 `import { getPreset, Preset } from './presets';` 改为:

```typescript
import { resolvePreset, Preset } from './presets';
```

`resolveTarget` 内第 32 行 `const preset = getPreset(name);` 改为:

```typescript
  const preset = resolvePreset(cfg, name);
```

第 39 行 keyless 判断由 `if (preset.id !== 'codex' && apiKeys.length === 0) {` 改为:

```typescript
  if (preset.id !== 'codex' && !preset.custom && apiKeys.length === 0) {
```

（其余不变:`getTranslator(preset)` 对自定义项因 `format:'openai'/api:'chat'/id!=='codex'` 自动返回 `CHAT_TRANSLATOR`;无 key 时转发循环走 `tryKeys=[null]` 跳过认证头。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（含现有 proxy 用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: proxy 解析自定义 provider(合并查找 + keyless 放开)"
```

---

### Task 4: models.ts —— parseEndpointModels 与 fetchEndpointModels

**Files:**
- Modify: `src/models.ts`
- Test: `src/models.test.ts`

**Interfaces:**
- Consumes: 既有 `ModelInfo`。
- Produces:
  - `parseEndpointModels(json: any): ModelInfo[]`(解析 OpenAI `/v1/models` 的 `{data:[{id}]}`,按 id 升序,`name=id`,`releaseDate=''`)
  - `fetchEndpointModels(baseUrl: string, key?: string, fetcher?: typeof fetch): Promise<ModelInfo[]>`(GET `${baseUrl}/v1/models`,有 key 加 `Authorization: Bearer`)

- [ ] **Step 1: 写失败测试**

在 `src/models.test.ts` 末尾追加:

```typescript
import { parseEndpointModels, fetchEndpointModels } from './models';

test('parseEndpointModels 解析 data[].id 并按 id 升序', () => {
  const json = { data: [{ id: 'qwen2.5' }, { id: 'llama3.2' }] };
  assert.deepEqual(parseEndpointModels(json).map(m => m.id), ['llama3.2', 'qwen2.5']);
});

test('parseEndpointModels name=id 且 releaseDate 为空', () => {
  assert.deepEqual(parseEndpointModels({ data: [{ id: 'llama3.2' }] })[0], { id: 'llama3.2', name: 'llama3.2', releaseDate: '' });
});

test('parseEndpointModels 非数组/缺字段降级', () => {
  assert.deepEqual(parseEndpointModels({}), []);
  assert.deepEqual(parseEndpointModels({ data: 'x' }), []);
  assert.deepEqual(parseEndpointModels({ data: [{ foo: 1 }, { id: 'ok' }] }).map(m => m.id), ['ok']);
});

test('fetchEndpointModels 带 key 时加 Bearer 并拼对 URL', async () => {
  let seenUrl = '';
  let seenAuth: any = '';
  const fakeFetch = (async (url: string, init: any) => {
    seenUrl = url;
    seenAuth = init?.headers?.Authorization;
    return { ok: true, json: async () => ({ data: [{ id: 'llama3.2' }] }) };
  }) as unknown as typeof fetch;
  const models = await fetchEndpointModels('http://localhost:11434', 'sk-x', fakeFetch);
  assert.equal(seenUrl, 'http://localhost:11434/v1/models');
  assert.equal(seenAuth, 'Bearer sk-x');
  assert.deepEqual(models.map(m => m.id), ['llama3.2']);
});

test('fetchEndpointModels 非 2xx 抛错', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchEndpointModels('http://x', undefined, fakeFetch), /404/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— tsc 报 `parseEndpointModels` / `fetchEndpointModels` 未导出。

- [ ] **Step 3: 实现**

在 `src/models.ts` 末尾追加:

```typescript
/** 纯解析:OpenAI 兼容 /v1/models 响应 { data: [{ id }] } → ModelInfo[](按 id 升序) */
export function parseEndpointModels(json: any): ModelInfo[] {
  const data = json?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const list: ModelInfo[] = data
    .filter((m: any) => m && typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.id, releaseDate: '' }));
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

/** 拉取自定义 provider 的模型列表:GET {baseUrl}/v1/models(可选 Bearer)。fetcher 可注入用于测试。 */
export async function fetchEndpointModels(baseUrl: string, key?: string, fetcher: typeof fetch = fetch): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {};
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  const res = await fetcher(`${baseUrl}/v1/models`, { headers });
  if (!res.ok) {
    throw new Error(`models endpoint fetch failed: ${res.status}`);
  }
  return parseEndpointModels(await res.json());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/models.ts src/models.test.ts
git commit -m "feat: models 增加 /v1/models 解析与拉取(parseEndpointModels/fetchEndpointModels)"
```

---

### Task 5: extension.ts —— getConfig/applyConfig 持久化 customProviders

**Files:**
- Modify: `src/extension.ts:5,47-48,69-84`

**Interfaces:**
- Consumes: Task 1 的 `CustomProvider`、`ProxyConfig.customProviders`。
- Produces: `getConfig()` 填充 `customProviders`;`applyConfig()` 把 `customProviders` 写入 globalState。
- 说明:装配层,无单测;验证 = `npm test` 全绿(编译通过 + 现有测试不回归)。

- [ ] **Step 1: 改 import**

`src/extension.ts` 第 5 行 `import { ProxyConfig } from './config';` 改为:

```typescript
import { ProxyConfig, CustomProvider } from './config';
```

- [ ] **Step 2: 加 globalState 键常量**

在 `activate` 内 `MODELS_CACHE_KEY` 定义附近(第 47 行后)追加:

```typescript
  const CUSTOM_PROVIDERS_KEY = 'claudeProxy.customProviders';
```

- [ ] **Step 3: getConfig 填充 customProviders**

把 `getConfig` 改为:

```typescript
  const getConfig = (): ProxyConfig => ({
    mapping: context.workspaceState.get<string>(MAPPING_KEY, 'pass'),
    providers: Object.entries(providerKeys).map(([name, apiKeys]) => ({ name, apiKeys })),
    customProviders: context.globalState.get<CustomProvider[]>(CUSTOM_PROVIDERS_KEY, []),
  });
```

- [ ] **Step 4: applyConfig 持久化 customProviders**

在 `applyConfig` 内 `await context.workspaceState.update(MAPPING_KEY, cfg.mapping);` 之后追加一行:

```typescript
    await context.globalState.update(CUSTOM_PROVIDERS_KEY, cfg.customProviders ?? []);
```

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `npm test`
Expected: PASS（编译通过,现有测试全绿)。

```bash
git add src/extension.ts
git commit -m "feat: extension 持久化 customProviders 到 globalState"
```

---

### Task 6: statusbar.ts —— 自定义 provider 的增删改 UI

**Files:**
- Modify: `src/statusbar.ts:2`(import)、`providerSettings` 方法,新增 `addCustomProviderFlow` 与 `manageCustomProvider`

**Interfaces:**
- Consumes: Task 1 的 `addCustomProvider`/`updateCustomProvider`/`removeCustomProvider`/`normalizeBaseUrl`、`setMapping`;既有 `PRESETS`、`manageKeys`、`changePort`、`applyConfig`/`getConfig`。
- Produces: `providerSettings` 列出/路由自定义项;`addCustomProviderFlow()`;`manageCustomProvider(id)`。
- 说明:UI 层,无单测;验证 = `npm test` 全绿(编译通过 + 现有测试不回归)。

- [ ] **Step 1: 改 import**

只改第 2 行的 `./config` import(`presets`/`models` 的 import 改动留到 Task 7 —— 本任务新增的 `providerSettings`/`addCustomProviderFlow`/`manageCustomProvider` 不用 `resolvePreset`/`fetchEndpointModels`,而第 84 行旧 `pickModel` 仍在用 `getPreset`,提前改会编译失败)。

`src/statusbar.ts` 第 2 行改为:

```typescript
import { ProxyConfig, configuredProviders, addKey, removeKey, setMapping, addCustomProvider, updateCustomProvider, removeCustomProvider, normalizeBaseUrl } from './config';
```

- [ ] **Step 2: 替换 providerSettings 方法**

把现有 `providerSettings` 整体替换为:

```typescript
  // ---- Provider 设置:内置管 key / 自定义增删改 / codex 登录登出 / 改端口 ----
  private async providerSettings(): Promise<void> {
    type Item = vscode.QuickPickItem & { id?: string; customId?: string; add?: boolean; codex?: boolean; port?: boolean };
    const cfg = this.deps.getConfig();
    const items: Item[] = PRESETS.filter(p => p.id !== 'codex').map(p => {
      const n = cfg.providers.find(x => x.name === p.id)?.apiKeys.length ?? 0;
      return { label: p.id, description: n > 0 ? `${n} key` : '未配置', id: p.id };
    });

    const customs = cfg.customProviders ?? [];
    if (customs.length > 0) {
      items.push({ label: '自定义', kind: vscode.QuickPickItemKind.Separator });
      for (const c of customs) {
        const n = cfg.providers.find(x => x.name === c.id)?.apiKeys.length ?? 0;
        items.push({ label: c.id, description: `${c.baseUrl}${n > 0 ? ` · ${n} key` : ''}`, customId: c.id });
      }
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(add) 添加自定义 provider', add: true });

    const codexIn = await this.deps.codexAuth.isLoggedIn();
    items.push({ label: CODEX_PLACEHOLDER_ID, description: codexIn ? '已登录(点击登出)' : '未登录(点击登录 ChatGPT)', codex: true });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    const curPort = vscode.workspace.getConfiguration('claudeProxy').get<number>('port', 4001);
    items.push({ label: '$(plug) 代理端口', description: `当前 ${curPort}`, port: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择 provider 管理' });
    if (!picked) {
      return;
    }
    if (picked.add) {
      await this.addCustomProviderFlow();
      return;
    }
    if (picked.port) {
      await this.changePort();
      return;
    }
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
    if (picked.customId) {
      await this.manageCustomProvider(picked.customId);
      return;
    }
    if (picked.id) {
      await this.manageKeys(picked.id);
    }
  }

  // ---- 添加自定义 provider:输入 id + baseUrl ----
  private async addCustomProviderFlow(): Promise<void> {
    const cfg = this.deps.getConfig();
    const existing = new Set<string>([...PRESETS.map(p => p.id), ...(cfg.customProviders ?? []).map(c => c.id)]);
    const id = await vscode.window.showInputBox({
      prompt: '自定义 provider 标识(用作映射前缀,如 ollama)',
      validateInput: (v) => {
        const s = v.trim();
        if (!s) {
          return 'id 不能为空';
        }
        if (s.includes(':')) {
          return 'id 不能包含冒号';
        }
        if (existing.has(s)) {
          return `id "${s}" 已存在`;
        }
        return null;
      },
    });
    if (!id) {
      return;
    }
    const baseUrl = await vscode.window.showInputBox({
      prompt: 'Base URL(不含 /v1,例如 http://localhost:11434)',
      validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? null : '需以 http:// 或 https:// 开头'),
    });
    if (!baseUrl) {
      return;
    }
    this.deps.applyConfig(addCustomProvider(this.deps.getConfig(), { id: id.trim(), baseUrl: normalizeBaseUrl(baseUrl.trim()) }));
  }

  // ---- 管理某自定义 provider:管 key / 改 baseUrl / 删除 ----
  private async manageCustomProvider(id: string): Promise<void> {
    const cp = (this.deps.getConfig().customProviders ?? []).find(c => c.id === id);
    if (!cp) {
      return;
    }
    type Item = vscode.QuickPickItem & { act?: 'keys' | 'edit' | 'del' };
    const items: Item[] = [
      { label: '$(key) 管理 key', description: '可选,本地服务通常不需要', act: 'keys' },
      { label: '$(edit) 编辑 Base URL', description: cp.baseUrl, act: 'edit' },
      { label: '$(trash) 删除', act: 'del' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${id}(自定义)` });
    if (!picked) {
      return;
    }
    if (picked.act === 'keys') {
      await this.manageKeys(id);
      return;
    }
    if (picked.act === 'edit') {
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Base URL(不含 /v1)',
        value: cp.baseUrl,
        validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? null : '需以 http:// 或 https:// 开头'),
      });
      if (baseUrl) {
        this.deps.applyConfig(updateCustomProvider(this.deps.getConfig(), id, normalizeBaseUrl(baseUrl.trim())));
      }
      return;
    }
    if (picked.act === 'del') {
      let next = removeCustomProvider(this.deps.getConfig(), id);
      if (next.mapping.slice(0, next.mapping.indexOf(':')) === id) {
        next = setMapping(next, 'pass');
      }
      this.deps.applyConfig(next);
    }
  }
```

- [ ] **Step 3: 跑测试确认通过并提交**

Run: `npm test`
Expected: PASS（编译通过,现有测试全绿)。

```bash
git add src/statusbar.ts
git commit -m "feat: statusbar 支持自定义 provider 的添加/编辑/删除"
```

---

### Task 7: statusbar.ts —— 选模型(/v1/models + 手填)与主菜单展示 + 端到端冒烟

**Files:**
- Modify: `src/statusbar.ts` 的 `openMenu` 与 `pickModel` 方法,新增 `manualModel`

**Interfaces:**
- Consumes: Task 2 的 `resolvePreset`、Task 4 的 `fetchEndpointModels`;既有 `configuredProviders`、`parseProviderModels`、`filterFeatured`、`setMapping`。
- Produces: `openMenu` 主菜单并入自定义项(无论是否有 key);`pickModel` 对自定义项走 `/v1/models`(失败手填);`manualModel(providerName)`。
- 说明:UI 层,无单测;验证 = `npm test` 全绿 + F5 端到端手动冒烟。

- [ ] **Step 1: 改 import(`presets`/`models`)**

本任务的 `pickModel` 改用 `resolvePreset` 与 `fetchEndpointModels`,且不再用 `getPreset`,故现在一起换掉。

`src/statusbar.ts` 第 3 行由 `import { PRESETS, CODEX_PLACEHOLDER_ID, getPreset } from './presets';` 改为:

```typescript
import { PRESETS, CODEX_PLACEHOLDER_ID, resolvePreset } from './presets';
```

第 4 行由 `import { parseProviderModels, filterFeatured, ModelInfo } from './models';` 改为:

```typescript
import { parseProviderModels, filterFeatured, fetchEndpointModels, ModelInfo } from './models';
```

- [ ] **Step 2: 替换 openMenu 的 Provider 区**

把 `openMenu` 中从 `const provs = configuredProviders(cfg);` 到对应 `if (provs.length > 0 || codexIn) { ... }` 整段(即构建 Provider 分区的代码)替换为:

```typescript
    // Provider 区:有 key 的内置 + 全部自定义(无论是否有 key)
    const withKey = configuredProviders(cfg).map(p => p.name);
    const customIds = (cfg.customProviders ?? []).map(c => c.id);
    const shownNames: string[] = [...withKey];
    for (const id of customIds) {
      if (!shownNames.includes(id)) {
        shownNames.push(id);
      }
    }
    const codexIn = await this.deps.codexAuth.isLoggedIn();
    if (shownNames.length > 0 || codexIn) {
      items.push({ label: 'Provider', kind: vscode.QuickPickItemKind.Separator });
      const customSet = new Set(customIds);
      for (const name of shownNames) {
        const keyCount = cfg.providers.find(p => p.name === name)?.apiKeys.length ?? 0;
        const description = keyCount > 0 ? `${keyCount} key` : (customSet.has(name) ? '自定义' : '');
        items.push({ label: `$(server) ${name}`, description, action: 'provider', value: name });
      }
      if (codexIn && !shownNames.includes('codex')) {
        items.push({ label: `$(server) codex`, description: '已登录', action: 'provider', value: 'codex' });
      }
    }
```

（注意:原代码里 `const codexIn = await this.deps.codexAuth.isLoggedIn();` 若在被替换段之外重复声明,需删去重复声明,保证 `codexIn` 只声明一次。）

- [ ] **Step 3: 替换 pickModel 并新增 manualModel**

把现有 `pickModel` 整体替换为下面两个方法:

```typescript
  // ---- 二级:选 provider 的模型 ----
  private async pickModel(providerName: string, showAll = false): Promise<void> {
    const cfg = this.deps.getConfig();
    const preset = resolvePreset(cfg, providerName);
    if (!preset) {
      return;
    }

    // 自定义 provider:从 /v1/models 拉取(带可选 Bearer),拉不到则手填
    if (preset.custom) {
      const key = cfg.providers.find(p => p.name === providerName)?.apiKeys[0];
      let models: ModelInfo[];
      try {
        models = await fetchEndpointModels(preset.baseUrl, key);
      } catch (e) {
        console.warn('[proxy] custom models fetch failed:', e);
        await this.manualModel(providerName);
        return;
      }
      type CItem = vscode.QuickPickItem & { model?: string; manual?: boolean };
      const citems: CItem[] = models.map(m => ({ label: m.id, model: m.id }));
      citems.push({ label: '$(edit) 手动输入…', manual: true });
      const cpicked = await vscode.window.showQuickPick(citems, { placeHolder: `${providerName} 的模型` });
      if (!cpicked) {
        return;
      }
      if (cpicked.manual) {
        await this.manualModel(providerName);
        return;
      }
      if (cpicked.model) {
        this.setMapping(`${providerName}:${cpicked.model}`);
      }
      return;
    }

    // 内置 provider:models.dev 路径
    let models: ModelInfo[] = [];
    try {
      const catalog = await this.deps.getCatalog();
      models = parseProviderModels(catalog, preset.modelsDevId);
    } catch (e) {
      vscode.window.showErrorMessage(`获取模型失败: ${String(e)}`);
      return;
    }
    const shown = showAll ? models : filterFeatured(models);

    type Item = vscode.QuickPickItem & { model?: string; more?: boolean };
    const items: Item[] = shown.map(m => ({ label: m.id, description: m.name === m.id ? '' : m.name, model: m.id }));
    if (!showAll && models.length > shown.length) {
      items.push({ label: '$(ellipsis) Other…', more: true });
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${providerName} 的模型` });
    if (!picked) {
      return;
    }
    if (picked.more) {
      await this.pickModel(providerName, true);
    } else if (picked.model) {
      this.setMapping(`${providerName}:${picked.model}`);
    }
  }

  // ---- 手动输入模型名(自定义 provider 拉取失败或主动选择时) ----
  private async manualModel(providerName: string): Promise<void> {
    const model = await vscode.window.showInputBox({ prompt: `输入 ${providerName} 的模型名` });
    if (model && model.trim()) {
      this.setMapping(`${providerName}:${model.trim()}`);
    }
  }
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `npm test`
Expected: PASS（编译通过,现有测试全绿)。

```bash
git add src/statusbar.ts
git commit -m "feat: statusbar 自定义 provider 选模型(/v1/models + 手填)与主菜单展示"
```

- [ ] **Step 5: F5 端到端手动冒烟**

前置:本机起一个 Ollama(`ollama serve`,已 `ollama pull` 至少一个模型),默认 `http://localhost:11434`。在 VSCode 按 F5 启动扩展开发宿主,逐项确认:

1. 状态栏点开 → Provider 设置 → "添加自定义 provider" → 输入 `id=ollama`、`baseUrl=http://localhost:11434/v1`(故意带 /v1)→ 保存。
   - 预期:回到 Provider 设置能看到 `ollama`,description 显示 `http://localhost:11434`(/v1 已被规范化去掉)。
2. 状态栏点开主菜单 → Provider 区出现 `ollama`(标注"自定义",无 key 也展示)→ 选它。
   - 预期:弹出模型列表(来自 `/v1/models`),末尾有"手动输入…"。
3. 选一个模型 → 状态栏变为该模型名;`<项目>/.claude/settings.json` 注入了 `http://127.0.0.1:<port>`。
4. 在该项目用 Claude Code 发一条消息。
   - 预期:请求被转换成 Chat Completions 转发到 Ollama 并正常流式返回。
5. Provider 设置 → 点 `ollama` → 编辑 Base URL / 管理 key(加一个假 key,再确认主菜单显示 `1 key`)。
6. Provider 设置 → 点 `ollama` → 删除;当前 mapping 指向 ollama 时,删除后状态栏回到"透传"。
7. （可选)停掉 Ollama,重复步骤 2 选 `ollama` → 预期直接弹"输入模型名"手填框(拉取失败兜底)。

全部通过后,本任务完成。若某步失败,按 superpowers:systematic-debugging 排查后再继续。

---
