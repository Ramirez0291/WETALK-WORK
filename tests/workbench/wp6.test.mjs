// WP6：自动调度与阶段重置。调度只执行规则：按分工表派发已就绪的任务、冷却、上限；一轮 = 一批派发到全部结束，
// 收轮时区分三种情况（没填改动记录、内容没有变化、有变化但质量指标没有提升）；七步阶段由主持人切换，生成交接单、切换记忆空间。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner, parseResult } from '../../lib/workbench/runner.mjs';
import { createSealedStore, anonymityTerms, findNames } from '../../lib/workbench/visibility.mjs';
import { createScheduler } from '../../lib/workbench/scheduler.mjs';
import { assessRound, resolveChangelog, normalizeChangelog, createChangelog } from '../../lib/workbench/changelog.mjs';
import { audienceConfusions } from '../../lib/workbench/modes.mjs';
import { phaseSpace, buildHandoff, PHASES } from '../../lib/workbench/phases.mjs';
import { formatTranscript } from '../../lib/agents.mjs';
import { createStore } from '../../lib/store.mjs';
import { blobStore } from '../../lib/workbench/records.mjs';
import { restorePacket } from '../../lib/workbench/packets.mjs';
import { workbenchRoutes } from '../../lib/workbench/http.mjs';
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase, readJson } from './helpers.mjs';

after(cleanup);
const P = '样本';
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';
const PEOPLE = [
  { id: 'claude', name: 'Claude', adapter: 'claude', model: 'claude-opus-5-5', resolved: 'claude' },
  { id: 'codex', name: 'Codex', adapter: 'codex', model: 'gpt-6-astra', resolved: 'codex' },
  { id: 'deepseek-pro', name: 'DeepSeek Pro', adapter: 'deepseek', model: 'deepseek-pro', resolved: 'api' },
];
const json = (v) => '```json\n' + JSON.stringify(v) + '\n```';

async function env(protocol = null) {
  const e = await setup();
  if (protocol) fs.writeFileSync(path.join(e.workbench.get(P).dir, 'protocol.json'), JSON.stringify(protocol));
  const usage = createUsage({ workbench: e.workbench, pricing: DEFAULTS.pricing });
  const board = createTaskBoard({ workbench: e.workbench, usage });
  const { gw } = await restart(e, { fence: board.fence });
  return { ...e, gw, usage, board };
}

// 假参与者：script[参与者] 是回复数组或 (prompt) => 回复；回复是文字，或抛出的错误（{ throw: Error }）
function world(e, script = {}, { store = null, clock = null } = {}) {
  const lookup = Object.assign((id) => PEOPLE.find((p) => p.id === id) ?? null, { all: () => PEOPLE });
  const prompts = [];
  const base = tmpBase();
  const now = clock ? () => new Date(clock.t) : () => new Date();
  let scheduler;
  const runner = createRunner({
    workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, sealed: createSealedStore(), participants: lookup,
    runAgent: async (p, prompt) => {
      prompts.push({ who: p.id, prompt });
      const s = script[p.id];
      const r = await (typeof s === 'function' ? s(prompt) : Array.isArray(s) ? s.shift() : s);
      if (r == null) throw new Error(`${p.id} 没有准备回复`);
      if (r.throw) throw r.throw;
      return { raw: r, model: null, exec: { args: [] }, usage: null, audit: null };
    },
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
    onFailure: (x) => scheduler.noteFailure(x),
    handoffOf: (p) => scheduler.handoffOf(p),
  });
  scheduler = createScheduler({ workbench: e.workbench, gateway: e.gw, board: e.board, runner, participants: lookup, store, cooldownFile: path.join(base, '_cooldowns.json'), now });
  return { runner, scheduler, prompts, cooldownFile: path.join(base, '_cooldowns.json'), lookup };
}

