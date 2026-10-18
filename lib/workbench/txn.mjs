// 契约二的底层：仓库级串行队列、单实例锁、提交日志（commits.jsonl）、写前日志（_txn/）与崩溃恢复、git 留档。
// 事实来源只有两样：正式记录文件 ＋ commits.jsonl。_txn/ 是进行中的提交，git 只留历史。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError, appendEvent } from './project.mjs';
import { renameRetry } from './fsx.mjs';
import { commitBlobs } from './git.mjs';
import { sha256 } from './records.mjs';

// ---------- 仓库级串行队列 ----------
// 所有项目共用一个 git 仓库，所以新建项目、晋升、git 留档排同一个队。
// fn 可以用 later(g) 登记“调用方拿到结果之后、下一个任务开始之前”要做的事（git 留档），
// 这样接口不用等 git，但留档仍然独占队列，不会和下一次晋升交错。
export function createQueue() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const job = tail.then(async () => {
        const later = [];
        try {
          return { value: await fn({ later: (g) => later.push(g) }), later };
        } catch (error) {
          return { error, later };
        }
      });
      tail = job.then(async ({ later }) => {
        for (const g of later) {
          try {
            await g();
          } catch (e) {
            console.error('队列后续任务出错：', e);
          }
        }
      });
      return job.then(({ value, error }) => {
        if (error) throw error;
        return value;
      });
    },
    idle: () => tail,
  };
}

// ---------- 单实例锁 ----------

export const LOCK_FILE = '.workbench.lock';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 进程存在，只是没有权限发信号
  }
}

// 在 projects 目录建锁文件（含进程号）。已有存活的实例就拒绝；持有者进程已不存在，说明上次没有正常退出，锁作废。
export function acquireLock(dir, { pid = process.pid, isAlive = processAlive, purpose = 'server' } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, token, purpose, host: os.hostname(), startedAt: new Date().toISOString() }), { flag: 'wx' });
      return {
        file,
        token,
        release() {
          try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file);
          } catch {}
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // 刚被别人用 wx 建出来、还没写完：当作有人持有
        const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age < 5000) throw new WorkbenchError(423, '另一个工坊进程正在启动，拒绝同时运行');
      }
      if (holder && isAlive(holder.pid)) {
        throw new WorkbenchError(423, `已有工坊进程在使用项目目录（进程 ${holder.pid}，${holder.purpose ?? 'server'}，${holder.startedAt}），拒绝同时运行`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new WorkbenchError(423, '取不到项目目录的锁');
}

// ---------- 提交日志 ----------
// 每行一条：applied（数据已提交，这一行就是成功的标志）、archived / archive_failed / archive_skipped（留档结果）。

export function createCommitLog(projectsDir) {
  const file = path.join(projectsDir, 'commits.jsonl');
  const lines = [];
  const byCid = new Map(); // cid -> { applied, archive: { state, error, at } }
  const bySid = new Map(); // `${project}\n${sid}` -> cid
  const lastBlob = new Map(); // 仓库内路径 -> 最后一次 applied 时的 blob

  function index(line) {
    lines.push(line);
    const entry = byCid.get(line.cid) ?? { applied: null, archive: { state: 'pending', error: null, at: null } };
    byCid.set(line.cid, entry);
    if (line.state === 'applied') {
      entry.applied = line;
      bySid.set(`${line.project}\n${line.sid}`, line.cid);
      for (const f of line.files) lastBlob.set(f.path, f.blob);
    } else if (line.state === 'archived') entry.archive = { state: 'archived', error: null, at: line.at, git: line.git ?? null };
    else if (line.state === 'archive_skipped') entry.archive = { state: 'skipped', error: null, at: line.at };
    else if (line.state === 'archive_failed') entry.archive = { state: 'failed', error: line.error, at: line.at };
  }

  // 只读加载；修补半行在 repairTail 里做（要先持有锁）
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        index(JSON.parse(raw));
      } catch {} // 写到一半断电留下的半行：没有 applied 就等于没提交，恢复流程会重做
    }
  }

  return {
    file,
    // 去掉文件末尾没写完的半行，免得下一次追加接在半行后面
    repairTail() {
      if (!fs.existsSync(file)) return false;
      const buf = fs.readFileSync(file);
      if (!buf.length || buf[buf.length - 1] === 10) return false;
      const cut = buf.lastIndexOf(10) + 1;
      fs.truncateSync(file, cut);
      return true;
    },
    append(line) {
      fs.appendFileSync(file, JSON.stringify(line) + '\n');
      index(line);
    },
    applied: (cid) => byCid.get(cid)?.applied ?? null,
    cidOfSid: (project, sid) => bySid.get(`${project}\n${sid}`) ?? null,
    lastBlob: (p) => lastBlob.get(p) ?? null,
    trackedPaths: () => [...lastBlob.keys()],
    archiveOf: (cid) => byCid.get(cid)?.archive ?? null,
    // 已提交、尚未留档（含失败待重试）的提交，按编号升序
    pendingArchives() {
      return [...byCid.values()]
        .filter((e) => e.applied && ['pending', 'failed'].includes(e.archive.state))
        .map((e) => e.applied)
        .sort((a, b) => a.cid.localeCompare(b.cid));
    },
    list(project) {
      return [...byCid.values()]
        .filter((e) => e.applied && (!project || e.applied.project === project))
        .map((e) => ({ ...e.applied, archive: e.archive }))
        .sort((a, b) => b.cid.localeCompare(a.cid));
    },
    maxCid: () => [...byCid.keys()].reduce((m, c) => Math.max(m, Number(c) || 0), 0),
  };
}

