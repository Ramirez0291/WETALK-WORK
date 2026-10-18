// WP2 评审（R1–R5）的回归用例：写入故障、编号复用、提交日志尾行、失效锁接管、外部改动隔离，以及多次留档失败后的补交
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git } from '../../lib/workbench/git.mjs';
import { acquireLock, createCommitLog, LOCK_FILE } from '../../lib/workbench/txn.mjs';
import { setup, restart, submit, seed, newSource, rid, HUMAN, ROOT, tmpBase, cleanup, readJson } from './helpers.mjs';

after(cleanup);
const gitAvailable = (await git(os.tmpdir(), ['--version'])).ok;
const P = '样本';
const rec = (env, rel) => readJson(path.join(env.projectsDir, P, rel));
const editS001 = (title, version = 1) => [{ id: 'S001', expected_version: version, data: { title, url: 'https://example.org/a', text: title } }];

// 临时替换 fs 上的某个同步函数（提交入口在调用时才取 fs.xxx，所以替换对它生效）
function patchFs(name, impl) {
  const original = fs[name];
  fs[name] = (...args) => impl(original, ...args);
  return () => (fs[name] = original);
}

// ---------- R1 ----------

test('R1: 清单落盘后文件一直被占用：进入故障状态、拒绝后续写入；重启后补完，已确认的结果不会被覆盖', async () => {
  const env = await setup();
  await seed(env.gw);
  const target = path.join(env.projectsDir, P, 'sources', 'S001.json');
  const restore = patchFs('renameSync', (orig, from, to) => {
    if (path.resolve(to) === target) throw Object.assign(new Error('模拟：文件被长期占用'), { code: 'EPERM' });
    return orig(from, to);
  });
  const a = env.gw.receive(P, { request_id: rid(), changes: editS001('甲') }, { actor: HUMAN });
  try {
    await assert.rejects(env.gw.promote(P, a.sid), { status: 503 });
  } finally {
    restore();
  }
  // 占用解除了，但故障状态下仍拒绝写入：不能让后来的提交先于未完成的事务落地
  const b = env.gw.receive(P, { request_id: rid(), changes: editS001('乙') }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, b.sid), { status: 503 });
  assert.equal(env.gw.inbox(P)[0].type, 'write_fault');
  const { gw } = await restart(env);
  assert.equal(rec(env, 'sources/S001.json').title, '甲');
  assert.equal(rec(env, 'sources/S001.json').version, 2);
  // 乙基于 v1：现在只能得到版本冲突，候选稿保留
  await assert.rejects(gw.promote(P, b.sid), (e) => e.status === 409 && e.details.reasons[0].type === 'version_conflict');
  // 再重启一次，结果不变
  await restart(env);
  assert.equal(rec(env, 'sources/S001.json').title, '甲');
  assert.deepEqual(gw.inbox(P), []);
});

test('R1: 写提交日志遇到磁盘满：一次性的错误就地重做成功，持续的错误进入故障状态，日志里不留半行', async () => {
  const env = await setup();
  await seed(env.gw);
  const logFile = path.join(env.projectsDir, 'commits.jsonl');
  let fails = 1;
  let restore = patchFs('appendFileSync', (orig, file, data) => {
    if (path.resolve(String(file)) === logFile && String(data).includes('"applied"') && fails-- > 0) {
      orig(file, String(data).slice(0, 20)); // 写进去一半才失败
      throw Object.assign(new Error('模拟：磁盘已满'), { code: 'ENOSPC' });
    }
    return orig(file, data);
  });
  try {
    const { result } = await submit(env.gw, P, editS001('一次性失败', 1));
    assert.equal(result.state, 'applied');
  } finally {
    restore();
  }
  for (const l of fs.readFileSync(logFile, 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(l), l);

  restore = patchFs('appendFileSync', (orig, file, data) => {
    if (path.resolve(String(file)) === logFile && String(data).includes('"applied"')) throw Object.assign(new Error('模拟：磁盘已满'), { code: 'ENOSPC' });
    return orig(file, data);
  });
  const r = env.gw.receive(P, { request_id: rid(), changes: editS001('持续失败', 2) }, { actor: HUMAN });
  try {
    await assert.rejects(env.gw.promote(P, r.sid), { status: 503 });
  } finally {
    restore();
  }
  await restart(env);
  await restart(env);
  const applied = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.state === 'applied');
  assert.deepEqual(applied.map((l) => l.cid), ['000001', '000002', '000003']);
  assert.equal(rec(env, 'sources/S001.json').title, '持续失败');
});

// ---------- R2 ----------

