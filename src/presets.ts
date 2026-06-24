// 内置 provider preset 目录(Part 1)。codex 仅作占位,登录留待 Part 3。

import { CustomProvider, ProxyConfig } from './config';

export type ProviderFormat = 'anthropic' | 'openai';

export interface Preset {
  /** mapping 前缀,同时也是 providers.json 中的 name */
  id: string;
  format: ProviderFormat;
  /** 转发目标 base url */
  baseUrl: string;
  /** models.dev 顶层 provider id,用于取模型列表 */
  modelsDevId: string;
  /** Part 1 是否支持转发(仅 anthropic 格式为 true) */
  forwardable: boolean;
  /** 走 OpenAI Chat Completions('chat')还是 Responses API('responses');非 openai 格式无意义 */
  api: 'chat' | 'responses';
  /** 用户自定义 provider(来自 CustomProvider),区别于内置 PRESETS */
  custom?: boolean;
}

/** Codex 占位 id —— Part 1 仅在管理列表展示提示,不落地登录/转发 */
export const CODEX_PLACEHOLDER_ID = 'codex';

export const PRESETS: Preset[] = [
  { id: 'openai',     format: 'openai',    baseUrl: 'https://api.openai.com',                     modelsDevId: 'openai',     forwardable: true,  api: 'responses' },
  { id: 'openrouter', format: 'openai',    baseUrl: 'https://openrouter.ai/api',                  modelsDevId: 'openrouter', forwardable: true,  api: 'chat' },
  { id: 'nvidia',     format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com',           modelsDevId: 'nvidia',     forwardable: true,  api: 'chat' },
  { id: 'glm',        format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic',     modelsDevId: 'zhipuai',    forwardable: true,  api: 'chat' },
  { id: 'kimi',       format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic',          modelsDevId: 'moonshotai', forwardable: true,  api: 'chat' },
  { id: 'deepseek',   format: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',         modelsDevId: 'deepseek',   forwardable: true,  api: 'chat' },
  { id: 'minimax',    format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic',         modelsDevId: 'minimax',    forwardable: true,  api: 'chat' },
  { id: 'codex',      format: 'openai',    baseUrl: 'https://chatgpt.com/backend-api/codex',      modelsDevId: 'openai',     forwardable: true,  api: 'responses' },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find(p => p.id === id);
}

/** 把自定义 provider 派生成内置 Preset 同形:固定 openai / chat / 可转发 */
export function customToPreset(cp: CustomProvider): Preset {
  return { id: cp.id, format: 'openai', baseUrl: cp.baseUrl, modelsDevId: '', forwardable: true, api: 'chat', custom: true };
}

/** 合并查找:先内置 PRESETS,再 cfg.customProviders(内置优先) */
export function resolvePreset(cfg: ProxyConfig, name: string): Preset | undefined {
  const builtin = getPreset(name);
  if (builtin) {
    return builtin;
  }
  const cp = (cfg.customProviders ?? []).find(c => c.id === name);
  return cp ? customToPreset(cp) : undefined;
}
