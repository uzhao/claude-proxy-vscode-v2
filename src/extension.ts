import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { ProxyConfig, ensureProviders, readProviders, writeProviders, configPath } from './config';
import { createProxyServer } from './proxy';
import { StatusBar } from './statusbar';
import { GLOBAL_SETTINGS_PATH, clearProxy, setProxy, getProxy } from './claudeSettings';
import { CodexAuth } from './codex/auth';
import { loginCodex } from './codex/login';

let server: http.Server | null = null;
let currentPort = 4001;
let statusBar: StatusBar;
const MAPPING_KEY = 'claudeProxy.mapping';

function randomPort(): number {
  return Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024;
}

function workspaceSettingsPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  return path.join(root, '.claude', 'settings.json');
}

function isJsonLogging(): boolean {
  return vscode.workspace.getConfiguration('claudeProxy').get<boolean>('enableJsonLogging', false);
}

/** 按当前 mapping 同步项目级 Claude 代理开关;返回代理开关是否发生翻转 */
function syncProxy(cfg: ProxyConfig): boolean {
  clearProxy(GLOBAL_SETTINGS_PATH); // 全局始终不带代理
  const wsPath = workspaceSettingsPath();
  const had = !!getProxy(wsPath);
  const want = !!cfg.mapping && cfg.mapping !== 'pass';
  if (want) {
    setProxy(wsPath, `http://127.0.0.1:${currentPort}`);
  } else {
    clearProxy(wsPath);
  }
  return had !== want;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Claude Proxy activating...');

  ensureProviders();

  // 组合运行时视图:mapping(本项目 workspaceState)+ providers(全局 providers.json)
  const getConfig = (): ProxyConfig => ({
    mapping: context.workspaceState.get<string>(MAPPING_KEY, 'pass'),
    providers: readProviders(),
  });

  // applyConfig:拆分落地(providers→全局文件,mapping→本项目)+ 同步代理 + 刷新;开关翻转才 reload
  // 必须 await mapping 写入再 reload —— 否则窗口可能在持久化前重载,导致 per-project mapping 丢失
  const applyConfig = async (cfg: ProxyConfig) => {
    writeProviders(cfg.providers);
    await context.workspaceState.update(MAPPING_KEY, cfg.mapping);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({ context, getConfig, applyConfig });

  const codexAuth = new CodexAuth(context.secrets);

  // 注:启动时不在此同步代理 —— 端口尚未确定,统一由下方 server 'listening' 用真实端口回填

  // 命令:打开菜单(状态栏点击)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.openMenu', () => statusBar.openMenu()),
  );
  // 命令:编辑配置文件(高级入口)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.editConfig', async () => {
      const doc = await vscode.workspace.openTextDocument(configPath());
      vscode.window.showTextDocument(doc);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.codexLogin', () => loginCodex(codexAuth)),
    vscode.commands.registerCommand('claudeProxy.codexLogout', async () => {
      await codexAuth.logout();
      vscode.window.showInformationMessage('已登出 Codex');
    }),
  );

  // 启动代理 server(随机端口,冲突漂移)
  server = createProxyServer({ getConfig, isJsonLogging, getCodexAuth: () => codexAuth.getValid() });
  let retries = 0;
  const tryListen = () => {
    currentPort = randomPort();
    server!.listen(currentPort, '127.0.0.1');
  };
  server.on('listening', () => {
    console.log(`proxy listening on http://127.0.0.1:${currentPort}`);
    syncProxy(getConfig()); // 用真实端口回填
  });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && retries < 10) {
      retries++;
      console.log(`port ${currentPort} in use, retrying`);
      tryListen();
      return;
    }
    console.error('server error:', err);
    server = null;
  });
  tryListen();

  context.subscriptions.push({
    dispose: () => {
      if (server) {
        server.close();
      }
    },
  });
}

export function deactivate(): void {
  if (server) {
    server.close();
  }
}
