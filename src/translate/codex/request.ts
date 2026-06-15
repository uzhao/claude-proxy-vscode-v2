import { buildResponsesRequest } from '../responses/request';

/** Anthropic 请求 → codex 的 Responses 请求:在通用 Responses 基础上叠加 codex 专属字段 */
export function buildCodexRequest(body: any, model: string): any {
  const out = buildResponsesRequest(body, model);
  // codex 后端(chatgpt.com)不接受这些参数,删除后用其默认
  delete out.max_output_tokens;
  delete out.temperature;
  delete out.top_p;
  out.instructions = '';
  out.store = false;
  out.include = ['reasoning.encrypted_content'];
  if (!out.reasoning) {
    out.reasoning = { effort: 'medium' };
  }
  out.reasoning.summary = 'auto';
  return out;
}
