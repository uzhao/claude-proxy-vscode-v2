import * as http from 'http';
import { ProxyConfig, getProvider } from './config';
import { resolvePreset, Preset } from './presets';
import { getTranslator, Translator } from './translate/registry';
import { SSEParser, sseEvent } from './translate/sse';
import { collectMessage } from './translate/collect';
import { Logger, RequestLog, nullLogger } from './reqlog';
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
  return { preset, model, apiKeys, forwardable: preset.forwardable };
}

/** 该响应状态是否应触发切换下一个 key */
export function shouldRotate(status: number): boolean {
  return status === 401 || status === 429 || status >= 500;
}

/** AMD Chat Completions 以顶层 reasoning_effort 开启推理。 */
export function applyAmdChatCompatibility(baseUrl: string, upstreamBody: any, claudeBody: any): void {
  if (!/^https:\/\/developer\.amd\.com\.cn\/radeon\/api\/?$/i.test(baseUrl)) {
    return;
  }
  const effort = thinkingToAmdEffort(claudeBody?.thinking, claudeBody?.output_config);
  if (effort) {
    upstreamBody.reasoning_effort = effort;
  }
}

/** Claude thinking 配置 → AMD 支持的 Chat Completions reasoning_effort。 */
function thinkingToAmdEffort(thinking: any, outputConfig: any): string | undefined {
  if (!thinking || typeof thinking !== 'object') {
    return undefined;
  }
  switch (thinking.type) {
    case 'enabled':
      return budgetToAmdEffort(typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : -1);
    case 'adaptive':
    case 'auto': {
      const effort = outputConfig?.effort;
      return typeof effort === 'string' && effort.trim() ? effort.trim().toLowerCase() : 'high';
    }
    case 'disabled':
      return 'none';
    default:
      return undefined;
  }
}

