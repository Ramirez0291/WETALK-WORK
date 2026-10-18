// 真实启动 server.mjs（临时数据目录、临时项目目录、随机端口），从 HTTP 层验证工坊接口和命令行工具
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, tmpBase, cleanup } from './helpers.mjs';

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let server;
let base;
let port;
let projectsDir;
let env;

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`服务没有启动：${out}`)), 15_000);
    child.stdout.on('data', () => {
      if (out.includes('研讨室已启动')) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`服务退出（${code}）：${out}`));
    });
  });
  child.output = () => out;
  return child;
}

before(async () => {
  base = tmpBase();
  port = await freePort();
  projectsDir = path.join(base, '项目资料');
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port, humanName: '主持人', participants: [] }));
  env = { ...process.env, WETALK_CONFIG: config, WETALK_DATA: path.join(base, 'data'), WETALK_PROJECTS: projectsDir, WETALK_PORT: String(port) };
  server = await startServer();
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.on('exit', r));
    server.kill();
    await exited;
  }
  await cleanup();
});

const url = (p) => `http://127.0.0.1:${port}${p}`;
async function call(method, p, body, headers = {}) {
  const res = await fetch(url(p), {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const tokenFromPage = async () => (await (await fetch(url('/workbench'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)?.[1];

test('第二个服务实例被拒绝启动', async () => {
  const second = spawnSync(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...env, WETALK_PORT: String(port + 1) }, encoding: 'utf8', timeout: 15_000 });
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /已有工坊进程在使用项目目录/);
});

test('主持人入口：没有令牌、或令牌不对的提交被拒绝；自报身份无效', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '接口测试' })).status, 200);
  const P = `/api/projects/${encodeURIComponent('接口测试')}`;
  const changes = [{ kind: 'source', expected_version: 0, data: { title: 't', url: 'https://example.org' } }];
  const noToken = await call('POST', `${P}/submissions`, { request_id: 'req-00000001', author: '主持人', kind: 'human', changes });
  assert.equal(noToken.status, 403);
  const wrong = await call('POST', `${P}/submissions`, { request_id: 'req-00000002', changes }, { 'X-Workbench-Host': 'f'.repeat(48) });
  assert.equal(wrong.status, 403);
  const token = await tokenFromPage();
  assert.ok(token, '工坊页面里应该带着令牌');
  const ok = await call('POST', `${P}/submissions`, { request_id: 'req-00000003', changes }, { 'X-Workbench-Host': token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const promoted = await call('POST', `${P}/submissions/${ok.body.sid}/promote`, {});
  assert.equal(promoted.status, 200);
  assert.deepEqual(promoted.body.records, [{ id: 'S001', version: 1 }]);
  const record = await call('GET', `${P}/records/S001`);
  assert.equal(record.body.record.provenance.kind, 'human');
  assert.equal(record.body.record.provenance.participant, '主持人');
});

test('版本冲突以 409 返回，并附带原因明细；概况、追溯、提交列表可读', async () => {
  const P = `/api/projects/${encodeURIComponent('接口测试')}`;
  const token = await tokenFromPage();
  const edit = (rid) => call('POST', `${P}/submissions`, { request_id: rid, changes: [{ id: 'S001', expected_version: 1, data: { title: rid, url: 'https://example.org' } }] }, { 'X-Workbench-Host': token });
  const a = await edit('req-conflict-a');
  const b = await edit('req-conflict-b');
  assert.equal((await call('POST', `${P}/submissions/${a.body.sid}/promote`, {})).status, 200);
  const lost = await call('POST', `${P}/submissions/${b.body.sid}/promote`, {});
  assert.equal(lost.status, 409);
  assert.equal(lost.body.details.reasons[0].type, 'version_conflict');
  const overview = await call('GET', P);
  assert.equal(overview.body.summary.byKind.source, 1);
  assert.equal(overview.body.candidates.pending, 1);
  assert.equal((await call('GET', `${P}/trace/S001`)).body.root.current_version, 2);
  const commits = await call('GET', `${P}/commits`);
  assert.equal(commits.body.length, 2);
  assert.equal((await call('GET', `${P}/records?kind=nope`)).status, 400);
  assert.equal((await call('GET', `${P}/records/C999`)).status, 404);
});

test('服务在运行时，命令行新建项目走服务接口；服务停掉后才在本地创建', async () => {
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts/new-project.mjs'), `命令行${Date.now()}`], { env, encoding: 'utf8', timeout: 30_000 });
  const viaServer = run();
  assert.equal(viaServer.status, 0, viaServer.stderr);
  assert.match(viaServer.stdout, /服务 127\.0\.0\.1/);
  // 接口连不上、但服务进程还活着（这里用一个错的端口模拟“连接失败”）：取不到锁，拒绝在本地写
  const wrongPort = spawnSync(process.execPath, [path.join(ROOT, 'scripts/new-project.mjs'), '不该建出来'], { env: { ...env, WETALK_PORT: '1' }, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(wrongPort.status, 0);
  assert.match(wrongPort.stderr, /已有工坊进程在使用项目目录/);
  assert.equal(fs.existsSync(path.join(projectsDir, '不该建出来')), false);
  // 服务停掉以后：本地创建
  const exited = new Promise((r) => server.on('exit', r));
  server.kill();
  await exited;
  const local = run();
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /本地（服务未运行）/);
  assert.equal(fs.existsSync(path.join(projectsDir, '.workbench.lock')), false); // 用完释放
});
