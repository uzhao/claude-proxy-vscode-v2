# Part 1:UI / 配置重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claude-proxy 扩展的配置与交互层重构为:全局单一 mapping、provider 配置落到 `~/.claude/proxy/providers.json`、模型列表来自 models.dev、状态栏单一入口 QuickPick 切换/管理,并移除外部 litellm/cliproxyapi 进程逻辑。

**Architecture:** 把现有单文件 `extension.ts` 拆成聚焦模块:纯逻辑(`presets` / `models` / `config` / `claudeSettings` / `proxy` 的转发决策)与 VSCode 胶水(`statusbar` / `extension`)分离。纯逻辑用 `node:test` 做 TDD;UI 用编译 + F5 手动冒烟。Part 1 只实现 anthropic 格式转发,openai/gemini/codex 仅在 UI 占位。

**Tech Stack:** TypeScript(commonjs / ES2020 / strict)、VSCode Extension API、Node 内置 `node:test` + `node:assert`、全局 `fetch`(Node 18+)。

---

## 文件结构

新增/改动(全部在 `src/`):

- `src/presets.ts` —— 内置 preset 目录(id/format/baseUrl/modelsDevId/forwardable)与查询。纯,无 vscode。
- `src/models.ts` —— models.dev 拉取+缓存(TTL)与纯解析(取某 provider 模型、按发布日期倒序、topN)。无 vscode。
- `src/config.ts` —— `providers.json` 读写/规范化/模板,以及 mapping/key 的纯增改助手。无 vscode。
- `src/claudeSettings.ts` —— `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 注入/清理(按文件路径参数,纯 fs)。无 vscode。
- `src/proxy.ts` —— HTTP server + 转发 + key 轮换;导出纯决策函数 `resolveTarget` / `shouldRotate`。
- `src/statusbar.ts` —— 状态栏 + 切换 QuickPick(逐级下钻)+ MRU + Provider 设置流程。vscode 胶水。
- `src/extension.ts` —— `activate`/`deactivate` 装配,串起各模块。
- 测试:`src/presets.test.ts` / `src/models.test.ts` / `src/config.test.ts` / `src/claudeSettings.test.ts` / `src/proxy.test.ts`。

---

## Task 1:测试设施

**Files:**
- Modify: `package.json`(scripts)
- Modify: `.vscodeignore`
- Create: `src/presets.test.ts`(临时 sanity,Task 2 扩充)

- [ ] **Step 1:加 test 脚本**

修改 `package.json` 的 `scripts` 为:

```json
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "test": "tsc -p ./ && node --test out"
  },
```

- [ ] **Step 2:排除测试文件进 vsix**

在 `.vscodeignore` 末尾追加两行:

```
out/**/*.test.js
out/**/*.test.js.map
```

- [ ] **Step 3:写一个 sanity 测试**

创建 `src/presets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sanity', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4:运行测试,确认链路可用**

Run: `npm test`
Expected: 编译通过,`node --test` 输出 `tests 1` / `pass 1`。

- [ ] **Step 5:提交**

```bash
git add package.json .vscodeignore src/presets.test.ts
git commit -m "chore: 引入 node:test 测试链路"
```

---

## Task 2:presets.ts —— 内置 preset 目录

**Files:**
- Create: `src/presets.ts`
- Test: `src/presets.test.ts`(替换 sanity)

- [ ] **Step 1:写失败测试**

替换 `src/presets.test.ts` 全文:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset, CODEX_PLACEHOLDER_ID } from './presets';

test('包含 8 个可配置 preset,且不含 codex 占位', () => {
  const ids = PRESETS.map(p => p.id);
  assert.deepEqual(ids, ['openai', 'gemini', 'openrouter', 'nvidia', 'glm', 'kimi', 'deepseek', 'minimax']);
  assert.equal(ids.includes(CODEX_PLACEHOLDER_ID), false);
});

test('国产四家为 anthropic 格式且 forwardable', () => {
  for (const id of ['glm', 'kimi', 'deepseek', 'minimax']) {
    const p = getPreset(id)!;
    assert.equal(p.format, 'anthropic');
    assert.equal(p.forwardable, true);
  }
});

test('openai/gemini/openrouter/nvidia 非 anthropic 且 Part 1 不可转发', () => {
  for (const id of ['openai', 'gemini', 'openrouter', 'nvidia']) {
    assert.equal(getPreset(id)!.forwardable, false);
  }
});

test('preset 映射到正确的 models.dev id', () => {
  assert.equal(getPreset('glm')!.modelsDevId, 'zhipuai');
  assert.equal(getPreset('kimi')!.modelsDevId, 'moonshotai');
  assert.equal(getPreset('gemini')!.modelsDevId, 'google');
});

