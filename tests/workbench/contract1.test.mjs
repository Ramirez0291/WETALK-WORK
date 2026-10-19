// 契约一：证据与核验。核验记录与异议的写入检查、份数计算、异议状态机、补证与“来源已不存在”的规则。
// 论断由服务端认定身份的 Agent 写入（经任务的栅栏），核验者、裁定者的身份同样由服务端认定。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createEvidenceFlow } from '../../lib/workbench/evidence.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { countVerifications } from '../../lib/workbench/verify.mjs';
import { collectInputs } from '../../lib/workbench/packets.mjs';
import { workbenchRoutes } from '../../lib/workbench/http.mjs';
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase } from './helpers.mjs';

after(cleanup);
const P = '样本';
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';

const agent = (participant, adapter, model = null) => ({ kind: 'server', participant, adapter, model, verified: true, basis: 'server-invoked' });
const DS = agent('deepseek', 'deepseek', 'deepseek-flash');
const DS2 = agent('deepseek-pro', 'deepseek', 'deepseek-pro');
const CL = agent('claude', 'claude');
const CX = agent('codex', 'codex');
const MCP = { kind: 'mcp', participant: 'codex', adapter: 'codex', model: null, verified: false, basis: 'mcp-self-reported' };

async function env({ evidenceMax = null } = {}) {
  const e = await setup();
  if (evidenceMax) fs.writeFileSync(path.join(e.workbench.get(P).dir, 'protocol.json'), JSON.stringify({ evidence: { maxAttempts: evidenceMax } }));
  const usage = createUsage({ workbench: e.workbench, pricing: DEFAULTS.pricing });
  const board = createTaskBoard({ workbench: e.workbench, usage });
  const availabilityOf = (p, urlOf) => usage.availabilityOf(p, { urlOf });
  const fetchFailed = (p, s, a) => usage.entries(p).some((x) => x.id === a && x.api === 'fetch' && x.source_id === s && x.settled && x.ok === false);
  const { gw } = await restart(e, { fence: board.fence, availabilityOf, fetchFailed });
  const flow = createEvidenceFlow({ workbench: e.workbench, gateway: gw, board, availabilityOf, onError: (err) => { throw err; } });
  return { ...e, gw, usage, board, flow };
}

// 以某个 Agent 的身份写入（经任务栅栏，身份由任务尝试派生）
async function as(e, holder, changes) {
  if (holder.kind === 'human' || holder.kind === 'mcp') {
    const r = e.gw.receive(P, { request_id: rid(), changes }, { actor: holder });
    return e.gw.promote(P, r.sid);
  }
  const t = e.board.create(P, { type: 'extract_claims' }, { created_by: HUMAN });
  const c = e.board.claim(P, t.id, holder);
  const r = e.gw.receive(P, { request_id: rid(), task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes });
  return e.gw.promote(P, r.sid);
}
const rejected = (promise, type) => assert.rejects(promise, (err) => err.status === 409 && err.details?.reasons?.some((r) => r.type === type), `应因 ${type} 被拒`);
const status = (e, id) => e.gw.getRecord(P, id).status;
const rec = (e, id) => e.gw.getRecord(P, id).record;

// 样本：主持人录入 S001（含正文）；DeepSeek 写 C001（引文“A 导致 B”确实出现在正文里）
async function sample(e, claim = {}) {
  await as(e, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await as(e, DS, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }], ...claim } }]);
}
const verification = (verdict, extra = {}) => ({
  kind: 'verification', expected_version: 0,
  data: { target: { id: 'C001', version: 1 }, source_versions: [{ id: 'S001', version: 1 }], verdict, reason: '理由', ...(verdict === 'supported' ? { support_quote: { id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' } } : {}), ...extra },
});
const objection = (data) => ({ kind: 'objection', expected_version: 0, data: { target: { id: 'C001', version: 1 }, reason: '问题在这里', state: 'open', ...data } });
const quotePtr = (quote) => ({ type: 'quote', source: { id: 'S001', version: 1 }, quote });
const move = (o, state, extra = {}) => ({ id: o.id, expected_version: o.version, data: { target: o.target, category: o.category, pointer: o.pointer, reason: o.reason, state, ...extra } });

// ---------- 契约一的验收案例 ----------

test('验收：来源写“没有证据表明 A 导致 B”、论断写“A 导致 B”：引文检查通过，核验者判 unsupported，论断不能进入成品', async () => {
  const e = await env();
  await sample(e); // 引文存在：晋升通过
  assert.equal(status(e, 'C001').verification.state, 'unreviewed');
  await as(e, CL, [verification('unsupported', { reason: '来源说的是“没有证据表明”，与论断相反' })]);
  const s = status(e, 'C001');
  assert.equal(s.verification.state, 'unsupported');
  assert.equal(s.ready, false);
  assert.equal(rec(e, 'V001').verifier.participant, 'claude');
  assert.equal(rec(e, 'V001').verifier.vendor, 'anthropic');
});

test('验收：论断改了措辞，旧核验不再计入，状态回到 unreviewed', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [verification('supported')]);
  assert.equal(status(e, 'C001').verification.state, 'supported');
  assert.equal(status(e, 'C001').ready, true);
  await as(e, DS, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: '没有证据表明 A 导致 B', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } }]);
  const s = status(e, 'C001');
  assert.equal(s.verification.state, 'unreviewed');
  assert.deepEqual(s.verification.counted, []);
  assert.equal(s.ready, false);
});

