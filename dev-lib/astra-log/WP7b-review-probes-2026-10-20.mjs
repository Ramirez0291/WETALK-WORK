// Astra independent WP7b review probes. Exit 0 means the observed bugs reproduce.
// Fixture helpers adapted from tests/workbench/wp7b.test.mjs; no real model calls.
// WP7b：逐页的视觉检查（模型看截图初查、主持人终审，每页每次一条渲染检查记录 RC###）、试运行报告（与单 Agent 基线逐项对比），
// 以及整套流程的集成测试：提交、核验、追溯、更正来源、重新核验、导出、渲染检查、视觉检查、终审、报告。
// 渲染用假渲染器、看图用假参与者（通用适配器）；测试目录的路径含日文字符（helpers 的 tmpBase）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { createExports } from '../../lib/workbench/exports.mjs';
import { createReport, parseBaseline } from '../../lib/workbench/report.mjs';
import { restorePacket } from '../../lib/workbench/packets.mjs';
import { workbenchRoutes, FILE_RESPONSE } from '../../lib/workbench/http.mjs';
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase, ROOT } from '../../tests/workbench/helpers.mjs';

after(cleanup);
const P = '样本';
const PYTHON = path.resolve(ROOT, DEFAULTS.export.python);
const NO_PY = fs.existsSync(PYTHON) ? false : '没有 .venv（导出用的 Python），跳过';
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';
const TEXT2 = '县志记载：当地人口在 1950 年为 1200 人，此后逐年减少。';
const holder = (participant, adapter) => ({ kind: 'server', participant, adapter, model: null, verified: true, basis: 'server-invoked' });
const DS = holder('deepseek', 'deepseek');
const CLAUDE = holder('claude', 'claude');
const PEOPLE = [
  { id: 'looker', name: 'Looker', adapter: 'generic', resolved: 'fake' }, // 能看图（通用适配器把图片路径写进提示词）
  { id: 'codex', name: 'Codex', adapter: 'codex', resolved: 'codex' }, // 这一版不能看图
];
const json = (v) => '```json\n' + JSON.stringify(v) + '\n```';

async function env() {
  const e = await setup();
  const usage = createUsage({ workbench: e.workbench, pricing: DEFAULTS.pricing });
  const board = createTaskBoard({ workbench: e.workbench, usage });
  const { gw } = await restart(e, { fence: board.fence });
  return { ...e, gw, usage, board };
}
async function asHost(e, changes) {
  const r = e.gw.receive(P, { request_id: rid(), changes }, { actor: HUMAN });
  return e.gw.promote(P, r.sid);
}
async function asAgent(e, who, changes) {
  const t = e.board.create(P, { type: 'extract_claims' }, { created_by: HUMAN });
  const c = e.board.claim(P, t.id, who);
  const r = e.gw.receive(P, { request_id: rid(), task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes });
  return e.gw.promote(P, r.sid);
}
const verify = (id, version, src, quote) => ({ kind: 'verification', expected_version: 0, data: { target: { id, version }, source_versions: [src], verdict: 'supported', reason: '原文', support_quote: { ...src, quote } } });