async function asHost(e, changes) {
  const r = e.gw.receive(P, { request_id: rid(), changes }, { actor: HUMAN });
  return e.gw.promote(P, r.sid);
}
const source = (extra = {}) => ({ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT, ...extra } });
const claim = (tmp, quote = 'A 导致 B') => ({ kind: 'claim', expected_version: 0, tmp, data: { type: 'fact', text: quote, sources: [{ id: 'S001', version: 1, quote }] } });
const task = (e, spec) => e.board.create(P, spec, { created_by: HUMAN });

// ---------- 派发 ----------

test('自动调度默认关；“跑一轮”把已就绪的任务按分工表或指派派出去；依赖没完成的不派；参与者手上有任务、分工表里没有人的记下原因', async () => {
  const e = await env({ plateau: { rounds: 3 } });
  await asHost(e, [source()]);
  const w = world(e, { 'deepseek-pro': [json({ changes: [claim('$c1')], changelog: [{ id: '$c1', type: 'evidence', note: '从 S001 抽出' }] })], claude: ['## 一\n大纲。'] });
  const t1 = task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] }); // 分工表 extract → deepseek
  const t2 = task(e, { type: 'outline', assigned_to: 'claude' }); // 指派
  const t3 = task(e, { type: 'check_citations', depends_on: [t1.id] }); // 依赖没完成
  const t4 = task(e, { type: 'collect_sources' }); // 分工表 search → deepseek，但它手上已有 t1
  const t5 = task(e, { type: 'key_number' }); // 分工表 verify → different_vendor：谁都可以，但 claude 手上有 t2、codex 空着
  // 默认关：调度一步什么都不做
  w.scheduler.step(P);
  assert.equal(e.board.get(P, t1.id).state, 'open');
  assert.equal(w.scheduler.state(P).auto, false);
  const r = w.scheduler.runOnce(P, '主持人');
  assert.deepEqual(r.round.tasks, [t1.id, t2.id, t5.id]);
  assert.equal(e.board.get(P, t5.id).holder.participant, 'codex');
  assert.match(r.last.skipped.find((x) => x.task === t4.id).reason, /deepseek-pro 手上还有进行中的任务/);
  assert.ok(!r.last.skipped.some((x) => x.task === t3.id), '依赖没完成的不算就绪');
  // 这一轮还没结束时不能再跑
  assert.throws(() => w.scheduler.runOnce(P, '主持人'), (err) => err.status === 409 && /还没结束/.test(err.message));
  await w.runner.idle();
  assert.equal(e.board.get(P, t1.id).state, 'done');
  // 改动记录挂在正式编号上
  const log = createChangelog(e.workbench.get(P).dir).list();
  assert.deepEqual(log.map((x) => [x.task, x.id, x.version, x.type]), [[t1.id, 'C001', 1, 'evidence']]);
  // t2 密封交稿等揭晓、t5 回复不合格式回到 open：都不算进行中，收轮
  w.scheduler.step(P);
  const s = w.scheduler.state(P);
  assert.equal(s.round, null);
  assert.equal(s.rounds[0].n, 1);
  assert.equal(s.rounds[0].assessment.kind, 'no_improvement'); // 新增了 C001，但没有新增 supported、没有解除阻塞
  assert.deepEqual(s.rounds[0].assessment.content.changed, ['C001']);
});

