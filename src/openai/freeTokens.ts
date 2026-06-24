// OpenAI 官方 endpoint 每日免费额度:模型→池、决策纯函数。

export type Pool = '1M' | '10M';

/** 两个共享池每日上限(token) */
export const POOL_LIMIT: Record<Pool, number> = {
  '1M': 1_000_000,
  '10M': 10_000_000,
};

/** 1M 池(大模型) */
const POOL_1M_MODELS = [
  'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5',
  'gpt-5-codex', 'gpt-5-chat-latest', 'gpt-4.1', 'gpt-4o', 'o1', 'o3',
];

/** 10M 池(mini/nano) */
const POOL_10M_MODELS = [
  'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini', 'o1-mini', 'o3-mini', 'o4-mini',
  'codex-mini-latest',
];

/** 模型属于哪个免费池;不在任何列表返回 null */
export function resolvePool(model: string): Pool | null {
  if (POOL_1M_MODELS.includes(model)) {
    return '1M';
  }
  if (POOL_10M_MODELS.includes(model)) {
    return '10M';
  }
  return null;
}

export interface OpenAIOfficialSettings {
  /** 请求体注入 service_tier: "flex"(仅对付费请求生效) */
  flex: boolean;
  /** 账号参与每日免费额度计划:开启后按 UTC 天计量两个共享池 */
  freeTokens: boolean;
  /** 只用免费额度:对应池用尽 / 模型不在免费列表时,该请求停用 */
  freeTokensOnly: boolean;
}

export const DEFAULT_OPENAI_SETTINGS: OpenAIOfficialSettings = {
  flex: false,
  freeTokens: false,
  freeTokensOnly: false,
};

/** globalState key:设置对象 / 当日用量(放无 vscode 依赖的本文件,避免 extension↔statusbar 循环引用) */
export const OPENAI_SETTINGS_KEY = 'claudeProxy.openaiSettings';
export const OPENAI_USAGE_KEY = 'claudeProxy.openaiUsage';

export interface OpenAIPlan {
  /** false → 该请求停用,返回错误 */
  allowed: boolean;
  /** true → 注入 service_tier: "flex" */
  flex: boolean;
  /** 命中的免费池(用于成功后计量) */
  pool: Pool | null;
}

/** 依据设置与当前用量决定:是否放行、是否 flex、计量到哪个池 */
export function planOpenAIRequest(
  model: string,
  settings: OpenAIOfficialSettings,
  used: (p: Pool) => number,
): OpenAIPlan {
  const pool = resolvePool(model);
  const isFree = settings.freeTokens && pool != null && used(pool) < POOL_LIMIT[pool];
  const allowed = !settings.freeTokensOnly || isFree;
  const flex = settings.flex && !isFree;
  return { allowed, flex, pool };
}
