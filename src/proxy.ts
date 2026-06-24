import * as http from 'http';
import { ProxyConfig, getProvider } from './config';
import { resolvePreset, Preset } from './presets';
import { getTranslator } from './translate/registry';
import { SSEParser } from './translate/sse';
import { planOpenAIRequest, extractResponsesUsage, OpenAIPlan, Pool, OpenAIOfficialSettings } from './openai/freeTokens';

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
  const preset = resolvePreset(cfg, name);
  if (!preset) {
    return null;
  }
  const entry = getProvider(cfg, name);
  const apiKeys = entry?.apiKeys ?? [];
  // codex 用 OAuth 登录、自定义 provider 可 keyless(由 baseUrl 直接转发);其余 provider 必须至少有一个 key
  if (preset.id !== 'codex' && !preset.custom && apiKeys.length === 0) {
    return null;
  }
  return { preset, model, apiKeys, forwardable: preset.forwardable };
}

/** 该响应状态是否应触发切换下一个 key */
export function shouldRotate(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

/** 从 startIndex(对 count 取模)起、长度 count 的轮转下标序列;count<=0 返回 [] */
export function pickCodexSequence(count: number, startIndex: number): number[] {
  if (count <= 0) {
    return [];
  }
  const start = ((startIndex % count) + count) % count;
  const seq: number[] = [];
  for (let off = 0; off < count; off++) {
    seq.push((start + off) % count);
  }
  return seq;
}

/** 构造 Anthropic 标准错误响应体 */
function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

/** codex 多账号访问接口:计数 / 游标 / 按下标取有效凭证 / 标记成功 */
export interface CodexAccess {
  count(): Promise<number>;
  startIndex(): number;
  validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>;
  markSuccess(i: number): void;
}

/** openai 官方免费额度访问:读设置 / 读当日用量 / 累加用量 */
export interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
}

