# Part 1 增量:per-project mapping + model 白名单

> 对已交付的 Part 1(UI/配置重构)的两处增量改动。基线为分支 `part1-ui-config-refactor`,所有 32 个纯逻辑测试通过的状态。

## 背景

当前 Part 1 状态:

- `mapping`(当前选中的 `provider:model`)与 `providers`(各家 key)**一起**存在全局 `~/.claude/proxy/providers.json`,所以**所有项目窗口共享同一个 mapping**。
- 状态栏点击 → provider 下钻 → `pickModel` 用 `topN(models, 8)`(按发布日期取最新 8 个)作为默认展示,其余进 `Other…`。

两个诉求:

1. **mapping 改为按项目保存**,而不是全局——不同项目可各自选不同 model;各家 key 仍全局共享。
2. **默认展示的 model 改用白名单过滤**,而不是"取最新 N 个"。

---

## 改动 A:mapping 改为 per-project

### 关键前提

VSCode 中**每个打开的项目窗口都是独立的扩展实例**:各自 `activate`、各自启动一个 proxy server(独立随机端口)、各自往本项目 `.claude/settings.json` 注入自己的端口。因此进程级隔离已天然成立,只需把 `mapping` 的存储从"全局单一"改成"按窗口"。

### 持久化拆分

- **`providers.json`(全局)只保留 `{ providers: [...] }`**,不再含 `mapping` 字段。各家 key 继续全局共享(无需每个项目重配)。
- **`mapping` 改存 `context.workspaceState`**(key:`claudeProxy.mapping`,默认 `pass`),每个项目窗口各存各的。

### 装配层(extension.ts)

- `getConfig()` 组合两源,返回运行时视图:
  `{ mapping: workspaceState.get('claudeProxy.mapping', 'pass'), providers: <providers.json 读> }`。
  该视图同时喂给 proxy server 与状态栏,`resolveTarget` **无需改动**。
- `applyConfig(cfg)` 内部**拆开写入**:
  - `cfg.providers` → 写 `providers.json`;
  - `cfg.mapping` → `workspaceState.update('claudeProxy.mapping', …)`;
  - 然后 `syncProxy(cfg)`、刷新状态栏;代理开关翻转时 reload 窗口(逻辑不变)。

### config.ts

- `providers.json` 的读写/规范化调整为**只处理 providers**(`mapping` 不再从文件读写)。
- `ProxyConfig { mapping, providers }` 类型**保留**,作为运行时组合视图;`setMapping` 等纯助手保留(状态栏仍用它们生成新 `cfg`,再交给 `applyConfig` 拆分落地)。

### 不变项

- `statusbar.ts` 仍通过 `getConfig()/applyConfig()` 工作,不直接接触 `workspaceState`,改动极小。
- recent(MRU)保持在全局 `globalState`——跨项目快捷复用,合理。

---

## 改动 B:默认 model 用白名单(取代 topN)

### 白名单

一份**全局写死**的 glob 白名单,**对任意 provider 的模型列表统一过滤**(如 nvidia 这类聚合平台,`gpt*5*`、`claude*4*` 等会各自命中):

```
claude*4*
gpt*5*
gemini*3*
kimi-k2.*
glm-5*
deepseek-v4*
minimax-m3*
minimax-m2.*
```

匹配规则:`*` 匹配任意长度任意字符、`.` 匹配任意单个字符(因此 `kimi-k2.*` 能命中 `kimi-k2-0905` 这类连字符 id)、大小写不敏感。命中的**全部显示、不做数量截断**;未命中的收进 `$(ellipsis) Other…`(展开后显示全部)。

这是**纯展示过滤**,不改可转发性——选中 gpt/gemini/claude 这类非 anthropic 目标,仍走 Part 1 的 502 占位提示。

### models.ts

- 新增白名单常量、`glob → RegExp` 转换、`isFeatured(id)`、`filterFeatured(models)`。
- **删除 `topN`**:白名单取代其在 UI 的角色后它成为 orphan,连同其测试一并移除。

### statusbar.ts

- `pickModel` 把 `topN(models, TOP_N)` 换成 `filterFeatured(models)`;删除 `TOP_N` 常量;import 去掉 `topN`、加 `filterFeatured`。

---

## 测试

**纯逻辑(`node:test`):**

- `models.test.ts`:删除 topN 用例;新增 `isFeatured` / `filterFeatured`——覆盖 `*` 通配、`.` 字面点、大小写不敏感、跨 provider 命中、未命中归入剩余集。
- `config.test.ts`:调整为"providers.json 只读写 providers";确认 `mapping` 不再从文件读写。

**手动冒烟(F5):**

- 开两个不同项目窗口,各自选不同 model,确认状态栏文本与 `.claude/settings.json` 注入互不干扰(验证 per-project 隔离)。
- 某 provider 下打开模型列表,确认默认仅显示白名单命中项、其余在 `Other…` 内。

---

## 范围外

- 白名单可配置化(出现 glm-6/kimi-k3 等需改代码;暂不做配置项)。
- 其余仍归 Part 2 / Part 3(格式转换、OAuth 登录)。
