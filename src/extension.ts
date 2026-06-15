import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { ProxyConfig, ensureConfig, readConfig, writeConfig, configPath } from './config';
import { createProxyServer } from './proxy';
import { StatusBar } from './statusbar';
import { GLOBAL_SETTINGS_PATH, clearProxy, setProxy, getProxy } from './claudeSettings';

let server: http.Server | null = null;
let currentPort = 4001;
let statusBar: StatusBar;

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

  ensureConfig();

  // applyConfig:写盘 + 同步代理 + 刷新状态栏;代理开关翻转时重载窗口
  const applyConfig = (cfg: ProxyConfig) => {
    writeConfig(cfg);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({
    context,
    getConfig: () => readConfig(),
    applyConfig,
  });

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

  // 启动代理 server(随机端口,冲突漂移)
  server = createProxyServer({ getConfig: () => readConfig(), isJsonLogging });
  let retries = 0;
  const tryListen = () => {
    currentPort = randomPort();
    server!.listen(currentPort, '127.0.0.1');
  };
  server.on('listening', () => {
    console.log(`proxy listening on http://127.0.0.1:${currentPort}`);
    syncProxy(readConfig()); // 用真实端口回填
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
