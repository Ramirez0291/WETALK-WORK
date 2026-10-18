// 上下文与可见性（契约四）：按任务类型决定输入方式与文件访问；匿名评审去掉署名；观众型读者不带证据；
// 密封期间的草稿和原始回复只存在服务进程内存里，揭晓后才写入磁盘。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';

// 每类任务的输入方式与文件访问
export const VISIBILITY = {
  sealed: { input: 'stdin', files: 'none', label: '密封起草' },
  review: { input: 'stdin', files: 'none', label: '匿名评审' },
  audience: { input: 'stdin', files: 'none', label: '观众型读者' },
  read: { input: 'workdir', files: 'read-workdir', label: '读资料' },
  export: { input: 'workdir', files: 'write-workdir', label: '导出' },
};

export function visibilityOf(task) {
  if (task.type === 'anonymous_review') return 'review';
  if (task.type === 'audience_reader') return 'audience';
  if (task.type === 'export') return 'export';
  if (task.mode === 'compete') return 'sealed';
  return 'read';
}
export const isSealed = (v) => VISIBILITY[v]?.input === 'stdin';

// ---------- 匿名 ----------
// 评审材料里不出现作者、模型、厂商：先按已知名单替换，再扫描一遍，还有残留就拒绝发出（宁可报错，不泄露）。
const VENDOR_WORDS = [
  'Anthropic', 'Claude', 'Opus', 'Sonnet', 'Haiku', 'Fable',
  'OpenAI', 'ChatGPT', 'GPT', 'Codex',
  'Google', 'Gemini', 'Antigravity', 'agy',
  'DeepSeek', '深度求索',
];

