/**
 * 代理请求日志:每个请求落一个 jsonl 文件到临时目录,完整记录
 * 客户端请求体、转换后的上游请求体、上游原始 SSE 分片、回写给客户端的事件。
 *
 * 出问题时直接看这个文件就能判断是"上游没吐"还是"转换没转出来"。
 * 认证头只留末 4 位;写盘失败一律吞掉 —— 日志绝不能拖垮代理本身。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 一次请求的日志句柄 */
export interface RequestLog {
  /** 追加一条事件;name 为 request / upstream_request / upstream_chunk / downstream_chunk / end 等 */
  event(name: string, data: Record<string, unknown>): void;
  /** 收尾,写 end 行 */
  end(data: Record<string, unknown>): void;
}

export interface Logger {
  begin(meta: { method: string; url: string }): RequestLog;
}

/** 需要脱敏的请求/响应头(小写比较) */
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'chatgpt-account-id']);

/** 默认保留的日志文件数 */
const DEFAULT_KEEP = 200;

/** 代理日志默认目录 */
export function defaultLogDir(): string {
  return path.join(os.tmpdir(), 'claude-proxy-logs');
}

/** 把认证头替换为只带末 4 位的占位;短值完全遮蔽 */
export function redactHeaders(headers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (!SECRET_HEADERS.has(k.toLowerCase())) {
      out[k] = v;
      continue;
    }
    const s = Array.isArray(v) ? v.join(',') : String(v ?? '');
    out[k] = s.length > 8 ? `***${s.slice(-4)}` : '***';
  }
  return out;
}

/** 递归找 headers 字段做脱敏(request / upstream_request / upstream_response 都可能带) */
function redactData(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || typeof data !== 'object' || !('headers' in data)) {
    return data;
  }
  const h = (data as any).headers;
  if (!h || typeof h !== 'object') {
    return data;
  }
  return { ...data, headers: redactHeaders(h as Record<string, any>) };
}

/** 安全序列化:循环引用等异常降级为占位串,绝不抛 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) {
            return '[circular]';
          }
          seen.add(v);
        }
        return v;
      });
    } catch {
      return '{"ev":"log_error","reason":"unserializable"}';
    }
  }
}

/** 只保留最新 keep 个文件,多余的删掉;任何失败都忽略 */
function prune(dir: string, keep: number): void {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // 并发下别的进程已删,忽略
      }
    }
  } catch {
    // 目录不存在/不可读,忽略
  }
}

/** 文件名安全的时间戳:2026-08-24T16-30-05.123Z */
function stamp(d: Date): string {
  return d.toISOString().replace(/:/g, '-');
}

/**
 * 创建落盘 logger。目录不可写时自动降级为 no-op,不影响代理运行。
 * keep:保留的日志文件数上限,默认 200。
 */
export function createFileLogger(dir: string, opts?: { keep?: number }): Logger {
  const keep = opts?.keep ?? DEFAULT_KEEP;
  let seq = 0;
  let ready = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ready = true;
  } catch {
    ready = false;
  }

  return {
    begin(meta): RequestLog {
      if (!ready) {
        return nullLogger.begin(meta);
      }
      const started = Date.now();
      const file = path.join(dir, `${stamp(new Date(started))}-${String(seq++).padStart(4, '0')}.jsonl`);
      // 给即将写入的这个文件留位置,保证落盘后总数不超过 keep
      prune(dir, keep - 1);

      const write = (name: string, data: Record<string, unknown>): void => {
        const line = safeStringify({ t: Date.now(), ev: name, ...redactData(data) });
        try {
          fs.appendFileSync(file, line + '\n');
        } catch {
          // 磁盘满 / 权限变化,忽略
        }
      };

      write('begin', { method: meta.method, url: meta.url });
      return {
        event: write,
        end: (data) => write('end', { ...data, ms: Date.now() - started }),
      };
    },
  };
}

/** 日志关闭时使用的空实现 */
export const nullLogger: Logger = {
  begin: () => ({ event: () => {}, end: () => {} }),
};