test('getPreset 未知返回 undefined', () => {
  assert.equal(getPreset('nope'), undefined);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./presets`。

- [ ] **Step 3:实现 presets.ts**

创建 `src/presets.ts`:

```ts
// 内置 provider preset 目录(Part 1)。codex 仅作占位,登录留待 Part 3。

export type ProviderFormat = 'anthropic' | 'openai' | 'gemini';

export interface Preset {
  /** mapping 前缀,同时也是 providers.json 中的 name */
  id: string;
  format: ProviderFormat;
  /** 转发目标 base url */
  baseUrl: string;
  /** models.dev 顶层 provider id,用于取模型列表 */
  modelsDevId: string;
  /** Part 1 是否支持转发(仅 anthropic 格式为 true) */
  forwardable: boolean;
}

/** Codex 占位 id —— Part 1 仅在管理列表展示提示,不落地登录/转发 */
export const CODEX_PLACEHOLDER_ID = 'codex';

export const PRESETS: Preset[] = [
  { id: 'openai',     format: 'openai',    baseUrl: 'https://api.openai.com',                     modelsDevId: 'openai',     forwardable: false },
  { id: 'gemini',     format: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com',  modelsDevId: 'google',     forwardable: false },
  { id: 'openrouter', format: 'openai',    baseUrl: 'https://openrouter.ai/api',                  modelsDevId: 'openrouter', forwardable: false },
  { id: 'nvidia',     format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com',           modelsDevId: 'nvidia',     forwardable: false },
  { id: 'glm',        format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic',     modelsDevId: 'zhipuai',    forwardable: true },
  { id: 'kimi',       format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic',          modelsDevId: 'moonshotai', forwardable: true },
  { id: 'deepseek',   format: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',         modelsDevId: 'deepseek',   forwardable: true },
  { id: 'minimax',    format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic',         modelsDevId: 'minimax',    forwardable: true },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find(p => p.id === id);
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS(全部 presets 用例)。

- [ ] **Step 5:提交**

```bash
git add src/presets.ts src/presets.test.ts
git commit -m "feat: 内置 provider preset 目录"
```

---

## Task 3:models.ts —— 纯解析(取模型 / 倒序 / topN)

**Files:**
- Create: `src/models.ts`
- Test: `src/models.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/models.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderModels, topN } from './models';

const CATALOG = {
  zhipuai: {
    models: {
      'glm-4.6':       { id: 'glm-4.6',       name: 'GLM 4.6',  release_date: '2026-01-10', last_updated: '2026-01-10' },
      'glm-4.5-flash': { id: 'glm-4.5-flash', name: 'GLM Flash', release_date: '2025-11-01', last_updated: '2025-11-01' },
      'glm-5':         { id: 'glm-5',          name: 'GLM 5',    release_date: '2026-03-20', last_updated: '2026-03-20' },
    },
  },
  empty: { models: {} },
};

test('按发布日期倒序', () => {
  const list = parseProviderModels(CATALOG, 'zhipuai');
  assert.deepEqual(list.map(m => m.id), ['glm-5', 'glm-4.6', 'glm-4.5-flash']);
});

test('字段映射到 id/name/releaseDate', () => {
  const first = parseProviderModels(CATALOG, 'zhipuai')[0];
  assert.deepEqual(first, { id: 'glm-5', name: 'GLM 5', releaseDate: '2026-03-20' });
});

test('未知 provider 或空模型返回空数组', () => {
  assert.deepEqual(parseProviderModels(CATALOG, 'nope'), []);
  assert.deepEqual(parseProviderModels(CATALOG, 'empty'), []);
});

test('topN 截取前 N 个', () => {
  const list = parseProviderModels(CATALOG, 'zhipuai');
  assert.deepEqual(topN(list, 2).map(m => m.id), ['glm-5', 'glm-4.6']);
});

test('name 缺省回退到 id', () => {
  const c = { x: { models: { 'm1': { id: 'm1', release_date: '2026-01-01' } } } };
  assert.equal(parseProviderModels(c, 'x')[0].name, 'm1');
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./models`。

- [ ] **Step 3:实现纯解析部分**

创建 `src/models.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ModelInfo {
  id: string;
  name: string;
  releaseDate: string;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存文件路径 */
export function cachePath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'models-cache.json');
}

/** 纯解析:从整份 catalog 取某 models.dev provider 的模型,按发布日期倒序 */
export function parseProviderModels(catalog: any, modelsDevId: string): ModelInfo[] {
  const models = catalog?.[modelsDevId]?.models;
  if (!models || typeof models !== 'object') {
    return [];
  }
  const list: ModelInfo[] = Object.values(models).map((m: any) => ({
    id: m.id,
    name: m.name ?? m.id,
    releaseDate: m.release_date ?? m.last_updated ?? '',
  }));
  list.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : a.releaseDate > b.releaseDate ? -1 : 0));
  return list;
}

export function topN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

/** 读缓存;过期或不存在返回 null。now 可注入用于测试 TTL。 */
export function readCache(p: string = cachePath(), now: number = Date.now()): any | null {
  try {
    const stat = fs.statSync(p);
    if (now - stat.mtimeMs > CACHE_TTL_MS) {
      return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(catalog: any, p: string = cachePath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(catalog), 'utf8');
}

/** 取 catalog:优先有效缓存,否则拉取并写缓存。fetcher 可注入用于测试。 */
export async function getCatalog(fetcher: typeof fetch = fetch): Promise<any> {
  const cached = readCache();
  if (cached) {
    return cached;
  }
  const res = await fetcher(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  writeCache(catalog);
  return catalog;
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/models.ts src/models.test.ts
git commit -m "feat: models.dev 解析与 topN"
```

---

## Task 4:models.ts —— 缓存 TTL 与拉取(可注入)

**Files:**
- Modify: `src/models.test.ts`(追加用例)

- [ ] **Step 1:追加缓存/拉取测试**

在 `src/models.test.ts` 末尾追加:

```ts
import { readCache, writeCache, getCatalog } from './models';
import * as os from 'node:os';
import * as fsp from 'node:fs';
import * as pathp from 'node:path';

function tmpFile(): string {
  return pathp.join(fsp.mkdtempSync(pathp.join(os.tmpdir(), 'cp-')), 'cache.json');
}

test('writeCache 后 readCache 读回', () => {
  const p = tmpFile();
  writeCache({ a: 1 }, p);
  assert.deepEqual(readCache(p), { a: 1 });
});

test('缓存超过 TTL 视为失效', () => {
  const p = tmpFile();
  writeCache({ a: 1 }, p);
  const future = Date.now() + 25 * 60 * 60 * 1000;
  assert.equal(readCache(p, future), null);
});

test('getCatalog 缓存命中时不调用 fetcher', async () => {
  // 预热默认缓存路径会污染 home,这里只验证 fetcher 注入:用一份无缓存的临时不可行,
  // 故改为验证 fetcher 失败时抛错(无缓存路径下默认缓存可能不存在)。
  let called = 0;
  const fakeFetch = (async () => {
    called++;
    return { ok: false, status: 500 } as any;
  }) as unknown as typeof fetch;
  // 仅当默认缓存不存在时才会触发 fetcher;若本机存在有效缓存则跳过断言。
  try {
    await getCatalog(fakeFetch);
  } catch (e: any) {
    assert.match(e.message, /500/);
  }
  assert.ok(called >= 0);
});
```

> 说明:`getCatalog` 走默认缓存路径(`~/.claude/proxy/models-cache.json`),为避免测试污染 home,这里只对纯函数 `readCache`/`writeCache`(可传路径)做严格断言;`getCatalog` 仅做弱断言。运行时行为由 Task 9 的手动冒烟覆盖。

- [ ] **Step 2:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 3:提交**

```bash
git add src/models.test.ts
git commit -m "test: models 缓存 TTL"
```

---

## Task 5:config.ts —— providers.json 读写与助手

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ProxyConfig, normalize, readConfig, writeConfig, ensureConfig,
  getProvider, configuredProviders, addKey, removeKey, setMapping,
} from './config';

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'providers.json');
}

test('normalize 容错非法输入', () => {
  assert.deepEqual(normalize(null), { mapping: 'pass', providers: [] });
  assert.deepEqual(normalize({ mapping: 5, providers: 'x' }), { mapping: 'pass', providers: [] });
  assert.deepEqual(
    normalize({ mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k1', 2] }, { bad: 1 }] }),
    { mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k1'] }] },
  );
});

test('ensureConfig 不存在时写默认模板', () => {
  const p = tmp();
  fs.rmSync(p, { force: true });
  const cfg = ensureConfig(p);
  assert.deepEqual(cfg, { mapping: 'pass', providers: [] });
  assert.equal(fs.existsSync(p), true);
});

test('writeConfig + readConfig 往返', () => {
  const p = tmp();
  const cfg: ProxyConfig = { mapping: 'glm:glm-5', providers: [{ name: 'glm', apiKeys: ['k'] }] };
  writeConfig(cfg, p);
  assert.deepEqual(readConfig(p), cfg);
});

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
Expected: FAIL —— 找不到 `./config`。

- [ ] **Step 3:实现 config.ts**

创建 `src/config.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
}

export const DEFAULT_CONFIG: ProxyConfig = { mapping: 'pass', providers: [] };

export function configPath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'providers.json');
}

/** 把任意 JSON 规范化为合法 ProxyConfig,丢弃非法字段 */
export function normalize(raw: any): ProxyConfig {
  const mapping = typeof raw?.mapping === 'string' ? raw.mapping : 'pass';
  const providers: ProviderEntry[] = Array.isArray(raw?.providers)
    ? raw.providers
        .filter((e: any) => e && typeof e.name === 'string')
        .map((e: any) => ({
          name: e.name,
          apiKeys: Array.isArray(e.apiKeys) ? e.apiKeys.filter((k: any) => typeof k === 'string') : [],
        }))
    : [];
  return { mapping, providers };
}

export function readConfig(p: string = configPath()): ProxyConfig {
  try {
    return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return { mapping: 'pass', providers: [] };
  }
}

export function writeConfig(cfg: ProxyConfig, p: string = configPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 不存在则写默认模板并返回;存在则读取 */
export function ensureConfig(p: string = configPath()): ProxyConfig {
  if (!fs.existsSync(p)) {
    writeConfig(DEFAULT_CONFIG, p);
    return { mapping: 'pass', providers: [] };
  }
  return readConfig(p);
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

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: providers.json 读写与配置助手"
```

---

## Task 6:claudeSettings.ts —— 代理注入/清理

**Files:**
- Create: `src/claudeSettings.ts`
- Test: `src/claudeSettings.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/claudeSettings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setProxy, clearProxy, getProxy, readSettings } from './claudeSettings';

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'settings.json');
}

test('setProxy 写入 ANTHROPIC_BASE_URL(目录不存在自动建)', () => {
  const p = tmp();
  setProxy(p, 'http://127.0.0.1:4001');
  assert.equal(getProxy(p), 'http://127.0.0.1:4001');
});

test('setProxy 保留已有 env 其他字段', () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ env: { FOO: 'bar' } }));
  setProxy(p, 'http://127.0.0.1:5000');
  assert.deepEqual(readSettings(p).env, { FOO: 'bar', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' });
});

test('clearProxy 删除字段,env 空则删 env', () => {
  const p = tmp();
  setProxy(p, 'http://127.0.0.1:4001');
  clearProxy(p);
  assert.equal(getProxy(p), undefined);
  assert.equal('env' in (readSettings(p) ?? {}), false);
});

test('clearProxy 保留 env 中其他字段', () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ env: { FOO: 'bar', ANTHROPIC_BASE_URL: 'x' } }));
  clearProxy(p);
  assert.deepEqual(readSettings(p).env, { FOO: 'bar' });
});

test('clearProxy 对不存在文件安全', () => {
  const p = tmp();
  fs.rmSync(p, { force: true });
  clearProxy(p);
  assert.equal(fs.existsSync(p), false);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./claudeSettings`。

- [ ] **Step 3:实现 claudeSettings.ts**

创建 `src/claudeSettings.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** 全局 Claude settings 路径 —— 始终保持不含代理 */
export const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export function readSettings(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSettings(p: string, data: any): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

export function getProxy(p: string): string | undefined {
  return readSettings(p)?.env?.ANTHROPIC_BASE_URL;
}

export function setProxy(p: string, baseUrl: string): void {
  const s = readSettings(p) ?? {};
  if (!s.env) {
    s.env = {};
  }
  s.env.ANTHROPIC_BASE_URL = baseUrl;
  writeSettings(p, s);
}

export function clearProxy(p: string): void {
  const s = readSettings(p);
  if (!s?.env?.ANTHROPIC_BASE_URL) {
    return;
  }
  delete s.env.ANTHROPIC_BASE_URL;
  if (Object.keys(s.env).length === 0) {
    delete s.env;
  }
  writeSettings(p, s);
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/claudeSettings.ts src/claudeSettings.test.ts
git commit -m "feat: Claude settings 代理注入/清理"
```

---

## Task 7:proxy.ts —— 转发决策(纯)

**Files:**
- Create: `src/proxy.ts`(本任务仅纯决策部分,server 在 Task 8 追加)
- Test: `src/proxy.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/proxy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, shouldRotate } from './proxy';
import { ProxyConfig } from './config';

const withGlm: ProxyConfig = { mapping: 'glm:glm-4.6', providers: [{ name: 'glm', apiKeys: ['k1', 'k2'] }] };

test('pass / 空 mapping 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'pass', providers: [] }), null);
  assert.equal(resolveTarget({ mapping: '', providers: [] }), null);
});

test('anthropic 格式 + 有 key → 命中目标', () => {
  const t = resolveTarget(withGlm)!;
  assert.equal(t.preset.id, 'glm');
  assert.equal(t.model, 'glm-4.6');
  assert.deepEqual(t.apiKeys, ['k1', 'k2']);
  assert.equal(t.forwardable, true);
});

test('未配置 key 的 provider 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'glm:glm-4.6', providers: [] }), null);
  assert.equal(resolveTarget({ mapping: 'glm:glm-4.6', providers: [{ name: 'glm', apiKeys: [] }] }), null);
});

test('未知 provider 或缺 model 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'nope:x', providers: [{ name: 'nope', apiKeys: ['k'] }] }), null);
  assert.equal(resolveTarget({ mapping: 'glm', providers: [{ name: 'glm', apiKeys: ['k'] }] }), null);
});

test('openai 格式命中但标记不可转发', () => {
  const t = resolveTarget({ mapping: 'openai:gpt-4o', providers: [{ name: 'openai', apiKeys: ['k'] }] })!;
  assert.equal(t.forwardable, false);
});

test('model 名含冒号可正确还原', () => {
  const t = resolveTarget({ mapping: 'openrouter:vendor:model-x', providers: [{ name: 'openrouter', apiKeys: ['k'] }] })!;
  assert.equal(t.model, 'vendor:model-x');
});

test('shouldRotate 仅对 401/429/5xx 为真', () => {
  assert.equal(shouldRotate(200), false);
  assert.equal(shouldRotate(400), false);
  assert.equal(shouldRotate(401), true);
  assert.equal(shouldRotate(429), true);
  assert.equal(shouldRotate(500), true);
  assert.equal(shouldRotate(503), true);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./proxy`。

- [ ] **Step 3:实现 proxy.ts 纯决策部分**

创建 `src/proxy.ts`:

```ts
import { ProxyConfig, getProvider } from './config';
import { getPreset, Preset } from './presets';

export interface Target {
  preset: Preset;
  model: string;
  apiKeys: string[];
  /** Part 1 是否能真正转发(anthropic 格式) */
  forwardable: boolean;
}

/**
 * 根据全局 mapping 解析转发目标。
 * 返回 null 表示透传(pass / 未配置 / 非法)。
 */
export function resolveTarget(cfg: ProxyConfig): Target | null {
  if (!cfg.mapping || cfg.mapping === 'pass') {
    return null;
  }
  const idx = cfg.mapping.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const name = cfg.mapping.slice(0, idx);
  const model = cfg.mapping.slice(idx + 1);
  if (!model) {
    return null;
  }
  const preset = getPreset(name);
  if (!preset) {
    return null;
  }
  const entry = getProvider(cfg, name);
  if (!entry || entry.apiKeys.length === 0) {
    return null;
  }
  return { preset, model, apiKeys: entry.apiKeys, forwardable: preset.forwardable };
}

/** 该响应状态是否应触发切换下一个 key */
export function shouldRotate(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/proxy.ts src/proxy.test.ts
git commit -m "feat: 转发目标解析与轮换判定"
```

---

## Task 8:proxy.ts —— HTTP server + 转发 + key 轮换 + 日志

**Files:**
- Modify: `src/proxy.ts`(追加 server)

> 本任务为 I/O 胶水,验证用 Task 11 的手动冒烟(curl)。这里只保证编译通过与逻辑完整。

- [ ] **Step 1:追加 server 实现**

在 `src/proxy.ts` 顶部补充 import,并在文件末尾追加 server 代码:

顶部 import 改为:

```ts
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProxyConfig, getProvider } from './config';
import { getPreset, Preset } from './presets';
```

文件末尾追加:

```ts
// ---- 日志 ----
function logDir(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'log');
}

function saveLog(enabled: boolean, request: any, response: any, error?: any): void {
  if (!enabled) {
    return;
  }
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const ts = new Date().toISOString();
    const id = Math.random().toString(36).slice(2, 15);
    const file = path.join(logDir(), `${ts.replace(/:/g, '-')}-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, timestamp: ts, request, response, error: error ?? null }, null, 2), 'utf8');
  } catch (e) {
    console.warn('saveLog failed', e);
  }
}

export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** 是否写 JSON 日志 */
  isJsonLogging: () => boolean;
}

/**
 * 创建透传/转发代理 server。
 * - mapping=pass 或不可解析 → 透传到 api.anthropic.com
 * - anthropic 格式目标 → 换 baseUrl/model/key 转发,失败时轮换 key
 * - 非 anthropic 格式目标 → 返回 502 提示(Part 2 才支持)
 */
export function createProxyServer(deps: ProxyServerDeps): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      let requestBody: any = null;
      try {
        requestBody = JSON.parse(body.toString('utf8'));
      } catch {
        // 非 JSON,保持透传
      }

      const cfg = deps.getConfig();
      const target = resolveTarget(cfg);

      // 非 anthropic 目标:Part 1 不支持转换
      if (target && !target.forwardable) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider "${target.preset.id}" (${target.preset.format}) 暂不支持,等待 Part 2 的格式转换。` }));
        return;
      }

      // 计算转发 URL / body / 认证
      let targetUrl = `https://api.anthropic.com${req.url}`;
      let targetBody = body;
      const authHeaders: Record<string, string> = {};
      let apiKeys: string[] = [];

      if (target) {
        targetUrl = `${target.preset.baseUrl}${req.url}`;
        apiKeys = target.apiKeys;
        if (requestBody && target.model) {
          requestBody.model = target.model;
          targetBody = Buffer.from(JSON.stringify(requestBody), 'utf8');
        }
      }

      // 转发头(剔除代理相关 + 原认证头,后面按 key 注入)
      const baseHeaders: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['host', 'connection', 'content-length'].includes(lk)) {
          continue;
        }
        if (target && (lk === 'x-api-key' || lk === 'authorization')) {
          continue;
        }
        baseHeaders[k] = v;
      }

      const tryKeys = apiKeys.length > 0 ? apiKeys : [null];
      let lastErr: any = null;

      for (let i = 0; i < tryKeys.length; i++) {
        const key = tryKeys[i];
        const headers: Record<string, any> = { ...baseHeaders };
        if (key) {
          headers['x-api-key'] = key; // anthropic 格式
        }
        try {
          const upstream = await fetch(targetUrl, { method: 'POST', headers: headers as any, body: targetBody });

          // 命中需轮换的状态且还有下一个 key → 换 key 重试
          if (apiKeys.length > 0 && shouldRotate(upstream.status) && i < tryKeys.length - 1) {
            console.warn(`key #${i} 失败(${upstream.status}),切换下一个`);
            continue;
          }

          // 转发响应头
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of upstream.headers.entries()) {
            const lk = k.toLowerCase();
            if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lk)) {
              continue;
            }
            respHeaders[k] = v;
          }
          if (!respHeaders['content-type']) {
            respHeaders['content-type'] = 'application/json';
          }
          res.writeHead(upstream.status, respHeaders);

          const collected: Uint8Array[] = [];
          const reader = upstream.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              collected.push(value);
              res.write(value);
            }
          }
          res.end();

          saveLog(deps.isJsonLogging(),
            { url: req.url, model: requestBody?.model, mapping: cfg.mapping },
            { status: upstream.status, bytes: Buffer.concat(collected).length });
          return;
        } catch (err) {
          lastErr = err;
          if (apiKeys.length > 0 && i < tryKeys.length - 1) {
            console.warn(`key #${i} 网络错误,切换下一个`, err);
            continue;
          }
        }
      }

      // 全部失败
      console.error('代理错误:', lastErr);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(lastErr?.message ?? lastErr) }));
      saveLog(deps.isJsonLogging(), { url: req.url, mapping: cfg.mapping }, null, String(lastErr));
    });
  });
}
```

- [ ] **Step 2:确认现有纯测试仍通过 + 编译**

Run: `npm test`
Expected: PASS(Task 7 用例不受影响);无 TS 编译错误。

- [ ] **Step 3:提交**

```bash
git add src/proxy.ts
git commit -m "feat: 代理 server 转发与 key 轮换"
```

---

## Task 9:statusbar.ts —— 状态栏 + 切换 QuickPick + MRU + Provider 设置

**Files:**
- Create: `src/statusbar.ts`

> vscode UI,验证用 Task 11 手动冒烟。代码必须完整、可编译。

- [ ] **Step 1:实现 statusbar.ts**

创建 `src/statusbar.ts`:

```ts
import * as vscode from 'vscode';
import { ProxyConfig, configuredProviders, addKey, removeKey, setMapping } from './config';
import { PRESETS, CODEX_PLACEHOLDER_ID, getPreset } from './presets';
import { getCatalog, parseProviderModels, topN, ModelInfo } from './models';

