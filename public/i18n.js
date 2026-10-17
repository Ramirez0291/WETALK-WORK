import messages from './locales/en.js';

const STORAGE_KEY = 'wetalk.language';
const supported = new Set(['zh-CN', 'en']);
let saved;
try { saved = globalThis.localStorage?.getItem(STORAGE_KEY); } catch {}
let language = supported.has(saved) ? saved : /^zh\b/i.test(globalThis.navigator?.language || 'zh-CN') ? 'zh-CN' : 'en';

export const getLanguage = () => language;
export function setLanguage(value) {
  if (!supported.has(value)) return;
  language = value;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, language); } catch {}
}

// Only source-code literals enter the translator. Interpolated values (including
// posts, names, notebook text and CLI output) are inserted AFTER translation.
function translateSegment(source) {
  if (language !== 'en') return source;
  const tokens = [];
  const key = source.trim().replace(/\uE000\d+\uE001/g, token => `{${tokens.push(token) - 1}}`);
  if (!Object.hasOwn(messages, key)) return source;
  const translated = messages[key].replace(/\{(\d+)\}/g, (match, index) => tokens[index] ?? match);
  return source.slice(0, source.length - source.trimStart().length) + translated + source.slice(source.trimEnd().length);
}

function translateLiteral(source) {
  return source.split(/(<[^>]*>)/g).map(part => part.startsWith('<')
    ? part.replace(/((?:title|placeholder|aria-label)=")([^"]*)(")/g, (_, before, value, after) => before + translateSegment(value) + after)
    : translateSegment(part)).join('');
}

export function t(source, ...values) {
  if (typeof source === 'string') return translateLiteral(source);
  const literal = source.map((part, index) => part + (index < values.length ? `\uE000${index}\uE001` : '')).join('');
  return translateLiteral(literal).replace(/\uE000(\d+)\uE001/g, (_, index) => String(values[index]));
}

// Only HTTP validation errors use these patterns. Raw invocation logs and
// generated discussion messages are deliberately left in their original form.
export function translateError(message) {
  const patterns = [
    [/^缺少 (.+)$/, ['缺少 ', '']],
    [/^(.+) 必须是字符串$/, ['', ' 必须是字符串']],
    [/^(.+) 不能为空$/, ['', ' 不能为空']],
    [/^(.+) 超过 (\d+) 字$/, ['', ' 超过 ', ' 字']],
    [/^(.+) 必须是字符串或 null$/, ['', ' 必须是字符串或 null']],
    [/^议题 #(\d+) 不存在$/, ['议题 #', ' 不存在']],
    [/^记忆空间 (.+) 不存在$/, ['记忆空间 ', ' 不存在']],
    [/^choice 只能是 (.+)$/, ['choice 只能是 ', '']],
    [/^记忆本已被更新：你读的是第 (\d+) 版，现在是第 (\d+) 版，请重新读取后再写$/, ['记忆本已被更新：你读的是第 ', ' 版，现在是第 ', ' 版，请重新读取后再写']],
  ];
  for (const [pattern, source] of patterns) {
    const match = message.match(pattern);
    if (match) return t(source, ...match.slice(1));
  }
  return t(message);
}

// Lookup tables are translated on access, so they also update without a reload.
export const localized = labels => new Proxy(labels, {
  get(target, key) { return Object.hasOwn(target, key) ? t(target[key]) : target[key]; },
});

// Register only the original HTML shell, before any runtime/user content is
// rendered. Reuse original text on every switch; never scan the live discussion.
export function initStaticTranslations(root = document) {
  const entries = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('script, style, [data-no-i18n]')) continue;
    if (/\p{Script=Han}/u.test(node.data)) entries.push({ node, original: node.data });
  }
  for (const node of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const original = node.getAttribute(attribute);
      if (original && /\p{Script=Han}/u.test(original)) entries.push({ node, attribute, original });
    }
  }
  return () => {
    document.documentElement.lang = language;
    for (const {node, attribute, original} of entries) {
      if (!node.isConnected) continue;
      if (attribute) node.setAttribute(attribute, t(original));
      else node.data = t(original);
    }
  };
}
