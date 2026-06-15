# Part 2a:Anthropic ↔ OpenAI Chat Completions 格式转换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自有 proxy 内实现 Anthropic Messages ↔ OpenAI Chat Completions 的流式格式转换,解锁 openai/openrouter/nvidia(文本/工具/图片/thinking,仅流式)。

**Architecture:** 转换逻辑独立成 `src/translate/` 纯模块,proxy.ts 按 `preset.format` 经 registry 分发调用。客户端恒为 Claude Code,故仅共享 Anthropic 输出端(`anthropic.ts` 的 SSE 事件构造);openai 的请求/响应转换各自独立。映射逻辑移植自 CLIProxyAPI `internal/translator/openai/claude`(Go→TS),做了合理简化(见各 Task)。

**Tech Stack:** TypeScript(commonjs/ES2020/strict)、Node 内置 `node:test`、全局 `fetch`。

---

## 文件结构

```
src/translate/
  sse.ts            —— SSEParser(上游字节流→data 负载)+ sseEvent(序列化 Anthropic 事件)
  anthropic.ts      —— Anthropic SSE 事件构造器 + mapStopReason + extractUsage(共享输出端)
  registry.ts       —— Translator 接口 + getTranslator(format 分发)
  openai/
    request.ts      —— buildOpenAIRequest:Anthropic 请求 → OpenAI Chat Completions(纯函数)
    response.ts     —— OpenAIToClaudeStream:OpenAI SSE → Anthropic SSE(有状态流转换器)
  sse.test.ts / anthropic.test.ts / registry.test.ts / openai/request.test.ts / openai/response.test.ts
```
改动:`src/presets.ts`(openai/openrouter/nvidia 的 forwardable→true)、`src/proxy.ts`(接入 translator + 错误格式统一)、`package.json`(test 脚本递归匹配子目录)。

> 注:spec 提到 anthropic.ts 含"请求体解析助手",实测请求端解析与映射交织、共享价值低,故请求解析内联在 `openai/request.ts`;`anthropic.ts` 专注响应输出端(真正跨 format 共享的部分)。

---

## Task 1:sse.ts —— SSE 解析与事件序列化

**Files:** Create `src/translate/sse.ts`, `src/translate/sse.test.ts`;Modify `package.json`

- [ ] **Step 1:让 test 脚本递归匹配子目录**

把 `package.json` 的 test 脚本改为(给 glob 加引号,交由 Node test runner 自己递归展开 `**`):

```json
    "test": "tsc -p ./ && node --test \"out/**/*.test.js\"",
```

- [ ] **Step 2:写失败测试**

创建 `src/translate/sse.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, sseEvent } from './sse';

test('SSEParser 提取 data 负载、忽略 event 行与空行', () => {
  const p = new SSEParser();
  const out = p.push('event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('SSEParser 跨 chunk 半行缓冲', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: {"x":'), []);
  assert.deepEqual(p.push('1}\n\n'), ['{"x":1}']);
});

test('SSEParser 识别 [DONE] 并处理 CRLF', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: [DONE]\r\n\r\n'), ['[DONE]']);
});

test('sseEvent 序列化为 event/data 两行加空行', () => {
  assert.equal(sseEvent('message_stop', { type: 'message_stop' }),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});
```

- [ ] **Step 3:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./sse`。

- [ ] **Step 4:实现 sse.ts**

创建 `src/translate/sse.ts`:

```ts
/** 解析上游 SSE 字节流:按行提取 `data:` 负载(去前缀);`[DONE]` 原样产出。其余行忽略。 */
export class SSEParser {
  private buf = '';

  /** 喂入一段文本,返回本段解析出的完整 data 负载(可能为空) */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) {
        out.push(trimmed.slice(5).trim());
      }
    }
    return out;
  }
}

/** 序列化为一个 Anthropic SSE 事件文本块 */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

- [ ] **Step 5:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 6:提交**

```bash
git add package.json src/translate/sse.ts src/translate/sse.test.ts
git commit -m "feat: SSE 解析与 Anthropic 事件序列化"
```

---

## Task 2:anthropic.ts —— Anthropic 输出端共享层

