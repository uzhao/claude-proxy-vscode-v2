import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SECRET_KEY = 'claudeProxy.providerKeys';

/** provider → key 列表 */
export type ProviderKeys = Record<string, string[]>;

/** 旧明文文件路径(迁移用) */
export function legacyProvidersPath(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'providers.json');
}

/** 规范化:仅保留 string[] 值的项,过滤非 string 元素 */
export function normalizeProviderKeys(raw: any): ProviderKeys {
  const out: ProviderKeys = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) {
        const keys = v.filter((x) => typeof x === 'string') as string[];
        out[k] = keys;
      }
    }
  }
  return out;
}

/** provider key 的安全存储:VSCode SecretStorage(系统密钥链) */
export class ProviderKeyStore {
  constructor(private secrets: vscode.SecretStorage) {}

  async load(): Promise<ProviderKeys> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return {};
    }
    try {
      return normalizeProviderKeys(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  async save(keys: ProviderKeys): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(keys));
  }

  /**
   * 首次迁移:若旧 providers.json 存在,把其中的 key 合并进 SecretStorage 并删除该文件。
   * 返回迁移后(或原样)的 keys。legacyPath 可注入用于测试。
   */
  async migrateLegacy(current: ProviderKeys, legacyPath: string = legacyProvidersPath()): Promise<ProviderKeys> {
    try {
      if (!fs.existsSync(legacyPath)) {
        return current;
      }
      const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      const merged: ProviderKeys = { ...current };
      if (Array.isArray(parsed?.providers)) {
        for (const e of parsed.providers) {
          if (e && typeof e.name === 'string' && Array.isArray(e.apiKeys)) {
            const keys = e.apiKeys.filter((k: any) => typeof k === 'string');
            if (keys.length > 0) {
              merged[e.name] = [...(merged[e.name] ?? []), ...keys];
            }
          }
        }
      }
      await this.save(merged);
      fs.unlinkSync(legacyPath);
      return merged;
    } catch {
      return current;
    }
  }
}