test('R2: 删掉的编号永不复用；旧引用不会被重新解释成新来源，删除在处理之前一直待办', async () => {
  const env = await setup();
  await seed(env.gw);
  fs.unlinkSync(path.join(env.projectsDir, P, 'sources', 'S001.json'));
  const { result } = await submit(env.gw, P, [newSource('$n', '无关的新来源')]);
  assert.deepEqual(result.records, [{ id: 'S002', version: 1 }]);
  assert.deepEqual(env.gw.inbox(P).map((i) => [i.type, i.path]), [['external_change', `${P}/sources/S001.json`]]);
  const c = env.gw.getRecord(P, 'C001').status;
  assert.equal(c.freshness, 'stale');
  assert.deepEqual(c.stale_reasons, [{ type: 'upstream', id: 'S001' }]);
  assert.deepEqual(env.gw.getRecord(P, 'S001').status.stale_reasons, [{ type: 'external', change: 'deleted' }]);
  assert.equal(env.gw.trace(P, 'C001').root.sources[0].title, '来源$s'); // 仍是当初提交的那份
  // 删掉同类的全部文件、再重启，编号照样往后排
  fs.unlinkSync(path.join(env.projectsDir, P, 'sources', 'S002.json'));
  const { gw } = await restart(env);
  const again = await submit(gw, P, [newSource('$m', '又一个')]);
  assert.deepEqual(again.result.records, [{ id: 'S003', version: 1 }]);
  assert.equal(gw.getRecord(P, 'C001').status.freshness, 'stale');
  // 引用被删掉的来源：拒绝
  const r = gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(gw.promote(P, r.sid), (e) => e.details.reasons.some((x) => x.type === 'external_dependency' && x.ref === 'S001'));
});

// ---------- R3 ----------

test('R3: 提交日志末尾是完整 JSON、只缺换行：保留它；内存与磁盘一致，连续重启两次结果相同', async () => {
  const env = await setup();
  await seed(env.gw);
  await submit(env.gw, P, editS001('v2'));
  await env.gw.queue.idle();
  const logFile = path.join(env.projectsDir, 'commits.jsonl');
  // 去掉最后一个换行（最后一行可能是 applied，也可能是留档结果，都要保留）
  fs.truncateSync(logFile, fs.statSync(logFile).size - 1);
  for (let i = 0; i < 2; i++) {
    const { gw } = await restart(env);
    assert.deepEqual(gw.commits(P).map((c) => c.cid), ['000002', '000001'], `第 ${i + 1} 次重启`);
    assert.deepEqual(createCommitLog(env.projectsDir).list(P).map((c) => c.cid), ['000002', '000001']);
    assert.deepEqual(gw.inbox(P), []);
    assert.ok(fs.readFileSync(logFile, 'utf8').endsWith('\n'));
  }
});

test('R3: applied 行写到一半被截断、清单还在：丢掉半行，按清单重做；再重启不会出现外部改动', async () => {
  const env = await setup();
  await seed(env.gw);
  // 制造“清单已落盘、applied 行只写了一半”的磁盘状态
  const crashing = await restart(env, { crash: (s) => { if (s === 'applied') throw new Error('停在 applied 之后'); } });
  const r = crashing.gw.receive(P, { request_id: rid(), changes: editS001('v2') }, { actor: HUMAN });
  await crashing.gw.promote(P, r.sid).catch(() => {});
  crashing.gw.stop();
  const logFile = path.join(env.projectsDir, 'commits.jsonl');
  const text = fs.readFileSync(logFile, 'utf8');
  const lastStart = text.trimEnd().lastIndexOf('\n') + 1;
  assert.match(text.slice(lastStart), /"applied"/);
  fs.writeFileSync(logFile, text.slice(0, lastStart + 30)); // applied 行只剩前 30 个字符
  assert.equal(fs.readdirSync(path.join(env.projectsDir, '_txn')).length, 1);
  for (let i = 0; i < 2; i++) {
    const { gw } = await restart(env);
    assert.deepEqual(gw.commits(P).map((c) => c.cid), ['000002', '000001'], `第 ${i + 1} 次重启`);
    assert.deepEqual(fs.readdirSync(path.join(env.projectsDir, '_txn')), []);
    assert.deepEqual(gw.inbox(P), []);
    assert.equal(rec(env, 'sources/S001.json').title, 'v2');
  }
});

// ---------- R4 ----------

test('R4: 两方同时接管同一把失效的锁：确定性交错下只有一方拿到', () => {
  const dir = path.join(tmpBase(), '项目资料');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 99999999, token: 'deadbeef', purpose: 'old' }));
  const alive = (pid) => pid !== 99999999;
  let second = null;
  let first = null;
  let firstError = null;
  try {
    first = acquireLock(dir, {
      pid: 1001,
      purpose: 'A',
      isAlive: (pid) => {
        // A 刚读完旧锁、判定持有者已死；这时 B 完整地接管
        if (pid === 99999999 && !second) second = acquireLock(dir, { pid: 1002, purpose: 'B', isAlive: alive });
        return alive(pid);
      },
    });
  } catch (e) {
    firstError = e;
  }
  assert.ok(second, 'B 应该拿到锁');
  assert.equal(first, null, 'A 不能也拿到锁');
  assert.equal(firstError.status, 423);
  assert.equal(readJson(path.join(dir, LOCK_FILE)).purpose, 'B');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('takeover')), []);
});

