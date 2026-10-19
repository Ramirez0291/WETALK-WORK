// WP7a：导出与程序检查。幻灯片源的约定与结构检查；Markdown 与 PPTX 导出（导出记录 EX### 经提交入口写入，文件存 blob）；
// 读回核对；渲染检查（单元测试用假的渲染器，真 PowerPoint 的测试要设 WB_REAL_RENDER=1）；Agent 出版式方案、脚本照方案生成；
// 换模板或 skill 不改代码。测试目录的路径含日文字符（helpers 的 tmpBase）。
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
import { workbenchRoutes, FILE_RESPONSE } from '../../lib/workbench/http.mjs';
import { blobStore, blobRefsOf } from '../../lib/workbench/records.mjs';
import { paragraphsOf, sentencesOf, cleanText, charCount, checkStructure, deckSlides } from '../../lib/workbench/export/deck.mjs';
import { renderMarkdown } from '../../lib/workbench/export/markdown.mjs';
import { parsePlan } from '../../lib/workbench/export/plan.mjs';
import { pyExport } from '../../lib/workbench/export/proc.mjs';
import { analyze, renderWith, powerpointAvailable } from '../../lib/workbench/export/render.mjs';
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase, ROOT } from './helpers.mjs';

after(cleanup);
const P = '样本';
const PYTHON = path.resolve(ROOT, DEFAULTS.export.python);
const NO_PY = fs.existsSync(PYTHON) ? false : '没有 .venv（导出用的 Python），跳过 PPTX 部分';
const TEXT = '神话学家指出，没有证据表明 A 导致 B。该书第 3 章记载当地人口为 1200 人。';
const DS = { kind: 'server', participant: 'deepseek', adapter: 'deepseek', model: 'deepseek-flash', verified: true, basis: 'server-invoked' };
const CLAUDE = { kind: 'server', participant: 'claude', adapter: 'claude', model: null, verified: true, basis: 'server-invoked' };
const PEOPLE = [
  { id: 'claude', name: 'Claude', adapter: 'claude', resolved: 'claude' },
  { id: 'codex', name: 'Codex', adapter: 'codex', resolved: 'codex' },
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
async function asAgent(e, holder, changes) {
  const t = e.board.create(P, { type: 'extract_claims' }, { created_by: HUMAN });
  const c = e.board.claim(P, t.id, holder);
  const r = e.gw.receive(P, { request_id: rid(), task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes });
  return e.gw.promote(P, r.sid);
}
const claim = (text, quote = text) => ({ kind: 'claim', expected_version: 0, data: { type: 'fact', text, sources: [{ id: 'S001', version: 1, quote }] } });
const verify = (id) => ({ kind: 'verification', expected_version: 0, data: { target: { id, version: 1 }, source_versions: [{ id: 'S001', version: 1 }], verdict: 'supported', reason: '原文', support_quote: { id: 'S001', version: 1, quote: id === 'C002' ? '当地人口为 1200 人' : '没有证据表明 A 导致 B' } } });

// 样本：S001；C001、C002（DeepSeek 写、Claude 核验 → 可进入成品）、C003（未核验）；SL001、SL002
const BODY1 = '没有证据表明 A 导致 B。（C001）\n- 当地人口约 1200 人 C002\n〔非事实〕下面讲我们的建议。';
async function sample(e) {
  await asHost(e, [{ kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } }]);
  await asAgent(e, DS, [claim('没有证据表明 A 导致 B'), claim('当地人口为 1200 人'), claim('A 导致 B')]);
  await asAgent(e, CLAUDE, [verify('C001'), verify('C002')]);
  await asHost(e, [
    { kind: 'slide', expected_version: 0, data: { title: '证据说了什么', body: BODY1, notes: '先讲原文。', order: 1, claims: [{ id: 'C001', version: 1 }, { id: 'C002', version: 1 }] } },
    { kind: 'slide', expected_version: 0, data: { title: '小结', body: '〔非事实〕谢谢大家。', notes: '收尾。', order: 2, claims: [] } },
  ]);
}

function templatesDir() {
  const dir = path.join(tmpBase(), 'templates');
  fs.mkdirSync(path.join(dir, 'pptx'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'templates', 'pptx', 'default.pptx'), path.join(dir, 'pptx', 'default.pptx'));
  return dir;
}

