import * as vscode from 'vscode';
import { ProxyConfig, configuredProviders, addKey, removeKey, setMapping } from './config';
import { PRESETS, CODEX_PLACEHOLDER_ID, getPreset } from './presets';
import { getCatalog, parseProviderModels, filterFeatured, ModelInfo } from './models';

const MRU_KEY = 'claudeProxy.recentMappings';
const MRU_MAX = 5;

export interface StatusBarDeps {
  context: vscode.ExtensionContext;
  getConfig: () => ProxyConfig;
  /** 写配置 + 同步 Claude 代理开关 + 刷新文本 */
  applyConfig: (cfg: ProxyConfig) => void;
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

    const provs = configuredProviders(cfg);
    if (provs.length > 0) {
      items.push({ label: 'Provider', kind: vscode.QuickPickItemKind.Separator });
      for (const p of provs) {
        items.push({ label: `$(server) ${p.name}`, description: `${p.apiKeys.length} key`, action: 'provider', value: p.name });
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
    const preset = getPreset(providerName);
    if (!preset) {
      return;
    }
    let models: ModelInfo[] = [];
    try {
      const catalog = await getCatalog();
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

  // ---- Provider 设置:选 provider → 管理 key ----
  private async providerSettings(): Promise<void> {
    type Item = vscode.QuickPickItem & { id?: string; codex?: boolean };
    const cfg = this.deps.getConfig();
    const items: Item[] = PRESETS.map(p => {
      const n = cfg.providers.find(x => x.name === p.id)?.apiKeys.length ?? 0;
      return { label: p.id, description: n > 0 ? `${n} key` : '未配置', id: p.id };
    });
    items.push({ label: `${CODEX_PLACEHOLDER_ID}`, description: '需登录(后续支持)', codex: true });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择 provider 管理 key' });
    if (!picked) {
      return;
    }
    if (picked.codex) {
      vscode.window.showInformationMessage('Codex 登录将在后续版本支持。');
      return;
    }
    if (picked.id) {
      await this.manageKeys(picked.id);
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
