// 代理请求日志测试:每个请求一个 jsonl 文件,记完整请求/响应,认证头脱敏,超量自动清理旧文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileLogger, redactHeaders, nullLogger } from './reqlog';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-log-'));
}

/** 读目录下唯一的日志文件,按行解析成事件数组 */
function readOnlyLog(dir: string): any[] {
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `期望只有一个日志文件,实际 ${JSON.stringify(files)}`);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('redactHeaders 只保留认证头末 4 位,其余头原样', () => {
  const out = redactHeaders({
    'authorization': 'Bearer sk-proj-abcdefghijkl9876',
    'x-api-key': 'sk-ant-secret-value-4321',
    'Cookie': 'session=deadbeef',
    'content-type': 'application/json',
    'user-agent': 'claude-cli/1.0',
  });
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['user-agent'], 'claude-cli/1.0');
  for (const k of ['authorization', 'x-api-key', 'Cookie']) {
    assert.ok(!String(out[k]).includes('secret'), `${k} 不应含明文`);
    assert.ok(!String(out[k]).includes('abcdefghijkl'), `${k} 不应含明文`);
    assert.ok(!String(out[k]).includes('deadbeef'), `${k} 不应含明文`);
  }
  assert.match(String(out['authorization']), /9876$/);
  assert.match(String(out['x-api-key']), /4321$/);
});

test('redactHeaders 对短值也不泄露原文', () => {
  const out = redactHeaders({ 'x-api-key': 'abc' });
  assert.ok(!String(out['x-api-key']).includes('abc'));
});

test('一个请求写一个 jsonl 文件,事件按顺序落盘', () => {
  const dir = tmpDir();
  const log = createFileLogger(dir).begin({ method: 'POST', url: '/v1/messages' });
  log.event('request', { headers: { 'x-api-key': 'sk-1234' }, body: { model: 'claude-x' } });
  log.event('upstream_request', { url: 'https://up/v1/chat/completions', body: { stream: true } });
  log.event('upstream_chunk', { text: 'data: {"a":1}\n\n' });
  log.end({ events: 3 });

  const lines = readOnlyLog(dir);
  assert.deepEqual(lines.map(l => l.ev), ['begin', 'request', 'upstream_request', 'upstream_chunk', 'end']);
  assert.equal(lines[0].method, 'POST');
  assert.equal(lines[0].url, '/v1/messages');
  assert.equal(lines[1].body.model, 'claude-x');
  assert.equal(lines[4].events, 3);
  // 每行都带毫秒时间戳,便于看上游静默间隔
  for (const l of lines) {
    assert.equal(typeof l.t, 'number');
  }
});

test('落盘时自动脱敏 headers 字段', () => {
  const dir = tmpDir();
  const log = createFileLogger(dir).begin({ method: 'POST', url: '/v1/messages' });
  log.event('request', { headers: { authorization: 'Bearer sk-super-secret-0001' } });
  log.end({});
  const raw = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.ok(!raw.includes('sk-super-secret'), '日志文件不应含明文 key');
  assert.ok(raw.includes('0001'), '应保留末 4 位便于分辨用了哪个 key');
});

test('请求体完整记录不截断', () => {
  const dir = tmpDir();
  const big = 'x'.repeat(200_000);
  const log = createFileLogger(dir).begin({ method: 'POST', url: '/v1/messages' });
  log.event('request', { body: { text: big } });
  log.end({});
  const lines = readOnlyLog(dir);
  assert.equal(lines[1].body.text.length, 200_000);
});

test('文件名含时间戳与序号,并发请求不互相覆盖', () => {
  const dir = tmpDir();
  const logger = createFileLogger(dir);
  const a = logger.begin({ method: 'POST', url: '/a' });
  const b = logger.begin({ method: 'POST', url: '/b' });
  a.event('request', { n: 1 });
  b.event('request', { n: 2 });
  a.end({});
  b.end({});
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.match(f, /\.jsonl$/);
  }
});

test('超过 keep 上限时清理最旧的文件', () => {
  const dir = tmpDir();
  const logger = createFileLogger(dir, { keep: 3 });
  for (let i = 0; i < 6; i++) {
    const l = logger.begin({ method: 'POST', url: `/${i}` });
    l.event('request', { i });
    l.end({});
  }
  const files = fs.readdirSync(dir);
  assert.ok(files.length <= 3, `应至多保留 3 个,实际 ${files.length}`);
});

test('目录创建失败时静默降级,不抛异常', () => {
  // 把一个普通文件当作日志目录的父目录 → mkdir 必然 ENOTDIR
  const base = tmpDir();
  const blocker = path.join(base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const logger = createFileLogger(path.join(blocker, 'logs'));
  const l = logger.begin({ method: 'POST', url: '/v1/messages' });
  assert.doesNotThrow(() => {
    l.event('request', { a: 1 });
    l.end({});
  });
});

test('含循环引用的对象不会让日志抛异常', () => {
  const dir = tmpDir();
  const cyclic: any = { a: 1 };
  cyclic.self = cyclic;
  const l = createFileLogger(dir).begin({ method: 'POST', url: '/x' });
  assert.doesNotThrow(() => {
    l.event('request', { body: cyclic });
    l.end({});
  });
  const lines = readOnlyLog(dir);
  assert.equal(lines.length, 3, '循环引用那条应降级为可读占位而不是丢整行');
});

test('nullLogger 关闭时不产生任何文件与副作用', () => {
  const dir = tmpDir();
  const l = nullLogger.begin({ method: 'POST', url: '/x' });
  l.event('request', { a: 1 });
  l.end({});
  assert.equal(fs.readdirSync(dir).length, 0);
});
