import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setProxy, clearProxy, getProxy, readSettings } from './claudeSettings';

function tmp(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'settings.json');
}

test('setProxy 写入 ANTHROPIC_BASE_URL(目录不存在自动建)', () => {
  const p = tmp();
  setProxy(p, 'http://127.0.0.1:4001');
  assert.equal(getProxy(p), 'http://127.0.0.1:4001');
});

test('setProxy 保留已有 env 其他字段', () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ env: { FOO: 'bar' } }));
  setProxy(p, 'http://127.0.0.1:5000');
  assert.deepEqual(readSettings(p).env, { FOO: 'bar', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' });
});

test('clearProxy 删除字段,env 空则删 env', () => {
  const p = tmp();
  setProxy(p, 'http://127.0.0.1:4001');
  clearProxy(p);
  assert.equal(getProxy(p), undefined);
  assert.equal('env' in (readSettings(p) ?? {}), false);
});

test('clearProxy 保留 env 中其他字段', () => {
  const p = tmp();
  fs.writeFileSync(p, JSON.stringify({ env: { FOO: 'bar', ANTHROPIC_BASE_URL: 'x' } }));
  clearProxy(p);
  assert.deepEqual(readSettings(p).env, { FOO: 'bar' });
});

test('clearProxy 对不存在文件安全', () => {
  const p = tmp();
  fs.rmSync(p, { force: true });
  clearProxy(p);
  assert.equal(fs.existsSync(p), false);
});