test('验收：同一论断有两条阻塞异议，只解决一条后仍不能进入成品', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [verification('supported')]);
  await as(e, CL, [objection({ category: 'quote_unsupported', pointer: quotePtr('没有证据表明 A 导致 B') })]);
  await as(e, CL, [objection({ category: 'number_error', pointer: quotePtr('当地人口为 1200 人') })]);
  assert.deepEqual(status(e, 'C001').blockers, ['O001', 'O002']);
  await as(e, CX, [move(rec(e, 'O002'), 'rejected', { resolution: '论断里没有数字，这条异议不成立' })]); // 作者、提出者之外的另一厂商裁定
  const s = status(e, 'C001');
  assert.deepEqual(s.blockers, ['O001']);
  assert.equal(s.ready, false);
});

test('验收：发现数字矛盾但找不到原文：异议为 needs_evidence 并生成补证任务，超过上限后转 needs_user', async () => {
  const e = await env({ evidenceMax: 2 });
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: { type: 'location', locator: '论断与第 3 页的数字前后矛盾' }, state: 'needs_evidence' })]);
  assert.deepEqual(status(e, 'C001').blockers, ['O001']); // 待补证照样阻塞
  const fail = (t) => {
    const c = e.board.claim(P, t.id, CX);
    e.board.failAttempt(P, t.id, c, '补证未完成：没有找到可定位的原文');
  };
  let acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => a.action), ['evidence_task']);
  const t1 = e.board.get(P, acts[0].task);
  assert.equal(t1.type, 'find_evidence');
  assert.equal(t1.max_attempts, 1);
  assert.deepEqual(t1.inputs.map((i) => i.id), ['O001', 'C001']);
  assert.deepEqual(await e.flow.reconcile(P), []); // 补证进行中：不重复生成
  fail(t1);
  assert.equal(e.board.get(P, t1.id).state, 'failed');
  acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => a.action), ['evidence_task']);
  fail(e.board.get(P, acts[0].task));
  acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => a.action), ['evidence_limit']);
  const o = rec(e, 'O001');
  assert.equal(o.state, 'needs_user');
  assert.equal(o.provenance.kind, 'system');
  assert.match(o.resolution, /补证任务已做 2 次/);
  assert.deepEqual(status(e, 'C001').blockers, ['O001']); // 不会自动作废
  assert.deepEqual(await e.flow.reconcile(P), []);
});

test('验收：Fetch 失败时来源为 temporarily_unavailable，已有快照仍可用于核验；fetch_failure 指针必须指向真实的失败记录', async () => {
  const e = await env();
  await sample(e);
  const id = e.usage.reserve(P, { api: 'fetch', attempt: 1, source_id: 'S001', url: 'https://example.org/book' });
  e.usage.settle(P, id, { ok: false, status: 503, usd: 0, error: 'HTTP 503' });
  assert.equal(e.gw.getRecord(P, 'S001').availability.state, 'temporarily_unavailable');
  await as(e, CL, [verification('supported')]); // 快照仍是证据
  assert.equal(status(e, 'C001').verification.state, 'supported');
  await rejected(as(e, CX, [objection({ category: 'source_missing', pointer: { type: 'fetch_failure', source: { id: 'S001' }, attempt: 'no-such-attempt' } })]), 'pointer_fetch_failure_not_found');
  await as(e, CX, [objection({ category: 'source_missing', pointer: { type: 'fetch_failure', source: { id: 'S001' }, attempt: id } })]);
  assert.equal(rec(e, 'O001').state, 'open');
});

