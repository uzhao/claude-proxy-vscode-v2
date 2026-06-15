import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** 全局 Claude settings 路径 —— 始终保持不含代理 */
export const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export function readSettings(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSettings(p: string, data: any): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

export function getProxy(p: string): string | undefined {
  return readSettings(p)?.env?.ANTHROPIC_BASE_URL;
}

export function setProxy(p: string, baseUrl: string): void {
  const s = readSettings(p) ?? {};
  if (!s.env) {
    s.env = {};
  }
  s.env.ANTHROPIC_BASE_URL = baseUrl;
  writeSettings(p, s);
}

export function clearProxy(p: string): void {
  const s = readSettings(p);
  if (!s?.env?.ANTHROPIC_BASE_URL) {
    return;
  }
  delete s.env.ANTHROPIC_BASE_URL;
  if (Object.keys(s.env).length === 0) {
    delete s.env;
  }
  writeSettings(p, s);
}