**Files:** Create `src/translate/anthropic.ts`, `src/translate/anthropic.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/translate/anthropic.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageStart, contentBlockStart, contentBlockDelta, contentBlockStop,
  messageDelta, messageStop, mapStopReason, extractUsage,
} from './anthropic';

test('messageStart 含 id/model 与初始 message 结构', () => {
  const s = messageStart('msg_1', 'gpt-5');
  assert.match(s, /^event: message_start\n/);
  const data = JSON.parse(s.split('data: ')[1]);
  assert.equal(data.type, 'message_start');
  assert.equal(data.message.id, 'msg_1');
  assert.equal(data.message.model, 'gpt-5');
  assert.equal(data.message.role, 'assistant');
});

test('content_block_start/delta/stop 带 index 与负载', () => {
  assert.match(contentBlockStart(0, { type: 'text', text: '' }), /content_block_start/);
  const d = JSON.parse(contentBlockDelta(1, { type: 'text_delta', text: 'hi' }).split('data: ')[1]);
  assert.equal(d.index, 1);
  assert.equal(d.delta.text, 'hi');
  const s = JSON.parse(contentBlockStop(2).split('data: ')[1]);
  assert.equal(s.type, 'content_block_stop');
  assert.equal(s.index, 2);
});

test('messageDelta 带 stop_reason 与 usage;messageStop', () => {
  const d = JSON.parse(messageDelta('end_turn', { input_tokens: 3, output_tokens: 5 }).split('data: ')[1]);
  assert.equal(d.delta.stop_reason, 'end_turn');
  assert.equal(d.usage.output_tokens, 5);
  assert.match(messageStop(), /message_stop/);
});

test('mapStopReason 映射', () => {
  assert.equal(mapStopReason('stop'), 'end_turn');
  assert.equal(mapStopReason('length'), 'max_tokens');
  assert.equal(mapStopReason('tool_calls'), 'tool_use');
  assert.equal(mapStopReason('content_filter'), 'end_turn');
  assert.equal(mapStopReason('whatever'), 'end_turn');
});

test('extractUsage 映射 token 并扣减 cached', () => {
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 4 }),
    { input_tokens: 10, output_tokens: 4 });
  assert.deepEqual(extractUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } }),
    { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 3 });
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./anthropic`。

- [ ] **Step 3:实现 anthropic.ts**

创建 `src/translate/anthropic.ts`:

```ts
import { sseEvent } from './sse';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

/** 流首事件:声明一条 assistant 消息 */
export function messageStart(id: string, model: string): string {
  return sseEvent('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

/** 开一个 content block(block 形如 {type:'text',text:''} / {type:'thinking',...} / {type:'tool_use',...}) */
export function contentBlockStart(index: number, block: unknown): string {
  return sseEvent('content_block_start', { type: 'content_block_start', index, content_block: block });
}

/** content block 增量(delta 形如 {type:'text_delta',text} / {type:'thinking_delta',thinking} / {type:'input_json_delta',partial_json}) */
export function contentBlockDelta(index: number, delta: unknown): string {
  return sseEvent('content_block_delta', { type: 'content_block_delta', index, delta });
}

export function contentBlockStop(index: number): string {
  return sseEvent('content_block_stop', { type: 'content_block_stop', index });
}

export function messageDelta(stopReason: string, usage: AnthropicUsage): string {
  return sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  });
}

export function messageStop(): string {
  return sseEvent('message_stop', { type: 'message_stop' });
}

/** OpenAI finish_reason → Anthropic stop_reason */
export function mapStopReason(openAIReason: string): string {
  switch (openAIReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

/** OpenAI usage → Anthropic usage(cached 从 input 中扣减,>0 时附带 cache_read_input_tokens) */
export function extractUsage(usage: any): AnthropicUsage {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0 };
  }
  let input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  if (cached > 0) {
    input = input >= cached ? input - cached : 0;
    return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached };
  }
  return { input_tokens: input, output_tokens: output };
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/translate/anthropic.ts src/translate/anthropic.test.ts
git commit -m "feat: Anthropic SSE 事件构造共享层"
```

---

## Task 3:openai/request.ts —— Anthropic 请求 → OpenAI

**Files:** Create `src/translate/openai/request.ts`, `src/translate/openai/request.test.ts`

> 移植自 [openai_claude_request.go](../../CLIProxyAPI/internal/translator/openai/claude/openai_claude_request.go)。简化:不做 Claude Code attribution 文本过滤、不做 thinking signature 校验、tool_result 中的图片降级为文本拼接。

- [ ] **Step 1:写失败测试**

