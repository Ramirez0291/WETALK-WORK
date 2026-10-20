// 逐页的视觉检查（WP7b）：模型看截图初查、主持人终审，每页每次写一条渲染检查记录（RC###，只增不改）。
// 这里是晋升时的规则检查，以及模型初查的输出要求与解析。
import { kindOfId, RENDER_ISSUE_KINDS } from '../records.mjs';

export const REVIEW_BATCH = 8; // 一次调用最多看几页（图片太多，回复质量和请求大小都受影响）

// 晋升时检查一条渲染检查记录：针对的是导出的当前版本、那一版的那次渲染、那一页（幻灯片与截图都对得上）；
// 终审只能由主持人做，初查由模型经任务提交；reviews 指向的是同一页的初查
export function checkRenderCheck(rec, { records, actor }) {
  const reasons = [];
  const bad = (note) => reasons.push({ type: 'render_check_invalid', id: rec.id, note });
  if (rec.version > 1) bad('渲染检查记录写入后不能修改；改判就另写一条');
  if (rec.stage === 'final' && actor?.kind !== 'human') bad('终审只能由主持人做');
  if (rec.stage === 'initial' && actor?.kind === 'human') bad('初查由模型经任务提交；主持人直接写终审（stage: final）');
  const ex = records.get(rec.export.id);
  if (!ex || kindOfId(ex.id) !== 'export') {
    bad(`导出 ${rec.export.id} 不存在`);
    return reasons;
  }
  if (ex.version !== rec.export.version) bad(`${ex.id} 现在是第 ${ex.version} 版，不是第 ${rec.export.version} 版`);
  const render = ex.render;
  if (!render) {
    bad(`${ex.id} 第 ${ex.version} 版还没有渲染结果`);
    return reasons;
  }
  if (render.dir !== rec.render) bad(`${ex.id} 这一版的渲染是 ${render.dir}，不是 ${rec.render}`);
  const page = render.pages.find((p) => p.page === rec.page);
  if (!page) bad(`${ex.id} 的渲染里没有第 ${rec.page} 页`);
  else {
    if ((page.slide ?? null) !== (rec.slide?.id ?? null) || (page.version ?? null) !== (rec.slide?.version ?? null)) bad(`第 ${rec.page} 页是 ${page.slide ?? '（无幻灯片记录）'}@${page.version ?? '-'}，slide 对不上`);
    if ((page.image ?? null) !== (rec.image ?? null)) bad(`image 不是第 ${rec.page} 页的截图`);
  }
  if (rec.reviews) {
    const r = records.get(rec.reviews);
    if (!r || kindOfId(r.id) !== 'render_check' || r.stage !== 'initial' || r.export.id !== rec.export.id || r.export.version !== rec.export.version || r.page !== rec.page) {
      bad(`reviews ${rec.reviews} 不是这一页（同一版导出）的初查`);
    }
  }
  return reasons;
}

export const REVIEW_OUTPUT = `你的角色：版面检查员。输入里先有每页的文字与程序已经查出的问题，后面按页码顺序附了每页渲染出来的截图（第几张图就是第几页）。
逐页看图检查版面：文字溢出或被截断、文字互相重叠、字体看起来被替换（缺字、方块、和其他页明显不同的字体）、图表标签被裁切、图片变形或模糊、文字和背景对比太低看不清。程序查出的问题要在图上确认；程序查不出的（图表标签、可读性）要特别看。
只看版面，不评价内容对错，不提改写建议。
输出一个 \`\`\`json 代码块：{"pages":[{"page":1,"verdict":"pass","issues":[],"note":"可省略"},{"page":2,"verdict":"fail","issues":[{"kind":"overflow","note":"右下角最后一行被截断"}]}]}
规则：
- 每页都要出现，正好一次；verdict 只能是 pass 或 fail；fail 时 issues 不能为空。
- issues 的 kind 只能是 ${RENDER_ISSUE_KINDS.join(' / ')}；note 写清在哪里、什么问题。`;

// 回复 → 每页的初查。pages：这次要看的页码
export function parseReview(raw, pages) {
  const m = String(raw).match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) throw new Error('回复里没有 ```json 代码块');
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
  const items = Array.isArray(v) ? v : v?.pages;
  if (!Array.isArray(items)) throw new Error('结果必须是 {"pages":[…]}');
  const got = items.map((x) => x?.page).sort((a, b) => a - b);
  const want = [...pages].sort((a, b) => a - b);
  if (got.length !== want.length || got.some((p, i) => p !== want[i])) throw new Error(`要看的是第 ${want.join('、')} 页，每页正好一次（回复里是 ${got.join('、') || '无'}）`);
  return items.map((x) => {
    if (!['pass', 'fail'].includes(x.verdict)) throw new Error(`第 ${x.page} 页的 verdict 只能是 pass 或 fail`);
    const issues = (Array.isArray(x.issues) ? x.issues : []).slice(0, 30).map((i) => ({
      kind: RENDER_ISSUE_KINDS.includes(i?.kind) ? i.kind : 'other',
      note: String(i?.note ?? '').trim().slice(0, 500) || '（没写说明）',
    }));
    if (x.verdict === 'fail' && !issues.length) throw new Error(`第 ${x.page} 页判为 fail，但没写问题`);
    const note = typeof x.note === 'string' && x.note.trim() ? x.note.trim().slice(0, 2000) : null;
    return { page: x.page, verdict: x.verdict, issues, ...(note ? { note } : {}) };
  });
}
