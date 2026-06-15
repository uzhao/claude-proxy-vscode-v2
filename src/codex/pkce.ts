import { randomBytes, createHash } from 'node:crypto';

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

/** 生成 PKCE 码对:verifier=base64url(96 随机字节),challenge=base64url(sha256(verifier)),均无填充(RFC 7636 S256) */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(96).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** OAuth state:防 CSRF 的随机串 */
export function randomState(): string {
  return randomBytes(24).toString('base64url');
}