async function sample(e) {
  await asHost(e, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await asAgent(e, DS, [
    { kind: 'claim', expected_version: 0, data: { type: 'fact', core: true, text: '没有证据表明 A 导致 B', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } },
    { kind: 'claim', expected_version: 0, data: { type: 'fact', text: '当地人口为 1200 人', sources: [{ id: 'S001', version: 1, quote: '当地人口为 1200 人' }] } },
  ]);
  await asAgent(e, CLAUDE, [verify('C001', 1, { id: 'S001', version: 1 }, '没有证据表明 A 导致 B'), verify('C002', 1, { id: 'S001', version: 1 }, '当地人口为 1200 人')]);
  await asHost(e, [verify('C001', 1, { id: 'S001', version: 1 }, '没有证据表明 A 导致 B')]); // 核心论断要两份独立核验
  await asHost(e, [
    { kind: 'slide', expected_version: 0, data: { title: '证据说了什么', body: '没有证据表明 A 导致 B。（C001）\n- 当地人口约 1200 人 C002', notes: '先讲原文。', order: 1, claims: [{ id: 'C001', version: 1 }, { id: 'C002', version: 1 }] } },
    { kind: 'slide', expected_version: 0, data: { title: '小结', body: '〔非事实〕谢谢大家。', notes: '收尾。', order: 2, claims: [] } },
  ]);
}

// 假渲染器：每页一张假的 PNG（内容各不相同，好分辨是哪一页的截图）
function fakeEngine() {
  let renderSequence = 0;
  return async (engineName, { pptx, outDir }) => {
    renderSequence++;
    const rb = spawnSync(PYTHON, ['-I', path.join(ROOT, 'lib/workbench/export/pptx_export.py'), 'readback', pptx, path.join(outDir, 'pages.json')], { encoding: 'utf8' });
    assert.equal(rb.status, 0, rb.stderr);
    const n = JSON.parse(fs.readFileSync(path.join(outDir, 'pages.json'), 'utf8')).slides.length;
    fs.writeFileSync(path.join(outDir, 'deck.pdf'), '%PDF-fake');
    const slides = Array.from({ length: n }, (_, i) => {
      const png = `p${String(i + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(outDir, png), `PNG-第${i + 1}页-${path.basename(outDir)}-run${renderSequence}`);
      return { index: i + 1, png, shapes: [{ name: 'Title 1', left: 48, top: 30, width: 864, height: 90, text: '标题', boundLeft: 300, boundTop: 50, boundWidth: 360, boundHeight: 40 }] };
    });
    return { engine: 'powerpoint', version: '16.0', slideWidth: 960, slideHeight: 540, fonts: ['Segoe UI', 'Microsoft YaHei'], installed: ['Segoe UI', 'Microsoft YaHei'], pdf: 'deck.pdf', slides };
  };
}

function world(e, { script = {} } = {}) {
  const lookup = Object.assign((id) => PEOPLE.find((p) => p.id === id) ?? null, { all: () => PEOPLE });
  const calls = [];
  const base = tmpBase();
  const runner = createRunner({
    workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, sealed: createSealedStore(), participants: lookup,
    runAgent: async (p, prompt, opts) => {
      // 调用时附图文件必须在：记下名字与内容
      calls.push({ who: p.id, prompt, attachments: (opts.attachments ?? []).map((a) => ({ name: a.name, mediaType: a.mediaType, content: fs.readFileSync(a.path, 'utf8') })) });
      const s = script[p.id];
      const r = await (typeof s === 'function' ? s(prompt, opts) : Array.isArray(s) ? s.shift() : s);
      if (r == null) throw new Error(`${p.id} 没有准备回复`);
      return { raw: r, model: null, exec: { args: [] }, usage: null, audit: null };
    },
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
  });
  const exports = createExports({ workbench: e.workbench, gateway: e.gw, board: e.board, runner, participants: lookup, root: ROOT, renderEngine: fakeEngine() });
  const report = createReport({ workbench: e.workbench, gateway: e.gw, usage: e.usage, exports });
  return { runner, exports, report, calls, workRoot: path.join(base, 'work') };
}

const pass = (pages) => json({ pages: pages.map((page) => ({ page, verdict: 'pass', issues: [] })) });
async function promoteFails(e, changes, actor = HUMAN) {
  const r = e.gw.receive(P, { request_id: rid(), changes }, { actor });
  return e.gw.promote(P, r.sid).then(() => null, (err) => err.details?.reasons ?? err);
}

test('probe: final approval from an older view is silently attached to a new render', async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  const viewed = await w.exports.render(P, 'EX001', '主持人');
  const changed = await w.exports.render(P, 'EX001', '主持人');
  assert.notEqual(viewed.record.version, changed.record.version);
  assert.notEqual(viewed.visual_pages[0].image, changed.visual_pages[0].image);
  // Same payload as the UI when there is no optional model initial review.
  for (const p of viewed.visual_pages) {
    await w.exports.finalReview(P, 'EX001', p.page, { verdict: 'pass', note: `Reviewed old version ${viewed.record.version}` }, HUMAN);
  }
  const result = w.exports.view(P, 'EX001');
  const rc = e.gw.listRecords(P, 'render_check').map(x => x.record);
  assert.equal(result.deliverable, true);
  assert.ok(rc.every(c => c.export.version === changed.record.version));
  assert.equal(rc[0].image, changed.visual_pages[0].image);
  console.log(JSON.stringify({ probe: 'stale-view-approved-new-render', viewedVersion: viewed.record.version, acceptedVersion: changed.record.version, imageChanged: true, deliverable: result.deliverable }));
});

test('probe: external claim of visual task omits image attachments but can promote initial reviews', async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  await w.exports.render(P, 'EX001', '主持人');
  const requestOnly = createExports({
    workbench: e.workbench, gateway: e.gw, board: e.board,
    runner: { dispatch() { throw new Error('Fixture: dispatch unavailable, task remains open'); } },
    participants: id => PEOPLE.find(p => p.id === id),
    root: ROOT,
  });
  const request = requestOnly.requestReview(P, 'EX001', 'looker', HUMAN);
  const claim = w.runner.claimExternal(P, request.tasks[0].id, { kind: 'mcp', participant: 'looker', adapter: 'generic', verified: true });
  const packet = restorePacket(e.workbench.get(P).dir, claim.packet.id);
  assert.deepEqual(packet.attachments, []);
  assert.equal(claim.packet.attachments, undefined);
  const rr = claim.task.render_review;
  const receipt = e.gw.receive(P, {
    request_id: rid(), task_id: claim.task.id, attempt: claim.attempt, lease_token: claim.lease_token,
    changes: rr.pages.map(p => ({
      kind: 'render_check', expected_version: 0,
      data: { export: rr.export, render: rr.render, page: p.page, slide: p.slide, image: p.image, stage: 'initial', verdict: 'pass' },
    })),
  });
  await e.gw.promote(P, receipt.sid);
  assert.equal(w.exports.view(P, 'EX001').visual.initial, 2);
  console.log(JSON.stringify({ probe: 'external-visual-without-images', savedAttachments: packet.attachments, returnedPacketKeys: Object.keys(claim.packet), promotedInitialPages: 2 }));
});

