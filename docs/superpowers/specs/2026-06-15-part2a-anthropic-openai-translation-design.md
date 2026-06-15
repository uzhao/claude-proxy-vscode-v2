# Part 2a:Anthropic ↔ OpenAI Chat Completions 格式转换

> 在自有 proxy 内实现格式转换,解锁 openai/openrouter/nvidia(均为 OpenAI Chat Completions 格式)。映射逻辑移植自 CLIProxyAPI 的 `internal/translator/openai/claude`(Go → TypeScript)。gemini(Part 2b)、codex(Part 3,依赖 OAuth)本轮仅留架构注册位。

## 背景

Part 1 已搭好:全局 mapping、provider/key 管理、anthropic 格式转发、key 轮换。非 anthropic 格式(openai/gemini)当前在 [proxy.ts](../../src/proxy.ts) 命中 `forwardable:false` 直接返回 502 占位。本轮把 OpenAI 格式做成真正可转发。

客户端恒为 Claude Code:发送 Anthropic Messages 请求(`/v1/messages`,`stream:true`),期望 Anthropic SSE 响应。

## 范围

- **做**:Anthropic Messages ↔ OpenAI Chat Completions 双向转换,覆盖 openai / openrouter / nvidia。功能含**文本、工具调用、图片、thinking、SSE 流式**。
- **只做流式**:Claude Code 默认 `stream:true`,proxy 对上游也用 `stream:true`,做增量 SSE 转换。不实现非流式响应路径。
- **不做**:gemini 转换(Part 2b)、codex(Part 3)、非流式响应、prompt caching。

## 架构

转换逻辑独立成纯模块 `src/translate/`,proxy.ts 仅按 `preset.format` 分发调用。客户端一端恒为 Anthropic,故只共享 Anthropic 端;openai/gemini/codex 各自独立(与 CLIProxyAPI 的全矩阵不同,后者无固定端、无共享)。

```
src/translate/
  registry.ts    —— 按 preset.format 返回转换器 { buildRequest, createStreamTranslator };openai/gemini/codex 注册位
  anthropic.ts   —— 共享层:Anthropic 请求体解析助手 + Anthropic SSE 事件构造器(message_start / content_block_start|delta|stop / message_delta / message_stop,含 block index 状态)
  sse.ts         —— 通用 SSE 行解析(data: 切分、[DONE] 识别、半行缓冲)
  openai/
    request.ts   —— Anthropic 请求 → OpenAI Chat Completions(纯函数)
    response.ts  —— OpenAI SSE chunk → Anthropic SSE 事件(有状态流转换器,用 anthropic.ts 构造输出)
  gemini/        —— Part 2b 占位
  codex/         —— Part 3 占位(依赖 OAuth)
```

**proxy.ts 改动**:`preset.format === 'openai'` 时——
- 转发 URL:`${baseUrl}/v1/chat/completions`(anthropic 格式仍用 `${baseUrl}${req.url}`)。
- 认证头:`Authorization: Bearer <key>`(anthropic 格式用 `x-api-key`)。
- 请求体:经 `buildRequest` 转换。
- 上游 SSE:经 `createStreamTranslator` 逐 chunk 转 Anthropic SSE 再写回。
- key 轮换:复用现有 401/429/5xx 重试循环。

**presets.ts 改动**:openai/openrouter/nvidia 的 `forwardable` 改 `true`;gemini 仍 `false`。

**数据流:**
```
Claude Code (Anthropic /v1/messages, stream:true)
  → proxy resolveTarget → format=openai
  → buildRequest(body) → OpenAI Chat Completions body (stream:true)
  → fetch ${baseUrl}/v1/chat/completions  (Bearer key,失败轮换)
  → 上游 OpenAI SSE chunks
  → streamTranslator 逐 chunk → Anthropic SSE events
  → 写回 Claude Code
```

## 请求映射(openai/request.ts)

参考 [openai_claude_request.go](../../CLIProxyAPI/internal/translator/openai/claude/openai_claude_request.go)。

