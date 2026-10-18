// 真实启动 server.mjs，DeepSeek 指向本地模拟服务：研讨室里的 DeepSeek 发言（用量入调用记录、“停止”能中断），
// 以及工坊的 Search / Fetch / 用量 / 来源可获取性接口
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, tmpBase, cleanup } from './helpers.mjs';
import { startMock, chatOk } from './mock-deepseek.mjs';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let server;
let mock;
let port;

before(async () => {
  mock = await startMock();
  const base = tmpBase();
  port = await freePort();
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [{ id: 'deepseek', name: 'DeepSeek', color: '#4D6BFE', adapter: 'deepseek', model: 'deepseek-flash', effort: 'none' }],
  }));
  const env = {
    ...process.env, WETALK_CONFIG: config, WETALK_DATA: path.join(base, 'data'), WETALK_PROJECTS: path.join(base, '项目资料'),
    WETALK_PORT: String(port), WETALK_DEEPSEEK_URL: mock.url, DEEPSEEK_API_KEY: 'sk-test',
  };
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`服务没有启动：${out}`)), 15_000);
    server.stdout.on('data', () => out.includes('工坊已启动') && (clearTimeout(t), resolve()));
    server.on('exit', (code) => (clearTimeout(t), reject(new Error(`服务退出（${code}）：${out}`))));
  });
});

after(async () => {
  if (server?.exitCode === null) {
    const exited = new Promise((r) => server.on('exit', r));
    server.kill();
    await exited;
  }
  await mock.close();
  await cleanup();
});

const url = (p) => `http://127.0.0.1:${port}${p}`;
async function call(method, p, body, headers = {}) {
  const res = await fetch(url(p), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
async function waitCalls(threadId, n = 1) {
  for (let i = 0; i < 100; i++) {
    const calls = (await call('GET', `/api/threads/${threadId}/calls`)).body;
    if (calls.length >= n && calls.every((c) => c.status !== 'running')) return calls;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('调用一直没有结束');
}

test('研讨室：DeepSeek 作为参与者发言，调用记录里有用量、费用估算与每次尝试', async () => {
  const state = (await call('GET', '/api/state')).body;
  assert.equal(state.participants.find((p) => p.id === 'deepseek').available, true);
  mock.script('/chat/completions', { status: 503, body: { error: { message: '忙' } } }, chatOk('DeepSeek 的发言'));
  const t = (await call('POST', '/api/threads', { title: '测试', content: '开题' })).body.thread;
  assert.equal((await call('POST', `/api/threads/${t.id}/round`, { participants: ['deepseek'], rounds: 1 })).status, 200);
  const [c] = await waitCalls(t.id);
  assert.equal(c.status, 'ok');
  const full = (await call('GET', `/api/calls/${c.id}`)).body;
  assert.equal(full.raw, 'DeepSeek 的发言');
  assert.equal(full.reasoning, '想一想');
  assert.equal(full.usage.completion_tokens, 500);
  assert.ok(full.usage.usd > 0);
  assert.equal(full.exec.api, 'deepseek');
  assert.deepEqual(full.exec.attempts.map((a) => a.status), [503, 200]);
  const thread = (await call('GET', `/api/threads/${t.id}`)).body;
  assert.equal(thread.posts.at(-1).content, 'DeepSeek 的发言');
});

test('研讨室：“停止”能中断进行中的 DeepSeek 调用', async () => {
  mock.script('/chat/completions', { ...chatOk('来不及说'), delayMs: 5000 });
  const t = (await call('POST', '/api/threads', { title: '停止测试', content: '开题' })).body.thread;
  await call('POST', `/api/threads/${t.id}/round`, { participants: ['deepseek'], rounds: 1 });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await call('POST', `/api/threads/${t.id}/stop`, {});
  const [c] = await waitCalls(t.id);
  assert.equal(c.status, 'aborted');
  assert.ok(Date.now() - t0 < 3000);
});

test('工坊接口：Search、Fetch 建来源卡、用量合计；来源可获取性只能由主持人确认', async () => {
  await call('POST', '/api/projects', { name: '检索' });
  const P = `/api/projects/${encodeURIComponent('检索')}`;
  mock.script('/v1/tools/search', { body: { results: [{ title: 't', url: 'https://example.org/a', snippet: 's', summary: 'm', content: '', rerank_score: 2, authority: 1, date: null, site_name: null, site_icon: null }] } });
  const s = await call('POST', `${P}/web/search`, { query: '测试' });
  assert.equal(s.status, 200);
  assert.equal(s.body.evidence, false);
  mock.script('/v1/tools/fetch', { body: { title: '页面', content: '正文内容' } });
  const f = await call('POST', `${P}/web/fetch`, { url: 'https://example.org/a', create: true });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.source.id, 'S001');
  const u = (await call('GET', `${P}/usage`)).body;
  assert.equal(u.calls, 2);
  assert.ok(Math.abs(u.usd - 0.0015) < 1e-12);
  assert.equal((await call('POST', `${P}/sources/S001/availability`, { state: 'gone' })).status, 403);
  const token = (await (await fetch(url('/workbench'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)[1];
  assert.equal((await call('POST', `${P}/sources/S001/availability`, { state: 'gone' }, { 'X-Workbench-Host': token })).status, 200);
  assert.equal((await call('GET', `${P}/records/S001`)).body.availability.state, 'gone');
  mock.script('/v1/tools/fetch', { status: 404, body: { error: { message: 'no usable content' } } });
  const miss = await call('POST', `${P}/web/fetch`, { url: 'https://example.org/b' });
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.body.details.attempts.map((a) => a.status), [404]);
});