test('冷却：API 被限流按 Retry-After、命令行额度用完按 cooldown.cliMinutes；冷却期间不派，过了再派；冷却记录跨项目、重启后仍在', async () => {
  const e = await env();
  await asHost(e, [source()]);
  const clock = { t: Date.parse('2026-10-19T03:00:00Z') };
  const limited = Object.assign(new Error('被限流（429），重试 3 次后放弃'), { kind: 'http', details: { rateLimited: true, retryAfterMs: 120_000 } });
  const quota = Object.assign(new Error("You've hit your usage limit. Try again later."), { kind: 'exit' });
  const w = world(e, { 'deepseek-pro': [{ throw: limited }, json([claim('$c1')])], claude: [{ throw: quota }] }, { clock });
  const t1 = task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  const t2 = task(e, { type: 'outline', assigned_to: 'claude' });
  w.scheduler.runOnce(P, '主持人');
  await w.runner.idle();
  w.scheduler.step(P);
  const cool = Object.fromEntries(w.scheduler.cooldowns().map((c) => [c.participant, c]));
  assert.equal(cool['deepseek-pro'].until, new Date(clock.t + 120_000).toISOString());
  assert.equal(cool.claude.until, new Date(clock.t + 60 * 60_000).toISOString());
  assert.equal(e.board.get(P, t1.id).state, 'open'); // 这次尝试失败，回到 open
  // 冷却期间不派
  let r = w.scheduler.runOnce(P, '主持人');
  assert.equal(r.round, null);
  assert.match(r.last.skipped.find((x) => x.task === t1.id).reason, /deepseek-pro 冷却到/);
  assert.match(r.last.skipped.find((x) => x.task === t2.id).reason, /claude 冷却到/);
  // 冷却记录落盘：新的调度实例（模拟重启）照样认
  const w3 = world(e, { 'deepseek-pro': [json([claim('$c1')])] }, { clock });
  const fresh = createScheduler({ workbench: e.workbench, gateway: e.gw, board: e.board, runner: w3.runner, participants: w3.lookup, cooldownFile: w.cooldownFile, now: () => new Date(clock.t) });
  assert.deepEqual(fresh.cooldowns().map((c) => c.participant).sort(), ['claude', 'deepseek-pro']);
  // 过了 Retry-After：DeepSeek 可以派了，Claude 还在冷却
  clock.t += 121_000;
  r = fresh.runOnce(P, '主持人');
  assert.deepEqual(r.round.tasks, [t1.id]);
  await w3.runner.idle();
  assert.equal(e.board.get(P, t1.id).state, 'done');
});

test('上限：派发时超出调用次数上限，任务转“待你决定”，这一轮不再往下派；待你决定里有提示', async () => {
  const e = await env({ budget: { calls: 1 } });
  const w = world(e, { claude: ['## 一\n甲。'], codex: ['## 一\n乙。'] });
  const a = task(e, { type: 'outline', assigned_to: 'claude' });
  const b = task(e, { type: 'outline', assigned_to: 'codex' });
  const r = w.scheduler.runOnce(P, '主持人');
  assert.deepEqual(r.round.tasks, [a.id]);
  assert.equal(e.board.get(P, b.id).state, 'needs_user');
  assert.equal(r.last.budget_hit, true);
  assert.deepEqual(w.scheduler.inbox(P).map((i) => i.type), ['scheduler_budget']);
  await w.runner.idle();
});

test('自动调度打开后由事件推进：任务结束就收轮并开下一轮，直到没有已就绪的任务', async () => {
  const e = await env({ plateau: { rounds: 5 } });
  await asHost(e, [source()]);
  const w = world(e, { 'deepseek-pro': [json([claim('$c1')]), json([claim('$c2', '当地人口为 1200 人')])] });
  const t1 = task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  const t2 = task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  w.scheduler.setAuto(P, true, '主持人'); // 打开时立刻看一眼
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await until(() => e.board.get(P, t1.id).state === 'done');
  // 同一位参与者一次只做一件：t2 等下一轮。这里手动推一步（服务里由任务事件推）
  w.scheduler.step(P);
  await w.runner.idle();
  w.scheduler.step(P);
  const s = w.scheduler.state(P);
  assert.deepEqual(s.rounds.map((r) => r.tasks).reverse(), [[t1.id], [t2.id]]);
  assert.equal(e.board.get(P, t2.id).state, 'done');
  w.scheduler.setAuto(P, false, '主持人');
  assert.equal(w.scheduler.state(P).auto, false);
});

// ---------- 停滞 ----------