| Anthropic 入 | OpenAI 出 |
|---|---|
| `system`(string 或 text blocks) | `messages[0] = {role:'system', content}` |
| user/assistant 文本块 | `messages[].content`(文本) |
| `image{source:{type:base64,media_type,data}}` | `content[]` 内 `{type:'image_url', image_url:{url:"data:<media_type>;base64,<data>"}}` |
| `tools[]`(name/description/input_schema) | `tools[]`(`{type:'function', function:{name, description, parameters:input_schema}}`) |
| `tool_choice` | `tool_choice`(auto/any→required/tool→具名) |
| assistant `tool_use{id,name,input}` | assistant `tool_calls[{id, type:'function', function:{name, arguments:JSON.stringify(input)}}]` |
| user `tool_result{tool_use_id,content}` | `{role:'tool', tool_call_id, content}` |
| assistant `thinking` block(仅 assistant) | `reasoning_content` 字段;`redacted_thinking` 忽略 |
| `thinking.budget_tokens` | `reasoning_effort`(budget→low/medium/high 等级) |
| `max_tokens / temperature / top_p` | 同名 |
| `stop_sequences` | `stop` |
| `model` | `model`(取 mapping 冒号后部分,由 resolveTarget 提供) |
| — | `stream: true`(固定) |

## 响应流状态机(openai/response.ts + anthropic.ts)

参考 [openai_claude_response.go](../../CLIProxyAPI/internal/translator/openai/claude/openai_claude_response.go)。输出标准 Anthropic SSE 事件序列;状态机管三类 content block 与 tool_calls 累加。

事件类型:`message_start`、`content_block_start`、`content_block_delta`(delta 子类型 `text_delta` / `input_json_delta` / `thinking_delta`)、`content_block_stop`、`message_delta`、`message_stop`。

```
首个有效 chunk:
  → 发 message_start(role:assistant, 空 content, usage 占位)
按 OpenAI choices[0].delta 内容驱动:
  delta.content(文本)        → 若 text block 未开则开(分配 index)→ content_block_delta{text_delta}
  delta.reasoning_content     → 若 thinking block 未开则开 → content_block_delta{thinking_delta}
  delta.tool_calls[i]         → 每个 tool_call index 开一个 tool_use block(content_block_start{tool_use,id,name})
                                → 参数增量经 content_block_delta{input_json_delta} 累加 arguments 字符串
切换 block 类型前:先对上一个开着的 block 发 content_block_stop
finish_reason 出现:
  → 关掉所有开着的 block(content_block_stop)
  → message_delta{ delta:{stop_reason}, usage:{output_tokens} }
  → message_stop
[DONE] / 流结束:兜底关 block + message_stop(若尚未发出)
```

stop_reason 映射:`stop → end_turn`、`length → max_tokens`、`tool_calls → tool_use`、其余 → `end_turn`。
usage:从 OpenAI `usage`(prompt_tokens/completion_tokens)映射到 Anthropic `input_tokens/output_tokens`。

## 错误处理

- 上游非 2xx:读取错误体,包装为 **Anthropic 标准错误格式** `{"type":"error","error":{"type":"<映射>","message":"<上游信息>"}}` 返回(并触发 key 轮换条件下的重试)。
- 转换过程异常:捕获后同样以 Anthropic 错误格式返回 500/502,不让连接悬挂。
- 顺带修复:当前非 anthropic 目标返回的非标准 502 body,统一改为 Anthropic 错误格式(对 gemini 这类仍 `forwardable:false` 的占位也适用)。

## 测试

**纯逻辑(node:test):**
- `request.ts`:Anthropic body → OpenAI body —— 覆盖纯文本、图片、tools 声明、tool_use/tool_result 往返、thinking→reasoning、参数透传各一例。
- `response.ts`:喂 OpenAI SSE chunk 序列,断言 Anthropic 事件序列 —— 覆盖纯文本、含 tool_calls、含 reasoning_content、finish_reason 收尾各一例;参考 CLIProxyAPI 的 `*_test.go` 造数据。
- `sse.ts`:行解析边界 —— 半行缓冲、单行多事件、`[DONE]`。
- `registry.ts`:format 分发命中/未命中。

**手动冒烟(F5):** 配置真实 openai(或 openrouter)key,mapping 指向其模型,在 Claude Code 中发起对话,验证文本回复、工具调用、(可选)图片输入正常;故意用无效 key 验证轮换。

## 范围外

- gemini 格式转换(Part 2b)。
- codex(Part 3,依赖 OAuth 登录;本轮仅 registry 占位)。
- 非流式响应路径、prompt caching、扩展 thinking 的签名校验。
