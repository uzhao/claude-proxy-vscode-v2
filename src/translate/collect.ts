/**
 * 把一串 Anthropic SSE 事件文本聚合回非流式 Messages 响应。
 *
 * 客户端发 stream:false 时,代理对上游仍然走流式(复用同一套 translator,
 * 避免为每种 provider 再写一遍非流式转换),读完后用本模块还原成一个 JSON 响应。
 */

interface Block {
  type: string;
  /** text / thinking 块累积的文本 */
  text: string;
  /** tool_use 块累积的 partial_json */
  json: string;
  /** content_block_start 里除 type 外的原始字段(tool_use 的 id/name 等) */
  meta: Record<string, unknown>;
}

export interface CollectedMessage {
  status: number;
  body: any;
}

/** Anthropic 错误类型 → HTTP 状态码 */
function errorStatus(type: string): number {
  switch (type) {
    case 'invalid_request_error': return 400;
    case 'authentication_error': return 401;
    case 'permission_error': return 403;
    case 'not_found_error': return 404;
    case 'request_too_large': return 413;
    case 'rate_limit_error': return 429;
    case 'overloaded_error': return 529;
    case 'upstream_error': return 502;
    default: return 500;
  }
}

/**
 * 解析 SSE 文本块,产出其中每个事件的 data 负载对象。
 * 入参可以是单个事件,也可以是多个事件拼接的字符串;非法 JSON 与非 data 行忽略。
 */
function parsePayloads(chunks: string[]): any[] {
  const out: any[] = [];
  for (const line of chunks.join('').split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') {
      continue;
    }
    try {
      out.push(JSON.parse(raw));
    } catch {
      // 半截或非法负载忽略
    }
  }
  return out;
}

/** 把累积好的块还原成 Anthropic content 项;无实际内容返回 null */
function finishBlock(b: Block): any | null {
  if (b.type === 'text') {
    return b.text ? { type: 'text', text: b.text } : null;
  }
  if (b.type === 'thinking') {
    return b.text ? { type: 'thinking', thinking: b.text } : null;
  }
  if (b.type === 'tool_use') {
    let input: unknown = {};
    if (b.json) {
      try {
        input = JSON.parse(b.json);
      } catch {
        // 上游把 arguments 截断了,退化为空入参而不是让整个响应失败
        input = {};
      }
    }
    return { ...b.meta, type: 'tool_use', input };
  }
  return null;
}

/**
 * 聚合入口。events 可以是逐个事件,也可以是含多个事件的文本块。
 * 命中 error 事件时返回对应状态码与错误体;一个事件都没有时返回 502。
 */
export function collectMessage(events: string[]): CollectedMessage {
  const payloads = parsePayloads(events);
  if (payloads.length === 0) {
    return {
      status: 502,
      body: {
        type: 'error',
        error: { type: 'api_error', message: 'upstream produced no events to translate' },
      },
    };
  }

  let id = '';
  let model = '';
  let stopReason: string | null = null;
  let stopSequence: string | null = null;
  let usage: any = { input_tokens: 0, output_tokens: 0 };
  const blocks = new Map<number, Block>();
  const order: number[] = [];

  for (const p of payloads) {
    switch (p?.type) {
      case 'error':
        return {
          status: errorStatus(p.error?.type ?? 'api_error'),
          body: {
            type: 'error',
            error: {
              type: p.error?.type ?? 'api_error',
              message: p.error?.message ?? 'upstream error',
            },
          },
        };

      case 'message_start':
        id = p.message?.id ?? id;
        model = p.message?.model ?? model;
        if (p.message?.usage) {
          usage = { ...usage, ...p.message.usage };
        }
        break;

      case 'content_block_start': {
        const idx = Number(p.index ?? 0);
        const cb = p.content_block ?? {};
        const { type, text, thinking, input, ...meta } = cb;
        if (!blocks.has(idx)) {
          order.push(idx);
        }
        blocks.set(idx, {
          type: type ?? 'text',
          text: typeof text === 'string' ? text : (typeof thinking === 'string' ? thinking : ''),
          json: '',
          meta,
        });
        break;
      }

      case 'content_block_delta': {
        const idx = Number(p.index ?? 0);
        const b = blocks.get(idx);
        if (!b) {
          break;
        }
        const d = p.delta ?? {};
        if (typeof d.text === 'string') {
          b.text += d.text;
        } else if (typeof d.thinking === 'string') {
          b.text += d.thinking;
        } else if (typeof d.partial_json === 'string') {
          b.json += d.partial_json;
        }
        break;
      }

      case 'message_delta':
        if (p.delta?.stop_reason != null) {
          stopReason = p.delta.stop_reason;
        }
        if (p.delta?.stop_sequence != null) {
          stopSequence = p.delta.stop_sequence;
        }
        if (p.usage) {
          usage = { ...usage, ...p.usage };
        }
        break;

      // content_block_stop / message_stop / ping 不携带需要聚合的信息
    }
  }

  const content: any[] = [];
  for (const idx of order) {
    const item = finishBlock(blocks.get(idx)!);
    if (item) {
      content.push(item);
    }
  }

  return {
    status: 200,
    body: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason ?? 'end_turn',
      stop_sequence: stopSequence,
      usage,
    },
  };
}
