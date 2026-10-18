// 提交入口与恢复（契约二），以及记录读写、追溯
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from '../../lib/workbench/git.mjs';
import { acquireLock, createCommitLog } from '../../lib/workbench/txn.mjs';
import { sha256 } from '../../lib/workbench/records.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { setup, restart, submit, seed, newSource, rid, HUMAN, DEFAULTS, ROOT, tmpBase, cleanup, readJson } from './helpers.mjs';

after(cleanup);
const gitAvailable = (await git(os.tmpdir(), ['--version'])).ok;
const P = '样本';
const rec = (projectsDir, rel) => readJson(path.join(projectsDir, P, rel));
const statusOf = (gw, id) => gw.getRecord(P, id).status;
const quiesce = async (env) => {
  await env.gw.queue.idle();
  env.gw.stop();
};

// ---------- 契约二 验收案例 ----------

test('两个任务都基于 C001 v1 修改：只有一个成为 v2，另一个保留为候选稿并返回版本冲突', async () => {
  const env = await setup();
  await seed(env.gw);
  const edit = (text) => [{ id: 'C001', expected_version: 1, data: { type: 'fact', text, sources: [{ id: 'S001', version: 1 }] } }];
  const a = env.gw.receive(P, { request_id: rid(), changes: edit('甲的改法') }, { actor: HUMAN });
  const b = env.gw.receive(P, { request_id: rid(), changes: edit('乙的改法') }, { actor: HUMAN });
  const [ra, rb] = await Promise.allSettled([env.gw.promote(P, a.sid), env.gw.promote(P, b.sid)]);
  assert.equal(ra.status, 'fulfilled');
  assert.equal(rb.status, 'rejected');
  assert.equal(rb.reason.status, 409);
  assert.deepEqual(rb.reason.details.reasons, [{ type: 'version_conflict', id: 'C001', expected: 1, current: 2 }]);
  assert.equal(rec(env.projectsDir, 'claims/C001.json').text, '甲的改法');
  // 乙的结果没有丢：候选稿还在，未晋升，失败原因有记录
  const cand = env.gw.candidates(P).find((c) => c.sid === b.sid);
  assert.equal(cand.state, 'received');
  assert.equal(cand.applied, null);
  const attempts = fs.readFileSync(path.join(env.projectsDir, P, 'candidates', b.sid, 'attempts.jsonl'), 'utf8');
  assert.match(attempts, /version_conflict/);
});