test('停滞：三种情况分别记录——没填改动记录（不算停滞）、内容没有变化、有变化但质量指标没有提升；另有没有任务完成、只有读者', () => {
  const base = { content: { S001: 'a', C001: 'b' }, supported: [], blocking: ['O001'], confusions: { task: 'T001', count: 4 } };
  const writer = { id: 'T010', type: 'extract_claims', state: 'done', result: { records: [{ id: 'C002', version: 1 }] } };
  const changedAfter = { ...base, content: { ...base.content, C002: 'c' } };
  // 有变化、没提升、没填改动记录
  let a = assessRound({ before: base, after: changedAfter, tasks: [writer], changelog: [] });
  assert.deepEqual([a.kind, a.stagnant, a.changelog.not_filled, a.changelog.missing], ['no_improvement', true, true, ['T010']]);
  // 填了改动记录、有提升（新增 supported）
  a = assessRound({ before: base, after: { ...changedAfter, supported: ['C002@1'] }, tasks: [writer], changelog: [{ task: 'T010', type: 'evidence' }] });
  assert.deepEqual([a.kind, a.stagnant, a.changelog.not_filled, a.self_reported.evidence], ['progress', false, false, 1]);
  // 解除阻塞也算提升
  assert.equal(assessRound({ before: base, after: { ...changedAfter, blocking: [] }, tasks: [writer], changelog: [] }).kind, 'progress');
  // 新读者标出的不懂处变少也算
  assert.equal(assessRound({ before: base, after: { ...changedAfter, confusions: { task: 'T011', count: 2 } }, tasks: [writer], changelog: [] }).kind, 'progress');
  assert.equal(assessRound({ before: base, after: { ...changedAfter, confusions: { task: 'T011', count: 5 } }, tasks: [writer], changelog: [] }).kind, 'no_improvement');
  // 内容没有变化（版本变了但正文一样也算没变化，见集成测试）
  a = assessRound({ before: base, after: base, tasks: [writer], changelog: [{ task: 'T010', type: 'clarity' }] });
  assert.deepEqual([a.kind, a.stagnant], ['unchanged', true]);
  // 没有任务完成、只有读者：都不算停滞
  assert.equal(assessRound({ before: base, after: base, tasks: [{ ...writer, state: 'open' }], changelog: [] }).kind, 'no_result');
  assert.equal(assessRound({ before: base, after: base, tasks: [{ id: 'T012', type: 'audience_reader', state: 'done', result: {} }], changelog: [] }).kind, 'reading');
});

