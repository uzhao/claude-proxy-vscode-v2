# Part 1 增量:per-project mapping + model 白名单 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前选中的 model(mapping)从全局存储改为按项目(VSCode workspaceState)存储,各家 key 仍全局共享;并把模型列表的默认展示从"取最新 N 个"改为全局 glob 白名单过滤。

**Architecture:** `providers.json` 只保留 `{ providers }`;`mapping` 移到 `context.workspaceState`。装配层(extension.ts)用 `getConfig()` 把两源组合成运行时 `ProxyConfig` 视图,`applyConfig()` 拆开落地——`resolveTarget` 等纯逻辑无需改动。models.ts 新增 glob 白名单匹配,取代 `topN`。

**Tech Stack:** TypeScript(commonjs / ES2020 / strict)、VSCode Extension API、Node 内置 `node:test` + `node:assert`。

---

## 文件结构

- `src/config.ts` —— 改:`providers.json` 读写只处理 `{ providers }`(移除 mapping 的文件读写);保留 `ProxyConfig` 类型与纯助手。
- `src/config.test.ts` —— 改:测 providers 专用读写。
- `src/models.ts` —— 改:新增 glob 白名单 `isFeatured`/`filterFeatured`,移除 `topN`。
- `src/models.test.ts` —— 改:移除 topN 用例,新增白名单用例。
- `src/statusbar.ts` —— 改:`pickModel` 用 `filterFeatured` 取代 `topN`。
- `src/extension.ts` —— 改:`getConfig` 组合 mapping(workspaceState)+ providers(文件);`applyConfig` 拆分落地。

---

## Task 1:config.ts —— providers.json 只读写 providers

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1:替换测试为 providers 专用版**

把 `src/config.test.ts` 的 import 段(第 6-9 行)替换为:

```ts
import {
  ProxyConfig, ProviderEntry, normalizeProviders, readProviders, writeProviders, ensureProviders,
  getProvider, configuredProviders, addKey, removeKey, setMapping,
} from './config';
```

把前三个用例(`normalize 容错非法输入` / `ensureConfig 不存在时写默认模板` / `writeConfig + readConfig 往返`,即第 15-37 行三个 test)整体替换为:

```ts
test('normalizeProviders 容错非法输入', () => {
  assert.deepEqual(normalizeProviders(null), []);
  assert.deepEqual(normalizeProviders({ providers: 'x' }), []);
  assert.deepEqual(
    normalizeProviders({ providers: [{ name: 'glm', apiKeys: ['k1', 2] }, { bad: 1 }] }),
    [{ name: 'glm', apiKeys: ['k1'] }],
  );
});

test('ensureProviders 不存在时写空模板', () => {
  const p = tmp();
  fs.rmSync(p, { force: true });
  assert.deepEqual(ensureProviders(p), []);
  assert.equal(fs.existsSync(p), true);
});

test('writeProviders + readProviders 往返(文件仅含 providers)', () => {
  const p = tmp();
  const providers: ProviderEntry[] = [{ name: 'glm', apiKeys: ['k'] }];
  writeProviders(providers, p);
  assert.deepEqual(readProviders(p), providers);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { providers });
});
```

其余四个用例(`addKey` / `removeKey` / `configuredProviders` / `setMapping`)保持不变——它们操作 `ProxyConfig` 纯助手,不受本次改动影响。

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— `config.ts` 未导出 `normalizeProviders`/`readProviders`/`writeProviders`/`ensureProviders`(编译报错)。

- [ ] **Step 3:改 config.ts**

在 `src/config.ts` 中,删除以下四段(第 17、23-35、37-57 行附近):`DEFAULT_CONFIG` 常量、`normalize` 函数、`readConfig` 函数、`writeConfig` 函数、`ensureConfig` 函数。

`ProviderEntry`、`ProxyConfig`、`configPath` 保持不变。在 `configPath` 之后插入:

