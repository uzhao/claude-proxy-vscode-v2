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
