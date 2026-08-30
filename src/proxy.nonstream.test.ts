// 代理转发路径的协议正确性测试。
//
// 起因:CC 报 "the non-streaming request was answered with a stream" ——
// 翻译路径无视客户端的 stream 字段一律回 SSE;以及上游 200 但吐不出可翻译事件时
// 代理静默回一个空流,客户端只能看到 StreamNoEventsError。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProxyServer, ProxyServerDeps } from './proxy';
import { ProxyConfig } from './config';

const CFG: ProxyConfig = { mapping: 'meta:meta-model', providers: [{ name: 'meta', apiKeys: ['k1'] }] };

/** 一段完整的 OpenAI Chat Completions 流式响应 */
const OPENAI_SSE = [
  'data: {"id":"cc-1","model":"meta-model","choices":[{"delta":{"content":"Hello"}}]}\n\n',
  'data: {"id":"cc-1","model":"meta-model","choices":[{"delta":{"content":" world"}}]}\n\n',
  'data: {"id":"cc-1","model":"meta-model","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('');

/** 构造一个立即吐完就结束的 SSE 上游 */
function sseUpstream(text: string, contentType = 'text/event-stream'): Response {
  return new Response(text, { status: 200, headers: { 'content-type': contentType } });
}

/** 永远静默、永不结束的上游 */
function silentUpstream(): Response {
  return new Response(new ReadableStream({ start() { /* 不 enqueue 不 close */ } }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface Captured {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 发一个请求并等完整响应 */
function post(port: number, body: unknown, url = '/v1/messages'): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST' }, res => {
      let buf = '';
      res.on('data', c => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

interface Harness {
  port: number;
  upstreamRequests: Array<{ url: string; body: any }>;
  dispose: () => Promise<void>;
}

/** 起一个代理 server + mock 掉全局 fetch */
async function harness(makeResp: () => Response, deps: Partial<ProxyServerDeps> = {}): Promise<Harness> {
  const realFetch = globalThis.fetch;
  const upstreamRequests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(init?.body ?? ''));
    } catch { /* 非 JSON 忽略 */ }
    upstreamRequests.push({ url: String(url), body: parsed });
    return makeResp();
  }) as typeof fetch;

  const server = createProxyServer({ getConfig: () => CFG, ...deps });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    upstreamRequests,
    dispose: async () => {
      globalThis.fetch = realFetch;
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

test('stream:false → 回 application/json 的 Messages 对象,不是 SSE', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE));
  try {
    const res = await post(h.port, { model: 'claude-x', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.ok(!res.body.includes('event:'), `不应含 SSE 帧: ${res.body.slice(0, 200)}`);
    const msg = JSON.parse(res.body);
    assert.equal(msg.type, 'message');
    assert.equal(msg.role, 'assistant');
    assert.deepEqual(msg.content, [{ type: 'text', text: 'Hello world' }]);
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.usage.input_tokens, 11);
  } finally {
    await h.dispose();
  }
});

test('缺省 stream 字段等同非流式(Anthropic 语义)', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE));
  try {
    const res = await post(h.port, { model: 'claude-x', messages: [] });
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(JSON.parse(res.body).type, 'message');
  } finally {
    await h.dispose();
  }
});

test('stream:true 仍然回 SSE,且事件完整', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE));
  try {
    const res = await post(h.port, { model: 'claude-x', stream: true, messages: [] });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.match(res.body, /event: message_start/);
    assert.match(res.body, /event: content_block_delta/);
    assert.match(res.body, /event: message_stop/);
  } finally {
    await h.dispose();
  }
});

test('非流式请求仍以流式打到上游(复用同一套 translator)', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE));
  try {
    await post(h.port, { model: 'claude-x', stream: false, messages: [] });
    assert.equal(h.upstreamRequests.length, 1);
    assert.equal(h.upstreamRequests[0].body.stream, true);
  } finally {
    await h.dispose();
  }
});

test('上游 200 但 content-type 是 JSON → 502 且带上游原文,而不是空流', async () => {
  const errBody = '{"error":{"message":"model not found","code":"invalid_model"}}';
  const h = await harness(() => new Response(errBody, { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const res = await post(h.port, { model: 'claude-x', stream: true, messages: [] });
    assert.equal(res.status, 502);
    assert.match(String(res.headers['content-type']), /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'error');
    assert.match(body.error.message, /model not found/);
  } finally {
    await h.dispose();
  }
});

test('上游是 SSE 但一个可翻译事件都没有 → 回 error 帧而非空流', async () => {
  // 合法 SSE 但负载全是代理不认识的东西
  const junk = 'data: {"foo":"bar"}\n\ndata: {"baz":1}\n\n';
  const h = await harness(() => sseUpstream(junk));
  try {
    const res = await post(h.port, { model: 'claude-x', stream: true, messages: [] });
    assert.equal(res.status, 200);
    assert.match(res.body, /event: error/);
    assert.match(res.body, /no translatable events/i);
  } finally {
    await h.dispose();
  }
});

test('非流式下上游无可翻译事件 → 502 错误体', async () => {
  const h = await harness(() => sseUpstream('data: {"foo":"bar"}\n\n'));
  try {
    const res = await post(h.port, { model: 'claude-x', stream: false, messages: [] });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).type, 'error');
  } finally {
    await h.dispose();
  }
});