// ---------- 写前日志 ----------
// crash(step) 是测试用的注入点：在每一步之后可以抛错或直接退出进程，模拟崩溃。

export const TXN_DIR = '_txn';

async function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  await renameRetry(tmp, file);
}

export function createTxn({ projectsDir, log, crash = () => {} }) {
  const txnRoot = path.join(projectsDir, TXN_DIR);
  const abs = (rel) => path.join(projectsDir, rel);
  let lastCid = Math.max(log.maxCid(), ...listTxnDirs().map(Number).filter(Number.isFinite), 0);

  function listTxnDirs() {
    return fs.existsSync(txnRoot) ? fs.readdirSync(txnRoot) : [];
  }

  return {
    nextCid: () => String(++lastCid).padStart(6, '0'),

    // 第 1 步：写清单（状态 prepared）。新内容的 blob 必须在这之前已经写好。
    async prepare(manifest) {
      for (const f of manifest.files) if (!fs.existsSync(abs(f.blob_path))) throw new Error(`清单引用的 blob 不存在：${f.blob_path}`);
      await writeAtomic(path.join(txnRoot, manifest.cid, 'manifest.json'), JSON.stringify({ ...manifest, state: 'prepared' }, null, 2));
      crash('prepared');
    },

    // 第 2–4 步。每一步都可以重复执行：恢复时按清单从头再来一遍即可。
    async apply(manifest) {
      // 2. 旧版本复制到归档
      for (const f of manifest.files) {
        if (!f.old) continue;
        const dest = abs(f.old.copy_path);
        if (!fs.existsSync(dest)) await writeAtomic(dest, fs.readFileSync(abs(f.old.blob_path)));
      }
      crash('archived-old');
      // 3. 逐个文件：先写临时文件，再改名替换（遇到占用会重试）
      for (const [i, f] of manifest.files.entries()) {
        await writeAtomic(abs(f.path), fs.readFileSync(abs(f.blob_path)));
        crash(`file:${i}`);
      }
      // 4. 追加 applied：这一行就是提交成功的标志；再记审计事件
      if (!log.applied(manifest.cid)) {
        log.append({
          cid: manifest.cid,
          state: 'applied',
          at: manifest.at,
          project: manifest.project,
          sid: manifest.sid,
          task_id: manifest.task_id ?? null,
          attempt: manifest.attempt ?? null,
          files: manifest.files.map((f) => ({ path: f.path, blob: f.blob, blob_path: f.blob_path })),
          extra: manifest.extra ?? [],
          records: manifest.records,
        });
      }
      crash('applied');
      try {
        appendEvent(abs(manifest.project), { at: new Date().toISOString(), type: 'commit', cid: manifest.cid, sid: manifest.sid, records: manifest.records });
      } catch {} // 审计事件不参与恢复，写不进去也不影响提交
      fs.rmSync(path.join(txnRoot, manifest.cid), { recursive: true, force: true });
    },

    // 启动时调用（已持有锁）：清理没写完的清单；有 prepared 清单但没有 applied 的，按清单重做。
    async recover() {
      const redone = [];
      const dropped = [];
      for (const cid of listTxnDirs().sort()) {
        const dir = path.join(txnRoot, cid);
        const file = path.join(dir, 'manifest.json');
        if (!fs.existsSync(file)) {
          fs.rmSync(dir, { recursive: true, force: true }); // 清单还没改名到位就崩溃了：等于没开始
          dropped.push(cid);
          continue;
        }
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (log.applied(cid)) fs.rmSync(dir, { recursive: true, force: true });
        else {
          await this.apply(manifest);
          redone.push(cid);
        }
      }
      return { redone, dropped };
    },
  };
}

