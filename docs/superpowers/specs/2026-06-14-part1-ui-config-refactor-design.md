# Part 1:UI / 配置重构 设计文档

日期:2026-06-14
状态:已批准,待实现

## 背景与整体拆分

`claude-proxy` 扩展计划做一次较大重构,整体拆成三块,各自独立 spec + 实现:

- **Part 1(本文)— UI / 配置重构**:纯配置与交互层,不改动格式转换逻辑。统一 mapping、用独立 JSON 文件组织 provider 配置、去掉启动端口提示、移除外部 spawn litellm/cliproxyapi 的代码,为 Part 2 让路。
- **Part 2 — proxy 内置格式转换**:`pass` 取消代理;原生 Anthropic provider 换 model+key 转发;OpenAI/Gemini 格式在 proxy 内完成转换(移植自 CLIProxyAPI 的 `internal/translator`)。
- **Part 3 — 鉴权 / 登录**:Codex OAuth 登录,可能含其他 OAuth 类 provider。

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
  "mapping": "glm:glm-4-plus",          // 全局单一 mapping;"pass" 表示透传
  "providers": [
    {
      "name": "glm",                     // 唯一标识,作为 mapping 前缀
      "format": "anthropic",             // anthropic | openai | gemini(后两者 Part 2 才真正转换)
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "apiKeys": ["sk-a", "sk-b"],       // 数组,失败时轮换
      "models": ["glm-4-plus", "glm-4-flash"]
    }
  ]
}
```

- `mapping` 为全局单一值,格式 `provider:model` 或 `pass`。
- VSCode 设置仅保留 `claudeProxy.enableJsonLogging`;`port` 不再暴露为设置(运行时随机)。
- 文件不存在时,扩展首启写入一份带注释的示例模板。
- 扩展监听该文件变化(`fs.watch` 或轮询),变化时刷新状态栏与转发配置。

### 2. 模型识别:取消 haiku/main 区分

- 删除 `extractModelType`。
- 进来的请求无论模型名是 haiku/sonnet/opus,一律走同一个 `mapping`。
- 已知代价:CC 的后台 haiku 调用也会路由到该 provider —— 已接受。

### 3. 状态栏交互:分级 quick-pick

右下角状态栏保留,文本显示当前 mapping(`pass` 时显示"透传")。点击进入多级菜单(VSCode quick-pick 逐级 push 实现):

- **一级**:`最近使用`(MRU)条目 + `pass(透传)` + `全部 ▸`
- **二级(全部)**:按 provider 列出
- **三级**:该 provider 的 models;选中即写入 `mapping = provider:model`

- MRU 最多 5 条,存于扩展 `globalState`(Memento),不写入 `providers.json`。
- 额外命令 `Claude Proxy: 编辑配置`,直接打开 `providers.json`。
- 现有两个命令(`selectHaikuMapping` / `selectMainMapping`)删除,替换为单一切换入口(状态栏)+ 编辑命令。

### 4. 转发与 key 轮换

`getTargetConfig` 重写为读取 `providers.json`:

- Part 1 仅实现 **`anthropic` 格式**转发:替换 baseUrl、`model`、认证头(`x-api-key`),与现状一致。
- **key 轮换(失败时切换)**:正常请求使用当前 key;遇到 401 / 429 / 5xx 或网络错误时,切换到该 provider 的下一个 key 重试,直至该 provider 的 keys 耗尽再返回错误。
- `format` 为 `openai` / `gemini` 的 provider 允许配置并出现在菜单中,但选中/命中时暂时返回提示"该格式将在 Part 2 支持",不参与转发。

### 5. 移除项

- 启动提示 `Claude Proxy 已启动 (端口…)` → 删除,仅保留 `console.log`。
- 进程管理相关代码全部删除:`startLiteLLM` / `stopLiteLLM` / `startCLIProxyAPI` / `stopCLIProxyAPI` / `fetchWithRetry` 的重启重试逻辑 / `filterLiteLLMChunk` / litellm & cliproxyapi 的配置项与对应日志清理。
- 过渡代价:Part 1 完成到 Part 2 之前,openai/gemini 类目标不可用(扩展尚在 0.0.x,可接受)。

### 6. 代理开关(沿用现有项目级注入)

- `mapping === "pass"` → 清除每个项目 `.claude/settings.json` 中的 `ANTHROPIC_BASE_URL`,保证干净的官方请求。
- 否则注入 `http://127.0.0.1:<随机端口>`。
- 全局 `~/.claude/settings.json` 始终清空代理设置的逻辑保留。

### 7. 代码结构拆分

现 `extension.ts`(1226 行)拆为聚焦模块,便于 Part 2/3 扩展:

- `config.ts` —— `providers.json` 读写、schema、模板生成、文件监听
- `proxy.ts` —— HTTP server + 转发 + key 轮换
- `statusbar.ts` —— 状态栏 + 分级 quick-pick + MRU
- `claudeSettings.ts` —— 项目级 `ANTHROPIC_BASE_URL` 注入 / 清理(含全局清空)
- `extension.ts` —— `activate` / `deactivate` 装配

## 范围边界

- **属于 Part 1**:上述配置/交互/转发(仅 anthropic)/移除项/模块拆分。
- **不属于 Part 1(留待 Part 2)**:OpenAI / Gemini ↔ Claude 的格式转换。
- **不属于 Part 1(留待 Part 3)**:Codex / OAuth 登录。

## 验收标准

1. 删除所有 `claudeProxy.providers.*` 与 `claudeProxy.mappings.*` 设置,改由 `providers.json` 驱动;首启自动生成模板。
2. 状态栏分级菜单可在 `最近使用` / `pass` / `全部 ▸ provider ▸ model` 间切换,选中后 `mapping` 与状态栏文本即时更新。
3. 配置 anthropic 格式 provider 后,Claude 请求被正确换 baseUrl/model/key 转发;某 key 触发 401/429/5xx 时自动切下一个 key。
4. `mapping = pass` 时项目 `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 被清除;非 pass 时注入当前随机端口。
5. 启动无端口弹窗;代码中不再存在 litellm/cliproxyapi 进程管理逻辑。
6. `extension.ts` 拆分为上述模块,编译通过(`npm run compile`)。
