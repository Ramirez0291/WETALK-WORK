// 幻灯片源与结构检查（WP7）。幻灯片源：slides/ 下每页一条记录（title、body、notes、order、claims）。
// 正文的约定：每个句子要么带论断编号（C001；可以单写，也可以写在〔〕［］[]（）() 里，几个编号用顿号或逗号隔开），
// 要么标为非事实（〔非事实〕，写在句首或句尾）。编号要在这一页的 claims 里，按那里写的版本绑定。
// 导出时编号和标记从页面上去掉：PPTX 里编号挪进讲者备注（“依据”），Markdown 里写成脚注。
// 结构检查（程序）：每个句子带编号或标为非事实；引用的论断全部可进入成品且是当前版本；正文字数不超上限；备注不为空。
import { CLAIM_TOKEN } from '../modes.mjs';

export const NONFACT = '〔非事实〕';
const TOKEN_RE = new RegExp(CLAIM_TOKEN, 'g');
// 只装着论断编号的一对括号：整组去掉
const GROUP_RE = new RegExp(`[〔［\\[（(]\\s*${CLAIM_TOKEN}(?:\\s*[、,，;；]\\s*${CLAIM_TOKEN})*\\s*[〕］\\]）)]`, 'g');
const BULLET_RE = /^(\s*)(?:[-*•・]|\d{1,2}[.、)])\s+/;

const ids = (s) => [...new Set([...String(s).matchAll(TOKEN_RE)].map((m) => m[0]))];

// 去掉编号与非事实标记，只留页面上要显示的文字
export function cleanText(s) {
  return String(s).replace(GROUP_RE, '').replace(TOKEN_RE, '').split(NONFACT).join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+([。！？!?；;，,、])/g, '$1').trim();
}

// 正文 → 段落：[{ text（显示用）, raw（原文）, level }]。“- ”开头为要点，缩进两格为下一级
export function paragraphsOf(body) {
  const out = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(BULLET_RE);
    const level = m ? Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) : 0;
    const raw = (m ? line.slice(m[0].length) : line).replace(/^#+\s*/, '').trim();
    const text = cleanText(raw);
    if (text || raw) out.push({ text, raw, level, bullet: !!m });
  }
  return out;
}