// 假的渲染器：按页给出形状与排版范围；faults：{ 页: 'overflow' | 'overlap' }，fonts：PowerPoint 报告的字体
function fakeEngine({ pages, faults = {}, fonts = ['Segoe UI', 'Microsoft YaHei'] }) {
  const calls = [];
  const engine = async (engineName, { pptx, outDir }) => {
    calls.push({ engineName, pptx });
    fs.writeFileSync(path.join(outDir, 'deck.pdf'), '%PDF-fake');
    const slides = Array.from({ length: pages }, (_, i) => {
      const n = i + 1;
      fs.writeFileSync(path.join(outDir, `p${String(n).padStart(2, '0')}.png`), 'png');
      const title = { name: 'Title 1', type: 14, left: 48, top: 30, width: 864, height: 90, text: '标题', boundLeft: 300, boundTop: 50, boundWidth: 360, boundHeight: 40 };
      const body = { name: 'Content 2', type: 14, left: 48, top: 126, width: 864, height: 356, text: '正文', boundLeft: 55, boundTop: 130, boundWidth: 500, boundHeight: faults[n] === 'overflow' ? 380 : 120 };
      if (faults[n] === 'overlap') Object.assign(body, { boundTop: 60, top: 40 });
      return { index: n, png: `p${String(n).padStart(2, '0')}.png`, shapes: [title, body] };
    });
    return { engine: 'powerpoint', version: '16.0', slideWidth: 960, slideHeight: 540, fonts, installed: ['Segoe UI', 'Microsoft YaHei', '微软雅黑', 'Calibri'], pdf: 'deck.pdf', slides };
  };
  engine.calls = calls;
  return engine;
}

function world(e, { script = {}, engine = fakeEngine({ pages: 2 }), templates = templatesDir() } = {}) {
  const lookup = Object.assign((id) => PEOPLE.find((p) => p.id === id) ?? null, { all: () => PEOPLE });
  const prompts = [];
  const base = tmpBase();
  const runner = createRunner({
    workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, sealed: createSealedStore(), participants: lookup,
    runAgent: async (p, prompt) => {
      prompts.push({ who: p.id, prompt });
      const s = script[p.id];
      const r = await (typeof s === 'function' ? s(prompt) : Array.isArray(s) ? s.shift() : s);
      if (r == null) throw new Error(`${p.id} 没有准备回复`);
      return { raw: r, model: null, exec: { args: [] }, usage: null, audit: null };
    },
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 10_000,
  });
  const exports = createExports({ workbench: e.workbench, gateway: e.gw, board: e.board, runner, participants: lookup, root: ROOT, templatesDir: templates, renderEngine: engine });
  return { runner, exports, prompts, engine, templates, lookup };
}

// ---------- 幻灯片源 ----------

test('幻灯片源的约定：句子带论断编号或标为非事实；编号与标记不出现在页面上；要点与层级；字数不算编号和标记', () => {
  const ps = paragraphsOf(BODY1);
  assert.deepEqual(ps.map((p) => [p.text, p.level, p.bullet]), [
    ['没有证据表明 A 导致 B。', 0, false], ['当地人口约 1200 人', 0, true], ['下面讲我们的建议。', 0, false],
  ]);
  assert.deepEqual(sentencesOf('甲说了一件事。（C001）乙又说。C002；丙'), ['甲说了一件事。（C001）', '乙又说。C002；', '丙']);
  assert.equal(cleanText('甲（C001、C002）乙 [C003] 丙 C004〔非事实〕'), '甲乙 丙');
  assert.equal(charCount('- 一二三 C001\n  - 四五（C002）'), 5);
  const md = renderMarkdown({
    title: '项目', at: '2026-10-19T00:00:00Z',
    slides: [{ id: 'SL001', version: 1, title: '页', body: BODY1, notes: '备注', claims: [{ id: 'C001', version: 1 }, { id: 'C002', version: 1 }] }],
    claimInfo: (ref) => ({ text: `论断 ${ref.id}`, sources: [{ title: '某书', locator: '第 3 章', quote: '原文' }] }),
  });
  // 普通段落与要点列表之间空一行（相邻的行在 Markdown 里会并成一段）
  assert.match(md, /没有证据表明 A 导致 B。\[\^C001@1\]\n\n- 当地人口约 1200 人\[\^C002@1\]\n\n下面讲我们的建议。\n/);
  assert.doesNotMatch(md, /非事实/);
  assert.match(md, /> 备注/);
  assert.match(md, /\[\^C002@1\]: C002@1 论断 C002 —— 某书，第 3 章：“原文”/);
});

