# Part 4:存储整顿(凭证进 SecretStorage、缓存进 globalState、移除文件日志)

> 把扩展的持久化从自有文件目录 `~/.claude/proxy/` 收进 VSCode 托管存储:provider key → SecretStorage(系统密钥链),models 缓存 → globalState,移除文件日志。目标:磁盘上不再有任何凭证明文,`~/.claude/proxy/` 不再使用。

## 背景

当前持久化分散:
- `~/.claude/proxy/providers.json` —— provider key(**明文**)
- `~/.claude/proxy/models-cache.json` —— models.dev 缓存
- `~/.claude/proxy/log/*.json` —— 请求/响应日志(`enableJsonLogging` 开时)
- `workspaceState`:mapping;`globalState`:MRU;`SecretStorage`:codex token

明文 key 落盘是安全隐患。本轮把敏感与可托管的数据都交给 VSCode 管理。

唯一保留的文件:`~/.claude/settings.json` 与 `<项目>/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 注入 —— 这是 Claude Code 走代理的唯一机制(它读该文件),无法搬走;但它只含 `http://127.0.0.1:<port>`,非敏感。

## 范围

- **做**:
  1. provider key 从 `providers.json` 迁入 SecretStorage,删除 `providers.json`(首启自动迁移)。
  2. models 缓存从文件迁入 `globalState`,删除 `models-cache.json` 逻辑。
  3. 移除文件日志:删 `saveLog`、`claudeProxy.enableJsonLogging` 配置、`~/.claude/proxy/log/`;保留 `console.log`(Output/Debug Console)。
  4. 废弃 `claudeProxy.editConfig` 命令(key 不再在文件,无可编辑内容)。
- **不做**:改 `.claude/settings.json` 注入机制(保留);改 mapping(仍 workspaceState)/MRU(仍 globalState)/codex token(仍 SecretStorage)。

## 设计

### 1. provider key → SecretStorage

- SecretStorage key `claudeProxy.providerKeys`,值为 `{ [providerName: string]: string[] }`。
- **保持 proxy 同步**:SecretStorage 是异步,但 proxy 每请求需同步拿 key。做法——extension `activate` 时 `await` 读入**内存缓存**;`getConfig()` 仍同步返回 `{ mapping, providers }`(providers 由内存缓存 + workspaceState mapping 组成);`applyConfig()` 改 providers 时更新内存 + 异步写回 SecretStorage。
- config.ts:`ProxyConfig`/`ProviderEntry` 类型与纯助手(`addKey`/`removeKey`/`configuredProviders`/`getProvider`/`setMapping`)**保持不变**(操作内存模型);移除文件相关(`readProviders`/`writeProviders`/`ensureProviders`/`normalizeProviders`/`configPath`)。
- 新增 `src/providerKeys.ts`:`ProviderKeyStore`(构造接收 `vscode.SecretStorage`)——`load(): Promise<Record<string,string[]>>`、`save(map): Promise<void>`;纯解析/合并逻辑可单测(注入 fake SecretStorage)。
- **迁移**:`activate` 时若 `~/.claude/proxy/providers.json` 存在,读出其 `providers` 的 key 合并进 SecretStorage,然后删除该文件(一次性,老用户无感)。

### 2. models 缓存 → globalState

- `globalState` key `claudeProxy.modelsCache`,值 `{ catalog: any, fetchedAt: number }`,TTL 24h。
- models.ts 的纯函数(`parseProviderModels`/`filterFeatured`/`isFeatured`)不变;`getCatalog` 改为接收一个缓存接口 `{ read(): {catalog,fetchedAt}|null; write(catalog): void }`(可注入,便于测试),移除文件 `readCache`/`writeCache`/`cachePath`。
- extension/statusbar 提供 globalState 实现的缓存接口(含 TTL 判断)注入给 `getCatalog`。

### 3. 移除文件日志

- proxy.ts:删除 `saveLog` 函数、`logDir`、所有 `saveLog(...)` 调用、`ProxyServerDeps.isJsonLogging`;保留 `console.log/warn/error`(`[proxy] ...`)。
- extension.ts:删除 `isJsonLogging`;`createProxyServer` 不再传 `isJsonLogging`。
- package.json:移除 `claudeProxy.enableJsonLogging` 配置项;移除 `claudeProxy.editConfig` 命令。

### 4. editConfig 废弃

- 移除命令注册与 package.json contributes;`configPath` 随 config.ts 文件函数一并移除。

## 结果

整顿后磁盘只剩 `.claude/settings.json`(非敏感 URL)。所有凭证(provider key + codex token)在系统密钥链;mapping/MRU/models 缓存在 VSCode 托管存储。`~/.claude/proxy/` 不再创建/使用。

## 测试

- `providerKeys.ts`:load/save/合并 与迁移逻辑,用注入 fake SecretStorage 单测。
- `models.ts`:`getCatalog` 的缓存命中/过期用注入 fake 缓存 + fake fetch 单测;纯函数测试不变。
- config 纯助手测试不变(移除文件读写相关用例)。
- proxy 纯逻辑测试不变(`resolveTarget`/`shouldRotate`)。
- 迁移、SecretStorage 实际读写、globalState 缓存走 F5 手动冒烟(旧 providers.json 自动迁移、key 增删、模型列表缓存生效)。

## 范围外

- `.claude/settings.json` 注入机制(保留);跨窗口 SecretStorage 实时同步(YAGNI,重载窗口同步);新 repo / 插件改名(独立任务)。