test('验收：与作者同厂商的核验记录被提交入口拒绝（含同厂商的另一个模型、主持人核验自己录入的论断）', async () => {
  const e = await env();
  await sample(e);
  await rejected(as(e, DS2, [verification('supported')]), 'same_vendor');
  await rejected(as(e, { ...MCP, participant: 'ds-mcp', adapter: 'deepseek' }, [verification('supported')]), 'same_vendor'); // 自报同厂商也拒
  await as(e, HUMAN, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '主持人写的论断', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  await rejected(as(e, HUMAN, [verification('supported', { target: { id: 'C002', version: 1 } })]), 'is_author'); // 主持人是这条论断的作者
  assert.equal(e.gw.listRecords(P, 'verification').length, 0);
});

// ---------- 份数 ----------

test('核心结论需要两位独立核验者：同一核验者只算最新一份；主持人算一份；MCP 会话的核验保存但不计入', async () => {
  const e = await env();
  await sample(e, { core: true });
  await as(e, CL, [verification('supported')]);
  let v = status(e, 'C001').verification;
  assert.deepEqual([v.state, v.independent, v.required, v.enough], ['supported', 1, 2, false]);
  assert.equal(status(e, 'C001').ready, false);
  await as(e, CL, [verification('supported', { reason: '再看一遍' })]); // 同一核验者：只算最新一份
  v = status(e, 'C001').verification;
  assert.deepEqual([v.independent, v.counted], [1, ['V002']]);
  assert.deepEqual(v.uncounted, [{ id: 'V001', reason: 'superseded' }]);
  await as(e, MCP, [verification('supported')]); // 身份未证实
  v = status(e, 'C001').verification;
  assert.equal(v.independent, 1);
  assert.ok(v.uncounted.some((u) => u.id === 'V003' && u.reason === 'identity_unverified'));
  assert.equal(rec(e, 'V003').verifier.verified, false);
  await as(e, HUMAN, [verification('supported')]); // 主持人算一份
  v = status(e, 'C001').verification;
  assert.deepEqual([v.independent, v.enough], [2, true]);
  assert.equal(status(e, 'C001').ready, true);
  // 同一核验者改判：只看最新一份，结论变为 disputed
  await as(e, CL, [verification('unsupported')]);
  assert.equal(status(e, 'C001').verification.state, 'disputed');
});

test('同厂商的两个不同参与者在“按核验者去重”下各算一份（与作者都不同厂商时）', async () => {
  const e = await env();
  await sample(e, { core: true });
  await as(e, CL, [verification('supported')]);
  await as(e, agent('claude-2', 'claude'), [verification('supported')]);
  assert.equal(status(e, 'C001').verification.independent, 2);
  assert.equal(status(e, 'C001').ready, true);
});

// ---------- 核验记录的写入检查 ----------

test('核验记录：目标必须是当前版本、来源版本必须完整且当前、支持引文必须出自所引来源并能定位；写入后不能修改', async () => {
  const e = await env();
  await sample(e);
  await rejected(as(e, CL, [verification('supported', { target: { id: 'C001', version: 2 } })]), 'stale_target');
  await rejected(as(e, CL, [verification('supported', { source_versions: [] })]), 'source_versions_mismatch');
  await rejected(as(e, CL, [verification('supported', { support_quote: { id: 'S001', version: 1, quote: '原文里没有这句' } })]), 'quote_not_found');
  await as(e, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: '别的书', url: 'https://example.org/other', text: 'A 导致 B，这是另一本书说的。' } }]);
  await rejected(as(e, CL, [verification('supported', { support_quote: { id: 'S002', version: 1, quote: 'A 导致 B' } })]), 'support_quote_foreign');
  await as(e, CL, [verification('supported')]);
  await rejected(as(e, CL, [{ id: 'V001', expected_version: 1, data: verification('unsupported').data }]), 'immutable_record');
  assert.throws(() => e.gw.receive(P, { request_id: rid(), changes: [{ ...verification('supported'), data: { ...verification('supported').data, verifier: { participant: 'claude' } } }] }, { actor: HUMAN }), /verifier 由提交入口填写/);
});

// ---------- 异议状态机 ----------

test('异议：阻塞类 open 必须带能核对的指针；定位不到时只能提为 needs_evidence；非阻塞类可以只写位置', async () => {
  const e = await env();
  await sample(e);
  await rejected(as(e, CL, [objection({ category: 'number_error', pointer: { type: 'location', locator: '第 3 页' } })]), 'pointer_type');
  await rejected(as(e, CL, [objection({ category: 'quote_unsupported', pointer: quotePtr('原文里没有') })]), 'pointer_quote_not_found');
  await rejected(as(e, CL, [objection({ category: 'source_missing', pointer: { type: 'missing_source' } })]), 'pointer_claim_has_sources');
  await rejected(as(e, CL, [objection({ category: 'source_missing', pointer: { type: 'gone', source: { id: 'S001' } } })]), 'pointer_gone_rule_only');
  await rejected(as(e, CL, [objection({ category: 'interpretation', pointer: { type: 'location', locator: '第 1 段' }, state: 'needs_evidence' })]), 'needs_evidence_blocking_only');
  await rejected(as(e, CL, [objection({ category: 'interpretation', pointer: { type: 'location', locator: '第 1 段' }, target: { id: 'C001', version: 9 } })]), 'stale_target');
  await as(e, CL, [objection({ category: 'interpretation', pointer: { type: 'location', locator: '第 1 段' } })]);
  assert.deepEqual(status(e, 'C001').blockers, []); // 非阻塞
  assert.equal(rec(e, 'O001').raised_by.participant, 'claude');
});