export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** codex 多账号凭证访问;未登录时 count() 返回 0 */
  codex?: CodexAccess;
  /** openai 官方免费额度访问;未注入则不做额度限制 */
  openai?: OpenAIAccess;
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
      res.writeHead(405, { 'Allow': 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks);
        let requestBody: any = null;
        try {
          requestBody = JSON.parse(body.toString('utf8'));
        } catch {
          // 非 JSON,保持透传
        }

        const cfg = deps.getConfig();
        const target = resolveTarget(cfg);

        // 解析转换器:有 target 且该格式支持转换则走转换转发;anthropic 格式无 translator,走原样转发
        const translator = target ? getTranslator(target.preset) : null;

        // 有 target 但格式尚不支持(如 gemini)→ Anthropic 标准错误
        if (target && !target.forwardable) {
          console.warn(`[proxy] format "${target.preset.format}" not supported yet (provider=${target.preset.id})`);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(anthropicError('invalid_request_error',
            `Provider "${target.preset.id}" (${target.preset.format}) 暂不支持,等待后续版本的格式转换。`));
          return;
        }

        // 计算转发 URL / body / 认证
        let targetUrl = `https://api.anthropic.com${req.url}`;
        let targetBody = body;
        let apiKeys: string[] = [];
        // openai 流式 usage 回写时需要知道命中了哪个计量池
        let openaiPool: Pool | null = null;

        if (target) {
          apiKeys = target.apiKeys;
          if (translator) {
            // 格式转换路径(openai 系):换端点 + 请求体转换
            targetUrl = `${target.preset.baseUrl}${translator.endpointPath}`;
            const upstreamBody = translator.buildRequest(requestBody ?? {}, target.model);
            // openai 官方:免费额度决策(停用 / flex 注入 / 计量池)
            if (target.preset.id === 'openai' && deps.openai) {
              const plan: OpenAIPlan = planOpenAIRequest(
                target.model, deps.openai.settings(), (p) => deps.openai!.used(p),
              );
              if (!plan.allowed) {
                const msg = plan.pool
                  ? `OpenAI daily free quota exhausted (${plan.pool} pool), resets at UTC 00:00.`
                  : `Model "${target.model}" is not eligible for OpenAI free quota.`;
                console.warn(`[proxy] openai blocked: ${msg}`);
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(anthropicError('rate_limit_error', msg));
                return;
              }
              openaiPool = plan.pool;
              if (plan.flex) {
                (upstreamBody as any).service_tier = 'flex';
              }
            }
            targetBody = Buffer.from(JSON.stringify(upstreamBody), 'utf8');
          } else {
            // 原样转发路径(anthropic 系):仅换 baseUrl/model
            targetUrl = `${target.preset.baseUrl}${req.url}`;
            if (requestBody && target.model) {
              requestBody.model = target.model;
              targetBody = Buffer.from(JSON.stringify(requestBody), 'utf8');
            }
          }
        }
        console.log(`[proxy] mapping=${cfg.mapping} → ${target ? target.preset.format : 'passthrough'} ${targetUrl} (keys=${apiKeys.length}, translate=${!!translator})`);

        // 转发头(剔除代理相关 + 原认证头,后面按 key 注入)
        const baseHeaders: Record<string, any> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          // accept-encoding 一并剔除:强制上游返回明文,避免转换/转发链路出现压缩编码不一致(ZlibError)
          if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lk)) {
            continue;
          }
          if (target && (lk === 'x-api-key' || lk === 'authorization')) {
            continue;
          }
          baseHeaders[k] = v;
        }
        if (translator) {
          baseHeaders['content-type'] = 'application/json';
        }

        // codex:多账号轮换(从游标起,遇 401/429/5xx 换下一个账号)
        if (target && target.preset.id === 'codex') {
          const codex = deps.codex;
          const n = codex ? await codex.count() : 0;
          if (!codex || n === 0) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(anthropicError('authentication_error', 'codex 未登录,请在 Provider 设置中登录 ChatGPT。'));
            return;
          }
          const seq = pickCodexSequence(n, codex.startIndex());
          let lastErr: any = null;
          for (let s = 0; s < seq.length; s++) {
            const idx = seq[s];
            const auth = await codex.validAt(idx);
            if (!auth) {
              lastErr = new Error(`codex account #${idx} unavailable`);
              continue;
            }
            const codexHeaders: Record<string, any> = {
              ...baseHeaders,
              'authorization': `Bearer ${auth.accessToken}`,
              'chatgpt-account-id': auth.accountId,
              'originator': 'codex-tui',
              'accept': 'text/event-stream',
            };
            try {
              const upstream = await fetch(targetUrl, { method: 'POST', headers: codexHeaders as any, body: targetBody });
              console.log(`[proxy] codex upstream status ${upstream.status} (account #${idx})`);

              if (shouldRotate(upstream.status) && s < seq.length - 1) {
                console.warn(`[proxy] codex account #${idx} failed (${upstream.status}), rotating`);
                await upstream.body?.cancel();
                continue;
              }

              if (upstream.status >= 400) {
                const errText = await upstream.text();
                res.writeHead(upstream.status, { 'content-type': 'application/json' });
                res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
                return;
              }

              codex.markSuccess(idx);
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
              const parser = new SSEParser();
              const stream = translator!.createStreamTranslator();
              const reader = upstream.body?.getReader();
              const decoder = new TextDecoder();
              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }
                  for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    for (const event of stream.push(payload)) {
                      if (!res.write(event)) {
                        await new Promise<void>(resolve => res.once('drain', resolve));
                      }
                    }
                  }
                }
              }
              res.end();
              return;
            } catch (err) {
              lastErr = err;
              if (s < seq.length - 1) {
                console.warn(`[proxy] codex account #${idx} network error, rotating`, err);
                continue;
              }
            }
          }

          console.error('[proxy] codex all accounts failed:', lastErr);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(anthropicError('api_error', String(lastErr?.message ?? lastErr)));
          return;
        }

        const tryKeys = apiKeys.length > 0 ? apiKeys : [null];
        let lastErr: any = null;

        for (let i = 0; i < tryKeys.length; i++) {
          const key = tryKeys[i];
          const headers: Record<string, any> = { ...baseHeaders };
          if (key) {
            if (translator) {
              Object.assign(headers, translator.authHeader(key));
            } else {
              headers['x-api-key'] = key; // anthropic 格式
            }
          }
          try {
            const upstream = await fetch(targetUrl, { method: 'POST', headers: headers as any, body: targetBody });
            console.log(`[proxy] upstream status ${upstream.status} (key #${i})`);

            // 命中需轮换的状态且还有下一个 key → 换 key 重试
            if (apiKeys.length > 0 && shouldRotate(upstream.status) && i < tryKeys.length - 1) {
              console.warn(`[proxy] key #${i} failed (${upstream.status}), rotating`);
              await upstream.body?.cancel();
              continue;
            }

            // 上游错误:统一 Anthropic 错误格式返回
            if (upstream.status >= 400) {
              const errText = await upstream.text();
              console.error(`[proxy] upstream error ${upstream.status}: ${errText.slice(0, 500)}`);
              res.writeHead(upstream.status, { 'content-type': 'application/json' });
              res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
              return;
            }

            if (translator) {
              // 格式转换:边收上游 SSE 边转 Anthropic SSE
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
              const parser = new SSEParser();
              const stream = translator.createStreamTranslator();
              const reader = upstream.body?.getReader();
              const decoder = new TextDecoder();
              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }
                  for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    // openai 官方:从流式响应中提取 usage 并回写当日用量
                    if (openaiPool && deps.openai) {
                      const u = extractResponsesUsage(payload);
                      if (u != null) {
                        deps.openai.add(openaiPool, u);
                      }
                    }
                    for (const event of stream.push(payload)) {
                      if (!res.write(event)) {
                        await new Promise<void>(resolve => res.once('drain', resolve));
                      }
                    }
                  }
                }
              }
              res.end();
              return;
            }

            // 原样转发响应头 + body(anthropic 路径)
            // 剔除 content-encoding:fetch 已自动解压 body,保留该头会让客户端再次解压明文而报 ZlibError
            const respHeaders: Record<string, string> = {};
            for (const [k, v] of upstream.headers.entries()) {
              const lk = k.toLowerCase();
              if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(lk)) {
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
                if (!res.write(value)) {
                  await new Promise<void>(resolve => res.once('drain', resolve));
                }
              }
            }
            res.end();
            return;
          } catch (err) {
            lastErr = err;
            if (apiKeys.length > 0 && i < tryKeys.length - 1) {
              console.warn(`[proxy] key #${i} network error, rotating`, err);
              continue;
            }
          }
        }

        // 全部失败
        console.error('[proxy] all attempts failed:', lastErr);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(anthropicError('api_error', String(lastErr?.message ?? lastErr)));
      } catch (err) {
        console.error('proxy handler error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: String((err as any)?.message ?? err) }));
      }
    });
  });
}
