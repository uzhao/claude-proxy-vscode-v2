import type * as vscode from 'vscode';
import { refreshToken, parseAccountId, parseEmail } from './oauth';

const SECRET_KEY = 'claudeProxy.codex';

interface StoredAccount {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  email: string;
  expiresAt: number; // epoch ms
}

/** access token 是否需要刷新(剩余不足 60s) */
export function isExpired(expiresAt: number, now: number = Date.now()): boolean {
  return expiresAt - now < 60_000;
}

/** 解析 codex CLI 风格凭证 JSON → StoredAccount;缺 access_token/refresh_token 抛错 */
export function parseImportedCredential(text: string): StoredAccount {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('invalid credential JSON');
  }
  const accessToken = j?.access_token;
  const refreshTok = j?.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshTok !== 'string' || !refreshTok) {
    throw new Error('missing access_token or refresh_token');
  }
  const idToken = typeof j?.id_token === 'string' ? j.id_token : '';
  const accountId = (typeof j?.account_id === 'string' && j.account_id) || parseAccountId(idToken);
  const email = (typeof j?.email === 'string' && j.email) || parseEmail(idToken);
  const ts = j?.expired ? Date.parse(j.expired) : NaN;
  const expiresAt = Number.isFinite(ts) ? ts : 0;
  return { accessToken, refreshToken: refreshTok, accountId, email, expiresAt };
}

/** codex 凭证管理:多账号,基于 VSCode SecretStorage;转发前确保 access token 有效 */
export class CodexAuth {
  private cursor = 0;

  constructor(private secrets: vscode.SecretStorage) {}

  /** OAuth 登录成功后保存(token 来自 exchangeCode) */
  async save(t: { accessToken: string; refreshToken: string; idToken: string; expiresIn: number }): Promise<void> {
    await this.add({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accountId: parseAccountId(t.idToken),
      email: parseEmail(t.idToken),
      expiresAt: Date.now() + t.expiresIn * 1000,
    });
  }

  /** 按 accountId 去重新增/更新 */
  async add(account: StoredAccount): Promise<void> {
    const list = await this.readAll();
    const i = account.accountId ? list.findIndex(a => a.accountId === account.accountId) : -1;
    if (i >= 0) {
      list[i] = account;
    } else {
      list.push(account);
    }
    await this.writeAll(list);
  }

  async removeByAccountId(id: string): Promise<void> {
    const list = (await this.readAll()).filter(a => a.accountId !== id);
    await this.writeAll(list);
  }

  async logoutAll(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  async list(): Promise<{ accountId: string; email: string }[]> {
    return (await this.readAll()).map(a => ({ accountId: a.accountId, email: a.email }));
  }

  async count(): Promise<number> {
    return (await this.readAll()).length;
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  startIndex(): number {
    return this.cursor;
  }

  markSuccess(i: number): void {
    this.cursor = i;
  }

  /** 取第 i 个账号有效凭证;过期则刷新并写回;未登录/刷新失败返回 null */
  async validAt(i: number): Promise<{ accessToken: string; accountId: string } | null> {
    const list = await this.readAll();
    const cur = list[i];
    if (!cur) {
      return null;
    }
    if (!isExpired(cur.expiresAt)) {
      return { accessToken: cur.accessToken, accountId: cur.accountId };
    }
    try {
      const fresh = await refreshToken(cur.refreshToken);
      const next: StoredAccount = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken || cur.refreshToken,
        accountId: parseAccountId(fresh.idToken) || cur.accountId,
        email: parseEmail(fresh.idToken) || cur.email,
        expiresAt: Date.now() + fresh.expiresIn * 1000,
      };
      // 写回:重新读取后按 accountId 定位(刷新期间列表可能已变)
      const latest = await this.readAll();
      const idx = next.accountId ? latest.findIndex(a => a.accountId === next.accountId) : i;
      if (idx >= 0 && idx < latest.length) {
        latest[idx] = next;
      } else {
        // 刷新期间该下标已不存在(并发删除)→ 追加,避免越界写出 sparse array
        latest.push(next);
      }
      await this.writeAll(latest);
      return { accessToken: next.accessToken, accountId: next.accountId };
    } catch (e) {
      console.error('codex token refresh failed', e);
      return null;
    }
  }

  /** 读取账号数组,兼容旧单对象格式 */
  private async readAll(): Promise<StoredAccount[]> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((a) => a && typeof a.accessToken === 'string');
      }
      if (parsed && typeof parsed.accessToken === 'string') {
        return [{
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken ?? '',
          accountId: parsed.accountId ?? '',
          email: parsed.email ?? '',
          expiresAt: parsed.expiresAt ?? 0,
        }];
      }
      return [];
    } catch {
      return [];
    }
  }

  private async writeAll(list: StoredAccount[]): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(list));
  }
}
