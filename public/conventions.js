// 项目约定（project.md）的分节：页面上按节编辑，Agent 起草的草案按节合并。服务端与页面共用这一份（不碰 DOM）。
// 节 = 二级标题（## ）到下一个二级标题之间的内容；第一个二级标题之前是开头（总标题、建立日期、说明）。
// 开头加各节首尾相接就是原文，一个字符都不差：只改动的那几节变，其余原样保留。

const HEAD_RE = /^##[ \t]+(.+?)[ \t#]*$/;
// 模板里的引导语：整行是全角括号里的一句说明，或以 > 开头的说明
const HINT_RE = /^\s*（.*）\s*$/;

export function parseConventions(md) {
  const text = String(md ?? '');
  const lines = text.split('\n');
  const sections = [];
  let head = '';
  let cur = null;
  let fence = false;
  for (const [i, line] of lines.entries()) {
    const piece = i < lines.length - 1 ? `${line}\n` : line;
    const l = line.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && l.match(HEAD_RE);
    if (m) {
      cur = { title: m[1].trim(), heading: piece, body: '' };
      sections.push(cur);
    } else if (cur) cur.body += piece;
    else head += piece;
  }
  return { head, sections };
}

export function joinConventions({ head, sections }) {
  return head + sections.map((s) => s.heading + s.body).join('');
}

// 一节里的引导语（原样未改的提示行），页面上用作输入框的占位提示
export const hintsOf = (body) => String(body).split(/\r?\n/).filter((l) => HINT_RE.test(l)).map((l) => l.trim());

// 一节的正文：去掉引导语，去掉首尾空行
export function contentOf(body) {
  return String(body).split(/\r?\n/).filter((l) => !HINT_RE.test(l)).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
}

// 页面上改了一节之后写回：正文为空时放回引导语，免得文件里只剩一个标题
export function bodyFrom(content, hints = []) {
  const c = String(content ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const text = c || hints.join('\n');
  return text ? `\n${text}\n\n` : '\n';
}

// 还没填的节：去掉引导语和空的列表项后什么都没有（empty），或有“键：”后面没写值的行（blank：列出这些键）
export function missingOf(md) {
  const out = [];
  for (const s of parseConventions(md).sections) {
    const lines = contentOf(s.body).split('\n').map((l) => l.trim()).filter(Boolean);
    const real = lines.filter((l) => !/^(?:[-*•]|\d+[.、)])\s*(?:\[[ xX]\]\s*)?$/.test(l));
    if (!real.length) {
      out.push({ title: s.title, kind: 'empty' });
      continue;
    }
    const blank = real.map((l) => l.match(/^(?:[-*•]\s*)?([^：:]{1,20})[：:]\s*$/)?.[1]).filter(Boolean);
    if (blank.length) out.push({ title: s.title, kind: 'blank', fields: blank });
  }
  return out;
}

// 把草案（{ 节标题: 正文 }）合并进约定：只替换草案里写了、约定里也有的节，其余原样保留
export function mergeSections(md, draft) {
  const doc = parseConventions(md);
  for (const s of doc.sections) {
    const v = draft?.[s.title];
    if (typeof v === 'string' && v.trim()) s.body = bodyFrom(v, hintsOf(s.body));
  }
  return joinConventions(doc);
}
