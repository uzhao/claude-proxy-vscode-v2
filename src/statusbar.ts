import * as vscode from 'vscode';
import { ProxyConfig, configuredProviders, addKey, removeKey, setMapping, addCustomProvider, updateCustomProvider, removeCustomProvider, normalizeBaseUrl } from './config';
import { PRESETS, CODEX_PLACEHOLDER_ID, resolvePreset } from './presets';
import { parseProviderModels, filterFeatured, fetchEndpointModels, ModelInfo } from './models';
import { CodexAuth } from './codex/auth';

const MRU_KEY = 'claudeProxy.recentMappings';
const MRU_MAX = 5;

export interface StatusBarDeps {
  context: vscode.ExtensionContext;
  getConfig: () => ProxyConfig;
  /** 写配置 + 同步 Claude 代理开关 + 刷新文本 */
  applyConfig: (cfg: ProxyConfig) => void;
  codexAuth: CodexAuth;
  /** 取 model catalog(含缓存),由外部注入 */
  getCatalog: () => Promise<any>;
}

export class StatusBar {
  private item: vscode.StatusBarItem;

  constructor(private deps: StatusBarDeps) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeProxy.openMenu';
    deps.context.subscriptions.push(this.item);
    this.refresh();
    this.item.show();
  }

  refresh(): void {
    const m = this.deps.getConfig().mapping;
    const label = !m || m === 'pass' ? '透传' : (m.includes(':') ? m.slice(m.indexOf(':') + 1) : m);
    this.item.text = `$(arrow-swap) Claude: ${label}`;
    this.item.tooltip = '点击切换/管理 Claude Proxy';
  }

  // ---- 一级菜单 ----
  async openMenu(): Promise<void> {
    const cfg = this.deps.getConfig();
    const recent = this.deps.context.globalState.get<string[]>(MRU_KEY, []);

    type Item = vscode.QuickPickItem & { action?: 'pass' | 'mapping' | 'provider' | 'settings'; value?: string };
    const items: Item[] = [];

    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(circle-slash) Pass(透传)', action: 'pass' });
    for (const m of recent) {
      items.push({ label: `$(history) ${m}`, action: 'mapping', value: m });
    }

    // Provider 区:有 key 的内置 + 全部自定义(无论是否有 key)
    const withKey = configuredProviders(cfg).map(p => p.name);
    const customIds = (cfg.customProviders ?? []).map(c => c.id);
    const shownNames: string[] = [...withKey];
    for (const id of customIds) {
      if (!shownNames.includes(id)) {
        shownNames.push(id);
      }
    }
    const codexCount = await this.deps.codexAuth.count();
    const codexIn = codexCount > 0;
    if (shownNames.length > 0 || codexIn) {
      items.push({ label: 'Provider', kind: vscode.QuickPickItemKind.Separator });
      const customSet = new Set(customIds);
      for (const name of shownNames) {
        const keyCount = cfg.providers.find(p => p.name === name)?.apiKeys.length ?? 0;
        const description = keyCount > 0 ? `${keyCount} key` : (customSet.has(name) ? '自定义' : '');
        items.push({ label: `$(server) ${name}`, description, action: 'provider', value: name });
      }
      if (codexIn && !shownNames.includes('codex')) {
        items.push({ label: `$(server) codex`, description: `已登录 ${codexCount} 个账号`, action: 'provider', value: 'codex' });
      }
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(gear) Provider 设置', action: 'settings' });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '切换映射目标' });
    if (!picked) {
      return;
    }
    if (picked.action === 'pass') {
      this.setMapping('pass');
    } else if (picked.action === 'mapping' && picked.value) {
      this.setMapping(picked.value);
    } else if (picked.action === 'provider' && picked.value) {
      await this.pickModel(picked.value);
    } else if (picked.action === 'settings') {
      await this.providerSettings();
    }
  }

  // ---- 二级:选 provider 的模型 ----
  private async pickModel(providerName: string, showAll = false): Promise<void> {
    const cfg = this.deps.getConfig();
    const preset = resolvePreset(cfg, providerName);
    if (!preset) {
      return;
    }

    // 自定义 provider:从 /v1/models 拉取(带可选 Bearer),拉不到则手填
    if (preset.custom) {
      const key = cfg.providers.find(p => p.name === providerName)?.apiKeys[0];
      let models: ModelInfo[];
      try {
        models = await fetchEndpointModels(preset.baseUrl, key);
      } catch (e) {
        console.warn('[proxy] custom models fetch failed:', e);
        await this.manualModel(providerName);
        return;
      }
      type CItem = vscode.QuickPickItem & { model?: string; manual?: boolean };
      const citems: CItem[] = models.map(m => ({ label: m.id, model: m.id }));
      citems.push({ label: '$(edit) 手动输入…', manual: true });
      const cpicked = await vscode.window.showQuickPick(citems, { placeHolder: `${providerName} 的模型` });
      if (!cpicked) {
        return;
      }
      if (cpicked.manual) {
        await this.manualModel(providerName);
        return;
      }
      if (cpicked.model) {
        this.setMapping(`${providerName}:${cpicked.model}`);
      }
      return;
    }

    // 内置 provider:models.dev 路径
    let models: ModelInfo[] = [];
    try {
      const catalog = await this.deps.getCatalog();
      models = parseProviderModels(catalog, preset.modelsDevId);
    } catch (e) {
      vscode.window.showErrorMessage(`获取模型失败: ${String(e)}`);
      return;
    }
    const shown = showAll ? models : filterFeatured(models);

    type Item = vscode.QuickPickItem & { model?: string; more?: boolean };
    const items: Item[] = shown.map(m => ({ label: m.id, description: m.name === m.id ? '' : m.name, model: m.id }));
    if (!showAll && models.length > shown.length) {
      items.push({ label: '$(ellipsis) Other…', more: true });
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${providerName} 的模型` });
    if (!picked) {
      return;
    }
    if (picked.more) {
      await this.pickModel(providerName, true);
    } else if (picked.model) {
      this.setMapping(`${providerName}:${picked.model}`);
    }
  }

  // ---- 手动输入模型名(自定义 provider 拉取失败或主动选择时) ----
  private async manualModel(providerName: string): Promise<void> {
    const model = await vscode.window.showInputBox({ prompt: `输入 ${providerName} 的模型名` });
    if (model && model.trim()) {
      this.setMapping(`${providerName}:${model.trim()}`);
    }
  }

  // ---- Provider 设置:内置管 key / 自定义增删改 / codex 登录登出 / 改端口 ----
  private async providerSettings(): Promise<void> {
    type Item = vscode.QuickPickItem & { id?: string; customId?: string; add?: boolean; codex?: boolean; port?: boolean };
    const cfg = this.deps.getConfig();
    const items: Item[] = PRESETS.filter(p => p.id !== 'codex').map(p => {
      const n = cfg.providers.find(x => x.name === p.id)?.apiKeys.length ?? 0;
      return { label: p.id, description: n > 0 ? `${n} key` : '未配置', id: p.id };
    });

    const customs = cfg.customProviders ?? [];
    if (customs.length > 0) {
      items.push({ label: '自定义', kind: vscode.QuickPickItemKind.Separator });
      for (const c of customs) {
        const n = cfg.providers.find(x => x.name === c.id)?.apiKeys.length ?? 0;
        items.push({ label: c.id, description: `${c.baseUrl}${n > 0 ? ` · ${n} key` : ''}`, customId: c.id });
      }
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(add) 添加自定义 provider', add: true });

    const codexCount = await this.deps.codexAuth.count();
    items.push({ label: CODEX_PLACEHOLDER_ID, description: codexCount > 0 ? `已登录 ${codexCount} 个账号` : '未登录(点击登录 ChatGPT)', codex: true });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    const curPort = vscode.workspace.getConfiguration('claudeProxy').get<number>('port', 4001);
    items.push({ label: '$(plug) 代理端口', description: `当前 ${curPort}`, port: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择 provider 管理' });
    if (!picked) {
      return;
    }
    if (picked.add) {
      await this.addCustomProviderFlow();
      return;
    }
    if (picked.port) {
      await this.changePort();
      return;
    }
    if (picked.codex) {
      await this.manageCodex();
      return;
    }
    if (picked.customId) {
      await this.manageCustomProvider(picked.customId);
      return;
    }
    if (picked.id) {
      await this.manageKeys(picked.id);
    }
  }

  // ---- codex 账号管理:逐账号登出 / OAuth 登录 / 粘贴 JSON 导入 ----
  private async manageCodex(): Promise<void> {
    type CItem = vscode.QuickPickItem & { accountId?: string; login?: boolean; import?: boolean };
    const accounts = await this.deps.codexAuth.list();
    const items: CItem[] = accounts.map(a => ({
      label: `$(account) ${a.email || a.accountId || '(unknown)'}`,
      description: '点击登出此账号',
      accountId: a.accountId,
    }));
    if (accounts.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: '$(sign-in) 登录新账号(ChatGPT OAuth)', login: true });
    items.push({ label: '$(clippy) 粘贴凭证 JSON…', import: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'codex 账号管理' });
    if (!picked) {
      return;
    }
    if (picked.login) {
      await vscode.commands.executeCommand('claudeProxy.codexLogin');
      return;
    }
    if (picked.import) {
      await vscode.commands.executeCommand('claudeProxy.codexImport');
      return;
    }
    if (picked.accountId !== undefined) {
      const name = picked.label.replace(/^\$\(account\) /, '');
      const confirm = await vscode.window.showWarningMessage(`登出 codex 账号 ${name}?`, '登出');
      if (confirm === '登出') {
        await vscode.commands.executeCommand('claudeProxy.codexLogout', picked.accountId);
      }
    }
  }

  // ---- 添加自定义 provider:输入 id + baseUrl ----
  private async addCustomProviderFlow(): Promise<void> {
    const cfg = this.deps.getConfig();
    const existing = new Set<string>([...PRESETS.map(p => p.id), ...(cfg.customProviders ?? []).map(c => c.id)]);
    const id = await vscode.window.showInputBox({
      prompt: '自定义 provider 标识(用作映射前缀,如 ollama)',
      validateInput: (v) => {
        const s = v.trim();
        if (!s) {
          return 'id 不能为空';
        }
        if (s.includes(':')) {
          return 'id 不能包含冒号';
        }
        if (existing.has(s)) {
          return `id "${s}" 已存在`;
        }
        return null;
      },
    });
    if (!id) {
      return;
    }
    const baseUrl = await vscode.window.showInputBox({
      prompt: 'Base URL(不含 /v1,例如 http://localhost:11434)',
      validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? null : '需以 http:// 或 https:// 开头'),
    });
    if (!baseUrl) {
      return;
    }
    this.deps.applyConfig(addCustomProvider(this.deps.getConfig(), { id: id.trim(), baseUrl: normalizeBaseUrl(baseUrl.trim()) }));
  }

  // ---- 管理某自定义 provider:管 key / 改 baseUrl / 删除 ----
  private async manageCustomProvider(id: string): Promise<void> {
    const cp = (this.deps.getConfig().customProviders ?? []).find(c => c.id === id);
    if (!cp) {
      return;
    }
    type Item = vscode.QuickPickItem & { act?: 'keys' | 'edit' | 'del' };
    const items: Item[] = [
      { label: '$(key) 管理 key', description: '可选,本地服务通常不需要', act: 'keys' },
      { label: '$(edit) 编辑 Base URL', description: cp.baseUrl, act: 'edit' },
      { label: '$(trash) 删除', act: 'del' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${id}(自定义)` });
    if (!picked) {
      return;
    }
    if (picked.act === 'keys') {
      await this.manageKeys(id);
      return;
    }
    if (picked.act === 'edit') {
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Base URL(不含 /v1)',
        value: cp.baseUrl,
        validateInput: (v) => (/^https?:\/\//.test(v.trim()) ? null : '需以 http:// 或 https:// 开头'),
      });
      if (baseUrl) {
        this.deps.applyConfig(updateCustomProvider(this.deps.getConfig(), id, normalizeBaseUrl(baseUrl.trim())));
      }
      return;
    }
    if (picked.act === 'del') {
      let next = removeCustomProvider(this.deps.getConfig(), id);
      if (next.mapping.split(':')[0] === id) {
        next = setMapping(next, 'pass');
      }
      this.deps.applyConfig(next);
    }
  }

  // ---- 改代理端口(写全局配置,需重载窗口生效) ----
  private async changePort(): Promise<void> {
    const cur = vscode.workspace.getConfiguration('claudeProxy').get<number>('port', 4001);
    const input = await vscode.window.showInputBox({
      prompt: '代理监听端口(1-65535),改后需重载窗口生效',
      value: String(cur),
      validateInput: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 && n < 65536 ? null : '请输入 1-65535 的整数';
      },
    });
    if (!input) {
      return;
    }
    await vscode.workspace.getConfiguration('claudeProxy').update('port', Number(input), vscode.ConfigurationTarget.Global);
    const choice = await vscode.window.showInformationMessage(`代理端口已设为 ${input},需重载窗口生效。`, '重载窗口');
    if (choice === '重载窗口') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  // ---- 管理某 provider 的 key ----
  private async manageKeys(name: string): Promise<void> {
    const cfg = this.deps.getConfig();
    const entry = cfg.providers.find(p => p.name === name);
    const keys = entry?.apiKeys ?? [];

    type Item = vscode.QuickPickItem & { add?: boolean; del?: string };
    const items: Item[] = [{ label: '$(add) 添加 key', add: true }];
    for (const k of keys) {
      items.push({ label: `$(trash) ${mask(k)}`, description: '删除', del: k });
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `${name}:管理 key` });
    if (!picked) {
      return;
    }
    if (picked.add) {
      const key = await vscode.window.showInputBox({ prompt: `输入 ${name} 的 API key`, password: true });
      if (key) {
        this.deps.applyConfig(addKey(this.deps.getConfig(), name, key.trim()));
        await this.manageKeys(name);
      }
    } else if (picked.del) {
      this.deps.applyConfig(removeKey(this.deps.getConfig(), name, picked.del));
      await this.manageKeys(name);
    }
  }

  private setMapping(mapping: string): void {
    // 刷新由 applyConfig 在 mapping 写入完成后统一负责,此处不再重复 refresh
    this.deps.applyConfig(setMapping(this.deps.getConfig(), mapping));
    if (mapping !== 'pass') {
      this.pushRecent(mapping);
    }
  }

  private pushRecent(mapping: string): void {
    const cur = this.deps.context.globalState.get<string[]>(MRU_KEY, []);
    const next = [mapping, ...cur.filter(m => m !== mapping)].slice(0, MRU_MAX);
    this.deps.context.globalState.update(MRU_KEY, next);
  }
}

function mask(k: string): string {
  if (k.length <= 8) {
    return '****';
  }
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}
