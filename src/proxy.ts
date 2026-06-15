import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProxyConfig, getProvider } from './config';
import { getPreset, Preset } from './presets';

export interface Target {
  preset: Preset;
  model: string;
  apiKeys: string[];
  /** Part 1 是否能真正转发(anthropic 格式) */
  forwardable: boolean;
}

/**
 * 根据全局 mapping 解析转发目标。
 * 返回 null 表示透传(pass / 未配置 / 非法)。
 */
export function resolveTarget(cfg: ProxyConfig): Target | null {
  if (!cfg.mapping || cfg.mapping === 'pass') {
    return null;
  }
  const idx = cfg.mapping.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const name = cfg.mapping.slice(0, idx);
  const model = cfg.mapping.slice(idx + 1);
  if (!model) {
    return null;
  }
  const preset = getPreset(name);
  if (!preset) {
    return null;
  }
  const entry = getProvider(cfg, name);
  if (!entry || entry.apiKeys.length === 0) {
    return null;
  }
  return { preset, model, apiKeys: entry.apiKeys, forwardable: preset.forwardable };
}

/** 该响应状态是否应触发切换下一个 key */
export function shouldRotate(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

// ---- 日志 ----
function logDir(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'log');
}

function saveLog(enabled: boolean, request: any, response: any, error?: any): void {
  if (!enabled) {
    return;
  }
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const ts = new Date().toISOString();
    const id = Math.random().toString(36).slice(2, 15);
    const file = path.join(logDir(), `${ts.replace(/:/g, '-')}-${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, timestamp: ts, request, response, error: error ?? null }, null, 2), 'utf8');
  } catch (e) {
    console.warn('saveLog failed', e);
  }
}

export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** 是否写 JSON 日志 */
  isJsonLogging: () => boolean;
}

/**
 * 创建透传/转发代理 server。
 * - mapping=pass 或不可解析 → 透传到 api.anthropic.com
 * - anthropic 格式目标 → 换 baseUrl/model/key 转发,失败时轮换 key
 * - 非 anthropic 格式目标 → 返回 502 提示(Part 2 才支持)
 */
export function createProxyServer(deps: ProxyServerDeps): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      let requestBody: any = null;
      try {
        requestBody = JSON.parse(body.toString('utf8'));
      } catch {
        // 非 JSON,保持透传
      }

      const cfg = deps.getConfig();
      const target = resolveTarget(cfg);

      // 非 anthropic 目标:Part 1 不支持转换
      if (target && !target.forwardable) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Provider "${target.preset.id}" (${target.preset.format}) 暂不支持,等待 Part 2 的格式转换。` }));
        return;
      }

      // 计算转发 URL / body / 认证
      let targetUrl = `https://api.anthropic.com${req.url}`;
      let targetBody = body;
      const authHeaders: Record<string, string> = {};
      let apiKeys: string[] = [];

      if (target) {
        targetUrl = `${target.preset.baseUrl}${req.url}`;
        apiKeys = target.apiKeys;
        if (requestBody && target.model) {
          requestBody.model = target.model;
          targetBody = Buffer.from(JSON.stringify(requestBody), 'utf8');
        }
      }

      // 转发头(剔除代理相关 + 原认证头,后面按 key 注入)
      const baseHeaders: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['host', 'connection', 'content-length'].includes(lk)) {
          continue;
        }
        if (target && (lk === 'x-api-key' || lk === 'authorization')) {
          continue;
        }
        baseHeaders[k] = v;
      }

      const tryKeys = apiKeys.length > 0 ? apiKeys : [null];
      let lastErr: any = null;

      for (let i = 0; i < tryKeys.length; i++) {
        const key = tryKeys[i];
        const headers: Record<string, any> = { ...baseHeaders };
        if (key) {
          headers['x-api-key'] = key; // anthropic 格式
        }
        try {
          const upstream = await fetch(targetUrl, { method: 'POST', headers: headers as any, body: targetBody });

          // 命中需轮换的状态且还有下一个 key → 换 key 重试
          if (apiKeys.length > 0 && shouldRotate(upstream.status) && i < tryKeys.length - 1) {
            console.warn(`key #${i} 失败(${upstream.status}),切换下一个`);
            continue;
          }

          // 转发响应头
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of upstream.headers.entries()) {
            const lk = k.toLowerCase();
            if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lk)) {
              continue;
            }
            respHeaders[k] = v;
          }
          if (!respHeaders['content-type']) {
            respHeaders['content-type'] = 'application/json';
          }
          res.writeHead(upstream.status, respHeaders);

          const collected: Uint8Array[] = [];
          const reader = upstream.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              collected.push(value);
              res.write(value);
            }
          }
          res.end();

          saveLog(deps.isJsonLogging(),
            { url: req.url, model: requestBody?.model, mapping: cfg.mapping },
            { status: upstream.status, bytes: Buffer.concat(collected).length });
          return;
        } catch (err) {
          lastErr = err;
          if (apiKeys.length > 0 && i < tryKeys.length - 1) {
            console.warn(`key #${i} 网络错误,切换下一个`, err);
            continue;
          }
        }
      }

      // 全部失败
      console.error('代理错误:', lastErr);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(lastErr?.message ?? lastErr) }));
      saveLog(deps.isJsonLogging(), { url: req.url, mapping: cfg.mapping }, null, String(lastErr));
    });
  });
}
