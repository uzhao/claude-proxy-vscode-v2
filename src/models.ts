export interface ModelInfo {
  id: string;
  name: string;
  releaseDate: string;
}

const CATALOG_URL = 'https://models.dev/api.json';

/** 纯解析:从整份 catalog 取某 models.dev provider 的模型,按发布日期倒序 */
export function parseProviderModels(catalog: any, modelsDevId: string): ModelInfo[] {
  const models = catalog?.[modelsDevId]?.models;
  if (!models || typeof models !== 'object') {
    return [];
  }
  const list: ModelInfo[] = Object.values(models).map((m: any) => ({
    id: m.id,
    name: m.name ?? m.id,
    releaseDate: m.release_date ?? m.last_updated ?? '',
  }));
  list.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : a.releaseDate > b.releaseDate ? -1 : 0));
  return list;
}

/** 默认展示的 model 白名单(glob:* 匹配任意串,. 匹配任意单字符,大小写不敏感) */
const FEATURED_PATTERNS = [
  'claude*4*', 'gpt*5*', 'gemini*3*', 'kimi-k2.*',
  'glm-5*', 'deepseek-v4*', 'minimax-m3*', 'minimax-m2.*',
];

function globToRegExp(pattern: string): RegExp {
  // 按 * 分段,段内转义正则特殊字符(故意不转义 . ,使其匹配任意单字符),段间用 .* 连接
  const body = pattern
    .split('*')
    .map(seg => seg.replace(/[+^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const FEATURED_REGEXPS = FEATURED_PATTERNS.map(globToRegExp);

/** model id 是否命中默认展示白名单(仅匹配 / 后的模型名,忽略 nvidia/openrouter 等的 vendor 前缀) */
export function isFeatured(id: string): boolean {
  const name = id.slice(id.lastIndexOf('/') + 1);
  return FEATURED_REGEXPS.some(re => re.test(name));
}

/** 仅保留命中白名单的 model */
export function filterFeatured(models: ModelInfo[]): ModelInfo[] {
  return models.filter(m => isFeatured(m.id));
}

/** catalog 缓存接口(由宿主提供 globalState 实现) */
export interface CatalogCache {
  /** 返回有效缓存,或 null(过期/无) */
  read(): any | null;
  write(catalog: any): void;
}

/** 取 catalog:优先有效缓存,否则拉取并写缓存。cache/fetcher 可注入用于测试。 */
export async function getCatalog(cache: CatalogCache, fetcher: typeof fetch = fetch): Promise<any> {
  const cached = cache.read();
  if (cached) {
    return cached;
  }
  const res = await fetcher(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  cache.write(catalog);
  return catalog;
}

/** 纯解析:OpenAI 兼容 /v1/models 响应 { data: [{ id }] } → ModelInfo[](按 id 升序) */
export function parseEndpointModels(json: any): ModelInfo[] {
  const data = json?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const list: ModelInfo[] = data
    .filter((m: any) => m && typeof m.id === 'string')
    .map((m: any) => ({ id: m.id, name: m.id, releaseDate: '' }));
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

/** 拉取自定义 provider 的模型列表:GET {baseUrl}/v1/models(可选 Bearer)。fetcher 可注入用于测试。 */
export async function fetchEndpointModels(baseUrl: string, key?: string, fetcher: typeof fetch = fetch): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {};
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  const res = await fetcher(`${baseUrl}/v1/models`, { headers });
  if (!res.ok) {
    throw new Error(`models endpoint fetch failed: ${res.status}`);
  }
  return parseEndpointModels(await res.json());
}
