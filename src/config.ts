import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

/**
 * 运行时内存聚合视图(非磁盘格式):mapping 来自 workspaceState、providers 来自 providers.json。
 * providers.json 本身只持久化 providers。
 */
export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
}

export function configPath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'providers.json');
}

/** 把任意 JSON 的 providers 字段规范化为合法数组;非法项整体丢弃,非法 apiKey 元素逐个过滤 */
export function normalizeProviders(raw: any): ProviderEntry[] {
  return Array.isArray(raw?.providers)
    ? raw.providers
        .filter((e: any) => e && typeof e.name === 'string')
        .map((e: any) => ({
          name: e.name,
          apiKeys: Array.isArray(e.apiKeys) ? e.apiKeys.filter((k: any) => typeof k === 'string') : [],
        }))
    : [];
}

/** 读 providers.json 的 providers;文件不存在/非法返回 [] */
export function readProviders(p: string = configPath()): ProviderEntry[] {
  try {
    return normalizeProviders(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return [];
  }
}

/** 写 providers 到 providers.json(仅 { providers }) */
export function writeProviders(providers: ProviderEntry[], p: string = configPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ providers }, null, 2), 'utf8');
}

/** 不存在则写空模板并返回 [];存在则读取 */
export function ensureProviders(p: string = configPath()): ProviderEntry[] {
  if (!fs.existsSync(p)) {
    writeProviders([], p);
    return [];
  }
  return readProviders(p);
}

export function getProvider(cfg: ProxyConfig, name: string): ProviderEntry | undefined {
  return cfg.providers.find(p => p.name === name);
}

export function configuredProviders(cfg: ProxyConfig): ProviderEntry[] {
  return cfg.providers.filter(p => p.apiKeys.length > 0);
}

export function addKey(cfg: ProxyConfig, name: string, key: string): ProxyConfig {
  const providers = cfg.providers.map(p => ({ ...p, apiKeys: [...p.apiKeys] }));
  const entry = providers.find(p => p.name === name);
  if (entry) {
    entry.apiKeys.push(key);
  } else {
    providers.push({ name, apiKeys: [key] });
  }
  return { ...cfg, providers };
}

export function removeKey(cfg: ProxyConfig, name: string, key: string): ProxyConfig {
  const providers = cfg.providers.map(p =>
    p.name === name ? { ...p, apiKeys: p.apiKeys.filter(k => k !== key) } : p,
  );
  return { ...cfg, providers };
}

export function setMapping(cfg: ProxyConfig, mapping: string): ProxyConfig {
  return { ...cfg, mapping };
}