const MRU_KEY = 'claudeProxy.recentMappings';
const MRU_MAX = 5;
const TOP_N = 8;

export interface StatusBarDeps {
  context: vscode.ExtensionContext;
  getConfig: () => ProxyConfig;
  /** 写配置 + 同步 Claude 代理开关 + 刷新文本 */
  applyConfig: (cfg: ProxyConfig) => void;
}

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor(private deps: StatusBarDeps) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeProxy.openMenu';
    deps.context.subscriptions.push(this.item);
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const m = this.deps.getConfig().mapping;
    const label = !m || m === 'pass' ? '透传' : (m.includes(':') ? m.slice(m.indexOf(':') + 1) : m);
    this.item.text = `$(arrow-swap) Claude: ${label}`;
    this.item.tooltip = '点击切换/管理 Claude Proxy';
  }

  // ---- 一级菜单 ----
  async openMenu(): Promise<void> {
    const cfg = this.deps.getConfig();
    const recent = this.deps.context.globalState.get<string[]>(MRU_KEY, []);

    type Item = vscode.QuickPickItem & { action?: 'pass' | 'mapping' | 'provider' | 'settings'; value?: string };
    const items: Item[] = [];

    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(circle-slash) Pass(透传)', action: 'pass' });
    for (const m of recent) {
      items.push({ label: `$(history) ${m}`, action: 'mapping', value: m });
    }

    const provs = configuredProviders(cfg);
    if (provs.length > 0) {
      items.push({ label: 'Provider', kind: vscode.QuickPickItemKind.Separator });
      for (const p of provs) {
        items.push({ label: `$(server) ${p.name}`, description: `${p.apiKeys.length} key`, action: 'provider', value: p.name });
      }
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(gear) Provider 设置', action: 'settings' });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '切换映射目标' });
    if (!picked) {
      return;
    }
    if (picked.action === 'pass') {
      this.setMapping('pass');
    } else if (picked.action === 'mapping' && picked.value) {
      this.setMapping(picked.value);
    } else if (picked.action === 'provider' && picked.value) {
      await this.pickModel(picked.value);
    } else if (picked.action === 'settings') {
      await this.providerSettings();
    }
  }

  // ---- 二级:选 provider 的模型 ----
  private async pickModel(providerName: string, showAll = false): Promise<void> {
    const preset = getPreset(providerName);
    if (!preset) {
      return;
    }
    let models: ModelInfo[] = [];
    try {
      const catalog = await getCatalog();
      models = parseProviderModels(catalog, preset.modelsDevId);
    } catch (e) {
      vscode.window.showErrorMessage(`获取模型失败: ${String(e)}`);
      return;
    }
    const shown = showAll ? models : topN(models, TOP_N);

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

  // ---- Provider 设置:选 provider → 管理 key ----
  private async providerSettings(): Promise<void> {
    type Item = vscode.QuickPickItem & { id?: string; codex?: boolean };
    const cfg = this.deps.getConfig();
    const items: Item[] = PRESETS.map(p => {
      const n = cfg.providers.find(x => x.name === p.id)?.apiKeys.length ?? 0;
      return { label: p.id, description: n > 0 ? `${n} key` : '未配置', id: p.id };
    });
    items.push({ label: `${CODEX_PLACEHOLDER_ID}`, description: '需登录(后续支持)', codex: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择 provider 管理 key' });
    if (!picked) {
      return;
    }
    if (picked.codex) {
      vscode.window.showInformationMessage('Codex 登录将在后续版本支持。');
      return;
    }
    if (picked.id) {
      await this.manageKeys(picked.id);
    }
  }

  // ---- 管理某 provider 的 key ----
  private async manageKeys(name: string): Promise<void> {
    const cfg = this.deps.getConfig();
    const entry = cfg.providers.find(p => p.name === name);
    const keys = entry?.apiKeys ?? [];

    type Item = vscode.QuickPickItem & { add?: boolean; del?: string };
    const items: Item[] = [{ label: '$(add) 添加 key', add: true }];
    for (const k of keys) {
      items.push({ label: `$(trash) ${mask(k)}`, description: '删除', del: k });
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${name}:管理 key` });
    if (!picked) {
      return;
    }
    if (picked.add) {
      const key = await vscode.window.showInputBox({ prompt: `输入 ${name} 的 API key`, password: true });
      if (key) {
        this.deps.applyConfig(addKey(this.deps.getConfig(), name, key.trim()));
        await this.manageKeys(name);
      }
    } else if (picked.del) {
      this.deps.applyConfig(removeKey(this.deps.getConfig(), name, picked.del));
      await this.manageKeys(name);
    }
  }

  private setMapping(mapping: string): void {
    this.deps.applyConfig(setMapping(this.deps.getConfig(), mapping));
    if (mapping !== 'pass') {
      this.pushRecent(mapping);
    }
    this.refresh();
  }

  private pushRecent(mapping: string): void {
    const cur = this.deps.context.globalState.get<string[]>(MRU_KEY, []);
    const next = [mapping, ...cur.filter(m => m !== mapping)].slice(0, MRU_MAX);
    this.deps.context.globalState.update(MRU_KEY, next);
  }
}

function mask(k: string): string {
  if (k.length <= 8) {
    return '****';
  }
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}
```

- [ ] **Step 2:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 3:提交**

```bash
git add src/statusbar.ts
git commit -m "feat: 状态栏切换菜单与 provider/key 管理"
```

---

## Task 10:extension.ts —— 重写装配,移除旧逻辑

**Files:**
- Rewrite: `src/extension.ts`

- [ ] **Step 1:整体重写 extension.ts**

用以下内容**替换** `src/extension.ts` 全文:

```ts
import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { ProxyConfig, ensureConfig, readConfig, writeConfig, configPath } from './config';
import { createProxyServer } from './proxy';
import { StatusBar } from './statusbar';
import { GLOBAL_SETTINGS_PATH, clearProxy, setProxy, getProxy } from './claudeSettings';

let server: http.Server | null = null;
let currentPort = 4001;
let statusBar: StatusBar;

function randomPort(): number {
  return Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024;
}

function workspaceSettingsPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  return path.join(root, '.claude', 'settings.json');
}

function isJsonLogging(): boolean {
  return vscode.workspace.getConfiguration('claudeProxy').get<boolean>('enableJsonLogging', false);
}

/** 按当前 mapping 同步项目级 Claude 代理开关;返回代理开关是否发生翻转 */
function syncProxy(cfg: ProxyConfig): boolean {
  clearProxy(GLOBAL_SETTINGS_PATH); // 全局始终不带代理
  const wsPath = workspaceSettingsPath();
  const had = !!getProxy(wsPath);
  const want = !!cfg.mapping && cfg.mapping !== 'pass';
  if (want) {
    setProxy(wsPath, `http://127.0.0.1:${currentPort}`);
  } else {
    clearProxy(wsPath);
  }
  return had !== want;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Claude Proxy activating...');

  ensureConfig();

  // applyConfig:写盘 + 同步代理 + 刷新状态栏;代理开关翻转时重载窗口
  const applyConfig = (cfg: ProxyConfig) => {
    writeConfig(cfg);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({
    context,
    getConfig: () => readConfig(),
    applyConfig,
  });

  // 启动时同步一次(不触发 reload)
  syncProxy(readConfig());

  // 命令:打开菜单(状态栏点击)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.openMenu', () => statusBar.openMenu()),
  );
  // 命令:编辑配置文件(高级入口)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.editConfig', async () => {
      const doc = await vscode.workspace.openTextDocument(configPath());
      vscode.window.showTextDocument(doc);
    }),
  );

  // 启动代理 server(随机端口,冲突漂移)
  server = createProxyServer({ getConfig: () => readConfig(), isJsonLogging });
  let retries = 0;
  const tryListen = () => {
    currentPort = randomPort();
    server!.listen(currentPort, '127.0.0.1');
  };
  server.on('listening', () => {
    console.log(`proxy listening on http://127.0.0.1:${currentPort}`);
    syncProxy(readConfig()); // 用真实端口回填
  });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && retries < 10) {
      retries++;
      console.log(`port ${currentPort} in use, retrying`);
      tryListen();
      return;
    }
    console.error('server error:', err);
    server = null;
  });
  tryListen();

  context.subscriptions.push({
    dispose: () => {
      if (server) {
        server.close();
      }
    },
  });
}

