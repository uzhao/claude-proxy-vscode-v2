# Claude Proxy v2

一个 VSCode 扩展:在本地把 Claude Code 的请求代理到多种 AI provider,**状态栏一键切换模型**。

## ✨ 功能

- **状态栏单一入口** —— 点右下角 `Claude: …`,在弹出菜单里选「透传」/「最近用过的模型」/「Provider 设置」;逐级选模型,即时生效,**按项目独立记忆**当前模型。
- **模型列表来自 [models.dev](https://models.dev)** —— 各 provider 的可选模型实时取自 models.dev,默认展示主流新模型,其余收进「Other…」可展开。
- **proxy 内置格式转换**(无需任何外部进程),支持的上游格式:
  - **Anthropic 原生** —— 直接换 endpoint/key 转发,零转换开销
  - **OpenAI Chat Completions** —— 兼容平台/聚合网关
  - **OpenAI Responses API** —— OpenAI 官方(gpt-5 系)
  - **ChatGPT(codex)** —— OAuth 登录后用订阅额度
- **OpenAI 官方 flex / 每日免费额度** —— 在 openai provider 子菜单里三个开关:`flex`(注入 `service_tier: "flex"`,更便宜更慢)、`freeTokens`(参与官方数据共享计划时,按 UTC 天计量 1M / 10M 两个共享池)、`freeTokensOnly`(只用免费额度,池用尽或模型不在免费列表则停用该请求)。跨 UTC 0 点自动归零。
- **API key 轮换** —— 一个 provider 配多个 key,遇 401/429/5xx 自动切换下一个。
- **透传模式** —— 选 `Pass` 不改请求,直连 Claude 官方。
- 转发覆盖**文本、工具调用、图片、thinking、SSE 流式**。

## 🚀 使用

1. 安装后扩展自动在本地起代理,并把当前项目的 `.claude/settings.json` 指向它(写入 `ANTHROPIC_BASE_URL`)。
2. 点状态栏 `Claude: …` → **Provider 设置** → 给某 provider 添加 API key(codex 则选「登录 ChatGPT」走 OAuth)。
3. 再点状态栏 → 选该 provider 的模型。之后 Claude Code 的请求即走代理、转发到该模型。
4. 选 **Pass(透传)** 可随时恢复直连官方。

> 切换 provider / 登录后,重启一次 Claude Code 会话,使其读到最新的代理地址。

## 🔧 工作原理

- 本地 HTTP 代理(固定起始端口 `claudeProxy.port`,默认 4001,被占用时自动递增),通过项目 `.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 接入 Claude Code。
- `mapping = pass` 时透传到 `api.anthropic.com`;否则按目标 provider 的格式转换请求、转发,并把上游的流式响应回译为 Anthropic SSE 返回给 Claude Code。
- provider API key 与 codex OAuth 凭证均存入**系统密钥链**(VSCode SecretStorage),不落明文磁盘;模型列表缓存于 VSCode globalState。

## 🛠️ 开发

```bash
npm install
npm run compile   # 编译到 out/
npm test          # 运行纯逻辑测试(node:test)
# 在 VSCode 中按 F5 启动扩展开发宿主
```

## 📄 许可证

[MIT License](LICENSE)
