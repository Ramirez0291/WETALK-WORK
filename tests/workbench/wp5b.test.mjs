// WP5b：分工与竞争。竞争：密封起草 → 揭晓 → 匿名评审（意见必须指向具体位置，指不到的退回）→ 选定 →
// 移植补丁逐条接受或拒绝 → 书记只应用通过的补丁；分工：拆成互不重叠的几份，提交入口拒绝越界写入。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore, anonymityTerms, findNames } from '../../lib/workbench/visibility.mjs';
import { createCompetitions } from '../../lib/workbench/compete.mjs';
import { createDivisions, partition } from '../../lib/workbench/divide.mjs';
import { sectionsOf, parseReview, applyPatches, checkPatch, patchConflict, numberSections, claimRefsIn } from '../../lib/workbench/modes.mjs';
import { authorsOf } from '../../lib/workbench/verify.mjs';
import { workbenchRoutes } from '../../lib/workbench/http.mjs';
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase } from './helpers.mjs';

after(cleanup);
const P = '样本';
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';

const PEOPLE = [
  { id: 'claude', name: 'Claude', adapter: 'claude', resolved: 'claude' },
  { id: 'codex', name: 'Codex', adapter: 'codex', resolved: 'codex' },
  { id: 'deepseek-pro', name: 'DeepSeek Pro', adapter: 'deepseek', model: 'deepseek-pro', resolved: 'api' },
  { id: 'gemini', name: 'Gemini', adapter: 'agy', model: 'gemini-3.8-flash-high', resolved: 'agy' },
  { id: 'offline', name: 'Offline', adapter: 'claude', resolved: null },
];

async function env() {
  const e = await setup();
  const usage = createUsage({ workbench: e.workbench, pricing: DEFAULTS.pricing });
  const board = createTaskBoard({ workbench: e.workbench, usage });
  const { gw } = await restart(e, { fence: board.fence });
  return { ...e, gw, usage, board };
}

// 一套假的参与者：script[参与者] 是回复数组或 (prompt) => 回复；回复可以是文字或 { raw, audit }，也可以是 Promise
function world(e, script = {}, { board = e.board, sealed = createSealedStore() } = {}) {
  const lookup = Object.assign((id) => PEOPLE.find((p) => p.id === id) ?? null, { all: () => PEOPLE });
  const prompts = [];
  const base = tmpBase();
  const runner = createRunner({
    workbench: e.workbench, gateway: e.gw, board, usage: e.usage, sealed, participants: lookup,
    runAgent: async (p, prompt) => {
      prompts.push({ who: p.id, prompt });
      const s = script[p.id];
      const r = await (typeof s === 'function' ? s(prompt) : Array.isArray(s) ? s.shift() : s);
      if (r == null) throw new Error(`${p.id} 没有准备回复`);
      return { raw: typeof r === 'object' ? r.raw : r, audit: typeof r === 'object' ? r.audit ?? null : null, model: null, exec: { args: [] }, usage: null };
    },
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
  });
  const events = [];
  const competitions = createCompetitions({ workbench: e.workbench, gateway: e.gw, board, runner, participants: lookup, onEvent: (ev) => events.push(ev) });
  const divisions = createDivisions({ workbench: e.workbench, gateway: e.gw, board, runner, participants: lookup });
  return { runner, competitions, divisions, prompts, sealed, events };
}

async function asHost(e, changes) {
  const r = e.gw.receive(P, { request_id: rid(), changes }, { actor: HUMAN });
  return e.gw.promote(P, r.sid);
}
// 以某个 Agent 的身份写入（经任务栅栏）
async function asAgent(e, holder, changes) {
  const t = e.board.create(P, { type: 'extract_claims' }, { created_by: HUMAN });
  const c = e.board.claim(P, t.id, holder);
  const r = e.gw.receive(P, { request_id: rid(), task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes });
  return e.gw.promote(P, r.sid);
}
const rec = (e, id) => e.gw.getRecord(P, id).record;
const json = (v) => '```json\n' + JSON.stringify(v) + '\n```';

const DRAFT_A = '# 大纲（MARK-A）\n\n## 问题\n为什么要做这件事。C001 说明了现状。\n\n## 做法\n分三步推进。\n\n## 边界\n不做的事。\n';
const DRAFT_B = '# 大纲（MARK-B）\n\n## 开场问题\n你有没有想过：A 真的导致 B 吗？\n\n## 方法\n先分工，再竞争。\n\n## 结语\n收尾一句话。\n';
// 提示词里某段正文属于哪个标签：它前面最近的【方案x】
const labelOf = (prompt, marker) => [...prompt.slice(0, prompt.indexOf(marker)).matchAll(/【(方案.)】/g)].at(-1)[1];

