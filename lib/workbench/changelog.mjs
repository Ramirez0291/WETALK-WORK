// 改动记录与停滞检测（WP6）。
// - 改动记录：Agent 交稿时可以附 changelog，挂在具体编号上，标明类型（新增证据、修正错误、提高可理解性）。
//   它只是辅助信号：是否停滞由程序比对正式内容、计算质量指标得出，不看自报。
// - 停滞按“轮”判断（调度派出的一批任务全部结束算一轮），区分并分别记录三种情况：
//   没填改动记录；内容没有变化（程序比对）；有变化但质量指标没有提升。后两种才算停滞。
//   质量指标：新增 supported 论断数、解除的阻塞数、观众型读者标出的不懂处数量。
import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256, blobStore } from './records.mjs';
import { contentOf } from './packets.mjs';
import { audienceConfusions } from './modes.mjs';

export const CHANGE_TYPES = { evidence: '新增证据', fix: '修正错误', clarity: '提高可理解性' };
const REF_RE = /^(?:[A-Z]{1,2}\d{3,6}|\$[\w-]{1,32})$/;

// 回复里的改动记录 → 规范化。id 是已有记录的编号，或本次新建记录的临时编号（$c1）
export function normalizeChangelog(list) {
  const entries = [];
  const invalid = [];
  if (list == null) return { entries, invalid };
  if (!Array.isArray(list)) return { entries, invalid: [{ entry: list, reason: 'changelog 必须是数组' }] };
  for (const e of list.slice(0, 200)) {
    if (!e || typeof e !== 'object') invalid.push({ entry: e, reason: '每一项必须是对象' });
    else if (typeof e.id !== 'string' || !REF_RE.test(e.id)) invalid.push({ entry: e, reason: 'id 必须是记录编号或本次新建记录的临时编号' });
    else if (!Object.hasOwn(CHANGE_TYPES, e.type)) invalid.push({ entry: e, reason: `type 只能是 ${Object.keys(CHANGE_TYPES).join(' / ')}` });
    else entries.push({ id: e.id, type: e.type, note: typeof e.note === 'string' ? e.note.slice(0, 500) : '' });
  }
  return { entries, invalid };
}

// 晋升之后：临时编号换成正式编号，只留本次真正写了的记录（提交清单的记录与改动顺序一一对应）
export function resolveChangelog(entries, changes, records) {
  const byTmp = new Map();
  const written = new Map();
  changes.forEach((c, i) => {
    const r = records[i];
    if (!r) return;
    written.set(r.id, r.version);
    if (c.tmp) byTmp.set(c.tmp, r.id);
  });
  const resolved = [];
  const dropped = [];
  for (const e of entries) {
    const id = e.id.startsWith('$') ? byTmp.get(e.id) : e.id;
    if (id && written.has(id)) resolved.push({ ...e, id, version: written.get(id) });
    else dropped.push({ ...e, reason: '这次没有写这条记录' });
  }
  return { resolved, dropped };
}

// <项目>/changelog.jsonl：只追加
export function createChangelog(projectDir) {
  const file = path.join(projectDir, 'changelog.jsonl');
  return {
    file,
    append(entries) {
      if (entries.length) fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
    },
    list(filter = () => true) {
      if (!fs.existsSync(file)) return [];
      const out = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (filter(e)) out.push(e);
        } catch {} // 写到一半的尾行：跳过
      }
      return out;
    },
  };
}

// 正式内容与质量指标的快照。内容按记录的正文比对（不含版本号与内容来源、提交编号这些系统字段），
// 所以只改了版本号、正文没变的新版本不算变化
export function snapshot({ gateway, board, project }) {
  const content = {};
  const supported = [];
  const blocking = new Set();
  for (const { record: r, kind, status } of gateway.listRecords(project)) {
    const { version, ...rest } = contentOf(r);
    content[r.id] = sha256(canonical(rest));
    if (kind === 'claim' && status.verification?.state === 'supported' && status.verification.enough) supported.push(`${r.id}@${r.version}`);
    for (const o of status.blockers ?? []) blocking.add(o);
  }
  // 最近一次揭晓了的观众型读者：标出的不懂处数量
  const blobs = blobStore(gateway.projectDir(project));
  const readers = board.list(project).filter((t) => t.type === 'audience_reader' && t.state === 'done' && t.result?.text_blob);
  const last = readers.sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
  const confusions = last ? { task: last.id, count: audienceConfusions(blobs.get(last.result.text_blob).toString('utf8')) } : null;
  return { at: new Date().toISOString(), content, supported, blocking: [...blocking], confusions };
}

const READER_TYPES = new Set(['audience_reader', 'anonymous_review']);

// 一轮的结论。tasks：这一轮派出的任务（当前状态）；changelog：这些任务的改动记录
export function assessRound({ before, after, tasks, changelog }) {
  const done = tasks.filter((t) => t.state === 'done');
  const writers = done.filter((t) => (t.result?.records ?? []).length);
  const changed = Object.keys(after.content).filter((id) => before.content[id] !== after.content[id]);
  const filled = new Set(changelog.map((e) => e.task));
  const missing = writers.filter((t) => !filled.has(t.id)).map((t) => t.id);
  const supportedNew = after.supported.filter((x) => !before.supported.includes(x)).length;
  const blockersResolved = before.blocking.filter((id) => !after.blocking.includes(id)).length;
  const confusions = after.confusions && before.confusions && after.confusions.task !== before.confusions.task
    ? { before: before.confusions.count, after: after.confusions.count } : null;
  const improved = supportedNew > 0 || blockersResolved > 0 || (confusions != null && confusions.after < confusions.before);
  const selfReported = Object.fromEntries(Object.keys(CHANGE_TYPES).map((k) => [k, changelog.filter((e) => e.type === k).length]));
  let kind;
  if (!done.length) kind = 'no_result'; // 这一轮没有任务完成（失败、取消、等揭晓）
  else if (done.every((t) => READER_TYPES.has(t.type)) && !changed.length) kind = 'reading'; // 只有读者或评审，本来就不改内容
  else if (!changed.length) kind = 'unchanged';
  else if (!improved) kind = 'no_improvement';
  else kind = 'progress';
  return {
    kind,
    stagnant: kind === 'unchanged' || kind === 'no_improvement',
    changelog: { writers: writers.map((t) => t.id), missing, not_filled: missing.length > 0 },
    content: { changed },
    quality: { supported_new: supportedNew, blockers_resolved: blockersResolved, confusions },
    self_reported: selfReported,
  };
}

export const ROUND_KIND_LABEL = {
  progress: '有进展', unchanged: '停滞：内容没有变化', no_improvement: '停滞：有变化但质量指标没有提升',
  no_result: '没有任务完成', reading: '只有读者或评审',
};
