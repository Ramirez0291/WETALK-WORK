// 试运行报告（WP7b）：多 Agent 版与单 Agent 基线（<项目>/baseline.md）逐项对比。设计 V2 的四项指标加花费：
// - 核心论断能否追溯到有效证据：成品引用的核心论断（core: true；没有标核心的就按全部引用的论断）里，
//   引用的版本仍是当前版本、可进入成品、每条引文都在来源正文快照里找得到的比例（程序算）；
// - 人工抽查发现多少实质错误：你填（另列流程中拦下的问题作参考，程序算）；
// - 你需要花多少时间才能放心分享（你的修改时间）：你填；
// - 总用时：从项目第一次提交到成品可交付（最后一页终审）的时间（程序算）；
// - 花费：用量账本里的调用次数与 API 费用（程序算）。
// 你填的数值存在 <项目>/trial.json（服务维护，不进 git）；报告可以下载成 Markdown。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';
import { writeJsonSync } from './tasks.mjs';
import { kindOfId } from './records.mjs';
import { recordsOf } from './export/deck.mjs';

const BLOCKING = ['source_missing', 'number_error', 'quote_unsupported'];
const METRICS = [
  { key: 'traceable', name: '核心论断可追溯到有效证据的比例' },
  { key: 'errors', name: '发现的实质错误数' },
  { key: 'revision', name: '你的修改时间' },
  { key: 'total_time', name: '总用时' },
  { key: 'cost', name: 'API / 订阅额度花费' },
];

