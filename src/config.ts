export interface ProviderEntry {
  /** = preset id */
  name: string;
  apiKeys: string[];
}

/**
 * 运行时内存聚合视图:mapping 来自 workspaceState、providers 来自 SecretStorage(内存缓存)。
 * 本类型不对应任何磁盘格式。
 */
export interface ProxyConfig {
  /** "provider:model" 或 "pass" */
  mapping: string;
  providers: ProviderEntry[];
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