// ---------- 外部改动 ----------
// 正式文件与最后一次 applied 记录的 hash 不一致：服务进程之外有人改过。没有任何 applied 记录的记录文件同样算外部改动。
export function scanExternal({ projectsDir, log, project, recordFiles }) {
  const items = [];
  for (const rel of recordFiles) {
    const expected = log.lastBlob(rel);
    let actual = null;
    try {
      actual = sha256(fs.readFileSync(path.join(projectsDir, rel)));
    } catch {}
    if (expected !== actual) items.push({ type: 'external_change', project, path: rel, expected, actual });
  }
  // 提交过、但文件被删掉了
  for (const rel of log.trackedPaths()) {
    if (!rel.startsWith(`${project}/`) || recordFiles.includes(rel)) continue;
    if (!fs.existsSync(path.join(projectsDir, rel))) items.push({ type: 'external_change', project, path: rel, expected: log.lastBlob(rel), actual: null });
  }
  return items;
}

// ---------- git 留档 ----------
// 严格按提交编号顺序留档：前面的没成功，后面的就等着，避免旧内容覆盖新内容。
// 每次留档都从 blob 取确切字节（见 commitBlobs），与工作区当前内容无关。
export async function archivePending({ projectsDir, log, gitOpts = {}, autoCommitOf = () => true }) {
  const done = [];
  for (const line of log.pendingArchives()) {
    if (!autoCommitOf(line.project)) {
      log.append({ cid: line.cid, state: 'archive_skipped', at: new Date().toISOString() });
      continue;
    }
    const files = [
      ...line.files.map((f) => ({ path: f.path, file: path.join(projectsDir, f.blob_path) })),
      ...(line.extra || []).map((p) => ({ path: p, file: path.join(projectsDir, p) })),
    ];
    const msg = `[工坊] 提交 ${line.cid} · ${line.project} · ${line.task_id ? `任务 ${line.task_id}#${line.attempt}` : `候选稿 ${line.sid}`}\n\n${line.records.map((r) => `${r.id} v${r.version}`).join('\n')}`;
    const r = await commitBlobs(projectsDir, files, msg, gitOpts);
    if (r.ok) {
      log.append({ cid: line.cid, state: 'archived', at: new Date().toISOString(), git: r.commit ?? null });
      done.push(line.cid);
    } else {
      const prev = log.archiveOf(line.cid);
      const error = String(r.error || '').slice(0, 500);
      if (prev?.state !== 'failed' || prev.error !== error) log.append({ cid: line.cid, state: 'archive_failed', at: new Date().toISOString(), error });
      return { done, failed: line.cid, error };
    }
  }
  return { done, failed: null };
}
