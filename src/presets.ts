// 内置 provider preset 目录(Part 1)。codex 仅作占位,登录留待 Part 3。

export type ProviderFormat = 'anthropic' | 'openai' | 'gemini';

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
}

/** Codex 占位 id —— Part 1 仅在管理列表展示提示,不落地登录/转发 */
export const CODEX_PLACEHOLDER_ID = 'codex';

export const PRESETS: Preset[] = [
  { id: 'openai',     format: 'openai',    baseUrl: 'https://api.openai.com',                     modelsDevId: 'openai',     forwardable: true },
  { id: 'gemini',     format: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com',  modelsDevId: 'google',     forwardable: false },
  { id: 'openrouter', format: 'openai',    baseUrl: 'https://openrouter.ai/api',                  modelsDevId: 'openrouter', forwardable: true },
  { id: 'nvidia',     format: 'openai',    baseUrl: 'https://integrate.api.nvidia.com',           modelsDevId: 'nvidia',     forwardable: true },
  { id: 'glm',        format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic',     modelsDevId: 'zhipuai',    forwardable: true },
  { id: 'kimi',       format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic',          modelsDevId: 'moonshotai', forwardable: true },
  { id: 'deepseek',   format: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',         modelsDevId: 'deepseek',   forwardable: true },
  { id: 'minimax',    format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic',         modelsDevId: 'minimax',    forwardable: true },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find(p => p.id === id);
}
