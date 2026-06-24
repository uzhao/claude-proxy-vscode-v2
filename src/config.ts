export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

export interface CustomProvider {
  /** 用作 mapping 前缀,同时是 SecretStorage 中的 key 索引名 */
  id: string;
  /** 转发目标 base url,不含 /v1 */
  baseUrl: string;
}

/**
 * 运行时内存聚合视图:mapping 来自 workspaceState、providers 来自 SecretStorage(内存缓存)。
 * 本类型不对应任何磁盘格式。
 */
export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
  /** 用户自定义的 OpenAI 兼容 provider(运行时从 globalState 填充) */
  customProviders?: CustomProvider[];
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

export function addCustomProvider(cfg: ProxyConfig, cp: CustomProvider): ProxyConfig {
  const rest = (cfg.customProviders ?? []).filter(c => c.id !== cp.id);
  return { ...cfg, customProviders: [...rest, cp] };
}

export function updateCustomProvider(cfg: ProxyConfig, id: string, baseUrl: string): ProxyConfig {
  const customProviders = (cfg.customProviders ?? []).map(c => (c.id === id ? { ...c, baseUrl } : c));
  return { ...cfg, customProviders };
}

export function removeCustomProvider(cfg: ProxyConfig, id: string): ProxyConfig {
  const customProviders = (cfg.customProviders ?? []).filter(c => c.id !== id);
  const providers = cfg.providers.filter(p => p.name !== id);
  return { ...cfg, customProviders, providers };
}

/** 规范化用户填的 base url:去尾部斜杠,再去误带的尾部 /v1(转发时由 endpointPath 统一补 /v1/...) */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}