创建 `src/translate/openai/request.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIRequest } from './request';

test('基础:model/参数/纯文本 messages/stream', () => {
  const out = buildOpenAIRequest({
    max_tokens: 100, temperature: 0.5, stop_sequences: ['X'],
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5');
  assert.equal(out.model, 'gpt-5');
  assert.equal(out.max_tokens, 100);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.stop, 'X');
  assert.equal(out.stream, true);
  assert.deepEqual(out.messages, [{ role: 'user', content: 'hi' }]);
});

test('system(string)置于首条 system 消息', () => {
  const out = buildOpenAIRequest({ system: 'be brief', messages: [] }, 'm');
  assert.deepEqual(out.messages[0], { role: 'system', content: [{ type: 'text', text: 'be brief' }] });
});

test('图片块 → image_url(data URI)', () => {
  const out = buildOpenAIRequest({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ] }],
  }, 'm');
  assert.deepEqual(out.messages[0].content, [
    { type: 'text', text: 'see' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
});

test('tools 声明 → functions;tool_choice 映射', () => {
  const out = buildOpenAIRequest({
    messages: [],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    tool_choice: { type: 'any' },
  }, 'm');
  assert.deepEqual(out.tools[0], { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object' } } });
  assert.equal(out.tool_choice, 'required');
});

test('assistant tool_use → tool_calls;user tool_result → tool 消息(先于内容)', () => {
  const out = buildOpenAIRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ],
  }, 'm');
  assert.deepEqual(out.messages[0], {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
  });
  assert.deepEqual(out.messages[1], { role: 'tool', tool_call_id: 'call_1', content: 'ok' });
});

test('assistant thinking → reasoning_content;thinking.budget → reasoning_effort', () => {
  const out = buildOpenAIRequest({
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer' },
    ] }],
  }, 'm');
  assert.equal(out.reasoning_effort, 'medium');
  assert.equal(out.messages[0].reasoning_content, 'hmm');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'answer' }]);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./request`。

- [ ] **Step 3:实现 request.ts**

创建 `src/translate/openai/request.ts`:

```ts
/** Anthropic Messages 请求 → OpenAI Chat Completions 请求(仅流式,固定 stream:true) */
export function buildOpenAIRequest(body: any, model: string): any {
  const out: any = { model, messages: [], stream: true };

  if (typeof body.max_tokens === 'number') {
    out.max_tokens = body.max_tokens;
  }
  if (typeof body.temperature === 'number') {
    out.temperature = body.temperature;
  } else if (typeof body.top_p === 'number') {
    out.top_p = body.top_p;
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences.length === 1 ? body.stop_sequences[0] : body.stop_sequences;
  }

  const effort = thinkingToEffort(body.thinking, body.output_config);
  if (effort) {
    out.reasoning_effort = effort;
  }

  const system = collectSystem(body);
  if (system.length > 0) {
    out.messages.push({ role: 'system', content: system });
  }
  for (const msg of body.messages ?? []) {
    if (msg?.role === 'system') {
      continue;
    }
    appendMessage(out.messages, msg);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} },
    }));
  }
  if (body.tool_choice) {
    out.tool_choice = mapToolChoice(body.tool_choice);
  }
  return out;
}

/** thinking 配置 → OpenAI reasoning_effort(budget 近似映射;disabled 不发) */
function thinkingToEffort(thinking: any, outputConfig: any): string | undefined {
  if (!thinking || typeof thinking !== 'object') {
    return undefined;
  }
  switch (thinking.type) {
    case 'enabled':
      return budgetToLevel(typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : -1);
    case 'adaptive':
    case 'auto': {
      const e = outputConfig?.effort;
      return typeof e === 'string' && e.trim() ? e.trim().toLowerCase() : 'high';
    }
    case 'disabled':
      return undefined;
    default:
      return undefined;
  }
}

function budgetToLevel(budget: number): string | undefined {
  if (budget === 0) {
    return undefined;
  }
  if (budget < 0) {
    return 'medium';
  }
  if (budget <= 4096) {
    return 'low';
  }
  if (budget <= 16384) {
    return 'medium';
  }
  return 'high';
}

/** 收集 system:顶层 system 字段 + role==system 的消息 */
function collectSystem(body: any): any[] {
  const content: any[] = [];
  const append = (s: any) => {
    if (typeof s === 'string') {
      if (s.trim()) {
        content.push({ type: 'text', text: s });
      }
    } else if (Array.isArray(s)) {
      for (const item of s) {
        const part = convertContentPart(item);
        if (part) {
          content.push(part);
        }
      }
    }
  };
  if (body.system != null) {
    append(body.system);
  }
  for (const m of body.messages ?? []) {
    if (m?.role === 'system') {
      append(m.content);
    }
  }
  return content;
}

/** 追加一条 Anthropic 消息到 OpenAI messages(处理 text/image/tool_use/tool_result/thinking) */
function appendMessage(messages: any[], msg: any): void {
  const role = msg?.role;
  const content = msg?.content;

  if (typeof content === 'string') {
    messages.push({ role, content });
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }

  const contentItems: any[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];

  for (const part of content) {
    switch (part?.type) {
      case 'thinking':
        if (role === 'assistant') {
          const t = typeof part.thinking === 'string' ? part.thinking : '';
          if (t.trim()) {
            reasoningParts.push(t);
          }
        }
        break;
      case 'redacted_thinking':
        break;
      case 'text':
      case 'image': {
        const cp = convertContentPart(part);
        if (cp) {
          contentItems.push(cp);
        }
        break;
      }
      case 'tool_use':
        if (role === 'assistant') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
          });
        }
        break;
      case 'tool_result':
        toolResults.push({ role: 'tool', tool_call_id: part.tool_use_id, content: toolResultText(part.content) });
        break;
    }
  }

  // tool_result 必须紧跟带 tool_calls 的 assistant 消息,故先发
  for (const tr of toolResults) {
    messages.push(tr);
  }

  if (role === 'assistant') {
    if (contentItems.length > 0 || reasoningParts.length > 0 || toolCalls.length > 0) {
      const m: any = { role: 'assistant', content: contentItems.length > 0 ? contentItems : '' };
      if (reasoningParts.length > 0) {
        m.reasoning_content = reasoningParts.join('\n\n');
      }
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls;
      }
      messages.push(m);
    }
  } else if (contentItems.length > 0) {
    messages.push({ role, content: contentItems });
  }
}

/** text / image 内容块 → OpenAI 内容项;不可转换返回 null */
function convertContentPart(part: any): any | null {
  if (part?.type === 'text') {
    const text = typeof part.text === 'string' ? part.text : '';
    if (!text.trim()) {
      return null;
    }
    return { type: 'text', text };
  }
  if (part?.type === 'image') {
    let url = '';
    const src = part.source;
    if (src?.type === 'base64') {
      const mt = src.media_type || 'application/octet-stream';
      if (src.data) {
        url = `data:${mt};base64,${src.data}`;
      }
    } else if (src?.type === 'url') {
      url = src.url ?? '';
    }
    if (!url) {
      url = part.url ?? '';
    }
    if (!url) {
      return null;
    }
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

/** tool_result 内容 → OpenAI tool 消息的字符串内容(图片降级:忽略,仅拼接文本) */
function toolResultText(content: any): string {
  if (content == null) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (typeof item?.text === 'string') {
        parts.push(item.text);
      }
    }
    return parts.join('\n\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return JSON.stringify(content);
}

function mapToolChoice(tc: any): any {
  switch (tc?.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'tool': return { type: 'function', function: { name: tc.name } };
    default: return 'auto';
  }
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/translate/openai/request.ts src/translate/openai/request.test.ts
git commit -m "feat: Anthropic 请求 → OpenAI Chat Completions"
```