test('结构检查：句子没编号也没标非事实、编号不在 claims 里、论断不能进入成品或不是当前版本、字数超限、备注为空都查得出；正常的页面通过', async () => {
  const e = await env();
  await sample(e);
  await asHost(e, [{ kind: 'slide', expected_version: 0, data: {
    title: '有问题的页', order: 3, notes: '',
    body: `这句话没有编号。\nA 导致 B（C003）\n人口见 C009。\n${'很长'.repeat(60)}C001`,
    claims: [{ id: 'C001', version: 1 }, { id: 'C003', version: 1 }, { id: 'C002', version: 1 }],
  } }]);
  const slides = deckSlides(e.gw, P);
  assert.deepEqual(slides.map((s) => s.id), ['SL001', 'SL002', 'SL003']);
  const r = checkStructure({ gateway: e.gw, project: P, slides, maxChars: 100 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.slides[0].issues, []);
  assert.deepEqual(r.slides[1].issues, []);
  const codes = r.slides[2].issues.map((x) => x.code).sort();
  assert.deepEqual(codes, ['claim_not_ready', 'claim_unbound', 'claim_unused', 'no_notes', 'too_long', 'untagged']);
  assert.match(r.slides[2].issues.find((x) => x.code === 'claim_not_ready').message, /C003 还不能进入成品：核验状态为 unreviewed/);
  assert.equal(r.slides[2].issues.find((x) => x.code === 'claim_unused').level, 'warn');
  // 论断改版：引用旧版本的页面查得出来
  await asAgent(e, DS, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: '没有证据表明 A 导致 B（改）', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } }]);
  const again = checkStructure({ gateway: e.gw, project: P, slides: deckSlides(e.gw, P), maxChars: 100 });
  assert.deepEqual(again.slides[0].issues.map((x) => x.code).sort(), ['claim_outdated', 'slide_stale']);
});

// ---------- 导出 ----------

test('脚本导出 Markdown 与 PPTX：写成正式记录 EX001（文件存 blob、随 git 留档），读回核对页数、标题、正文、备注与标记；只有导出流程能写导出记录；幻灯片改版后导出变成 stale', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  const out = (await w.exports.create(P, { formats: ['md', 'pptx'], via: 'script' }, '主持人')).export;
  assert.equal(out.id, 'EX001');
  assert.deepEqual([out.structure.ok, out.readback.ok, out.render, out.deliverable], [true, true, null, false]); // 还没做渲染检查
  const rec = out.record;
  assert.deepEqual(rec.slides, [{ id: 'SL001', version: 1 }, { id: 'SL002', version: 1 }]);
  assert.equal(rec.template.name, 'default.pptx');
  assert.equal(rec.provenance.participant, 'workbench-export');
  const blobs = blobStore(e.workbench.get(P).dir);
  for (const h of blobRefsOf(rec)) assert.ok(blobs.has(h));
  // 生成的文件和模板随导出记录进 git 留档
  await e.gw.queue.idle();
  for (const h of blobRefsOf(rec)) assert.equal(spawnSync('git', ['-C', e.projectsDir, 'cat-file', '-e', `HEAD:${P}/archive/blobs/${h.slice(0, 2)}/${h}`]).status, 0, h);
  assert.equal(spawnSync('git', ['-C', e.projectsDir, 'cat-file', '-e', `HEAD:${P}/exports/EX001.json`]).status, 0);
  // 文件
  const md = fs.readFileSync(w.exports.file(P, 'EX001', 'deck.md').path, 'utf8');
  assert.match(md, /## 1\. 证据说了什么/);
  assert.match(md, /\[\^C001@1\]: C001@1 没有证据表明 A 导致 B —— 某书：“没有证据表明 A 导致 B”/);
  const pptx = w.exports.file(P, 'EX001', 'deck.pptx');
  assert.equal(pptx.filename, `${P}-EX001.pptx`);
  const rb = await pyExport(PYTHON, 'readback', [pptx.path], path.join(tmpBase(), 'rb.json'));
  assert.deepEqual(rb.slides.map((s) => [s.title, s.layout]), [['证据说了什么', 'Title and Content'], ['小结', 'Title and Content']]);
  assert.equal(rb.slides[0].body, '没有证据表明 A 导致 B。\n当地人口约 1200 人\n下面讲我们的建议。');
  assert.match(rb.slides[0].notes, /^先讲原文。\n\n依据：\nC001：没有证据表明 A 导致 B\nC002：当地人口为 1200 人\n\n〔SL001@1 · 依据 C001@1、C002@1〕$/);
  assert.doesNotMatch(rb.slides.map((s) => s.title + s.body).join(), /C00\d|非事实/);
  // 主持人入口不能写导出记录
  assert.throws(() => e.gw.receive(P, { request_id: rid(), changes: [{ kind: 'export', expected_version: 0, data: Object.fromEntries(['title', 'formats', 'slides', 'via', 'files'].map((k) => [k, rec[k]])) }] }, { actor: HUMAN }), (err) => err.status === 403);
  assert.throws(() => e.board.create(P, { type: 'export' }, { created_by: HUMAN }), (err) => err.status === 400 && /由“导出”页面发起/.test(err.message));
  // 幻灯片改版：导出变成 stale，不能交付，也不能再做渲染检查
  await asHost(e, [{ id: 'SL002', expected_version: 1, data: { title: '小结（改）', body: '〔非事实〕谢谢。', notes: '收尾。', order: 2, claims: [] } }]);
  const stale = w.exports.view(P, 'EX001');
  assert.deepEqual([stale.freshness, stale.deliverable], ['stale', false]);
  await assert.rejects(w.exports.render(P, 'EX001', '主持人'), (err) => err.status === 409 && /先重新导出/.test(err.message));
});

