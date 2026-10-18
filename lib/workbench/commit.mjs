// 提交入口（契约二）：收稿 → 候选稿；在仓库级串行队列的临界区里晋升为正式版本；git 留档与重试。
// 另外负责服务启动时的恢复、外部改动检测，以及查询接口要用的派生视图（概况、记录、追溯、待你决定）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import {
  KINDS, kindOfId, formatId, recordRelPath, validateData, refsOf, serialize, canonical, sha256, blobStore, loadRecords, locateQuote,
} from './records.mjs';
import { derive, statusOf, summarize } from './deps.mjs';
import { createQueue, createCommitLog, createTxn, acquireLock, archivePending, scanExternal } from './txn.mjs';

const conflict = (message, details) => Object.assign(new WorkbenchError(409, message), { details });

// 任务系统（契约三）在 WP4 实现。之前所有带 task_id 的提交都找不到任务。
// check 返回 { ok: true, provenance } / { ok: false, reason }（栅栏不通过：存为历史草稿）/ { notFound: true }
export const NO_TASKS = { check: () => ({ notFound: true }) };

export function createCommitGateway({
  workbench,
  defaults,
  fence = NO_TASKS,
  now = () => new Date(),
  onEvent = () => {},
  gitOpts = {},
  crash, // 测试用：写前日志各步之后的崩溃注入点
  lock = true, // 服务进程持有单实例锁；测试可以关掉
  lockOpts = {},
  availabilityOf = () => new Map(), // 来源可获取性（usage.mjs 派生）；没接入时一律视为未知
}) {
  const projectsDir = workbench.projectsDir;
  const abs = (rel) => path.join(projectsDir, rel);
  const queue = createQueue();
  let log = null;
  let txn = null;
  let held = null;
  let retryTimer = null;
  // 写入故障：清单已落盘、却没能做完的事务。出现后拒绝一切写入，直到重启时恢复流程把它做完，
  // 否则较早的失败事务会在之后被重做，覆盖掉中间已经确认成功的提交。
  let fault = null;
  const assertWritable = () => {
    if (fault) throw new WorkbenchError(503, `正式区处于写入故障状态（提交 ${fault.cid}：${fault.error}），已停止接受写入。请重启服务完成恢复`);
  };
  const requestIndex = new Map(); // project -> Map<request_id, { sid, hash }>

  const autoCommitOf = (project) => {
    try {
      return workbench.get(project).config.git.autoCommit;
    } catch {
      return defaults.git.autoCommit; // 项目被删或配置坏了：按全局设置
    }
  };

  // ---------- 启动与恢复 ----------

  async function start() {
    fs.mkdirSync(projectsDir, { recursive: true });
    if (lock) held = acquireLock(projectsDir, lockOpts);
    try {
      const init = await workbench.init();
      log = createCommitLog(projectsDir, { repair: true }); // 持有锁之后才动磁盘上的尾行
      // 持有锁之后才清理新建项目时残留的临时目录：此时不可能有人还在用它们
      for (const name of fs.readdirSync(projectsDir)) {
        if (name.startsWith('_staging-')) fs.rmSync(path.join(projectsDir, name), { recursive: true, force: true });
      }
      txn = createTxn({ projectsDir, log, crash });
      const recovered = await txn.recover();
      queue.run(({ later }) => later(archive));
      return { recovered, init };
    } catch (e) {
      held?.release();
      throw e;
    }
  }

  async function archive() {
    const r = await archivePending({ projectsDir, log, gitOpts, autoCommitOf });
    for (const cid of r.done) onEvent({ type: 'archive', cid, state: 'archived' });
    if (r.failed) onEvent({ type: 'archive', cid: r.failed, state: 'failed', error: r.error });
    return r;
  }

  // 留档失败后定时重试：git 恢复后自动补交
  function startArchiveRetry(intervalMs = 60_000) {
    retryTimer = setInterval(() => {
      if (log.pendingArchives().length) queue.run(({ later }) => later(archive));
    }, intervalMs);
    retryTimer.unref?.();
  }

  function stop() {
    if (retryTimer) clearInterval(retryTimer);
    held?.release();
    held = null;
  }

  // ---------- 候选稿 ----------

  const candDir = (project, sid) => path.join(project.dir, 'candidates', sid);

  function readCandidate(project, sid) {
    if (!/^[\w-]{1,80}$/.test(sid)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(candDir(project, sid), 'submission.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function candidatesOf(project) {
    const dir = path.join(project.dir, 'candidates');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((sid) => readCandidate(project, sid)).filter(Boolean);
  }

  function requestsOf(project) {
    if (!requestIndex.has(project.name)) {
      const m = new Map();
      for (const c of candidatesOf(project)) m.set(c.request_id, { sid: c.sid, hash: c.content_hash, receipt: receiptOf(c) });
      requestIndex.set(project.name, m);
    }
    return requestIndex.get(project.name);
  }

  const receiptOf = (c) => ({ sid: c.sid, request_id: c.request_id, state: c.fenced ? 'draft' : 'received', reason: c.fence_reason ?? null });

  // 收稿：校验格式、身份与租约，存为候选稿。整个过程是同步的，同一 request_id 的并发重试不会各自存一份。
  // actor：只由服务端给出（受控的人工入口），不从请求体里取。
  function receive(projectName, body, { actor = null } = {}) {
    const project = workbench.get(projectName);
    if (!body || typeof body !== 'object') throw new WorkbenchError(400, '请求体必须是对象');
    const requestId = body.request_id;
    if (typeof requestId !== 'string' || !/^[\w.:-]{8,100}$/.test(requestId)) throw new WorkbenchError(400, 'request_id 必须是 8–100 位的字母、数字或 . : _ -');
    const taskId = body.task_id ?? null;
    if (!Array.isArray(body.changes) || !body.changes.length) throw new WorkbenchError(400, 'changes 必须是非空数组');
    if (body.changes.length > 200) throw new WorkbenchError(400, '一次最多提交 200 条记录');

    const hash = sha256(canonical({ task_id: taskId, attempt: body.attempt ?? null, changes: body.changes }));
    const requests = requestsOf(project);
    const seen = requests.get(requestId);
    if (seen) {
      if (seen.hash !== hash) throw conflict(`request_id ${requestId} 已用于内容不同的提交`, { sid: seen.sid });
      return { ...seen.receipt, duplicate: true };
    }

    // 身份与租约
    let provenance;
    let fenced = false;
    let fenceReason = null;
    if (taskId) {
      const f = fence.check(project.name, { task_id: taskId, attempt: body.attempt, lease_token: body.lease_token });
      if (f.notFound) throw new WorkbenchError(404, `任务 ${taskId} 不存在`);
      provenance = f.provenance ?? { kind: 'unknown', verified: false, basis: 'fence-failed' };
      if (!f.ok) {
        fenced = true; // 栅栏不通过：存为历史草稿，永不自动晋升
        fenceReason = f.reason;
      }
    } else {
      if (!actor) throw new WorkbenchError(403, '没有任务号的提交只接受工坊页面的主持人入口');
      provenance = actor;
    }

    const blobs = blobStore(project.dir);
    const changes = normalizeChanges(body.changes, blobs, provenance);
    const deps = dedupe(changes.flatMap(refsOfChange).filter((r) => !r.id.startsWith('$')));

    const at = now().toISOString();
    const sid = `${taskId ? `${taskId}-${body.attempt ?? 0}` : 'H'}-${at.replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const cand = {
      sid,
      request_id: requestId,
      content_hash: hash,
      project: project.name,
      task_id: taskId,
      attempt: body.attempt ?? null,
      provenance,
      fenced,
      fence_reason: fenceReason,
      received_at: at,
      deps, // 提交时依赖的版本
      changes,
    };
    const dir = candDir(project, sid);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'submission.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(cand, null, 2));
    fs.renameSync(tmp, path.join(dir, 'submission.json'));
    const receipt = receiptOf(cand);
    requests.set(requestId, { sid, hash, receipt });
    onEvent({ type: 'submission', project: project.name, sid, state: receipt.state });
    return receipt;
  }

  function normalizeChanges(raw, blobs, provenance) {
    const tmps = new Map();
    const targets = new Set();
    const out = raw.map((c, i) => {
      const at = `changes[${i}]`;
      if (!c || typeof c !== 'object') throw new WorkbenchError(400, `${at} 必须是对象`);
      let kind = c.kind;
      if (c.id !== undefined) {
        const k = kindOfId(c.id);
        if (!k) throw new WorkbenchError(400, `${at}.id 不是合法编号`);
        if (kind && kind !== k) throw new WorkbenchError(400, `${at}.kind 与编号 ${c.id} 不符`);
        kind = k;
        if (targets.has(c.id)) throw new WorkbenchError(400, `${c.id} 在同一次提交里出现了两次`);
        targets.add(c.id);
      }
      if (!KINDS[kind]) throw new WorkbenchError(400, `${at}.kind 必须是 ${Object.keys(KINDS).join(' / ')}`);
      const ev = c.expected_version;
      if (!Number.isInteger(ev) || ev < 0) throw new WorkbenchError(400, `${at}.expected_version 必须是非负整数（新建写 0）`);
      if ((c.id === undefined) !== (ev === 0)) throw new WorkbenchError(400, `${at}：新建记录不写 id 且 expected_version 为 0；修改已有记录必须写 id 和当前版本`);
      if (c.tmp !== undefined) {
        if (c.id !== undefined) throw new WorkbenchError(400, `${at}.tmp 只用于新建记录`);
        if (typeof c.tmp !== 'string' || !/^\$[\w-]{1,32}$/.test(c.tmp)) throw new WorkbenchError(400, `${at}.tmp 必须形如 $s1`);
        if (tmps.has(c.tmp)) throw new WorkbenchError(400, `临时编号 ${c.tmp} 重复`);
        tmps.set(c.tmp, kind);
      }
      const data = validateData(kind, c.data);
      if (kind === 'source') {
        if (data.text !== undefined) {
          // 来源正文只有两个来处：Fetch 抓到的快照，或主持人手工录入。Agent 不能直接写正文，
          // 否则搜索结果的 summary / snippet 就能冒充原文
          if (provenance?.kind !== 'human') throw new WorkbenchError(403, `${at}：来源正文只能经 Fetch 获取（text_blob），或由主持人手工录入`);
          data.text_blob = blobs.put(data.text); // 正文快照存成 blob，记录里只留 hash
          delete data.text;
        } else if (data.text_blob !== undefined && !blobs.has(data.text_blob)) {
          throw new WorkbenchError(400, `${at}.data.text_blob 指向的正文快照不存在`);
        }
      }
      const change = { kind, expected_version: ev, data };
      if (c.id !== undefined) change.id = c.id;
      if (c.tmp !== undefined) change.tmp = c.tmp;
      return change;
    });
    // 临时编号只能指向本次提交里同种类的新记录
    for (const [i, c] of out.entries()) {
      for (const r of refsOfChange(c)) {
        if (!r.id.startsWith('$')) continue;
        const k = tmps.get(r.id);
        if (!k) throw new WorkbenchError(400, `changes[${i}] 引用了未定义的临时编号 ${r.id}`);
        const want = c.kind === 'claim' ? 'source' : 'claim';
        if (k !== want) throw new WorkbenchError(400, `changes[${i}] 引用的 ${r.id} 应该是 ${want}`);
      }
    }
    return out;
  }

  // ---------- 晋升 ----------

  // 新编号：跳过正式记录、提交日志里出现过的全部编号（含已被删掉的）、以及目录里现存的任何文件名。
  // 编号一旦用过就永不复用，旧的 {id, version} 引用不会被重新解释成另一条记录。
  function nextNumbers(project, records) {
    const next = {};
    const used = [...records.keys(), ...log.usedIds(project.name)];
    for (const [kind, { dir }] of Object.entries(KINDS)) {
      let max = 0;
      for (const id of used) if (kindOfId(id) === kind) max = Math.max(max, Number(id.match(/\d+$/)[0]));
      // 目录里还有读不出来的坏文件时，编号也要跳过它们，绝不覆盖
      const full = path.join(project.dir, dir);
      if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) {
        const m = name.match(/^[A-Z]{1,2}(\d+)\.json$/);
        if (m && kindOfId(name.slice(0, -5)) === kind) max = Math.max(max, Number(m[1]));
      }
      next[kind] = max + 1;
    }
    return next;
  }

  function promote(projectName, sid) {
    return queue.run(async ({ later }) => {
      assertWritable();
      const project = workbench.get(projectName);
      const cand = readCandidate(project, sid);
      if (!cand) throw new WorkbenchError(404, `候选稿 ${sid} 不存在`);
      if (cand.fenced) throw conflict('这是栅栏检查未通过的历史草稿，不能晋升', { reason: cand.fence_reason });
      const done = log.cidOfSid(project.name, sid);
      if (done) return { state: 'applied', cid: done, records: log.applied(done).records, duplicate: true };

      // 正式状态一律从提交日志和 blob 读：工作区里未经采纳的改动不会成为晋升的依据
      const { records, external } = committedState(project);
      const reasons = [];

      // 1. 目标记录：当前版本等于 expected_version；文件没有被服务进程之外改过
      for (const c of cand.changes) {
        if (c.id === undefined) continue;
        const cur = records.get(c.id);
        if (!cur) {
          reasons.push({ type: 'missing_target', id: c.id });
          continue;
        }
        if (cur.version !== c.expected_version) reasons.push({ type: 'version_conflict', id: c.id, expected: c.expected_version, current: cur.version });
        if (external.has(c.id)) reasons.push({ type: 'external_change', id: c.id, change: external.get(c.id) });
      }

      // 2. 分配新编号，算出本次提交之后每条相关记录的版本
      const next = nextNumbers(project, records);
      const tmpIds = new Map();
      const ids = cand.changes.map((c) => {
        if (c.id !== undefined) return c.id;
        const id = formatId(c.kind, next[c.kind]++);
        if (c.tmp) tmpIds.set(c.tmp, id);
        return id;
      });
      const after = new Map([...records].map(([id, r]) => [id, r.version]));
      cand.changes.forEach((c, i) => after.set(ids[i], c.expected_version + 1));

      // 3. 依赖全部为当前版本（引用本次一起修改的记录时，按修改后的版本算）
      const resolve = (r) => (r.id.startsWith('$') ? { ...r, id: tmpIds.get(r.id), version: 1 } : r);
      const at = now().toISOString();
      const newRecords = cand.changes.map((c, i) => {
        const data = structuredClone(c.data);
        if (data.sources) data.sources = data.sources.map(resolve);
        if (data.claims) data.claims = data.claims.map(resolve);
        return {
          id: ids[i],
          version: c.expected_version + 1,
          ...data,
          provenance: { ...cand.provenance, task_id: cand.task_id, attempt: cand.attempt, sid: cand.sid },
          commit: null, // 通过全部检查后才分配提交编号
          updated_at: at,
        };
      });
      for (const rec of newRecords) {
        for (const r of refsOf(rec)) {
          if (!after.has(r.id)) reasons.push({ type: 'missing_dependency', id: rec.id, ref: r.id });
          else if (after.get(r.id) !== r.version) reasons.push({ type: 'stale_dependency', id: rec.id, ref: r.id, based: r.version, current: after.get(r.id) });
        }
      }
      // 依赖链上（含间接上游）有未处理的外部改动：不能拿它当晋升的依据
      const written = new Set(ids);
      const seen = new Set();
      const stack = newRecords.flatMap(refsOf).map((r) => r.id);
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id) || written.has(id)) continue;
        seen.add(id);
        if (external.has(id)) reasons.push({ type: 'external_dependency', ref: id, change: external.get(id) });
        const up = records.get(id);
        if (up) stack.push(...refsOf(up).map((r) => r.id));
      }

      // 4. 验收规则：引文必须出现在所引来源版本的正文快照里（契约一第一步“指针有效”中的 quote 检查）。
      //    这只证明“引文存在”，不证明“支持结论”；后者由核验者判断（WP5）。
      const blobsOf = blobStore(project.dir);
      const sourceAt = (id, version) => {
        const fresh = newRecords.find((r) => r.id === id);
        if (fresh && fresh.version === version) return fresh;
        const cur = records.get(id);
        if (cur && cur.version === version) return cur;
        return recordAt(project, records, id, version);
      };
      for (const rec of newRecords) {
        if (kindOfId(rec.id) !== 'claim') continue;
        for (const s of rec.sources || []) {
          if (!s.quote) continue;
          const src = sourceAt(s.id, s.version);
          if (!src?.text_blob || !blobsOf.has(src.text_blob)) {
            reasons.push({ type: 'quote_unverifiable', id: rec.id, source: s.id, note: '来源没有正文快照，引文无法核对；先对来源 Fetch，或由主持人录入正文' });
          } else if (!locateQuote(blobsOf.get(src.text_blob).toString('utf8'), s.quote)) {
            reasons.push({ type: 'quote_not_found', id: rec.id, source: s.id, quote: s.quote.slice(0, 80) });
          }
        }
      }

      // 5. 验收规则：引用关系不能成环
      const merged = new Map(records);
      for (const rec of newRecords) merged.set(rec.id, rec);
      const cyc = derive(merged, { external }).cycles.filter((cy) => cy.some((id) => ids.includes(id)));
      for (const cy of cyc) reasons.push({ type: 'cycle', cycle: cy });

      if (reasons.length) {
        fs.appendFileSync(path.join(candDir(project, sid), 'attempts.jsonl'), JSON.stringify({ at, ok: false, reasons }) + '\n');
        onEvent({ type: 'submission', project: project.name, sid, state: 'rejected', reasons });
        throw conflict('候选稿未能晋升，已保留；请基于当前版本重做或复核', { sid, reasons });
      }

      // 6. 写前日志：先存 blob，再写清单，然后旧版本归档 → 逐个替换文件 → applied
      const cid = txn.nextCid();
      for (const rec of newRecords) rec.commit = cid;
      const blobs = blobStore(project.dir);
      const files = newRecords.map((rec) => {
        const rel = recordRelPath(project.name, rec.id);
        const blob = blobs.put(serialize(rec));
        const f = { path: rel, blob, blob_path: `${project.name}/${blobs.relOf(blob)}`, old: null };
        if (rec.version > 1) {
          const oldBlob = blobs.put(fs.readFileSync(abs(rel)));
          f.old = {
            version: rec.version - 1,
            blob: oldBlob,
            blob_path: `${project.name}/${blobs.relOf(oldBlob)}`,
            copy_path: `${project.name}/archive/versions/${KINDS[kindOfId(rec.id)].dir}/${rec.id}.v${rec.version - 1}.json`,
          };
        }
        return f;
      });
      // 来源正文快照一起进 git 留档
      const extra = [...new Set(newRecords.filter((r) => r.text_blob).map((r) => `${project.name}/${blobs.relOf(r.text_blob)}`))];
      const manifest = {
        cid, at, project: project.name, sid, task_id: cand.task_id, attempt: cand.attempt,
        files, extra, records: newRecords.map((r) => ({ id: r.id, version: r.version })),
      };
      try {
        await txn.prepare(manifest);
        await txn.apply(manifest);
      } catch (e) {
        if (log.applied(cid)) {
          // applied 已经落盘：数据已提交，之后的收尾（审计事件、清理清单目录）失败不影响结果，恢复流程会清理
          console.error(`[工坊] 提交 ${cid} 已完成，收尾出错（已忽略）：`, e);
        } else if (!txn.isPending(cid)) {
          throw e; // 清单没写成：等于没开始，原样报错
        } else {
          // 清单已落盘：就地再做一次（每一步都可重复执行）。仍然失败就进入故障状态，不再接受任何写入
          try {
            await txn.apply(manifest);
          } catch (e2) {
            fault = { cid, error: String(e2.message || e2).slice(0, 300), at: new Date().toISOString() };
            console.error(`[工坊] 写入故障，停止接受写入：提交 ${cid}：`, e2);
            onEvent({ type: 'fault', ...fault });
            assertWritable();
          }
        }
      }
      fs.appendFileSync(path.join(candDir(project, sid), 'attempts.jsonl'), JSON.stringify({ at, ok: true, cid }) + '\n');
      onEvent({ type: 'commit', project: project.name, cid, sid, records: manifest.records });
      for (const r of manifest.records) onEvent({ type: 'record', project: project.name, id: r.id, version: r.version });
      later(archive); // 异步留档：接口先返回，留档仍占着队列，和下一次晋升不交错
      return { state: 'applied', cid, records: manifest.records };
    });
  }

  // 新建项目也走同一个队列：它同样写 projects 目录、同样做 git 提交
  const createProject = (name) =>
    queue.run(async () => {
      assertWritable();
      const r = await workbench.create(name);
      onEvent({ type: 'project', project: { name: r.project.name, title: r.project.title } });
      return r;
    });

  // ---------- 查询 ----------

  // 正式状态：每条提交过的记录取最后一次 applied 的 blob。工作区文件只用来比对——
  // 被改过或删掉的记录照样按已提交的内容参与计算，但标为外部改动；从没提交过的文件不算正式记录。
  function committedState(project) {
    const prefix = `${project.name}/`;
    const blobs = blobStore(project.dir);
    const records = new Map();
    const external = new Map();
    for (const rel of log.trackedPaths()) {
      if (!rel.startsWith(prefix)) continue;
      const id = path.basename(rel, '.json');
      if (!kindOfId(id) || rel !== recordRelPath(project.name, id)) continue;
      const blob = log.lastBlob(rel);
      let rec;
      try {
        rec = JSON.parse(blobs.get(blob).toString('utf8'));
      } catch {
        continue; // blob 丢失：扫描外部改动时会报告
      }
      records.set(id, rec);
      let actual = null;
      try {
        actual = sha256(fs.readFileSync(abs(rel)));
      } catch {}
      if (actual !== blob) external.set(id, actual ? 'modified' : 'deleted');
    }
    return { records, external };
  }

  function view(projectName) {
    const project = workbench.get(projectName);
    const { records, external } = committedState(project);
    return { project, records, external, d: derive(records, { external }) };
  }

  function recordFiles(project) {
    const out = [];
    for (const { dir } of Object.values(KINDS)) {
      const full = path.join(project.dir, dir);
      if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) if (name.endsWith('.json')) out.push(`${project.name}/${dir}/${name}`);
    }
    return out;
  }

  // 待你决定（WP2 部分）：外部改动、读不出的记录文件、留档失败。任务类事项在 WP4 加入。
  function inbox(projectName) {
    const project = workbench.get(projectName);
    const items = scanExternal({ projectsDir, log, project: project.name, recordFiles: recordFiles(project) });
    for (const p of loadRecords(project.dir).problems) items.push({ type: 'bad_record_file', project: project.name, path: `${project.name}/${p.file}`, error: p.error });
    for (const c of log.list(project.name)) {
      if (c.archive.state === 'failed') items.push({ type: 'archive_failed', project: project.name, cid: c.cid, error: c.archive.error });
    }
    if (fault) items.unshift({ type: 'write_fault', project: project.name, ...fault });
    return items;
  }

  function overview(projectName) {
    const { project, records, d } = view(projectName);
    const cands = candidatesOf(project);
    const pending = cands.filter((c) => !c.fenced && !log.cidOfSid(project.name, c.sid)).length;
    const commits = log.list(project.name);
    return {
      name: project.name,
      title: project.title,
      summary: summarize(records, d),
      candidates: { pending, drafts: cands.filter((c) => c.fenced).length, total: cands.length },
      commits: { total: commits.length, archivePending: commits.filter((c) => ['pending', 'failed'].includes(c.archive.state)).length },
      inbox: inbox(projectName).length,
    };
  }

  function listRecords(projectName, kind) {
    const { records, d } = view(projectName);
    return [...records.values()]
      .filter((r) => !kind || kindOfId(r.id) === kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ record: r, kind: kindOfId(r.id), status: statusOf(d, r.id) }));
  }

  // 某条记录的某个版本：当前版本读正式文件，旧版本读归档副本
  function recordAt(project, records, id, version) {
    const cur = records.get(id);
    if (cur && cur.version === version) return cur;
    const kind = kindOfId(id);
    if (!kind) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(project.dir, 'archive', 'versions', KINDS[kind].dir, `${id}.v${version}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  function history(project, id, current) {
    const kind = kindOfId(id);
    const dir = path.join(project.dir, 'archive', 'versions', KINDS[kind].dir);
    const old = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n) => n.startsWith(`${id}.v`)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
      : [];
    return [...old, ...(current ? [current] : [])]
      .sort((a, b) => b.version - a.version)
      .map((r) => ({ version: r.version, commit: r.commit ?? null, updated_at: r.updated_at ?? null, provenance: r.provenance ?? null }));
  }

  function getRecord(projectName, id) {
    const { project, records, d } = view(projectName);
    const rec = records.get(id);
    if (!rec) throw new WorkbenchError(404, `记录 ${id} 不存在`);
    const targeting = (k) => [...records.values()].filter((r) => kindOfId(r.id) === k && r.target?.id === id).map((r) => r.id);
    return {
      record: rec,
      kind: kindOfId(id),
      status: statusOf(d, id),
      ...(kindOfId(id) === 'source' ? { availability: availabilityOf(project.name).get(id) ?? { state: 'unknown' } } : {}),
      history: history(project, id, rec),
      verifications: targeting('verification'),
      objections: targeting('objection'),
    };
  }

  // 追溯：页面 → 论断 → 来源 → 原文位置。按引用时的版本取来源正文，检查引文是否出现在快照里。
  function trace(projectName, id) {
    const { project, records, d } = view(projectName);
    const rec = records.get(id);
    if (!rec) throw new WorkbenchError(404, `记录 ${id} 不存在`);
    const blobs = blobStore(project.dir);
    const availability = availabilityOf(project.name);
    const textOf = (src) => {
      if (!src?.text_blob || !blobs.has(src.text_blob)) return null;
      return blobs.get(src.text_blob).toString('utf8');
    };

    const sourceNode = (ref) => {
      const cur = records.get(ref.id);
      const atRef = recordAt(project, records, ref.id, ref.version);
      const node = {
        id: ref.id,
        version: ref.version,
        current_version: cur?.version ?? null,
        title: atRef?.title ?? cur?.title ?? null,
        citation: atRef?.citation ?? null,
        url: atRef?.url ?? null,
        availability: availability.get(ref.id)?.state ?? 'unknown',
        locator: ref.locator ?? null,
        quote: ref.quote ?? null,
        quote_found: null,
        context: null,
      };
      if (ref.quote) {
        const body = textOf(atRef);
        if (body != null) {
          const hit = locateQuote(body, ref.quote);
          node.quote_found = !!hit;
          if (hit) {
            const { index: i, length: n } = hit;
            node.context = { before: body.slice(Math.max(0, i - 80), i), quote: body.slice(i, i + n), after: body.slice(i + n, i + n + 80), offset: i };
          }
        }
      }
      return node;
    };

    const claimNode = (ref) => {
      const cur = records.get(ref.id);
      const atRef = recordAt(project, records, ref.id, ref.version) ?? cur;
      return {
        id: ref.id,
        version: ref.version,
        current_version: cur?.version ?? null,
        type: atRef?.type ?? null,
        text: atRef?.text ?? null,
        status: cur ? statusOf(d, ref.id) : null,
        sources: (atRef?.sources || []).map(sourceNode),
      };
    };

    const kind = kindOfId(id);
    const downstreamOf = (x) => [...(d.downstream.get(x) || [])].sort();
    if (kind === 'claim') return { kind, root: claimNode({ id, version: rec.version }), downstream: downstreamOf(id) };
    if (kind === 'source') {
      return {
        kind,
        root: sourceNode({ id, version: rec.version }),
        downstream: downstreamOf(id).map((c) => ({ id: c, downstream: downstreamOf(c) })),
      };
    }
    if (['outline', 'script', 'slide'].includes(kind)) {
      return {
        kind,
        root: { id, version: rec.version, title: rec.title, status: statusOf(d, id), claims: (rec.claims || []).map(claimNode) },
      };
    }
    return { kind, root: { id, version: rec.version, status: statusOf(d, id) } };
  }

  return {
    projectsDir,
    start, stop, startArchiveRetry, archive, queue,
    receive, promote, createProject,
    candidates: (p) => candidatesOf(workbench.get(p)).map((c) => ({ ...receiptOf(c), received_at: c.received_at, task_id: c.task_id, applied: log.cidOfSid(p, c.sid) })),
    commits: (p) => (workbench.get(p), log.list(p)),
    overview, listRecords, getRecord, trace, inbox,
    get log() {
      return log;
    },
  };
}

// 一条待提交改动引用了哪些记录（新建的记录还没有编号，用种类的占位编号让 refsOf 认出种类）
const refsOfChange = (c) => refsOf({ ...c.data, id: c.id ?? formatId(c.kind, 0) });

function dedupe(refs) {
  const seen = new Map();
  for (const r of refs) seen.set(`${r.id}@${r.version}`, { id: r.id, version: r.version });
  return [...seen.values()];
}
