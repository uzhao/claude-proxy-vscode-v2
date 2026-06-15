# Part 4:存储整顿 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** provider key 迁入 SecretStorage(首启从旧 providers.json 迁移)、models 缓存迁入 globalState、移除文件日志;`~/.claude/proxy/` 不再使用,磁盘上不再有凭证。

**Architecture:** 新增 `src/providerKeys.ts`(SecretStorage 存取 + 迁移)。extension `activate` 时把 key 读进**内存缓存**,`getConfig()` 保持同步(providers 来自内存),`applyConfig()` 更新内存 + 异步写 SecretStorage。models `getCatalog` 改为接收缓存接口,extension 用 globalState 实现注入。proxy 移除文件日志。config 纯助手不变。

**Tech Stack:** TypeScript、VSCode SecretStorage/globalState、`node:test`。

---

## 文件结构

- Create:`src/providerKeys.ts`(+ `src/providerKeys.test.ts`)—— SecretStorage key 存取 + 旧文件迁移。
- Modify:`src/config.ts` —— 移除文件读写函数,保留纯助手。
- Modify:`src/models.ts` —— `getCatalog` 改缓存接口注入,移除文件缓存。
- Modify:`src/proxy.ts` —— 移除文件日志。
- Modify:`src/extension.ts` + `src/statusbar.ts` —— 内存 providerKeys + 迁移 + getConfig/applyConfig + models 缓存(globalState)注入 + 移除 isJsonLogging/editConfig。
- Modify:`package.json` —— 移除 `enableJsonLogging` 配置与 `editConfig` 命令。
- Modify 测试:`config.test.ts` / `models.test.ts` 相应增删。

---

## Task 1:providerKeys.ts —— SecretStorage 存取与迁移

**Files:** Create `src/providerKeys.ts`, `src/providerKeys.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/providerKeys.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProviderKeyStore, normalizeProviderKeys } from './providerKeys';

/** 内存版 fake SecretStorage */
function fakeSecrets(): any {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    _map: m,
  };
}

test('normalizeProviderKeys 丢弃非法', () => {
  assert.deepEqual(normalizeProviderKeys(null), {});
  assert.deepEqual(normalizeProviderKeys({ glm: ['k1', 2], bad: 'x' }), { glm: ['k1'] });
});

test('save 后 load 往返', async () => {
  const s = fakeSecrets();
  const store = new ProviderKeyStore(s);
  await store.save({ glm: ['k1', 'k2'] });
  assert.deepEqual(await store.load(), { glm: ['k1', 'k2'] });
});

test('load 空时返回 {}', async () => {
  assert.deepEqual(await new ProviderKeyStore(fakeSecrets()).load(), {});
});

test('migrateLegacy 把旧 providers.json 的 key 合并并删文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const legacy = path.join(dir, 'providers.json');
  fs.writeFileSync(legacy, JSON.stringify({ providers: [{ name: 'glm', apiKeys: ['k1'] }] }));
  const s = fakeSecrets();
  const store = new ProviderKeyStore(s);
  const merged = await store.migrateLegacy({}, legacy);
  assert.deepEqual(merged, { glm: ['k1'] });
  assert.deepEqual(await store.load(), { glm: ['k1'] });
  assert.equal(fs.existsSync(legacy), false);
});

test('migrateLegacy 无旧文件时原样返回', async () => {
  const store = new ProviderKeyStore(fakeSecrets());
  assert.deepEqual(await store.migrateLegacy({ kimi: ['k'] }, '/no/such/file.json'), { kimi: ['k'] });
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./providerKeys`。

- [ ] **Step 3:实现 providerKeys.ts**

创建 `src/providerKeys.ts`:

```ts
import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SECRET_KEY = 'claudeProxy.providerKeys';

/** provider → key 列表 */
export type ProviderKeys = Record<string, string[]>;

/** 旧明文文件路径(迁移用) */
export function legacyProvidersPath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'providers.json');
}

/** 规范化:仅保留 string[] 值的项,过滤非 string 元素 */
export function normalizeProviderKeys(raw: any): ProviderKeys {
  const out: ProviderKeys = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) {
        const keys = v.filter((x) => typeof x === 'string') as string[];
        out[k] = keys;
      }
    }
  }
  return out;
}

/** provider key 的安全存储:VSCode SecretStorage(系统密钥链) */
export class ProviderKeyStore {
  constructor(private secrets: vscode.SecretStorage) {}

  async load(): Promise<ProviderKeys> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return {};
    }
    try {
      return normalizeProviderKeys(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  async save(keys: ProviderKeys): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(keys));
  }

  /**
   * 首次迁移:若旧 providers.json 存在,把其中的 key 合并进 SecretStorage 并删除该文件。
   * 返回迁移后(或原样)的 keys。legacyPath 可注入用于测试。
   */
  async migrateLegacy(current: ProviderKeys, legacyPath: string = legacyProvidersPath()): Promise<ProviderKeys> {
    try {
      if (!fs.existsSync(legacyPath)) {
        return current;
      }
      const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      const merged: ProviderKeys = { ...current };
      if (Array.isArray(parsed?.providers)) {
        for (const e of parsed.providers) {
          if (e && typeof e.name === 'string' && Array.isArray(e.apiKeys)) {
            const keys = e.apiKeys.filter((k: any) => typeof k === 'string');
            if (keys.length > 0) {
              merged[e.name] = [...(merged[e.name] ?? []), ...keys];
            }
          }
        }
      }
      await this.save(merged);
      fs.unlinkSync(legacyPath);
      return merged;
    } catch {
      return current;
    }
  }
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/providerKeys.ts src/providerKeys.test.ts
git commit -m "feat: provider key 的 SecretStorage 存取与旧文件迁移"
```

---

## Task 2:config.ts —— 移除文件读写

**Files:** Modify `src/config.ts`, `src/config.test.ts`

- [ ] **Step 1:更新测试(移除文件相关用例)**

把 `src/config.test.ts` 全文替换为(仅保留纯助手测试):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProxyConfig, getProvider, configuredProviders, addKey, removeKey, setMapping,
} from './config';

test('addKey 新建与追加', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  cfg = addKey(cfg, 'glm', 'k1');
  cfg = addKey(cfg, 'glm', 'k2');
  assert.deepEqual(getProvider(cfg, 'glm')!.apiKeys, ['k1', 'k2']);
});

test('removeKey 删除指定 key', () => {
  let cfg: ProxyConfig = { mapping: 'pass', providers: [{ name: 'glm', apiKeys: ['k1', 'k2'] }] };
  cfg = removeKey(cfg, 'glm', 'k1');
  assert.deepEqual(getProvider(cfg, 'glm')!.apiKeys, ['k2']);
});

test('configuredProviders 仅含有 key 的', () => {
  const cfg: ProxyConfig = { mapping: 'pass', providers: [
    { name: 'glm', apiKeys: ['k'] },
    { name: 'kimi', apiKeys: [] },
  ] };
  assert.deepEqual(configuredProviders(cfg).map(p => p.name), ['glm']);
});

