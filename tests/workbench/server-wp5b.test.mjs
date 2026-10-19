// WP5b 经 HTTP：真实启动 server.mjs（临时目录、假 Agent）。竞争从发起到书记应用补丁走一遍；分工；
// 研讨室的议题挂到工坊项目上，记忆默认用这个项目自己的空间。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, tmpBase, cleanup } from './helpers.mjs';

const FAKE = path.join(ROOT, 'tests/workbench/fixtures/fake-agent.mjs');
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const DRAFT_A = '# 甲\n\n## 问题\n为什么要做。\n\n## 做法\n分三步。\n';
const DRAFT_B = '# 乙\n\n## 开场\n你有没有想过这个问题？\n\n## 方法\n先分工再竞争。\n';

let server;
let port;
before(async () => {
  const base = tmpBase();
  port = await freePort();
  const fake = (id, model, ...args) => ({ id, name: id, model, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args] });
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [
      fake('cl', 'claude-fake', 'say64', b64(DRAFT_A)),
      fake('cx', 'gpt-fake', 'say64', b64(DRAFT_B)),
      fake('ds', 'deepseek-fake', 'say64', b64('方案甲 第 1 节：问题提得好。\n方案乙 第 1 节：开场可以借用。\n整体还行。')),
      fake('gm', 'gemini-fake', 'json', b64([{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '甲书说 A', sources: [{ id: 'S001', version: 1, quote: '甲书说 A' }] } }])),
    ],
  }));
  const env = { ...process.env, WETALK_CONFIG: path.join(base, 'config.json'), WETALK_DATA: path.join(base, 'data'), WETALK_PROJECTS: path.join(base, '项目资料'), WETALK_PORT: String(port), DEEPSEEK_API_KEY: '' };
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
  await cleanup();
});

const url = (p) => `http://127.0.0.1:${port}${p}`;
let token;
async function call(method, p, body, host = true) {
  token ??= (await (await fetch(url('/'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)[1];
  const res = await fetch(url(p), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(host ? { 'X-Workbench-Host': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const P = `/api/projects/${encodeURIComponent('五b')}`;
const until = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
};
const tasksIn = async (ids, state) => (await call('GET', `${P}/tasks`)).body.filter((t) => ids.includes(t.id)).every((t) => t.state === state);

test('HTTP：竞争从发起到书记应用补丁；分工；研讨挂到工坊项目上', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '五b' })).status, 200);
  const r0 = await call('POST', `${P}/submissions`, { request_id: 'seed-source-0001', changes: [{ kind: 'source', expected_version: 0, data: { title: '甲书', url: 'https://example.org/a', text: '甲书说 A。' } }] });
  await call('POST', `${P}/submissions/${r0.body.sid}/promote`, {});

  // 竞争：只限主持人
  assert.equal((await call('POST', `${P}/compete`, { type: 'outline', participants: ['cl', 'cx'] }, false)).status, 403);
  const k = await call('POST', `${P}/compete`, { type: 'outline', title: '怎么讲', participants: ['cl', 'cx'] });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  const drafts = k.body.drafts.map((d) => d.task);
  await until(() => tasksIn(drafts, 'submitted'), '方案交稿');
  // 揭晓前：竞争接口里没有方案正文
  assert.doesNotMatch(JSON.stringify((await call('GET', `${P}/competitions/K001`)).body), /为什么要做|先分工再竞争/);
  assert.ok((await call('GET', `${P}/inbox`)).body.some((i) => i.type === 'competition' && i.action === 'reveal'));
  assert.equal((await call('POST', `${P}/competitions/K001/reveal`, {})).status, 200);
  const rv = await call('POST', `${P}/competitions/K001/review`, { reviewers: ['ds'] });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  await until(() => tasksIn(rv.body.reviews[0].tasks.map((t) => t.task), 'submitted'), '评审交稿');
  await call('POST', `${P}/competitions/K001/reveal`, {});
  let v = (await call('GET', `${P}/competitions/K001`)).body;
  assert.equal(v.stage, 'selecting');
  assert.deepEqual(v.reviews[0].comments.map((c) => c.where), ['方案甲 第 1 节', '方案乙 第 1 节']);
  assert.equal(v.reviews[0].returned.length, 1);
  const A = v.label_drafts.find((l) => l.participant === 'cl').label;
  const B = v.label_drafts.find((l) => l.participant === 'cx').label;
  assert.equal((await call('POST', `${P}/competitions/K001/select`, { label: A, reason: '更完整' })).status, 200);
  await call('POST', `${P}/competitions/K001/patches`, { from: { draft: B, section: 1, quote: '你有没有想过这个问题？' }, to: { section: 1, position: 'start' } });
  await call('POST', `${P}/competitions/K001/patches`, { from: { draft: B, section: 2 }, to: { section: 2, position: 'after' } });
  assert.equal((await call('POST', `${P}/competitions/K001/patches/P1/decide`, { decision: 'accept' }, false)).status, 403);
  await call('POST', `${P}/competitions/K001/patches/P1/decide`, { decision: 'accept' });
  await call('POST', `${P}/competitions/K001/patches/P2/decide`, { decision: 'reject', reason: '不需要' });
  assert.equal((await call('POST', `${P}/competitions/K001/apply`, {})).status, 200);
  const ol = (await call('GET', `${P}/records/OL001`)).body.record;
  assert.equal(ol.version, 2);
  assert.ok(ol.body.includes('你有没有想过这个问题？') && !ol.body.includes('先分工再竞争'));
  v = (await call('POST', `${P}/competitions/K001/close`, {})).body;
  assert.equal(v.stage, 'closed');

  // 分工
  const dv = await call('POST', `${P}/divide`, { type: 'extract_claims', title: '抽取', inputs: [{ id: 'S001', version: 1 }], participants: ['gm'] });
  assert.equal(dv.status, 200, JSON.stringify(dv.body));
  await until(async () => (await call('GET', `${P}/divisions`)).body[0].done === 1, '分工完成');

  // 研讨：挂到项目上，记忆用项目自己的空间；按项目列出
  const th = await call('POST', '/api/threads', { project: '五b', ref: 'OL001', title: '讨论大纲', content: '开场要不要换？' });
  assert.equal(th.status, 200, JSON.stringify(th.body));
  assert.deepEqual([th.body.thread.project, th.body.thread.ref], ['五b', 'OL001']);
  const space = (await call('GET', '/api/spaces')).body.find((s) => s.id === th.body.thread.memorySpace);
  assert.equal(space.name, '工坊·五b·研讨');
  await call('POST', '/api/threads', { title: '别的议题' });
  assert.deepEqual((await call('GET', `/api/threads?project=${encodeURIComponent('五b')}`)).body.map((t) => t.title), ['讨论大纲']);
  assert.equal((await call('POST', '/api/threads', { project: '不存在的项目', title: 'x' })).status, 404);
});
