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
