import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ModelInfo {
  id: string;
  name: string;
  releaseDate: string;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存文件路径 */
export function cachePath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'models-cache.json');
}

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

export function topN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

/** 读缓存;过期或不存在返回 null。now 可注入用于测试 TTL。 */
export function readCache(p: string = cachePath(), now: number = Date.now()): any | null {
  try {
    const stat = fs.statSync(p);
    if (now - stat.mtimeMs > CACHE_TTL_MS) {
      return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(catalog: any, p: string = cachePath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(catalog), 'utf8');
}

/** 取 catalog:优先有效缓存,否则拉取并写缓存。fetcher 可注入用于测试。 */
export async function getCatalog(fetcher: typeof fetch = fetch): Promise<any> {
  const cached = readCache();
  if (cached) {
    return cached;
  }
  const res = await fetcher(CATALOG_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status}`);
  }
  const catalog = await res.json();
  writeCache(catalog);
  return catalog;
}