test('写完新来源后强制杀进程：重启后依赖它的论断和页面自动为 stale', async () => {
  const env = await setup();
  await seed(env.gw);
  const changes = path.join(tmpBase(), 'changes.json');
  fs.writeFileSync(changes, JSON.stringify([{ id: 'S001', expected_version: 1, data: { title: '来源（更正版）', url: 'https://example.org/a', text: '更正后的正文' } }]));
  await quiesce(env); // 生产环境由单实例锁保证：子进程启动前，这里的实例已经停下
  const child = spawnSync(process.execPath, [path.join(ROOT, 'tests/workbench/fixtures/crash-child.mjs'), env.projectsDir, P, 'file:0', changes], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  // 杀进程时文件已经写了，但 applied 还没写
  assert.equal(rec(env.projectsDir, 'sources/S001.json').version, 2);
  const { gw, recovered } = await restart(env);
  assert.equal(recovered.redone.length, 1);
  assert.equal(statusOf(gw, 'S001').freshness, 'current');
  assert.equal(statusOf(gw, 'C001').freshness, 'stale');
  assert.equal(statusOf(gw, 'SL001').freshness, 'stale');
  assert.deepEqual(gw.inbox(P), []); // 恢复补写了 applied，不会被当成外部改动
});

test('在写入文件的第 3 步中途被杀：重启后补完写入，不出现半新半旧', async () => {
  const env = await setup();
  await seed(env.gw);
  const changes = path.join(tmpBase(), 'changes.json');
  fs.writeFileSync(changes, JSON.stringify([
    { id: 'S001', expected_version: 1, data: { title: '来源 v2', url: 'https://example.org/a', text: '新正文：最早见于《三五历纪》' } },
    { id: 'C001', expected_version: 1, data: { type: 'fact', text: '论断 v2', sources: [{ id: 'S001', version: 2, quote: '最早见于《三五历纪》' }] } },
  ]));
  await quiesce(env); // 生产环境由单实例锁保证：子进程启动前，这里的实例已经停下
  const child = spawnSync(process.execPath, [path.join(ROOT, 'tests/workbench/fixtures/crash-child.mjs'), env.projectsDir, P, 'file:0', changes], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(rec(env.projectsDir, 'sources/S001.json').version, 2);
  assert.equal(rec(env.projectsDir, 'claims/C001.json').version, 1); // 崩溃那一刻确实是半新半旧
  const { gw } = await restart(env);
  assert.equal(rec(env.projectsDir, 'claims/C001.json').version, 2);
  assert.equal(rec(env.projectsDir, 'claims/C001.json').commit, rec(env.projectsDir, 'sources/S001.json').commit);
  assert.equal(statusOf(gw, 'C001').freshness, 'current');
  assert.deepEqual(gw.inbox(P), []);
});

test('提交流程每一步之后崩溃，重启后状态都一致，且只有一条 applied', async () => {
  for (const step of ['prepared', 'archived-old', 'file:0', 'file:1', 'applied']) {
    const env = await setup();
    await seed(env.gw);
    let armed = false;
    const crashing = await restart(env, { crash: (s) => { if (armed && s === step) throw Object.assign(new Error('crash'), { crash: true }); } });
    armed = true;
    const r = crashing.gw.receive(P, { request_id: rid(), changes: [
      { id: 'S001', expected_version: 1, data: { title: 'v2', url: 'https://example.org/a', text: 'x' } },
      { id: 'C001', expected_version: 1, data: { type: 'fact', text: 'v2', sources: [{ id: 'S001', version: 2 }] } },
    ] }, { actor: HUMAN });
    // 清单已落盘后出错，入口会就地重做一次：只在 prepared 之后出错时重做能成功，其余步骤每次都出错，进入故障状态
    const outcome = await crashing.gw.promote(P, r.sid).then(() => 'applied', (e) => e.status ?? 'crash');
    // prepared 之后：就地重做成功；applied 之后：数据已经提交，请求照样算成功
    assert.equal(outcome, ['prepared', 'applied'].includes(step) ? 'applied' : 503, step);
    if (outcome === 503) {
      // 故障状态下拒绝一切后续写入
      const other = crashing.gw.receive(P, { request_id: rid(), changes: [newSource('$x', 'y')] }, { actor: HUMAN });
      await assert.rejects(crashing.gw.promote(P, other.sid), { status: 503 }, step);
      await assert.rejects(crashing.gw.createProject('故障中新建'), { status: 503 }, step);
      assert.equal(crashing.gw.inbox(P)[0].type, 'write_fault', step);
    }
    const { gw } = await restart(env);
    assert.equal(rec(env.projectsDir, 'sources/S001.json').version, 2, step);
    assert.equal(rec(env.projectsDir, 'claims/C001.json').version, 2, step);
    const applied = fs.readFileSync(path.join(env.projectsDir, 'commits.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"applied"'));
    assert.equal(applied.length, 2, step); // seed 一次 ＋ 本次一次
    assert.deepEqual(fs.readdirSync(path.join(env.projectsDir, '_txn')), [], step);
    // 再次晋升同一份候选稿：返回已有结果，不产生新版本
    const again = await gw.promote(P, r.sid);
    assert.equal(again.duplicate, true, step);
    assert.equal(rec(env.projectsDir, 'claims/C001.json').version, 2, step);
    assert.deepEqual(gw.inbox(P), [], step);
  }
});

test('git 不可用：数据提交照常成功，留档显示待重试；git 恢复后自动补交', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const gitOpts = { bin: 'git-不存在-xyz' };
  const env = await setup({ gitOpts });
  const { result } = await seed(env.gw);
  assert.equal(result.state, 'applied');
  await env.gw.queue.idle();
  const failed = env.gw.commits(P).find((c) => c.cid === result.cid);
  assert.equal(failed.archive.state, 'failed');
  assert.equal(env.gw.overview(P).commits.archivePending, 1);
  assert.equal(env.gw.inbox(P).filter((i) => i.type === 'archive_failed').length, 1);
  gitOpts.bin = 'git';
  await env.gw.archive();
  assert.equal(env.gw.commits(P).find((c) => c.cid === result.cid).archive.state, 'archived');
  const files = (await git(env.projectsDir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n');
  assert.ok(files.includes(`${P}/claims/C001.json`));
  assert.deepEqual(env.gw.inbox(P), []);
});

test('两个项目同时提交：各自的 git 提交只包含本次清单里的文件', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const env = await setup({ projects: ['甲', '乙'] });
  const one = (p) => submit(env.gw, p, [{ kind: 'source', expected_version: 0, data: { title: p, url: 'https://example.org' } }]);
  const [a, b] = await Promise.all([one('甲'), one('乙')]);
  await env.gw.queue.idle();
  for (const [p, r] of [['甲', a], ['乙', b]]) {
    const sha = env.gw.commits(p).find((c) => c.cid === r.result.cid).archive.git;
    const files = (await git(env.projectsDir, ['show', '--name-only', '--format=', sha])).stdout.trim().split('\n');
    assert.deepEqual(files, [`${p}/sources/S001.json`]);
  }
});

test('尝试启动第二个服务实例：被拒绝；上一个实例异常退出留下的锁会作废', async () => {
  const dir = path.join(tmpBase(), '项目资料');
  fs.mkdirSync(dir, { recursive: true });
  const first = acquireLock(dir, { isAlive: () => true });
  assert.throws(() => acquireLock(dir, { isAlive: () => true }), { status: 423 });
  first.release();
  const again = acquireLock(dir, { isAlive: () => true });
  assert.ok(again.token);
  // 持有者进程已经不在：锁作废，可以接手
  const taken = acquireLock(dir, { isAlive: () => false });
  assert.notEqual(taken.token, again.token);
  // 真实进程号：当前进程活着，所以拒绝
  taken.release();
  acquireLock(dir);
  assert.throws(() => acquireLock(dir), { status: 423 });
});

test('提交入口的单实例锁：第二个入口 start 时被拒绝，stop 之后可以启动', async () => {
  const env = await setup();
  const mk = () => createCommitGateway({ workbench: env.workbench, defaults: DEFAULTS, lockOpts: { isAlive: () => true } });
  const a = mk();
  await a.start();
  await assert.rejects(mk().start(), { status: 423 });
  a.stop();
  const b = mk();
  await b.start();
  b.stop();
});

// ---------- 幂等、身份、校验 ----------

test('同一 request_id 重试返回第一次的结果，不产生第二个候选稿；内容不同则冲突', async () => {
  const env = await setup();
  const body = { request_id: rid(), changes: [newSource('$a', '正文')] };
  const first = env.gw.receive(P, body, { actor: HUMAN });
  const second = env.gw.receive(P, structuredClone(body), { actor: HUMAN });
  assert.equal(second.sid, first.sid);
  assert.equal(second.duplicate, true);
  assert.equal(env.gw.candidates(P).length, 1);
  const changed = { ...body, changes: [newSource('$a', '另一份正文')] };
  assert.throws(() => env.gw.receive(P, changed, { actor: HUMAN }), { status: 409 });
  // 重启后幂等索引从候选稿重建
  await env.gw.promote(P, first.sid);
  const { gw } = await restart(env);
  assert.equal(gw.receive(P, structuredClone(body), { actor: HUMAN }).sid, first.sid);
  assert.equal((await gw.promote(P, first.sid)).duplicate, true);
});

test('身份不从请求体里取：没有任务号又不是主持人入口的提交被拒绝；任务系统（WP4）之前任务号一律不存在', async () => {
  const env = await setup();
  const body = { request_id: rid(), author: '主持人', kind: 'human', changes: [newSource('$a', 'x')] };
  assert.throws(() => env.gw.receive(P, body), { status: 403 });
  assert.throws(() => env.gw.receive(P, { ...body, task_id: 'T001', attempt: 1, lease_token: 'x' }), { status: 404 });
});

test('记录字段校验：系统字段、未知字段、缺最早出处、核验与异议（WP5 之前）都被拒绝', async () => {
  const env = await setup();
  const bad = [
    [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'https://a', version: 3 } }, /version 由提交入口填写/],
    [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'https://a', provenance: {} } }, /provenance 由提交入口填写/],
    [{ kind: 'source', expected_version: 0, data: { title: 'x' } }, /至少要有 citation 或 url/],
    [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'ftp://a' } }, /url 必须以/],
    [{ kind: 'claim', expected_version: 0, data: { type: 'textual', text: 'x', sources: [] } }, /earliest_attestation/],
    [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001' }] } }, /version 必须是正整数/],
    [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', status: 'supported' } }, /未知字段 status/],
    [{ kind: 'verification', expected_version: 0, data: {} }, /WP5/],
    [{ kind: 'objection', expected_version: 0, data: {} }, /WP5/],
    [{ kind: 'source', expected_version: 1, data: { title: 'x', url: 'https://a' } }, /新建记录不写 id/],
    [{ id: 'S001', expected_version: 0, data: { title: 'x', url: 'https://a' } }, /新建记录不写 id/],
    [{ id: 'C001', kind: 'source', expected_version: 1, data: {} }, /kind 与编号/],
  ];
  for (const [change, msg] of bad) assert.throws(() => env.gw.receive(P, { request_id: rid(), changes: [change] }, { actor: HUMAN }), msg, JSON.stringify(change));
  assert.throws(() => env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: '$nope' }] } }] }, { actor: HUMAN }), /未定义的临时编号/);
});