test('setMapping 不可变更新', () => {
  const cfg: ProxyConfig = { mapping: 'pass', providers: [] };
  assert.equal(setMapping(cfg, 'glm:glm-5').mapping, 'glm:glm-5');
  assert.equal(cfg.mapping, 'pass');
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— config.ts 仍导出但测试已不引用文件函数;实际此步会因 config.ts 未改、其余文件仍 import `readProviders` 等而暂不报错。直接进入 Step 3 改 config.ts;真正的失败会在编译阶段由 extension/Task 5 暴露。**本步允许 PASS(纯助手测试)**;Step 3 后全量编译在 Task 5 完成前会因 extension 仍引用旧函数而失败,属预期。

- [ ] **Step 3:改 config.ts**

把 `src/config.ts` 全文替换为(移除 fs/path/os import 与所有文件函数,保留类型与纯助手):

```ts
export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

/**
 * 运行时内存聚合视图:mapping 来自 workspaceState、providers 来自 SecretStorage(内存缓存)。
 * 本类型不对应任何磁盘格式。
 */
export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
}

export function getProvider(cfg: ProxyConfig, name: string): ProviderEntry | undefined {
  return cfg.providers.find(p => p.name === name);
}

export function configuredProviders(cfg: ProxyConfig): ProviderEntry[] {
  return cfg.providers.filter(p => p.apiKeys.length > 0);
}

export function addKey(cfg: ProxyConfig, name: string, key: string): ProxyConfig {
  const providers = cfg.providers.map(p => ({ ...p, apiKeys: [...p.apiKeys] }));
  const entry = providers.find(p => p.name === name);
  if (entry) {
    entry.apiKeys.push(key);
  } else {
    providers.push({ name, apiKeys: [key] });
  }
  return { ...cfg, providers };
}

export function removeKey(cfg: ProxyConfig, name: string, key: string): ProxyConfig {
  const providers = cfg.providers.map(p =>
    p.name === name ? { ...p, apiKeys: p.apiKeys.filter(k => k !== key) } : p,
  );
  return { ...cfg, providers };
}

export function setMapping(cfg: ProxyConfig, mapping: string): ProxyConfig {
  return { ...cfg, mapping };
}
```

- [ ] **Step 4:验证纯逻辑测试**

Run: `npx tsc -p ./ ; node --test out/config.test.js`
Expected: config 用例 PASS(整体 `tsc` 此时会因 extension.ts 仍引用 `readProviders`/`ensureProviders` 报错,属预期,Task 5 修复)。

- [ ] **Step 5:提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: config 移除文件读写,仅保留内存纯助手"
```

---

## Task 3:models.ts —— getCatalog 缓存接口注入

**Files:** Modify `src/models.ts`, `src/models.test.ts`

- [ ] **Step 1:更新测试**

在 `src/models.test.ts` 中:把 `import { readCache, writeCache, getCatalog } from './models';` 及其后所有缓存相关用例(`writeCache 后 readCache 读回`、`缓存超过 TTL 视为失效`、`getCatalog 缓存命中时不调用 fetcher`)整体替换为:

```ts
import { getCatalog, CatalogCache } from './models';

function memCache(initial: any = null): CatalogCache & { written: any } {
  const box: any = { value: initial, written: null };
  return {
    read: () => box.value,
    write: (c: any) => { box.value = c; box.written = c; },
    get written() { return box.written; },
  } as any;
}

test('getCatalog 命中缓存时不拉取', async () => {
  const cache = memCache({ a: 1 });
  let called = 0;
  const fakeFetch = (async () => { called++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
  assert.deepEqual(await getCatalog(cache, fakeFetch), { a: 1 });
  assert.equal(called, 0);
});

test('getCatalog 未命中则拉取并写缓存', async () => {
  const cache = memCache(null);
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ b: 2 }) })) as unknown as typeof fetch;
  assert.deepEqual(await getCatalog(cache, fakeFetch), { b: 2 });
  assert.deepEqual(cache.written, { b: 2 });
});

test('getCatalog 拉取失败抛错', async () => {
  const cache = memCache(null);
  const fakeFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  await assert.rejects(() => getCatalog(cache, fakeFetch), /500/);
});
```

(保留 `parseProviderModels` / `isFeatured` / `filterFeatured` 的既有用例不变。)

- [ ] **Step 2:运行,确认失败**

Run: `npx tsc -p ./ ; node --test out/models.test.js`
Expected: FAIL —— `models.ts` 尚未导出 `CatalogCache`、`getCatalog` 签名未改。

- [ ] **Step 3:改 models.ts**

在 `src/models.ts`:删除顶部 `import * as fs/path/os`;删除 `cachePath`、`CACHE_TTL_MS`、`readCache`、`writeCache`;`getCatalog` 改为:

```ts
const CATALOG_URL = 'https://models.dev/api.json';

/** catalog 缓存接口(由宿主提供 globalState 实现) */
export interface CatalogCache {
  /** 返回有效缓存,或 null(过期/无) */
  read(): any | null;
  write(catalog: any): void;
}