function budgetToAmdEffort(budget: number): string {
  if (budget < 0) {
    return 'medium';
  }
  if (budget <= 4096) {
    return 'low';
  }
  if (budget <= 16384) {
    return 'medium';
  }
  return 'high';
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

/** 构造 Anthropic 标准错误 SSE 帧(流已开头、改不了状态码时用) */
function anthropicErrorEvent(type: string, message: string): string {
  return sseEvent('error', { type: 'error', error: { type, message } });
}

/**
 * 粗估 token 数(按字符数 /4)。仅用于本地兜底 /v1/messages/count_tokens ——
 * OpenAI 系没有对应端点,不做这个兜底就会被当成一次完整补全打到上游。
 */
export function estimateTokens(body: any): number {
  if (!body || typeof body !== 'object') {
    return 0;
  }
  const text = [body.system, body.messages, body.tools]
    .filter(v => v != null)
    .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join('');
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * 流式空闲心跳控制器:SSE 转发循环中每次收到上游字节后调用 touch(),
 * 上游静默超过 idleMs 时向下游发标准 Anthropic ping 帧,
 * 避免 Claude Code 客户端 180s 空闲看门狗("stream idle: no bytes")掐断连接。
 * 流结束时必须调用 stop() 清理计时器。
 */
export function createIdlePing(res: http.ServerResponse, idleMs: number): { touch(): void; stop(): void } {
  // 标准 Anthropic SSE ping 事件(与 api.anthropic.com 流式响应中的心跳帧一致)
  const PING_EVENT = 'event: ping\ndata: {"type":"ping"}\n\n';
  if (idleMs <= 0) {
    return { touch: () => {}, stop: () => {} };
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // 客户端提前断开时转发循环可能仍挂在 reader.read() 上,
  // 监听 close 兜底停表,防止计时器泄漏拖住进程退出
  res.on('close', () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  const fire = (): void => {
    timer = null;
    if (!res.writableEnded && res.writable && !stopped) {
      res.write(PING_EVENT);
      touch();
    }
  };
  // touch 必须真正"重置"空闲计时:之前的实现在已有计时器时直接 return,
  // 导致上游正常推流时也会每 idleMs 插一个多余的 ping。
  const touch = (): void => {
    if (stopped) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fire, idleMs);
  };
  return {
    touch,
    stop: (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * 上游停摆看门狗:超过 ms 没有产出任何**可翻译事件**就触发 onStall。
 * 注意心跳 ping 不重置它 —— 否则上游彻底静默时永远不会触发。
 * ms<=0 表示关闭。
 */
export function createStallGuard(ms: number, onStall: () => void): { touch(): void; stop(): void } {
  if (ms <= 0) {
    return { touch: () => {}, stop: () => {} };
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const touch = (): void => {
    if (stopped) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) {
        onStall();
      }
    }, ms);
  };
  return {
    touch,
    stop: (): void => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** codex 多账号访问接口:计数 / 游标 / 按下标取有效凭证 / 标记成功 */
export interface CodexAccess {
  count(): Promise<number>;
  startIndex(): number;
  validAt(i: number): Promise<{ accessToken: string; accountId: string } | null>;
  markSuccess(i: number): void;
}

/** openai 官方免费额度访问:读设置 / 读当日用量 / 累加用量 / 读上次用量估计 */
export interface OpenAIAccess {
  settings(): OpenAIOfficialSettings;
  used(p: Pool): number;
  add(p: Pool, tokens: number): void;
  estimate(p: Pool): number;
}

/** 流式空闲心跳默认间隔:远小于 Claude Code 客户端 180s 空闲看门狗 */
const DEFAULT_IDLE_PING_MS = 15_000;
/** 上游停摆默认上限:超过这么久没吐出任何可翻译事件就判死,避免心跳把连接无限吊着 */
const DEFAULT_STALL_MS = 10 * 60_000;

export interface ProxyServerDeps {
  /** 读取当前配置(每次请求实时读,保证热更新) */
  getConfig: () => ProxyConfig;
  /** 流式空闲心跳间隔(ms):超过该时长没有向下游写任何字节时,主动发标准 Anthropic ping 帧;<=0 关闭 */
  idlePingMs?: number;
  /** 上游停摆上限(ms):超过该时长没有产出任何可翻译事件就中断并报错;<=0 关闭 */
  stallMs?: number;
  /** 请求日志(默认不记);出问题时按请求翻 jsonl 就能定位是上游没吐还是转换没转出来 */
  log?: Logger;
  /** codex 多账号凭证访问;未登录时 count() 返回 0 */
  codex?: CodexAccess;
  /** openai 官方免费额度访问;未注入则不做额度限制 */
  openai?: OpenAIAccess;
}

/** 一次翻译转发所需的全部上下文 */
interface RelayArgs {
  res: http.ServerResponse;
  upstream: Response;
  translator: Translator;
  /** 客户端是否要求流式(Anthropic 语义:stream 缺省即非流式) */
  wantStream: boolean;
  idlePingMs: number;
  stallMs: number;
  log: RequestLog;
  finish: (data: Record<string, unknown>) => void;
  /** 每个上游 data 负载的旁路钩子(openai 官方用来回写用量) */
  onPayload?: (payload: string) => void;
}

/**
 * 把上游 SSE 翻译成 Anthropic 响应回给客户端。
 *
 * 无论客户端要不要流,上游一律走流式(复用同一套 translator,不为每种 provider
 * 再写一遍非流式转换);客户端要非流式时把翻译出来的事件聚合回一个 Messages JSON。
 */
async function relayTranslated(a: RelayArgs): Promise<void> {
  const { res, upstream, translator, wantStream, log, finish } = a;

  // 上游 200 但不是 SSE:多半是网关把错误塞进 200 的 JSON 里。
  // 读全文落日志后显式报 502 —— 比按 SSE 解析出 0 事件、静默回一个空流可诊断得多。
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('event-stream')) {
    const text = await upstream.text().catch(() => '');
    log.event('upstream_body', { contentType, text });
    console.error(`[proxy] upstream 200 but content-type="${contentType}", not an event stream`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(anthropicError('upstream_error',
      `Upstream returned 200 with content-type "${contentType || 'unknown'}" instead of an event stream: ${text.slice(0, 2000)}`));
    finish({ events: 0, reason: 'upstream_not_sse' });
    return;
  }

  const parser = new SSEParser();
  const stream = translator.createStreamTranslator();
  const reader = upstream.body?.getReader();
  const decoder = new TextDecoder();
  const collected: string[] = [];
  let events = 0;
  let stalled = false;

  const stall = createStallGuard(a.stallMs, () => {
    stalled = true;
    console.error(`[proxy] upstream stalled: no translatable events for ${a.stallMs}ms`);
    void reader?.cancel().catch(() => {});
  });
  // 流式:头先发出去,并武装心跳(上游首字节前也可能长时间静默)
  const ping = wantStream ? createIdlePing(res, a.idlePingMs) : null;
  if (wantStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    ping!.touch();
  }
  stall.touch();

  // 客户端提前断开时转发循环还挂在 reader.read() 上,不主动 cancel 的话
  // 上游连接与 stall 计时器会一直吊着(最长 stallMs)。
  res.on('close', () => {
    stall.stop();
    void reader?.cancel().catch(() => {});
  });

  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        ping?.touch();
        const text = decoder.decode(value, { stream: true });
        log.event('upstream_chunk', { text });
        for (const payload of parser.push(text)) {
          a.onPayload?.(payload);
          for (const event of stream.push(payload)) {
            events++;
            stall.touch(); // 只有真正产出事件才算"上游还活着"
            log.event('downstream_chunk', { text: event });
            if (wantStream) {
              if (!res.write(event)) {
                await new Promise<void>(resolve => res.once('drain', resolve));
              }
            } else {
              collected.push(event);
            }
          }
        }
      }
    }
  } catch (err) {
    // reader.cancel() 会让挂起的 read 直接结束;其余网络异常也落到这里
    log.event('stream_error', { message: String((err as any)?.message ?? err) });
  } finally {
    ping?.stop();
    stall.stop();
  }

  // 客户端已经断开(或响应已收尾)时什么都别写,否则 writeHead/write 会抛
  if (res.writableEnded || !res.writable) {
    finish({ events, stalled, aborted: true });
    return;
  }

  if (wantStream) {
    // 头已经发出去了,状态码改不了,只能用 error 帧告诉客户端到底怎么了。
    // 不发这一帧的话客户端只会看到一个空流,报 StreamNoEventsError。
    if (stalled) {
      res.write(anthropicErrorEvent('api_error',
        `Upstream stalled: no translatable events for ${a.stallMs}ms.`));
    } else if (events === 0) {
      res.write(anthropicErrorEvent('api_error',
        'Upstream returned an event stream with no translatable events. See proxy request log for the raw upstream body.'));
    }
    res.end();
    finish({ events, stalled });
    return;
  }

  if (stalled) {
    res.writeHead(504, { 'content-type': 'application/json' });
    res.end(anthropicError('api_error', `Upstream stalled: no translatable events for ${a.stallMs}ms.`));
    finish({ events, stalled });
    return;
  }

  const { status, body } = collectMessage(collected);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  finish({ events, status });
}

/**
 * 创建透传/转发代理 server。
 * - mapping=pass 或不可解析 → 透传到 api.anthropic.com
 * - anthropic 格式目标 → 换 baseUrl/model/key 转发,失败时轮换 key
 * - openai 格式目标 → 翻译转发(上游恒流式,按客户端 stream 字段决定回流还是回 JSON)
 */
export function createProxyServer(deps: ProxyServerDeps): http.Server {
  const idlePingMs = deps.idlePingMs ?? DEFAULT_IDLE_PING_MS;
  const stallMs = deps.stallMs ?? DEFAULT_STALL_MS;
  const logger = deps.log ?? nullLogger;

  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    const log = logger.begin({ method: req.method, url: req.url ?? '' });
    let ended = false;
    const finish = (data: Record<string, unknown>): void => {
      if (ended) {
        return;
      }
      ended = true;
      log.end({ status: res.statusCode, ...data });
    };
    // 客户端提前断开等异常路径的兜底收尾
    res.on('close', () => finish({ aborted: !res.writableEnded }));

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
        log.event('request', {
          url: req.url,
          headers: req.headers as Record<string, any>,
          body: requestBody ?? body.toString('utf8'),
        });

        // Anthropic 语义:stream 缺省即非流式。之前翻译路径完全无视这个字段一律回 SSE,
        // 导致客户端的非流式重试报 "the non-streaming request was answered with a stream"。
        const wantStream = requestBody?.stream === true;

        const cfg = deps.getConfig();
        const target = resolveTarget(cfg);

        // 目标 Provider 未配置 API Key(且非 codex / 非 keyless 自定义 provider) → Anthropic 标准 401 错误
        if (target && target.preset.id !== 'codex' && !target.preset.custom && target.apiKeys.length === 0) {
          console.warn(`[proxy] provider "${target.preset.id}" has no api keys configured`);
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(anthropicError('authentication_error',
            `Provider "${target.preset.id}" 未配置 API Key,请在 Provider 设置中添加。`));
          finish({ reason: 'no_api_keys' });
          return;
        }

        // 解析转换器:有 target 且该格式支持转换则走转换转发;anthropic 格式无 translator,走原样转发
        const translator = target ? getTranslator(target.preset) : null;

        // 有 target 但格式尚不支持(如 gemini)→ Anthropic 标准错误
        if (target && !target.forwardable) {
          console.warn(`[proxy] format "${target.preset.format}" not supported yet (provider=${target.preset.id})`);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(anthropicError('invalid_request_error',
            `Provider "${target.preset.id}" (${target.preset.format}) 暂不支持,等待后续版本的格式转换。`));
          finish({ reason: 'not_forwardable' });
          return;
        }

        // count_tokens 是 Anthropic 专属端点,OpenAI 系没有对应接口。翻译路径下
        // targetUrl 只认 translator.endpointPath,不拦的话会被当成一次完整补全打到
        // /v1/chat/completions —— 白烧 token 且返回格式不对。这里本地粗估直接回。
        if (translator && req.url?.endsWith('/count_tokens')) {
          const input_tokens = estimateTokens(requestBody);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens }));
          finish({ reason: 'count_tokens_local', input_tokens });
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
            if (target.preset.api === 'chat') {
              applyAmdChatCompatibility(target.preset.baseUrl, upstreamBody, requestBody);
            }
            // openai 官方:免费额度决策(停用 / flex 注入 / 计量池)
            if (target.preset.id === 'openai' && deps.openai) {
              const plan: OpenAIPlan = planOpenAIRequest(
                target.model,
                deps.openai.settings(),
                (p) => deps.openai!.used(p),
                (p) => deps.openai!.estimate(p),
              );
              if (!plan.allowed) {
                const msg = plan.pool
                  ? `OpenAI daily free quota exhausted (${plan.pool} pool), resets at UTC 00:00.`
                  : `Model "${target.model}" is not eligible for OpenAI free quota.`;
                console.warn(`[proxy] openai blocked: ${msg}`);
                res.writeHead(429, { 'content-type': 'application/json' });
                res.end(anthropicError('rate_limit_error', msg));
                finish({ reason: 'openai_quota' });
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
        console.log(`[proxy] mapping=${cfg.mapping} → ${target ? target.preset.format : 'passthrough'} ${targetUrl} (keys=${apiKeys.length}, translate=${!!translator}, stream=${wantStream})`);

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

        /** 上游请求落日志(body 已是最终发出去的那份) */
        const logUpstreamRequest = (url: string, headers: Record<string, any>, tag: string): void => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(targetBody.toString('utf8'));
          } catch {
            parsed = targetBody.toString('utf8');
          }
          log.event('upstream_request', { url, headers, body: parsed, via: tag });
        };

        /** 上游响应头落日志 */
        const logUpstreamResponse = (upstream: Response, tag: string): void => {
          log.event('upstream_response', {
            status: upstream.status,
            headers: Object.fromEntries(upstream.headers.entries()),
            via: tag,
          });
        };

        // codex:多账号轮换(从游标起,遇 401/429/5xx 换下一个账号)
        if (target && target.preset.id === 'codex') {
          const codex = deps.codex;
          const n = codex ? await codex.count() : 0;
          if (!codex || n === 0) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(anthropicError('authentication_error', 'codex 未登录,请在 Provider 设置中登录 ChatGPT。'));
            finish({ reason: 'codex_not_logged_in' });
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
              logUpstreamRequest(targetUrl, codexHeaders, `codex#${idx}`);
              const upstream = await fetch(targetUrl, { method: 'POST', headers: codexHeaders as any, body: targetBody });
              console.log(`[proxy] codex upstream status ${upstream.status} (account #${idx})`);
              logUpstreamResponse(upstream, `codex#${idx}`);

              if (shouldRotate(upstream.status) && s < seq.length - 1) {
                console.warn(`[proxy] codex account #${idx} failed (${upstream.status}), rotating`);
                await upstream.body?.cancel();
                continue;
              }

              if (upstream.status >= 400) {
                const errText = await upstream.text();
                log.event('upstream_body', { text: errText });
                res.writeHead(upstream.status, { 'content-type': 'application/json' });
                res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
                finish({ reason: 'codex_upstream_error' });
                return;
              }

              codex.markSuccess(idx);
              await relayTranslated({
                res, upstream, translator: translator!, wantStream, idlePingMs, stallMs, log, finish,
              });
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
          finish({ reason: 'codex_all_failed' });
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
            logUpstreamRequest(targetUrl, headers, `key#${i}`);
            const upstream = await fetch(targetUrl, { method: 'POST', headers: headers as any, body: targetBody });
            console.log(`[proxy] upstream status ${upstream.status} (key #${i})`);
            logUpstreamResponse(upstream, `key#${i}`);

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
              log.event('upstream_body', { text: errText });
              res.writeHead(upstream.status, { 'content-type': 'application/json' });
              res.end(anthropicError('upstream_error', errText.slice(0, 2000)));
              finish({ reason: 'upstream_error' });
              return;
            }

            if (translator) {
              await relayTranslated({
                res, upstream, translator, wantStream, idlePingMs, stallMs, log, finish,
                onPayload: openaiPool && deps.openai
                  // openai 官方:从流式响应中提取 usage 并回写当日用量
                  ? (payload) => {
                    const u = extractResponsesUsage(payload);
                    if (u != null) {
                      deps.openai!.add(openaiPool!, u);
                    }
                  }
                  : undefined,
              });
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

            // 透传路径同样怕上游长时间静默,给它也装上心跳(仅 SSE 响应)
            const passIsSSE = (respHeaders['content-type'] ?? '').includes('event-stream');
            const passPing = passIsSSE ? createIdlePing(res, idlePingMs) : null;
            passPing?.touch();

            const decoder = new TextDecoder();
            let bytes = 0;
            const reader = upstream.body?.getReader();
            try {
              if (reader) {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    break;
                  }
                  passPing?.touch();
                  bytes += value.byteLength;
                  log.event('upstream_chunk', { text: decoder.decode(value, { stream: true }) });
                  if (!res.write(value)) {
                    await new Promise<void>(resolve => res.once('drain', resolve));
                  }
                }
              }
            } finally {
              passPing?.stop();
            }
            res.end();
            finish({ bytes, passthrough: true });
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
        finish({ reason: 'all_attempts_failed', error: String(lastErr?.message ?? lastErr) });
      } catch (err) {
        console.error('proxy handler error:', err);
        log.event('handler_error', { message: String((err as any)?.message ?? err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: String((err as any)?.message ?? err) }));
        finish({ reason: 'handler_error' });
      }
    });
  });
}