async function sample(e) {
  await asHost(e, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await asAgent(e, { kind: 'server', participant: 'deepseek', adapter: 'deepseek', model: 'deepseek-flash', verified: true, basis: 'server-invoked' },
    [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
}

const REVIEW = (prompt) => {
  const a = labelOf(prompt, 'MARK-A');
  const b = labelOf(prompt, 'MARK-B');
  return [
    '评审意见如下：',
    `- ${a} 第 2 节：分三步写得太简略，缺少每一步的产出。`,
    `- ${b} 第 1 节：开场问题很抓人，值得保留。`,
    `- ${b} 第 9 节：这一节有问题。`,
    '- 总体来说两份都不错。',
    `- ${a} C001：引用的现状需要核对版本。`,
    `- ${b} C001：这里引错了。`,
  ].join('\n');
};

// ---------- 竞争 ----------

test('竞争全流程：密封起草 → 揭晓 → 匿名评审（指不到位置的意见被退回）→ 选定 → 移植补丁逐条接受或拒绝 → 书记只应用通过的补丁', async () => {
  const e = await env();
  await sample(e);
  const w = world(e, { claude: [DRAFT_A], codex: [DRAFT_B], 'deepseek-pro': REVIEW });
  const c = w.competitions;

  // 发起：两份方案进同一个密封轮次
  const k = c.create(P, { type: 'outline', title: '这套方案怎么讲', goal: '给第一次接触的同事讲清楚', inputs: [{ id: 'C001', version: 1 }], participants: ['claude', 'codex'] }, HUMAN);
  assert.equal(k.id, 'K001');
  assert.deepEqual(k.dispatched.map((d) => d.dispatched), [true, true]);
  await w.runner.idle();
  assert.deepEqual(w.sealed.status(P, 'K001-drafts').tasks.sort(), ['T002', 'T003']);
  // 揭晓前：竞争的视图、事件、待你决定里都没有方案正文
  let v = c.view(P, 'K001');
  assert.equal(v.stage, 'drafting');
  assert.doesNotMatch(JSON.stringify(v) + JSON.stringify(w.events) + JSON.stringify(c.inbox(P)), /MARK-A|MARK-B/);
  assert.deepEqual(c.inbox(P).map((i) => i.action), ['reveal']);
  // 起草提示词：竞争起草的输出要求，输入里有论断
  const draftPrompt = w.prompts.find((p) => p.who === 'claude').prompt;
  assert.match(draftPrompt, /竞争起草者/);
  assert.match(draftPrompt, /A 导致 B/);

  c.reveal(P, 'K001');
  v = c.view(P, 'K001');
  assert.equal(v.stage, 'review_ready');

  // 评审者不能是起草者（会认出自己的方案）
  await assert.rejects(c.review(P, 'K001', { reviewers: ['claude'] }, HUMAN), (err) => err.status === 409 && /起草者/.test(err.message));
  await c.review(P, 'K001', { reviewers: ['deepseek-pro'] }, HUMAN);
  await w.runner.idle();
  v = c.view(P, 'K001');
  assert.equal(v.stage, 'reviewing');
  // 评审结束前：标签与起草者的对应关系不出现在竞争的接口里
  assert.equal(v.mapping_public, false);
  assert.ok(v.label_drafts.every((l) => l.task === undefined && l.participant === undefined));
  assert.equal(v.labels, undefined);

  // 评审实际收到的提示词：只有标签和去掉署名的正文，每节标着节号
  const reviewPrompt = w.prompts.find((p) => p.who === 'deepseek-pro').prompt;
  assert.deepEqual(findNames(reviewPrompt, anonymityTerms(PEOPLE)), []);
  assert.match(reviewPrompt, /## 做法 〔第 2 节〕/);
  assert.match(reviewPrompt, /没有指向具体位置的意见会被退回/);

  c.reveal(P, 'K001');
  v = c.view(P, 'K001');
  assert.equal(v.stage, 'selecting');
  assert.equal(v.mapping_public, true);
  const A = v.label_drafts.find((l) => l.participant === 'claude').label;
  const B = v.label_drafts.find((l) => l.participant === 'codex').label;
  // 意见：指向具体节或论断的留下；指不到位置的退回，原文与原因都留着
  const r1 = v.reviews[0];
  assert.deepEqual(r1.comments.map((x) => x.where), [`${A} 第 2 节`, `${B} 第 1 节`, `${A} C001`]);
  assert.deepEqual(r1.returned.map((x) => x.reason), [`${B}没有第 9 节（共 3 节）`, '没有指向具体位置（方案和节、页或论断编号）', `${B}里没有提到 C001`]);
  assert.match(r1.returned[1].text, /总体来说两份都不错/);

  // 选定：要写理由；选定的方案写成正式大纲，内容来源是起草者，不是选定它的主持人
  await assert.rejects(c.select(P, 'K001', { label: A }, HUMAN), (err) => err.status === 400);
  v = await c.select(P, 'K001', { label: A, reason: '结构更完整' }, HUMAN);
  assert.equal(v.stage, 'patching');
  const ol1 = rec(e, 'OL001');
  assert.equal(ol1.body, DRAFT_A);
  assert.deepEqual(ol1.claims, [{ id: 'C001', version: 1 }]);
  assert.deepEqual([ol1.provenance.participant, ol1.provenance.vendor, ol1.provenance.basis, ol1.provenance.selected_by, ol1.provenance.competition], ['claude', 'anthropic', 'compete-selected', '主持人', 'K001']);
  assert.deepEqual(authorsOf(ol1).map((a) => a.participant), ['claude']);

  // 移植补丁：只能从落选方案搬运原文
  await assert.rejects(c.propose(P, 'K001', { from: { draft: A, section: 1 }, to: { section: 1, position: 'after' } }, HUMAN), /不是落选方案/);
  await assert.rejects(c.propose(P, 'K001', { from: { draft: B, section: 1, quote: 'B 方案里没有的话' }, to: { section: 1, position: 'start' } }, HUMAN), /找不到这段原文/);
  await assert.rejects(c.propose(P, 'K001', { from: { draft: B, section: 1 }, to: { section: 7, position: 'after' } }, HUMAN), /底稿没有第 7 节/);
  await c.propose(P, 'K001', { from: { draft: B, section: 1, quote: '你有没有想过：A 真的导致 B 吗？' }, to: { section: 1, position: 'start' }, note: '把乙第 1 节的开场问题移到甲第 1 节开头', comment: '1.2' }, HUMAN);
  await c.propose(P, 'K001', { from: { draft: B, section: 2 }, to: { section: 2, position: 'after' } }, HUMAN);
  await c.propose(P, 'K001', { from: { draft: B, section: 3 }, to: { section: 3, position: 'replace' } }, HUMAN);
  await c.propose(P, 'K001', { from: { draft: B, section: 2 }, to: { section: 1, position: 'replace' } }, HUMAN);
  assert.deepEqual(c.inbox(P).map((i) => i.action), ['decide']);

  // 逐条接受或拒绝：拒绝必须写理由；冲突的不能接受；决定后不再改
  await c.decide(P, 'K001', 'P1', { decision: 'accept' }, HUMAN);
  await c.decide(P, 'K001', 'P2', { decision: 'accept', reason: '方法一节补上了做法缺的细节' }, HUMAN);
  await assert.rejects(c.decide(P, 'K001', 'P3', { decision: 'reject' }, HUMAN), (err) => err.status === 400);
  await c.decide(P, 'K001', 'P3', { decision: 'reject', reason: '结语太单薄，保留甲的边界' }, HUMAN);
  await assert.rejects(c.decide(P, 'K001', 'P4', { decision: 'accept' }, HUMAN), (err) => err.status === 409 && /与已接受的补丁 P1 冲突/.test(err.message));
  await c.decide(P, 'K001', 'P4', { decision: 'reject', reason: '与 P1 冲突' }, HUMAN);
  await assert.rejects(c.decide(P, 'K001', 'P1', { decision: 'reject', reason: '反悔' }, HUMAN), (err) => err.status === 409);
  assert.deepEqual(c.inbox(P).map((i) => i.action), ['apply']);

  // 书记：只应用 P1、P2
  v = await c.apply(P, 'K001', HUMAN);
  const ol2 = rec(e, 'OL001');
  assert.equal(ol2.version, 2);
  assert.ok(ol2.body.includes('你有没有想过：A 真的导致 B 吗？'));
  assert.ok(ol2.body.includes('## 方法\n先分工，再竞争。'));
  assert.ok(!ol2.body.includes('结语') && !ol2.body.includes('收尾一句话'), '被拒的补丁没有进入正式大纲');
  // 底稿一个字不改：去掉补丁搬来的原文（和分隔的空行），剩下的就是底稿
  const strip = (s) => s.replace('你有没有想过：A 真的导致 B 吗？', '').replace('## 方法\n先分工，再竞争。', '').replace(/\n{2,}/g, '\n');
  assert.equal(strip(ol2.body), DRAFT_A.replace(/\n{2,}/g, '\n'));
  assert.deepEqual([ol2.provenance.participant, ol2.provenance.kind, ol2.provenance.patches], ['workbench-scribe', 'system', ['P1', 'P2']]);
  assert.deepEqual(authorsOf(ol2).map((a) => `${a.participant}/${a.vendor}`), ['claude/anthropic', 'codex/openai']); // 搬来的原文保留原作者
  assert.deepEqual(ol2.authors.map((a) => a.participant), ['claude', 'codex']); // 书记是规则，不写进作者集合
  assert.deepEqual(v.patches.map((p) => [p.id, p.state, p.applied?.version ?? null]), [['P1', 'accepted', 2], ['P2', 'accepted', 2], ['P3', 'rejected', null], ['P4', 'rejected', null]]);
  assert.deepEqual(v.patches.map((p) => p.decision.by), ['主持人', '主持人', '主持人', '主持人']);
  // 少数意见记录：被拒的补丁连同理由；没被采纳的评审意见（P1 采纳了 1.2）
  assert.deepEqual(v.minority.rejected_patches.map((p) => [p.id, p.reason]), [['P3', '结语太单薄，保留甲的边界'], ['P4', '与 P1 冲突']]);
  assert.deepEqual(v.minority.unadopted_comments.map((x) => x.id), ['1.1', '1.3']);
  assert.deepEqual(v.minority.losing_drafts.map((x) => x.label), [B]);

  // 作品在竞争之外被改过：书记不覆盖，返回冲突；竞争照样可以结束，没应用的补丁记下来
  await asHost(e, [{ id: 'OL001', expected_version: 2, data: { title: '这套方案怎么讲', body: '主持人重写的版本', claims: [] } }]);
  await c.propose(P, 'K001', { from: { draft: B, section: 3 }, to: { section: 3, position: 'after' } }, HUMAN);
  await c.decide(P, 'K001', 'P5', { decision: 'accept' }, HUMAN);
  await assert.rejects(c.apply(P, 'K001', HUMAN), (err) => err.status === 409 && /书记不覆盖/.test(err.message));
  assert.equal(rec(e, 'OL001').body, '主持人重写的版本');
  v = await c.close(P, 'K001', HUMAN);
  assert.equal(v.stage, 'closed');
  assert.deepEqual(v.minority.skipped_patches.map((p) => p.id), ['P5']);
  assert.deepEqual(v.history.map((h) => h.action), ['create', 'review', 'select', 'patch_proposed', 'patch_proposed', 'patch_proposed', 'patch_proposed', 'patch_accepted', 'patch_accepted', 'patch_rejected', 'patch_rejected', 'apply', 'patch_proposed', 'patch_accepted', 'close']);
});

test('竞争：两位评审看到的标签一致；独立性未证明的评审整份退回；评审全部失败时可以再发起一轮', async () => {
  const e = await env();
  await sample(e);
  const w = world(e, {
    claude: [DRAFT_A], codex: [DRAFT_B],
    'deepseek-pro': REVIEW,
    gemini: ['方案甲 第 1 节：第一轮，被取消。', { raw: '方案甲 第 1 节：读过别的文件。', audit: { independence: 'unproven', toolEvents: [{ type: 'command_execution' }] } }],
  });
  const c = w.competitions;
  c.create(P, { type: 'outline', title: '题目', participants: ['claude', 'codex'] }, HUMAN);
  await w.runner.idle();
  c.reveal(P, 'K001');
  // 第一轮评审被取消：没有一份评审完成，可以再发起一轮
  await c.review(P, 'K001', { reviewers: ['gemini'] }, HUMAN);
  await w.runner.idle();
  assert.equal(c.view(P, 'K001').stage, 'reviewing');
  e.board.cancel(P, c.view(P, 'K001').reviews[0].tasks[0].task, '主持人');
  assert.equal(c.view(P, 'K001').stage, 'review_ready');
  w.prompts.length = 0;
  await c.review(P, 'K001', { reviewers: ['deepseek-pro', 'gemini'] }, HUMAN);
  await w.runner.idle();
  const [p1, p2] = ['deepseek-pro', 'gemini'].map((who) => w.prompts.find((p) => p.who === who).prompt);
  assert.equal(labelOf(p1, 'MARK-A'), labelOf(p2, 'MARK-A'));
  assert.equal(labelOf(p1, 'MARK-B'), labelOf(p2, 'MARK-B'));
  c.reveal(P, 'K001');
  const v = c.view(P, 'K001');
  assert.deepEqual([v.reviews[0].comments, v.reviews[0].returned], [[], []]);
  assert.equal(v.reviews[1].comments.length, 3);
  assert.ok(v.reviews[1].returned.some((x) => /独立性未证明/.test(x.reason)));
  assert.ok(v.reviews[1].comments.every((x) => x.id.startsWith('2.')));
});

test('竞争：独立性未证明的方案不参与比较；有效方案不足两份时只能取消', async () => {
  const e = await env();
  const w = world(e, { claude: [DRAFT_A], codex: [{ raw: DRAFT_B, audit: { independence: 'unproven', toolEvents: [{ type: 'command_execution' }] } }] });
  const c = w.competitions;
  c.create(P, { type: 'outline', title: '题目', participants: ['claude', 'codex'] }, HUMAN);
  await w.runner.idle();
  c.reveal(P, 'K001');
  assert.equal(c.view(P, 'K001').stage, 'insufficient');
  await assert.rejects(c.review(P, 'K001', { reviewers: ['deepseek-pro'] }, HUMAN), (err) => err.status === 409);
  assert.deepEqual(c.inbox(P).map((i) => i.action), ['cancel']);
  const v = await c.cancel(P, 'K001', HUMAN, '重来');
  assert.equal(v.stage, 'cancelled');
});

test('竞争：方案全部交稿前不能揭晓；服务重启后密封结果消失，重新派发时两份方案回到同一个轮次', async () => {
  const e = await env();
  let release;
  const slow = new Promise((r) => (release = r));
  const w = world(e, { claude: [DRAFT_A, DRAFT_A], codex: [slow, DRAFT_B] });
  const c = w.competitions;
  c.create(P, { type: 'outline', title: '题目', participants: ['claude', 'codex'] }, HUMAN);
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25)); };
  await until(() => e.board.get(P, 'T001').state === 'submitted');
  assert.equal(e.board.get(P, 'T002').state, 'claimed');
  assert.throws(() => c.reveal(P, 'K001'), (err) => err.status === 409 && /还不能揭晓/.test(err.message));
  release(DRAFT_B);
  await w.runner.idle();
  // 模拟重启：新的任务看板与密封存储，内存里的稿子没了
  const board2 = createTaskBoard({ workbench: e.workbench, usage: e.usage });
  assert.deepEqual(board2.recover(P).sort(), ['T001', 'T002']);
  const w2 = world(e, { claude: [DRAFT_A], codex: [DRAFT_B] }, { board: board2 });
  assert.deepEqual(w2.competitions.inbox(P).map((i) => i.action), ['dispatch']);
  await w2.competitions.redispatch(P, 'K001');
  assert.deepEqual(w2.sealed.status(P, 'K001-drafts').tasks.sort(), ['T001', 'T002']);
  await w2.runner.idle();
  w2.competitions.reveal(P, 'K001');
  assert.equal(w2.competitions.view(P, 'K001').stage, 'review_ready');
});

test('竞争：同一个竞争的改动逐个执行：选定等待晋升期间发起的评审，排在选定之后（这时已不能再评审），不会互相覆盖', async () => {
  const e = await env();
  const w = world(e, { claude: [DRAFT_A], codex: [DRAFT_B], 'deepseek-pro': REVIEW, gemini: REVIEW });
  const c = w.competitions;
  c.create(P, { type: 'outline', title: '题目', participants: ['claude', 'codex'] }, HUMAN);
  await w.runner.idle();
  c.reveal(P, 'K001');
  await c.review(P, 'K001', { reviewers: ['deepseek-pro'] }, HUMAN);
  await w.runner.idle();
  c.reveal(P, 'K001');
  const label = c.view(P, 'K001').label_drafts[0].label;
  const selecting = c.select(P, 'K001', { label, reason: '好' }, HUMAN);
  const reviewing = c.review(P, 'K001', { reviewers: ['gemini'] }, HUMAN);
  await selecting;
  await assert.rejects(reviewing, (err) => err.status === 409 && /移植补丁/.test(err.message));
  const v = c.view(P, 'K001');
  assert.deepEqual([v.stage, v.reviews.length, v.selection.label], ['patching', 1, label]);
});

test('竞争：发起时的检查', async () => {
  const e = await env();
  await sample(e);
  const { competitions: c } = world(e);
  const bad = (spec, re) => assert.throws(() => c.create(P, { type: 'outline', title: '题目', participants: ['claude', 'codex'], ...spec }, HUMAN), re);
  bad({ type: 'extract_claims' }, /不是竞争方式的任务类型/);
  bad({ participants: ['claude'] }, /要指定 2 位不同的起草者/);
  bad({ participants: ['claude', 'claude'] }, /不能重复/);
  bad({ participants: ['claude', 'nobody'] }, /不存在/);
  bad({ participants: ['claude', 'offline'] }, /不可用/);
  bad({ inputs: [{ id: 'C001', version: 2 }] }, /当前是第 1 版/);
  assert.equal(c.list(P).length, 0);
  // 内部字段不能从任务接口传入
  const t = e.board.create(P, { type: 'outline', competition: 'K009', sealed_group: 'X', division: { id: 'DV9' } }, { created_by: HUMAN });
  assert.deepEqual([t.competition, t.sealed_group, t.division], [undefined, undefined, undefined]);
});

// ---------- 纯函数：分节、评审意见、补丁 ----------

test('分节：总标题下的二级标题是节；前言加各节首尾相接就是原文；代码块里的 # 不算标题；节号标注', () => {
  const s = sectionsOf(DRAFT_A);
  assert.deepEqual(s.sections.map((x) => x.title), ['问题', '做法', '边界']);
  assert.equal(s.preamble + s.sections.map((x) => x.text).join(''), DRAFT_A);
  assert.deepEqual(sectionsOf('# 甲\n正文\n# 乙\n```\n# 不是标题\n```\n').sections.map((x) => x.title), ['甲', '乙']);
  assert.deepEqual(sectionsOf('没有标题的方案').sections.map((x) => x.n), [1]);
  assert.match(numberSections(DRAFT_A), /## 边界 〔第 3 节〕\n/);
  assert.deepEqual(claimRefsIn('见 C001、C002 与 XC003', [{ id: 'C001', version: 3 }, { id: 'C003', version: 1 }]), [{ id: 'C001', version: 3 }]);
});

test('评审意见：json 与逐行两种格式；没有指向具体位置、位置不存在、只有位置没有意见的都退回', () => {
  const drafts = { 方案甲: DRAFT_A, 方案乙: DRAFT_B };
  const claimExists = (id) => id === 'C001';
  const j = parseReview(json([
    { draft: '方案甲', section: 3, comment: '边界太窄' },
    { draft: '方案乙', page: 2, comment: '方法好' },
    { draft: '方案丙', section: 1, comment: '没有这个方案' },
    { comment: '整体可以' },
    { draft: '方案甲', location: '第 1 节', comment: '用 location 写位置' },
    { draft: '方案甲', claim: 'C001', comment: '核对' },
    { draft: '方案甲', section: 1, comment: '。' },
  ]), { drafts, claimExists });
  assert.deepEqual(j.comments.map((c) => c.where), ['方案甲 第 3 节', '方案乙 第 2 页', '方案甲 第 1 节', '方案甲 C001']);
  assert.deepEqual(j.returned.map((r) => r.reason), ['没有方案丙', '没有指向具体位置（方案和节、页或论断编号）', '只有位置，没有写问题和理由']);
  const l = parseReview('## 评审\n1. 方案甲第2节：太简略\n* 方案乙 § 3 收尾太快\n方案乙觉得还行\n', { drafts, claimExists });
  assert.deepEqual(l.comments.map((c) => [c.where, c.comment]), [['方案甲 第 2 节', '太简略'], ['方案乙 第 3 节', '收尾太快']]);
  assert.deepEqual(l.returned.map((r) => r.reason), ['没有指向具体位置（节、页或论断编号）']);
  assert.match(parseReview('```json\n{坏的\n```\n方案甲 第 1 节：好', { drafts }).returned[0].reason, /json 代码块解析失败/);
});

test('书记：节前、节后、节首、节尾、整节替换；节号按底稿原来的分节；冲突的补丁；底稿其余字符原样保留', () => {
  const src = { 方案乙: DRAFT_B };
  const ps = [
    { id: 'P1', from: { draft: '方案乙', section: 1 }, to: { section: 1, position: 'before' } },
    { id: 'P2', from: { draft: '方案乙', section: 2, quote: '先分工' }, to: { section: 2, position: 'end' } },
    { id: 'P3', from: { draft: '方案乙', section: 3 }, to: { section: 3, position: 'replace' } },
    { id: 'P4', from: { draft: '方案乙', section: 2 }, to: { section: 3, position: 'after' } },
  ];
  for (const p of ps) assert.equal(checkPatch(p, { base: DRAFT_A, sources: src }), null);
  const out = applyPatches(DRAFT_A, ps, (l) => src[l]);
  const titles = sectionsOf(out).sections.map((x) => x.title);
  assert.deepEqual(titles, ['开场问题', '问题', '做法', '结语', '方法']);
  assert.ok(out.includes('分三步推进。\n\n先分工'));
  assert.ok(!out.includes('不做的事'), '整节替换掉了底稿第 3 节');
  assert.equal(patchConflict({ id: 'P5', to: { section: 3, position: 'start' } }, ps), '与已接受的补丁 P3 冲突：底稿第 3 节被整节替换后，不能再有别的替换或节内插入');
  assert.equal(patchConflict({ id: 'P5', to: { section: 3, position: 'before' } }, ps), null);
  assert.match(checkPatch({ from: { draft: '方案乙', section: 1 }, to: { section: 1, position: 'sideways' } }, { base: DRAFT_A, sources: src }), /position 只能是/);
  // 没有补丁：原文原样
  assert.equal(applyPatches(DRAFT_A, [], () => null), DRAFT_A);
});

// ---------- 分工 ----------

test('分工：拆成互不重叠的几份，每份派给一个参与者；子任务只能写自己那一份，越界的写入被提交入口拒绝', async () => {
  const e = await env();
  for (const [i, t] of ['甲书说：A 导致 B。', '乙书说：C 导致 D。', '丙书说：E 导致 F。'].entries()) {
    await asHost(e, [{ kind: 'source', expected_version: 0, data: { title: `书${i + 1}`, url: `https://example.org/${i + 1}`, text: t } }]);
  }
  const claim = (src, quote) => ({ kind: 'claim', expected_version: 0, data: { type: 'fact', text: quote, sources: [{ id: src, version: 1, quote }] } });
  const w = world(e, {
    'deepseek-pro': [json([claim('S001', 'A 导致 B'), claim('S003', 'E 导致 F')])],
    claude: [json([claim('S001', 'A 导致 B')])], // 越界：S001 分给了别人
  });
  const d = w.divisions;
  const bad = (spec, re) => assert.throws(() => d.create(P, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }, { id: 'S002', version: 1 }, { id: 'S003', version: 1 }], participants: ['deepseek-pro', 'claude'], ...spec }, HUMAN), re);
  bad({ type: 'outline' }, /不是分工方式的任务类型/);
  bad({ inputs: [{ id: 'S001', version: 1 }, { id: 'S001', version: 1 }] }, /出现了两次/);
  bad({ participants: ['claude', 'claude'] }, /只能分到一份/);
  bad({ assignments: [{ participant: 'claude', inputs: [{ id: 'S001', version: 1 }, { id: 'S002', version: 1 }] }, { participant: 'codex', inputs: [{ id: 'S002', version: 1 }, { id: 'S003', version: 1 }] }] }, /S002 分到了 2 份/);
  bad({ assignments: [{ participant: 'claude', inputs: [{ id: 'S001', version: 1 }] }, { participant: 'codex', inputs: [{ id: 'S002', version: 1 }] }] }, /S003 没有分到任何一份/);
  bad({ participants: ['offline'] }, /不可用/);
  assert.equal(e.board.list(P).length, 0, '检查不通过时一个任务都不建');

  const r = d.create(P, { type: 'extract_claims', title: '抽取论断', inputs: [{ id: 'S001', version: 1 }, { id: 'S002', version: 1 }, { id: 'S003', version: 1 }], participants: ['deepseek-pro', 'claude'] }, HUMAN);
  assert.equal(r.id, 'DV001');
  assert.deepEqual(r.parts.map((p) => [p.participant, p.inputs.map((x) => x.id)]), [['deepseek-pro', ['S001', 'S003']], ['claude', ['S002']]]);
  await w.runner.idle();
  // 每份的任务包只有自己那一份的来源正文
  const ds = w.prompts.find((p) => p.who === 'deepseek-pro').prompt;
  assert.ok(ds.includes('甲书说') && ds.includes('丙书说') && !ds.includes('乙书说'));
  assert.match(ds, /分工 DV001 的第 1\/2 份/);
  const [t1, t2] = d.list(P)[0].parts;
  assert.equal(t1.state, 'done');
  assert.deepEqual(t1.records.map((x) => x.id), ['C001', 'C002']);
  assert.equal(t2.state, 'open'); // 晋升被拒，回到 open 重做
  assert.match(t2.reason, /out_of_scope/);
  const cand = e.gw.candidates(P).find((x) => x.task_id === t2.task);
  assert.ok(cand && !cand.applied);
  assert.equal(e.gw.listRecords(P, 'claim').length, 2);
});