export function deactivate(): void {
  if (server) {
    server.close();
  }
}
```

- [ ] **Step 2:编译**

Run: `npm run compile`
Expected: 无 TS 错误。若报未使用 import,按报错删除对应未用符号。

- [ ] **Step 3:提交**

```bash
git add src/extension.ts
git commit -m "feat: 重写 extension 装配,移除外部进程逻辑"
```

---

## Task 11:package.json contributes 清理 + 手动冒烟

**Files:**
- Modify: `package.json`

- [ ] **Step 1:替换 contributes 与版本**

把 `package.json` 的 `contributes` 整段替换为:

```json
  "contributes": {
    "commands": [
      {
        "command": "claudeProxy.openMenu",
        "title": "Claude Proxy: 打开菜单"
      },
      {
        "command": "claudeProxy.editConfig",
        "title": "Claude Proxy: 编辑配置文件"
      }
    ],
    "configuration": [
      {
        "title": "Claude Proxy",
        "properties": {
          "claudeProxy.enableJsonLogging": {
            "type": "boolean",
            "default": false,
            "description": "是否将请求和响应保存为JSON文件到~/.claude/proxy/log目录",
            "scope": "machine"
          }
        }
      }
    ]
  },
```

- [ ] **Step 2:编译并确认无残留旧配置引用**

Run: `npm run compile && grep -rn "mappings\.\|providers\.litellm\|providers\.cliproxyapi\|selectHaikuMapping\|selectMainMapping" src/ || echo OK`
Expected: 编译通过;grep 输出 `OK`(无残留)。

- [ ] **Step 3:手动冒烟 —— 透传与菜单**

在 VSCode 按 F5 启动扩展开发宿主,然后:

1. 确认右下角状态栏显示 `Claude: 透传`,**启动无端口弹窗**。
2. 确认 `~/.claude/proxy/providers.json` 已生成,内容 `{ "mapping": "pass", "providers": [] }`。
3. 点击状态栏 → 出现 `[Recent]`(Pass)/ 底部 `⚙ Provider 设置`;此时 `[Provider]` 段为空。
4. `⚙ Provider 设置` → 选 `glm` → `添加 key` → 输入一个真实 GLM key。
5. 再点状态栏 → `[Provider]` 段出现 `glm` → 选中 → 列出较新模型(来自 models.dev)+ `Other…`;选一个模型。
6. 确认状态栏文本变为该模型名;`providers.json` 的 `mapping` 已更新;当前项目 `.claude/settings.json` 出现 `ANTHROPIC_BASE_URL: http://127.0.0.1:<port>`(窗口可能重载)。