test('渲染检查（假渲染器）：结果写成导出记录的新版本；全部通过才可交付；文字溢出、重叠、本机没有的字体逐页列出', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  let v = await w.exports.render(P, 'EX001', '主持人');
  assert.equal(v.record.version, 2);
  assert.deepEqual([v.render.ok, v.render.errors, v.deliverable], [true, 0, true]);
  assert.deepEqual(v.record.render.pages.map((p) => [p.page, p.slide, p.png]), [[1, 'SL001', 'p01.png'], [2, 'SL002', 'p02.png']]);
  assert.ok(v.files.includes(`${v.record.render.dir}/p02.png`));
  const png = w.exports.file(P, 'EX001', `${v.record.render.dir}/p01.png`);
  assert.deepEqual([png.type, fs.existsSync(png.path)], ['image/png', true]);
  assert.throws(() => w.exports.file(P, 'EX001', '../../workflow.json'), (err) => err.status === 400);
  // 第 1 页溢出、第 2 页重叠，PowerPoint 报告了一种本机没有的字体
  const e2 = await env();
  await sample(e2);
  const w2 = world(e2, { engine: fakeEngine({ pages: 2, faults: { 1: 'overflow', 2: 'overlap' }, fonts: ['Segoe UI', 'NoSuchFont-WB'] }) });
  await w2.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  v = await w2.exports.render(P, 'EX001', '主持人');
  assert.deepEqual([v.render.ok, v.deliverable], [false, false]);
  const r = v.record.render;
  assert.deepEqual(r.pages[0].issues.map((x) => x.code), ['overflow']);
  assert.deepEqual(r.pages[1].issues.map((x) => x.code), ['overlap']);
  assert.deepEqual(r.fonts.missing, ['NoSuchFont-WB']);
  assert.match(r.issues[0].message, /本机没有的字体：NoSuchFont-WB/);
});

test('图片变形与图表：读回的图片宽高比和原图不一致时查得出；有图表的页面提示人工看标签', () => {
  const raw = { engine: 'powerpoint', slideWidth: 960, slideHeight: 540, fonts: [], installed: ['Calibri'], slides: [{ index: 1, png: 'p01.png', shapes: [] }] };
  const readback = { slide_width: 960, slide_height: 540, theme_fonts: ['Calibri'], slides: [{ fonts: ['Calibri'], shapes: [
    { name: 'Picture 3', kind: 'picture', image_ratio: 2, shape_ratio: 1 },
    { name: 'Group 1', kind: 'group', children: [{ name: 'Chart 2', kind: 'chart' }] },
  ] }] };
  const a = analyze({ raw, readback, spec: { slides: [{ id: 'SL001', version: 1 }] } });
  assert.deepEqual(a.pages[0].issues.map((x) => [x.code, x.level]), [['distorted', 'error'], ['chart', 'warn']]);
  // 没有 PowerPoint：只查得了字体、图片和图表，溢出与重叠记为未检查，不给“通过”的结论
  const fontsOnly = analyze({ raw: { engine: 'fonts', installed: ['Calibri'] }, readback: { ...readback, slides: [{ fonts: ['Calibri'], shapes: [] }] }, spec: { slides: [] } });
  assert.deepEqual([fontsOnly.ok, fontsOnly.unchecked], [null, ['overflow', 'overlap']]);
});

