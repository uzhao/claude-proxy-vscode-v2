# Part 2c:Anthropic ↔ OpenAI Responses API 格式转换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 openai 官方从 chat completions 切到 OpenAI Responses API(`/v1/responses`),实现 Anthropic Messages ↔ Responses 的流式转换(文本/工具/图片/thinking);并移除已放弃的 gemini provider。

**Architecture:** 新增 `src/translate/responses/` 子模块(request/response),复用 `anthropic.ts`(输出端)+`sse.ts`。`Preset` 加 `api` 字段区分 chat/responses,`getTranslator` 改为按 preset 分发;openrouter/nvidia 仍用 Part 2a 的 chat completions。映射移植自 CLIProxyAPI `codex/claude`,剥离 codex/ChatGPT 专属部分(留 Part 3)。

**Tech Stack:** TypeScript(commonjs/ES2020/strict)、Node 内置 `node:test`、全局 `fetch`。

---

## 文件结构

```
src/translate/
  responses/
    request.ts       —— buildResponsesRequest:Anthropic 请求 → Responses {model, input:[...]}(纯函数)
    response.ts      —— ResponsesToClaudeStream:Responses SSE 事件 → Anthropic SSE(有状态)
    request.test.ts / response.test.ts
  registry.ts        —— 改:getTranslator 按 preset.api 分发(chat / responses)
  openai/            —— Part 2a chat completions(openrouter/nvidia 继续用,不动)
  anthropic.ts / sse.ts —— 复用,不动
```
改动:`src/presets.ts`(移除 gemini、加 `api` 字段、openai 设 responses)、`src/proxy.ts`(getTranslator 调用点)、`src/presets.test.ts` / `src/proxy.test.ts` / `src/translate/registry.test.ts`(断言更新)。

---

## Task 1:移除 gemini provider

**Files:** Modify `src/presets.ts`, `src/presets.test.ts`, `src/proxy.test.ts`

- [ ] **Step 1:改测试以反映 gemini 移除**

`src/presets.test.ts`:把第一个用例里的 ids 数组去掉 `'gemini'`,数量描述改为 7;把 openai 系可转发用例里的 gemini 断言删掉;把 `preset 映射` 用例里的 gemini 断言换成 deepseek。即:

将 `test('包含 8 个可配置 preset,且不含 codex 占位', ...)` 整体替换为:
```ts
test('包含 7 个可配置 preset,且不含 codex 占位', () => {
  const ids = PRESETS.map(p => p.id);
  assert.deepEqual(ids, ['openai', 'openrouter', 'nvidia', 'glm', 'kimi', 'deepseek', 'minimax']);
  assert.equal(ids.includes(CODEX_PLACEHOLDER_ID), false);
});
```

将 `test('openai 系 Part 2a 起可转发,gemini 仍不可转发', ...)` 整体替换为:
```ts
test('openai 系可转发', () => {
  for (const id of ['openai', 'openrouter', 'nvidia']) {
    assert.equal(getPreset(id)!.forwardable, true);
  }
});
```

将 `preset 映射到正确的 models.dev id` 用例中的这一行:
```ts
  assert.equal(getPreset('gemini')!.modelsDevId, 'google');
```
替换为:
```ts
  assert.equal(getPreset('deepseek')!.modelsDevId, 'deepseek');
```