/** 取 catalog:优先有效缓存,否则拉取并写缓存。cache/fetcher 可注入用于测试。 */
export async function getCatalog(cache: CatalogCache, fetcher: typeof fetch = fetch): Promise<any> {
  const cached = cache.read();
  if (cached) {
    return cached;
  }
  const res = await fetcher(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  cache.write(catalog);
  return catalog;
}
```

(原 `CATALOG_URL` 常量保留/合并;`ModelInfo`/`parseProviderModels`/白名单函数不变。)

- [ ] **Step 4:运行,确认通过**

Run: `npx tsc -p ./ ; node --test out/models.test.js`
Expected: models 用例 PASS(整体 tsc 仍因 statusbar 调 `getCatalog()` 旧签名报错,Task 5 修复)。

- [ ] **Step 5:提交**

```bash
git add src/models.ts src/models.test.ts
git commit -m "refactor: getCatalog 改缓存接口注入,移除文件缓存"
```

---

## Task 4:proxy.ts —— 移除文件日志

**Files:** Modify `src/proxy.ts`

- [ ] **Step 1:移除日志相关代码**

在 `src/proxy.ts`:
- 删除顶部 `import * as fs/path/os`(仅日志使用)。
- 删除 `logDir()` 与 `saveLog()` 两个函数。
- 在 `ProxyServerDeps` 接口删除 `isJsonLogging` 字段(保留 `getConfig`、`getCodexAuth`)。
- 删除请求处理中所有 `saveLog(...)` 调用(在 codex 分支、translator 分支、anthropic 原样分支、全失败分支等处,共数处)。

其余转发/轮换/错误处理逻辑不变。

- [ ] **Step 2:编译确认本文件无 fs/日志残留**

Run: `npx tsc -p ./ 2>&1 | grep -c "proxy.ts"`
Expected: `0`(proxy.ts 自身无错;extension.ts 仍传 `isJsonLogging` 会在 extension 处报错,Task 5 修复)。

- [ ] **Step 3:提交**

```bash
git add src/proxy.ts
git commit -m "refactor: 移除 proxy 文件日志(saveLog/isJsonLogging),保留 console 日志"
```

---

## Task 5:extension.ts + statusbar.ts —— 内存装配与缓存注入

**Files:** Modify `src/extension.ts`, `src/statusbar.ts`

- [ ] **Step 1:statusbar.ts 改用注入的 getCatalog**

在 `src/statusbar.ts`:
- import 从 `import { getCatalog, parseProviderModels, filterFeatured, ModelInfo } from './models';` 改为 `import { parseProviderModels, filterFeatured, ModelInfo } from './models';`。
- `StatusBarDeps` 接口新增:`getCatalog: () => Promise<any>;`。
- `pickModel` 中 `const catalog = await getCatalog();` 改为 `const catalog = await this.deps.getCatalog();`。

- [ ] **Step 2:重写 extension.ts 装配**

在 `src/extension.ts`:
- import 调整:移除 `ensureProviders, readProviders, writeProviders, configPath`,保留 `ProxyConfig`;新增:
```ts
import { ProxyConfig } from './config';
import { ProviderKeyStore, ProviderKeys } from './providerKeys';
import { getCatalog, CatalogCache } from './models';
import { CodexAuth } from './codex/auth';
import { loginCodex } from './codex/login';
```
- 删除 `isJsonLogging` 函数。
- 删除 `editConfig` 命令注册整段。
- 在 `activate` 内,把原 `ensureProviders()` + getConfig + applyConfig 段替换为:

```ts
  const MODELS_CACHE_KEY = 'claudeProxy.modelsCache';
  const MODELS_CACHE_TTL = 24 * 60 * 60 * 1000;

  // provider key:从 SecretStorage 读入内存(首启迁移旧 providers.json)
  const keyStore = new ProviderKeyStore(context.secrets);
  let providerKeys: ProviderKeys = await keyStore.load();
  providerKeys = await keyStore.migrateLegacy(providerKeys);

  const codexAuth = new CodexAuth(context.secrets);

  // models 缓存:globalState 实现(含 TTL)
  const catalogCache: CatalogCache = {
    read: () => {
      const c = context.globalState.get<{ catalog: any; fetchedAt: number }>(MODELS_CACHE_KEY);
      return c && Date.now() - c.fetchedAt < MODELS_CACHE_TTL ? c.catalog : null;
    },
    write: (catalog) => {
      context.globalState.update(MODELS_CACHE_KEY, { catalog, fetchedAt: Date.now() });
    },
  };

  // 运行时视图:mapping(workspaceState)+ providers(内存 key 缓存)
  const getConfig = (): ProxyConfig => ({
    mapping: context.workspaceState.get<string>(MAPPING_KEY, 'pass'),
    providers: Object.entries(providerKeys).map(([name, apiKeys]) => ({ name, apiKeys })),
  });

  // applyConfig:providers 更新内存 + 写 SecretStorage;mapping 写 workspaceState;同步代理 + 刷新;翻转才 reload
  const applyConfig = async (cfg: ProxyConfig) => {
    providerKeys = Object.fromEntries(cfg.providers.map(p => [p.name, p.apiKeys]));
    await keyStore.save(providerKeys);
    await context.workspaceState.update(MAPPING_KEY, cfg.mapping);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({ context, getConfig, applyConfig, codexAuth, getCatalog: () => getCatalog(catalogCache) });
```

- `createProxyServer` 调用改为(去掉 isJsonLogging):
```ts
  server = createProxyServer({ getConfig, getCodexAuth: () => codexAuth.getValid() });
```

> 注:`codexAuth` 的构造与 `statusBar = new StatusBar(...)` 的相对顺序——确保 `codexAuth` 在 `new StatusBar` 之前定义(上面顺序已满足)。

- [ ] **Step 3:编译 + 全量测试**

Run: `npm run compile && npm test`
Expected: 无 TS 错误;全部测试 PASS。

- [ ] **Step 4:提交**

```bash
git add src/extension.ts src/statusbar.ts
git commit -m "feat: 装配改用 SecretStorage 内存缓存 + globalState 模型缓存,移除文件日志/editConfig"
```

---

## Task 6:package.json —— 移除废弃配置与命令

**Files:** Modify `package.json`

- [ ] **Step 1:移除 enableJsonLogging 配置 与 editConfig 命令**

在 `package.json` 的 `contributes.commands` 中删除 `claudeProxy.editConfig` 那一项;在 `contributes.configuration[0].properties` 中删除 `claudeProxy.enableJsonLogging`(保留 `claudeProxy.port`)。

- [ ] **Step 2:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 3:提交**

```bash
git add package.json
git commit -m "chore: 移除 enableJsonLogging 配置与 editConfig 命令"
```

---

## Task 7:手动冒烟

**Files:** 无

- [ ] **Step 1:全量测试 + 编译**

Run: `npm test && npm run compile`
Expected: 全部 PASS,无 TS 错误。

- [ ] **Step 2:迁移冒烟**

准备一个旧 `~/.claude/proxy/providers.json`(含某 provider 的 key)。F5 启动扩展:
- Provider 设置里该 provider 应显示已有 key(已从文件迁入 SecretStorage);
- `~/.claude/proxy/providers.json` 应已被删除。

- [ ] **Step 3:key 管理冒烟**

Provider 设置 → 某 provider → 添加/删除 key;重载窗口后 key 仍在(存于密钥链)。`~/.claude/proxy/` 下不再生成 providers.json。

- [ ] **Step 4:模型列表缓存冒烟**

选某 provider 的模型,列表正常(首次拉 models.dev,之后命中 globalState 缓存);`~/.claude/proxy/models-cache.json` 不再生成。

- [ ] **Step 5:转发与日志冒烟**

正常对话转发可用;`~/.claude/proxy/log/` 不再生成;调试信息仍在 Debug Console 的 `[proxy]` 日志。

---

## Self-Review 记录

- **Spec provider key → SecretStorage + 迁移**:Task 1(store+迁移)+ Task 2(config 去文件)+ Task 5(内存装配)。
- **Spec models 缓存 → globalState**:Task 3(缓存接口)+ Task 5(globalState 实现注入)。
- **Spec 移除文件日志**:Task 4(proxy)+ Task 5(extension 去 isJsonLogging)+ Task 6(package.json 去 enableJsonLogging)。
- **Spec 废弃 editConfig**:Task 5(去命令注册)+ Task 6(去 contributes)。
- **Spec getConfig 保持同步**:Task 5(providers 来自内存缓存)。
- **类型一致性**:`ProviderKeyStore`/`ProviderKeys`/`normalizeProviderKeys`(providerKeys.ts)、`CatalogCache`/`getCatalog(cache,fetcher)`(models.ts)、`StatusBarDeps.getCatalog`(statusbar.ts)、config 纯助手签名不变,跨 Task 一致。
- **占位符扫描**:无 TBD/TODO;胶水(extension/statusbar/proxy)以 Task 7 手动冒烟覆盖,代码完整给出。

## 范围外

- `.claude/settings.json` 注入机制(保留);跨窗口 SecretStorage 实时同步(YAGNI);发布(新 repo 已建,marketplace 发布后续)。