test('派给 Agent 导出：Agent 不给工具，只按幻灯片、模板版式清单和 skill 回版式方案；脚本照方案生成并记下方案与任务；方案不合规时这次尝试失败', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const templates = templatesDir();
  fs.writeFileSync(path.join(templates, 'skills', '简洁.md'), '# 版式要求\n有要点的页面用 Two Content。\n');
  const plan = { slides: [{ id: 'SL001', layout: 'Two Content', note: '有要点' }, { id: 'SL002', layout: 'Title and Content' }] };
  const w = world(e, { templates, script: { codex: [json({ slides: [{ id: 'SL001', layout: '不存在的版式' }, { id: 'SL002', layout: 'Title Only' }] }), json(plan)] } });
  const r = await w.exports.create(P, { formats: ['md', 'pptx'], via: 'codex', skill: '简洁.md' }, '主持人');
  await w.runner.idle();
  // 第一次的方案用了模板里没有的版式：这次尝试失败，回到 open
  let t = e.board.get(P, r.task.id);
  assert.equal(t.state, 'open');
  assert.match(t.history.at(-1).reason, /版式方案不能用：SL001 的版式「不存在的版式」不在模板的版式清单里/);
  const prompt = w.prompts[0].prompt;
  assert.match(prompt, /导出版式/);
  assert.match(prompt, /【模板版式清单\.json】[\s\S]*"name": "Two Content"/);
  assert.match(prompt, /【skill-简洁\.md】\n# 版式要求/);
  assert.match(prompt, /【SL001\.v1\.json】/);
  assert.doesNotMatch(prompt, /工作目录/);
  w.runner.dispatch(P, r.task.id, 'codex');
  await w.runner.idle();
  t = e.board.get(P, r.task.id);
  assert.equal(t.state, 'done');
  assert.deepEqual(t.result.plan, plan);
  // 服务里由任务完成的事件触发；这里直接调
  const out = await w.exports.onTaskDone(P, r.task.id);
  assert.deepEqual([out.id, out.via, out.record.plan_task, out.record.plan], ['EX001', 'codex', { task: r.task.id, attempt: 2 }, plan]);
  assert.equal(out.record.skill.name, '简洁.md');
  assert.equal(await w.exports.onTaskDone(P, r.task.id), null, '同一份方案不重复生成');
  const rb = await pyExport(PYTHON, 'readback', [w.exports.file(P, 'EX001', 'deck.pptx').path], path.join(tmpBase(), 'rb.json'));
  assert.deepEqual(rb.slides.map((s) => s.layout), ['Two Content', 'Title and Content']);
  assert.ok(out.readback.ok);
  assert.deepEqual(w.exports.list(P).tasks, []);
});

