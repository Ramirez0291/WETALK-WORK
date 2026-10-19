// 阶段与工作记忆（契约四“阶段重置的范围”）：每个“项目＋阶段”使用一个独立的 WeTalk 记忆空间。
// 重置只归档并清空当前项目、当前阶段的那个空间，不碰全局共享记忆，也不碰其他项目、其他阶段。
// 阶段切换时何时重置、交接单怎么写，在 WP6 接入调度。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';

export const phaseSpaceName = (project, phase) => `工坊·${project}·${phase}`;

// 取得（没有就新建）某个项目某个阶段的记忆空间
export function phaseSpace(store, project, phase) {
  if (typeof phase !== 'string' || !/^[\w\u4e00-\u9fff-]{1,40}$/.test(phase)) throw new WorkbenchError(400, '阶段名只能是 1–40 个字母、数字、汉字、下划线或连字符');
  const name = phaseSpaceName(project, phase);
  return store.listSpaces().find((s) => s.name === name) ?? store.createSpace({ name, parent: null });
}

// 先归档到 <项目>/archive/memory/<阶段>-<时间>.json（临时文件写完再改名），归档成功后才清空该空间。
// 归档失败时记忆原样保留，错误抛给调用方。
// file：调用方指定的归档文件（阶段切换的待办里记下的）。它已经存在时（上一次归档、清空之后没走完）不覆盖，
// 而是把空间里现有的记忆本合并进去，所以重做多少次都不会丢掉第一次归档的内容
export function resetPhase({ store, projectDir, project, phase, now = () => new Date(), file = null }) {
  const space = phaseSpace(store, project, phase);
  const at = now().toISOString();
  const target = file ?? path.join(projectDir, 'archive', 'memory', `${phase}-${at.replace(/[:.]/g, '-')}.json`);
  const { result } = store.takeSpaceMemories(space.id, (notebooks) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let prev = null;
    if (fs.existsSync(target)) {
      if (!file) throw new WorkbenchError(409, `归档文件已存在：${path.basename(target)}`);
      prev = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
    const all = prev ? mergeNotebooks(prev.notebooks, notebooks) : notebooks;
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ project, phase, space: space.id, at: prev?.at ?? at, ...(prev ? { merged_at: at } : {}), notebooks: all }, null, 2) + '\n');
      fs.renameSync(tmp, target);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return all;
  });
  return { space: space.id, archived: Object.keys(result).length, file: target };
}

// 同一本记忆在两次归档里都有：按版本记录合并，完全相同的只留一份（重启后存储里又读回来的那些）
function mergeNotebooks(a = {}, b = {}) {
  const out = { ...a };
  for (const [key, revs] of Object.entries(b)) {
    const seen = new Set((out[key] ?? []).map((r) => JSON.stringify(r)));
    out[key] = [...(out[key] ?? []), ...revs.filter((r) => !seen.has(JSON.stringify(r)))];
  }
  return out;
}

// ---------- 七步流程（WP6）----------
// 阶段用设计文档“PPT 生产流程”的七步，由主持人手动切换。切换时：程序生成一页以内的交接单（不调用模型）；
// 旧阶段的工作记忆先归档再清空，新阶段换一个记忆空间。新阶段的任务包只带交接单，不带此前的讨论。
export const PHASES = [
  { id: 'goal', name: '明确目标' },
  { id: 'sources', name: '收集来源' },
  { id: 'claims', name: '抽取论断' },
  { id: 'outline', name: '大纲' },
  { id: 'script', name: '讲稿' },
  { id: 'slides', name: '幻灯片' },
  { id: 'review', name: '审阅' },
];
export const phaseOf = (id) => PHASES.find((p) => p.id === id) ?? null;

const HANDOFF_MAX_CHARS = 2500; // 一页以内
const MAX_ITEMS = 8;
const WORK_LABEL = { outline: '大纲', script: '讲稿', slide: '幻灯片' };