test('上游长时间不产出可翻译事件 → stall 超时后回 error 帧并结束', async () => {
  const h = await harness(silentUpstream, { stallMs: 120, idlePingMs: 40 });
  try {
    const res = await post(h.port, { model: 'claude-x', stream: true, messages: [] });
    assert.match(res.body, /event: ping/, '超时前应有心跳');
    assert.match(res.body, /event: error/);
    assert.match(res.body, /stall|timed out|no response/i);
  } finally {
    await h.dispose();
  }
});

test('非流式下 stall 超时 → 504', async () => {
  const h = await harness(silentUpstream, { stallMs: 120 });
  try {
    const res = await post(h.port, { model: 'claude-x', stream: false, messages: [] });
    assert.equal(res.status, 504);
    assert.equal(JSON.parse(res.body).type, 'error');
  } finally {
    await h.dispose();
  }
});

test('stallMs<=0 关闭超时', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE), { stallMs: 0 });
  try {
    const res = await post(h.port, { model: 'claude-x', stream: true, messages: [] });
    assert.match(res.body, /event: message_stop/);
    assert.ok(!res.body.includes('event: error'));
  } finally {
    await h.dispose();
  }
});

test('count_tokens 不打到上游,本地估算后直接回 input_tokens', async () => {
  const h = await harness(() => sseUpstream(OPENAI_SSE));
  try {
    const res = await post(
      h.port,
      { model: 'claude-x', messages: [{ role: 'user', content: 'hello there' }] },
      '/v1/messages/count_tokens',
    );
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.input_tokens, 'number');
    assert.ok(body.input_tokens > 0);
    assert.equal(h.upstreamRequests.length, 0, 'count_tokens 不应发上游');
  } finally {
    await h.dispose();
  }
});

test('日志 logger 收到完整的请求/上游请求/上游响应/收尾事件', async () => {
  const seen: Array<{ ev: string; data: any }> = [];
  const log = {
    begin: () => ({
      event: (ev: string, data: any) => seen.push({ ev, data }),
      end: (data: any) => seen.push({ ev: 'end', data }),
    }),
  };
  const h = await harness(() => sseUpstream(OPENAI_SSE), { log });
  try {
    await post(h.port, { model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const names = seen.map(s => s.ev);
    for (const want of ['request', 'upstream_request', 'upstream_response', 'upstream_chunk', 'downstream_chunk', 'end']) {
      assert.ok(names.includes(want), `缺少 ${want} 事件,实际:${names.join(',')}`);
    }
    const reqEv = seen.find(s => s.ev === 'request')!;
    assert.equal(reqEv.data.body.model, 'claude-x');
    const upEv = seen.find(s => s.ev === 'upstream_request')!;
    assert.equal(upEv.data.body.stream, true);
    assert.match(String(upEv.data.url), /chat\/completions/);
    const endEv = seen.find(s => s.ev === 'end')!;
    assert.ok(endEv.data.events > 0, 'end 应带下游事件计数');
  } finally {
    await h.dispose();
  }
});

test('透传路径(mapping=pass)也记日志', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"ok":true}', {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  const seen: string[] = [];
  const server = createProxyServer({
    getConfig: () => ({ mapping: 'pass', providers: [] }),
    log: { begin: () => ({ event: (ev: string) => seen.push(ev), end: () => seen.push('end') }) },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    await post((server.address() as AddressInfo).port, { model: 'claude-x', messages: [] });
    assert.ok(seen.includes('request'));
    assert.ok(seen.includes('upstream_response'));
    assert.ok(seen.includes('end'));
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('目标 Provider 未配置 key 时直接回 401 authentication_error,不透传', async () => {
  let fetchCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  const server = createProxyServer({
    getConfig: () => ({ mapping: 'glm:glm-4.6', providers: [] }),
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const res = await post((server.address() as AddressInfo).port, { model: 'claude-x', messages: [] });
    assert.equal(res.status, 401);
    assert.equal(fetchCalled, false, '不应向任何上游发起 fetch 请求');
    const body = JSON.parse(res.body);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
    assert.match(body.error.message, /未配置 API Key/);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(r => server.close(() => r()));
  }
});