test('异议：裁定者不能是提出者或作者、不能与作者同厂商，必须写理由；撤回只限提出者；待你决定只限主持人；终态不能再改', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'quote_unsupported', pointer: quotePtr('没有证据表明 A 导致 B') })]);
  const o = () => rec(e, 'O001');
  await rejected(as(e, CL, [move(o(), 'upheld', { resolution: '成立' })]), 'judge_is_raiser');
  await rejected(as(e, DS, [move(o(), 'rejected', { resolution: '不成立' })]), 'judge_is_author');
  await rejected(as(e, DS2, [move(o(), 'rejected', { resolution: '不成立' })]), 'judge_same_vendor');
  await rejected(as(e, MCP, [move(o(), 'upheld', { resolution: '成立' })]), 'role');
  await rejected(as(e, CX, [move(o(), 'upheld')]), 'resolution_required');
  await rejected(as(e, CX, [move(o(), 'withdrawn')]), 'role');
  await rejected(as(e, CX, [move(o(), 'open', { pointer: quotePtr('A 导致 B') })]), 'bad_transition');
  await as(e, CX, [move(o(), 'needs_user', { resolution: '对分类有争议' })]);
  await rejected(as(e, CX, [move(o(), 'rejected', { resolution: '不成立' })]), 'role');
  await as(e, HUMAN, [move(o(), 'rejected', { resolution: '主持人裁决：不成立' })]);
  await rejected(as(e, HUMAN, [move(o(), 'open')]), 'final_state');
  // 提出者撤回自己的
  await as(e, CL, [objection({ category: 'number_error', pointer: quotePtr('当地人口为 1200 人') })]);
  await as(e, CL, [move(rec(e, 'O002'), 'withdrawn')]);
  assert.equal(rec(e, 'O002').state, 'withdrawn');
  assert.equal(rec(e, 'O002').raised_by.participant, 'claude'); // 提出者不随新版本改变
});

test('异议：upheld 之后，论断改版并重新核验通过才能转为 resolved', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'quote_unsupported', pointer: quotePtr('没有证据表明 A 导致 B') })]);
  await as(e, CX, [move(rec(e, 'O001'), 'upheld', { resolution: '引文与论断相反' })]);
  await rejected(as(e, CX, [move(rec(e, 'O001'), 'resolved', { resolution: '已改' })]), 'not_settled'); // 还没改版
  await as(e, DS, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: '没有证据表明 A 导致 B', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } }]);
  await rejected(as(e, CX, [move(rec(e, 'O001'), 'resolved', { resolution: '已改' })]), 'not_settled'); // 改版了，但还没重新核验
  await as(e, CL, [verification('supported', { target: { id: 'C001', version: 2 } })]);
  assert.deepEqual(status(e, 'C001').blockers, ['O001']);
  await as(e, CX, [move(rec(e, 'O001'), 'resolved', { resolution: '论断已按原文改写并重新核验' })]);
  assert.deepEqual(status(e, 'C001').blockers, []);
  assert.equal(status(e, 'C001').ready, true);
});

// ---------- 来源已不存在 ----------

test('主持人确认来源 gone：规则对引用它的每条论断提出“来源不存在”异议；撤销后规则撤回；再次确认会再提', async () => {
  const e = await env();
  await sample(e);
  await as(e, DS, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '人口 1200', sources: [{ id: 'S001', version: 1, quote: '当地人口为 1200 人' }] } }]);
  await as(e, CL, [verification('supported')]);
  e.usage.mark(P, 'S001', 'gone', { by: '主持人', url: 'https://example.org/book' });
  let acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => `${a.action}:${a.claim}`).sort(), ['gone_objection:C001', 'gone_objection:C002']);
  assert.deepEqual(status(e, 'C001').blockers, ['O001']);
  assert.equal(rec(e, 'O001').raised_by.kind, 'system');
  assert.equal(rec(e, 'O001').category, 'source_missing');
  assert.deepEqual(await e.flow.reconcile(P), []); // 重复执行不重复提
  e.usage.mark(P, 'S001', 'available', { by: '主持人', url: 'https://example.org/book' });
  acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => a.action), ['gone_withdrawn', 'gone_withdrawn']);
  assert.equal(rec(e, 'O001').state, 'withdrawn');
  assert.deepEqual(status(e, 'C001').blockers, []);
  e.usage.mark(P, 'S001', 'gone', { by: '主持人', url: 'https://example.org/book' });
  acts = await e.flow.reconcile(P);
  assert.equal(acts.filter((a) => a.action === 'gone_objection').length, 2);
});

// ---------- 对抗核验与补证：经任务派发 ----------

function withRunner(e, replies) {
  const people = [
    { id: 'claude', name: 'Claude', adapter: 'claude', resolved: 'claude' },
    { id: 'codex', name: 'Codex', adapter: 'codex', resolved: 'codex' },
    { id: 'deepseek-pro', name: 'DeepSeek Pro', adapter: 'deepseek', model: 'deepseek-pro', resolved: 'api' },
  ];
  const prompts = [];
  const base = tmpBase();
  const runner = createRunner({
    workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, sealed: createSealedStore(),
    participants: Object.assign((id) => people.find((p) => p.id === id), { all: () => people }),
    runAgent: async (p, prompt) => {
      prompts.push({ who: p.id, prompt });
      return { raw: replies.shift(), model: null, exec: { args: [] }, usage: null, audit: null };
    },
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
  });
  return { runner, prompts };
}
const json = (v) => '```json\n' + JSON.stringify(v) + '\n```';