test('停滞的处理：改写只换了版本、正文没变 → “内容没有变化”；连续 plateau.rounds 轮停滞就派观众型新读者读当前作品；没有作品时交给你决定', async () => {
  const e = await env({ plateau: { rounds: 1, action: 'audience_reader' } });
  await asHost(e, [{ kind: 'outline', expected_version: 0, data: { title: '大纲', body: '## 一\n讲清楚问题。' } }]);
  const same = json({ changes: [{ id: 'OL001', expected_version: 1, data: { title: '大纲', body: '## 一\n讲清楚问题。' } }], changelog: [{ id: 'OL001', type: 'clarity', note: '自称更清楚了' }] });
  const w = world(e, { 'deepseek-pro': [same] });
  const t = task(e, { type: 'extract_claims', inputs: [{ id: 'OL001', version: 1 }] });
  w.scheduler.runOnce(P, '主持人');
  await w.runner.idle();
  assert.equal(e.gw.getRecord(P, 'OL001').record.version, 2);
  w.scheduler.step(P);
  const r = w.scheduler.state(P).rounds[0];
  assert.equal(r.assessment.kind, 'unchanged');
  assert.equal(r.assessment.self_reported.clarity, 1); // 自报“提高可理解性”只作辅助，不影响结论
  assert.equal(r.action.type, 'audience_reader');
  const reader = e.board.get(P, r.action.task);
  assert.deepEqual([reader.type, reader.inputs, reader.created_by.participant], ['audience_reader', [{ id: 'OL001', version: 2 }], 'workbench-scheduler']);
  // 没有作品的项目：交给你决定
  const e2 = await env({ plateau: { rounds: 1, action: 'audience_reader' } });
  await asHost(e2, [source()]);
  const w2 = world(e2, { 'deepseek-pro': [json([claim('$c1')])] });
  task(e2, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  w2.scheduler.runOnce(P, '主持人');
  await w2.runner.idle();
  w2.scheduler.step(P);
  assert.equal(w2.scheduler.state(P).rounds[0].action.type, 'needs_user');
  assert.deepEqual(w2.scheduler.inbox(P).map((i) => i.type), ['stagnation']);
});

test('改动记录：对象格式与旧的数组格式都接受；临时编号换成正式编号；没写的记录、错误的类型记为无效', () => {
  assert.deepEqual(parseResult(json([{ kind: 'claim' }])).changelog, { entries: [], invalid: [] });
  const r = parseResult(json({ changes: [{ kind: 'claim', tmp: '$c1' }, { id: 'SL001', expected_version: 2 }], changelog: [{ id: '$c1', type: 'evidence' }, { id: 'SL001', type: 'clarity', note: '分段' }, { id: 'C099', type: 'fix' }, { id: 'SL001', type: 'better' }] }));
  assert.equal(r.changes.length, 2);
  assert.deepEqual(r.changelog.invalid.map((x) => x.reason), ['type 只能是 evidence / fix / clarity']);
  const { resolved, dropped } = resolveChangelog(r.changelog.entries, r.changes, [{ id: 'C007', version: 1 }, { id: 'SL001', version: 3 }]);
  assert.deepEqual(resolved.map((x) => [x.id, x.version, x.type]), [['C007', 1, 'evidence'], ['SL001', 3, 'clarity']]);
  assert.deepEqual(dropped.map((x) => x.id), ['C099']);
  assert.equal(normalizeChangelog('乱写').invalid.length, 1);
  assert.equal(audienceConfusions(json({ restatement: ['a'], confusions: [{ where: '第 1 页', issue: '跳跃' }, { where: '第 2 页', issue: '术语' }] })), 2);
  assert.equal(audienceConfusions('复述：……\n看不懂的地方：\n- 第 1 页跳跃\n- 第 3 页术语\n'), 2);
});

// ---------- 阶段 ----------

test('阶段切换：生成一页以内、不带内容生产者身份的交接单；旧阶段的工作记忆先归档再清空，新阶段换空间；别的项目和全局记忆不动', async () => {
  const e = await env();
  await asHost(e, [source(), claim('$c1')]);
  await asHost(e, [{ kind: 'outline', expected_version: 0, data: { title: '大纲', body: '## 一', claims: [{ id: 'C001', version: 1 }] } }]);
  const store = createStore(path.join(tmpBase(), 'forum.json'));
  const w = world(e, {}, { store });
  assert.throws(() => w.scheduler.switchPhase(P, 'nope', '主持人'), (err) => err.status === 400);
  const first = w.scheduler.switchPhase(P, 'goal', '主持人');
  assert.equal(first.handoff.id, 'H001');
  assert.match(first.handoff.text, /阶段交接单：（开始） → 明确目标/);
  assert.throws(() => w.scheduler.switchPhase(P, 'goal', '主持人'), (err) => err.status === 409);
  const goal = phaseSpace(store, P, '明确目标');
  const other = phaseSpace(store, '别的项目', '明确目标');
  store.addMemory(`${goal.id}/claude`, { name: 'Claude', content: '目标阶段的笔记', source: 'test' });
  store.addMemory(`${other.id}/claude`, { name: 'Claude', content: '别的项目', source: 'test' });
  store.addMemory('shared/claude', { name: 'Claude', content: '全局', source: 'test' });
  const second = w.scheduler.switchPhase(P, 'sources', '主持人');
  const text = second.handoff.text;
  assert.ok(text.length <= 2500, '一页以内');
  assert.match(text, /阶段交接单：明确目标 → 收集来源/);
  assert.match(text, /论断 1 条/);
  assert.match(text, /大纲 OL001 第 1 版/);
  assert.deepEqual(findNames(text, anonymityTerms(PEOPLE)), [], '交接单里没有参与者、模型、厂商');
  assert.ok(!text.includes('主持人'), '也没有主持人的名字');
  // 记忆：旧阶段归档后清空；别的项目、全局不动；新阶段的空间建好了
  assert.equal(store.getMemory(`${goal.id}/claude`), null);
  assert.equal(store.getMemory(`${other.id}/claude`).content, '别的项目');
  assert.equal(store.getMemory('shared/claude').content, '全局');
  const s = w.scheduler.state(P);
  assert.equal(s.phase.id, 'sources');
  assert.equal(s.phase.space, phaseSpace(store, P, '收集来源').id);
  const archived = readJson(path.join(e.workbench.get(P).dir, s.phase_history[1].memory.file));
  assert.equal(archived.notebooks[`${goal.id}/claude`][0].content, '目标阶段的笔记');
  assert.equal(w.scheduler.handoff(P, 'H002'), text);
});

test('阶段切换：这一轮还没收轮时不能切；新阶段的读资料与起草任务包带交接单，观众型读者和匿名评审不带', async () => {
  const e = await env();
  await asHost(e, [source()]);
  await asHost(e, [{ kind: 'outline', expected_version: 0, data: { title: '大纲', body: '## 一\n内容' } }]);
  let release;
  const slow = new Promise((r) => (release = r));
  const w = world(e, {
    'deepseek-pro': [slow, json([claim('$c2', '当地人口为 1200 人')])],
    claude: ['## 一\n起草', '方案甲 第 1 节：太短。'],
    codex: [json({ restatement: ['讲问题'], confusions: [] })],
  });
  w.scheduler.switchPhase(P, 'goal', '主持人');
  task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  w.scheduler.runOnce(P, '主持人');
  assert.throws(() => w.scheduler.switchPhase(P, 'sources', '主持人'), (err) => err.status === 409 && /还没收轮/.test(err.message));
  release(json([claim('$c1')]));
  await w.runner.idle();
  w.scheduler.step(P);
  w.scheduler.switchPhase(P, 'sources', '主持人');
  w.prompts.length = 0;
  const blobs = blobStore(e.workbench.get(P).dir);
  const ex = task(e, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] });
  const dr = task(e, { type: 'outline', assigned_to: 'claude' });
  const au = task(e, { type: 'audience_reader', assigned_to: 'codex', inputs: [{ id: 'OL001', version: 1 }] });
  const rv = task(e, { type: 'anonymous_review', assigned_to: 'claude', inputs: [{ blob: blobs.put('## 一\n甲'), name: '方案甲' }, { blob: blobs.put('## 一\n乙'), name: '方案乙' }] });
  w.runner.dispatch(P, ex.id, 'deepseek-pro');
  w.runner.dispatch(P, dr.id, 'claude');
  w.runner.dispatch(P, au.id, 'codex');
  await w.runner.idle();
  w.runner.dispatch(P, rv.id, 'claude');
  await w.runner.idle();
  const sent = (pred) => w.prompts.find(pred).prompt;
  const extract = sent((x) => x.who === 'deepseek-pro');
  const draft = sent((x) => x.who === 'claude' && /竞争起草者|密封起草/.test(x.prompt));
  const audience = sent((x) => x.who === 'codex');
  const review = sent((x) => /匿名评审/.test(x.prompt));
  assert.match(extract, /【交接单-H002\.md】/);
  assert.match(extract, /阶段交接单：明确目标 → 收集来源/);
  assert.match(draft, /阶段交接单：明确目标 → 收集来源/);
  assert.doesNotMatch(audience, /交接单/);
  assert.doesNotMatch(review, /交接单/);
  // 任务包里存着这份交接单，可以还原
  assert.ok(restorePacket(e.workbench.get(P).dir, `${ex.id}-a1`).inputs.some((i) => i.role === 'handoff' && i.ref === 'H002'));
});

