// 流式空闲心跳测试:上游长时间不发字节时代理应主动发 Anthropic ping 帧保活,
// 避免 Claude Code 客户端 180 秒空闲看门狗(stream idle: no bytes for 180000ms)掐断连接。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProxyServer } from './proxy';
import { ProxyConfig } from './config';

/** 一直静默、永不结束的上游 Response */
function upstreamSilent(contentType = 'text/event-stream'): Response {
  return new Response(new ReadableStream({ start() { /* 不 enqueue 不 close */ } }), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

interface ClientResult {
  chunks: string[];
  close: () => void;
}

/** 向代理发一个 POST /v1/messages,收集响应 chunk */
function postMessage(port: number): ClientResult {
  const chunks: string[] = [];
  const req = http.request(
    { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST' },
    res => {
      res.on('data', c => chunks.push(c.toString('utf8')));
      res.on('error', () => {});
    },
  );
  req.end(JSON.stringify({ model: 'claude-x', stream: true, messages: [] }));
  return {
    chunks,
    close: () => req.destroy(),
  };
}

interface ServerHandle {
  port: number;
  dispose: () => Promise<void>;
}

async function listen(server: http.Server): Promise<ServerHandle> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    dispose: () => new Promise(r => server.close(() => r())),
  };
}

/** 等待 chunks 中出现匹配文本,带超时;超时抛错(测试失败) */
async function waitFor(chunks: string[], pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const joined = chunks.join('');
    const m = joined.match(pattern);
    if (m) return m[0];
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${pattern} in ${JSON.stringify(chunks.join('').slice(0, 500))}`);
}

interface FetchMock {
  called: () => boolean;
  restore: () => void;
}

/** 安装全局 fetch mock,restore 恢复原实现 */
function mockFetch(makeResp: () => Response): FetchMock {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return makeResp();
  }) as typeof fetch;
  return {
    called: () => calls > 0,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

test('openai 格式转换路径:上游静默时代理周期性发送 ping 保活', async () => {
  const cfg: ProxyConfig = { mapping: 'meta:meta-model', providers: [{ name: 'meta', apiKeys: ['k1'] }] };
  const mock = mockFetch(() => upstreamSilent());
  const server = createProxyServer({
    getConfig: () => cfg,
    idlePingMs: 60,
  });
  const handle = await listen(server);
  const client = postMessage(handle.port);
  try {
    // idlePingMs=60,宽限 2s 内必见 ping
    const ping = await waitFor(client.chunks, /event: ping\ndata: .*\n\n/, 2000);
    assert.ok(ping.includes('"type":"ping"'), `ping 帧应为标准 Anthropic ping: ${ping}`);
    assert.ok(mock.called(), '上游应被调用');
  } finally {
    client.close();
    await handle.dispose();
    mock.restore();
  }
});
