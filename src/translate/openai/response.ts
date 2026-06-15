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
