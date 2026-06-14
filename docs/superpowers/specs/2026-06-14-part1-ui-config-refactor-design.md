# Part 1:UI / 配置重构 设计文档

日期:2026-06-14
状态:已批准,待实现

## 背景与整体拆分

`claude-proxy` 扩展计划做一次较大重构,整体拆成三块,各自独立 spec + 实现:

- **Part 1(本文)— UI / 配置重构**:纯配置与交互层,不改动格式转换逻辑。统一 mapping、用独立 JSON 文件组织 provider 配置、去掉启动端口提示、移除外部 spawn litellm/cliproxyapi 的代码,为 Part 2 让路。
- **Part 2 — proxy 内置格式转换**:`pass` 取消代理;原生 Anthropic provider 换 model+key 转发;OpenAI/Gemini 格式在 proxy 内完成转换(移植自 CLIProxyAPI 的 `internal/translator`)。
- **Part 3 — 鉴权 / 登录**:仅 Codex OAuth 登录,其他 OAuth 暂不需要。

本文只覆盖 Part 1。

## Part 1 目标

解决当前 UI 的几个问题:

1. CC 并无"问题简单时切换 haiku"的机制,haiku/main 两套 mapping 没有意义 → 统一成单一 mapping。
2. 设置中逐个平铺 provider(8 个配置段)非常乱 → 改为独立 JSON 配置文件。
3. 启动时提示"端口启动了代理"对用户无用 → 删除。
4. 外部启动 litellm/cliproxyapi 的方式粗糙 → 移除进程管理代码(转换能力由 Part 2 在自有 proxy 内实现)。

## 设计细节

### 1. 配置存储:`~/.claude/proxy/providers.json`

扩展自管的全局配置文件,取代现有所有 `claudeProxy.providers.*` 与 `claudeProxy.mappings.*` 设置段。

```jsonc
{
  "mapping": "glm:glm-4.6",          // 全局单一 mapping;"pass" 表示透传
  "providers": [
    // 所有条目统一极简:只有 name(= preset id)+ apiKeys
    { "name": "glm", "apiKeys": ["sk-a", "sk-b"] },
    { "name": "deepseek", "apiKeys": ["sk-c"] }
  ]
}
```

- `mapping` 为全局单一值,格式 `provider:model` 或 `pass`。
- **条目统一极简**:只存 `name`(= preset id,见下表)+ `apiKeys`;`format` / `baseUrl` 来自内置 preset 目录,`models` 来自 models.dev。无自定义 provider —— 所有 provider 均出自内置 preset 目录。
- VSCode 设置仅保留 `claudeProxy.enableJsonLogging`;`port` 不再暴露为设置(运行时随机)。
- 文件不存在时,扩展首启写入一份带注释的示例模板。
- 扩展监听该文件变化(`fs.watch` 或轮询),变化时刷新状态栏与转发配置。

### 2. 内置 preset 目录(写在扩展代码里)

每个 preset 自带默认 `format` / `baseUrl` 与 models.dev 映射 id。**移除 groq**。`codex` 列出但实际登录属于 Part 3,Part 1 仅占位。

| preset | format | 默认 baseUrl | models.dev id | Part 1 可转发 |
|---|---|---|---|---|
| openai | openai | api.openai.com | openai | ❌(Part 2) |
| gemini | gemini | generativelanguage.googleapis.com | google | ❌(Part 2) |
| openrouter | openai | openrouter.ai/api | openrouter | ❌(Part 2) |
| nvidia | openai | integrate.api.nvidia.com | nvidia | ❌(Part 2) |
| glm | anthropic | open.bigmodel.cn/api/anthropic | zhipuai | ✅ |
| kimi | anthropic | api.moonshot.cn/anthropic | moonshotai | ✅ |
| deepseek | anthropic | api.deepseek.com/anthropic | deepseek | ✅ |
| minimax | anthropic | api.minimaxi.com/anthropic | minimax | ✅ |
| codex | (Part 3) | — | openai | ❌(Part 3) |

### 3. 模型列表来源:models.dev

- 所有 provider 的可用模型**统一来自 models.dev**(`https://models.dev/api.json`,顶层按 provider id 索引,每个 provider 下 `models` 为 `{模型id: {name, release_date, …}}`)。
- 用户**不手动维护模型**;加完 key 即可在切换菜单看到模型。
- 拉取后缓存到 `~/.claude/proxy/models-cache.json`(带 TTL,例如 24h);离线 / 拉取失败时用缓存。
- provider 通过表中的 models.dev id 取列表。
- "较新模型"的判定:按 `release_date` / `last_updated` 倒序取前 N 个(例如 8)作为默认列表;`Other` 展开全部。对 openrouter 这类海量列表同一规则适用。

### 4. 模型识别:取消 haiku/main 区分

- 删除 `extractModelType`。
- 进来的请求无论模型名是 haiku/sonnet/opus,一律走同一个 `mapping`。
- 已知代价:CC 的后台 haiku 调用也会路由到该 provider —— 已接受。

### 5. 状态栏交互:单一入口 QuickPick(逐级下钻)

VSCode 状态栏点击只能执行一个命令,**没有原生向左右级联的子菜单**;用 QuickPick"替换列表 + ← 返回"实现逐级下钻。右下角保留一个状态栏项,文本显示当前 mapping(`pass` 时显示"透传"):

- **一级**(分隔符分两段):
  - `[Recent]`:`Pass`(永远置顶)+ 最近使用条目(`Provider: Model`)。
  - `[Provider]`:**仅列出已添加 key 的 provider**。
  - 底部:`⚙ Provider 设置`(进入管理流程)。
