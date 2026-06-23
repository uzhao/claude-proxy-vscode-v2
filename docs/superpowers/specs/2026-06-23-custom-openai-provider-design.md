# 自定义 OpenAI 兼容 Provider(Ollama 等)

> 现有 provider 全部硬编码在 `presets.ts` 的 `PRESETS` 里。本轮让用户能在扩展内自行添加 OpenAI 兼容(Chat Completions)的 provider —— 典型场景是本地 Ollama / LM Studio / vLLM / LiteLLM,填个 baseUrl 就能用,模型从该端点的 `/v1/models` 自动拉取、拉不到可手填,key 可选(本地服务通常不需要)。

## 背景

转发体系围绕硬编码 `Preset = { id, format, baseUrl, modelsDevId, forwardable, api }` 构建:

- **转发**:`proxy.ts` 的 `resolveTarget` 用 mapping(`provider:model`)查 `getPreset`,openai 格式走 translator 转 Anthropic SSE,anthropic 格式原样转发。
- **模型列表**:`models.ts` 从 `models.dev` 按 `modelsDevId` 拉取,再过 featured 白名单。
- **key**:存 SecretStorage,按 provider name 索引;`resolveTarget` 里**除 codex 外必须有至少一个 key** 才转发。
- **UI**:全是 `statusbar.ts` 的 QuickPick(选映射 / 选模型 / 管 key / 改端口)。

接入 Ollama 这类自定义 provider 有三个与现有体系不匹配的点:

1. **没有 `modelsDevId`** —— 本地模型名任意,models.dev 查不到,现有选模型流程不适用。
2. **可能不需要 key** —— Ollama 无需 key,但 `resolveTarget` 现在强制要求 key。
3. **需要持久化** —— preset 写死在源码,自定义项必须存到用户侧存储。

协议范围已确认**只做 OpenAI Chat Completions**(`format:'openai', api:'chat'`),它正好命中现有 `CHAT_TRANSLATOR`,所以转发与格式转换链路**零改动**。

## 范围

- **做**:
  1. 新增 `CustomProvider = { id, baseUrl }`,存 `globalState`(键 `claudeProxy.customProviders`),跨项目共享。
  2. `Preset` 增可选 `custom?: boolean`;纯函数把自定义项派生成 `Preset`,并提供合并查找。
  3. `proxy.resolveTarget` 改用合并查找,并放开"自定义项允许 0 key"。
  4. 选模型:自定义项走 `GET {baseUrl}/v1/models` 拉取(带可选 Bearer),列表末尾给"手动输入",拉取失败直接弹手填。
  5. UI:`providerSettings()` 加"添加自定义 provider";自定义项支持管理 key / 编辑 baseUrl / 删除;`openMenu()` 中自定义项即使 0 key 也展示。
- **不做**:responses / anthropic 协议的自定义项;"测试连接"按钮;models.dev 之外内置 provider 的任何改动;`.claude/settings.json` 注入机制。

## 设计

### 1. 数据模型与存储

- 新类型 `CustomProvider = { id: string; baseUrl: string }`。
- `globalState` 键 `claudeProxy.customProviders`,值 `CustomProvider[]`。
- `config.ts` 的 `ProxyConfig` 增字段 `customProviders: CustomProvider[]`(它本就是"运行时内存聚合视图",自定义项是其一部分)。新增纯助手:
  - `addCustomProvider(cfg, cp): ProxyConfig`
  - `updateCustomProvider(cfg, id, baseUrl): ProxyConfig`
  - `removeCustomProvider(cfg, id): ProxyConfig`(同时从 `providers` 里摘掉同名 key 项)
- key 仍走 SecretStorage,复用现有 `ProviderKeys`(按 id 索引),无新增存储。

### 2. Preset 合并与查找

- `presets.ts` 的 `Preset` 增可选字段 `custom?: boolean`。
- 新增纯函数:
  - `customToPreset(cp: CustomProvider): Preset` —— 返回 `{ id: cp.id, format:'openai', baseUrl: cp.baseUrl, modelsDevId:'', forwardable:true, api:'chat', custom:true }`。
  - `resolvePreset(cfg: ProxyConfig, name: string): Preset | undefined` —— 先查内置 `PRESETS`,再在 `cfg.customProviders` 里找,命中则 `customToPreset`。
- `proxy.ts` 的 `resolveTarget`、`statusbar.ts` 各处把 `getPreset(name)` 换成 `resolvePreset(cfg, name)`。`resolvePreset` 内部复用现有 `getPreset` 查内置,故 `getPreset` 保留。