// baseline.md 的“## 指标”表：| 指标 | 数值 | 说明 |
export function parseBaseline(text) {
  const out = {};
  const section = String(text ?? '').split(/^## /m).find((s) => s.startsWith('指标'));
  if (!section) return out;
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 2 || cells[0] === '指标' || /^-+$/.test(cells[0].replace(/:/g, ''))) continue;
    out[cells[0]] = { value: cells[1] || null, note: cells[2] || null };
  }
  return out;
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 1) return `${Math.round(ms / 1000)} 秒`;
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 小时 ${m % 60} 分钟` : `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export function createReport({ workbench, gateway, usage = null, exports, now = () => new Date() }) {
  const trialFile = (project) => path.join(workbench.get(project).dir, 'trial.json');

  function manualOf(project) {
    try {
      return { revision_minutes: null, errors_found: null, error_list: '', note: '', ...JSON.parse(fs.readFileSync(trialFile(project), 'utf8')) };
    } catch {
      return { revision_minutes: null, errors_found: null, error_list: '', note: '' };
    }
  }

  // 你填的数值：修改时间（分钟）、抽查发现的实质错误条数与清单、备注。不填写 null 或空
  function setManual(project, body = {}, by) {
    const num = (v, field, { int = false } = {}) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw new WorkbenchError(400, `${field} 必须是不小于 0 的${int ? '整数' : '数'}`);
      return n;
    };
    const str = (v, field, max) => {
      if (v == null) return '';
      if (typeof v !== 'string') throw new WorkbenchError(400, `${field} 必须是字符串`);
      if (v.length > max) throw new WorkbenchError(400, `${field} 超过 ${max} 字`);
      return v;
    };
    const m = {
      revision_minutes: num(body.revision_minutes, 'revision_minutes'),
      errors_found: num(body.errors_found, 'errors_found', { int: true }),
      error_list: str(body.error_list, 'error_list', 8000),
      note: str(body.note, 'note', 4000),
      updated_at: now().toISOString(), by,
    };
    writeJsonSync(trialFile(project), m);
    return build(project);
  }

  function build(project) {
    const p = workbench.get(project);
    const all = recordsOf(gateway, project);
    const list = exports.list(project).exports;
    // 用哪份导出：最新的可交付导出；没有就用最新的导出（并注明还不可交付）
    const chosen = list.find((x) => x.deliverable) ?? list[0] ?? null;
    const view = chosen ? exports.view(project, chosen.id) : null;
    const notes = [];

    // ---- 可追溯：成品引用的核心论断 ----
    const cited = new Map();
    for (const s of view?.record.slides ?? []) {
      const slide = gateway.recordVersion(project, s.id, s.version);
      for (const c of slide?.claims ?? []) cited.set(`${c.id}@${c.version}`, c);
    }
    const refs = [...cited.values()];
    const core = refs.filter((c) => gateway.recordVersion(project, c.id, c.version)?.core === true);
    const base = core.length ? core : refs;
    if (refs.length && !core.length) notes.push('没有论断标为核心（core: true），可追溯比例按成品引用的全部论断计算。');
    const traceable = base.filter((c) => {
      const cur = all.get(c.id);
      if (!cur || cur.record.version !== c.version || cur.status.ready !== true) return false;
      const t = gateway.trace(project, c.id);
      return t.root.sources.length > 0 && t.root.sources.every((s) => s.quote && s.quote_found === true);
    });
    const traceDetail = base.map((c) => ({ id: c.id, version: c.version, ok: traceable.includes(c) }));

    // ---- 实质错误：你填的抽查结果；流程中拦下的问题作参考 ----
    const manual = manualOf(project);
    const recs = [...all.values()].map((x) => x.record);
    const upheld = recs.filter((r) => kindOfId(r.id) === 'objection' && BLOCKING.includes(r.category) && ['upheld', 'resolved'].includes(r.state)).length;
    const unsupported = recs.filter((r) => kindOfId(r.id) === 'verification' && r.verdict === 'unsupported').length;

    // ---- 总用时：第一次提交 → 成品可交付（最后一页终审；只有 Markdown 时为导出时间） ----
    const commits = gateway.commits(project);
    const startAt = commits.map((c) => c.at).filter(Boolean).sort()[0] ?? null;
    let endAt = null;
    if (chosen?.deliverable) {
      const finals = (view.visual_pages ?? []).map((pg) => pg.final?.at).filter(Boolean).sort();
      endAt = finals.at(-1) ?? view.record.updated_at ?? null;
    } else notes.push(chosen ? `最新的导出 ${chosen.id} 还不可交付，总用时还算不出来。` : '还没有导出，总用时还算不出来。');
    const total = startAt && endAt ? Date.parse(endAt) - Date.parse(startAt) : null;

    // ---- 花费：用量账本 ----
    let cost = null;
    if (usage) {
      const t = usage.totals(project);
      const by = new Map();
      for (const e of usage.entries(project)) {
        const key = `${e.participant ?? '—'}${e.api === 'cli' ? '（命令行）' : e.api ? `（${e.api}）` : ''}`;
        by.set(key, (by.get(key) ?? 0) + 1);
      }
      cost = { calls: t.calls, usd: t.usd, limits: t.limits, by: Object.fromEntries([...by].sort((a, b) => b[1] - a[1])) };
    }

    const baseline = (() => {
      try {
        return parseBaseline(fs.readFileSync(path.join(p.dir, 'baseline.md'), 'utf8'));
      } catch {
        return {};
      }
    })();
    const multi = {
      traceable: base.length ? `${traceable.length} / ${base.length}（${Math.round((traceable.length / base.length) * 100)}%）` : null,
      errors: manual.errors_found != null ? `${manual.errors_found}` : null,
      revision: manual.revision_minutes != null ? duration(manual.revision_minutes * 60_000) : null,
      total_time: duration(total),
      cost: cost ? `调用 ${cost.calls} 次，API 费用 $${cost.usd.toFixed(4)}` : null,
    };
    const extra = {
      traceable: core.length ? '核心论断（core: true）' : '成品引用的全部论断',
      errors: `流程中拦下：成立的阻塞异议 ${upheld} 条，核验判为不支持 ${unsupported} 次`,
      revision: manual.updated_at ? `你在 ${manual.updated_at} 填写` : '还没填',
      total_time: startAt ? `从 ${startAt}${endAt ? ` 到 ${endAt}` : ''}` : '',
      cost: cost ? Object.entries(cost.by).map(([k, n]) => `${k} ${n} 次`).join('、') : '',
    };
    const rows = METRICS.map((m) => ({ key: m.key, name: m.name, baseline: baseline[m.name]?.value ?? null, multi: multi[m.key], note: extra[m.key] }));
    if (!Object.values(baseline).some((x) => x.value)) notes.push('baseline.md 的指标表还没有填数值，无法逐项对比。');
    return {
      project, title: p.title, generated_at: now().toISOString(),
      export: chosen ? { id: chosen.id, version: chosen.version, deliverable: chosen.deliverable, pages: chosen.pages, structure: chosen.structure, live: chosen.live, render: chosen.render, visual: chosen.visual } : null,
      rows, trace: traceDetail, manual, process: { upheld_blocking_objections: upheld, unsupported_verifications: unsupported }, cost, notes,
    };
  }

  function markdown(r) {
    const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const ex = r.export;
    const lines = [
      `# 试运行报告：${r.title}`, '', `生成时间：${r.generated_at}`, '',
      '## 成品', '',
      ex ? `- 导出 ${ex.id} 第 ${ex.version} 版，${ex.pages} 页：${ex.deliverable ? '可交付' : '还不可交付'}` : '- 还没有导出',
      ...(ex ? [
        `- 结构检查：导出时${ex.structure.ok ? '通过' : `${ex.structure.errors} 个问题`}；此刻${ex.live ? (ex.live.ok ? '通过' : `${ex.live.errors} 个问题`) : '（导出已过期）'}`,
        `- 渲染检查：${ex.render ? (ex.render.ok === true ? '通过' : ex.render.ok === false ? `${ex.render.errors} 个问题` : '未检查完') : '还没做'}`,
        `- 逐页视觉检查：${ex.visual ? `模型初查 ${ex.visual.initial}/${ex.visual.total} 页，你终审 ${ex.visual.reviewed}/${ex.visual.total} 页，通过 ${ex.visual.passed} 页` : '（没有 PPTX）'}`,
      ] : []),
      '', '## 与单 Agent 基线对比', '',
      '| 指标 | 单 Agent 基线 | 多 Agent 版 | 说明 |', '| --- | --- | --- | --- |',
      ...r.rows.map((x) => `| ${cell(x.name)} | ${cell(x.baseline)} | ${cell(x.multi)} | ${cell(x.note)} |`),
      '',
      ...(r.trace.length ? ['## 论断追溯', '', ...r.trace.map((t) => `- ${t.id}@${t.version}：${t.ok ? '可追溯到有效证据' : '追溯不到有效证据（不是当前版本、不可进入成品，或引文在来源快照里找不到）'}`), ''] : []),
      ...(r.manual.error_list ? ['## 抽查发现的实质错误', '', r.manual.error_list.trim(), ''] : []),
      ...(r.manual.note ? ['## 备注', '', r.manual.note.trim(), ''] : []),
      ...(r.notes.length ? ['## 说明', '', ...r.notes.map((n) => `- ${n}`), ''] : []),
    ];
    return lines.join('\n');
  }

  // 下载用：写到 <项目>/exports/_report/report.md（不进 git）
  function markdownFile(project) {
    const file = path.join(workbench.get(project).dir, 'exports', '_report', 'report.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown(build(project)));
    return { path: file, type: 'text/markdown; charset=utf-8', filename: `${project}-试运行报告.md` };
  }

  return { build, setManual, manualOf, markdown, markdownFile };
}