test('分工：按条目拆分（找资料）；新建与已有来源同一地址的来源卡被拒，各份的结果不重叠', async () => {
  const e = await env();
  await asHost(e, [{ kind: 'source', expected_version: 0, data: { title: '已有', url: 'https://example.org/known', text: '已有正文' } }]);
  const w = world(e, {
    claude: [json([{ kind: 'source', expected_version: 0, data: { title: '重复', url: 'https://example.org/known/' } }])],
    codex: [json([{ kind: 'source', expected_version: 0, data: { title: '新的', url: 'https://example.org/new' } }])],
  });
  const r = w.divisions.create(P, { type: 'collect_sources', title: '找资料', items: ['盘古神话的最早记载', '徐整与《三五历纪》'], participants: ['claude', 'codex'] }, HUMAN);
  assert.deepEqual(r.parts.map((p) => p.items), [['盘古神话的最早记载'], ['徐整与《三五历纪》']]);
  assert.throws(() => w.divisions.create(P, { type: 'collect_sources', items: ['甲', ' 甲 '], participants: ['claude'] }, HUMAN), /出现了两次/);
  await w.runner.idle();
  const [a, b] = w.divisions.list(P)[0].parts;
  assert.match(a.reason, /duplicate_source/);
  assert.equal(b.state, 'done');
  assert.deepEqual(partition([1, 2, 3, 4, 5], 2), [[1, 3, 5], [2, 4]]);
  assert.deepEqual(partition([1], 3), [[1]]);
});