---

## Task 4:openai/response.ts —— OpenAI SSE → Anthropic SSE 状态机

**Files:** Create `src/translate/openai/response.ts`, `src/translate/openai/response.test.ts`

> 移植自 [openai_claude_response.go](../../CLIProxyAPI/internal/translator/openai/claude/openai_claude_response.go) 的流式分支。简化:不做工具名映射、tool id 直接透传(空则合成 `toolu_*`)、arguments 直接作为 partial_json(省略 FixJSON)。仅实现流式(不实现非流式响应)。

- [ ] **Step 1:写失败测试**

创建 `src/translate/openai/response.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIToClaudeStream } from './response';

/** 把一串 OpenAI data 负载喂给转换器,收集所有 Anthropic 事件名 */
function run(payloads: string[]): { events: string[]; raw: string[] } {
  const s = new OpenAIToClaudeStream();
  const raw: string[] = [];
  for (const p of payloads) {
    raw.push(...s.push(p));
  }
  const events = raw.map(e => e.slice('event: '.length, e.indexOf('\n')));
  return { events, raw };
}

function dataOf(raw: string): any {
  return JSON.parse(raw.split('data: ')[1]);
}

test('纯文本流:message_start → block_start/delta → 收尾', () => {
  const { events, raw } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"content":"Hel"}}]}',
    '{"choices":[{"delta":{"content":"lo"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
    '[DONE]',
  ]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const delta = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.equal(delta.usage.output_tokens, 1);
});

test('工具调用流:累加 arguments 后在 finish 时出 tool_use + input_json_delta', () => {
  const { events, raw } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Bash","arguments":"{\\"cmd\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '{"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
    '[DONE]',
  ]);
  assert.ok(events.includes('content_block_start'));
  const startRaw = raw.find(r => r.includes('"tool_use"'))!;
  assert.equal(dataOf(startRaw).content_block.name, 'Bash');
  assert.equal(dataOf(startRaw).content_block.id, 'call_1');
  const inputRaw = raw.find(r => r.includes('input_json_delta'))!;
  assert.equal(dataOf(inputRaw).delta.partial_json, '{"cmd":"ls"}');
  const delta = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(delta.delta.stop_reason, 'tool_use');
});

test('reasoning 流:出 thinking block 并在文本前关闭', () => {
  const { events } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"reasoning_content":"think"}}]}',
    '{"choices":[{"delta":{"content":"ans"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ]);
  // thinking block 开→delta→(文本到来时)stop→文本 block 开→delta
  assert.deepEqual(events.slice(0, 6), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta',
  ]);
});

test('无 usage 时 [DONE] 兜底出 message_delta + message_stop', () => {
  const { events } = run([
    '{"id":"m1","model":"gpt-5","choices":[{"delta":{"content":"hi"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ]);
  assert.equal(events.filter(e => e === 'message_delta').length, 1);
  assert.equal(events[events.length - 1], 'message_stop');
});

test('非法 JSON 负载被忽略', () => {
  const s = new OpenAIToClaudeStream();
  assert.deepEqual(s.push('not json'), []);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./response`。