```ts
/** 把任意 JSON 的 providers 字段规范化为合法数组,丢弃非法项 */
export function normalizeProviders(raw: any): ProviderEntry[] {
  return Array.isArray(raw?.providers)
    ? raw.providers
        .filter((e: any) => e && typeof e.name === 'string')
        .map((e: any) => ({
          name: e.name,
          apiKeys: Array.isArray(e.apiKeys) ? e.apiKeys.filter((k: any) => typeof k === 'string') : [],
        }))
    : [];
}

/** 读 providers.json 的 providers;文件不存在/非法返回 [] */
export function readProviders(p: string = configPath()): ProviderEntry[] {
  try {
    return normalizeProviders(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return [];
  }
}

/** 写 providers 到 providers.json(仅 { providers }) */
export function writeProviders(providers: ProviderEntry[], p: string = configPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ providers }, null, 2), 'utf8');
}

/** 不存在则写空模板并返回 [];存在则读取 */
export function ensureProviders(p: string = configPath()): ProviderEntry[] {
  if (!fs.existsSync(p)) {
    writeProviders([], p);
    return [];
  }
  return readProviders(p);
}
```

`getProvider`、`configuredProviders`、`addKey`、`removeKey`、`setMapping` 全部保持不变。

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS(config 全部用例)。

- [ ] **Step 5:提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: providers.json 仅读写 providers,mapping 移出文件"
```

---

## Task 2:models.ts —— glob 白名单取代 topN

**Files:**
- Modify: `src/models.ts`
- Modify: `src/models.test.ts`

- [ ] **Step 1:改测试 —— 删 topN 用例、加白名单用例**

在 `src/models.test.ts` 第 3 行的 import 改为:

```ts
import { parseProviderModels, isFeatured, filterFeatured } from './models';
```

删除 `topN 截取前 N 个` 用例(第 31-34 行)。在 `name 缺省回退到 id` 用例(第 36-39 行)之后插入:

```ts
test('isFeatured:* 匹配任意串', () => {
  assert.equal(isFeatured('gpt-5'), true);
  assert.equal(isFeatured('gpt-5-mini'), true);
  assert.equal(isFeatured('glm-5'), true);
  assert.equal(isFeatured('glm-5-air'), true);
});

test('isFeatured:. 匹配任意单字符(覆盖连字符 id)', () => {
  assert.equal(isFeatured('kimi-k2-0905'), true);
  assert.equal(isFeatured('minimax-m2-pro'), true);
});

test('isFeatured:大小写不敏感', () => {
  assert.equal(isFeatured('GLM-5'), true);
  assert.equal(isFeatured('Claude-Opus-4-1'), true);
});

test('isFeatured:未命中返回 false', () => {
  assert.equal(isFeatured('glm-4.6'), false);
  assert.equal(isFeatured('gpt-4o'), false);
  assert.equal(isFeatured('deepseek-v3'), false);
});