// ---------- 接口 ----------

test('接口：发起、选定、接受或拒绝只限主持人；MCP 会话可以提补丁（提出者记为未证实）', async () => {
  const e = await env();
  await sample(e);
  const w = world(e, { claude: [DRAFT_A], codex: [DRAFT_B], 'deepseek-pro': REVIEW });
  const routes = workbenchRoutes({ workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, runner: w.runner, competitions: w.competitions, divisions: w.divisions, hostToken: 'tok', humanName: '主持人', readJson: async (req) => req.body });
  const call = (method, url, body, host = true) => {
    const route = routes.find(([m, re]) => m === method && re.test(url));
    return route[2]({ headers: host ? { 'x-workbench-host': 'tok' } : {}, body }, url.match(route[1]));
  };
  const base = `/api/projects/${encodeURIComponent(P)}`;
  await assert.rejects(async () => call('POST', `${base}/compete`, { type: 'outline', participants: ['claude', 'codex'] }, false), (err) => err.status === 403);
  await assert.rejects(async () => call('POST', `${base}/divide`, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }], participants: ['claude'] }, false), (err) => err.status === 403);
  await call('POST', `${base}/compete`, { type: 'outline', title: '题目', participants: ['claude', 'codex'] });
  await w.runner.idle();
  await call('POST', `${base}/competitions/K001/reveal`, {});
  await call('POST', `${base}/competitions/K001/review`, { reviewers: ['deepseek-pro'] });
  await w.runner.idle();
  await call('POST', `${base}/competitions/K001/reveal`, {});
  const v = await call('GET', `${base}/competitions/K001`);
  const A = v.label_drafts.find((l) => l.participant === 'claude').label;
  const B = v.label_drafts.find((l) => l.participant === 'codex').label;
  await assert.rejects(call('POST', `${base}/competitions/K001/select`, { label: A, reason: '好' }, false), (err) => err.status === 403);
  await call('POST', `${base}/competitions/K001/select`, { label: A, reason: '好' });
  const after1 = await call('POST', `${base}/competitions/K001/patches`, { agent: 'Codex', from: { draft: B, section: 1 }, to: { section: 1, position: 'before' } }, false);
  assert.deepEqual([after1.patches[0].proposed_by.kind, after1.patches[0].proposed_by.verified], ['mcp', false]);
  await assert.rejects(call('POST', `${base}/competitions/K001/patches/P1/decide`, { decision: 'accept' }, false), (err) => err.status === 403);
  await call('POST', `${base}/competitions/K001/patches/P1/decide`, { decision: 'accept' });
  await call('POST', `${base}/competitions/K001/apply`, {});
  assert.equal(rec(e, 'OL001').version, 2);
  const list = await call('GET', `${base}/competitions`);
  assert.deepEqual(list.map((x) => [x.id, x.stage]), [['K001', 'patching']]);
  // 待你决定里有竞争的事项；有补丁待决定时出现
  const inbox = await call('GET', `${base}/inbox`);
  assert.deepEqual(inbox.filter((i) => i.type === 'competition'), []);
});
