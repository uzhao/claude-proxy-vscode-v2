import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
}

export const DEFAULT_CONFIG: ProxyConfig = { mapping: 'pass', providers: [] };

export function configPath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'providers.json');
}

/** 把任意 JSON 规范化为合法 ProxyConfig,丢弃非法字段 */
export function normalize(raw: any): ProxyConfig {
  const mapping = typeof raw?.mapping === 'string' ? raw.mapping : 'pass';
  const providers: ProviderEntry[] = Array.isArray(raw?.providers)
    ? raw.providers
        .filter((e: any) => e && typeof e.name === 'string')
        .map((e: any) => ({
          name: e.name,
          apiKeys: Array.isArray(e.apiKeys) ? e.apiKeys.filter((k: any) => typeof k === 'string') : [],
        }))
    : [];
  return { mapping, providers };
}

export function readConfig(p: string = configPath()): ProxyConfig {
  try {
    return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return { mapping: 'pass', providers: [] };
  }
}

export function writeConfig(cfg: ProxyConfig, p: string = configPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 不存在则写默认模板并返回;存在则读取 */
export function ensureConfig(p: string = configPath()): ProxyConfig {
  if (!fs.existsSync(p)) {
    writeConfig(DEFAULT_CONFIG, p);
    return { mapping: 'pass', providers: [] };
  }
  return readConfig(p);
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