- [ ] **Step 3:实现 response.ts**

创建 `src/translate/openai/response.ts`:

```ts
import * as A from '../anthropic';

interface ToolAcc {
  id: string;
  name: string;
  args: string;
  startEmitted: boolean;
}

/** OpenAI Chat Completions 流式响应 → Anthropic SSE 事件。每喂一个 data 负载,返回应写回客户端的 SSE 文本数组。 */
export class OpenAIToClaudeStream {
  private messageId = '';
  private model = '';
  private messageStarted = false;
  private textStarted = false;
  private thinkingStarted = false;
  private textIndex = -1;
  private thinkingIndex = -1;
  private nextIndex = 0;
  private tools = new Map<number, ToolAcc>();
  private toolBlockIndexes = new Map<number, number>();
  private finishReason = '';
  private blocksStopped = false;
  private messageDeltaSent = false;
  private messageStopSent = false;
  private sawToolCall = false;

  /** 喂一个 data 负载(已去 "data:" 前缀);`[DONE]` 触发收尾 */
  push(payload: string): string[] {
    if (payload === '[DONE]') {
      return this.done();
    }
    let root: any;
    try {
      root = JSON.parse(payload);
    } catch {
      return [];
    }
    return this.handleChunk(root);
  }

  private handleChunk(root: any): string[] {
    const out: string[] = [];
    if (!this.messageId) {
      this.messageId = root.id ?? '';
    }
    if (!this.model) {
      this.model = root.model ?? '';
    }

    const delta = root.choices?.[0]?.delta;
    if (delta) {
      if (!this.messageStarted) {
        out.push(A.messageStart(this.messageId, this.model));
        this.messageStarted = true;
      }

      // reasoning → thinking block
      for (const text of collectReasoning(delta.reasoning_content)) {
        if (!text) {
          continue;
        }
        this.stopText(out);
        if (!this.thinkingStarted) {
          if (this.thinkingIndex === -1) {
            this.thinkingIndex = this.nextIndex++;
          }
          out.push(A.contentBlockStart(this.thinkingIndex, { type: 'thinking', thinking: '' }));
          this.thinkingStarted = true;
        }
        out.push(A.contentBlockDelta(this.thinkingIndex, { type: 'thinking_delta', thinking: text }));
      }

      // text → text block
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!this.textStarted) {
          this.stopThinking(out);
          if (this.textIndex === -1) {
            this.textIndex = this.nextIndex++;
          }
          out.push(A.contentBlockStart(this.textIndex, { type: 'text', text: '' }));
          this.textStarted = true;
        }
        out.push(A.contentBlockDelta(this.textIndex, { type: 'text_delta', text: delta.content }));
      }

      // tool_calls 累加
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          let acc = this.tools.get(index);
          if (!acc) {
            acc = { id: '', name: '', args: '', startEmitted: false };
            this.tools.set(index, acc);
          }
          if (typeof tc.id === 'string' && tc.id) {
            acc.id = tc.id;
          }
          if (tc.function) {
            if (!acc.startEmitted && typeof tc.function.name === 'string' && tc.function.name) {
              acc.name = tc.function.name;
            }
            if (typeof tc.function.arguments === 'string' && tc.function.arguments) {
              acc.args += tc.function.arguments;
            }
          }
          if (!acc.startEmitted && acc.name && acc.id && !this.blocksStopped) {
            this.emitToolStart(index, acc, out);
          }
        }
      }
    }

    const fr = root.choices?.[0]?.finish_reason;
    if (typeof fr === 'string' && fr) {
      this.finishReason = this.sawToolCall ? 'tool_calls' : (fr === 'tool_calls' ? 'stop' : fr);
      this.stopThinking(out);
      this.stopText(out);
      this.flushTools(out);
    }

    if (this.finishReason && root.usage != null) {
      out.push(A.messageDelta(A.mapStopReason(this.effectiveFinish()), A.extractUsage(root.usage)));
      this.messageDeltaSent = true;
      this.emitStop(out);
    }
    return out;
  }

  private done(): string[] {
    const out: string[] = [];
    this.stopThinking(out);
    this.stopText(out);
    this.flushTools(out);
    if (this.finishReason && !this.messageDeltaSent) {
      out.push(A.messageDelta(A.mapStopReason(this.effectiveFinish()), { input_tokens: 0, output_tokens: 0 }));
      this.messageDeltaSent = true;
    }
    this.emitStop(out);
    return out;
  }

  /** 关闭所有 tool_use block:补发累加的 input_json_delta 再 stop */
  private flushTools(out: string[]): void {
    if (this.blocksStopped) {
      return;
    }
    for (const index of [...this.tools.keys()].sort((a, b) => a - b)) {
      const acc = this.tools.get(index)!;
      if (!acc.startEmitted) {
        if (!acc.name) {
          continue;
        }
        this.emitToolStart(index, acc, out);
      }
      const bi = this.toolBlockIndexes.get(index)!;
      if (acc.args) {
        out.push(A.contentBlockDelta(bi, { type: 'input_json_delta', partial_json: acc.args }));
      }
      out.push(A.contentBlockStop(bi));
    }
    this.blocksStopped = true;
  }

  private emitToolStart(index: number, acc: ToolAcc, out: string[]): void {
    this.stopThinking(out);
    this.stopText(out);
    let bi = this.toolBlockIndexes.get(index);
    if (bi === undefined) {
      bi = this.nextIndex++;
      this.toolBlockIndexes.set(index, bi);
    }
    out.push(A.contentBlockStart(bi, { type: 'tool_use', id: acc.id || synthToolId(), name: acc.name, input: {} }));
    acc.startEmitted = true;
    this.sawToolCall = true;
  }

  private stopText(out: string[]): void {
    if (!this.textStarted) {
      return;
    }
    out.push(A.contentBlockStop(this.textIndex));
    this.textStarted = false;
    this.textIndex = -1;
  }

  private stopThinking(out: string[]): void {
    if (!this.thinkingStarted) {
      return;
    }
    out.push(A.contentBlockStop(this.thinkingIndex));
    this.thinkingStarted = false;
    this.thinkingIndex = -1;
  }

  private emitStop(out: string[]): void {
    if (this.messageStopSent) {
      return;
    }
    out.push(A.messageStop());
    this.messageStopSent = true;
  }

  private effectiveFinish(): string {
    return this.sawToolCall ? 'tool_calls' : this.finishReason;
  }
}

/** reasoning_content 可能是 string / 数组 / {text} 对象,递归收集文本 */
function collectReasoning(node: any): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return node ? [node] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectReasoning);
  }
  if (typeof node === 'object' && typeof node.text === 'string' && node.text) {
    return [node.text];
  }
  return [];
}

function synthToolId(): string {
  return `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/translate/openai/response.ts src/translate/openai/response.test.ts
