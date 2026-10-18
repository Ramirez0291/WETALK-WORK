// 契约三：任务与租约。时钟可注入，租约不用真等。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { setup, restart, rid, DEFAULTS, cleanup, readJson } from './helpers.mjs';

after(cleanup);
const P = '样本';
const AGENT_A = { kind: 'mcp', participant: 'Codex', model: 'gpt-6-astra', verified: false, basis: 'mcp-self-reported' };
const AGENT_B = { kind: 'server', participant: 'claude', model: 'claude-opus-5-5', adapter: 'claude', verified: true, basis: 'server-invoked' };
const HOST = { kind: 'human', participant: '主持人', verified: true, basis: 'host-session' };

async function tasksEnv(protocol = {}) {
  const env = await setup();
  if (Object.keys(protocol).length) fs.writeFileSync(path.join(env.projectsDir, P, 'protocol.json'), JSON.stringify(protocol));
  let t = Date.parse('2026-10-20T00:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms) => (t += ms) };
  const usage = createUsage({ workbench: env.workbench, pricing: DEFAULTS.pricing, now: clock.now });
  const board = createTaskBoard({ workbench: env.workbench, usage, now: clock.now });
  const { gw } = await restart(env, { fence: board.fence, now: clock.now });
  return { ...env, gw, board, usage, clock };
}

const source = (title) => [{ kind: 'source', expected_version: 0, data: { title, url: 'https://example.org/' + encodeURIComponent(title) } }];
function submitAs(env, task, cred, changes, request_id = rid()) {
  return env.gw.receive(P, { request_id, task_id: task, attempt: cred.attempt, lease_token: cred.lease_token, changes });
}

test('A 认领后卡住、租约过期；B 接手并提交成功；A 恢复后提交：A 的结果存为历史草稿，B 的结果不受影响', async () => {
  const env = await tasksEnv();
  const t = env.board.create(P, { type: 'extract_claims', title: '抽取' }, { created_by: HOST });
  assert.equal(t.state, 'open');
  const a = env.board.claim(P, t.id, AGENT_A);
  env.clock.advance((DEFAULTS.lease.minutes + 1) * 60_000); // A 卡住，租约过期
  assert.equal(env.board.get(P, t.id).state, 'open');
  assert.equal(env.board.get(P, t.id).attempts[0].outcome, 'abandoned');
  const b = env.board.claim(P, t.id, AGENT_B);
  assert.equal(b.attempt, 2);
  const rb = submitAs(env, t.id, b, source('B 的结果'));
  assert.equal(rb.state, 'received');
  assert.equal(env.board.get(P, t.id).state, 'submitted');
  const pb = await env.gw.promote(P, rb.sid);
  assert.equal(env.board.get(P, t.id).state, 'done');
  // A 恢复后提交：栅栏不通过，存为历史草稿，永不晋升
  const ra = submitAs(env, t.id, a, source('A 迟到的结果'));
  assert.equal(ra.state, 'draft');
  assert.match(ra.reason, /尝试号 1 不是当前的 2|租约凭证不是当前值|任务处于 done/);
  await assert.rejects(env.gw.promote(P, ra.sid), { status: 409 });
  assert.deepEqual(env.board.get(P, t.id).result.records, pb.records);
  assert.equal(env.gw.getRecord(P, 'S001').record.title, 'B 的结果');
  // B 的身份按它认领的那次尝试派生，是服务端发起、已证实的
  const prov = env.gw.getRecord(P, 'S001').record.provenance;
  assert.deepEqual([prov.kind, prov.participant, prov.vendor, prov.verified, prov.attempt], ['server', 'claude', 'anthropic', true, 2]);
});

test('服务已接受结果但响应丢失，客户端用同一 request_id 重试：返回第一次的结果，不产生第二个版本；内容不同则冲突', async () => {
  const env = await tasksEnv();
  const t = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
  const c = env.board.claim(P, t.id, AGENT_A);
  const reqId = rid();
  const first = submitAs(env, t.id, c, source('甲'), reqId);
  await env.gw.promote(P, first.sid);
  // 响应丢了；此时任务已经 done、租约已不在，但同一 request_id 的重试照样拿到第一次的回执
  const again = submitAs(env, t.id, c, source('甲'), reqId);
  assert.equal(again.sid, first.sid);
  assert.equal(again.duplicate, true);
  assert.equal((await env.gw.promote(P, again.sid)).duplicate, true);
  assert.equal(env.gw.getRecord(P, 'S001').record.version, 1);
  assert.equal(env.gw.listRecords(P).length, 1);
  assert.throws(() => submitAs(env, t.id, c, source('乙'), reqId), { status: 409 });
});

test('任务连续失败到上限：转 failed，进入待你决定，不再循环', async () => {
  const env = await tasksEnv({ task: { maxAttempts: 2 } });
  const t = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
  for (let i = 1; i <= 2; i++) {
    const c = env.board.claim(P, t.id, AGENT_B);
    env.board.failAttempt(P, t.id, c, `第 ${i} 次调用失败`);
  }
  const task = env.board.get(P, t.id);
  assert.equal(task.state, 'failed');
  assert.deepEqual(task.attempts.map((a) => a.outcome), ['error', 'error']);
  assert.throws(() => env.board.claim(P, t.id, AGENT_B), { status: 409 });
  // 晋升失败也算一次失败的尝试
  const t2 = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
  await (async () => {
    const seed = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
    const c = env.board.claim(P, seed.id, AGENT_B);
    await env.gw.promote(P, submitAs(env, seed.id, c, source('底稿')).sid);
  })();
  const edit = (title) => [{ id: 'S001', expected_version: 1, data: { title, url: 'https://example.org/x' } }];
  for (let i = 1; i <= 2; i++) {
    const c = env.board.claim(P, t2.id, AGENT_B);
    const r = submitAs(env, t2.id, c, edit(`改法 ${i}`));
    if (i === 1) {
      // 另一个任务先把 S001 改成 v2，这次晋升就会版本冲突
      const other = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
      const oc = env.board.claim(P, other.id, AGENT_A);
      await env.gw.promote(P, submitAs(env, other.id, oc, edit('抢先的改法')).sid);
    }
    await assert.rejects(env.gw.promote(P, r.sid), { status: 409 });
  }
  assert.equal(env.board.get(P, t2.id).state, 'failed');
  assert.deepEqual(env.board.get(P, t2.id).attempts.map((a) => a.outcome), ['promote_failed', 'promote_failed']);
});

test('服务重启：服务自己发起的进行中任务被释放、可以重新认领；MCP 外部会话的租约保留到期为止', async () => {
  const env = await tasksEnv();
  const s = env.board.create(P, { type: 'extract_claims', title: '服务调用' }, { created_by: HOST });
  const m = env.board.create(P, { type: 'extract_claims', title: '外部会话' }, { created_by: HOST });
  env.board.claim(P, s.id, AGENT_B);
  const mc = env.board.claim(P, m.id, AGENT_A);
  // 模拟重启：新建一个看板读同一份文件
  const board2 = createTaskBoard({ workbench: env.workbench, usage: env.usage, now: env.clock.now });
  assert.deepEqual(board2.recover(P), [s.id]);
  assert.equal(board2.get(P, s.id).state, 'open');
  assert.equal(board2.get(P, s.id).attempts[0].outcome, 'abandoned');
  assert.equal(board2.claim(P, s.id, AGENT_B).attempt, 2);
  assert.equal(board2.get(P, m.id).state, 'claimed');
  assert.ok(board2.renew(P, m.id, mc).lease_until); // 外部会话可以继续续租
  env.clock.advance((DEFAULTS.lease.minutes + 1) * 60_000);
  assert.equal(board2.get(P, m.id).state, 'open');
});

test('自动提议的子任务超过深度上限：进入待你决定，不能被认领、不自动执行', async () => {
  const env = await tasksEnv({ task: { maxDepth: 1 } });
  const root = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
  const child = env.board.create(P, { type: 'check_citations', parent: root.id }, { created_by: AGENT_A });
  assert.equal(child.depth, 1);
  assert.equal(child.state, 'open');
  const grandchild = env.board.create(P, { type: 'check_citations', parent: child.id }, { created_by: AGENT_A });
  assert.equal(grandchild.depth, 2);
  assert.equal(grandchild.state, 'needs_user');
  assert.match(grandchild.history.at(-1).reason, /深度 2 超过上限 1/);
  assert.throws(() => env.board.claim(P, grandchild.id, AGENT_B), { status: 409 });
  // 你仍可以取消；提高上限之前不能重开
  assert.throws(() => env.board.decide(P, grandchild.id, 'open', '主持人'), /深度/);
  assert.equal(env.board.decide(P, grandchild.id, 'cancelled', '主持人').state, 'cancelled');
});

test('类型不在允许列表、预算用完：新任务进入待你决定；超预算时的重试也进入待你决定', async () => {
  const env = await tasksEnv({ budget: { calls: 1 } });
  assert.equal(env.board.create(P, { type: 'make_coffee' }, { created_by: HOST }).state, 'needs_user');
  const t = env.board.create(P, { type: 'extract_claims' }, { created_by: HOST });
  const c = env.board.claim(P, t.id, AGENT_B);
  env.usage.reserve(P, { api: 'chat', attempt: 1, task: t.id }); // 用掉唯一的调用名额
  env.board.failAttempt(P, t.id, c, '调用失败');
  assert.equal(env.board.get(P, t.id).state, 'needs_user');
  assert.match(env.board.get(P, t.id).history.at(-1).reason, /调用次数已到上限/);
  assert.equal(env.board.create(P, { type: 'extract_claims' }, { created_by: HOST }).state, 'needs_user');
  assert.deepEqual(env.board.budgetUsed(P, t.id), { calls: 1, usd: 0 });
});

test('依赖、指派、续租、释放、取消：各自的约束', async () => {
  const env = await tasksEnv();
  const first = env.board.create(P, { type: 'collect_sources' }, { created_by: HOST });
  const second = env.board.create(P, { type: 'extract_claims', depends_on: [first.id], assigned_to: 'claude' }, { created_by: HOST });
  assert.throws(() => env.board.claim(P, second.id, AGENT_B), /依赖的任务/);
  const c1 = env.board.claim(P, first.id, AGENT_A);
  env.clock.advance(20 * 60_000);
  const before = env.board.get(P, first.id).lease_until;
  env.board.renew(P, first.id, c1);
  assert.ok(Date.parse(env.board.get(P, first.id).lease_until) > Date.parse(before));
  assert.throws(() => env.board.renew(P, first.id, { ...c1, lease_token: 'x' }), { status: 409 });
  await env.gw.promote(P, submitAs(env, first.id, c1, source('来源')).sid);
  assert.throws(() => env.board.claim(P, second.id, AGENT_A), /已指派给 claude/);
  const c2 = env.board.claim(P, second.id, AGENT_B);
  assert.equal(env.board.release(P, second.id, c2).state, 'open');
  // 取消：进行中的调用被中止，之后到达的结果只存历史
  const c3 = env.board.claim(P, second.id, AGENT_B);
  const ac = new AbortController();
  env.board.track(P, second.id, ac);
  env.board.cancel(P, second.id, '主持人');
  assert.equal(ac.signal.aborted, true);
  const late = submitAs(env, second.id, c3, source('取消后才到的结果'));
  assert.equal(late.state, 'draft');
  assert.throws(() => env.board.cancel(P, second.id, '主持人'), { status: 409 });
});

test('任务文件逐次落盘：重新加载后状态与历史一致', async () => {
  const env = await tasksEnv();
  const t = env.board.create(P, { type: 'extract_claims', inputs: [{ blob: 'a'.repeat(64), name: '片段.md' }] }, { created_by: HOST });
  env.board.claim(P, t.id, AGENT_A);
  const onDisk = readJson(path.join(env.projectsDir, P, 'tasks', `${t.id}.json`));
  assert.equal(onDisk.state, 'claimed');
  assert.deepEqual(onDisk.history.map((h) => h.to), ['proposed', 'open', 'claimed']);
  assert.throws(() => env.board.create(P, { type: 'extract_claims', inputs: [{ id: 'S001' }] }, { created_by: HOST }), /inputs\[0\]/);
});
