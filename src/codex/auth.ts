import type * as vscode from 'vscode';
import { refreshToken, parseAccountId } from './oauth';

const SECRET_KEY = 'claudeProxy.codex';

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number; // epoch ms
}

/** access token 是否需要刷新(剩余不足 60s) */
export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now < 60_000;
}

/** codex 凭证管理:基于 VSCode SecretStorage,转发前确保 access token 有效 */
export class CodexAuth {
  constructor(private secrets: vscode.SecretStorage) {}

  async save(t: { accessToken: string; refreshToken: string; idToken: string; expiresIn: number }): Promise<void> {
    const stored: StoredToken = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accountId: parseAccountId(t.idToken),
      expiresAt: Date.now() + t.expiresIn * 1000,
    };
    await this.secrets.store(SECRET_KEY, JSON.stringify(stored));
  }

  async logout(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async accountId(): Promise<string> {
    return (await this.read())?.accountId ?? '';
  }

  /** 返回有效的 {accessToken, accountId};未登录或刷新失败返回 null */
  async getValid(): Promise<{ accessToken: string; accountId: string } | null> {
    const cur = await this.read();
    if (!cur) {
      return null;
    }
    if (!isExpired(cur.expiresAt)) {
      return { accessToken: cur.accessToken, accountId: cur.accountId };
    }
    try {
      const fresh = await refreshToken(cur.refreshToken);
      const next: StoredToken = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || cur.refreshToken,
        accountId: parseAccountId(fresh.idToken) || cur.accountId,
        expiresAt: Date.now() + fresh.expiresIn * 1000,
      };
      await this.secrets.store(SECRET_KEY, JSON.stringify(next));
      return { accessToken: next.accessToken, accountId: next.accountId };
    } catch (e) {
      console.error('codex token refresh failed', e);
      return null;
    }
  }

  private async read(): Promise<StoredToken | null> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }
}
