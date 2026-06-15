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
  return `toulu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
