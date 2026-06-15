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
