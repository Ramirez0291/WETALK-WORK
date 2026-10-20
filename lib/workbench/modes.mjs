// 工作方式（WP5）：各任务类型的提示词模板（输出要求）与结果解析。提示词模板随这里维护。
// 5a：对抗核验（verify_claim）、补证（find_evidence）。
// 5b：竞争起草（compete 方式的任务）、匿名评审（anonymous_review）的输出要求；方案分节、评审意见的定位检查、
//     移植补丁的检查与应用（书记）。分工的拆分在 divide.mjs，竞争的流程在 compete.mjs。
import { WorkbenchError } from './project.mjs';
import { locateQuote } from './records.mjs';
import { PLAN_OUTPUT } from './export/plan.mjs';
import { REVIEW_OUTPUT } from './export/review.mjs';

// 任务类型 → 输出要求（替换 visibility.mjs 里按可见性给的通用要求）
export const TASK_OUTPUT = {
  export: PLAN_OUTPUT,
  render_review: REVIEW_OUTPUT,
  verify_claim: `你的角色：对抗核验者。你和论断的作者来自不同厂商，任务是找反例和证据缺口，而不是替论断辩护。
核验规则：
- 只根据上面给出的来源正文判断，不要用你自己的知识补充证据；正文里找不到支持的原文，就判 unsupported（证据不足也算）。
- 引文出现在来源里不等于支持结论。例如来源写“没有证据表明 A 导致 B”，论断写“A 导致 B”，应判 unsupported。
- 文献记载类论断（textual）还要核对“最早出处”是否被来源支持，警惕把晚出的记载说成更早的传说。
- 判为 supported 时，support_quote 必须是来源正文里逐字出现的一段，并写明来源编号和版本。
- 发现三类事实性问题时另提异议：来源不存在（source_missing）、数字错误（number_error）、引文不支持结论（quote_unsupported）。
  能在来源正文里定位到原文的，state 写 open，pointer 写 {"type":"quote","source":{"id":"S001","version":1},"quote":"原文"}；
  发现了问题但定位不到原文的，state 写 needs_evidence，pointer 写 {"type":"location","locator":"问题所在的位置描述"}。
  解释争议（interpretation）、叙事选择（narrative）、可选扩展（extension）也可以提，不阻塞。
输出格式：只输出一个 \`\`\`json 代码块，内容是一个对象：
{"verdict":"supported 或 unsupported","reason":"理由","support_quote":{"id":"S001","version":1,"quote":"逐字原文","locator":"可选的位置"},"objections":[{"category":"number_error","pointer":{…},"reason":"问题在哪里","state":"open"}]}
判 unsupported 时不写 support_quote；没有异议时 objections 写空数组。`,

  find_evidence: `输出要求：
- 只在上面给出的来源正文里找，不要用你自己的知识，也不要编造引文。
- 找到了能定位的原文：输出一个 \`\`\`json 代码块，内容是提交入口的 changes 数组，只含一项：把异议改为 open 并补上有效指针，例如
  [{"id":"O001","expected_version":1,"data":{"target":{…原样…},"category":"…原样…","pointer":{"type":"quote","source":{"id":"S001","version":1},"quote":"逐字原文"},"reason":"…原样或补充…","state":"open"}}]
  expected_version 写异议的当前版本；target、category 不能改。
- 找不到：不要输出 json 代码块，直接说明你查了哪些来源、为什么定位不到。`,
};

TASK_OUTPUT.anonymous_review = `你的角色：匿名评审。下面的方案用随机标签（方案甲、方案乙……）表示，你不知道作者，也不要猜测。
评审规则：
- 逐条写意见，每条必须指向具体位置：某个方案的第几节（节号见每节标题后面的〔第 n 节〕，没有标题的方案全文算第 1 节），或该方案里出现的论断编号（如 C007）。
- 没有指向具体位置的意见会被退回、不予采用；总体评价也要落到具体的节。
- 写清问题和理由；可以指出某个方案里值得保留、可以移植到别的方案的内容（同样写明位置）。
输出格式：输出一个 \`\`\`json 代码块，内容是数组，每项一条意见：
[{"draft":"方案甲","section":2,"comment":"问题和理由"},{"draft":"方案乙","claim":"C007","comment":"问题和理由"}]
（不用 json 也可以：每行一条，写成“方案甲 第 2 节：问题和理由”。）`;