test('依赖必须是当前版本：基于旧版来源的论断不能晋升', async () => {
  const env = await setup();
  await seed(env.gw);
  await submit(env.gw, P, [{ id: 'S001', expected_version: 1, data: { title: 'v2', url: 'https://example.org/a' } }]);
  const r = env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, r.sid), (e) => e.status === 409 && e.details.reasons[0].type === 'stale_dependency');
});

test('服务进程之外改过的记录：进入待你决定，提交入口拒绝覆盖它', async () => {
  const env = await setup();
  await seed(env.gw);
  const file = path.join(env.projectsDir, P, 'claims', 'C001.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('最早见于', '据说见于'));
  assert.deepEqual(env.gw.inbox(P).map((i) => [i.type, i.path]), [['external_change', `${P}/claims/C001.json`]]);
  const r = env.gw.receive(P, { request_id: rid(), changes: [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'y', sources: [{ id: 'S001', version: 1 }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, r.sid), (e) => e.details.reasons.some((x) => x.type === 'external_change'));
  // 手工放进来的新文件同样算外部改动，新编号也会跳过它
  fs.writeFileSync(path.join(env.projectsDir, P, 'sources', 'S007.json'), '{坏文件');
  const items = env.gw.inbox(P).map((i) => i.type).sort();
  assert.deepEqual(items, ['bad_record_file', 'external_change', 'external_change']);
  const { result } = await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: 'n', url: 'https://a' } }]);
  assert.deepEqual(result.records, [{ id: 'S008', version: 1 }]);
});