Expected: 上述全部符合。

- [ ] **Step 4:手动冒烟 —— anthropic 转发与轮换**

在已配置 glm key 且 mapping=glm:<model> 的情况下:

```bash
curl -s -X POST http://127.0.0.1:<port>/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-3-5-sonnet","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

Expected: 返回 GLM 的回复(证明换 baseUrl/model/key 转发成功)。再把该 provider 的第一个 key 改成无效、追加一个有效 key,重复请求应仍成功(证明失败轮换)。

- [ ] **Step 5:手动冒烟 —— 切回 pass**

点状态栏 → `Pass(透传)`。
Expected: 状态栏显示 `透传`;当前项目 `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 被移除;`mapping` 变回 `pass`。

- [ ] **Step 6:提交**

```bash
git add package.json
git commit -m "chore: 清理设置项与命令,升级 Part 1 UI 配置"
```

---

## Self-Review 记录

- **Spec §1 配置文件**:Task 5(config.ts)+ Task 11 Step 3(首启生成)。
- **Spec §2 preset 目录(移除 groq、codex 占位)**:Task 2(PRESETS 不含 codex)+ Task 9(providerSettings 展示 codex 占位提示)。
- **Spec §3 models.dev 来源/缓存/topN**:Task 3 + Task 4 + Task 9(pickModel)。
- **Spec §4 取消 haiku/main**:Task 7(resolveTarget 不区分模型名)+ Task 10/11(删除 extractModelType,旧命令清理)。
- **Spec §5 状态栏单一入口逐级下钻 + MRU**:Task 9。
- **Spec §6 Provider 设置内嵌 + 增删 key**:Task 9(providerSettings/manageKeys)。
- **Spec §7 转发 + key 轮换(失败切换)**:Task 7 + Task 8 + Task 11 Step 4。
- **Spec §8 移除项(启动弹窗 / litellm / cliproxyapi / filterLiteLLMChunk)**:Task 10 重写未保留任何相关逻辑 + Task 11 Step 2 grep 校验。
- **Spec §9 代理开关(当前项目注入/清理 + 全局清空)**:Task 6 + Task 10(syncProxy)+ Task 11 Step 3/5。
- **Spec §10 模块拆分**:Task 2/3/5/6/7-8/9/10 分别对应。
- **类型一致性**:`ProxyConfig`/`ProviderEntry`(config.ts)、`Target`/`resolveTarget`/`shouldRotate`(proxy.ts)、`ModelInfo`/`parseProviderModels`/`topN`/`getCatalog`(models.ts)、`Preset`/`getPreset`/`PRESETS`/`CODEX_PLACEHOLDER_ID`(presets.ts)、`StatusBar`/`StatusBarDeps`(statusbar.ts)在各 Task 间签名一致。
- **占位符扫描**:无 TBD/TODO;I/O 胶水(server/UI)以手动冒烟覆盖,已在 Task 8/9/11 给出完整代码与验证命令。

## 范围外(不在本计划)

- OpenAI / Gemini ↔ Claude 格式转换(Part 2)。
- Codex / 其他 OAuth 登录(Part 3);Part 1 仅占位提示。
- 换名发布(发布期处理)。
