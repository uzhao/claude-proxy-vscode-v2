import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import { ProxyConfig, CustomProvider } from './config';
import { ProviderKeyStore, ProviderKeys } from './providerKeys';
import { getCatalog, CatalogCache } from './models';
import { createProxyServer } from './proxy';
import { StatusBar } from './statusbar';
import { GLOBAL_SETTINGS_PATH, clearProxy, setProxy, getProxy } from './claudeSettings';
import { CodexAuth } from './codex/auth';
import { loginCodex } from './codex/login';

let server: http.Server | null = null;
let currentPort = 4001;
let statusBar: StatusBar;
const MAPPING_KEY = 'claudeProxy.mapping';

/** 读取配置的代理端口(默认 4001,固定不漂移,保证 Claude Code 端口稳定) */
function configuredPort(): number {
  const p = vscode.workspace.getConfiguration('claudeProxy').get<number>('port', 4001);
  return typeof p === 'number' && p > 0 && p < 65536 ? p : 4001;
}

function workspaceSettingsPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  return path.join(root, '.claude', 'settings.json');
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

  const MODELS_CACHE_KEY = 'claudeProxy.modelsCache';
  const MODELS_CACHE_TTL = 24 * 60 * 60 * 1000;
  const CUSTOM_PROVIDERS_KEY = 'claudeProxy.customProviders';

  // provider key:从 SecretStorage 读入内存(首启迁移旧 providers.json)
  const keyStore = new ProviderKeyStore(context.secrets);
  let providerKeys: ProviderKeys = await keyStore.load();
  providerKeys = await keyStore.migrateLegacy(providerKeys);

  const codexAuth = new CodexAuth(context.secrets);

  // models 缓存:globalState 实现(含 TTL)
  const catalogCache: CatalogCache = {
    read: () => {
      const c = context.globalState.get<{ catalog: any; fetchedAt: number }>(MODELS_CACHE_KEY);
      return c && Date.now() - c.fetchedAt < MODELS_CACHE_TTL ? c.catalog : null;
    },
    write: (catalog) => {
      context.globalState.update(MODELS_CACHE_KEY, { catalog, fetchedAt: Date.now() });
    },
  };

  // 运行时视图:mapping(workspaceState)+ providers(内存 key 缓存)
  const getConfig = (): ProxyConfig => ({
    mapping: context.workspaceState.get<string>(MAPPING_KEY, 'pass'),
    providers: Object.entries(providerKeys).map(([name, apiKeys]) => ({ name, apiKeys })),
    customProviders: context.globalState.get<CustomProvider[]>(CUSTOM_PROVIDERS_KEY, []),
  });

  // applyConfig:providers 更新内存 + 写 SecretStorage;mapping 写 workspaceState;同步代理 + 刷新;翻转才 reload
  const applyConfig = async (cfg: ProxyConfig) => {
    providerKeys = Object.fromEntries(cfg.providers.map(p => [p.name, p.apiKeys]));
    await keyStore.save(providerKeys);
    await context.workspaceState.update(MAPPING_KEY, cfg.mapping);
    await context.globalState.update(CUSTOM_PROVIDERS_KEY, cfg.customProviders ?? []);
    const flipped = syncProxy(cfg);
    statusBar.refresh();
    if (flipped) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  statusBar = new StatusBar({ context, getConfig, applyConfig, codexAuth, getCatalog: () => getCatalog(catalogCache) });

  // 注:启动时不在此同步代理 —— 端口尚未确定,统一由下方 server 'listening' 用真实端口回填

  // 命令:打开菜单(状态栏点击)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.openMenu', () => statusBar.openMenu()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.codexLogin', () => loginCodex(codexAuth)),
    vscode.commands.registerCommand('claudeProxy.codexLogout', async () => {
      await codexAuth.logoutAll();
      vscode.window.showInformationMessage('已登出 Codex');
    }),
  );

  // 启动代理 server:固定起始端口(claudeProxy.port,默认 4001),被占则递增找可用
  // —— 单项目稳定用起始端口;同机多项目窗口并行时各自往后挑,互不冲突。实际端口回填到项目 settings.json。
  server = createProxyServer({ getConfig, getCodexAuth: () => codexAuth.validAt(0) });
  const startPort = configuredPort();
  currentPort = startPort;
  let portRetries = 0;
  const tryListen = () => server!.listen(currentPort, '127.0.0.1');
  server.on('listening', () => {
    console.log(`proxy listening on http://127.0.0.1:${currentPort}`);
    syncProxy(getConfig()); // 用实际端口回填
  });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && portRetries < 20) {
      portRetries++;
      currentPort++;
      console.log(`port in use, trying ${currentPort}`);
      tryListen();
      return;
    }
    if (err.code === 'EADDRINUSE') {
      vscode.window.showErrorMessage(`Claude Proxy: 端口 ${startPort}~${currentPort} 都被占用,请修改 claudeProxy.port 后重载窗口。`);
    } else {
      console.error('server error:', err);
    }
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