`src/proxy.test.ts`:把 `test('openai 格式 Part 2a 起可转发;gemini 仍不可转发', ...)` 整体替换为:
```ts
test('openai 格式可转发;未知 provider 返回 null', () => {
  assert.equal(resolveTarget({ mapping: 'openai:gpt-4o', providers: [{ name: 'openai', apiKeys: ['k'] }] })!.forwardable, true);
  assert.equal(resolveTarget({ mapping: 'gemini:x', providers: [{ name: 'gemini', apiKeys: ['k'] }] }), null);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— presets 仍含 gemini(数量 8、ids 含 gemini)。

- [ ] **Step 3:改 presets.ts**

在 `src/presets.ts` 中:
- 把 `ProviderFormat` 类型由 `'anthropic' | 'openai' | 'gemini'` 改为 `'anthropic' | 'openai'`。
- 删除 PRESETS 数组里 gemini 那一行:
```ts
  { id: 'gemini',     format: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com',  modelsDevId: 'google',     forwardable: false },
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

> 注:`src/translate/registry.ts` 的 `getTranslator(format)` 当前对非 openai 返回 null,移除 'gemini' 类型后其 `if (format === 'openai')` 不受影响,仍编译通过(Task 4 才改它的签名)。

- [ ] **Step 5:提交**

```bash
git add src/presets.ts src/presets.test.ts src/proxy.test.ts
git commit -m "chore: 移除已放弃的 gemini provider"
```

---

## Task 2:responses/request.ts —— Anthropic 请求 → Responses

**Files:** Create `src/translate/responses/request.ts`, `src/translate/responses/request.test.ts`

> 移植自 [codex_claude_request.go](../../CLIProxyAPI/internal/translator/codex/claude/codex_claude_request.go),剥离 codex 专属(instructions/store/encrypted reasoning/web_search/工具名缩短/call_id 缩短)。

- [ ] **Step 1:写失败测试**

创建 `src/translate/responses/request.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponsesRequest } from './request';

test('基础:model/参数/input/stream', () => {
  const out = buildResponsesRequest({
    max_tokens: 100, temperature: 0.5,
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-5');
  assert.equal(out.model, 'gpt-5');
  assert.equal(out.max_output_tokens, 100);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.stream, true);
  assert.deepEqual(out.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
});

test('system → developer message', () => {
  const out = buildResponsesRequest({ system: 'be brief', messages: [] }, 'm');
  assert.deepEqual(out.input[0], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] });
});

test('assistant 文本用 output_text;图片用 input_image', () => {
  const out = buildResponsesRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
    ],
  }, 'm');
  assert.deepEqual(out.input[0].content, [{ type: 'output_text', text: 'ok' }]);
  assert.deepEqual(out.input[1].content, [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }]);
});

test('tool_use → function_call;tool_result → function_call_output', () => {
  const out = buildResponsesRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
    ],
  }, 'm');
  assert.deepEqual(out.input[0], { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' });
  assert.deepEqual(out.input[1], { type: 'function_call_output', call_id: 'call_1', output: 'ok' });
});

test('tools → function 定义(删 $schema);tool_choice;thinking → reasoning.effort', () => {
  const out = buildResponsesRequest({
    thinking: { type: 'enabled', budget_tokens: 10000 },
    messages: [],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', $schema: 'x' } }],
    tool_choice: { type: 'any' },
  }, 'm');
  assert.deepEqual(out.tools[0], { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' } });
  assert.equal(out.tool_choice, 'required');
  assert.deepEqual(out.reasoning, { effort: 'medium', summary: 'auto' });
});

test('assistant thinking 块被忽略(不发 reasoning item)', () => {
  const out = buildResponsesRequest({
    messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'secret' },
      { type: 'text', text: 'answer' },
    ] }],
  }, 'm');
  assert.equal(out.input.length, 1);
  assert.deepEqual(out.input[0].content, [{ type: 'output_text', text: 'answer' }]);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./request`。

- [ ] **Step 3:实现 request.ts**

创建 `src/translate/responses/request.ts`:

```ts
/** Anthropic Messages 请求 → OpenAI Responses 请求(仅流式)。剥离 codex 专属(instructions/store/encrypted reasoning/web_search/名称缩短)。 */
export function buildResponsesRequest(body: any, model: string): any {
  const out: any = { model, input: [], stream: true };

  if (typeof body.max_tokens === 'number') {
    out.max_output_tokens = body.max_tokens;
  }
  if (typeof body.temperature === 'number') {
    out.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    out.top_p = body.top_p;
  }

  // system → developer message
  const sysText = collectSystemText(body);
  if (sysText.length > 0) {
    out.input.push({ type: 'message', role: 'developer', content: sysText.map(t => ({ type: 'input_text', text: t })) });
  }

  for (const msg of body.messages ?? []) {
    appendItems(out.input, msg);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: cleanSchema(t.input_schema),
    }));
  }
  if (body.tool_choice) {
    out.tool_choice = mapToolChoice(body.tool_choice);
  }
  out.parallel_tool_calls = body.tool_choice?.disable_parallel_tool_use ? false : true;

  const effort = thinkingToEffort(body.thinking, body.output_config);
  if (effort) {
    out.reasoning = { effort, summary: 'auto' };
  }

  return out;
}

/** 收集 system 文本(顶层 system 字段 + role==system 的消息),返回文本数组 */
function collectSystemText(body: any): string[] {
  const texts: string[] = [];
  const add = (s: any) => {
    if (typeof s === 'string') {
      if (s.trim()) {
        texts.push(s);
      }
    } else if (Array.isArray(s)) {
      for (const item of s) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          texts.push(item.text);
        }
      }
    }
  };
  if (body.system != null) {
    add(body.system);
  }
  for (const m of body.messages ?? []) {
    if (m?.role === 'system') {
      add(m.content);
    }
  }
  return texts;
}

/** 把一条 Anthropic 消息追加为 Responses input items(message / function_call / function_call_output) */
function appendItems(input: any[], msg: any): void {
  const role = msg?.role === 'system' ? 'developer' : msg?.role;
  const content = msg?.content;
  const textType = role === 'assistant' ? 'output_text' : 'input_text';

  if (typeof content === 'string') {
    if (content) {
      input.push({ type: 'message', role, content: [{ type: textType, text: content }] });
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }

  let parts: any[] = [];
  const flush = () => {
    if (parts.length > 0) {
      input.push({ type: 'message', role, content: parts });
      parts = [];
    }
  };

  for (const part of content) {
    switch (part?.type) {
      case 'text':
        if (typeof part.text === 'string' && part.text) {
          parts.push({ type: textType, text: part.text });
        }
        break;
      case 'image': {
        const url = imageDataUrl(part);
        if (url) {
          parts.push({ type: 'input_image', image_url: url });
        }
        break;
      }
      case 'tool_use':
        flush();
        input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
        break;
      case 'tool_result':
        flush();
        input.push({ type: 'function_call_output', call_id: part.tool_use_id, output: toolResultOutput(part.content) });
        break;
      // thinking / redacted_thinking:忽略(codex 的 encrypted reasoning 留 Part 3)
    }
  }
  flush();
}

function imageDataUrl(part: any): string {
  const src = part?.source;
  if (src?.type === 'base64' && src.data) {
    const mt = src.media_type || 'application/octet-stream';
    return `data:${mt};base64,${src.data}`;
  }
  if (src?.type === 'url' && src.url) {
    return src.url;
  }
  return '';
}

/** function_call_output 的 output:拼接文本(图片降级忽略) */
function toolResultOutput(content: any): string {
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

/** 删除 Responses 不接受的顶层 schema 字段($schema) */
function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema ?? {};
  }
  const { $schema, ...rest } = schema;
  return rest;
}

function mapToolChoice(tc: any): any {
  switch (tc?.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', name: tc.name };
    default: return 'auto';
  }
}

/** thinking → reasoning.effort(budget 近似映射;disabled→low) */
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
      return 'low';
    default:
      return undefined;
  }
}

function budgetToLevel(budget: number): string {
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
```

- [ ] **Step 4:运行,确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5:提交**

```bash
git add src/translate/responses/request.ts src/translate/responses/request.test.ts
git commit -m "feat: Anthropic 请求 → OpenAI Responses"
```

---

## Task 3:responses/response.ts —— Responses SSE → Anthropic SSE 状态机

**Files:** Create `src/translate/responses/response.ts`, `src/translate/responses/response.test.ts`

> 移植自 [codex_claude_response.go](../../CLIProxyAPI/internal/translator/codex/claude/codex_claude_response.go) 的流式分支,剥离 codex 签名(encrypted_content/signature_delta)。

- [ ] **Step 1:写失败测试**

创建 `src/translate/responses/response.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesToClaudeStream } from './response';

function run(payloads: string[]): { events: string[]; raw: string[] } {
  const s = new ResponsesToClaudeStream();
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

test('纯文本流:created→part.added→text.delta→part.done→completed', () => {
  const { events, raw } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.content_part.added"}',
    '{"type":"response.output_text.delta","delta":"Hel"}',
    '{"type":"response.output_text.delta","delta":"lo"}',
    '{"type":"response.content_part.done"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}',
  ]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const md = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.equal(md.usage.output_tokens, 1);
});

test('工具调用流:output_item.added(function_call)→args.delta→item.done→completed', () => {
  const { events, raw } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"Bash"}}',
    '{"type":"response.function_call_arguments.delta","delta":"{\\"cmd\\":\\"ls\\"}"}',
    '{"type":"response.output_item.done","item":{"type":"function_call"}}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
  ]);
  const startRaw = raw.find(r => r.includes('"tool_use"'))!;
  assert.equal(dataOf(startRaw).content_block.name, 'Bash');
  assert.equal(dataOf(startRaw).content_block.id, 'call_1');
  const inputRaw = raw.find(r => r.includes('input_json_delta'))!;
  assert.equal(dataOf(inputRaw).delta.partial_json, '{"cmd":"ls"}');
  const md = dataOf(raw.find(r => r.includes('message_delta'))!);
  assert.equal(md.delta.stop_reason, 'tool_use');
});

test('reasoning 流:summary_part.added→summary_text.delta→(content_part)关 thinking', () => {
  const { events } = run([
    '{"type":"response.created","response":{"id":"r1","model":"gpt-5"}}',
    '{"type":"response.reasoning_summary_part.added"}',
    '{"type":"response.reasoning_summary_text.delta","delta":"think"}',
    '{"type":"response.reasoning_summary_part.done"}',
    '{"type":"response.content_part.added"}',
    '{"type":"response.output_text.delta","delta":"ans"}',
    '{"type":"response.content_part.done"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
  ]);
  // message_start, thinking start/delta, (content_part.added 前先关 thinking), text start/delta/stop, delta, stop
  assert.deepEqual(events.slice(0, 5), [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_start',
  ]);
});

test('error 事件 → Anthropic 错误', () => {
  const { raw } = run([
    '{"type":"error","error":{"type":"invalid_request","message":"bad"}}',
  ]);
  const ev = dataOf(raw[0]);
  assert.equal(ev.type, 'error');
  assert.equal(ev.error.message, 'bad');
});

test('非法 JSON 负载被忽略', () => {
  const s = new ResponsesToClaudeStream();
  assert.deepEqual(s.push('[DONE]'), []);
  assert.deepEqual(s.push('not json'), []);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— 找不到 `./response`。

- [ ] **Step 3:实现 response.ts**

创建 `src/translate/responses/response.ts`:

```ts
import * as A from '../anthropic';
import { sseEvent } from '../sse';

/** OpenAI Responses 流式响应 → Anthropic SSE 事件。每喂一个 data 负载,返回应写回客户端的 SSE 文本数组。 */
export class ResponsesToClaudeStream {
  private messageStarted = false;
  private blockIndex = 0;
  private textOpen = false;
  private thinkingOpen = false;
  private thinkingStopPending = false;
  private hasToolCall = false;
  private hasArgsDelta = false;
  private messageStopped = false;

  push(payload: string): string[] {
    let root: any;
    try {
      root = JSON.parse(payload);
    } catch {
      return [];
    }
    const type = root.type;
    if (typeof type !== 'string') {
      return [];
    }
    const out: string[] = [];

    // thinking 延迟关闭:在新内容/结束事件到来前补关
    if (this.thinkingOpen && this.thinkingStopPending &&
        (type === 'response.content_part.added' || type === 'response.completed' || type === 'response.incomplete' ||
         type === 'response.output_item.added')) {
      this.stopThinking(out);
    }

    switch (type) {
      case 'response.created':
        if (!this.messageStarted) {
          out.push(A.messageStart(root.response?.id ?? '', root.response?.model ?? ''));
          this.messageStarted = true;
        }
        break;

      case 'response.reasoning_summary_part.added':
        this.ensureStarted(out);
        if (!this.thinkingOpen) {
          out.push(A.contentBlockStart(this.blockIndex, { type: 'thinking', thinking: '' }));
          this.thinkingOpen = true;
          this.thinkingStopPending = false;
        }
        break;
      case 'response.reasoning_summary_text.delta':
        if (this.thinkingOpen) {
          out.push(A.contentBlockDelta(this.blockIndex, { type: 'thinking_delta', thinking: root.delta ?? '' }));
        }
        break;
      case 'response.reasoning_summary_part.done':
        this.thinkingStopPending = true;
        break;

      case 'response.content_part.added':
        this.ensureStarted(out);
        out.push(A.contentBlockStart(this.blockIndex, { type: 'text', text: '' }));
        this.textOpen = true;
        break;
      case 'response.output_text.delta':
        if (this.textOpen) {
          out.push(A.contentBlockDelta(this.blockIndex, { type: 'text_delta', text: root.delta ?? '' }));
        }
        break;
      case 'response.content_part.done':
        if (this.textOpen) {
          out.push(A.contentBlockStop(this.blockIndex));
          this.textOpen = false;
          this.blockIndex++;
        }
        break;

      case 'response.output_item.added':
        if (root.item?.type === 'function_call') {
          this.ensureStarted(out);
          this.hasToolCall = true;
          this.hasArgsDelta = false;
          out.push(A.contentBlockStart(this.blockIndex, {
            type: 'tool_use', id: root.item.call_id || synthToolId(), name: root.item.name ?? '', input: {},
          }));
        }
        break;
      case 'response.function_call_arguments.delta':
        this.hasArgsDelta = true;
        out.push(A.contentBlockDelta(this.blockIndex, { type: 'input_json_delta', partial_json: root.delta ?? '' }));
        break;
      case 'response.function_call_arguments.done':
        if (!this.hasArgsDelta && root.arguments) {
          out.push(A.contentBlockDelta(this.blockIndex, { type: 'input_json_delta', partial_json: root.arguments }));
        }
        break;
      case 'response.output_item.done':
        if (root.item?.type === 'function_call') {
          out.push(A.contentBlockStop(this.blockIndex));
          this.blockIndex++;
        }
        break;

      case 'response.completed':
      case 'response.incomplete': {
        if (this.textOpen) {
          this.stopText(out);
        }
        const stopReason = this.hasToolCall ? 'tool_use' : (type === 'response.incomplete' ? 'max_tokens' : 'end_turn');
        out.push(A.messageDelta(stopReason, A.extractUsage(toChatUsage(root.response?.usage))));
        this.emitStop(out);
        break;
      }

      case 'error':
        out.push(sseEvent('error', {
          type: 'error',
          error: { type: root.error?.type || 'api_error', message: root.error?.message || 'upstream error' },
        }));
        break;
    }
    return out;
  }

  private ensureStarted(out: string[]): void {
    if (!this.messageStarted) {
      out.push(A.messageStart('', ''));
      this.messageStarted = true;
    }
  }

  private stopText(out: string[]): void {
    if (!this.textOpen) {
      return;
    }
    out.push(A.contentBlockStop(this.blockIndex));
    this.textOpen = false;
    this.blockIndex++;
  }

  private stopThinking(out: string[]): void {
    if (!this.thinkingOpen) {
      return;
    }
    out.push(A.contentBlockStop(this.blockIndex));
    this.thinkingOpen = false;
    this.thinkingStopPending = false;
    this.blockIndex++;
  }

  private emitStop(out: string[]): void {
    if (this.messageStopped) {
      return;
    }
    out.push(A.messageStop());
    this.messageStopped = true;
  }
}

/** Responses usage(input_tokens/output_tokens)→ 复用 anthropic.extractUsage 期望的 chat 字段名 */
function toChatUsage(usage: any): any {
  if (!usage || typeof usage !== 'object') {
    return {};
  }
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
  };
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
git add src/translate/responses/response.ts src/translate/responses/response.test.ts
git commit -m "feat: OpenAI Responses SSE → Anthropic SSE 流式状态机"
```

---

## Task 4:registry + preset.api —— 按 preset 分发

**Files:** Modify `src/presets.ts`, `src/translate/registry.ts`, `src/translate/registry.test.ts`

- [ ] **Step 1:改测试**

把 `src/translate/registry.test.ts` 全文替换为:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTranslator } from './registry';
import { getPreset } from '../presets';

test('openai(api=responses)→ responses 端点', () => {
  const t = getTranslator(getPreset('openai')!)!;
  assert.equal(t.endpointPath, '/v1/responses');
  assert.deepEqual(t.authHeader('sk-1'), { Authorization: 'Bearer sk-1' });
  const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'gpt-5');
  assert.deepEqual(req.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
  assert.equal(typeof t.createStreamTranslator().push, 'function');
});

test('openrouter/nvidia(api=chat)→ chat completions 端点', () => {
  for (const id of ['openrouter', 'nvidia']) {
    const t = getTranslator(getPreset(id)!)!;
    assert.equal(t.endpointPath, '/v1/chat/completions');
    const req = t.buildRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'm');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'hi' }]);
  }
});

test('anthropic 格式 preset 无 translator(原样转发)', () => {
  assert.equal(getTranslator(getPreset('glm')!), null);
});
```

- [ ] **Step 2:运行,确认失败**

Run: `npm test`
Expected: FAIL —— `getTranslator` 仍按 format 入参 / openai 仍返回 chat translator。

- [ ] **Step 3:改 presets.ts 加 api 字段**

在 `src/presets.ts` 的 `Preset` 接口加字段(放在 `forwardable` 之后):

```ts
  /** 走 OpenAI Chat Completions('chat')还是 Responses API('responses');非 openai 格式无意义 */
  api: 'chat' | 'responses';
```

PRESETS 各行补上 `api`:openai 设 `'responses'`,openrouter/nvidia 设 `'chat'`,anthropic 四家设 `'chat'`(占位,不会用到)。改后:

```ts
export const PRESETS: Preset[] = [
  { id: 'openai',     format: 'openai',    baseUrl: 'https://api.openai.com',                     modelsDevId: 'openai',     forwardable: true,  api: 'responses' },
  { id: 'openrouter', format: 'openai',    baseUrl: 'https://openrouter.ai/api',                  modelsDevId: 'openrouter', forwardable: true,  api: 'chat' },
  { id: 'nvidia',     format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com',           modelsDevId: 'nvidia',     forwardable: true,  api: 'chat' },
  { id: 'glm',        format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic',     modelsDevId: 'zhipuai',    forwardable: true,  api: 'chat' },
  { id: 'kimi',       format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic',          modelsDevId: 'moonshotai', forwardable: true,  api: 'chat' },
  { id: 'deepseek',   format: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',         modelsDevId: 'deepseek',   forwardable: true,  api: 'chat' },
  { id: 'minimax',    format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic',         modelsDevId: 'minimax',    forwardable: true,  api: 'chat' },
];
```

- [ ] **Step 4:改 registry.ts 按 preset 分发**

把 `src/translate/registry.ts` 全文替换为:

```ts
import { Preset } from '../presets';
import { buildOpenAIRequest } from './openai/request';
import { OpenAIToClaudeStream } from './openai/response';
import { buildResponsesRequest } from './responses/request';
import { ResponsesToClaudeStream } from './responses/response';

/** 一个流式转换器:把 data 负载逐个转为 Anthropic SSE 文本 */
export interface StreamTranslator {
  push(payload: string): string[];
}

/** 某 from→Anthropic 方向的完整转换器,proxy 据此转发而不关心具体格式 */
export interface Translator {
  buildRequest(claudeBody: any, model: string): any;
  createStreamTranslator(): StreamTranslator;
  endpointPath: string;
  authHeader(key: string): Record<string, string>;
}

const CHAT_TRANSLATOR: Translator = {
  buildRequest: buildOpenAIRequest,
  createStreamTranslator: () => new OpenAIToClaudeStream(),
  endpointPath: '/v1/chat/completions',
  authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
};

const RESPONSES_TRANSLATOR: Translator = {
  buildRequest: buildResponsesRequest,
  createStreamTranslator: () => new ResponsesToClaudeStream(),
  endpointPath: '/v1/responses',
  authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
};

/** 按 preset 返回转换器;anthropic 格式返回 null(原样转发) */
export function getTranslator(preset: Preset): Translator | null {
  if (preset.format !== 'openai') {
    return null;
  }
  return preset.api === 'responses' ? RESPONSES_TRANSLATOR : CHAT_TRANSLATOR;
}
```

- [ ] **Step 5:改 proxy.ts 调用点**

在 `src/proxy.ts` 中,把:

```ts
        const translator = target ? getTranslator(target.preset.format) : null;
```

改为:

```ts
        const translator = target ? getTranslator(target.preset) : null;
```

- [ ] **Step 6:运行 + 编译**

Run: `npm test && npm run compile`
Expected: PASS,无 TS 错误。

- [ ] **Step 7:提交**

```bash
git add src/presets.ts src/translate/registry.ts src/translate/registry.test.ts src/proxy.ts
git commit -m "feat: registry 按 preset 分发,openai 切到 Responses API"
```

---

## Task 5:手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1:全量测试 + 编译**

Run: `npm test && npm run compile`
Expected: 全部 PASS,无 TS 错误。

- [ ] **Step 2:openai(Responses)冒烟**

F5 启动扩展宿主(先关旧宿主确保加载新 `out/`):
1. 状态栏 → ⚙ Provider 设置 → 给 openai 配置真实 key。
2. 状态栏 → 选 openai 的 gpt-5 系模型。
3. **重启 F5 宿主里的 Claude Code 会话**(让它读到新端口),发起普通对话。

Expected:正常文本回复(证明 Responses 请求转换 + SSE 回译成功);不再出现之前 chat completions 的 `max_tokens`/`reasoning_effort` 报错。Debug Console 有 `[proxy] ... → openai https://api.openai.com/v1/responses` 与 `upstream status 200`。

- [ ] **Step 3:工具调用冒烟**

让 Claude Code 执行需要工具的任务(如"列出当前目录文件")。

Expected:模型发起工具调用、执行、回传、对话继续(证明 function_call/function_call_output 双向转换)。

- [ ] **Step 4:回归 nvidia(chat completions 未受影响)**

切到 nvidia 的模型,发一句对话。

Expected:仍正常(证明按 preset 分发后,openrouter/nvidia 仍走 chat completions)。

- [ ] **Step 5:轮换冒烟**

把 openai 第一个 key 改无效、追加一个有效 key,重复对话。

Expected:仍成功(401/429/5xx 轮换);全无效时 Claude Code 收到 Anthropic 格式错误。

---

## Self-Review 记录

- **Spec 移除 gemini**:Task 1(presets/ProviderFormat/测试)。
- **Spec preset.api + registry 按 preset 分发**:Task 4。
- **Spec 请求映射(developer/文本/图片/function_call/function_call_output/tools/max_output_tokens/reasoning)**:Task 2,逐项有测试。
- **Spec 响应状态机(created/part/text.delta/reasoning/function_call/completed/error)**:Task 3,逐路径有测试。
- **Spec 剥离 codex 专属**:Task 2(不发 instructions/store/encrypted reasoning/web_search/名称缩短)+ Task 3(无 signature_delta)。
- **Spec 仅流式**:request 固定 stream:true(Task 2);response 仅流式状态机(Task 3)。
- **Spec proxy 接入复用**:Task 4 Step 5(仅改 getTranslator 入参;proxy 转换转发路径 Part 2a 已就绪,Responses 也是 SSE,直接复用)+ Task 5 冒烟。
- **类型一致性**:`buildResponsesRequest`(request.ts)、`ResponsesToClaudeStream`(response.ts)、`getTranslator(preset)`/`Translator`/`StreamTranslator`(registry.ts)、`Preset.api`(presets.ts)跨 Task 引用一致;复用 `A.messageStart/contentBlock*/messageDelta/messageStop/extractUsage`(anthropic.ts)与 `sseEvent`(sse.ts)签名不变。
- **占位符扫描**:无 TBD/TODO;胶水/接入以 Task 5 手动冒烟覆盖,代码完整给出。

## 范围外

- codex OAuth 登录 + codex 专属处理(Part 3,在本轮 Responses 转换之上叠加)。
- gemini(已移除)、非流式响应、prompt caching、tool_result 图片(降级为文本)。
