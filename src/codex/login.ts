import * as vscode from 'vscode';
import * as http from 'http';
import { generatePkce, randomState } from './pkce';
import { buildAuthUrl, exchangeCode } from './oauth';
import { CodexAuth } from './auth';

const CALLBACK_PORT = 1455;
const TIMEOUT_MS = 5 * 60 * 1000;

/** 走完整 OAuth 登录:起本地 server 收 callback、开浏览器、换 token、存储。成功返回 true。 */
export async function loginCodex(auth: CodexAuth): Promise<boolean> {
  const pkce = generatePkce();
  const state = randomState();

  const codePromise = waitForCallback(state);
  await vscode.env.openExternal(vscode.Uri.parse(buildAuthUrl(pkce.challenge, state)));

  let code: string;
  try {
    code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '等待 ChatGPT 授权…', cancellable: true },
      (_progress, token) => Promise.race([
        codePromise.promise,
        new Promise<string>((_, reject) => token.onCancellationRequested(() => reject(new Error('用户取消')))),
      ]),
    );
  } catch (e) {
    codePromise.close();
    vscode.window.showWarningMessage(`Codex 登录未完成: ${String((e as any)?.message ?? e)}`);
    return false;
  }

  try {
    const tok = await exchangeCode(code, pkce.verifier);
    await auth.save(tok);
    vscode.window.showInformationMessage('Codex 登录成功');
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Codex 换取 token 失败: ${String((e as any)?.message ?? e)}`);
    return false;
  }
}

interface Pending {
  promise: Promise<string>;
  close: () => void;
}

/** 起本地 server 监听 1455/auth/callback,校验 state 后 resolve code */
function waitForCallback(expectedState: string): Pending {
  let server: http.Server;
  let timer: NodeJS.Timeout;
  const promise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (!code || state !== expectedState) {
        res.end('<h3>登录失败:state 校验未通过,可关闭本页。</h3>');
        reject(new Error('state 校验失败或缺少 code'));
        return;
      }
      res.end('<h3>Codex 登录成功,可关闭本页返回编辑器。</h3>');
      resolve(code);
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT, '127.0.0.1');
    timer = setTimeout(() => reject(new Error('授权超时')), TIMEOUT_MS);
  });
  const close = () => {
    clearTimeout(timer);
    server?.close();
  };
  promise.then(close, close);
  return { promise, close };
}