// 句子边界：中文的句末标点（。！？；）一律断开；英文的 . ! ? ; 后面跟空白或到段末才断（1.5、e.g. 这类不断）。
// 句末标点后面紧跟的右引号、右括号算这一句
const CJK_END = '。！？；';
const ASCII_END = '.!?;';
const CLOSERS = '"\'”’」』）)】]';
const ABBR_RE = /(?:^|[\s(（"“])(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|Prof|No|Fig|St|Jr|Sr|[A-Z])\.$/;
function splitSentences(text) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!CJK_END.includes(ch) && !ASCII_END.includes(ch)) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.includes(text[end])) end++;
    if (ASCII_END.includes(ch)) {
      if (end < text.length && !/\s/.test(text[end])) continue; // 1.5、a.b
      if (ch === '.' && ABBR_RE.test(text.slice(start, i + 1))) continue; // e.g.、Dr.、单个大写字母的缩写
    }
    parts.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

// 一段话 → 句子。句末标点之后紧跟的编号（“……。（C001）”“… 1200. (C001)”）归前一句；
// 〔非事实〕写在句首（属于后一句）或句末标点之前、段末（属于前一句）
const LEAD_RE = new RegExp(`^(?:\\s*(?:${GROUP_RE.source}|${TOKEN_RE.source}))+\\s*`);
export function sentencesOf(raw) {
  const out = [];
  for (let part of splitSentences(String(raw))) {
    const lead = out.length ? part.match(LEAD_RE)?.[0] : null;
    if (lead) {
      out[out.length - 1] += lead;
      part = part.slice(lead.length);
    }
    if (!part.trim()) continue;
    if (!/[\p{L}\p{N}]/u.test(cleanText(part))) { // 只剩标点：归前一句
      if (out.length) out[out.length - 1] += part;
      continue;
    }
    out.push(part);
  }
  return out;
}

// 显示的字数：去掉编号、标记和空白
export const charCount = (body) => [...paragraphsOf(body).map((p) => p.text).join('').replace(/\s+/g, '')].length;

// 全部幻灯片按 order、再按编号排好
export function deckSlides(gateway, project) {
  return gateway.listRecords(project, 'slide').map((x) => x.record)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
}

const issue = (level, code, message, extra = {}) => ({ level, code, message, ...extra });

// 全部正式记录与派生状态（一次取完：列表里每份导出都要按当前状态重算）
export const recordsOf = (gateway, project) => new Map(gateway.listRecords(project).map((x) => [x.record.id, x]));

// 结构检查。slides：要检查的幻灯片记录；maxChars：每页正文字数上限；records：recordsOf 的结果（不给就现取）。
// 论断能否进入成品、页面有没有阻塞，都按此刻的派生状态（新增异议、新的核验不改版本，也会反映出来）
export function checkStructure({ gateway, project, slides, maxChars, records = null }) {
  const all = records ?? recordsOf(gateway, project);
  const result = slides.map((s) => {
    const issues = [];
    const st = all.get(s.id)?.status ?? { freshness: 'stale', stale_reasons: [{ id: s.id }], blockers: [] };
    if (st.freshness !== 'current') issues.push(issue('error', 'slide_stale', `这一页引用的记录已经改版（${st.stale_reasons.map((r) => r.id).filter(Boolean).join('、') || '上游变化'}），先更新这一页`));
    if (st.blockers.length) issues.push(issue('error', 'slide_blocked', `这一页有未解决的阻塞异议：${st.blockers.join('、')}`));
    const bound = new Map((s.claims ?? []).map((c) => [c.id, c.version]));
    const cited = new Set();
    paragraphsOf(s.body).forEach((p, pi) => {
      for (const sentence of sentencesOf(p.raw)) {
        const found = ids(sentence);
        for (const id of found) {
          cited.add(id);
          if (!bound.has(id)) issues.push(issue('error', 'claim_unbound', `正文提到 ${id}，但这一页的 claims 里没有它（编号要按版本绑定）`, { claim: id }));
        }
        if (!found.length && !sentence.includes(NONFACT)) {
          issues.push(issue('error', 'untagged', `第 ${pi + 1} 段有句子既没有论断编号，也没标${NONFACT}：「${cleanText(sentence).slice(0, 40)}」`, { sentence: cleanText(sentence).slice(0, 200) }));
        }
      }
    });
    for (const [id, version] of bound) {
      const rec = all.get(id);
      if (!rec) {
        issues.push(issue('error', 'claim_missing', `引用的 ${id} 不存在`, { claim: id }));
        continue;
      }
      if (rec.record.version !== version) issues.push(issue('error', 'claim_outdated', `引用的是 ${id} 第 ${version} 版，现在是第 ${rec.record.version} 版`, { claim: id }));
      else if (!rec.status.ready) {
        const v = rec.status.verification;
        const why = rec.status.blockers.length ? `有阻塞异议 ${rec.status.blockers.join('、')}`
          : rec.status.freshness !== 'current' ? '来源已改版，待重新核验'
            : v?.state === 'supported' ? `核验份数不够（${v.independent}/${v.required}）` : `核验状态为 ${v?.state ?? '未知'}`;
        issues.push(issue('error', 'claim_not_ready', `${id} 还不能进入成品：${why}`, { claim: id }));
      }
      if (!cited.has(id)) issues.push(issue('warn', 'claim_unused', `${id} 在 claims 里，但正文没有哪句话引用它`, { claim: id }));
    }
    const chars = charCount(s.body);
    if (chars > maxChars) issues.push(issue('error', 'too_long', `正文 ${chars} 字，超过每页上限 ${maxChars} 字（不含讲者备注）`));
    if (!String(s.notes ?? '').trim()) issues.push(issue('error', 'no_notes', '讲者备注为空'));
    return { id: s.id, version: s.version, title: s.title, chars, issues };
  });
  const errors = result.reduce((n, s) => n + s.issues.filter((i) => i.level === 'error').length, 0);
  const warnings = result.reduce((n, s) => n + s.issues.filter((i) => i.level === 'warn').length, 0);
  return { ok: errors === 0, max_chars: maxChars, errors, warnings, slides: result };
}

// 每页讲者备注末尾的标记：读回 PPTX 时据此核对页序、版本和引用的论断
export const slideMark = (s) => `〔${s.id}@${s.version}${s.claims?.length ? ` · 依据 ${s.claims.map((c) => `${c.id}@${c.version}`).join('、')}` : ''}〕`;

// 交给 pptx.py 的幻灯片源：只放页面上显示的文字；备注后面附依据（论断原文摘要）与标记
export function deckSpec({ title, slides, claimText }) {
  return {
    title,
    slides: slides.map((s) => {
      const basis = (s.claims ?? []).map((c) => `${c.id}：${String(claimText(c) ?? '').slice(0, 120)}`);
      const notes = [String(s.notes ?? '').trim(), basis.length ? `依据：\n${basis.join('\n')}` : '', slideMark(s)].filter(Boolean).join('\n\n');
      return {
        id: s.id, version: s.version, title: s.title, claims: (s.claims ?? []).map((c) => ({ id: c.id, version: c.version })),
        paragraphs: paragraphsOf(s.body).map(({ text, level, bullet }) => ({ text, level, bullet })), notes,
      };
    }),
  };
}

// 读回核对：页数、每页的标题与正文、备注不为空、备注里的标记（页序、版本、论断编号）
export function checkReadback(spec, readback) {
  const issues = [];
  if (readback.slides.length !== spec.slides.length) issues.push({ level: 'error', code: 'page_count', message: `PPTX 有 ${readback.slides.length} 页，幻灯片源有 ${spec.slides.length} 页` });
  const norm = (s) => String(s ?? '').replace(/\s+/g, '');
  spec.slides.forEach((s, i) => {
    const got = readback.slides[i];
    if (!got) return;
    const page = i + 1;
    if (norm(got.title) !== norm(s.title)) issues.push({ level: 'error', code: 'title_mismatch', page, slide: s.id, message: `第 ${page} 页标题读回为「${String(got.title).slice(0, 40)}」` });
    const want = norm(s.paragraphs.map((p) => p.text).join(''));
    if (norm(got.body) !== want) issues.push({ level: 'error', code: 'body_mismatch', page, slide: s.id, message: `第 ${page} 页正文读回与幻灯片源不一致` });
    if (!norm(got.notes)) issues.push({ level: 'error', code: 'notes_missing', page, slide: s.id, message: `第 ${page} 页讲者备注为空` });
    if (!String(got.notes).includes(slideMark(s))) issues.push({ level: 'error', code: 'mark_missing', page, slide: s.id, message: `第 ${page} 页备注里没有 ${slideMark(s)} 标记（页序、版本或论断编号对不上）` });
  });
  return { ok: !issues.some((x) => x.level === 'error'), issues };
}