test('换模板或 skill 不改代码：模板与 skill 按文件名从 templates/ 取，内容 hash 写进导出记录；文件名之外的写法一律拒绝', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const templates = templatesDir();
  // 另一份模板：python-pptx 自带的 4:3 模板
  const alt = path.join(templates, 'pptx', '四比三.pptx');
  const made = spawnSync(PYTHON, ['-I', '-c', 'import sys\nfrom pptx import Presentation\nPresentation().save(sys.argv[1])', alt], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const w = world(e, { templates });
  assert.deepEqual(w.exports.list(P).templates, { pptx: ['default.pptx', '四比三.pptx'], skills: [] });
  const a = (await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人')).export;
  const b = (await w.exports.create(P, { formats: ['pptx'], via: 'script', template: '四比三.pptx' }, '主持人')).export;
  assert.notEqual(a.record.template.blob, b.record.template.blob);
  const size = async (id) => (await pyExport(PYTHON, 'readback', [w.exports.file(P, id, 'deck.pptx').path], path.join(tmpBase(), 'rb.json'))).slide_width;
  assert.deepEqual([await size('EX001'), await size('EX002')], [960, 720]);
  for (const template of ['../default.pptx', 'C:\\x.pptx', 'nope.pptx', 'default.md']) {
    await assert.rejects(w.exports.create(P, { formats: ['pptx'], via: 'script', template }, '主持人'), (err) => [400, 404].includes(err.status), template);
  }
  await assert.rejects(w.exports.create(P, { formats: ['md'], via: 'codex' }, '主持人'), (err) => err.status === 400 && /formats 要包含 pptx/.test(err.message));
});

test('接口：导出、渲染检查只限主持人；文件按附件返回', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  const routes = workbenchRoutes({ workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, runner: w.runner, exports: w.exports, hostToken: 'tok', humanName: '主持人', readJson: async (req) => req.body });
  const call = (method, url, body, host = true) => {
    const route = routes.find(([m, re]) => m === method && re.test(url));
    return route[2]({ headers: host ? { 'x-workbench-host': 'tok' } : {}, body }, url.match(route[1]));
  };
  const base = `/api/projects/${encodeURIComponent(P)}`;
  await assert.rejects(async () => call('POST', `${base}/export`, { via: 'script' }, false), (err) => err.status === 403);
  const out = (await call('POST', `${base}/export`, { formats: ['md'], via: 'script' })).export;
  assert.equal(out.id, 'EX001');
  await assert.rejects(async () => call('POST', `${base}/exports/EX001/render`, {}, false), (err) => err.status === 403);
  assert.equal((await call('GET', `${base}/exports`)).exports[0].id, 'EX001');
  const f = await call('GET', `${base}/exports/EX001/files/deck.md`);
  assert.equal(f[FILE_RESPONSE], true);
  assert.equal(f.filename, `${P}-EX001.md`);
});

// ---------- 真 PowerPoint（WB_REAL_RENDER=1 时才跑：会在后台启动 PowerPoint） ----------

