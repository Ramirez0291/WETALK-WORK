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
import { setup, restart, rid, DEFAULTS, HUMAN, cleanup, tmpBase, ROOT } from './helpers.mjs';

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
  return async (engineName, { pptx, outDir }) => {
    const rb = spawnSync(PYTHON, ['-I', path.join(ROOT, 'lib/workbench/export/pptx_export.py'), 'readback', pptx, path.join(outDir, 'pages.json')], { encoding: 'utf8' });
    assert.equal(rb.status, 0, rb.stderr);
    const n = JSON.parse(fs.readFileSync(path.join(outDir, 'pages.json'), 'utf8')).slides.length;
    fs.writeFileSync(path.join(outDir, 'deck.pdf'), '%PDF-fake');
    const slides = Array.from({ length: n }, (_, i) => {
      const png = `p${String(i + 1).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(outDir, png), `PNG-第${i + 1}页-${path.basename(outDir)}`);
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
// 你看到的那一版导出、那次渲染、那一页的截图（终审请求要带上）
const seenOf = (v, page) => ({ version: v.record.version, render: v.record.render.dir, image: v.visual_pages[page - 1].image });
const approve = async (w, id, page, body = {}) => w.exports.finalReview(P, id, page, { verdict: 'pass', ...seenOf(w.exports.view(P, id), page), ...body }, HUMAN);
async function promoteFails(e, changes, actor = HUMAN) {
  const r = e.gw.receive(P, { request_id: rid(), changes }, { actor });
  return e.gw.promote(P, r.sid).then(() => null, (err) => err.details?.reasons ?? err);
}

// ---------- 逐页的视觉检查 ----------

test('视觉检查：派能看图的参与者初查（截图按页附上、内容随任务包记下），每页一条初查记录；主持人逐页终审，全部通过才可交付；只增不改、身份与页面对不上的一律拒绝', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e, {
    script: {
      looker: [
        json({ pages: [{ page: 1, verdict: 'pass', issues: [] }] }), // 少了第 2 页：这次尝试失败
        json({ pages: [{ page: 1, verdict: 'pass', issues: [] }, { page: 2, verdict: 'fail', issues: [{ kind: 'overflow', note: '最后一行被截断' }] }] }),
      ],
    },
  });
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  let v = await w.exports.render(P, 'EX001', '主持人');
  assert.deepEqual([v.render.ok, v.deliverable, v.visual], [true, false, { total: 2, initial: 0, reviewed: 0, passed: 0, ok: false }]);
  const images = v.record.render.pages.map((p) => p.image);
  assert.ok(images.every(Boolean));
  // 不能看图的参与者：拒绝
  assert.throws(() => w.exports.requestReview(P, 'EX001', 'codex', HUMAN), (err) => err.status === 409 && /不能看图/.test(err.message));
  assert.throws(() => e.board.create(P, { type: 'render_review' }, { created_by: HUMAN }), (err) => err.status === 400);
  // 派 looker：第一次回复少了一页，尝试失败；再派一次
  const r1 = w.exports.requestReview(P, 'EX001', 'looker', HUMAN);
  assert.deepEqual(r1.tasks.map((t) => t.pages), [[1, 2]]);
  await w.runner.idle();
  const task = e.board.get(P, r1.tasks[0].id);
  assert.equal(task.state, 'open');
  assert.match(task.history.at(-1).reason, /要看的是第 1、2 页，每页正好一次/);
  w.runner.dispatch(P, task.id, 'looker');
  await w.runner.idle();
  assert.equal(e.board.get(P, task.id).state, 'done');
  // 截图按页码顺序附上，调用时文件就在；提示词里有页面文字与程序检查的结果，没有工作目录
  const call = w.calls.at(-1);
  assert.deepEqual(call.attachments.map((a) => [a.name, a.mediaType]), [['第 1 页', 'image/png'], ['第 2 页', 'image/png']]);
  assert.match(call.attachments[1].content, /^PNG-第2页-render-\d{14}$/);
  assert.match(call.prompt, /视觉检查/);
  assert.match(call.prompt, /## 第 1 页：证据说了什么[\s\S]*没有证据表明 A 导致 B。[\s\S]*程序检查发现的问题：\n- 无/);
  assert.doesNotMatch(call.prompt, /C001|工作目录/);
  assert.deepEqual(fs.readdirSync(w.workRoot).filter((n) => n.includes('images')), [], '临时图片目录用完就删');
  assert.deepEqual(restorePacket(e.workbench.get(P).dir, `${task.id}-a2`).attachments, [{ name: '第 1 页', blob: images[0] }, { name: '第 2 页', blob: images[1] }]);
  // 两条初查记录：针对 EX001@2、这次渲染、每页的截图；检查者是 looker
  const rc = ['RC001', 'RC002'].map((id) => e.gw.getRecord(P, id).record);
  assert.deepEqual(rc.map((x) => [x.page, x.stage, x.verdict, x.export, x.image, x.reviewer.participant]), [
    [1, 'initial', 'pass', { id: 'EX001', version: 2 }, images[0], 'looker'],
    [2, 'initial', 'fail', { id: 'EX001', version: 2 }, images[1], 'looker'],
  ]);
  v = w.exports.view(P, 'EX001');
  assert.deepEqual([v.visual.initial, v.visual.reviewed, v.deliverable], [2, 0, false]);
  assert.deepEqual(v.visual_pages[1].initial.issues, [{ kind: 'overflow', note: '最后一行被截断' }]);
  // 主持人终审：第 1 页通过；第 2 页先判不通过，再改判通过（另写一条，取最新的）
  v = await approve(w, 'EX001', 1, { reviews: 'RC001' });
  v = await approve(w, 'EX001', 2, { verdict: 'fail', issues: [{ kind: 'overflow', note: '确实截断了' }], reviews: 'RC002' });
  assert.deepEqual([v.visual.reviewed, v.visual.passed, v.deliverable], [2, 1, false]);
  v = await approve(w, 'EX001', 2, { note: '放大看是行距，不是截断' }); // 对同一张截图改判
  assert.deepEqual([v.visual.passed, v.visual.ok, v.deliverable], [2, true, true]);
  assert.equal(v.visual_pages[1].final.note, '放大看是行距，不是截断');
  // 截图随记录进 git 留档
  await e.gw.queue.idle();
  for (const h of images) assert.equal(spawnSync('git', ['-C', e.projectsDir, 'cat-file', '-e', `HEAD:${P}/archive/blobs/${h.slice(0, 2)}/${h}`]).status, 0);
  // 规则：只增不改；主持人不能写初查；页面、截图、渲染对不上的拒绝；reviews 要指向同一页的初查
  const base = { export: { id: 'EX001', version: 2 }, render: v.record.render.dir, page: 1, slide: { id: 'SL001', version: 1 }, image: images[0], stage: 'final', verdict: 'pass' };
  const reason = async (data, extra = {}) => {
    const out = await promoteFails(e, [{ kind: 'render_check', expected_version: 0, data: { ...base, ...data }, ...extra }]);
    return out?.map?.((x) => x.note).join('；') ?? String(out?.message ?? out);
  };
  assert.match(await reason({ stage: 'initial' }), /初查由模型经任务提交/);
  assert.match(await reason({ image: images[1] }), /image 不是第 1 页的截图/);
  assert.match(await reason({ page: 3 }), /没有第 3 页/);
  assert.match(await reason({ render: 'render-20000101000000' }), /不是 render-20000101000000/);
  assert.match(await reason({ reviews: 'RC002' }), /不是这一页（同一版导出）的初查/);
  assert.match(String((await promoteFails(e, [{ id: 'RC001', expected_version: 1, data: base }]))?.map?.((x) => x.note).join() ?? ''), /写入后不能修改/);
  // 重新渲染：导出升版，旧的检查不再算数
  v = await w.exports.render(P, 'EX001', '主持人');
  assert.deepEqual([v.record.version, v.visual.reviewed, v.deliverable], [3, 0, false]);
});

test('视觉检查分批：每次调用最多看 8 页，超过就分成几个任务', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  await asHost(e, Array.from({ length: 7 }, (_, i) => ({ kind: 'slide', expected_version: 0, data: { title: `第 ${i + 3} 页`, body: '〔非事实〕补充。', notes: '备注。', order: i + 3, claims: [] } })));
  const w = world(e, { script: { looker: (prompt, opts) => pass(opts.attachments.map((a) => Number(a.name.match(/\d+/)[0]))) } });
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  await w.exports.render(P, 'EX001', '主持人');
  const r = w.exports.requestReview(P, 'EX001', 'looker', HUMAN);
  assert.deepEqual(r.tasks.map((t) => t.pages.length), [8, 1]);
  await w.runner.idle();
  assert.deepEqual(w.calls.map((c) => c.attachments.length), [8, 1]);
  assert.equal(w.exports.view(P, 'EX001').visual.initial, 9);
});

// ---------- 试运行报告 ----------

test('试运行报告：与 baseline.md 逐项对比；可追溯比例按成品引用的核心论断算；你填的修改时间与抽查错误；总用时到最后一页终审；花费取用量账本；可以下载 Markdown', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const dir = e.workbench.get(P).dir;
  fs.writeFileSync(path.join(dir, 'baseline.md'), fs.readFileSync(path.join(dir, 'baseline.md'), 'utf8')
    .replace('| 总用时 |  |', '| 总用时 | 11m48s |').replace('| 核心论断可追溯到有效证据的比例 |  |', '| 核心论断可追溯到有效证据的比例 | 1/4 |'));
  const w = world(e, { script: { looker: pass([1, 2]) } });
  let rep = w.report.build(P);
  assert.equal(rep.export, null);
  assert.match(rep.notes.join(), /还没有导出/);
  await w.exports.create(P, { formats: ['md', 'pptx'], via: 'script' }, '主持人');
  await w.exports.render(P, 'EX001', '主持人');
  w.exports.requestReview(P, 'EX001', 'looker', HUMAN);
  await w.runner.idle();
  for (const page of [1, 2]) await approve(w, 'EX001', page);
  // 你填的数值；只限主持人写
  assert.throws(() => w.report.setManual(P, { revision_minutes: -1 }, '主持人'), (err) => err.status === 400);
  rep = w.report.setManual(P, { revision_minutes: 25, errors_found: 1, error_list: '第 1 页“约 1200 人”与原文措辞不同', note: '试运行第一轮' }, '主持人');
  const row = Object.fromEntries(rep.rows.map((x) => [x.key, x]));
  assert.deepEqual([rep.export.id, rep.export.deliverable, rep.export.visual.passed], ['EX001', true, 2]);
  // 可追溯：核心论断只有 C001（core: true），可进入成品、引文在快照里找得到
  assert.deepEqual([row.traceable.baseline, row.traceable.multi, row.traceable.note], ['1/4', '1 / 1（100%）', '核心论断（core: true）']);
  assert.deepEqual(rep.trace, [{ id: 'C001', version: 1, ok: true }]);
  assert.deepEqual([row.errors.multi, row.revision.multi, row.total_time.baseline], ['1', '25 分钟', '11m48s']);
  assert.match(row.errors.note, /成立的阻塞异议 0 条，核验判为不支持 0 次/);
  assert.match(row.total_time.multi, /秒|分钟/);
  assert.match(row.cost.multi, /^调用 \d+ 次，API 费用 \$0\.0000$/);
  assert.match(row.cost.note, /looker（命令行） 1 次/);
  // Markdown
  const f = w.report.markdownFile(P);
  const md = fs.readFileSync(f.path, 'utf8');
  assert.equal(f.filename, `${P}-试运行报告.md`);
  assert.match(md, /\| 核心论断可追溯到有效证据的比例 \| 1\/4 \| 1 \/ 1（100%） \| 核心论断（core: true） \|/);
  assert.match(md, /逐页视觉检查：模型初查 2\/2 页，你终审 2\/2 页，通过 2 页/);
  assert.match(md, /## 抽查发现的实质错误\n\n第 1 页“约 1200 人”与原文措辞不同/);
  // 之后新增阻塞异议：成品不可交付，报告注明
  await asHost(e, [{ kind: 'objection', expected_version: 0, data: { target: { id: 'C001', version: 1 }, category: 'number_error', pointer: { type: 'quote', source: { id: 'S001', version: 1 }, quote: '没有证据表明 A 导致 B' }, reason: '再核', state: 'open' } }]);
  rep = w.report.build(P);
  assert.deepEqual([rep.export.deliverable, rep.rows.find((x) => x.key === 'traceable').multi], [false, '0 / 1（0%）']);
  assert.match(rep.notes.join(), /EX001 还不可交付/);
  assert.deepEqual(Object.keys(parseBaseline('## 指标\n\n| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n| 总用时 | 3h | x |\n')), ['总用时']);
});

test('接口：派视觉检查、终审、填报告只限主持人；报告可以下载', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e, { script: { looker: pass([1, 2]) } });
  const routes = workbenchRoutes({ workbench: e.workbench, gateway: e.gw, board: e.board, usage: e.usage, runner: w.runner, exports: w.exports, report: w.report, hostToken: 'tok', humanName: '主持人', readJson: async (req) => req.body });
  const call = (method, url, body, host = true) => {
    const route = routes.find(([m, re]) => m === method && re.test(url));
    return route[2]({ headers: host ? { 'x-workbench-host': 'tok' } : {}, body }, url.match(route[1]));
  };
  const base = `/api/projects/${encodeURIComponent(P)}`;
  await call('POST', `${base}/export`, { formats: ['pptx'], via: 'script' });
  await call('POST', `${base}/exports/EX001/render`, {});
  for (const [url, body] of [[`${base}/exports/EX001/review-request`, { participant: 'looker' }], [`${base}/exports/EX001/pages/1/review`, { verdict: 'pass', ...seenOf(w.exports.view(P, 'EX001'), 1) }], [`${base}/report/manual`, { revision_minutes: 3 }]]) {
    await assert.rejects(async () => call('POST', url, body, false), (err) => err.status === 403, url);
  }
  assert.deepEqual((await call('POST', `${base}/exports/EX001/review-request`, { participant: 'looker' })).tasks.map((t) => t.pages), [[1, 2]]);
  await w.runner.idle();
  const v = await call('POST', `${base}/exports/EX001/pages/1/review`, { verdict: 'pass', ...seenOf(w.exports.view(P, 'EX001'), 1) });
  assert.equal(v.visual.reviewed, 1);
  assert.equal((await call('GET', `${base}/report`)).export.id, 'EX001');
  assert.equal((await call('POST', `${base}/report/manual`, { revision_minutes: 3 })).manual.revision_minutes, 3);
  const f = await call('GET', `${base}/report.md`);
  assert.equal(f[FILE_RESPONSE], true);
});

// ---------- 集成测试：整套流程 ----------

test('集成：2 份来源、3 条论断、2 页幻灯片走完整流程——提交、核验、追溯、更正来源、重新核验、导出、渲染检查、视觉检查、终审、报告（路径含日文字符）', { skip: NO_PY }, async () => {
  const e = await env();
  assert.match(e.projectsDir, /テスト/);
  const w = world(e, { script: { looker: pass([1, 2]) } });
  // 提交：两份来源（主持人录入正文）、三条论断（DeepSeek 抽取）、两页幻灯片
  await asHost(e, [
    { kind: 'source', expected_version: 0, data: { title: '某书', url: 'https://example.org/book', text: TEXT } },
    { kind: 'source', expected_version: 0, data: { title: '县志', url: 'https://example.org/county', text: TEXT2 } },
  ]);
  await asAgent(e, DS, [
    { kind: 'claim', expected_version: 0, data: { type: 'fact', core: true, text: '没有证据表明 A 导致 B', sources: [{ id: 'S001', version: 1, quote: '没有证据表明 A 导致 B' }] } },
    { kind: 'claim', expected_version: 0, data: { type: 'fact', core: true, text: '当地人口在 1950 年为 1200 人', sources: [{ id: 'S002', version: 1, quote: '当地人口在 1950 年为 1200 人' }] } },
    { kind: 'claim', expected_version: 0, data: { type: 'fact', text: '人口此后逐年减少', sources: [{ id: 'S002', version: 1, quote: '此后逐年减少' }] } },
  ]);
  // 核验：Claude（与作者不同厂商）逐条支持
  await asAgent(e, CLAUDE, [
    verify('C001', 1, { id: 'S001', version: 1 }, '没有证据表明 A 导致 B'),
    verify('C002', 1, { id: 'S002', version: 1 }, '当地人口在 1950 年为 1200 人'),
    verify('C003', 1, { id: 'S002', version: 1 }, '此后逐年减少'),
  ]);
  // 核心论断（C001、C002）要两份独立核验：主持人再核一份
  await asHost(e, [verify('C001', 1, { id: 'S001', version: 1 }, '没有证据表明 A 导致 B'), verify('C002', 1, { id: 'S002', version: 1 }, '当地人口在 1950 年为 1200 人')]);
  const slides = (c2, c3) => [
    { kind: 'slide', expected_version: 0, data: { title: '证据说了什么', body: '没有证据表明 A 导致 B。（C001）', notes: '先讲原文。', order: 1, claims: [{ id: 'C001', version: 1 }] } },
    { kind: 'slide', expected_version: 0, data: { title: '人口', body: `1950 年当地有 1200 人（C002），此后逐年减少 C003。`, notes: '数字来自县志。', order: 2, claims: [c2, c3] } },
  ];
  await asHost(e, slides({ id: 'C002', version: 1 }, { id: 'C003', version: 1 }));
  // 追溯：从第 2 页到县志的原文位置
  let t = e.gw.trace(P, 'SL002');
  assert.deepEqual(t.root.claims.map((c) => [c.id, c.sources[0].id, c.sources[0].quote_found]), [['C002', 'S002', true], ['C003', 'S002', true]]);
  assert.equal(t.root.claims[0].sources[0].context.quote, '当地人口在 1950 年为 1200 人');
  // 更正来源：县志的正文快照更正（v2）→ 下游论断与页面变成待更新，成品不能导出为可交付
  await asHost(e, [{ id: 'S002', expected_version: 1, data: { title: '县志（更正版）', url: 'https://example.org/county', text: `${TEXT2}（据 1952 年复查更正）` } }]);
  assert.equal(e.gw.getRecord(P, 'C002').status.freshness, 'stale');
  assert.equal(e.gw.getRecord(P, 'SL002').status.freshness, 'stale');
  const stale = (await w.exports.create(P, { formats: ['md'], via: 'script' }, '主持人')).export;
  assert.deepEqual([stale.structure.ok, stale.deliverable], [false, false]);
  // 重新核验：论断改为引用更正后的来源（升版，旧核验不再计入），再由 Claude 核验；页面改引新版本
  await asAgent(e, DS, [
    { id: 'C002', expected_version: 1, data: { type: 'fact', core: true, text: '当地人口在 1950 年为 1200 人', sources: [{ id: 'S002', version: 2, quote: '当地人口在 1950 年为 1200 人' }] } },
    { id: 'C003', expected_version: 1, data: { type: 'fact', text: '人口此后逐年减少', sources: [{ id: 'S002', version: 2, quote: '此后逐年减少' }] } },
  ]);
  assert.equal(e.gw.getRecord(P, 'C002').status.verification.state, 'unreviewed');
  await asAgent(e, CLAUDE, [verify('C002', 2, { id: 'S002', version: 2 }, '当地人口在 1950 年为 1200 人'), verify('C003', 2, { id: 'S002', version: 2 }, '此后逐年减少')]);
  await asHost(e, [verify('C002', 2, { id: 'S002', version: 2 }, '当地人口在 1950 年为 1200 人')]);
  await asHost(e, [{ id: 'SL002', expected_version: 1, data: slides({ id: 'C002', version: 2 }, { id: 'C003', version: 2 })[1].data }]);
  assert.equal(e.gw.getRecord(P, 'SL002').status.ready, true);
  // 导出、渲染检查、视觉检查（模型初查）、终审
  const ex = (await w.exports.create(P, { formats: ['md', 'pptx'], via: 'script' }, '主持人')).export;
  assert.deepEqual([ex.id, ex.structure.ok, ex.readback.ok], ['EX002', true, true]);
  let v = await w.exports.render(P, ex.id, '主持人');
  assert.equal(v.render.ok, true);
  w.exports.requestReview(P, ex.id, 'looker', HUMAN);
  await w.runner.idle();
  v = w.exports.view(P, ex.id);
  for (const page of [1, 2]) await approve(w, ex.id, page, { reviews: v.visual_pages[page - 1].initial?.id ?? undefined });
  v = w.exports.view(P, ex.id);
  assert.deepEqual([v.visual.initial, v.visual.passed, v.deliverable], [2, 2, true]);
  const md = fs.readFileSync(w.exports.file(P, ex.id, 'deck.md').path, 'utf8');
  assert.match(md, /\[\^C002@2\]: C002@2 当地人口在 1950 年为 1200 人 —— 县志（更正版）：“当地人口在 1950 年为 1200 人”/);
  // 报告：两条核心论断都可追溯
  const rep = w.report.build(P);
  assert.deepEqual([rep.export.id, rep.rows.find((x) => x.key === 'traceable').multi], [ex.id, '2 / 2（100%）']);
  t = e.gw.trace(P, 'SL002');
  assert.deepEqual(t.root.claims.map((c) => [c.id, c.version, c.sources[0].version, c.sources[0].quote_found]), [['C002', 2, 2, true], ['C003', 2, 2, true]]);
});

// ---------- WP7b 评审（Astra，R1–R2）----------

test('评审 R1：终审要带上看到的导出版本、渲染与截图；期间重新渲染过就拒绝（不自动记到新版本上），刷新后对新截图终审照常；晋升时再核一次', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e, { script: { looker: pass([1, 2]) } });
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  const old = await w.exports.render(P, 'EX001', '主持人'); // 旧标签页看到的是 v2
  w.exports.requestReview(P, 'EX001', 'looker', HUMAN);
  await w.runner.idle();
  const oldSeen = (page) => seenOf(w.exports.view(P, 'EX001'), page);
  const seenV2 = [oldSeen(1), oldSeen(2)];
  const initialV2 = w.exports.view(P, 'EX001').visual_pages.map((p) => p.initial.id);
  const now = await w.exports.render(P, 'EX001', '主持人'); // 另一个标签页重新渲染：v3，截图不同
  assert.equal(now.record.version, 3);
  assert.notEqual(now.visual_pages[0].image, seenV2[0].image);
  const before = e.gw.listRecords(P, 'render_check').length;
  // 旧标签页：没做模型初查的终审、带着 v2 初查编号的终审，都拒绝
  await assert.rejects(w.exports.finalReview(P, 'EX001', 1, { verdict: 'pass', ...seenV2[0] }, HUMAN), (err) => err.status === 409 && /你看到的是 EX001 第 2 版.*现在是第 3 版.*刷新后再审/.test(err.message));
  await assert.rejects(w.exports.finalReview(P, 'EX001', 2, { verdict: 'pass', ...seenV2[1], reviews: initialV2[1] }, HUMAN), (err) => err.status === 409);
  // 版本与渲染没变、截图对不上，也拒绝；没带“看到的”，400
  await assert.rejects(w.exports.finalReview(P, 'EX001', 1, { verdict: 'pass', ...seenOf(now, 1), image: seenV2[0].image }, HUMAN), (err) => err.status === 409 && /截图也不同/.test(err.message));
  await assert.rejects(w.exports.finalReview(P, 'EX001', 1, { verdict: 'pass' }, HUMAN), (err) => err.status === 400);
  assert.equal(e.gw.listRecords(P, 'render_check').length, before, '没有写任何终审');
  let v = w.exports.view(P, 'EX001');
  assert.deepEqual([v.visual.reviewed, v.deliverable], [0, false]);
  // 请求校验之后、晋升之前又重新渲染：晋升时按记录里写的版本再核，拒绝
  const stale = await promoteFails(e, [{ kind: 'render_check', expected_version: 0, data: { export: { id: 'EX001', version: 3 }, render: now.record.render.dir, page: 1, slide: { id: 'SL001', version: 1 }, image: now.visual_pages[0].image, stage: 'final', verdict: 'pass' } }].map((c) => c), HUMAN).then(async (r) => {
    assert.equal(r, null); // 这条对 v3 是对的，先写进去
    await w.exports.render(P, 'EX001', '主持人'); // v4
    return promoteFails(e, [{ kind: 'render_check', expected_version: 0, data: { export: { id: 'EX001', version: 3 }, render: now.record.render.dir, page: 2, slide: { id: 'SL002', version: 1 }, image: now.visual_pages[1].image, stage: 'final', verdict: 'pass' } }]);
  });
  assert.match(stale.map((x) => x.note ?? x.type).join(), /现在是第 4 版/);
  // 刷新后对当前截图终审、对同一张截图改判：照常
  v = await approve(w, 'EX001', 1, { verdict: 'fail', note: '先不通过' });
  v = await approve(w, 'EX001', 1);
  v = await approve(w, 'EX001', 2);
  assert.deepEqual([v.record.version, v.visual.passed, v.deliverable], [4, 2, true]);
});

test('评审 R2：视觉检查任务外部会话不能认领（截图交不过去）；初查只能来自那次视觉检查任务，别的任务顺手写的初查、与任务不符的初查都拒绝', { skip: NO_PY }, async () => {
  const e = await env();
  await sample(e);
  const w = world(e);
  await w.exports.create(P, { formats: ['pptx'], via: 'script' }, '主持人');
  const v = await w.exports.render(P, 'EX001', '主持人');
  // 派发暂时不可用，任务留在 open（Astra 的复现）
  const requestOnly = createExports({ workbench: e.workbench, gateway: e.gw, board: e.board, runner: { dispatch() { throw new Error('派发暂时不可用'); } }, participants: (id) => PEOPLE.find((p) => p.id === id), root: ROOT });
  const t = requestOnly.requestReview(P, 'EX001', 'looker', HUMAN).tasks[0];
  assert.equal(e.board.get(P, t.id).state, 'open');
  assert.throws(() => w.runner.claimExternal(P, t.id, { kind: 'mcp', participant: 'looker', adapter: 'generic', verified: false }), (err) => err.status === 409 && /视觉检查.*外部会话不能认领/.test(err.message));
  assert.equal(e.board.get(P, t.id).state, 'open', '认领被拒，任务仍可由服务端派发');
  // 别的任务（抽取论断）的租约顺手写一条初查：拒绝
  const page1 = { export: { id: 'EX001', version: v.record.version }, render: v.record.render.dir, page: 1, slide: { id: 'SL001', version: 1 }, image: v.visual_pages[0].image, stage: 'initial', verdict: 'pass' };
  const other = e.board.create(P, { type: 'extract_claims' }, { created_by: HUMAN });
  const c = e.board.claim(P, other.id, holder('looker', 'generic'));
  const r1 = e.gw.receive(P, { request_id: rid(), task_id: other.id, attempt: c.attempt, lease_token: c.lease_token, changes: [{ kind: 'render_check', expected_version: 0, data: page1 }] });
  const why = await e.gw.promote(P, r1.sid).then(() => null, (err) => err.details?.reasons ?? err);
  assert.match(why.map((x) => x.note).join(), /初查只能经视觉检查任务/);
  // 视觉检查任务本身，但交的初查与任务不符（截图不对）：拒绝；相符的通过
  const c2 = e.board.claim(P, t.id, holder('looker', 'generic'));
  const r2 = e.gw.receive(P, { request_id: rid(), task_id: t.id, attempt: c2.attempt, lease_token: c2.lease_token, changes: [{ kind: 'render_check', expected_version: 0, data: { ...page1, image: v.visual_pages[1].image } }] });
  const why2 = await e.gw.promote(P, r2.sid).then(() => null, (err) => err.details?.reasons ?? err);
  assert.match(why2.map((x) => x.note).join(), /要与视觉检查任务里的导出版本、渲染、页码和截图一致/);
  assert.equal(w.exports.view(P, 'EX001').visual.initial, 0);
});
