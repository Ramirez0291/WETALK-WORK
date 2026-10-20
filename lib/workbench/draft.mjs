// 起草项目约定（WP8）：主持人写一段说明，派一位参与者把它整理成约定的各节。
// 草案不进正式区，也不直接写进 project.md：它只记在任务上，主持人在页面上逐节改过、点确认，才经 POST /conventions 写入。
// 草案按起草时那一版约定合并（任务输入里存着那一版），起草期间约定被改过时，页面提示草案基于旧版本。
import { parseConventions, mergeSections } from '../../public/conventions.js';

export const DRAFT_OUTPUT = `你的角色：帮主持人起草项目约定。主持人只写了一段说明（见上面的“目标”），你把它整理成约定的各节，之后的每个任务都会带上这份约定。
规则：
- 只写主持人说明里有的，或从中直接推得出的。拿不准的写成要主持人确认的问题（questions），不要替主持人做决定。
- 不要编造来源、数字或事实。约定只写受众、目标、篇幅、风格、范围这类要求，不写内容本身的结论。
- 节标题只用输入里“现在的项目约定”已有的二级标题，一字不改地照抄；不需要改的节不写。
- “观众看完后应当理解什么”写 3 条以内，每条一句话，用 1. 2. 3. 编号。
- “验收标准”是工坊的通用要求，主持人说明里没有另提要求时不要写这一节。
输出格式：只输出一个 \`\`\`json 代码块：
{"sections":{"受众":"……","观众看完后应当理解什么":"1. ……\\n2. ……","篇幅与页数":"- 形式：……\\n- 页数：……\\n- 讲述时长：……","风格":"……","不在本项目范围内":"……"},
 "questions":["要主持人确认的问题，最多 5 条"],
 "queries":["找资料时可以先搜的关键词或子题，最多 8 条"]}`;

const MAX_SECTION = 4000;
const strings = (v, n, max = 300) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, max)).slice(0, n);

// 回复 → 草案。base：起草时的约定原文。对不上约定里任何一节的标题放进 ignored，不静默丢弃
export function parseDraft(raw, base) {
  const m = String(raw).match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) throw new Error('回复里没有 ```json 代码块');
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !v.sections || typeof v.sections !== 'object' || Array.isArray(v.sections)) {
    throw new Error('json 代码块必须是 {"sections":{节标题: 正文}, …}');
  }
  const titles = new Set(parseConventions(base).sections.map((s) => s.title));
  const sections = {};
  const ignored = [];
  for (const [title, text] of Object.entries(v.sections)) {
    const t = title.trim();
    if (!titles.has(t)) ignored.push(t);
    else if (typeof text === 'string' && text.trim()) sections[t] = text.trim().slice(0, MAX_SECTION);
  }
  if (!Object.keys(sections).length) throw new Error(`草案里没有能对上约定的节（约定的节：${[...titles].join('、')}）`);
  return {
    sections,
    ignored,
    questions: strings(v.questions, 5),
    queries: strings(v.queries, 8, 200),
    conventions: mergeSections(base, sections),
  };
}
