/** Anthropic Messages 请求 → OpenAI Chat Completions 请求(仅流式,固定 stream:true) */
export function buildOpenAIRequest(body: any, model: string): any {
  const out: any = { model, messages: [], stream: true };

  // OpenAI 新模型(gpt-5 / o 系)废弃 max_tokens,统一用 max_completion_tokens(旧模型亦兼容)
  if (typeof body.max_tokens === 'number') {
    out.max_completion_tokens = body.max_tokens;
  }
  if (typeof body.temperature === 'number') {
    out.temperature = body.temperature;
  } else if (typeof body.top_p === 'number') {
    out.top_p = body.top_p;
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences.length === 1 ? body.stop_sequences[0] : body.stop_sequences;
  }

  // 注:不发 reasoning_effort —— OpenAI 在 /v1/chat/completions 下不允许 tools 与 reasoning_effort 共存,
  // 且非 reasoning 模型不认该参数;gpt-5/o 系仍会按默认强度推理。

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
