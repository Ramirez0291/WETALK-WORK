// 真实启动 server.mjs（假 Agent 作为参与者），从 HTTP、SSE 与 MCP 三个出口验证：
// 密封期间的草稿哪里都拿不到；任务的派发、认领、交稿走通；只有主持人能派发、揭晓、取消。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ROOT, tmpBase, cleanup } from './helpers.mjs';

const FAKE = path.join(ROOT, 'tests/workbench/fixtures/fake-agent.mjs');
const b64 = (s) => Buffer.from(s).toString('base64');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

let server;
let port;
let base;
let release;
const sse = [];
let sseReq;

before(async () => {
  base = tmpBase();
  port = await freePort();
  release = path.join(base, '放行');
  const fake = (id, ...args) => ({ id, name: id, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args] });
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [
      fake('alpha', 'say64', b64('甲的草稿 SEALED-ALPHA-5150')),
      fake('beta', 'say64', b64('乙的草稿 SEALED-BETA-6060'), release),
    ],
  }));
  const env = { ...process.env, WETALK_CONFIG: path.join(base, 'config.json'), WETALK_DATA: path.join(base, 'data'), WETALK_PROJECTS: path.join(base, '项目资料'), WETALK_PORT: String(port) };
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`服务没有启动：${out}`)), 15_000);
    server.stdout.on('data', () => out.includes('工坊已启动') && (clearTimeout(t), resolve()));
    server.on('exit', (code) => (clearTimeout(t), reject(new Error(`服务退出（${code}）：${out}`))));
  });
  // 订阅 SSE，收下所有事件
  sseReq = http.get(`http://127.0.0.1:${port}/api/events`, (res) => res.setEncoding('utf8').on('data', (d) => sse.push(d)));
});

after(async () => {
  sseReq?.destroy();
  fs.writeFileSync(release, '');
  if (server?.exitCode === null) {
    const exited = new Promise((r) => server.on('exit', r));
    server.kill();
    await exited;
  }
  await cleanup();
});

