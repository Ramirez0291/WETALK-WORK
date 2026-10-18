// WP4 评审（Astra）发现的 9 个问题的回归测试：R1–R9。假 Agent、本地模拟 API，不调用真实模型。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { blobStore } from '../../lib/workbench/records.mjs';
import { createDeepseekClient } from '../../lib/workbench/deepseek.mjs';
import { resetPhase, phaseSpace } from '../../lib/workbench/phases.mjs';
import { createStore } from '../../lib/store.mjs';
import { runAgent, parseCodexEvents } from '../../lib/agents.mjs';
import { startMock, chatOk, apiError } from './mock-deepseek.mjs';
import { setup, restart, DEFAULTS, ROOT, tmpBase, cleanup } from './helpers.mjs';

after(cleanup);
const HOST = { kind: 'human', participant: '主持人', verified: true, basis: 'host-session' };
const MCP = { kind: 'mcp', participant: 'Codex', verified: false, basis: 'mcp-session' };
const basic = { id: 'fixture', name: 'Fixture', adapter: 'generic', model: 'fixture', resolved: process.execPath };
const reply = (raw, audit = null) => ({ raw, audit, model: 'fixture', exec: { args: [], stdoutTail: raw }, usage: null });
const source = (title) => [{ kind: 'source', expected_version: 0, data: { title, url: 'https://example.org/' } }];
const tick = () => new Promise((r) => setImmediate(r));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// 可注入时钟与 runAgent 的环境
async function env({ projects = ['甲'], invoke = async () => reply('草稿'), people = [basic], deepseek = null } = {}) {
  let ms = Date.now();
  const now = () => new Date(ms);
  const e = await setup({ projects });
  const usage = createUsage({ workbench: e.workbench, pricing: DEFAULTS.pricing, now });
  const board = createTaskBoard({ workbench: e.workbench, usage, now });
  const { gw } = await restart(e, { fence: board.fence, now });
  const base = tmpBase();
  const runner = createRunner({
    workbench: e.workbench, gateway: gw, board, usage, sealed: createSealedStore(),
    participants: Object.assign((id) => people.find((p) => p.id === id), { all: () => people }),
    runAgent: invoke, deepseek, workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), now, timeoutMs: 10_000,
  });
  return { ...e, gw, usage, board, runner, advance: (n) => { ms += n; } };
}
const task = (e, p, spec = {}) => e.board.create(p, { type: 'outline', ...spec }, { created_by: HOST });
const blobText = (e, p, h) => blobStore(e.workbench.get(p).dir).get(h).toString('utf8');