test('filterFeatured 跨 provider 只留命中项', () => {
  const models = [
    { id: 'glm-5', name: 'GLM 5', releaseDate: '' },
    { id: 'glm-4.6', name: 'GLM 4.6', releaseDate: '' },
    { id: 'gpt-5', name: 'GPT 5', releaseDate: '' },
    { id: 'gpt-4o', name: 'GPT 4o', releaseDate: '' },
  ];
  assert.deepEqual(filterFeatured(models).map(m => m.id), ['glm-5', 'gpt-5']);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— `models.ts` 未导出 `isFeatured`/`filterFeatured`(编译报错)。

- [ ] **Step 3:改 models.ts**

删除 `src/models.ts` 中的 `topN` 函数(第 34-36 行):

```ts
export function topN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}
```

在 `parseProviderModels` 函数(到第 32 行结束)之后插入:

```ts
/** 默认展示的 model 白名单(glob:* 匹配任意串,. 匹配任意单字符,大小写不敏感) */
const FEATURED_PATTERNS = [
  'claude*4*', 'gpt*5*', 'gemini*3*', 'kimi-k2.*',
  'glm-5*', 'deepseek-v4*', 'minimax-m3*', 'minimax-m2.*',
];

function globToRegExp(pattern: string): RegExp {
  // 按 * 分段,段内转义正则特殊字符(故意不转义 . ,使其匹配任意单字符),段间用 .* 连接
  const body = pattern
    .split('*')
    .map(seg => seg.replace(/[+^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const FEATURED_REGEXPS = FEATURED_PATTERNS.map(globToRegExp);

/** model id 是否命中默认展示白名单 */
export function isFeatured(id: string): boolean {
  return FEATURED_REGEXPS.some(re => re.test(id));
}

/** 仅保留命中白名单的 model */
export function filterFeatured(models: ModelInfo[]): ModelInfo[] {
  return models.filter(m => isFeatured(m.id));
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS(models 全部用例)。

- [ ] **Step 5:提交**

```bash
git add src/models.ts src/models.test.ts
git commit -m "feat: model 默认展示改为 glob 白名单"
```

---

## Task 3:statusbar.ts —— pickModel 用 filterFeatured

**Files:**
- Modify: `src/statusbar.ts`

> 纯 UI 胶水,无单测,以编译 + Task 5 手动冒烟验证。

- [ ] **Step 1:改 import**

把 `src/statusbar.ts` 第 4 行:

```ts
import { getCatalog, parseProviderModels, topN, ModelInfo } from './models';
```

改为:

```ts
import { getCatalog, parseProviderModels, filterFeatured, ModelInfo } from './models';
```

- [ ] **Step 2:删除 TOP_N 常量**

删除第 8 行:

```ts
const TOP_N = 8;
```

- [ ] **Step 3:pickModel 改用白名单**

把 `pickModel` 中的第 89 行:

```ts
    const shown = showAll ? models : topN(models, TOP_N);
```

改为:

```ts
    const shown = showAll ? models : filterFeatured(models);
```

`pickModel` 其余逻辑(`Other…` 仅在 `models.length > shown.length` 时显示)保持不变。

- [ ] **Step 4:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 5:提交**

```bash
git add src/statusbar.ts
git commit -m "feat: 状态栏模型列表用白名单过滤"
```

---

## Task 4:extension.ts —— per-project mapping 组合装配

**Files:**
- Modify: `src/extension.ts`

> 纯 VSCode 胶水,无单测,以编译 + Task 5 手动冒烟验证。

- [ ] **Step 1:改 import 并加常量**

把 `src/extension.ts` 第 4 行:

```ts
import { ProxyConfig, ensureConfig, readConfig, writeConfig, configPath } from './config';
```

改为:

```ts
import { ProxyConfig, ensureProviders, readProviders, writeProviders, configPath } from './config';
```

在第 11 行 `let statusBar: StatusBar;` 之后新增一行:

```ts
const MAPPING_KEY = 'claudeProxy.mapping';
```

- [ ] **Step 2:重写 activate 中的装配段**

把 `activate` 内从 `ensureConfig();`(第 44 行)到 `statusBar = new StatusBar({...});`(第 56-60 行)结束的这一段,替换为:

```ts
  ensureProviders();

  // 组合运行时视图:mapping(本项目 workspaceState)+ providers(全局 providers.json)
  const getConfig = (): ProxyConfig => ({
    mapping: context.workspaceState.get<string>(MAPPING_KEY, 'pass'),
    providers: readProviders(),
  });

  // applyConfig:拆分落地(providers→全局文件,mapping→本项目)+ 同步代理 + 刷新;开关翻转才 reload
  const applyConfig = (cfg: ProxyConfig) => {
    writeProviders(cfg.providers);
    context.workspaceState.update(MAPPING_KEY, cfg.mapping);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({ context, getConfig, applyConfig });
```

- [ ] **Step 3:把 server 装配里的 readConfig 换成 getConfig**

把第 77 行:

```ts
  server = createProxyServer({ getConfig: () => readConfig(), isJsonLogging });
```

改为:

```ts
  server = createProxyServer({ getConfig, isJsonLogging });
```

把 `server.on('listening', ...)` 内第 85 行:

```ts
    syncProxy(readConfig()); // 用真实端口回填
```

改为:

```ts
    syncProxy(getConfig()); // 用真实端口回填
```

- [ ] **Step 4:编译 + 确认无旧符号残留**

Run: `npm run compile && grep -rn "readConfig\|writeConfig\|ensureConfig\|DEFAULT_CONFIG\|\.mapping\b" src/extension.ts || echo OK`
Expected: 编译通过;grep 不再出现 `readConfig`/`writeConfig`/`ensureConfig`/`DEFAULT_CONFIG`(`syncProxy` 内对 `cfg.mapping` 的读取属正常,可忽略)。

- [ ] **Step 5:提交**

```bash
git add src/extension.ts
git commit -m "feat: mapping 改为 per-project(workspaceState)存储"
```

---

## Task 5:手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1:全量测试 + 编译**

Run: `npm test && npm run compile`
Expected: 全部 PASS,无 TS 错误。

- [ ] **Step 2:per-project 隔离冒烟**

按 F5 启动扩展开发宿主,打开**两个不同项目**窗口(窗口 A、窗口 B):

1. 窗口 A:点状态栏 → ⚙ Provider 设置 → 给 glm 加 key → 回到状态栏选 glm 的某模型(如 glm-5)。确认 A 状态栏显示该模型;A 项目 `.claude/settings.json` 出现 `ANTHROPIC_BASE_URL`。
2. 窗口 B:点状态栏,确认它仍是 `透传`(mapping 未被 A 影响);给 kimi 选一个模型(key 已全局共享,glm 的 key 在 B 里也在,但 B 自己选 kimi)。
3. 回窗口 A,确认它仍是 glm 的模型(未被 B 改动)。
4. 确认 `~/.claude/proxy/providers.json` 内容为 `{ "providers": [ ... ] }`,**不含 mapping 字段**。

Expected: 两窗口 mapping 互不干扰;providers.json 只含 providers。

- [ ] **Step 3:白名单展示冒烟**

在某个已配置 key 的 provider(如 glm)上打开模型列表:

Expected: 默认只显示命中白名单的模型(如 `glm-5*`),旧版本/非命中模型(如 `glm-4.6`)不直接出现,而是收在 `$(ellipsis) Other…` 里;点开 Other… 能看到全部。

- [ ] **Step 4:切回 pass 冒烟**

窗口 A 点状态栏 → Pass(透传)。
Expected: A 状态栏显示 `透传`;A 项目 `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 被移除;workspaceState 的 mapping 回到 pass(重开窗口仍是透传)。

---

## Self-Review 记录

- **Spec 改动 A(mapping per-project)**:Task 1(config 拆分)+ Task 4(getConfig 组合 / applyConfig 拆分落地 / workspaceState)+ Task 5 Step 2/4 冒烟。
- **Spec 改动 B(白名单取代 topN)**:Task 2(isFeatured/filterFeatured,删 topN)+ Task 3(pickModel 接入)+ Task 5 Step 3 冒烟。
- **类型一致性**:`ProxyConfig`/`ProviderEntry`(config.ts,保留)、`normalizeProviders`/`readProviders`/`writeProviders`/`ensureProviders`(config.ts,Task 1 定义,Task 4 使用)、`isFeatured`/`filterFeatured`(models.ts,Task 2 定义,Task 3 使用)签名跨 Task 一致。
- **orphan 清理**:`topN`(及其测试)随 Task 2/3 改用白名单一并移除;`readConfig`/`writeConfig`/`ensureConfig`/`normalize`/`DEFAULT_CONFIG` 随 Task 1 移除,Task 4 切走最后调用点。
- **占位符扫描**:无 TBD/TODO;UI/装配胶水以 Task 5 手动冒烟覆盖,代码已完整给出。

## 范围外

- 白名单可配置化(出现 glm-6/kimi-k3 需改代码)。
- 格式转换(Part 2)、OAuth 登录(Part 3)。