// 观众型读者（WP6：标出的不懂处数量是停滞检测的质量指标之一，所以要能数得出来）
TASK_OUTPUT.audience_reader = `你的角色：第一次看到这份材料的观众。只根据给你的材料回答，不要查找资料。
输出一个 \`\`\`json 代码块：
{"restatement":["用你自己的话复述的核心观点，3 条以内"],"confusions":[{"where":"第几页或哪一段","issue":"哪里看不懂、觉得跳跃或有疑问"}]}
没有看不懂的地方时 confusions 写空数组。`;

// 观众型读者标出的不懂处数量：json 代码块里的 confusions；没有 json 时，数“看不懂”那一段之后的列表项
export function audienceConfusions(raw) {
  const m = String(raw).match(/```json\s*\n([\s\S]*?)```/i);
  if (m) {
    try {
      const v = JSON.parse(m[1]);
      if (Array.isArray(v?.confusions)) return v.confusions.length;
    } catch {}
  }
  const lines = String(raw).split(/\r?\n/);
  const start = lines.findIndex((l) => /看不懂|不懂|跳跃|疑问|confus/i.test(l));
  if (start < 0) return 0;
  return lines.slice(start + 1).filter((l) => /^\s*(?:[-*•]|\d+[.、)])\s*\S/.test(l)).length;
}

// 竞争方式的任务（选题角度、大纲、核心解释）：密封起草
const COMPETE_OUTPUT = `你的角色：竞争起草者之一。你独立完成自己的方案；你看不到其他人的方案，也不要猜测或提及它们。
输出要求：
- 直接输出 Markdown 正文，不要输出 json 代码块。
- 用二级标题（## ）分节，一节一个标题：评审会按“第几节”指出问题，选定后落选方案里值得保留的内容也按节移植。
- 提到输入里的论断时写它的编号（如 C007），只引用输入里给出的论断；不要编造来源、引文或数字。
- 不要在正文里署名，也不要写你是谁、用的什么模型。`;

export const outputFor = (task) => TASK_OUTPUT[task.type] ?? (task.mode === 'compete' ? COMPETE_OUTPUT : null);

