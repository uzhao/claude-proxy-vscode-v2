const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const REDIRECT_URI = 'http://localhost:1455/auth/callback';

export interface CodexToken {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

/** 构造 OAuth 授权 URL(PKCE S256) */
export function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** 用授权码换 token */
export async function exchangeCode(code: string, verifier: string, fetcher: typeof fetch = fetch): Promise<CodexToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  return postToken(body, fetcher);
}

/** 用 refresh token 换新 token */
export async function refreshToken(refresh: string, fetcher: typeof fetch = fetch): Promise<CodexToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refresh,
    scope: 'openid profile email',
  });
  return postToken(body, fetcher);
}

async function postToken(body: URLSearchParams, fetcher: typeof fetch): Promise<CodexToken> {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  } as any);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token request failed: ${res.status} ${text}`);
  }
  const j: any = await res.json();
  return {
    accessToken: j.access_token ?? '',
    refreshToken: j.refresh_token ?? '',
    idToken: j.id_token ?? '',
    expiresIn: typeof j.expires_in === 'number' ? j.expires_in : 3600,
  };
}

/** 解析 id_token(JWT,不验签)取 chatgpt_account_id;失败返回 '' */
export function parseAccountId(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return '';
    }
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? '';
  } catch {
    return '';
  }
}

/** 解析 id_token(JWT,不验签)取邮箱:优先 profile.email,回退顶层 email;失败返回 '' */
export function parseEmail(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return '';
    }
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/profile']?.email ?? claims?.email ?? '';
  } catch {
    return '';
  }
}