test('对抗核验任务：只派给与作者不同厂商的核验者；任务包内联论断、来源与正文；结果写成核验记录与异议，目标版本取自任务', async () => {
  const e = await env();
  await sample(e);
  const { runner, prompts } = withRunner(e, [
    json({ verdict: 'supported', reason: '原文就是这么说的', support_quote: { id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }, objections: [{ category: 'interpretation', pointer: { type: 'location', locator: '论断第 1 句' }, reason: '“导致”的说法过强', state: 'open' }] }),
    '我觉得没问题。',
  ]);
  const task = () => e.board.create(P, { type: 'verify_claim', inputs: [{ id: 'C001', version: 1 }] }, { created_by: HUMAN });
  const t1 = task();
  assert.throws(() => runner.dispatch(P, t1.id, 'deepseek-pro'), (err) => err.status === 409 && /同厂商/.test(err.message));
  assert.equal(e.board.get(P, t1.id).state, 'open'); // 没认领
  runner.dispatch(P, t1.id, 'claude');
  await runner.idle();
  assert.equal(e.board.get(P, t1.id).state, 'done');
  assert.ok(prompts[0].prompt.includes(TEXT), '来源正文内联在提示词里');
  assert.match(prompts[0].prompt, /对抗核验者/);
  const v = rec(e, 'V001');
  assert.deepEqual([v.target, v.source_versions, v.verifier.participant, v.verifier.vendor], [{ id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'claude', 'anthropic']);
  assert.equal(rec(e, 'O001').category, 'interpretation');
  assert.equal(status(e, 'C001').verification.independent, 1);
  // 同一核验者不再派
  const t2 = task();
  assert.throws(() => runner.dispatch(P, t2.id, 'claude'), /已核验过/);
  // 回复不合格式：这次尝试失败，回到 open
  runner.dispatch(P, t2.id, 'codex');
  await runner.idle();
  assert.equal(e.board.get(P, t2.id).state, 'open');
  assert.match(e.board.get(P, t2.id).history.at(-1).reason, /结果无法解析/);
});

test('补证任务：找到原文就把异议改为 open 并补上有效指针；找不到时这一次补证结束（任务只做一次）', async () => {
  const e = await env({ evidenceMax: 2 });
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: { type: 'location', locator: '人口数字' }, state: 'needs_evidence' })]);
  const o = rec(e, 'O001');
  const fixed = [{ id: 'O001', expected_version: 1, data: { target: o.target, category: o.category, pointer: quotePtr('当地人口为 1200 人'), reason: o.reason, state: 'open' } }];
  const { runner } = withRunner(e, ['查过 S001，没有找到。', json(fixed)]);
  let [act] = await e.flow.reconcile(P);
  runner.dispatch(P, act.task, 'codex');
  await runner.idle();
  assert.equal(e.board.get(P, act.task).state, 'failed');
  assert.match(e.board.get(P, act.task).history.at(-1).reason, /补证未完成：没有找到可定位的原文/);
  [act] = await e.flow.reconcile(P);
  assert.equal(act.action, 'evidence_task');
  runner.dispatch(P, act.task, 'codex');
  await runner.idle();
  assert.equal(e.board.get(P, act.task).state, 'done');
  assert.equal(rec(e, 'O001').state, 'open');
  assert.equal(rec(e, 'O001').pointer.type, 'quote');
  assert.deepEqual(await e.flow.reconcile(P), []);
});

// ---------- WP5a 评审（Astra，R1–R7）----------

test('评审 R1：主持人对 Agent 的论断只做小改，原作者（及其同厂商）仍不能核验；作者集合随版本累积；其他厂商照常计入', async () => {
  const e = await env();
  await sample(e);
  await as(e, HUMAN, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'A 导致 B。', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  assert.deepEqual(rec(e, 'C001').authors.map((a) => `${a.participant}/${a.vendor}`), ['deepseek/deepseek', '主持人/human']);
  const v2 = (extra = {}) => verification('supported', { target: { id: 'C001', version: 2 }, ...extra });
  await rejected(as(e, DS, [v2()]), 'is_author');
  await rejected(as(e, DS2, [v2()]), 'same_vendor');
  await rejected(as(e, HUMAN, [v2()]), 'is_author');
  // 裁定针对它的异议同样按作者集合判断
  await as(e, CL, [objection({ target: { id: 'C001', version: 2 }, category: 'quote_unsupported', pointer: quotePtr('没有证据表明 A 导致 B') })]);
  await rejected(as(e, DS, [move(rec(e, 'O001'), 'rejected', { resolution: '不成立' })]), 'judge_is_author');
  await rejected(as(e, DS2, [move(rec(e, 'O001'), 'rejected', { resolution: '不成立' })]), 'judge_same_vendor');
  await as(e, CX, [v2()]);
  assert.deepEqual([status(e, 'C001').verification.independent, status(e, 'C001').verification.enough], [1, true]);
  // 主持人新写的论断：作者只有主持人，Agent 的核验照常计入
  await as(e, HUMAN, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '主持人写的', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  await as(e, DS, [verification('supported', { target: { id: 'C002', version: 1 } })]);
  assert.equal(status(e, 'C002').verification.enough, true);
});

test('评审 R1：对抗核验的派发同样按作者集合挑选，原作者的同厂商参与者不会被派到', async () => {
  const e = await env();
  await sample(e);
  await as(e, HUMAN, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'A 导致 B。', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  const { runner } = withRunner(e, []);
  const t = e.board.create(P, { type: 'verify_claim', inputs: [{ id: 'C001', version: 2 }] }, { created_by: HUMAN });
  assert.throws(() => runner.dispatch(P, t.id, 'deepseek-pro'), (err) => err.status === 409 && /同厂商/.test(err.message) && /deepseek\/deepseek/.test(err.message));
});

test('评审 R2：厂商推断不出的一方不能由 Agent 裁定异议（裁定者、作者或双方不明）；主持人仍可裁定', async () => {
  const MYSTERY = agent('mystery', 'generic');
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: quotePtr('当地人口为 1200 人') })]);
  await rejected(as(e, MYSTERY, [move(rec(e, 'O001'), 'rejected', { resolution: '不成立' })]), 'judge_vendor_unknown');
  // 作者厂商不明
  await as(e, MYSTERY, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '人口 1200', sources: [{ id: 'S001', version: 1, quote: '当地人口为 1200 人' }] } }]);
  await as(e, CL, [objection({ target: { id: 'C002', version: 1 }, category: 'number_error', pointer: quotePtr('当地人口为 1200 人') })]);
  await rejected(as(e, CX, [move(rec(e, 'O002'), 'rejected', { resolution: '不成立' })]), 'judge_author_vendor_unknown');
  await rejected(as(e, agent('mystery-2', 'generic'), [move(rec(e, 'O002'), 'rejected', { resolution: '不成立' })]), 'judge_vendor_unknown');
  assert.deepEqual(status(e, 'C002').blockers, ['O002']);
  await as(e, HUMAN, [move(rec(e, 'O002'), 'rejected', { resolution: '主持人裁定' })]);
  await as(e, CX, [move(rec(e, 'O001'), 'upheld', { resolution: '跨厂商裁定照常' })]);
  assert.equal(rec(e, 'O001').state, 'upheld');
});