const REAL = process.env.WB_REAL_RENDER === '1' && !NO_PY && powerpointAvailable() ? false : '设 WB_REAL_RENDER=1 才跑（需要本机 PowerPoint）';
test('真渲染：故意做出文字溢出、缺字体和图片变形的 PPTX，渲染检查都查得出来；正常导出的样本通过', { skip: REAL, timeout: 300_000 }, async () => {
  const dir = tmpBase();
  const bad = path.join(dir, '坏样例.pptx');
  const script = [
    'import sys', 'from pptx import Presentation', 'from pptx.util import Inches, Pt', 'from PIL import Image',
    'prs = Presentation(); prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)',
    's = prs.slides.add_slide(prs.slide_layouts[6])',
    'tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1)); tb.text_frame.word_wrap = True; tb.text_frame.text = "很长的一段字，" * 40',
    'r = tb.text_frame.paragraphs[0].runs[0]; r.font.size = Pt(24); r.font.name = "NoSuchFont-WB"',
    'img = sys.argv[1] + ".png"; Image.new("RGB", (400, 200), (200, 80, 80)).save(img)',
    's.shapes.add_picture(img, Inches(8), Inches(4), Inches(2), Inches(2))',
    // 第 2 页（Astra 的复现）：右对齐、不换行、关自动调整的 100×100pt 文本框，文字向左越出、右端仍在框内
    'from pptx.enum.text import PP_ALIGN, MSO_AUTO_SIZE',
    's2 = prs.slides.add_slide(prs.slide_layouts[6]); sh = s2.shapes.add_textbox(Pt(300), Pt(200), Pt(100), Pt(100))',
    'tf = sh.text_frame; tf.word_wrap = False; tf.auto_size = MSO_AUTO_SIZE.NONE',
    'tf.margin_left = tf.margin_top = tf.margin_bottom = 0; tf.margin_right = Pt(12)',
    'p = tf.paragraphs[0]; p.alignment = PP_ALIGN.RIGHT; p.text = "AAAAAAAAAAAAAAAA"; p.runs[0].font.size = Pt(20); p.runs[0].font.name = "Segoe UI"',
    'prs.save(sys.argv[1])',
  ].join('\n');
  const made = spawnSync(PYTHON, ['-I', '-c', script, bad], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const raw = await renderWith('auto', { pptx: bad, outDir: path.join(dir, 'out'), resultFile: path.join(dir, 'render.json') });
  const rb = await pyExport(PYTHON, 'readback', [bad], path.join(dir, 'rb.json'));
  const a = analyze({ raw, readback: rb, spec: { slides: [] } });
  assert.equal(a.engine, 'powerpoint');
  assert.ok(fs.existsSync(path.join(dir, 'out', 'deck.pdf')) && fs.existsSync(path.join(dir, 'out', 'p01.png')));
  assert.deepEqual(a.pages[0].issues.map((x) => x.code).sort(), ['distorted', 'font_missing', 'off_slide', 'overflow']);
  assert.deepEqual(a.fonts.missing, ['NoSuchFont-WB']);
  // 只向左越出、仍在页面内：只有 overflow，方向是左
  assert.deepEqual(a.pages[1].issues.map((x) => [x.code, x.sides]), [['overflow', ['左']]]);
  // 正常导出的样本：渲染检查通过
  const e = await env();
  await sample(e);
  const w = world(e, { engine: renderWith });
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  const v = await w.exports.render(P, 'EX001', '主持人');
  assert.deepEqual([v.render.engine, v.render.ok, v.render.errors], ['powerpoint', true, 0]);
});

// ---------- WP7a 评审（Astra，R1–R4）----------

const CODEX = { kind: 'server', participant: 'codex', adapter: 'codex', model: null, verified: true, basis: 'server-invoked' };
const OBJECTION = { target: { id: 'C001', version: 1 }, category: 'number_error', pointer: { type: 'quote', source: { id: 'S001', version: 1 }, quote: '没有证据表明 A 导致 B' }, reason: '这个说法要再核', state: 'open' };
const liveMessages = (v) => v.live_structure.slides.flatMap((s) => s.issues.map((i) => i.message)).join('\n');

test('评审 R1：可交付按此刻的状态算——新增阻塞异议、新的不一致核验都不改版本，也会让已有导出不可交付；异议撤回后恢复', async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  const ex = (await w.exports.create(P, { formats: ['md'], via: 'script' }, '主持人')).export;
  assert.deepEqual([ex.deliverable, ex.live.ok], [true, true]);
  // 新增阻塞异议：论断、页面、导出的版本都没变
  await asHost(e, [{ kind: 'objection', expected_version: 0, data: OBJECTION }]);
  let v = w.exports.view(P, 'EX001');
  assert.deepEqual([v.freshness, v.record.version, v.deliverable, v.live.ok], ['current', 1, false, false]);
  assert.match(liveMessages(v), /C001 还不能进入成品：有阻塞异议 O001/);
  assert.equal(v.record.structure.ok, true, '导出时存下的检查结果不变，只是不再代表现在');
  assert.deepEqual(w.exports.list(P).exports.map((x) => [x.id, x.deliverable, x.live.ok]), [['EX001', false, false]]);
  // 提出者撤回：恢复可交付
  await asHost(e, [{ id: 'O001', expected_version: 1, data: { ...OBJECTION, state: 'withdrawn' } }]);
  assert.equal(w.exports.view(P, 'EX001').deliverable, true);
  // 另一位核验者（与作者不同厂商）判 unsupported：C002 变成核验结论不一致
  await asAgent(e, CODEX, [{ kind: 'verification', expected_version: 0, data: { target: { id: 'C002', version: 1 }, source_versions: [{ id: 'S001', version: 1 }], verdict: 'unsupported', reason: '原文说的是记载，不是现状' } }]);
  v = w.exports.view(P, 'EX001');
  assert.deepEqual([v.deliverable, v.live.ok], [false, false]);
  assert.match(liveMessages(v), /C002 还不能进入成品：核验状态为 disputed/);
});

