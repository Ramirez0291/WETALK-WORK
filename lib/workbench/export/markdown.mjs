// 幻灯片源 → Markdown（WP7）。每页一节：标题、正文（论断编号写成脚注）、讲者备注；
// 文末“依据”列出每条论断的原文与出处，从 Markdown 也能追溯到来源。非事实标记不出现在成品里。
import { CLAIM_TOKEN } from '../modes.mjs';
import { NONFACT, paragraphsOf } from './deck.mjs';

const GROUP_RE = new RegExp(`[〔［\\[（(]\\s*(${CLAIM_TOKEN}(?:\\s*[、,，;；]\\s*${CLAIM_TOKEN})*)\\s*[〕］\\]）)]`, 'g');
const TOKEN_RE = new RegExp(CLAIM_TOKEN, 'g');

// 正文里的编号 → 脚注引用（键带上这一页绑定的版本：C001@1）；一组编号连写成几个脚注
function footnoted(raw, bound) {
  const marks = [];
  const keep = (ids) => {
    marks.push(ids.map((id) => `[^${bound.has(id) ? `${id}@${bound.get(id)}` : id}]`).join(''));
    return `\u0000${marks.length - 1}\u0000`;
  };
  return String(raw)
    .replace(GROUP_RE, (_, inner) => keep(inner.match(TOKEN_RE)))
    .replace(TOKEN_RE, (id) => keep([id]))
    .split(NONFACT).join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\u0000(\d+)\u0000/g, (_, i) => marks[i])
    .trim();
}

// claimInfo(ref) → { text, sources: [{ title, locator, quote }] }
export function renderMarkdown({ title, slides, claimInfo, at }) {
  const out = [`# ${title}`, '', `> 导出时间：${at}；共 ${slides.length} 页。脚注是论断编号，文末“依据”列出原文与出处。`, ''];
  const used = new Map();
  slides.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, '');
    let prev = null;
    const bound = new Map((s.claims ?? []).map((c) => [c.id, c.version]));
    for (const p of paragraphsOf(s.body)) {
      const text = footnoted(p.raw, bound);
      if (!text) continue;
      // 普通段落之间、段落与要点列表之间空一行（Markdown 里相邻的行会并成一段）
      if (prev && (!p.bullet || !prev.bullet)) out.push('');
      out.push(p.bullet ? `${'  '.repeat(p.level)}- ${text}` : text);
      prev = p;
    }
    out.push('');
    if (String(s.notes ?? '').trim()) out.push(...String(s.notes).trim().split(/\r?\n/).map((l) => `> ${l}`), '');
    for (const c of s.claims ?? []) used.set(`${c.id}@${c.version}`, c);
  });
  if (used.size) {
    out.push('---', '', '## 依据', '');
    for (const [key, ref] of [...used].sort((a, b) => a[0].localeCompare(b[0]))) {
      const info = claimInfo(ref); // 按引用的版本
      const srcs = (info?.sources ?? []).map((x) => `${x.title}${x.locator ? `，${x.locator}` : ''}${x.quote ? `：“${x.quote}”` : ''}`).join('；');
      out.push(`[^${key}]: ${key} ${info?.text ?? ''}${srcs ? ` —— ${srcs}` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}
