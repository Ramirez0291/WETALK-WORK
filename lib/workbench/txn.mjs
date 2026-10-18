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

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 原子地建出“内容完整”的文件：先写临时文件，再用硬链接占位（目标已存在就失败），读者永远看不到写了一半的锁。
// 文件系统不支持硬链接时退回 wx 直接写。
function createExclusive(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(e.code)) throw e;
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
    } catch (e2) {
      if (e2.code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return true;
}

// 在 projects 目录建锁文件（含进程号）。已有存活的实例就拒绝。
// 持有者进程已不存在时要接管失效的锁，接管本身也必须跨进程互斥：
// 以失效持有者的 token 为键 mkdir 一个接管目录（mkdir 是排他的），只有建成的一方有权替换锁文件；
// 替换前再确认锁文件里仍是那个失效 token（这时别人不可能再改它），然后用改名原子替换。
// 接管者自己死在半路时，接管目录里的 owner 也已失效，下一位以“原键~它的 token”为键继续接管。
export function acquireLock(dir, { pid = process.pid, isAlive = processAlive, purpose = 'server' } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const token = crypto.randomBytes(8).toString('hex');
  const info = JSON.stringify({ pid, token, purpose, host: os.hostname(), startedAt: new Date().toISOString() });
  const handle = {
    file,
    token,
    // 只删自己的锁。能改动“持有者还活着的锁”的只有持有者自己，所以这里的先读后删没有竞态
    release() {
      if (readJsonFile(file)?.token === token) fs.rmSync(file, { force: true });
    },
  };
  const busy = (h) => new WorkbenchError(423, `已有工坊进程在使用项目目录（进程 ${h.pid}，${h.purpose ?? 'server'}，${h.startedAt}），拒绝同时运行`);

  // 以 key 抢接管权；抢到返回接管目录列表（成功后要删），抢不到返回 null
  function claim(key) {
    const chain = [];
    let k = key;
    for (let depth = 0; depth < 8; depth++) {
      const d = path.join(dir, `${LOCK_FILE}.takeover.${k}`);
      try {
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'owner.json'), info);
        chain.push(d);
        return chain;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      chain.push(d);
      const owner = readJsonFile(path.join(d, 'owner.json'));
      if (!owner) {
        // 刚建出目录、还没写 owner：等它写完；超过 5 秒还空着，说明建目录的进程已经死了
        const age = Date.now() - (fs.statSync(d, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age < 5000) return null;
        k = `${k}~orphan`;
        continue;
      }
      if (isAlive(owner.pid)) return null; // 有活着的进程正在接管
      k = `${k}~${owner.token}`; // 上一位接管者死在半路：接管它的接管
    }
    return null;
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    if (createExclusive(file, info)) return handle;
    const holder = readJsonFile(file);
    if (!holder?.token) {
      // 锁文件读不出来（硬链接不可用时的 wx 写入可能还没写完）
      const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age < 5000) throw new WorkbenchError(423, '另一个工坊进程正在启动，拒绝同时运行');
    } else if (isAlive(holder.pid)) {
      throw busy(holder);
    }
    const key = holder?.token ?? `unreadable-${Math.floor(fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0)}`;
    const chain = claim(key);
    if (!chain) {
      sleepSync(20 + Math.random() * 30);
      continue;
    }
    try {
      // 抢到接管权后再确认一次：锁文件仍是那个失效的持有者，才替换
      const now = readJsonFile(file);
      if ((now?.token ?? null) !== (holder?.token ?? null)) continue;
      const tmp = `${file}.${token}.tmp`;
      fs.writeFileSync(tmp, info);
      fs.renameSync(tmp, file);
      return handle;
    } finally {
      for (const d of chain.reverse()) fs.rmSync(d, { recursive: true, force: true });
    }
  }
  throw new WorkbenchError(423, '取不到项目目录的锁');
}

// ---------- 提交日志 ----------
// 每行一条：applied（数据已提交，这一行就是成功的标志）、archived / archive_failed / archive_skipped（留档结果）。

export function createCommitLog(projectsDir, { repair = false } = {}) {
  const file = path.join(projectsDir, 'commits.jsonl');
  const lines = [];
  const byCid = new Map(); // cid -> { applied, archive: { state, error, at } }
  const bySid = new Map(); // `${project}\n${sid}` -> cid
  const lastBlob = new Map(); // 仓库内路径 -> 最后一次 applied 时的 blob
  const usedIds = new Map(); // 项目 -> Set<出现过的记录编号>（删掉的编号也保留，绝不复用）

  function index(line) {
    lines.push(line);
    const entry = byCid.get(line.cid) ?? { applied: null, archive: { state: 'pending', error: null, at: null } };
    byCid.set(line.cid, entry);
    if (line.state === 'applied') {
      entry.applied = line;
      bySid.set(`${line.project}\n${line.sid}`, line.cid);
      for (const f of line.files) lastBlob.set(f.path, f.blob);
      if (!usedIds.has(line.project)) usedIds.set(line.project, new Set());
      for (const r of line.records) usedIds.get(line.project).add(r.id);
    } else if (line.state === 'archived') entry.archive = { state: 'archived', error: null, at: line.at, git: line.git ?? null };
    else if (line.state === 'archive_skipped') entry.archive = { state: 'skipped', error: null, at: line.at };
    else if (line.state === 'archive_failed') entry.archive = { state: 'failed', error: line.error, at: line.at };
  }

  // 末尾没有换行的一行：完整的 JSON 就补上换行保留它，否则截掉。内存索引和磁盘采用同一个决定：
  // 只读加载（repair = false）时，同样只承认完整的 JSON 行。修改磁盘必须先持有锁。
  if (fs.existsSync(file)) {
    let buf = fs.readFileSync(file);
    if (repair && buf.length && buf[buf.length - 1] !== 10) {
      const start = buf.lastIndexOf(10) + 1;
      let complete = false;
      try {
        JSON.parse(buf.subarray(start).toString('utf8'));
        complete = true;
      } catch {}
      if (complete) fs.appendFileSync(file, '\n');
      else fs.truncateSync(file, start);
      buf = fs.readFileSync(file);
    }
    for (const raw of buf.toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        index(JSON.parse(raw));
      } catch {} // 写到一半断电留下的半行：没有 applied 就等于没提交，恢复流程会重做
    }
  }

  return {
    file,
    // 追加失败（例如磁盘满）时把文件截回原长度，不留下半行；截不回去，调用方会进入故障状态，
    // 下次启动按上面的规则处理尾行
    append(line) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      try {
        fs.appendFileSync(file, JSON.stringify(line) + '\n');
      } catch (e) {
        try {
          if (fs.existsSync(file)) fs.truncateSync(file, size);
        } catch {}
        throw e;
      }
      index(line);
    },
    applied: (cid) => byCid.get(cid)?.applied ?? null,
    cidOfSid: (project, sid) => bySid.get(`${project}\n${sid}`) ?? null,
    lastBlob: (p) => lastBlob.get(p) ?? null,
    trackedPaths: () => [...lastBlob.keys()],
    usedIds: (project) => usedIds.get(project) ?? new Set(),
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

    // 清单已经落盘、但还没有 applied：这个事务必须先做完，才能接受后续写入
    isPending: (cid) => fs.existsSync(path.join(txnRoot, cid, 'manifest.json')) && !log.applied(cid),

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