test('评审 R3：身份以这次调用实际报告的厂商为准：与作者同厂商被拒；与配置冲突保存但不计入；一致或没有报告按配置', async () => {
  const run = async (author, model) => {
    const e = await env();
    await sample(e);
    if (author !== DS) await as(e, author, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B（另一位作者）', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
    const target = author === DS ? 'C001' : 'C002';
    const reply = json({ verdict: 'supported', reason: '原文', support_quote: { id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }, objections: [] });
    const base = tmpBase();
    const people = [{ id: 'claude', name: 'Claude', adapter: 'claude', resolved: 'claude' }];
    const runner = createRunner({
      workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, sealed: createSealedStore(),
      participants: Object.assign((id) => people.find((p) => p.id === id), { all: () => people }),
      runAgent: async () => ({ raw: reply, model, exec: { args: [] }, usage: null, audit: null }),
      workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
    });
    const t = e.board.create(P, { type: 'verify_claim', inputs: [{ id: target, version: 1 }] }, { created_by: HUMAN });
    runner.dispatch(P, t.id, 'claude');
    await runner.idle();
    return { t: e.board.get(P, t.id), v: e.gw.listRecords(P, 'verification')[0]?.record ?? null, status: status(e, target) };
  };
  // 配置是 Claude，实际报告的是 OpenAI 的模型；作者是 Codex（OpenAI）：同厂商，晋升被拒
  let r = await run(CX, 'gpt-6-fixture');
  assert.equal(r.v, null);
  assert.match(r.t.history.at(-1).reason, /same_vendor/);
  // 作者是 DeepSeek：报告的 OpenAI 与作者不同厂商，但与配置冲突：保存，标为待确认，不计入
  r = await run(DS, 'gpt-6-fixture');
  assert.deepEqual([r.v.verifier.vendor, r.v.verifier.configured_vendor, r.v.verifier.vendor_conflict], ['openai', 'anthropic', true]);
  assert.deepEqual(r.status.verification.uncounted, [{ id: r.v.id, reason: 'vendor_conflict' }]);
  assert.equal(r.status.ready, false);
  // 报告与配置一致：计入
  r = await run(DS, 'claude-opus-5-5');
  assert.deepEqual([r.v.verifier.vendor, r.v.verifier.vendor_conflict ?? false, r.status.verification.enough], ['anthropic', false, true]);
  // 没有报告模型：按配置
  r = await run(DS, null);
  assert.deepEqual([r.v.verifier.vendor, r.status.verification.enough], ['anthropic', true]);
});

test('评审 R4：论断改版后，补证任务仍针对异议所指的版本，任务包附的是那个版本所引的来源正文', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: { type: 'location', locator: '人口' }, state: 'needs_evidence' })]);
  await as(e, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: '新来源', url: 'https://example.org/new', text: '新来源：A 导致 B。' } }]);
  await as(e, DS, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S002', version: 1, quote: 'A 导致 B' }] } }]);
  const [act] = await e.flow.reconcile(P);
  const t = e.board.get(P, act.task);
  assert.deepEqual(t.inputs, [{ id: 'O001', version: 1 }, { id: 'C001', version: 1 }]);
  const inputs = collectInputs({ gateway: e.gw, project: P, task: t, visibility: 'read' });
  assert.deepEqual(inputs.filter((i) => i.role === 'source_text').map((i) => i.ref), ['S001@1']);
  assert.ok(inputs.some((i) => i.ref === 'C001@1' && i.text.includes('"S001"')));
});