test('R4: 接管者死在半路留下的接管目录不会把锁永久卡死', () => {
  const dir = path.join(tmpBase(), '项目资料');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 99999999, token: 'deadbeef' }));
  // 上一个接管者（同样已死）建了接管目录
  const d = path.join(dir, `${LOCK_FILE}.takeover.deadbeef`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ pid: 99999998, token: 'cafe' }));
  // 另一个接管者建了目录、还没来得及写 owner 就死了（目录已存在超过 5 秒）
  const orphan = path.join(dir, `${LOCK_FILE}.takeover.deadbeef~cafe`);
  fs.mkdirSync(orphan);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(orphan, old, old);
  const lock = acquireLock(dir, { pid: 1003, purpose: 'C', isAlive: (pid) => pid < 99999998 });
  assert.equal(readJson(path.join(dir, LOCK_FILE)).token, lock.token);
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);
});

test('R4: 真实多进程：遗留一把失效的锁，四个进程同时启动，每轮恰好一个拿到', async () => {
  for (let round = 0; round < 3; round++) {
    const dir = path.join(tmpBase(), '项目资料');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 99999999, token: `dead${round}` }));
    const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'tests/workbench/fixtures/lock-child.mjs'), dir, '1500']);
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.on('exit', () => resolve(out.trim()));
    }));
    const outputs = await Promise.all(runs);
    assert.equal(outputs.filter((o) => o === 'got').length, 1, `第 ${round + 1} 轮：${outputs.join(', ')}`);
    assert.equal(outputs.filter((o) => o === 'busy').length, 3, `第 ${round + 1} 轮：${outputs.join(', ')}`);
  }
});

// ---------- R5 ----------

test('R5: 上游被外部改过但版本号没变：不能当依赖；视图与追溯仍是已提交的内容', async () => {
  const env = await setup();
  await seed(env.gw);
  const file = path.join(env.projectsDir, P, 'sources', 'S001.json');
  const edited = readJson(file);
  edited.title = '未经采纳的外部修改';
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.equal(env.gw.getRecord(P, 'S001').record.title, '来源$s');
  assert.equal(env.gw.trace(P, 'C001').root.sources[0].title, '来源$s');
  assert.equal(env.gw.getRecord(P, 'C001').status.freshness, 'stale');
  const r = env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, r.sid), (e) => e.details.reasons.some((x) => x.type === 'external_dependency' && x.ref === 'S001'));
  // 间接上游：新页面引用 C001，C001 的来源 S001 被外部改过
  const s = env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'slide', expected_version: 0, data: { title: 'p', claims: [{ id: 'C001', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, s.sid), (e) => e.details.reasons.some((x) => x.type === 'external_dependency' && x.ref === 'S001'));
});

test('R5: 手工放进来、从未提交过的记录文件不是正式记录，不能被引用', async () => {
  const env = await setup();
  await seed(env.gw);
  fs.writeFileSync(path.join(env.projectsDir, P, 'sources', 'S005.json'), JSON.stringify({ id: 'S005', version: 1, title: '手工', url: 'https://a' }));
  assert.throws(() => env.gw.getRecord(P, 'S005'), { status: 404 });
  const r = env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S005', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, r.sid), (e) => e.details.reasons.some((x) => x.type === 'missing_dependency'));
  assert.ok(env.gw.inbox(P).some((i) => i.path === `${P}/sources/S005.json`));
});

// ---------- 多次留档失败后补交 ----------

test('git 连续失败积压多个提交，重启后按顺序补交：每个 git 提交都是对应提交的确切内容', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const gitOpts = { bin: 'git-不存在-xyz' };
  const env = await setup({ gitOpts });
  await seed(env.gw);
  await submit(env.gw, P, editS001('第二版', 1));
  await submit(env.gw, P, editS001('第三版', 2));
  await env.gw.queue.idle();
  assert.equal(env.gw.commits(P).filter((c) => c.archive.state === 'failed').length, 1); // 只试了第一个，后面的排队等着
  env.gw.stop();
  const { gw } = await restart(env);
  await gw.queue.idle();
  const commits = gw.commits(P).reverse();
  assert.deepEqual(commits.map((c) => c.archive.state), ['archived', 'archived', 'archived']);
  for (const c of commits) {
    for (const f of c.files) {
      const inGit = (await git(env.projectsDir, ['cat-file', 'blob', `${c.archive.git}:${f.path}`])).stdout;
      assert.equal(inGit, fs.readFileSync(path.join(env.projectsDir, f.blob_path), 'utf8'), `${c.cid} ${f.path}`);
    }
  }
  // git 历史里 S001 的三个版本依次出现，最后一个等于正式文件
  const log = (await git(env.projectsDir, ['log', '--format=%H', '--', `${P}/sources/S001.json`])).stdout.trim().split('\n');
  assert.equal(log.length, 3);
  const head = (await git(env.projectsDir, ['cat-file', 'blob', `HEAD:${P}/sources/S001.json`])).stdout;
  assert.equal(head, fs.readFileSync(path.join(env.projectsDir, P, 'sources', 'S001.json'), 'utf8'));
});