export function anonymityTerms(participants = []) {
  const terms = new Set(VENDOR_WORDS);
  for (const p of participants) {
    for (const t of [p.id, p.name, ...(p.aliases ?? []), p.model, p._model].filter(Boolean)) terms.add(String(t));
  }
  return [...terms].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 英文词按词边界匹配（避免把 "agyrate" 里的 agy 换掉），中文直接匹配
const termRe = (t) => (/^[\w.-]+$/.test(t) ? new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`, 'gi') : new RegExp(esc(t), 'g'));

export function scrubNames(text, terms) {
  let out = text;
  for (const t of terms) out = out.replace(termRe(t), '［已隐去］');
  return out;
}
export function findNames(text, terms) {
  return terms.filter((t) => termRe(t).test(text));
}

// 草稿 → 方案甲、方案乙……对应关系只存在服务端，评审结束后公开
const LABELS = ['方案甲', '方案乙', '方案丙', '方案丁', '方案戊', '方案己'];
export function anonymize(drafts, terms, rand = () => crypto.randomInt(1 << 30)) {
  const order = drafts.map((d) => ({ d, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.d);
  if (order.length > LABELS.length) throw new WorkbenchError(400, `匿名评审最多 ${LABELS.length} 份方案`);
  const mapping = {};
  const items = order.map((d, i) => {
    mapping[LABELS[i]] = d.ref;
    return { label: LABELS[i], text: scrubNames(d.text, terms) };
  });
  return { items, mapping };
}

// ---------- 提示词 ----------

const OUTPUT = {
  read: `输出要求：
- 只根据上面给出的输入工作，不要引用输入以外的资料。
- 把要写入正式区的结果写成一个 \`\`\`json 代码块，内容是提交入口的 changes 数组，例如：
  [{"kind":"claim","expected_version":0,"data":{"type":"fact","text":"……","sources":[{"id":"S001","version":1,"locator":"第 2 段","quote":"原文里逐字出现的一段"}]}}]
- 论断的 quote 必须逐字出自所引来源版本的正文快照；没有把握的不要写。
- 代码块之外可以写简短说明，提交入口只读取第一个 json 代码块。`,
  sealed: `输出要求：独立完成你的方案，直接输出 Markdown 正文。你看不到其他人的方案，也不要猜测或提及它们。`,
  review: `输出要求：逐条评审。每条意见必须指向具体位置（例如“方案甲 第 2 节”“方案乙 第 3 页”“论断 C007”），写清问题和理由；没有指向具体位置的意见会被退回。不要猜测方案的作者。`,
  audience: `输出要求：你是第一次看到这份材料的观众。先用自己的话复述核心观点（3 条以内），再逐条列出你看不懂、觉得跳跃或有疑问的地方，并指出在哪一页或哪一段。不要查找资料，只根据给你的材料回答。`,
  export: `输出要求：按任务目标在工作目录里生成导出文件，并在回复里列出生成的文件。`,
};

// parts：{ task, attempt, visibility, conventions, inputs, inline }。工作目录方式只列文件名，正文在文件里；
// inline 为真时（API 参与者、MCP 外部会话）输入一律写进提示词
export function renderPrompt({ task, attempt, visibility, conventions, inputs, inline = false }) {
  const v = VISIBILITY[visibility];
  const head = `你在 WETALK 工坊里执行一个任务（${v.label}）。
任务：${task.title}（类型 ${task.type}，任务号 ${task.id}，第 ${attempt} 次尝试）
${task.goal ? `目标：${task.goal}\n` : ''}`;
  const body = [];
  if (conventions) body.push(`======== 项目约定 ========\n${conventions}`);
  if (v.input === 'workdir' && !inline) {
    body.push(`======== 输入 ========\n输入文件都在当前工作目录里，只读取这些文件，不要读取工作目录以外的任何东西：\n${inputs.map((i) => `- ${i.name}${i.note ? ` ${i.note}` : ''}`).join('\n') || '（没有输入文件）'}`);
  } else {
    body.push(`======== 输入 ========\n${inputs.map((i) => `【${i.label ?? i.name}】${i.note ? ` ${i.note}` : ''}\n${i.text}`).join('\n\n') || '（没有输入）'}`);
  }
  body.push(`======== ${visibility === 'read' ? '提交格式' : '回答方式'} ========\n${OUTPUT[visibility]}`);
  return `${head}\n${body.join('\n\n')}\n`;
}

// 读资料的任务：专用临时工作目录，只放允许的输入副本
export function prepareWorkdir(root, packetId, inputs) {
  const dir = path.join(root, packetId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = inputs.map((i) => {
    const name = i.name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(dir, name), i.text);
    return { path: name, text: i.text };
  });
  return { dir, files };
}

// ---------- 密封 ----------
// 一轮密封（例如两份大纲竞争）的结果只存在这里。揭晓前：不写文件、不进调用记录正文、不出现在接口和事件里。
// 服务若在揭晓前崩溃，内存里的稿子随之消失，本轮重跑。
export function createSealedStore() {
  const rounds = new Map(); // roundId -> { project, tasks: Set, results: Map<task, result>, revealed }
  return {
    open(project, roundId, taskIds) {
      if (rounds.has(roundId)) throw new WorkbenchError(409, `密封轮次 ${roundId} 已存在`);
      rounds.set(roundId, { project, tasks: new Set(taskIds), results: new Map(), revealed: false });
    },
    roundOf(project, taskId) {
      for (const [id, r] of rounds) if (r.project === project && r.tasks.has(taskId)) return id;
      return null;
    },
    put(roundId, taskId, result) {
      const r = rounds.get(roundId);
      if (!r || r.revealed) throw new WorkbenchError(409, '密封轮次不存在或已揭晓');
      r.results.set(taskId, result);
    },
    // 只给出进度，不给内容
    status(roundId) {
      const r = rounds.get(roundId);
      if (!r) return null;
      return { project: r.project, tasks: [...r.tasks], done: [...r.results.keys()], complete: r.results.size === r.tasks.size, revealed: r.revealed };
    },
    // 揭晓：交出全部结果，之后从内存里清掉
    reveal(roundId) {
      const r = rounds.get(roundId);
      if (!r) throw new WorkbenchError(404, `密封轮次 ${roundId} 不存在`);
      if (r.results.size !== r.tasks.size) throw new WorkbenchError(409, `还有 ${r.tasks.size - r.results.size} 份没完成，不能揭晓`);
      r.revealed = true;
      const out = new Map(r.results);
      rounds.delete(roundId);
      return out;
    },
    discard(roundId) {
      rounds.delete(roundId);
    },
    list: () => [...rounds.keys()],
  };
}