test('提交日志末尾的半行被修掉，之后的追加不会接在半行后面', async () => {
  const env = await setup();
  await seed(env.gw);
  await quiesce(env);
  fs.appendFileSync(path.join(env.projectsDir, 'commits.jsonl'), '{"cid":"0000');
  const { gw } = await restart(env);
  await submit(gw, P, [{ kind: 'source', expected_version: 0, data: { title: 'n', url: 'https://a' } }]);
  const lines = fs.readFileSync(path.join(env.projectsDir, 'commits.jsonl'), 'utf8').trim().split('\n');
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), l);
  assert.equal(createCommitLog(env.projectsDir).list(P).length, 2);
});

test('git 留档与正式文件逐字节一致（含 CRLF 正文快照），不受全局换行设置影响', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const env = await setup();
  const text = '第一行\r\n第二行\r\n';
  const { result } = await submit(env.gw, P, [newSource('$a', text)]);
  await env.gw.queue.idle();
  const line = env.gw.commits(P).find((c) => c.cid === result.cid);
  assert.equal(line.archive.state, 'archived');
  for (const f of [...line.files.map((x) => x.path), ...line.extra]) {
    const inGit = (await git(env.projectsDir, ['cat-file', 'blob', `HEAD:${f}`], { env: {} })).stdout;
    const onDisk = fs.readFileSync(path.join(env.projectsDir, f), 'utf8');
    assert.equal(inGit, onDisk, f);
  }
  const blobRel = line.extra[0];
  assert.equal(fs.readFileSync(path.join(env.projectsDir, blobRel), 'utf8'), text);
  assert.equal(sha256(fs.readFileSync(path.join(env.projectsDir, blobRel))), path.basename(blobRel));
  // 用户已暂存的其他改动没有被带进留档，也没有被清掉
  fs.writeFileSync(path.join(env.projectsDir, 'note.txt'), 'x');
  await git(env.projectsDir, ['add', 'note.txt']);
  await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: 'n', url: 'https://a' } }]);
  await env.gw.queue.idle();
  assert.equal((await git(env.projectsDir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim(), `${P}/sources/S002.json`);
  assert.equal((await git(env.projectsDir, ['diff', '--cached', '--name-only'])).stdout.trim(), 'note.txt');
});