- **二级(选某 provider 切模型)**:默认列该 provider 较新模型 + 底部 `Other`;选中模型即写入 `mapping = provider:model` 并刷新状态栏。
- **三级(Other)**:列该 provider 全部模型。

MRU 最多 5 条,存于扩展 `globalState`(Memento),不写入 `providers.json`。

### 6. Provider 设置(管理流程,内嵌于切换菜单)

不另设入口、不依赖命令面板;从一级菜单的 `⚙ Provider 设置` 进入:

- 进入后弹出命令面板式 QuickPick,**列出全部 preset**(此处才包含尚未配置 key 的 provider)。
- 选中某 provider → **管理 key**:列出已有 key(掩码显示)、`添加 key`(输入框)、选中某 key 删除。
- 所有改动写回 `providers.json`。某 provider 的 key 数归零即视为未配置(从切换菜单的 `[Provider]` 段消失)。
- 不在此处管理模型(模型恒来自 models.dev)。

> 现有命令 `selectHaikuMapping` / `selectMainMapping` 删除。可保留一个 `Claude Proxy: 编辑配置` 命令直接打开 `providers.json` 作为高级入口(非主路径)。

### 7. 转发与 key 轮换

`getTargetConfig` 重写为读取 `providers.json` + 内置 preset 目录:

- Part 1 仅实现 **`anthropic` 格式**转发:替换 baseUrl、`model`、认证头(`x-api-key`),与现状一致。
- **key 轮换(失败时切换)**:正常请求使用当前 key;遇到 401 / 429 / 5xx 或网络错误时,切换到该 provider 的下一个 key 重试,直至该 provider 的 keys 耗尽再返回错误。
- `format` 为 `openai` / `gemini` 的 provider 允许配置并出现在菜单中,但选中 / 命中时暂时返回提示"该格式将在 Part 2 支持",不参与转发。

### 8. 移除项

- 启动提示 `Claude Proxy 已启动 (端口…)` → 删除,仅保留 `console.log`。
- 进程管理相关代码全部删除:`startLiteLLM` / `stopLiteLLM` / `startCLIProxyAPI` / `stopCLIProxyAPI` / `fetchWithRetry` 的重启重试逻辑 / `filterLiteLLMChunk` / litellm & cliproxyapi 的配置项与对应日志清理。
- 过渡代价:Part 1 完成到 Part 2 之前,openai/gemini 类目标不可用(扩展尚在 0.0.x,可接受)。

### 9. 代理开关(沿用现有项目级注入)

- `mapping === "pass"` → 清除当前项目 `.claude/settings.json` 中的 `ANTHROPIC_BASE_URL`,保证干净的官方请求。
- 否则注入 `http://127.0.0.1:<随机端口>`。
- 全局 `~/.claude/settings.json` 始终清空代理设置的逻辑保留。

### 10. 代码结构拆分

现 `extension.ts`(1226 行)拆为聚焦模块,便于 Part 2/3 扩展:

- `config.ts` —— `providers.json` 读写、schema、模板生成、文件监听;内置 preset 目录
- `models.ts` —— models.dev 拉取、缓存(TTL)、按 provider 取模型 / 较新模型
- `proxy.ts` —— HTTP server + 转发 + key 轮换
- `statusbar.ts` —— 状态栏 + 切换 QuickPick(逐级下钻)+ MRU + Provider 设置流程
- `claudeSettings.ts` —— 项目级 `ANTHROPIC_BASE_URL` 注入 / 清理(含全局清空)
- `extension.ts` —— `activate` / `deactivate` 装配

## 范围边界

- **属于 Part 1**:上述配置/交互/转发(仅 anthropic)/移除项/模块拆分。
- **不属于 Part 1(留待 Part 2)**:OpenAI / Gemini ↔ Claude 的格式转换。
- **不属于 Part 1(留待 Part 3)**:Codex / OAuth 登录。

## 发布考虑(非 Part 1 实现项)

新版与旧版差异很大,为避免现有用户自动更新后不适应,计划**以新的扩展名 / id 发布**(而非作为 `uzhao.claude-proxy` 的更新)。具体新名称待发布时再定,不阻塞 Part 1 实现。

## 验收标准

1. 删除所有 `claudeProxy.providers.*` 与 `claudeProxy.mappings.*` 设置,改由 `providers.json` 驱动;首启自动生成模板。
2. 状态栏切换菜单:一级含 `[Recent]`(Pass + 最近)与 `[Provider]`(仅已加 key 的)两段及 `⚙ Provider 设置`;选 provider → 较新模型 + `Other`;选模型后 `mapping` 与状态栏文本即时更新。
3. `⚙ Provider 设置` 可列出全部 preset,并对选中 provider 增 / 删 key,改动写回 `providers.json`;key 归零后该 provider 从 `[Provider]` 段消失。
4. 模型列表来自 models.dev 并本地缓存(按 preset 的 models.dev id 取);离线时用缓存。
5. 配置 anthropic 格式 provider 后,Claude 请求被正确换 baseUrl/model/key 转发;某 key 触发 401/429/5xx 时自动切下一个 key。
6. `mapping = pass` 时当前项目 `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 被清除;非 pass 时注入当前随机端口。
7. 启动无端口弹窗;代码中不再存在 litellm/cliproxyapi 进程管理逻辑。
8. `extension.ts` 拆分为上述模块,编译通过(`npm run compile`)。