### 3. proxy 转发

- 自定义项 `format:'openai' / api:'chat'`、`id !== 'codex'` → `getTranslator` 自动返回现有 `CHAT_TRANSLATOR`,**转发与 SSE 转换链路不改**。
- `resolveTarget` 放开 key 限制:
  `if (preset.id !== 'codex' && !preset.custom && apiKeys.length === 0) return null;`
- 有 key 时照常 `Authorization: Bearer <key>`(`CHAT_TRANSLATOR.authHeader`);无 key 时走现有 `tryKeys = [null]` 分支(`if (key)` 跳过认证头),已天然支持。

### 4. 模型获取(自定义专属路径)

- `models.ts` 加纯函数 `parseEndpointModels(json): ModelInfo[]` —— 从 OpenAI 标准 `/v1/models` 响应 `{ data: [{ id }] }` 取 id;无发布日期,`name = id`,`releaseDate = ''`;按 id 升序排序;**不过 featured 白名单**(本地模型不在白名单语义内)。
- `statusbar.ts` 的 `pickModel` 按 `preset.custom` 分支:
  - 自定义:`GET {baseUrl}/v1/models`(若该 provider 有 key 则带 `Authorization: Bearer`),`parseEndpointModels` 后列出,末尾追加"✎ 手动输入…"。
  - 拉取失败(网络/非 2xx/解析空):提示后直接弹 `showInputBox` 手填模型名。
  - 选中具体模型或手填非空 → `setMapping(\`${id}:${model}\`)`,与现有一致。
- 内置 provider 的 models.dev 路径不变。

### 5. UI(statusbar)

- `providerSettings()`:
  - 列表顶部加一项"➕ 添加自定义 provider":
    - 输入 `id`:校验非空、不含 `:`、不与内置 `PRESETS` id 及已有自定义 id 冲突(给 `validateInput` 文案)。
    - 输入 `baseUrl`:校验以 `http://` / `https://` 开头;保存前去掉尾部 `/`,并去掉误带的尾部 `/v1`(示例提示 `http://localhost:11434`)。
    - 落地:`applyConfig(addCustomProvider(...))`。
  - 内置 provider 项:行为不变(仅管理 key)。
  - 自定义 provider 项:点进去是一个子菜单 —— 管理 key / 编辑 baseUrl / 删除。
    - 删除:`removeCustomProvider`(连带清 key);若当前 `mapping` 前缀等于被删 id,则一并 `setMapping('pass')`。
- `openMenu()` 的 Provider 区:在"有 key 的内置 provider + 已登录 codex"基础上,**并入所有自定义 provider(无论是否有 key)**,去重后展示,便于直接选它做映射。
- `applyConfig`(extension.ts)扩展:除写 providerKeys(SecretStorage)/ mapping(workspaceState)外,**把 `cfg.customProviders` 持久化到 globalState**;`getConfig()` 从 globalState 读出填入 `customProviders`。

## 结果

用户在"Provider 设置"里添加一个 `id=ollama`、`baseUrl=http://localhost:11434` 的自定义 provider(无需 key),即可在主菜单选它、从 `/v1/models` 选模型(或手填),mapping 设为 `ollama:<model>` 后 Claude Code 的请求被转换成 Chat Completions 转发到本地 Ollama。内置 provider 行为完全不变。

## 测试

- **纯函数单测**(沿用现有 `*.test.ts` 风格):
  - `config.ts`:`addCustomProvider` / `updateCustomProvider` / `removeCustomProvider`(含删除时摘 key)。
  - `presets.ts`:`customToPreset` 字段正确;`resolvePreset` 命中内置、命中自定义、id 冲突时以内置为准、未命中返回 undefined。
  - `models.ts`:`parseEndpointModels` 正常解析 / 空 data / 缺字段降级。
  - `proxy.ts`:`resolveTarget` 对自定义项 0 key 仍返回 target(keyless),有 key 时带 key。
- **手动冒烟(F5)**:添加 Ollama provider → `/v1/models` 列表出现 → 选模型 → 发起对话成功转发;编辑 baseUrl、删除(连带 mapping 重置)生效;有 key 的自定义网关带 Bearer 正常。

## 范围外

- responses / anthropic 协议的自定义项(仅 chat completions)。
- 连接健康检查 / "测试连接"按钮。
- 自定义项的模型缓存(每次选模型实时拉 `/v1/models`,本地端点开销可忽略)。
- 跨窗口 globalState 实时同步(重载窗口同步,与现有约定一致)。