git commit -m "feat: OpenAI SSE → Anthropic SSE 流式状态机"
```

---

## Task 5:registry.ts —— format 分发

**Files:** Create `src/translate/registry.ts`, `src/translate/registry.test.ts`

- [ ] **Step 1:写失败测试**

创建 `src/translate/registry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTranslator } from './registry';

test('openai format 返回转换器,端点与认证正确', () => {
  const t = getTranslator('openai')!;
  assert.equal(t.endpointPath, '/v1/chat/completions');
  assert.deepEqual(t.authHeader('sk-1'), { Authorization: 'Bearer sk-1' });
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5');
  assert.equal(req.model, 'gpt-5');
  assert.equal(req.stream, true);
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});

test('gemini/codex 尚未实现返回 null', () => {
  assert.equal(getTranslator('gemini'), null);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./registry`。

- [ ] **Step 3:实现 registry.ts**

创建 `src/translate/registry.ts`:

```ts
import { ProviderFormat } from '../presets';
import { buildOpenAIRequest } from './openai/request';
import { OpenAIToClaudeStream } from './openai/response';

/** 一个流式转换器:把 data 负载逐个转为 Anthropic SSE 文本 */
export interface StreamTranslator {
  push(payload: string): string[];
}

/** 某 from→Anthropic 方向的完整转换器,proxy 据此转发而不关心具体格式 */
export interface Translator {
  /** Anthropic 请求体 → 上游请求体 */
  buildRequest(claudeBody: any, model: string): any;
  /** 新建一个有状态的响应流转换器 */
  createStreamTranslator(): StreamTranslator;
  /** 上游端点路径(拼到 baseUrl 后) */
  endpointPath: string;
  /** 上游认证头 */
  authHeader(key: string): Record<string, string>;
}

const OPENAI_TRANSLATOR: Translator = {
  buildRequest: buildOpenAIRequest,
  createStreamTranslator: () => new OpenAIToClaudeStream(),
  endpointPath: '/v1/chat/completions',
  authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
};

/** 按 provider 格式返回转换器;gemini(Part 2b)/codex(Part 3)暂返回 null */
export function getTranslator(format: ProviderFormat): Translator | null {
  if (format === 'openai') {
    return OPENAI_TRANSLATOR;
  }
  return null;
}
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/translate/registry.ts src/translate/registry.test.ts
git commit -m "feat: 转换器 registry 分发"
```

---

## Task 6:presets + proxy 接入 + 错误格式

**Files:** Modify `src/presets.ts`, `src/proxy.ts`

> I/O 胶水,以编译 + Task 7 手动冒烟验证。纯转换逻辑已在 Task 1-5 测过。

- [ ] **Step 1:presets 开启 openai 系转发**

在 `src/presets.ts` 中把 openai / openrouter / nvidia 三行的 `forwardable: false` 改为 `forwardable: true`(gemini 保持 false)。改完三行形如:

```ts
  { id: 'openai',     format: 'openai',    baseUrl: 'https://api.openai.com',                     modelsDevId: 'openai',     forwardable: true },
  { id: 'openrouter', format: 'openai',    baseUrl: 'https://openrouter.ai/api',                  modelsDevId: 'openrouter', forwardable: true },
  { id: 'nvidia',     format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com',           modelsDevId: 'nvidia',     forwardable: true },
```

- [ ] **Step 2:proxy.ts 顶部引入转换 registry + Anthropic 错误助手**

在 `src/proxy.ts` 现有 import 之后追加:

```ts
import { getTranslator } from './translate/registry';
```

并在文件内(`shouldRotate` 函数之后)新增一个 Anthropic 错误体助手:

```ts
/** 构造 Anthropic 标准错误响应体 */
function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}
```

- [ ] **Step 3:替换 forwardable 检查与转发逻辑**

当前 `src/proxy.ts` 的请求处理中:(a) `if (target && !target.forwardable)` 返回非标准 502;(b) 之后统一按 anthropic 走 `${baseUrl}${req.url}` + `x-api-key` 转发并原样 pipe。改为按是否有 translator 分流。

把从 `// 非 anthropic 目标:Part 1 不支持转换` 起、到转发循环结束(`res.end(...)` 全部失败分支)为止的逻辑,调整为如下结构(保留外层 try/catch 与既有变量 `body`/`requestBody`/`cfg`/`target`):

```ts
        // 解析转换器:有 target 且该格式已支持转换则走转换转发;anthropic 格式无 translator,走原样转发
        const translator = target ? getTranslator(target.preset.format) : null;

        // 有 target 但格式尚不支持(如 gemini)→ Anthropic 标准错误
        if (target && !target.forwardable) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(anthropicError('invalid_request_error',
            `Provider "${target.preset.id}" (${target.preset.format}) 暂不支持,等待后续版本的格式转换。`));
          return;
        }

        // 计算转发 URL / body / 认证
        let targetUrl = `https://api.anthropic.com${req.url}`;
        let targetBody = body;
        let apiKeys: string[] = [];

        if (target) {
          apiKeys = target.apiKeys;
          if (translator) {
            // 格式转换路径(openai 系)
            targetUrl = `${target.preset.baseUrl}${translator.endpointPath}`;
            const openAIBody = translator.buildRequest(requestBody ?? {}, target.model);
            targetBody = Buffer.from(JSON.stringify(openAIBody), 'utf8');
          } else {
            // 原样转发路径(anthropic 系):仅换 baseUrl/model
            targetUrl = `${target.preset.baseUrl}${req.url}`;
            if (requestBody && target.model) {
              requestBody.model = target.model;
              targetBody = Buffer.from(JSON.stringify(requestBody), 'utf8');
            }
          }
        }

        // 转发头:剔除代理相关 + 原认证头(认证按 key 注入)
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
        if (translator) {
          baseHeaders['content-type'] = 'application/json';
        }

        const tryKeys = apiKeys.length > 0 ? apiKeys : [null];
        let lastErr: any = null;

        for (let i = 0; i < tryKeys.length; i++) {
          const key = tryKeys[i];
          const headers: Record<string, any> = { ...baseHeaders };
          if (key) {
            if (translator) {
              Object.assign(headers, translator.authHeader(key));
            } else {
              headers['x-api-key'] = key; // anthropic 格式
            }
          }
          try {
            const upstream = await fetch(targetUrl, { method: 'POST', headers: headers as any, body: targetBody });

            // 需轮换状态且还有下一个 key → 换 key 重试
            if (apiKeys.length > 0 && shouldRotate(upstream.status) && i < tryKeys.length - 1) {
              console.warn(`key #${i} failed (${upstream.status}), rotating`);
              await upstream.body?.cancel();
              continue;
            }

            // 上游错误:统一 Anthropic 错误格式返回
            if (upstream.status >= 400) {
              const errText = await upstream.text();
              res.writeHead(upstream.status, { 'content-type': 'application/json' });
              res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
              saveLog(deps.isJsonLogging(),
                { url: req.url, model: target?.model, mapping: cfg.mapping },
                { status: upstream.status });
              return;
            }

            if (translator) {
              // 格式转换:边收上游 SSE 边转 Anthropic SSE
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
              const parser = new (await import('./translate/sse')).SSEParser();
              const stream = translator.createStreamTranslator();
              const reader = upstream.body?.getReader();
              const decoder = new TextDecoder();
              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }
                  for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    for (const event of stream.push(payload)) {
                      if (!res.write(event)) {
                        await new Promise<void>(resolve => res.once('drain', resolve));
                      }
                    }
                  }
                }
              }
              res.end();
              saveLog(deps.isJsonLogging(),
                { url: req.url, model: target?.model, mapping: cfg.mapping },
                { status: upstream.status, translated: true });
              return;
            }

            // 原样转发响应头 + body(anthropic 路径,逻辑同 Part 1)
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
                if (!res.write(value)) {
                  await new Promise<void>(resolve => res.once('drain', resolve));
                }
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
              console.warn(`key #${i} network error, rotating`, err);
              continue;
            }
          }
        }

        // 全部失败
        console.error('proxy error:', lastErr);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(anthropicError('api_error', String(lastErr?.message ?? lastErr)));
        saveLog(deps.isJsonLogging(), { url: req.url, mapping: cfg.mapping }, null, String(lastErr));