test('R1 服务重启时有服务自己发起的进行中任务：启动恢复会广播事件，服务照常启动并把任务放回 open', async () => {
  const e = await env();
  const t = task(e, '甲');
  e.board.claim('甲', t.id, { kind: 'server', participant: 'fixture', verified: true, basis: 'server-invoked' });
  await e.gw.queue.idle();
  e.gw.stop();
  const base = tmpBase();
  const port = await freePort();
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ participants: [], humanName: '主持人', port }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, WETALK_CONFIG: path.join(base, 'config.json'), WETALK_PROJECTS: e.projectsDir, WETALK_DATA: path.join(base, 'data'), WETALK_PORT: String(port), DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', r));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务没有启动：${out}`)), 15_000);
      child.stdout.on('data', () => out.includes('工坊已启动') && (clearTimeout(timer), resolve()));
      child.on('exit', (code) => (clearTimeout(timer), reject(new Error(`服务退出（${code}）：${out}`))));
    });
    assert.match(out, /重启释放任务：T001/);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent('甲')}/tasks/T001`);
    assert.equal((await res.json()).state, 'open');
  } finally {
    child.kill();
    await exited;
  }
});

test('R2 收稿后、晋升前任务被取消：候选稿不再晋升，正式区没有记录；写入期间不能取消', async () => {
  const e = await env();
  const t = task(e, '甲', { type: 'extract_claims' });
  const c = e.board.claim('甲', t.id, MCP);
  const r = e.gw.receive('甲', { request_id: 'r2-cancel-0001', task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes: source('取消后的稿') });
  assert.equal(e.board.get('甲', t.id).state, 'submitted');
  e.board.cancel('甲', t.id, '主持人');
  await assert.rejects(e.gw.promote('甲', r.sid), (err) => err.status === 409 && /候选稿不再晋升/.test(err.message));
  assert.equal(e.gw.listRecords('甲').length, 0);
  assert.equal(e.board.get('甲', t.id).state, 'cancelled');

  // 检查通过、正在写入时：取消被拒绝，晋升照常完成
  const t2 = task(e, '甲', { type: 'extract_claims' });
  const c2 = e.board.claim('甲', t2.id, MCP);
  const r2 = e.gw.receive('甲', { request_id: 'r2-cancel-0002', task_id: t2.id, attempt: c2.attempt, lease_token: c2.lease_token, changes: source('照常晋升的稿') });
  const release = e.board.fence.holdPromotion('甲', t2.id);
  assert.throws(() => e.board.cancel('甲', t2.id, '主持人'), (err) => err.status === 409 && /正在写入正式区/.test(err.message));
  release();
  await e.gw.promote('甲', r2.sid);
  assert.equal(e.board.get('甲', t2.id).state, 'done');
});

test('R3 过期的旧尝试在当前尝试密封之后才返回：旧结果丢弃，揭晓的是当前尝试的稿', async () => {
  const pending = [];
  const e = await env({ invoke: () => new Promise((resolve) => pending.push(resolve)) });
  const t = task(e, '甲');
  e.runner.dispatch('甲', t.id, 'fixture');
  e.advance((DEFAULTS.lease.minutes + 1) * 60_000);
  assert.equal(e.board.get('甲', t.id).state, 'open'); // 第 1 次尝试过期
  e.runner.dispatch('甲', t.id, 'fixture');
  pending[1](reply('当前尝试 ATTEMPT-2'));
  await tick();
  pending[0](reply('过期尝试 ATTEMPT-1'));
  await e.runner.idle();
  const r = e.runner.reveal('甲', `R-${t.id}`);
  assert.equal(blobText(e, '甲', r.results[0].text_blob), '当前尝试 ATTEMPT-2');
  const calls = e.runner.callLogOf('甲').getMany((x) => x.task === t.id && !x.fill_of);
  assert.equal(calls.find((x) => x.attempt === 1).status, 'stale');
  assert.ok(!fs.readFileSync(path.join(e.workbench.get('甲').dir, 'calls.jsonl'), 'utf8').includes('ATTEMPT-1'));
});

test('R4 两个项目的同号任务各自的默认密封轮次互不相干；同一任务不能进两个轮次', async () => {
  let n = 0;
  const e = await env({ projects: ['甲', '乙'], invoke: async () => reply(++n === 1 ? '甲项目的稿' : '乙项目的稿') });
  const a = task(e, '甲');
  const b = task(e, '乙');
  assert.equal(a.id, b.id);
  const da = e.runner.dispatch('甲', a.id, 'fixture');
  await e.runner.idle();
  const db = e.runner.dispatch('乙', b.id, 'fixture');
  await e.runner.idle();
  assert.equal(e.board.get('乙', b.id).state, 'submitted');
  const ra = e.runner.reveal('甲', da.round);
  assert.equal(blobText(e, '甲', ra.results[0].text_blob), '甲项目的稿');
  assert.equal(e.board.get('乙', b.id).state, 'submitted'); // 乙项目的轮次没被动
  const rb = e.runner.reveal('乙', db.round);
  assert.equal(blobText(e, '乙', rb.results[0].text_blob), '乙项目的稿');
  const sealed = createSealedStore();
  sealed.open('甲', 'R1', ['T005']);
  assert.throws(() => sealed.open('甲', 'R2', ['T005']), /已在密封轮次 R1/);
  sealed.open('乙', 'R1', ['T005']); // 别的项目可以用同一个轮次号
});

test('R5 密封期间的调用记录与任务历史里没有工具参数、权限拒绝的输入，也没有失败报错里附带的输出', async () => {
  const secret = 'SEALED-AUDIT-CANARY';
  const parsed = parseCodexEvents({ code: 0, stderr: '', stdout: [
    { type: 'item.completed', item: { id: 'x', type: 'mcp_tool_call', server: 'fixture', tool: 'process_text', arguments: { text: secret } } },
    { type: 'item.completed', item: { id: 'y', type: 'agent_message', text: secret } },
    { type: 'turn.completed' },
  ].map((x) => JSON.stringify(x)).join('\n') });
  const e = await env({ invoke: async () => reply(parsed.text, { ...parsed.audit, permission_denials: [{ tool_name: 'Read', tool_input: { file: secret } }] }) });
  const t = task(e, '甲');
  e.runner.dispatch('甲', t.id, 'fixture');
  await e.runner.idle();
  const calls = () => fs.readFileSync(path.join(e.workbench.get('甲').dir, 'calls.jsonl'), 'utf8');
  assert.equal(e.board.get('甲', t.id).state, 'submitted');
  assert.ok(!calls().includes(secret));
  const placeholder = e.runner.callLogOf('甲').getMany((x) => x.task === t.id)[0];
  assert.deepEqual(placeholder.audit, { independence: 'unproven', toolEvents: 1, permissionDenials: 1, detail: 'sealed' });
  e.runner.reveal('甲', `R-${t.id}`);
  assert.ok(calls().includes(secret)); // 揭晓后完整审计随正文补写

  // 通用适配器失败：报错里附带的 stdout 不进任务历史和调用记录
  const file = path.join(tmpBase(), 'failing-agent.mjs');
  fs.writeFileSync(file, `for await (const x of process.stdin) {} process.stdout.write('SEALED-ERROR-CANARY'); process.exitCode = 1;`);
  const p = { ...basic, id: 'failing', command: [process.execPath], args: [file] };
  const e2 = await env({ invoke: runAgent, people: [p] });
  const t2 = task(e2, '甲');
  e2.runner.dispatch('甲', t2.id, 'failing');
  await e2.runner.idle();
  const task2 = e2.board.get('甲', t2.id);
  assert.equal(task2.state, 'open');
  assert.ok(!JSON.stringify(task2).includes('SEALED-ERROR-CANARY'));
  assert.match(task2.history.at(-1).reason, /退出码 1；密封期间不记录报错原文/);
  assert.ok(!fs.readFileSync(path.join(e2.workbench.get('甲').dir, 'calls.jsonl'), 'utf8').includes('SEALED-ERROR-CANARY'));
});

test('R6 阶段重置时归档写不进去：记忆原样保留（重启后也在），错误抛给调用方', () => {
  const dir = tmpBase();
  const file = path.join(dir, 'forum.json');
  const store = createStore(file);
  const space = phaseSpace(store, '甲', '评审');
  store.addMemory(`${space.id}/claude`, { name: 'Claude', content: '唯一的副本', source: 'test' });
  fs.writeFileSync(path.join(dir, 'archive'), '挡住目录创建');
  assert.throws(() => resetPhase({ store, projectDir: dir, project: '甲', phase: '评审' }), (e) => ['ENOTDIR', 'EEXIST'].includes(e.code));
  assert.equal(store.getMemory(`${space.id}/claude`).content, '唯一的副本');
  assert.equal(createStore(file).getMemory(`${space.id}/claude`).content, '唯一的副本');
});

test('R7 观众型读者的任务不接受 blob 输入：新建时拒绝；绕过新建直接组装任务包也拒绝', async () => {
  const e = await env();
  const h = blobStore(e.workbench.get('甲').dir).put(JSON.stringify({ id: 'C007', sources: ['S001'], text: 'CLAIM-AND-SOURCE-CANARY' }));
  assert.throws(() => task(e, '甲', { type: 'audience_reader', inputs: [{ blob: h, name: 'input.json' }] }), (err) => err.status === 400 && /不能直接给 blob/.test(err.message));
  const t = task(e, '甲', { type: 'audience_reader' });
  const forged = { ...t, inputs: [{ blob: h, name: 'input.json' }] };
  assert.throws(() => e.runner.buildParts('甲', forged, 1, 'audience', { inline: true }), /不能包含 blob 输入/);
});

test('R8 派发给 API 参与者的任务按项目生效的重试策略重试', async () => {
  const mock = await startMock();
  try {
    const client = createDeepseekClient({ apiKey: 'test-dummy', baseUrl: mock.url, retry: { max: 2, delaysSec: [0, 0] } });
    const p = { ...basic, id: 'ds', adapter: 'deepseek', model: 'deepseek-flash' };
    const e = await env({ invoke: runAgent, people: [p], deepseek: client });
    fs.writeFileSync(path.join(e.workbench.get('甲').dir, 'protocol.json'), JSON.stringify({ retry: { max: 0, delaysSec: [0] } }));
    assert.equal(e.workbench.get('甲').config.retry.max, 0);
    mock.script('/chat/completions', apiError(503), chatOk('```json\n' + JSON.stringify(source('不该重试出来的稿')) + '\n```'));
    const t = task(e, '甲', { type: 'extract_claims' });
    e.runner.dispatch('甲', t.id, 'ds');
    await e.runner.idle();
    assert.equal(mock.requests.length, 1);
    assert.equal(e.board.get('甲', t.id).state, 'open');
  } finally {
    await mock.close();
  }
});

test('R9 不同项目的同号读资料任务各用自己的工作目录，输入不会被另一个项目覆盖', async () => {
  const pending = [];
  const e = await env({ projects: ['甲', '乙'], invoke: (p, prompt, opts) => new Promise((resolve) => pending.push({ resolve, cwd: opts.cwd })) });
  const inA = blobStore(e.workbench.get('甲').dir).put('只属于甲的输入');
  const inB = blobStore(e.workbench.get('乙').dir).put('只属于乙的输入');
  const a = task(e, '甲', { type: 'extract_claims', inputs: [{ blob: inA, name: 'input.md' }] });
  const b = task(e, '乙', { type: 'extract_claims', inputs: [{ blob: inB, name: 'input.md' }] });
  e.runner.dispatch('甲', a.id, 'fixture');
  e.runner.dispatch('乙', b.id, 'fixture');
  assert.notEqual(pending[0].cwd, pending[1].cwd);
  assert.equal(fs.readFileSync(path.join(pending[0].cwd, 'input.md'), 'utf8'), '只属于甲的输入');
  assert.equal(fs.readFileSync(path.join(pending[1].cwd, 'input.md'), 'utf8'), '只属于乙的输入');
  for (const x of pending) x.resolve(reply('没有 changes 的回复'));
  await e.runner.idle();
  assert.ok(!fs.existsSync(pending[0].cwd) && !fs.existsSync(pending[1].cwd)); // 用完即删
});
