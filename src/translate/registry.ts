import { Preset } from '../presets';
import { buildOpenAIRequest } from './openai/request';
import { OpenAIToClaudeStream } from './openai/response';
import { buildResponsesRequest } from './responses/request';
import { ResponsesToClaudeStream } from './responses/response';
import { buildCodexRequest } from './codex/request';

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

const CODEX_TRANSLATOR: Translator = {
  buildRequest: buildCodexRequest,
  createStreamTranslator: () => new ResponsesToClaudeStream(),
  endpointPath: '/responses',
  authHeader: () => ({}), // codex 认证由 proxy 用 OAuth token 注入,这里留空
};

/** 按 preset 返回转换器;anthropic 格式返回 null(原样转发) */
export function getTranslator(preset: Preset): Translator | null {
  if (preset.id === 'codex') {
    return CODEX_TRANSLATOR;
  }
  if (preset.format !== 'openai') {
    return null;
  }
  return preset.api === 'responses' ? RESPONSES_TRANSLATOR : CHAT_TRANSLATOR;
}