// ---------- 竞争：方案的分节 ----------
// 方案是 Markdown。节的标题级别：最小的标题级别；它只出现一次、又是第一个标题（总标题）时取下一级。
// 第一个节标题之前的内容是前言（不编号）；没有标题时全文算第 1 节。代码块里的 # 不算标题。
// 前言加各节正文首尾相接就是原文，一个字符都不差（书记据此只插入、不改动胜出方案）。
export function sectionsOf(text) {
  const heads = [];
  let fence = false;
  let at = 0;
  for (const line of text.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence) {
      const m = l.match(/^(#{1,6})[ \t]+(.*?)[ \t#]*$/);
      if (m && m[2]) heads.push({ at, level: m[1].length, title: m[2] });
    }
    at += line.length + 1;
  }
  if (!heads.length) return { level: null, preamble: '', sections: text.trim() ? [{ n: 1, title: null, text }] : [] };
  const counts = new Map();
  for (const h of heads) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const level = counts.get(levels[0]) === 1 && heads[0].level === levels[0] && levels.length > 1 ? levels[1] : levels[0];
  const starts = heads.filter((h) => h.level === level);
  return {
    level,
    preamble: text.slice(0, starts[0].at),
    sections: starts.map((h, i) => ({ n: i + 1, title: h.title, text: text.slice(h.at, i + 1 < starts.length ? starts[i + 1].at : text.length) })),
  };
}

// 给评审看的方案：每节标题后面标上〔第 n 节〕，节号与程序检查时一致
export function numberSections(text) {
  const { preamble, sections } = sectionsOf(text);
  if (!sections.length || sections[0].title === null) return text;
  return preamble + sections.map((s) => s.text.replace(/^([^\n]*?)(\r?\n|$)/, (m, head, nl) => `${head} 〔第 ${s.n} 节〕${nl}`)).join('');
}

// 正文里出现的论断编号：按完整编号匹配，两侧不能紧挨字母或数字（C100 不会被当成 C1000 的一部分），按出现先后去重。
// 评审位置检查和作品的论断绑定都用这一条规则
export const CLAIM_TOKEN = '(?<![A-Za-z0-9])C\\d{3,6}(?![A-Za-z0-9])';
export function claimIdsIn(text) {
  return [...new Set([...String(text).matchAll(new RegExp(CLAIM_TOKEN, 'g'))].map((m) => m[0]))];
}

// 作品正文里提到的论断，按竞争固定的“可引用论断”绑定版本（citable：[{id, version}]，来自输入里的论断，
// 以及输入作品里引用的论断，版本按输入快照，不用当前最新版）。对不上可引用论断的编号放进 unknown，由调用方明确拒绝，不静默省略
export function bindClaims(text, citable) {
  const given = new Map(citable.map((c) => [c.id, c.version]));
  const ids = claimIdsIn(text);
  return { refs: ids.filter((id) => given.has(id)).map((id) => ({ id, version: given.get(id) })), unknown: ids.filter((id) => !given.has(id)) };
}

// ---------- 匿名评审：意见必须指向具体位置 ----------
// 每条意见要指向某个方案的第几节（或第几页，按节计），或该方案里出现、项目里存在的论断编号。
// 指不到位置的意见退回（保留原文与原因），不交给主持人。
const LABEL = '方案[甲乙丙丁戊己]';
const LOC_RE = new RegExp(`(${LABEL})\\s*[·・,，、的]?\\s*(?:第\\s*(\\d+)\\s*([节页])|§\\s*(\\d+)|(${CLAIM_TOKEN}))`);
const LABEL_ONLY = new RegExp(LABEL);

function jsonBlock(raw) {
  const m = raw.match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) return { found: false };
  try {
    return { found: true, value: JSON.parse(m[1]) };
  } catch (e) {
    return { found: true, error: e.message };
  }
}

// drafts：{ 方案甲: 正文, … }；claimExists(id)：项目里有没有这条论断
export function parseReview(raw, { drafts, claimExists = () => false }) {
  const comments = [];
  const returned = [];
  const sectionCount = (label) => sectionsOf(drafts[label]).sections.length;
  const take = (source, c) => {
    const text = typeof c.comment === 'string' ? c.comment.trim() : '';
    const why = (() => {
      if (!c.draft) return '没有指向具体位置（方案和节、页或论断编号）';
      if (!Object.hasOwn(drafts, c.draft)) return `没有${c.draft}`;
      if (c.section != null) {
        const n = Number(c.section);
        const total = sectionCount(c.draft);
        if (!Number.isInteger(n) || n < 1 || n > total) return `${c.draft}没有第 ${c.section} ${c.unit ?? '节'}（共 ${total} 节）`;
        return null;
      }
      if (c.claim != null) {
        if (!claimExists(c.claim)) return `论断 ${c.claim} 不存在`;
        if (!claimIdsIn(drafts[c.draft]).includes(c.claim)) return `${c.draft}里没有提到 ${c.claim}`;
        return null;
      }
      return '没有指向具体位置（节、页或论断编号）';
    })();
    if (why) return returned.push({ text: String(source).slice(0, 500), reason: why });
    if (text.replace(/[\s\p{P}]/gu, '').length < 2) return returned.push({ text: String(source).slice(0, 500), reason: '只有位置，没有写问题和理由' });
    const where = c.section != null ? `${c.draft} 第 ${Number(c.section)} ${c.unit ?? '节'}` : `${c.draft} ${c.claim}`;
    comments.push({ draft: c.draft, ...(c.section != null ? { section: Number(c.section) } : { claim: c.claim }), where, comment: text.slice(0, 2000) });
  };
  // 从一段文字里认出“方案甲 第 2 节”“方案乙 C007”这样的位置
  const fromText = (s) => {
    const m = s.match(LOC_RE);
    if (!m) return { draft: s.match(LABEL_ONLY)?.[0] ?? null, comment: s };
    const section = m[2] ?? m[4] ?? null;
    return { draft: m[1], section, unit: m[3] ?? '节', claim: section ? null : m[5], comment: s.slice(m.index + m[0].length).replace(/^[\s：:，,、。.—–-]+/, '') || s.slice(0, m.index) };
  };

  const block = jsonBlock(raw);
  if (block.found && Array.isArray(block.value)) {
    for (const x of block.value) {
      if (!x || typeof x !== 'object') {
        returned.push({ text: JSON.stringify(x).slice(0, 500), reason: '不是一条意见对象' });
        continue;
      }
      const page = x.page != null && x.section == null;
      let c = { draft: typeof x.draft === 'string' ? x.draft.trim() : null, section: x.section ?? x.page ?? null, unit: page ? '页' : '节', claim: typeof x.claim === 'string' ? x.claim.trim() : null, comment: x.comment };
      if (c.section == null && !c.claim && typeof x.location === 'string') {
        const t = fromText(`${c.draft ?? ''} ${x.location}`);
        c = { ...t, comment: x.comment };
      }
      take(JSON.stringify(x), c);
    }
    return { comments, returned };
  }
  if (block.found) returned.push({ text: '（json 代码块）', reason: block.error ? `json 代码块解析失败：${block.error}` : 'json 代码块不是数组' });
  // 逐行：每行一条。空行、Markdown 标题、代码块不算意见
  let fence = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    const s = line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim();
    if (fence || !s || /^#{1,6}\s/.test(s)) continue;
    if (/[:：]$/.test(s) && !LABEL_ONLY.test(s)) continue; // “以下是评审意见：”这类引导语
    take(line.trim(), fromText(s));
  }
  return { comments, returned };
}

