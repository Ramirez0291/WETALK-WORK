// 导出（WP7）：幻灯片源 → Markdown / PPTX，并做结构检查、读回核对、渲染检查。
// - 每次导出写成一条正式记录 EX###（只由导出流程经提交入口写入）：用了哪些幻灯片的哪个版本、模板与 skill 的内容 hash、
//   版式方案、生成的文件（blob，随 git 留档），以及检查结果。幻灯片改版后导出变成 stale，要重新导出。
// - 导出方式：脚本直接生成；或派给指定 Agent 出版式方案（每页用模板里的哪个版式，不给工具），脚本照方案生成。
// - 渲染检查：本机 PowerPoint 把 PPTX 转成 PDF 与逐页图片，程序查溢出、重叠、字体、图片变形，结果写成导出记录的新版本。
// - <项目>/exports/EX###/ 下的 deck.md、deck.pptx 是从 blob 取出的副本，render-<时间>/ 是渲染产物；都不进 git。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import { blobStore } from './records.mjs';
import { EXPORT_WRITER } from './commit.mjs';
import { deckSlides, checkStructure, deckSpec, checkReadback, recordsOf, paragraphsOf } from './export/deck.mjs';
import { REVIEW_BATCH } from './export/review.mjs';
import { canSeeImages } from '../agents.mjs';
import { renderMarkdown } from './export/markdown.mjs';
import { LAYOUTS_INPUT, SKILL_INPUT_PREFIX } from './export/plan.mjs';
import { pyExport } from './export/proc.mjs';
import { renderWith, analyze } from './export/render.mjs';