test('评审 R5：撤销 gone 时，规则撤回自己提出的 open 和待你决定的异议，成立的保留；一条失败不影响其余', async () => {
  const e = await env();
  await sample(e);
  for (let i = 0; i < 2; i++) await as(e, DS, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: `第 ${i + 2} 条`, sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  e.usage.mark(P, 'S001', 'gone', { by: '主持人', url: 'https://example.org/book' });
  await e.flow.reconcile(P);
  const byClaim = (c) => e.gw.listRecords(P, 'objection').map((x) => x.record).find((o) => o.target.id === c);
  await as(e, CL, [move(byClaim('C002'), 'needs_user', { resolution: '有争议' })]);
  await as(e, CX, [move(byClaim('C003'), 'upheld', { resolution: '来源确实没了' })]);
  e.usage.mark(P, 'S001', 'available', { by: '主持人', url: 'https://example.org/book' });
  // 规则之外的人不能借这个例外撤回待你决定的异议
  await rejected(as(e, CL, [move(byClaim('C002'), 'withdrawn')]), 'role');
  const acts = await e.flow.reconcile(P);
  assert.deepEqual(acts.map((a) => a.action).sort(), ['gone_withdrawn', 'gone_withdrawn']);
  assert.deepEqual(['C001', 'C002', 'C003'].map((c) => byClaim(c).state), ['withdrawn', 'withdrawn', 'upheld']);
});

test('评审 R5：规则的一条写入被拒时，其余各条照常处理，错误在本轮结束后报告', async () => {
  const e = await env();
  await sample(e);
  await as(e, DS, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '第 2 条', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  const errors = [];
  const availabilityOf = (p, urlOf) => e.usage.availabilityOf(p, { urlOf });
  const flow = createEvidenceFlow({ workbench: e.workbench, gateway: e.gw, board: e.board, availabilityOf, onError: (err) => errors.push(err) });
  e.usage.mark(P, 'S001', 'gone', { by: '主持人', url: 'https://example.org/book' });
  // 让 C001 的那一条写入失败：先把 C001 的提交请求号占掉
  const orig = e.gw.receive;
  e.gw.receive = (p, body, opts) => {
    if (body.request_id.startsWith('rule-gone-C001')) throw Object.assign(new Error('模拟：这一条被拒'), { status: 409 });
    return orig(p, body, opts);
  };
  const acts = await flow.reconcile(P);
  e.gw.receive = orig;
  assert.deepEqual(acts.map((a) => `${a.action}:${a.claim}`), ['error:C001', 'gone_objection:C002']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /gone_objection/);
});

test('评审 R6：编号超过三位后，同一核验者的“最新一份”按编号数值取', () => {
  const claim = { id: 'C001', version: 1, sources: [{ id: 'S001', version: 1 }], provenance: DS };
  const records = new Map([['S001', { id: 'S001', version: 1 }]]);
  const verifier = { kind: 'server', participant: 'claude', vendor: 'anthropic', verified: true };
  const v = (id, verdict) => ({ id, version: 1, target: { id: 'C001', version: 1 }, source_versions: [{ id: 'S001', version: 1 }], verdict, verifier });
  for (const [older, newer] of [['V999', 'V1000'], ['V9999', 'V10000']]) {
    for (const [a, b] of [['supported', 'unsupported'], ['unsupported', 'supported']]) {
      const r = countVerifications(claim, [v(older, a), v(newer, b)], records);
      assert.deepEqual([r.state, r.counted], [b, [newer]], `${older}=${a} → ${newer}=${b}`);
    }
  }
});

test('评审 R7：异议状态接口用同一 request_id 原样重试，返回第一次的结果、不产生新版本；换了内容仍冲突', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: quotePtr('当地人口为 1200 人') })]);
  const routes = workbenchRoutes({ workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, hostToken: 'tok', humanName: '主持人', readJson: async (req) => req.body });
  const url = `/api/projects/${encodeURIComponent(P)}/objections/O001/resolve`;
  const route = routes.find(([m, re]) => m === 'POST' && re.test(url));
  const call = (body) => route[2]({ headers: { 'x-workbench-host': 'tok' }, body }, url.match(route[1]));
  const body = { request_id: 'resolve-retry-0001', state: 'rejected', resolution: '主持人裁定不成立' };
  const first = await call(body);
  const again = await call({ ...body });
  assert.equal(again.receipt.sid, first.receipt.sid);
  assert.equal(again.result.cid, first.result.cid);
  assert.equal(rec(e, 'O001').version, 2);
  await assert.rejects(call({ ...body, resolution: '换了理由' }), (err) => err.status === 409 && /内容不同/.test(err.message));
  await assert.rejects(call({ ...body, state: 'upheld' }), (err) => err.status === 409);
  assert.equal(rec(e, 'O001').version, 2);
});

// ---------- WP5a 第二轮复审（Astra，R1–R2）----------

