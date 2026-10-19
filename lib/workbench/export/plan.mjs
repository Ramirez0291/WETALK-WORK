// 指定 Agent 负责导出（WP7）：Agent 不给工具、不写文件，只按幻灯片源、模板的版式清单和 skill 回一份版式方案
// （每页用模板里的哪个版式）；PPTX 由脚本照方案生成，再走同样的结构检查、读回核对与渲染检查。
// 契约四的实测结论：给命令行 Agent 工具后，工作目录不构成隔离，所以导出也不给工具。

import { blobStore } from '../records.mjs';
import { WorkbenchError } from '../project.mjs';

export const LAYOUTS_INPUT = '模板版式清单.json';
export const SKILL_INPUT_PREFIX = 'skill-';

export const PLAN_OUTPUT = `你的角色：排版助手。你不改写内容，只决定每一页用模板里的哪个版式。
输入：幻灯片（按顺序，每页一条记录，含标题、正文、讲者备注）、「${LAYOUTS_INPUT}」（模板里能用的版式及其占位符），可能还有一份版式要求（skill-开头的文件）。
输出：一个 \`\`\`json 代码块：{"slides":[{"id":"SL001","layout":"版式名","note":"为什么这样选（可省略）"}]}
规则：
- 每一页都要出现，正好一次，顺序和输入一致；layout 原样照抄版式清单里的名字。
- 有正文的页面，选带正文占位符（body 或 object）的版式；只有标题的页面可以选标题类版式。
- 不要改写标题、正文和备注，也不要提出新内容；有版式要求时照它的规则选。`;

// 回复 → 方案。slides：任务输入里的幻灯片 [{ id, body }]；layouts：版式清单 [{ name, placeholders:[{type}] }]
export function parsePlan(raw, { slides, layouts }) {
  const m = String(raw).match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) throw new Error('回复里没有 ```json 代码块');
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
  const items = Array.isArray(v) ? v : v?.slides;
  if (!Array.isArray(items)) throw new Error('方案必须是 {"slides":[…]}');
  const byName = new Map(layouts.map((l) => [l.name, l]));
  const want = slides.map((s) => s.id);
  const got = items.map((x) => x?.id);
  if (got.length !== want.length || got.some((id, i) => id !== want[i])) throw new Error(`方案里的页面要和输入一致、各出现一次、顺序相同（输入：${want.join('、')}；方案：${got.join('、')}）`);
  return {
    slides: items.map((x, i) => {
      if (typeof x.layout !== 'string' || !byName.has(x.layout)) throw new Error(`${x.id} 的版式「${String(x.layout).slice(0, 40)}」不在模板的版式清单里`);
      const hasBody = byName.get(x.layout).placeholders.some((p) => ['body', 'object'].includes(p.type));
      if (String(slides[i].body ?? '').trim() && !hasBody) throw new Error(`${x.id} 有正文，但版式「${x.layout}」没有正文占位符`);
      return { id: x.id, layout: x.layout, ...(typeof x.note === 'string' && x.note.trim() ? { note: x.note.trim().slice(0, 200) } : {}) };
    }),
  };
}

// 导出任务的回复 → 方案：幻灯片按任务输入里的版本（期间改过版就不能用），版式清单取任务输入里的那一份
export function planOfTask({ gateway, project, task, raw }) {
  const slides = task.inputs.filter((x) => x.id && /^SL\d/.test(x.id)).map((x) => {
    const { record } = gateway.getRecord(project, x.id);
    if (record.version !== x.version) throw new WorkbenchError(409, `${x.id} 已从第 ${x.version} 版改到第 ${record.version} 版，重新导出`);
    return record;
  });
  const input = task.inputs.find((x) => x.blob && x.name === LAYOUTS_INPUT);
  if (!input) throw new WorkbenchError(400, `任务输入里没有${LAYOUTS_INPUT}`);
  const { layouts } = JSON.parse(blobStore(gateway.projectDir(project)).get(input.blob).toString('utf8'));
  return parsePlan(raw, { slides, layouts });
}