// ---------- 移植补丁与书记 ----------
// 补丁：把落选方案里的一节（或其中逐字的一段）移到胜出方案（底稿）的某一节前后、节首节尾，或整节替换。
// 补丁只搬运落选方案的原文，书记只应用已接受的补丁：底稿原文一个字不改（替换的那一节除外，替换同样要经你接受）。
// 节号一律按底稿原来的分节计，多条补丁之间互不影响位置。
export const PATCH_POSITIONS = ['before', 'after', 'start', 'end', 'replace'];
export const POSITION_LABEL = { before: '插到这一节之前', after: '插到这一节之后', start: '放进这一节开头', end: '放进这一节末尾', replace: '整节替换' };

// 补丁要搬运的原文：给了 quote 就是那一节里逐字的那一段（取原文里的确切字符），否则是整节
export function patchContent(from, sourceText) {
  const sec = sectionsOf(sourceText).sections[from.section - 1];
  if (!sec) return null;
  if (from.quote == null) return sec.text;
  const hit = locateQuote(sec.text, from.quote);
  return hit ? sec.text.slice(hit.index, hit.index + hit.length) : null;
}

// 检查一条补丁能否应用；能应用返回 null，否则返回原因。sources：{ 方案乙: 正文 }（落选方案）
export function checkPatch(p, { base, sources }) {
  if (!p?.from || !p?.to) return '补丁要写明 from（落选方案的哪一节）和 to（底稿的哪一节、放在哪）';
  if (!Object.hasOwn(sources, p.from.draft)) return `${p.from.draft ?? '（没写方案）'}不是落选方案`;
  const src = sectionsOf(sources[p.from.draft]).sections;
  if (!Number.isInteger(p.from.section) || p.from.section < 1 || p.from.section > src.length) return `${p.from.draft}没有第 ${p.from.section} 节（共 ${src.length} 节）`;
  if (p.from.quote != null && (typeof p.from.quote !== 'string' || !p.from.quote.trim())) return 'quote 不能为空';
  if (patchContent(p.from, sources[p.from.draft]) == null) return `${p.from.draft} 第 ${p.from.section} 节里找不到这段原文`;
  const total = sectionsOf(base).sections.length;
  if (!Number.isInteger(p.to.section) || p.to.section < 1 || p.to.section > total) return `底稿没有第 ${p.to.section} 节（共 ${total} 节）`;
  if (!PATCH_POSITIONS.includes(p.to.position)) return `position 只能是 ${PATCH_POSITIONS.join(' / ')}`;
  return null;
}