// ---------- 研讨截断 ----------

test('研讨截断：工坊项目里的研讨保留“项目约定＋交接单”代替开题帖，加上省略部分里的表决结果和最近发言；别的研讨照旧保留开题帖', () => {
  const posts = [
    { author: '主持人', kind: 'human', content: '开题：要不要换开场？' + '。'.repeat(50) },
    { author: '表决', kind: 'system', type: 'result', content: '表决通过：换成问题开场' },
    ...Array.from({ length: 6 }, (_, i) => ({ author: 'Claude', kind: 'ai', content: `第 ${i + 1} 条发言` + '长'.repeat(200) })),
    ...Array.from({ length: 3 }, (_, i) => ({ author: 'Codex', kind: 'ai', content: `最近 ${i + 1}` + '近'.repeat(100) })),
  ];
  const withPreface = formatTranscript(posts, 1200, null, '受众：新同事\n\n# 阶段交接单：大纲 → 讲稿');
  assert.match(withPreface, /^【背景：项目约定与阶段交接单】\n受众：新同事/);
  assert.doesNotMatch(withPreface, /开题：要不要换开场/);
  assert.match(withPreface, /【决议摘要：省略部分里的表决结果】[\s\S]*表决通过：换成问题开场/);
  assert.match(withPreface, /最近 3/);
  const plain = formatTranscript(posts, 1200);
  assert.match(plain, /开题：要不要换开场/);
  assert.doesNotMatch(plain, /背景：项目约定/);
  // 不需要截断时原样
  assert.doesNotMatch(formatTranscript(posts.slice(0, 2), 100_000, null, '约定'), /背景/);
});

