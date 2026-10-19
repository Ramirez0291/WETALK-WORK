// WP6 经 HTTP：真实启动 server.mjs（临时目录、假 Agent）。自动调度默认关；打开后按分工表派发、由任务事件收轮；
// 切换阶段生成交接单；挂到项目上的研讨用当前阶段的记忆空间。
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

let server;
let port;
before(async () => {
  const base = tmpBase();
  port = await freePort();
  const fake = (id, model, ...args) => ({ id, name: id, model, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args] });
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [
      // 分工表默认 extract → deepseek：参与者 id 对得上就行
      fake('deepseek', 'deepseek-fake', 'json', b64({ changes: [{ kind: 'claim', expected_version: 0, tmp: '$c1', data: { type: 'fact', text: '甲书说 A', sources: [{ id: 'S001', version: 1, quote: '甲书说 A' }] } }], changelog: [{ id: '$c1', type: 'evidence', note: '抽出一条' }] })),
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
const P = `/api/projects/${encodeURIComponent('六')}`;
const until = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
};

test('HTTP：自动调度默认关，打开后按分工表派发并由任务事件收轮；切换阶段生成交接单；研讨用当前阶段的记忆空间', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '六' })).status, 200);
  const r0 = await call('POST', `${P}/submissions`, { request_id: 'seed-source-0001', changes: [{ kind: 'source', expected_version: 0, data: { title: '甲书', url: 'https://example.org/a', text: '甲书说 A。' } }] });
  await call('POST', `${P}/submissions/${r0.body.sid}/promote`, {});
  let s = (await call('GET', `${P}/scheduler`)).body;
  assert.deepEqual([s.auto, s.phase, s.round], [false, null, null]);

  // 阶段：切到“收集来源”，交接单可读
  assert.equal((await call('POST', `${P}/phase`, { to: 'sources' }, false)).status, 403);
  const ph = (await call('POST', `${P}/phase`, { to: 'sources' })).body;
  assert.match(ph.handoff.text, /阶段交接单：（开始） → 收集来源/);
  assert.equal((await call('GET', `${P}/handoffs/${ph.handoff.id}`)).body.text, ph.handoff.text);
  // 研讨挂到项目上：记忆用当前阶段的空间
  const th = (await call('POST', '/api/threads', { project: '六', title: '讨论来源' })).body.thread;
  const space = (await call('GET', '/api/spaces')).body.find((x) => x.id === th.memorySpace);
  assert.equal(space.name, '工坊·六·收集来源');

  // 建一个抽取任务：默认关时不派
  const t = (await call('POST', `${P}/tasks`, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] })).body;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call('GET', `${P}/tasks/${t.id}`)).body.state, 'open');
  // 打开自动调度：派给分工表里的 deepseek，任务完成后由事件收轮
  assert.equal((await call('POST', `${P}/scheduler/auto`, { on: true })).body.auto, true);
  await until(async () => (await call('GET', `${P}/scheduler`)).body.rounds.length === 1, '收轮');
  s = (await call('GET', `${P}/scheduler`)).body;
  assert.deepEqual(s.rounds[0].tasks, [t.id]);
  assert.equal(s.rounds[0].phase, 'sources');
  assert.equal(s.rounds[0].assessment.changelog.not_filled, false);
  assert.deepEqual(s.rounds[0].assessment.content.changed, ['C001']);
  assert.equal((await call('GET', `${P}/tasks/${t.id}`)).body.state, 'done');
  await call('POST', `${P}/scheduler/auto`, { on: false });
});