// ---------- 版本、来源、追溯 ----------

test('修改记录：旧版本进归档，历史可查，内容来源随版本记录', async () => {
  const env = await setup();
  await seed(env.gw);
  await submit(env.gw, P, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: '改过的论断', sources: [{ id: 'S001', version: 1 }] } }]);
  const r = env.gw.getRecord(P, 'C001');
  assert.equal(r.record.version, 2);
  assert.deepEqual(r.history.map((h) => h.version), [2, 1]);
  assert.equal(r.record.provenance.kind, 'human');
  assert.equal(r.record.provenance.basis, 'host-session');
  const old = readJson(path.join(env.projectsDir, P, 'archive', 'versions', 'claims', 'C001.v1.json'));
  assert.equal(old.text, '盘古故事最早见于《三五历纪》');
  // 页面引用的是 C001 v1，现在 C001 是 v2：页面 stale
  assert.equal(statusOf(env.gw, 'SL001').freshness, 'stale');
});

test('追溯：从一页 PPT 到论断、来源和原文位置；按引用时的版本取正文', async () => {
  const env = await setup();
  await seed(env.gw);
  const t = env.gw.trace(P, 'SL001');
  assert.equal(t.kind, 'slide');
  const claim = t.root.claims[0];
  assert.equal(claim.id, 'C001');
  assert.equal(claim.type, 'textual');
  const src = claim.sources[0];
  assert.equal(src.id, 'S001');
  assert.equal(src.locator, '第 1 段');
  assert.equal(src.quote_found, true);
  assert.equal(src.context.before, '神话学家指出，盘古开天辟地的故事');
  assert.equal(src.context.offset, 16);
  // 来源换了正文以后，追溯仍按论断引用的 v1 正文核对引文
  await submit(env.gw, P, [{ id: 'S001', expected_version: 1, data: { title: 'v2', url: 'https://example.org/a', text: '完全不同的正文' } }]);
  const t2 = env.gw.trace(P, 'SL001');
  assert.equal(t2.root.claims[0].sources[0].quote_found, true);
  assert.equal(t2.root.claims[0].sources[0].current_version, 2);
  assert.equal(t2.root.status.freshness, 'stale');
  // 从来源反查下游
  assert.deepEqual(env.gw.trace(P, 'S001').downstream, [{ id: 'C001', downstream: ['SL001'] }]);
  // 引文在正文里找不到
  await submit(env.gw, P, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'y', sources: [{ id: 'S001', version: 2, quote: '不存在的引文' }] } }]);
  assert.equal(env.gw.trace(P, 'C002').root.sources[0].quote_found, false);
});

test('概况统计', async () => {
  const env = await setup();
  await seed(env.gw);
  const o = env.gw.overview(P);
  assert.deepEqual(o.summary.byKind, { source: 1, claim: 1, slide: 1 });
  assert.deepEqual(o.summary.claims, { unreviewed: 1, supported: 0, disputed: 0, unsupported: 0 });
  assert.equal(o.summary.ready, 0);
  assert.equal(o.commits.total, 1);
  assert.equal(o.candidates.pending, 0);
});