// 两条补丁能否同时应用：整节替换的那一节，不能再有别的替换或节首、节尾插入
export function patchConflict(p, accepted) {
  for (const q of accepted) {
    if (q.to.section !== p.to.section) continue;
    const inside = ['start', 'end', 'replace'];
    if ((p.to.position === 'replace' && inside.includes(q.to.position)) || (q.to.position === 'replace' && inside.includes(p.to.position))) {
      return `与已接受的补丁 ${q.id} 冲突：底稿第 ${p.to.section} 节被整节替换后，不能再有别的替换或节内插入`;
    }
  }
  return null;
}

// 书记：底稿 ＋ 已接受的补丁（按编号顺序）→ 新正文。只插入补丁搬运的原文和分隔用的空行，底稿其余字符原样保留
export function applyPatches(base, patches, sourceOf) {
  const { preamble, sections } = sectionsOf(base);
  const at = { before: new Map(), after: new Map(), start: new Map(), end: new Map(), replace: new Map() };
  for (const p of patches) {
    const content = patchContent(p.from, sourceOf(p.from.draft));
    if (content == null) throw new WorkbenchError(409, `补丁 ${p.id} 找不到要搬运的原文`);
    const m = at[p.to.position];
    if (!m.has(p.to.section)) m.set(p.to.section, []);
    m.get(p.to.section).push(content);
  }
  let out = preamble;
  const block = (c) => {
    if (out && !out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n';
    out += c.replace(/\s+$/, '') + '\n\n';
  };
  for (const s of sections) {
    for (const c of at.before.get(s.n) ?? []) block(c);
    if (at.replace.has(s.n)) {
      for (const c of at.replace.get(s.n)) block(c);
    } else {
      const starts = at.start.get(s.n) ?? [];
      const ends = at.end.get(s.n) ?? [];
      if (!starts.length && !ends.length) {
        if (out && !out.endsWith('\n')) out += '\n';
        out += s.text;
      } else {
        const nl = s.text.indexOf('\n');
        const head = s.title === null ? '' : nl < 0 ? `${s.text}\n` : s.text.slice(0, nl + 1);
        const rest = s.title === null ? s.text : nl < 0 ? '' : s.text.slice(nl + 1);
        if (out && !out.endsWith('\n')) out += '\n';
        out += head;
        for (const c of starts) block(c);
        if (rest.trim()) {
          if (starts.length && !out.endsWith('\n\n')) out += '\n';
          out += rest;
        }
        for (const c of ends) block(c);
      }
    }
    for (const c of at.after.get(s.n) ?? []) block(c);
  }
  return out;
}

// 从回复里取第一个 ```json 代码块并解析
function firstJson(raw) {
  const m = raw.match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
}

// 对抗核验的结果 → 提交入口的 changes。目标版本与来源版本取任务输入里的论断版本（不采信回复里自填的版本）。
// claim：任务输入指定版本的论断记录
export function verifyResultToChanges(raw, claim) {
  const v = firstJson(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('回复里没有核验结果对象（```json 代码块）');
  const target = { id: claim.id, version: claim.version };
  const data = {
    target,
    source_versions: (claim.sources || []).map((s) => ({ id: s.id, version: s.version })),
    verdict: v.verdict,
    reason: v.reason,
  };
  if (v.verdict === 'supported') data.support_quote = v.support_quote;
  const changes = [{ kind: 'verification', expected_version: 0, data }];
  for (const o of Array.isArray(v.objections) ? v.objections : []) {
    changes.push({ kind: 'objection', expected_version: 0, data: { target, category: o?.category, pointer: o?.pointer, reason: o?.reason, state: o?.state } });
  }
  return changes;
}

// 补证：找不到时回复里没有 json 代码块，这一次补证就此结束。只能更新任务针对的那条异议
export function evidenceResultToChanges(raw, objectionId) {
  const v = firstJson(raw);
  if (v == null) throw new Error('没有找到可定位的原文');
  if (!Array.isArray(v) || v.length !== 1) throw new Error('json 代码块必须是只含一项的 changes 数组');
  if (v[0]?.id !== objectionId) throw new WorkbenchError(400, `补证任务只能更新异议 ${objectionId}`);
  return v;
}
