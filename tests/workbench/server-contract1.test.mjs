// 契约一经 HTTP 与 MCP：真实启动 server.mjs，假 Agent 的模型名决定厂商（deepseek-* / claude-* / gpt-*）。
// 走一遍：主持人录入来源 → DeepSeek 抽取论断 → 主持人派对抗核验（自动挑跨厂商的核验者）→ 主持人核验与异议 →
// 待你决定 → 来源确认 gone 后规则自动提异议 → MCP 会话的核验与异议。
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
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';

let server;
let port;
before(async () => {
  const base = tmpBase();
  port = await freePort();
  const fake = (id, model, ...args) => ({ id, name: id, model, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args] });
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [
      fake('ds', 'deepseek-fake', 'json', b64([{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }])),
      fake('cl', 'claude-fake', 'json', b64({ verdict: 'unsupported', reason: '来源说的是没有证据', objections: [] })),
      fake('cx', 'gpt-fake', 'json', b64({ verdict: 'supported', reason: '有原文', support_quote: { id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }, objections: [] })),
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
async function call(method, p, body, host = false) {
  token ??= (await (await fetch(url('/'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)[1];
  const res = await fetch(url(p), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(host ? { 'X-Workbench-Host': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const P = `/api/projects/${encodeURIComponent('核验')}`;
const until = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等不到：${what}`);
};
const record = async (id) => (await call('GET', `${P}/records/${id}`)).body;

async function mcp(calls) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], { env: { ...process.env, WETALK_URL: url(''), WETALK_AGENT: '外部会话' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  let id = 0;
  const send = async (method, params) => {
    const myId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    for (let k = 0; k < 200 && !replies.has(myId); k++) await new Promise((r) => setTimeout(r, 25));
    return replies.get(myId);
  };
  await send('initialize', {});
  const out = [];
  for (const [name, args] of calls) out.push((await send('tools/call', { name, arguments: args }))?.result);
  child.kill();
  return out;
}

test('契约一经 HTTP：对抗核验自动挑跨厂商的核验者、主持人核验与异议、待你决定、gone 自动异议；MCP 会话的核验不计入', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '核验' })).status, 200);
  // 主持人录入来源；DeepSeek 抽取论断
  let r = await call('POST', `${P}/submissions`, { request_id: 'host-source-0001', changes: [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }] }, true);
  assert.equal((await call('POST', `${P}/submissions/${r.body.sid}/promote`, {})).status, 200);
  const t = (await call('POST', `${P}/tasks`, { type: 'extract_claims', title: '抽取' }, true)).body;
  assert.equal((await call('POST', `${P}/tasks/${t.id}/dispatch`, { participant: 'ds' }, true)).status, 200);
  await until(async () => (await call('GET', `${P}/tasks/${t.id}`)).body.state === 'done', '抽取完成');
  assert.equal((await record('C001')).record.provenance.vendor, 'deepseek');

  // 对抗核验：只限主持人；自动挑能计入的核验者（cl 在前）；指定同厂商的被拒
  assert.equal((await call('POST', `${P}/claims/C001/verify`, {})).status, 403);
  assert.equal((await call('POST', `${P}/claims/C001/verify`, { participants: ['ds'] }, true)).status, 409);
  r = await call('POST', `${P}/claims/C001/verify`, {}, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.dispatched.map((d) => d.task.assigned_to), ['cl']);
  const vt = r.body.dispatched[0].task.id;
  await until(async () => (await call('GET', `${P}/tasks/${vt}`)).body.state === 'done', '核验完成');
  let c = await record('C001');
  assert.equal(c.status.verification.state, 'unsupported');
  assert.equal((await record('V001')).record.verifier.vendor, 'anthropic');
  // cl 已核验过：再派时自动挑下一位
  r = await call('POST', `${P}/claims/C001/verify`, {}, true);
  assert.deepEqual(r.body.dispatched.map((d) => d.task.assigned_to), ['cx']);
  await until(async () => (await call('GET', `${P}/tasks/${r.body.dispatched[0].task.id}`)).body.state === 'done', '第二份核验完成');
  c = await record('C001');
  assert.equal(c.status.verification.state, 'disputed');
  let inbox = (await call('GET', `${P}/inbox`)).body;
  assert.ok(inbox.some((x) => x.type === 'claim_disputed' && x.claim === 'C001'));

  // 主持人核验（算一份）、提异议、转待你决定、裁决
  r = await call('POST', `${P}/verifications`, { target: { id: 'C001', version: 1 }, verdict: 'unsupported', reason: '主持人看过原文' }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await record(r.body.result.records[0].id)).record.verifier.kind, 'human');
  r = await call('POST', `${P}/objections`, { target: { id: 'C001', version: 1 }, category: 'quote_unsupported', pointer: { type: 'quote', source: { id: 'S001', version: 1 }, quote: '没有证据表明 A 导致 B' }, reason: '引文与论断相反' }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await record('C001')).status.blockers, ['O001']);
  r = await call('POST', `${P}/objections/O001/resolve`, { state: 'needs_user', resolution: '先放着' }, true);
  assert.equal(r.status, 200);
  inbox = (await call('GET', `${P}/inbox`)).body;
  assert.ok(inbox.some((x) => x.type === 'objection_needs_user' && x.objection === 'O001'));
  r = await call('POST', `${P}/objections/O001/resolve`, { state: 'upheld', resolution: '主持人裁决：成立' }, true);
  assert.equal(r.status, 200);
  assert.equal((await record('O001')).record.state, 'upheld');

  // 来源确认 gone：规则自动对 C001 提“来源不存在”异议
  assert.equal((await call('POST', `${P}/sources/S001/availability`, { state: 'gone' }, true)).status, 200);
  const gone = await until(async () => (await call('GET', `${P}/records?kind=objection`)).body.find((x) => x.record.pointer.type === 'gone'), '规则异议');
  assert.equal(gone.record.raised_by.kind, 'system');
  assert.deepEqual((await record('C001')).status.blockers.sort(), ['O001', gone.record.id].sort());

  // MCP 会话：核验保存但不计入；不合规的异议把原因交回
  const [okText, badText] = await mcp([
    ['wetalk_verification_create', { project: '核验', target: { id: 'C001', version: 1 }, verdict: 'unsupported', reason: '外部会话的意见' }],
    ['wetalk_objection_create', { project: '核验', target: { id: 'C001', version: 1 }, category: 'number_error', pointer: { type: 'location', locator: '第 3 章' }, reason: '数字对不上', state: 'open' }],
  ]);
  assert.match(okText.content[0].text, /已写入核验/);
  assert.match(badText.content[0].text, /pointer_type/);
  c = await record('C001');
  assert.ok(c.status.verification.uncounted.some((u) => u.reason === 'identity_unverified'));
});