export const EXPORT_ACTOR = { kind: 'system', participant: EXPORT_WRITER, verified: true, basis: 'rule' };
const NAME_RE = /^[\w一-鿿぀-ヿ .()（）-]{1,80}$/;
const FILE_RE = /^(deck\.(md|pptx)|render-\d{14}\/(deck\.pdf|p\d{2,3}\.png))$/;
const TYPES = { md: 'text/markdown; charset=utf-8', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf', png: 'image/png' };
const RECORD_FIELDS = ['title', 'formats', 'slides', 'via', 'plan', 'plan_task', 'template', 'skill', 'files', 'structure', 'readback', 'render'];

const bad = (status, msg) => new WorkbenchError(status, msg);

export function createExports({
  workbench, gateway, board, runner, participants,
  root, // 工坊仓库根目录：export.python 写相对路径时相对它（.venv）
  templatesDir = path.join(root, 'templates'), // pptx/*.pptx 与 skills/*.md
  renderEngine = renderWith, // (engine, { pptx, outDir, resultFile }) → render.ps1 的结果；测试里换成假的
  now = () => new Date(), onEvent = () => {},
}) {
  const iso = () => now().toISOString();
  const stamp = () => iso().replace(/\D/g, '').slice(0, 14);
  const pyOf = (config) => path.resolve(root, config.export.python);
  const dirOf = (project) => path.join(workbench.get(project).dir, 'exports');
  const failures = new Map(); // 项目 → 按版式方案生成失败的记录（内存里；任务本身仍在，可以再生成）
  const busy = new Set(); // 正在渲染的导出

  // ---------- 模板与 skill：templates/pptx/*.pptx、templates/skills/*.md，只认文件名 ----------
  const listDir = (sub, ext) => {
    const dir = path.join(templatesDir, sub);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(ext) && NAME_RE.test(n)).sort() : [];
  };
  const templates = () => ({ pptx: listDir('pptx', '.pptx'), skills: listDir('skills', '.md') });
  function asset(project, sub, ext, name) {
    if (name == null) return null;
    if (typeof name !== 'string' || !NAME_RE.test(name) || !name.toLowerCase().endsWith(ext)) throw bad(400, `${sub === 'pptx' ? '模板' : 'skill'}只能写 templates/${sub}/ 里的文件名`);
    const file = path.join(templatesDir, sub, name);
    if (!fs.existsSync(file)) throw bad(404, `templates/${sub}/${name} 不存在`);
    return { name, file, blob: blobStore(workbench.get(project).dir).put(fs.readFileSync(file)) };
  }

  // 本次导出的设置：项目配置（export.*）＋ 请求里的覆盖
  function optionsOf(project, body = {}) {
    const config = workbench.get(project).config;
    const formats = body.formats ?? config.export.formats;
    if (!Array.isArray(formats) || !formats.length || formats.some((f) => !['md', 'pptx'].includes(f))) throw bad(400, 'formats 只能取 md、pptx');
    const via = body.via ?? config.export.via;
    if (typeof via !== 'string' || !via) throw bad(400, 'via 写 script，或一位参与者的 id');
    if (via !== 'script') {
      const p = participants(via);
      if (!p) throw bad(404, `参与者 ${via} 不存在`);
      if (!formats.includes('pptx')) throw bad(400, 'Agent 出的是 PPTX 的版式方案：formats 要包含 pptx');
    }
    return {
      formats: [...new Set(formats)], via,
      template: asset(project, 'pptx', '.pptx', body.template !== undefined ? body.template : config.export.template ?? 'default.pptx') ?? asset(project, 'pptx', '.pptx', 'default.pptx'),
      skill: asset(project, 'skills', '.md', body.skill !== undefined ? body.skill : config.export.skill),
    };
  }

  const slidesNow = (project) => {
    const slides = deckSlides(gateway, project);
    if (!slides.length) throw bad(409, '还没有幻灯片记录（slides/），没有可导出的内容');
    return slides;
  };

  // ---------- 发起导出 ----------
  async function create(project, body, by) {
    const opts = optionsOf(project, body);
    const slides = slidesNow(project);
    if (opts.via === 'script') return { export: await build(project, opts, slides, null) };
    // 派给 Agent：先列出模板的版式，连同 skill 放进任务输入（内容版本随任务包保存）
    const config = workbench.get(project).config;
    const work = fs.mkdtempSync(path.join(dirOf(project), '_work-'));
    let layouts;
    try {
      layouts = await pyExport(pyOf(config), 'layouts', [opts.template.file], path.join(work, 'layouts.json'));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const blobs = blobStore(workbench.get(project).dir);
    const inputs = [
      ...slides.map((s) => ({ id: s.id, version: s.version })),
      { blob: blobs.put(JSON.stringify(layouts, null, 1)), name: LAYOUTS_INPUT },
      ...(opts.skill ? [{ blob: opts.skill.blob, name: `${SKILL_INPUT_PREFIX}${opts.skill.name}` }] : []),
    ];
    const strip = (a) => a && { name: a.name, blob: a.blob };
    let task = board.create(project, {
      type: 'export', title: `导出版式：${slides.length} 页`, goal: '为每一页选模板里的版式（不改写内容）。', inputs, assigned_to: opts.via,
    }, { created_by: by, internal: { export: { formats: opts.formats, template: strip(opts.template), skill: strip(opts.skill) } } });
    let dispatchError = null;
    if (task.state === 'open') {
      try {
        runner.dispatch(project, task.id, opts.via);
      } catch (e) {
        dispatchError = e.message;
      }
    }
    task = board.get(project, task.id);
    return { task: { id: task.id, state: task.state, assigned_to: task.assigned_to }, dispatch_error: dispatchError };
  }

  // 导出任务（Agent 的版式方案）完成：照方案生成。已经生成过的不再生成
  async function onTaskDone(project, taskId) {
    let task;
    try {
      task = board.get(project, taskId);
    } catch {
      return null;
    }
    if (task.type !== 'export' || task.state !== 'done' || !task.export || !task.result?.plan) return null;
    if (exportOfTask(project, task)) return null;
    const key = `${project}/${taskId}`;
    if (busy.has(key)) return null;
    busy.add(key);
    try {
      const slides = slidesNow(project);
      const want = task.inputs.filter((x) => x.id && /^SL\d/.test(x.id));
      if (want.length !== slides.length || want.some((x, i) => x.id !== slides[i].id || x.version !== slides[i].version)) {
        throw bad(409, '出方案之后幻灯片改过（增删或改版），这份方案不能用了，重新导出');
      }
      const ex = task.export;
      const opts = { formats: ex.formats, via: task.assigned_to, template: { ...ex.template, file: materializeBlob(project, ex.template.blob, `${ex.template.blob}.pptx`) }, skill: ex.skill };
      const a = task.attempts.find((x) => x.n === task.attempt);
      const out = await build(project, opts, slides, { plan: task.result.plan, task: task.id, attempt: a?.n ?? task.attempt });
      failures.get(project)?.delete(taskId);
      return out;
    } catch (e) {
      if (!failures.has(project)) failures.set(project, new Map());
      failures.get(project).set(taskId, { task: taskId, at: iso(), message: String(e.message).slice(0, 500) });
      onEvent({ type: 'export', project, task: taskId, failed: true });
      throw e;
    } finally {
      busy.delete(key);
    }
  }
  const exportOfTask = (project, task) => gateway.listRecords(project, 'export').find((x) => x.record.plan_task?.task === task.id)?.record ?? null;

  // 模板等从 blob 取出到一个临时文件（导出任务完成时，模板以任务里记下的那个版本为准，不读 templates/ 里现在的文件）
  function materializeBlob(project, hash, name) {
    const file = path.join(dirOf(project), '_blobs', name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, blobStore(workbench.get(project).dir).get(hash));
    }
    return file;
  }

  // ---------- 生成 ----------
  async function build(project, opts, slides, planInfo) {
    const p = workbench.get(project);
    const config = p.config;
    const blobs = blobStore(p.dir);
    const structure = checkStructure({ gateway, project, slides, maxChars: config.slides.maxCharsPerPage });
    // 依据一律按引用的版本取（论断按页面 claims 里的版本，来源按论断 sources 里的版本），不拿当前版本冒充旧版本；
    // 某个版本还原不出来（归档里也没有）就不导出
    const at = (ref) => {
      const rec = gateway.recordVersion(project, ref.id, ref.version);
      if (!rec) throw bad(409, `还原不出 ${ref.id}@${ref.version}（正式记录和归档里都没有这个版本），不能导出`);
      return rec;
    };
    for (const s of slides) {
      for (const c of s.claims ?? []) for (const src of at(c).sources ?? []) at(src);
    }
    const claim = (ref) => at(ref);
    const files = {};
    let readback = null;
    fs.mkdirSync(dirOf(project), { recursive: true });
    const work = fs.mkdtempSync(path.join(dirOf(project), '_work-'));
    try {
      if (opts.formats.includes('md')) {
        const md = renderMarkdown({
          title: p.title, slides, at: iso(),
          claimInfo: (ref) => {
            const c = claim(ref);
            return { text: c.text, sources: (c.sources ?? []).map((s) => ({ title: at(s).title ?? s.id, locator: s.locator, quote: s.quote })) };
          },
        });
        files.md = blobs.put(md);
      }
      if (opts.formats.includes('pptx')) {
        const spec = { ...deckSpec({ title: p.title, slides, claimText: (ref) => claim(ref)?.text }), template: opts.template.file, plan: planInfo?.plan ?? null };
        const specFile = path.join(work, 'spec.json');
        const pptx = path.join(work, 'deck.pptx');
        fs.writeFileSync(specFile, JSON.stringify(spec));
        await pyExport(pyOf(config), 'build', [specFile, pptx], path.join(work, 'build.json'));
        const rb = await pyExport(pyOf(config), 'readback', [pptx], path.join(work, 'readback.json'));
        readback = checkReadback(spec, rb);
        files.pptx = blobs.put(fs.readFileSync(pptx));
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    const data = {
      title: p.title, formats: opts.formats, slides: slides.map((s) => ({ id: s.id, version: s.version })), via: opts.via,
      plan: planInfo?.plan ?? null, plan_task: planInfo ? { task: planInfo.task, attempt: planInfo.attempt } : null,
      template: opts.formats.includes('pptx') ? { name: opts.template.name, blob: opts.template.blob } : null,
      skill: opts.skill ? { name: opts.skill.name, blob: opts.skill.blob } : null,
      files, structure, readback, render: null,
    };
    const id = await write(project, [{ kind: 'export', expected_version: 0, data }]);
    materialize(project, id);
    onEvent({ type: 'export', project, id });
    return view(project, id);
  }

  async function write(project, changes) {
    const receipt = gateway.receive(project, { request_id: `export-${crypto.randomBytes(8).toString('hex')}`, changes }, { actor: EXPORT_ACTOR });
    const result = await gateway.promote(project, receipt.sid);
    return result.records[0].id;
  }

  // deck.md、deck.pptx：从 blob 取出到 exports/EX###/（下载与渲染用）
  function materialize(project, id) {
    const rec = gateway.getRecord(project, id).record;
    const dir = path.join(dirOf(project), id);
    fs.mkdirSync(dir, { recursive: true });
    const blobs = blobStore(workbench.get(project).dir);
    for (const [f, hash] of Object.entries(rec.files)) {
      const file = path.join(dir, `deck.${f}`);
      const buf = blobs.get(hash);
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(buf)) fs.writeFileSync(file, buf);
    }
    return dir;
  }

  // ---------- 渲染检查 ----------
  async function render(project, id, by) {
    const cur = gateway.getRecord(project, id);
    if (cur.kind !== 'export') throw bad(400, `${id} 不是导出记录`);
    const rec = cur.record;
    if (!rec.files.pptx) throw bad(409, `${id} 没有 PPTX，不能做渲染检查`);
    if (cur.status.freshness !== 'current') throw bad(409, `${id} 用到的幻灯片在导出之后改过，先重新导出，再做渲染检查`);
    const key = `${project}/${id}`;
    if (busy.has(key)) throw bad(409, `${id} 正在做渲染检查`);
    busy.add(key);
    try {
      const config = workbench.get(project).config;
      const dir = materialize(project, id);
      const sub = `render-${stamp()}`;
      const outDir = path.join(dir, sub);
      fs.mkdirSync(outDir, { recursive: true });
      const pptx = path.join(dir, 'deck.pptx');
      const raw = await renderEngine(config.render.engine, { pptx, outDir, resultFile: path.join(outDir, 'render.json') });
      const rb = await pyExport(pyOf(config), 'readback', [pptx], path.join(outDir, 'readback.json'));
      const result = { ...analyze({ raw, readback: rb, spec: { slides: rec.slides } }), dir: sub, at: iso(), by };
      // 每页截图存成 blob：视觉检查的记录指向它，审过的那张随记录进 git 留档（WP7b）
      const blobs = blobStore(workbench.get(project).dir);
      for (const pg of result.pages) {
        if (pg.png && fs.existsSync(path.join(outDir, pg.png))) pg.image = blobs.put(fs.readFileSync(path.join(outDir, pg.png)));
      }
      const data = Object.fromEntries(RECORD_FIELDS.map((k) => [k, rec[k] ?? null]));
      await write(project, [{ id, expected_version: rec.version, data: { ...data, render: result } }]);
      onEvent({ type: 'export', project, id });
      return view(project, id);
    } finally {
      busy.delete(key);
    }
  }

  // ---------- 视图 ----------
  // 可交付：导出时的结构检查、读回核对、渲染检查都通过，用到的幻灯片仍是当前版本，并且此刻再查一遍结构也通过——
  // 新增阻塞异议、新的核验改变了论断能否进入成品，但不改版本，导出时存下的检查结果反映不出来（逐页的视觉检查在 WP7b 加进来）。
  // all：recordsOf 的结果（列表里所有导出共用一份）
  // ---------- 逐页的视觉检查（WP7b）：模型看截图初查、主持人终审 ----------
  // 这一版导出、这一次渲染的检查记录：每页取最新的一条初查、一条终审（编号大的在后）
  function visualOf(r, all) {
    if (!r.render) return null;
    const num = (id) => Number(id.slice(2));
    const checks = [...all.values()].map((x) => x.record)
      .filter((c) => c.id.startsWith('RC') && c.export?.id === r.id && c.export.version === r.version && c.render === r.render.dir)
      .sort((a, b) => num(a.id) - num(b.id));
    const pages = r.render.pages.map((p) => {
      const mine = checks.filter((c) => c.page === p.page);
      const pick = (stage) => {
        const c = mine.filter((x) => x.stage === stage).at(-1);
        return c ? { id: c.id, verdict: c.verdict, issues: c.issues, note: c.note ?? null, by: c.reviewer?.participant ?? null, at: c.updated_at ?? null, reviews: c.reviews ?? null } : null;
      };
      return { page: p.page, slide: p.slide, version: p.version, png: p.png, image: p.image ?? null, issues: p.issues, initial: pick('initial'), final: pick('final') };
    });
    const passed = pages.filter((p) => p.final?.verdict === 'pass').length;
    return {
      pages, total: pages.length, initial: pages.filter((p) => p.initial).length, reviewed: pages.filter((p) => p.final).length, passed,
      ok: pages.length > 0 && passed === pages.length,
    };
  }

  // 派一位能看图的参与者做初查：每批最多 REVIEW_BATCH 页，一批一个任务（页面文字与程序检查结果内联，截图作为图片附上）
  function requestReview(project, id, participantId, by) {
    const x = gateway.getRecord(project, id);
    if (x.kind !== 'export') throw bad(400, `${id} 不是导出记录`);
    const r = x.record;
    if (x.status.freshness !== 'current') throw bad(409, `${id} 用到的幻灯片在导出之后改过，先重新导出`);
    if (!r.render) throw bad(409, `${id} 还没做渲染检查，没有页面截图`);
    if (r.render.pages.some((p) => !p.image)) throw bad(409, `${id} 这次渲染没有页面截图（没有用 PowerPoint 渲染），做不了视觉检查`);
    const who = participants(participantId);
    if (!who) throw bad(404, `参与者 ${participantId} 不存在`);
    if (!canSeeImages(who)) throw bad(409, `${who.name} 的适配器（${who.adapter}）这一版不能看图：视觉检查请派给 Claude`);
    const blobs = blobStore(workbench.get(project).dir);
    const out = [];
    for (let i = 0; i < r.render.pages.length; i += REVIEW_BATCH) {
      const batch = r.render.pages.slice(i, i + REVIEW_BATCH);
      const info = batch.map((p) => {
        const s = p.slide ? gateway.recordVersion(project, p.slide, p.version) : null;
        const text = s ? paragraphsOf(s.body).map((x) => `${x.bullet ? `${'  '.repeat(x.level)}- ` : ''}${x.text}`).join('\n') : '';
        const found = p.issues.length ? p.issues.map((x) => `- ${x.message}`).join('\n') : '- 无';
        return `## 第 ${p.page} 页${s ? `：${s.title}` : ''}\n\n页面上的文字：\n${text || '（只有标题）'}\n\n程序检查发现的问题：\n${found}`;
      }).join('\n\n');
      const deck = r.render.issues.length ? `\n\n## 整份\n${r.render.issues.map((x) => `- ${x.message}`).join('\n')}` : '';
      const a = batch[0].page;
      const b = batch.at(-1).page;
      let t = board.create(project, {
        type: 'render_review', title: `视觉检查：${id} 第 ${a === b ? a : `${a}–${b}`} 页`,
        goal: '逐页看截图，检查版面问题（不评价内容对错）。', inputs: [{ blob: blobs.put(`${info}${deck}\n`), name: '页面与程序检查.md' }], assigned_to: participantId,
      }, { created_by: by, internal: { render_review: { export: { id, version: r.version }, render: r.render.dir, pages: batch.map((p) => ({ page: p.page, slide: p.slide ? { id: p.slide, version: p.version } : null, image: p.image })) } } });
      let error = null;
      if (t.state === 'open') {
        try {
          runner.dispatch(project, t.id, participantId);
        } catch (e) {
          error = e.message;
        }
      }
      t = board.get(project, t.id);
      out.push({ id: t.id, state: t.state, pages: batch.map((p) => p.page), dispatch_error: error });
    }
    return { tasks: out };
  }

  // 主持人终审一页：{ verdict, note, issues, reviews }。针对导出的当前版本、这一版的渲染、这一页的截图
  async function finalReview(project, id, page, body, actor) {
    const x = gateway.getRecord(project, id);
    if (x.kind !== 'export') throw bad(400, `${id} 不是导出记录`);
    const r = x.record;
    if (!r.render) throw bad(409, `${id} 还没做渲染检查`);
    const p = r.render.pages.find((y) => y.page === page);
    if (!p) throw bad(404, `${id} 的渲染里没有第 ${page} 页`);
    const data = {
      export: { id, version: r.version }, render: r.render.dir, page, slide: p.slide ? { id: p.slide, version: p.version } : null, image: p.image ?? null,
      stage: 'final', verdict: body?.verdict, issues: Array.isArray(body?.issues) ? body.issues : [],
      ...(typeof body?.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(typeof body?.reviews === 'string' ? { reviews: body.reviews } : {}),
    };
    const receipt = gateway.receive(project, { request_id: `review-${crypto.randomBytes(8).toString('hex')}`, changes: [{ kind: 'render_check', expected_version: 0, data }] }, { actor });
    await gateway.promote(project, receipt.sid);
    onEvent({ type: 'export', project, id });
    return view(project, id);
  }

  function summary(project, x, all) {
    const r = x.record;
    const current = x.status.freshness === 'current';
    const visual = r.formats.includes('pptx') ? visualOf(r, all) : null;
    const live = current
      ? checkStructure({ gateway, project, slides: r.slides.map((s) => all.get(s.id).record), maxChars: workbench.get(project).config.slides.maxCharsPerPage, records: all })
      : null;
    return {
      id: r.id, version: r.version, at: r.updated_at ?? null, formats: r.formats, via: r.via, pages: r.slides.length,
      template: r.template?.name ?? null, skill: r.skill?.name ?? null, plan_task: r.plan_task,
      freshness: x.status.freshness,
      structure: { ok: r.structure?.ok ?? null, errors: r.structure?.errors ?? 0, warnings: r.structure?.warnings ?? 0 },
      readback: r.readback ? { ok: r.readback.ok, errors: r.readback.issues.filter((i) => i.level === 'error').length } : null,
      render: r.render ? { ok: r.render.ok, errors: r.render.errors, engine: r.render.engine, at: r.render.at } : null,
      // 此刻的结构检查（只在导出仍是当前版本时有意义）：问题与导出时不同，就以这里为准
      live: live ? { ok: live.ok, errors: live.errors, warnings: live.warnings, at: iso() } : null,
      // 逐页的视觉检查（WP7b）：每页都有主持人终审且判为通过
      visual: visual ? { total: visual.total, initial: visual.initial, reviewed: visual.reviewed, passed: visual.passed, ok: visual.ok } : null,
      deliverable: current && r.structure?.ok === true && live?.ok === true && (r.readback?.ok ?? true) && (!r.formats.includes('pptx') || (r.render?.ok === true && visual?.ok === true)),
      _visual: visual,
      _live: live,
    };
  }

  function list(project) {
    const all = recordsOf(gateway, project);
    const exports = [...all.values()].filter((x) => x.kind === 'export').map((x) => {
      const { _live, _visual, ...s } = summary(project, x, all);
      return s;
    }).sort((a, b) => b.id.localeCompare(a.id));
    const done = new Set(exports.map((x) => x.plan_task?.task).filter(Boolean));
    // 还没生成导出的导出任务（含失败的：看得到最后一次的原因），最近 10 个
    const tasks = board.list(project).filter((t) => t.type === 'export' && !done.has(t.id) && t.state !== 'cancelled').slice(-10)
      .map((t) => ({ id: t.id, state: t.state, assigned_to: t.assigned_to, reason: t.history.at(-1)?.reason ?? null, failure: failures.get(project)?.get(t.id) ?? null }));
    return { exports, tasks, templates: templates(), engine: workbench.get(project).config.render.engine };
  }

  function view(project, id) {
    const x = gateway.getRecord(project, id);
    if (x.kind !== 'export') throw bad(400, `${id} 不是导出记录`);
    const files = Object.keys(x.record.files).map((f) => `deck.${f}`);
    const r = x.record.render;
    if (r) {
      if (r.pdf) files.push(`${r.dir}/${r.pdf}`);
      for (const p of r.pages) if (p.png) files.push(`${r.dir}/${p.png}`);
    }
    const { _live, _visual, ...s } = summary(project, x, recordsOf(gateway, project));
    // 这份导出的视觉检查任务（模型初查），最近的在后
    const reviewTasks = board.list(project).filter((t) => t.type === 'render_review' && t.render_review?.export.id === id)
      .slice(-10).map((t) => ({ id: t.id, state: t.state, assigned_to: t.assigned_to, version: t.render_review.export.version, pages: t.render_review.pages.map((p) => p.page), reason: t.history.at(-1)?.reason ?? null }));
    // live_structure：此刻的结构检查（逐页的问题），导出时的结果在 record.structure
    return { ...s, live_structure: _live, visual_pages: _visual?.pages ?? null, review_tasks: reviewTasks, record: x.record, status: x.status, history: x.history, files };
  }

  // 下载：只认导出目录里的固定几种文件名；deck.* 不在磁盘上时从 blob 取出
  function file(project, id, name) {
    if (!FILE_RE.test(name)) throw bad(400, '文件名不对');
    const rec = gateway.getRecord(project, id);
    if (rec.kind !== 'export') throw bad(400, `${id} 不是导出记录`);
    if (name.startsWith('deck.')) materialize(project, id);
    const full = path.join(dirOf(project), id, ...name.split('/'));
    if (!fs.existsSync(full)) throw bad(404, `${id}/${name} 不存在`);
    const ext = path.extname(name).slice(1);
    return { path: full, type: TYPES[ext], filename: name.startsWith('deck.') ? `${project}-${id}.${ext}` : `${project}-${id}-${path.basename(name)}` };
  }

  return { templates, create, onTaskDone, render, list, view, file, optionsOf, requestReview, finalReview };
}