test('评审 R2：英文句号也断句，每句分别要编号或非事实标记；句后编号前有空格也归前一句；小数、缩写不误断', async () => {
  const e = await env();
  await sample(e);
  const slide = e.gw.getRecord(P, 'SL001').record;
  const untagged = (body) => checkStructure({ gateway: e.gw, project: P, slides: [{ ...slide, body }], maxChars: 1000 }).slides[0].issues.filter((i) => i.code === 'untagged').map((i) => i.sentence);
  // Astra 的两种绕过：后一句的编号或标记不再替前一句担保
  assert.deepEqual(untagged('An unsupported factual sentence. Population is 1200 C001.'), ['An unsupported factual sentence.']);
  assert.deepEqual(untagged('An unsupported factual sentence. 〔非事实〕Welcome.'), ['An unsupported factual sentence.']);
  // 句末标点后有空格、再跟编号：仍归前一句（修正前正则里的 \s 写成了 s）
  assert.deepEqual(untagged('人口是1200。 （C001）〔非事实〕谢谢。'), []);
  assert.deepEqual(untagged('Growth was 1.5 times, e.g. apples (C001). Dr. Smith agrees C002. Thanks〔非事实〕.'), []);
  assert.deepEqual(untagged('Fact one C001! Is it true? 〔非事实〕Yes; really C002.'), ['Is it true?']);
  assert.deepEqual(sentencesOf('He said “yes.” Then left C001.'), ['He said “yes.”', ' Then left C001.']);
});

test('评审 R3：导出的依据按引用的版本取——论断和来源改版后，旧引用的脚注与讲者备注仍是旧版本的正文与标题；还原不出的版本拒绝导出', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  await asAgent(e, DS, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'NEW-CLAIM 改过的说法', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } }]);
  await asHost(e, [{ id: 'S001', expected_version: 1, data: { title: 'NEW-TITLE 新书名', url: 'https://example.org/book', text: TEXT } }]);
  const out = (await w.exports.create(P, { formats: ['md', 'pptx'], via: 'script' }, '主持人')).export;
  assert.equal(out.structure.ok, false); // 页面引用的是旧版本：结构检查不过，但文件里的依据必须是旧版本
  const md = fs.readFileSync(w.exports.file(P, out.id, 'deck.md').path, 'utf8');
  assert.match(md, /\[\^C001@1\]: C001@1 没有证据表明 A 导致 B —— 某书：“没有证据表明 A 导致 B”/);
  assert.doesNotMatch(md, /NEW-CLAIM|NEW-TITLE/);
  const rb = await pyExport(PYTHON, 'readback', [w.exports.file(P, out.id, 'deck.pptx').path], path.join(tmpBase(), 'rb.json'));
  assert.match(rb.slides[0].notes, /C001：没有证据表明 A 导致 B\n/);
  assert.doesNotMatch(rb.slides[0].notes, /NEW-CLAIM/);
  // 旧版本的归档副本不在了：还原不出，拒绝导出，不拿新版本顶替
  fs.rmSync(path.join(e.workbench.get(P).dir, 'archive', 'versions', 'claims', 'C001.v1.json'));
  await assert.rejects(w.exports.create(P, { formats: ['md'], via: 'script' }, '主持人'), (err) => err.status === 409 && /还原不出 C001@1/.test(err.message));
});

test('评审 R4：溢出四个方向都查——文字向左、向上越出文本框也算（仍在页面内）；正好在 2pt 容差内的不算', () => {
  const issues = (shape) => analyze({
    raw: { engine: 'powerpoint', installed: [], slideWidth: 960, slideHeight: 540, slides: [{ png: 'p01.png', shapes: [shape] }] },
    readback: { theme_fonts: [], slides: [{ fonts: [], shapes: [] }] }, spec: { slides: [{ id: 'SL001', version: 1 }] },
  }).pages[0].issues;
  const box = { name: 'T', text: '字', left: 200, top: 200, width: 100, height: 100 };
  assert.deepEqual(issues({ ...box, boundLeft: 160, boundTop: 160, boundWidth: 140, boundHeight: 140 }).map((i) => [i.code, i.sides]), [['overflow', ['左', '上']]]);
  // 右对齐不换行（Astra 实测的数值）：只向左越出 118pt
  assert.deepEqual(issues({ ...box, left: 300, boundLeft: 182, boundTop: 200, boundWidth: 211.5, boundHeight: 24 }).map((i) => i.sides), [['左']]);
  assert.deepEqual(issues({ ...box, boundLeft: 210, boundTop: 150, boundWidth: 50, boundHeight: 60 }).map((i) => i.sides), [['上']]);
  assert.deepEqual(issues({ ...box, boundLeft: 198, boundTop: 198, boundWidth: 104, boundHeight: 104 }), []); // 每边正好 2pt
});
