# Part 2c:Anthropic ↔ OpenAI Responses API 格式转换

> 在自有 proxy 内实现 Anthropic Messages ↔ OpenAI **Responses API**(`/v1/responses`)转换,把 openai 官方从 chat completions 切到 Responses API(gpt-5 系原生支持 reasoning + tools,不再受 chat completions 的参数限制)。映射逻辑移植自 CLIProxyAPI 的 `internal/translator/codex/claude`,**剥离 codex/ChatGPT 专属部分**(留给 Part 3)。

## 背景

Part 2a 已实现 chat completions 转换,但 openai 官方的 gpt-5 系在 `/v1/chat/completions` 下限制重重(`max_tokens` 废弃、`reasoning_effort` 与 tools 冲突)。gpt-5 系是为 **Responses API** 设计的。本轮让 openai 走 Responses API,彻底绕开这些限制。

openrouter / nvidia 只支持 chat completions,继续用 Part 2a 的转换。Responses 转换也为 Part 3 的 codex 复用(codex 同样走 Responses,只是凭证来自 OAuth)。

客户端恒为 Claude Code(Anthropic Messages,`stream:true`)。

## 范围

- **做**:Anthropic Messages ↔ OpenAI Responses API 双向转换,服务 **openai**。功能含文本、工具调用、图片、thinking(reasoning)、SSE 流式。
- **仅流式**:对上游用 `stream:true`,做增量 SSE 转换;不实现非流式响应路径。
- **剥离 codex 专属(留 Part 3)**:`instructions` 注入、reasoning `encrypted_content`/signature 校验、web_search 工具特殊处理、ChatGPT 专属 headers。
- **不做**:gemini(已放弃)、codex OAuth(Part 3)、prompt caching。

## 架构

复用 `src/translate/` 结构,新增 `responses/` 子模块;openai 一端恒为 Anthropic,继续共享 `anthropic.ts` 输出端。

```
src/translate/
  registry.ts       —— 改:getTranslator 按 preset(而非仅 format)分发
  responses/
    request.ts      —— Anthropic 请求 → Responses {model, input:[...]}(纯函数)
    response.ts     —— Responses SSE 事件 → Anthropic SSE(有状态流转换器)
  openai/           —— Part 2a chat completions(openrouter/nvidia 继续用)
  anthropic.ts / sse.ts —— 复用
  responses/request.test.ts / response.test.ts
```

**preset 区分**:`Preset` 接口加字段 `api: 'chat' | 'responses'`(默认 `'chat'`)。openai 设 `'responses'`;openrouter/nvidia/其余保持 `'chat'`。

**registry 分发**:`getTranslator` 签名由 `(format: ProviderFormat)` 改为 `(preset: Preset)`,内部按 `preset.api` 返回 responses 或 chat-completions translator。`Translator` 接口不变(`/v1/responses`、`authHeader` 用 `Bearer`、model 在 body,与现有接口兼容)。proxy.ts 调用点相应改为传 preset。

**数据流:**
```
Claude Code (Anthropic /v1/messages, stream:true)
  → proxy resolveTarget → preset.api=responses
  → buildResponsesRequest(body, model) → Responses body (stream:true)
  → fetch ${baseUrl}/v1/responses  (Bearer key,失败轮换)
  → 上游 Responses SSE 事件
  → streamTranslator 逐事件 → Anthropic SSE
  → 写回 Claude Code
```

## 请求映射(responses/request.ts)

参考 [codex_claude_request.go](../../CLIProxyAPI/internal/translator/codex/claude/codex_claude_request.go),剥离 codex 专属。

输出模板:`{model, input:[], stream:true}`(不注入 instructions)。