test('交接单超过一页时截断；七步阶段的顺序', () => {
  assert.deepEqual(PHASES.map((p) => p.name), ['明确目标', '收集来源', '抽取论断', '大纲', '讲稿', '幻灯片', '审阅']);
  const records = Array.from({ length: 40 }, (_, i) => ({ kind: 'outline', record: { id: `OL${String(i + 1).padStart(3, '0')}`, version: 1, title: '很长的标题'.repeat(10) }, status: { ready: false, freshness: 'current', blockers: [] } }));
  const text = buildHandoff({ title: '项目', from: PHASES[2], to: PHASES[3], at: '2026-10-19T00:00:00Z', records });
  assert.ok(text.length <= 2500);
  assert.match(text, /另有 32 条/);
});

// ---------- 接口 ----------

test('接口：开关自动调度、跑一轮、切换阶段只限主持人；状态与交接单可以读', async () => {
  const e = await env();
  const store = createStore(path.join(tmpBase(), 'forum.json'));
  const w = world(e, {}, { store });
  const routes = workbenchRoutes({ workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, runner: w.runner, scheduler: w.scheduler, hostToken: 'tok', humanName: '主持人', readJson: async (req) => req.body });
  const call = (method, url, body, host = true) => {
    const route = routes.find(([m, re]) => m === method && re.test(url));
    return route[2]({ headers: host ? { 'x-workbench-host': 'tok' } : {}, body }, url.match(route[1]));
  };
  const base = `/api/projects/${encodeURIComponent(P)}`;
  for (const [url, body] of [[`${base}/scheduler/auto`, { on: true }], [`${base}/scheduler/run`, {}], [`${base}/phase`, { to: 'goal' }]]) {
    await assert.rejects(async () => call('POST', url, body, false), (err) => err.status === 403);
  }
  assert.equal((await call('POST', `${base}/scheduler/auto`, { on: true })).auto, true);
  assert.equal((await call('POST', `${base}/scheduler/run`, {})).round, null); // 没有已就绪的任务
  const ph = await call('POST', `${base}/phase`, { to: 'goal' });
  assert.equal((await call('GET', `${base}/handoffs/${ph.handoff.id}`)).text, ph.handoff.text);
  const s = await call('GET', `${base}/scheduler`);
  assert.deepEqual([s.auto, s.phase.id, s.phase.name], [true, 'goal', '明确目标']);
  await call('POST', `${base}/scheduler/auto`, { on: false });
});