// 交接单：只从正式记录、派生状态、竞争与轮次的记录里取事实，不写内容生产者的身份（模型、厂商、参与者）。
// data：{ title, from, to, at, records: gateway.listRecords(), competitions, inboxCount, rounds }
export function buildHandoff({ title, from, to, at, records, competitions = [], inboxCount = 0, rounds = [] }) {
  const list = (items, fmt) => {
    // 子项缩进两格，挂在上一行的条目下面
    const shown = items.slice(0, MAX_ITEMS).map((x) => `  ${fmt(x)}`);
    if (items.length > MAX_ITEMS) shown.push(`  - ……另有 ${items.length - MAX_ITEMS} 条`);
    return shown.length ? shown.join('\n') : '  - 无';
  };
  const of = (k) => records.filter((x) => x.kind === k);
  const claims = of('claim');
  const v = (s) => s.status.verification;
  const ready = claims.filter((c) => c.status.ready).length;
  const thin = claims.filter((c) => v(c)?.state === 'supported' && !v(c).enough).length;
  const unreviewed = claims.filter((c) => v(c)?.state === 'unreviewed').length;
  const split = claims.filter((c) => ['disputed', 'unsupported'].includes(v(c)?.state));
  const stale = records.filter((x) => x.status.freshness === 'stale').length;
  const works = records.filter((x) => WORK_LABEL[x.kind]);
  const blocking = new Map();
  for (const x of records) for (const o of x.status.blockers ?? []) blocking.set(o, x.record.id);
  const objections = new Map(of('objection').map((o) => [o.record.id, o.record]));
  const lines = [
    `# 阶段交接单：${from ? from.name : '（开始）'} → ${to.name}`,
    '',
    `项目：${title}；交接时间：${at}`,
    '',
    '## 现状',
    `- 来源 ${of('source').length} 张；论断 ${claims.length} 条：可进入成品 ${ready}，支持但份数不够 ${thin}，未核验 ${unreviewed}，有分歧或不支持 ${split.length}`,
    `- 待更新（stale）的记录 ${stale} 条`,
    '- 作品：',
    list(works, (w) => `- ${WORK_LABEL[w.kind]} ${w.record.id} 第 ${w.record.version} 版《${String(w.record.title).slice(0, 40)}》${w.status.ready ? '' : '（不可进入成品）'}`),
    '',
    '## 没解决的事',
    '- 阻塞异议：',
    list([...blocking], ([o, target]) => {
      const r = objections.get(o);
      return `- ${o}（${r?.category ?? '?'}）针对 ${r ? `${r.target.id}@${r.target.version}` : target}`;
    }),
    '- 有分歧或不支持的论断：',
    list(split, (c) => `- ${c.record.id}：${v(c).state === 'disputed' ? '核验结论不一致' : '核验不支持'}`),
    `- 待你决定：${inboxCount} 项`,
    '- 竞争：',
    list(competitions, (k) => `- ${k.id}《${String(k.title).slice(0, 30)}》：${k.stage_label}${k.selection ? `，选定 ${k.selection.label} → ${k.selection.record.id}` : ''}${k.minority ? `；少数意见 ${k.minority} 条留在竞争记录里` : ''}`),
    '',
    '## 最近几轮',
    list(rounds.slice(-3).reverse(), (r) => `- 第 ${r.n} 轮（${r.phase_name ?? '未设阶段'}）：${r.assessment?.label ?? '进行中'}`).replace(/^ {2}/gm, ''),
    '',
    '## 给下一阶段',
    '- 正式记录（来源、论断、核验、异议、作品）照常可用，以它们的当前版本为准。',
    '- 此前阶段的讨论和工作笔记不进入任务包；需要时去研讨室和归档里查。',
  ];
  let text = lines.join('\n') + '\n';
  if (text.length > HANDOFF_MAX_CHARS) text = `${text.slice(0, HANDOFF_MAX_CHARS - 40).replace(/\n[^\n]*$/, '')}\n- ……（超过一页，后面省略）\n`;
  return text;
}
