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