```

> 说明:把顶部 `import { SSEParser } from './translate/sse'` 放到文件头更整洁;计划用动态 `await import` 仅为减少 diff,实现时可改为顶层静态 import。两种都可,实现者择一并保持编译通过。

- [ ] **Step 4:编译确认**

Run: `npm run compile`
Expected: 无 TS 错误。

- [ ] **Step 5:全量测试确认无回归**

Run: `npm test`
Expected: PASS(Part 1 + Part 2a 全部纯测试)。

- [ ] **Step 6:提交**

```bash
git add src/presets.ts src/proxy.ts
git commit -m "feat: proxy 接入 OpenAI 格式转换 + 统一 Anthropic 错误格式"
```

---

## Task 7:手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1:全量测试 + 编译**

Run: `npm test && npm run compile`
Expected: 全部 PASS,无 TS 错误。

- [ ] **Step 2:配置真实 key 冒烟**

F5 启动扩展开发宿主:
1. 状态栏 → ⚙ Provider 设置 → 给 openai(或 openrouter)添加真实 key。
2. 状态栏 → 选 openai 的某模型(如 gpt-5 系)。
3. 在 Claude Code 中发起一次普通对话。

Expected:正常返回文本回复(证明请求转换 + SSE 流式回译成功),状态栏显示该模型。

- [ ] **Step 3:工具调用冒烟**

在已选 openai 模型下,让 Claude Code 执行一个需要用工具的任务(如"列出当前目录文件")。

Expected:模型发起工具调用、Claude Code 执行并回传 tool_result、对话继续(证明 tool_use/tool_result 双向转换成功)。

- [ ] **Step 4:轮换与错误冒烟**

把 openai 的第一个 key 改为无效、再追加一个有效 key,重复对话。

Expected:仍能成功(证明 401/429/5xx 轮换);若全部 key 无效,Claude Code 收到 Anthropic 格式错误而非卡死。

- [ ] **Step 5:确认 gemini 占位**

临时把 mapping 指向 gemini 的某模型(需先配 key 才会出现在菜单)。

Expected:返回 Anthropic 标准错误"暂不支持",Claude Code 正常报错不卡死。

---

## Self-Review 记录

- **Spec 架构(translate 模块 + registry 分发 + 仅共享 Anthropic 端)**:Task 1(sse)+ Task 2(anthropic)+ Task 5(registry)+ Task 6(proxy 接入)。
- **Spec 请求映射(文本/system/图片/tools/tool_use/tool_result/thinking/参数)**:Task 3,逐项有测试。
- **Spec 响应状态机(message_start/block 开关/text/thinking/tool 累加/finish/usage/DONE 收尾)**:Task 4,逐路径有测试。
- **Spec 错误处理(上游错误 + 502 改 Anthropic 格式)**:Task 6 Step 2/3。
- **Spec 仅流式**:request 固定 stream:true(Task 3);response 仅实现流式状态机(Task 4);非流式不实现。
- **Spec 测试策略**:Task 1-5 node:test;proxy 接入走 Task 7 手动冒烟。
- **类型一致性**:`SSEParser`/`sseEvent`(sse.ts)、`messageStart`/`contentBlock*`/`messageDelta`/`messageStop`/`mapStopReason`/`extractUsage`(anthropic.ts)、`buildOpenAIRequest`(request.ts)、`OpenAIToClaudeStream`(response.ts)、`Translator`/`StreamTranslator`/`getTranslator`(registry.ts)跨 Task 引用一致。
- **占位符扫描**:无 TBD/TODO;胶水代码以手动冒烟覆盖,均给出完整代码。

## 范围外

- gemini 格式转换(Part 2b)、codex(Part 3,依赖 OAuth)。
- 非流式响应路径、prompt caching、thinking 签名校验、工具名 sanitize/映射。
