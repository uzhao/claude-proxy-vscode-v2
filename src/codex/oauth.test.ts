import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthUrl, exchangeCode, refreshToken, parseAccountId, REDIRECT_URI } from './oauth';

test('buildAuthUrl 含必需参数', () => {
  const url = new URL(buildAuthUrl('chal123', 'state456'));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge'), 'chal123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state456');
  assert.equal(url.searchParams.get('scope'), 'openid email profile offline_access');
});

test('exchangeCode 发送正确表单并解析 token', async () => {
  let captured: any = null;
  const fakeFetch = (async (url: string, opts: any) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  const tok = await exchangeCode('the_code', 'the_verifier', fakeFetch);
  assert.equal(captured.url, 'https://auth.openai.com/oauth/token');
  const form = new URLSearchParams(captured.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'the_code');
  assert.equal(form.get('code_verifier'), 'the_verifier');
  assert.equal(tok.accessToken, 'at');
  assert.equal(tok.refreshToken, 'rt');
  assert.equal(tok.idToken, 'idt');
  assert.equal(tok.expiresIn, 3600);
});

test('refreshToken 用 refresh_token 授权类型', async () => {
  let body = '';
  const fakeFetch = (async (_url: string, opts: any) => {
    body = opts.body;
    return { ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'newrt', id_token: 'i', expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  const tok = await refreshToken('old_rt', fakeFetch);
  const form = new URLSearchParams(body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old_rt');
  assert.equal(tok.accessToken, 'new');
});

test('exchangeCode 失败抛错', async () => {
  const fakeFetch = (async () => ({ ok: false, status: 400, text: async () => 'bad' })) as unknown as typeof fetch;
  await assert.rejects(() => exchangeCode('c', 'v', fakeFetch), /400/);
});

test('parseAccountId 从 id_token 取 chatgpt_account_id', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_1' }, email: 'a@b.c' })).toString('base64url');
  const idToken = `header.${payload}.sig`;
  assert.equal(parseAccountId(idToken), 'acc_1');
  assert.equal(parseAccountId('bad'), '');
});