| Anthropic 入 | Responses 出(input item) |
|---|---|
| `system`(string/blocks) | `{type:'message', role:'developer', content:[{type:'input_text', text}]}` |
| user 文本 | `{type:'message', role:'user', content:[{type:'input_text', text}]}` |
| assistant 文本 | `{type:'message', role:'assistant', content:[{type:'output_text', text}]}` |
| `image{base64}` | message content 内 `{type:'input_image', image_url:"data:<mt>;base64,<data>"}` |
| assistant `tool_use{id,name,input}` | `{type:'function_call', call_id:id, name, arguments:JSON.stringify(input)}` |
| user `tool_result{tool_use_id,content}` | `{type:'function_call_output', call_id:tool_use_id, output:<text>}` |
| `tools[]` | `tools:[{type:'function', name, description, parameters:input_schema}]` |
| `tool_choice` | `tool_choice`(auto/any→required/tool→具名;none→none) |
| `max_tokens` | `max_output_tokens` |
| `temperature/top_p` | 同名 |
| `thinking`(enabled/budget) | `reasoning:{effort}`(budget→low/medium/high;summary 不强制) |
| assistant `thinking` block | **本轮忽略**(codex 的 encrypted reasoning 留 Part 3) |
| `model` | `model`(mapping 冒号后部分) |
| — | `stream:true` |

注:tool_use 的 `call_id` 与 tool_result 的 `call_id` 用同一 id 关联(Responses API 用 call_id,不像 gemini 靠 name,较简单)。

## 响应状态机(responses/response.ts + anthropic.ts)

参考 [codex_claude_response.go](../../CLIProxyAPI/internal/translator/codex/claude/codex_claude_response.go)。Responses SSE 是 typed 事件(`event: response.xxx` + data),状态机据事件类型驱动 Anthropic block。

输出 Anthropic 事件:`message_start`/`content_block_start|delta|stop`/`message_delta`/`message_stop`。

| Responses 事件 | 动作 |
|---|---|
| `response.created` | 记录 id/model(待首个 item 再发 message_start) |
| `response.output_item.added`(message/function_call/reasoning) | 开对应 block:message→text、function_call→tool_use(带 call_id/name)、reasoning→thinking |
| `response.output_text.delta` | text block 的 `text_delta` |
| `response.reasoning_summary_text.delta` | thinking block 的 `thinking_delta` |
| `response.function_call_arguments.delta` | tool_use block 的 `input_json_delta`(累加 arguments) |
| `response.output_item.done` / `content_part.done` | 关对应 block(content_block_stop) |
| `response.completed` | 关所有 block → message_delta(stop_reason + usage)→ message_stop |
| `error` | 以 Anthropic 错误格式返回 |

stop_reason 映射:正常 completed → `end_turn`;有 function_call → `tool_use`;`incomplete`(max_output_tokens)→ `max_tokens`。usage:Responses `usage.input_tokens/output_tokens` 直接对应 Anthropic。

> message_start 在收到首个 `output_item.added` 时发出(此时已有 id/model)。block index 管理复用 Part 2a 的方式(text/thinking/tool 各分配递增 index)。

## 错误处理

- 上游非 2xx 或 `error` 事件 → Anthropic 标准错误格式 `{type:"error", error:{type, message}}`。
- key 轮换复用 proxy.ts 现有 401/429/5xx 逻辑。

## 测试

**纯逻辑(node:test):**
- `request.ts`:Anthropic body → Responses body —— 覆盖 system→developer、文本(user/assistant)、图片、tools 声明、tool_use→function_call、tool_result→function_call_output、max_tokens→max_output_tokens、thinking→reasoning.effort 各一例。
- `response.ts`:喂 Responses SSE 事件序列,断言 Anthropic 事件序列 —— 覆盖纯文本、含 function_call、含 reasoning、completed 收尾各一例。参考 CLIProxyAPI 的 `codex_claude_*_test.go` 造数据。
- `registry.ts`:openai→responses translator、openrouter/nvidia→chat translator 的分发。

**手动冒烟(F5):** 配置 openai key,mapping 指向 gpt-5 系模型,在 Claude Code 中验证文本回复、工具调用、(可选)图片正常;无效 key 验证轮换。

## 范围外

- codex OAuth 登录与 codex 专属处理(Part 3,在本轮 Responses 转换之上叠加)。
- gemini(已放弃)、非流式响应、prompt caching。
