// 任务包：一次尝试实际拿到的全部输入。每项输入按内容 hash 存进 blob，任务包记录 hash、来处和实际发送的提示词、
// 有效配置，存在 <项目>/archive/packets/<任务>-a<尝试>.json（只写一次）。hash 只用来检查内容有没有变，
// 还原时从 blob 读回内容本身。还原输入不等于重新运行会得到相同输出。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';
import { blobStore, kindOfId, KINDS } from './records.mjs';
import { snapshotInfo } from './snapshots.mjs';

const packetDir = (projectDir) => path.join(projectDir, 'archive', 'packets');
export const packetIdOf = (taskId, attempt) => `${taskId}-a${attempt}`;

// 项目约定里还留着的模板引导语（原样未改的提示行）不进任务包，免得把“请填写……”当成约定发给模型
export function cleanConventions(text, templateText = '') {
  const hints = new Set(
    templateText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^（.*）$/.test(l) || /^> /.test(l)),
  );
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((l) => !hints.has(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 读取某条记录的某个版本：当前版本读已提交快照，旧版本读归档
function recordAt(gateway, project, ref) {
  const cur = gateway.getRecord(project, ref.id).record;
  if (cur.version === ref.version) return cur;
  const kind = kindOfId(ref.id);
  const file = path.join(gateway.projectDir(project), 'archive', 'versions', KINDS[kind].dir, `${ref.id}.v${ref.version}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new WorkbenchError(404, `${ref.id} 没有第 ${ref.version} 版`);
  }
}

// 不带系统字段的记录正文：任务包里只放内容。内容生产者的身份（provenance、作者集合 authors、
// 核验者 verifier、异议提出者 raised_by，含其中的模型与厂商）一律在这里结构化剔除——
// 匿名评审靠这一步，不靠正文里的署名替换；服务端的记录与归档照样保留完整的来源关系。
// 来源卡的 author 是文献作者（书目信息），不是内容生产者，保留。
export const PRODUCER_FIELDS = ['provenance', 'authors', 'verifier', 'raised_by', 'commit', 'updated_at'];
export const contentOf = (rec) => Object.fromEntries(Object.entries(rec).filter(([k]) => !PRODUCER_FIELDS.includes(k)));

// 收集任务的输入，返回 [{ role, ref, name, text }]。audience 只接受作品，并去掉其中的论断引用。
// 读资料的任务里，论断输入会带上它所引的每个来源（按论断引用的版本）及其正文快照：核验、补证都要读原文。
export function collectInputs({ gateway, project, task, visibility }) {
  const dir = gateway.projectDir(project);
  const blobs = blobStore(dir);
  const out = [];
  const seen = new Set();
  const queue = [...task.inputs];
  if (visibility !== 'audience') {
    for (const x of task.inputs) {
      if (x.blob || kindOfId(x.id) !== 'claim') continue;
      for (const s of recordAt(gateway, project, x).sources || []) queue.push({ id: s.id, version: s.version });
    }
  }
  for (const x of queue) {
    if (!x.blob) {
      const key = `${x.id}@${x.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (x.blob) {
      // 观众型读者：任意 blob 无法确认里面没有来源、论断或核验，一律不给
      if (visibility === 'audience') throw new WorkbenchError(400, `观众型读者的任务包不能包含 blob 输入 ${x.name}（只给讲稿、大纲或幻灯片记录）`);
      if (!blobs.has(x.blob)) throw new WorkbenchError(400, `输入 ${x.name} 的 blob 不存在`);
      out.push({ role: 'file', ref: null, name: x.name, text: blobs.get(x.blob).toString('utf8') });
      continue;
    }
    const kind = kindOfId(x.id);
    const rec = recordAt(gateway, project, x);
    if (visibility === 'audience') {
      // 观众型读者：只给讲稿或 PPT 文本；来源、论断、核验、异议一律不给，作品里的论断编号也去掉
      if (!['script', 'slide', 'outline'].includes(kind)) throw new WorkbenchError(400, `观众型读者的任务包不能包含 ${x.id}（只给讲稿、大纲或幻灯片文本）`);
      out.push({ role: 'work', ref: `${x.id}@${x.version}`, name: `${x.id}.md`, text: [`# ${rec.title}`, rec.body ?? '', rec.notes ? `\n讲者备注：${rec.notes}` : ''].join('\n').trim() });
      continue;
    }
    out.push({ role: 'record', ref: `${x.id}@${x.version}`, name: `${x.id}.v${x.version}.json`, text: JSON.stringify(contentOf(rec), null, 2) });
    // 来源卡附上它的正文快照，并注明快照的来处
    if (kind === 'source' && rec.text_blob && blobs.has(rec.text_blob)) {
      const info = snapshotInfo(dir, rec.text_blob);
      const note = info?.origin === 'fetch' ? `（Fetch 快照，${info.url}，${info.retrieved_at ?? info.at}；第三方服务返回的 Markdown，不保证与网页逐字一致）` : info?.origin === 'manual' ? '（主持人录入）' : '';
      out.push({ role: 'source_text', ref: `${x.id}@${x.version}`, name: `${x.id}.v${x.version}.正文.md`, text: blobs.get(rec.text_blob).toString('utf8'), note });
    }
  }
  return out;
}

// 保存任务包。parts：{ conventions, inputs, prompt, config, participant, visibility, files }，全部是实际使用的内容
export function savePacket({ projectDir, task, attempt, parts, now = () => new Date() }) {
  const blobs = blobStore(projectDir);
  const put = (text) => blobs.put(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  const packet = {
    id: packetIdOf(task.id, attempt),
    task: task.id,
    type: task.type,
    attempt,
    created_at: now().toISOString(),
    visibility: parts.visibility,
    participant: parts.participant ?? null,
    conventions_blob: put(parts.conventions ?? ''),
    inputs: (parts.inputs ?? []).map((i) => ({ role: i.role, ref: i.ref, name: i.name, note: i.note ?? null, blob: put(i.text), chars: i.text.length })),
    prompt_blob: parts.prompt != null ? put(parts.prompt) : null,
    config_blob: put(parts.config ?? {}),
    files: (parts.files ?? []).map((f) => ({ path: f.path, blob: put(f.text) })),
  };
  const file = path.join(packetDir(projectDir), `${packet.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new WorkbenchError(409, `任务包 ${packet.id} 已存在（同一次尝试只保存一次）`);
  fs.writeFileSync(file, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
  return packet;
}

// 按任务包完整还原当时的输入：约定、每项输入、实际发送的提示词、有效配置、放进工作目录的文件
export function restorePacket(projectDir, packetId) {
  if (!/^T\d{3,6}-a\d+$/.test(packetId)) throw new WorkbenchError(400, '任务包编号格式不对');
  const file = path.join(packetDir(projectDir), `${packetId}.json`);
  if (!fs.existsSync(file)) throw new WorkbenchError(404, `任务包 ${packetId} 不存在`);
  const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blobs = blobStore(projectDir);
  const text = (h) => (h ? blobs.get(h).toString('utf8') : null);
  return {
    packet,
    conventions: text(packet.conventions_blob),
    inputs: packet.inputs.map((i) => ({ ...i, text: text(i.blob) })),
    prompt: text(packet.prompt_blob),
    config: JSON.parse(text(packet.config_blob)),
    files: packet.files.map((f) => ({ ...f, text: text(f.blob) })),
  };
}

export function listPackets(projectDir, taskId) {
  const dir = packetDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${taskId}-a`)).map((n) => n.slice(0, -5)).sort();
}