const url = (p) => `http://127.0.0.1:${port}${p}`;
let token;
async function call(method, p, body, host = false) {
  token ??= (await (await fetch(url('/'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)[1];
  const res = await fetch(url(p), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(host ? { 'X-Workbench-Host': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const P = `/api/projects/${encodeURIComponent('任务')}`;
const waitState = async (id, states) => {
  for (let i = 0; i < 300; i++) {
    const t = (await call('GET', `${P}/tasks/${id}`)).body;
    if (states.includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${id} 一直没有进入 ${states}`);
};
function grepTree(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (fs.readFileSync(f).includes(Buffer.from(needle))) hits.push(path.relative(dir, f));
    }
  };
  walk(dir);
  return hits;
}

// 走一遍 MCP（stdio JSON-RPC）
async function mcp(calls) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], { env: { ...process.env, WETALK_URL: url(''), WETALK_AGENT: 'Codex' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const replies = new Map();
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); replies.set(m.id, m); }
    }
  });
  const out = [];
  let id = 0;
  const send = async (method, params) => {
    const myId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    for (let k = 0; k < 200 && !replies.has(myId); k++) await new Promise((r) => setTimeout(r, 25));
    return replies.get(myId);
  };
  await send('initialize', {});
  for (const [name, args] of calls) out.push((await send('tools/call', { name, arguments: args }))?.result);
  child.kill();
  return out;
}

test('密封期间：HTTP、SSE、MCP、数据目录和项目目录里都拿不到已完成一方的草稿；揭晓后才有', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '任务' })).status, 200);
  const a = (await call('POST', `${P}/tasks`, { type: 'outline', title: '大纲甲' }, true)).body;
  const b = (await call('POST', `${P}/tasks`, { type: 'outline', title: '大纲乙' }, true)).body;
  assert.equal((await call('POST', `${P}/rounds`, { id: 'R1', tasks: [a.id, b.id] })).status, 403);
  assert.equal((await call('POST', `${P}/rounds`, { id: 'R1', tasks: [a.id, b.id] }, true)).status, 200);
  assert.equal((await call('POST', `${P}/tasks/${a.id}/dispatch`, { participant: 'alpha' })).status, 403); // 没有主持人令牌
  assert.equal((await call('POST', `${P}/tasks/${a.id}/dispatch`, { participant: 'alpha', round: 'R1' }, true)).status, 200);
  assert.equal((await call('POST', `${P}/tasks/${b.id}/dispatch`, { participant: 'beta', round: 'R1' }, true)).status, 200);
  await waitState(a.id, ['submitted']);
  const SECRET = 'SEALED-ALPHA-5150';
  const responses = [];
  for (const p of [`${P}/tasks`, `${P}/tasks/${a.id}`, `${P}/tasks/${a.id}/packet`, `${P}/rounds/R1`, `${P}/inbox`, `${P}/records`, `${P}/commits`, `${P}`, '/api/state']) {
    responses.push(JSON.stringify((await call('GET', p)).body));
  }
  for (const r of responses) assert.ok(!r.includes(SECRET));
  assert.ok(!sse.join('').includes(SECRET));
  const viaMcp = await mcp([['wetalk_task_list', { project: '任务' }], ['wetalk_record_read', { project: '任务', id: 'S001' }]]);
  assert.ok(!JSON.stringify(viaMcp).includes(SECRET));
  assert.deepEqual(grepTree(base, SECRET), []); // 数据目录、项目目录、配置、工作目录
  assert.equal((await call('POST', `${P}/rounds/R1/reveal`, {}, true)).status, 409); // 乙还没完成
  fs.writeFileSync(release, '');
  await waitState(b.id, ['submitted']);
  const revealed = await call('POST', `${P}/rounds/R1/reveal`, {}, true);
  assert.equal(revealed.status, 200);
  assert.equal((await call('GET', `${P}/tasks/${a.id}`)).body.state, 'done');
  assert.ok(grepTree(path.join(base, '项目资料'), SECRET).length >= 1);
});

test('MCP 外部会话：认领读资料的任务、交稿晋升；身份记为未证实；密封任务不能认领', async () => {
  const t = (await call('POST', `${P}/tasks`, { type: 'collect_sources', title: '找来源' }, true)).body;
  const [claimed] = await mcp([['wetalk_task_claim', { project: '任务', task_id: t.id }]]);
  const text = claimed.content[0].text;
  const attempt = Number(text.match(/attempt=(\d+)/)[1]);
  const lease = text.match(/lease_token=([0-9a-f]+)/)[1];
  assert.match(text, /任务包 T\d+-a1/);
  const changes = [{ kind: 'source', expected_version: 0, data: { title: '外部会话找到的来源', url: 'https://example.org/x' } }];
  const [submitted] = await mcp([['wetalk_submit', { project: '任务', task_id: t.id, attempt, lease_token: lease, request_id: 'mcp-submit-0001', changes }]]);
  assert.match(submitted.content[0].text, /已收稿并晋升/);
  const task = (await call('GET', `${P}/tasks/${t.id}`)).body;
  assert.equal(task.state, 'done');
  assert.equal(task.lease_token, undefined); // 接口里不返回租约凭证
  const rec = (await call('GET', `${P}/records/${task.result.records[0].id}`)).body.record;
  assert.deepEqual([rec.provenance.kind, rec.provenance.participant, rec.provenance.verified], ['mcp', 'Codex', false]);
  const s = (await call('POST', `${P}/tasks`, { type: 'outline' }, true)).body;
  const [refused] = await mcp([['wetalk_task_claim', { project: '任务', task_id: s.id }]]);
  assert.match(refused.content[0].text, /只能由服务端派发/);
  // 外部会话提议的任务：记为未证实的提议者
  const proposed = (await call('POST', `${P}/tasks`, { type: 'check_citations', agent: 'Codex' })).body;
  assert.deepEqual([proposed.created_by.kind, proposed.created_by.verified], ['mcp', false]);
  assert.equal((await call('POST', `${P}/tasks/${proposed.id}/cancel`, {})).status, 403);
  assert.equal((await call('POST', `${P}/tasks/${proposed.id}/cancel`, {}, true)).body.state, 'cancelled');
});