test('复审 R1：同一参与者换厂商的模型改写后，两次贡献的厂商都留在作者集合里；两个厂商的其他参与者都不能核验或裁定，第三厂商可以', async () => {
  const W1 = agent('writer', 'generic', 'deepseek-fixture');
  const W2 = agent('writer', 'generic', 'gpt-6-fixture');
  const e = await env();
  await as(e, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await as(e, W1, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  await as(e, W2, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'A 导致 B。', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  assert.deepEqual(rec(e, 'C001').authors.map((a) => `${a.participant}/${a.vendor}`), ['writer/deepseek', 'writer/openai']);
  const v2 = verification('supported', { target: { id: 'C001', version: 2 } });
  await rejected(as(e, CX, [v2]), 'same_vendor'); // 后一次贡献的厂商
  await rejected(as(e, DS2, [v2]), 'same_vendor'); // 前一次贡献的厂商
  await as(e, CL, [objection({ target: { id: 'C001', version: 2 }, category: 'quote_unsupported', pointer: quotePtr('没有证据表明 A 导致 B') })]);
  await rejected(as(e, CX, [move(rec(e, 'O001'), 'rejected', { resolution: '不成立' })]), 'judge_same_vendor');
  await as(e, CL, [v2]);
  assert.equal(status(e, 'C001').verification.enough, true);
  // 派发同样拒绝两个厂商
  const { runner } = withRunner(e, []);
  const t = e.board.create(P, { type: 'verify_claim', inputs: [{ id: 'C001', version: 2 }] }, { created_by: HUMAN });
  assert.throws(() => runner.dispatch(P, t.id, 'codex'), (err) => err.status === 409 && /writer\/openai/.test(err.message));
  assert.throws(() => runner.dispatch(P, t.id, 'deepseek-pro'), (err) => err.status === 409);
});

test('复审 R1：厂商从推断不出变为能推断，旧的“推断不出”仍保留（保守）：Agent 的核验不计入，主持人的计入', async () => {
  const W0 = agent('writer', 'generic'); // 没有模型：推断不出
  const W2 = agent('writer', 'generic', 'gpt-6-fixture');
  const e = await env();
  await as(e, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await as(e, W0, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'A 导致 B', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  await as(e, W2, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'A 导致 B。', sources: [{ id: 'S001', version: 1, quote: 'A 导致 B' }] } }]);
  assert.deepEqual(rec(e, 'C001').authors.map((a) => a.vendor), ['unknown', 'openai']);
  await as(e, CL, [verification('supported', { target: { id: 'C001', version: 2 } })]);
  assert.deepEqual(status(e, 'C001').verification.uncounted.map((u) => u.reason), ['author_vendor_unknown']);
  await as(e, HUMAN, [verification('supported', { target: { id: 'C001', version: 2 } })]);
  assert.equal(status(e, 'C001').verification.enough, true);
});

test('复审 R2：匿名评审实际发送的提示词里没有内容生产者的身份（主持人、已不在名单里的旧参与者、多位作者、报告的模型）；服务端记录照样可追溯', async () => {
  const OLD = agent('old-writer', 'generic', 'gpt-6-fixture'); // 不在当前参与者名单里
  const e = await env();
  await as(e, OLD, [{ kind: 'outline', expected_version: 0, data: { title: '大纲', body: '第一节：问题。第二节：做法。' } }]);
  await as(e, HUMAN, [{ id: 'OL001', expected_version: 1, data: { title: '大纲', body: '第一节：问题。第二节：做法与边界。' } }]);
  assert.deepEqual(rec(e, 'OL001').authors.map((a) => a.participant), ['old-writer', '主持人']);
  const { runner, prompts } = withRunner(e, ['方案甲 第 2 节：边界写得太含糊。']);
  const t = e.board.create(P, { type: 'anonymous_review', inputs: [{ id: 'OL001', version: 2 }] }, { created_by: HUMAN });
  runner.dispatch(P, t.id, 'claude');
  await runner.idle();
  assert.equal(e.board.get(P, t.id).state, 'submitted');
  const sent = prompts[0].prompt;
  assert.match(sent, /做法与边界/); // 内容在
  for (const leak of ['主持人', 'old-writer', 'gpt-6-fixture', 'openai', '"human"', '"authors"', '"provenance"', 'verified']) assert.ok(!sent.includes(leak), `提示词里不该出现：${leak}`);
});

test('复审 R2：核验与补证任务的输入里也不带论断作者、核验者、异议提出者的身份', async () => {
  const e = await env();
  await sample(e);
  await as(e, CL, [objection({ category: 'number_error', pointer: { type: 'location', locator: '人口' }, state: 'needs_evidence' })]);
  const [act] = await e.flow.reconcile(P);
  const inputs = collectInputs({ gateway: e.gw, project: P, task: e.board.get(P, act.task), visibility: 'read' });
  const all = inputs.map((i) => i.text).join('\n');
  for (const leak of ['"raised_by"', '"authors"', '"provenance"', 'deepseek-flash']) assert.ok(!all.includes(leak), `任务输入里不该出现：${leak}`);
  assert.ok(all.includes('某书'), '来源卡的书目信息保留');
});
