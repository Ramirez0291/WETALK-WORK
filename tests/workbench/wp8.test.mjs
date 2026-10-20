// WP8：在页面上改项目约定与参数、Agent 起草约定。
// 单元：约定的分节（原样往返、没填的节、草案合并）、草案解析；提交入口：改约定与参数（hash 对不上拒绝、不合法不动文件、旧版本存档、留档）；
// HTTP：真实启动 server.mjs（临时目录、假 Agent），起草 → 草案 → 确认，以及起草任务的边界（只由 /plan 发起、外部会话不能认领、任务包不重复带约定）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { ROOT, TEMPLATES, setup, tmpBase, cleanup } from './helpers.mjs';
import { parseConventions, joinConventions, contentOf, hintsOf, bodyFrom, missingOf, mergeSections } from '../../public/conventions.js';
import { parseDraft } from '../../lib/workbench/draft.mjs';
import { git } from '../../lib/workbench/git.mjs';

const TEMPLATE = fs.readFileSync(path.join(TEMPLATES, 'project.md'), 'utf8').replace('{{name}}', '样本').replace('{{date}}', '2026-10-20');
const gitAvailable = (await git(os.tmpdir(), ['--version'])).ok;

test('约定分节：开头加各节原样拼回原文；没填的节；草案只替换写了的节，其余一个字符不差', () => {
  const doc = parseConventions(TEMPLATE);
  assert.deepEqual(doc.sections.map((s) => s.title), ['受众', '观众看完后应当理解什么', '篇幅与页数', '风格', '验收标准', '不在本项目范围内']);
  assert.equal(joinConventions(doc), TEMPLATE);
  // CRLF 和代码块里的 ## 也不打乱分节
  const crlf = '# T\r\n\r\n## 甲\r\n内容\r\n```\r\n## 不是标题\r\n```\r\n## 乙\r\n';
  assert.equal(joinConventions(parseConventions(crlf)), crlf);
  assert.deepEqual(parseConventions(crlf).sections.map((s) => s.title), ['甲', '乙']);

  assert.deepEqual(missingOf(TEMPLATE), [
    { title: '受众', kind: 'empty' },
    { title: '观众看完后应当理解什么', kind: 'empty' },
    { title: '篇幅与页数', kind: 'blank', fields: ['页数', '讲述时长'] },
    { title: '风格', kind: 'empty' },
    { title: '不在本项目范围内', kind: 'empty' },
  ]);
  const aud = doc.sections[0];
  assert.deepEqual(hintsOf(aud.body), ['（谁来看：身份、已有知识、对这个话题的兴趣或疑虑。）']);
  assert.equal(contentOf(aud.body), '');
  assert.equal(bodyFrom('', hintsOf(aud.body)), `\n${hintsOf(aud.body)[0]}\n\n`); // 清空一节时放回引导语

  const merged = mergeSections(TEMPLATE, { 受众: '大学老师', 风格: '  ', 不存在: 'x' });
  const after = parseConventions(merged);
  assert.equal(contentOf(after.sections[0].body), '大学老师');
  for (const i of [1, 2, 3, 4, 5]) assert.equal(after.sections[i].body, doc.sections[i].body); // 空白的草案节不替换
  assert.equal(after.head, doc.head);
  assert.deepEqual(missingOf(merged).map((m) => m.title), ['观众看完后应当理解什么', '篇幅与页数', '风格', '不在本项目范围内']);
});

test('草案解析：只收约定里有的节，对不上的列出来；没有 json、没有一节对得上都算失败', () => {
  const raw = '草案如下：\n```json\n' + JSON.stringify({ sections: { 受众: '老师', ' 风格 ': '简洁', 结论: '不该写' }, questions: ['页数？', 3, ''], queries: ['甲', '乙'] }) + '\n```';
  const d = parseDraft(raw, TEMPLATE);
  assert.deepEqual(d.sections, { 受众: '老师', 风格: '简洁' });
  assert.deepEqual(d.ignored, ['结论']);
  assert.deepEqual(d.questions, ['页数？']);
  assert.deepEqual(d.queries, ['甲', '乙']);
  assert.equal(d.conventions, mergeSections(TEMPLATE, d.sections));
  assert.throws(() => parseDraft('没有代码块', TEMPLATE), /没有 ```json/);
  assert.throws(() => parseDraft('```json\n{"sections":{"别的":"x"}}\n```', TEMPLATE), /没有能对上约定的节/);
  assert.throws(() => parseDraft('```json\n["x"]\n```', TEMPLATE), /sections/);
});

test('改约定与参数：hash 对不上（含服务之外改过）拒绝；参数不合法时文件不动；旧版本存档，按配置留档；内容没变不写', async () => {
  const { gw, workbench, projectsDir } = await setup();
  const p = workbench.get('样本');
  const file = path.join(p.dir, 'project.md');
  const text = mergeSections(p.conventions, { 受众: '大学老师' });

  await assert.rejects(gw.setConventions('样本', { text, expected: 'x'.repeat(64) }, '主持人'), (e) => e.status === 409);
  await assert.rejects(gw.setConventions('样本', { text }, '主持人'), (e) => e.status === 400); // 没带 expected
  await assert.rejects(gw.setConventions('样本', { text: '  ', expected: p.hashes.conventions }, '主持人'), (e) => e.status === 400);
  const r = await gw.setConventions('样本', { text, expected: p.hashes.conventions }, '主持人');
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.notEqual(r.project.hashes.conventions, p.hashes.conventions);
  const kept = fs.readdirSync(path.join(p.dir, 'archive', 'versions', '_project'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(p.dir, 'archive', 'versions', '_project', kept[0]), 'utf8'), p.conventions);
  const ev = fs.readFileSync(path.join(p.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([ev.type, ev.file, ev.from, ev.to, ev.by], ['setting_changed', 'project.md', p.hashes.conventions, r.project.hashes.conventions, '主持人']);
  if (gitAvailable) {
    assert.equal(r.archive.state, 'done');
    const log = await git(projectsDir, ['log', '--format=%s', '-1', '--', '样本/project.md']);
    assert.match(log.stdout, /修改 样本 的项目约定/);
  }
  // 内容没变：不写、不存档
  const same = await gw.setConventions('样本', { text, expected: r.project.hashes.conventions }, '主持人');
  assert.equal(same.changed, false);
  assert.equal(fs.readdirSync(path.join(p.dir, 'archive', 'versions', '_project')).length, 1);
  // 服务之外改过：页面拿着旧 hash，保存被拒绝，外部的改动保留
  fs.appendFileSync(file, '外部追加\n');
  await assert.rejects(gw.setConventions('样本', { text, expected: r.project.hashes.conventions }, '主持人'), (e) => e.status === 409 && /被改过/.test(e.message));
  assert.match(fs.readFileSync(file, 'utf8'), /外部追加/);

  // 参数：不合法（份数超出、未知参数、上限设为 null）一律拒绝，文件不动
  const pfile = path.join(p.dir, 'protocol.json');
  const before = fs.readFileSync(pfile, 'utf8');
  const expected = workbench.get('样本').hashes.protocol;
  for (const override of [{ compete: { drafts: 9 } }, { nope: 1 }, { budget: { calls: null } }, [1]]) {
    await assert.rejects(gw.setProtocol('样本', { override, expected }, '主持人'), (e) => e.status === 400, JSON.stringify(override));
    assert.equal(fs.readFileSync(pfile, 'utf8'), before);
  }
  const keepNote = { ...JSON.parse(before), budget: { calls: 50 } };
  const pr = await gw.setProtocol('样本', { override: keepNote, expected }, '主持人');
  assert.equal(pr.changed, true);
  assert.equal(workbench.get('样本').config.budget.calls, 50);
  assert.deepEqual(JSON.parse(fs.readFileSync(pfile, 'utf8')), keepNote); // 备注键原样保留
});

// ---------- HTTP ----------

const FAKE = path.join(ROOT, 'tests/workbench/fixtures/fake-agent.mjs');
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const DRAFT = { sections: { 受众: '没有编程背景的老师', 观众看完后应当理解什么: '1. 单个 AI 难核对出处。', 没有这节: 'x' }, questions: ['讲多久？'], queries: ['交叉核验'] };

let server;
let port;
let base;
before(async () => {
  base = tmpBase();
  port = await freePort();
  const fake = (id, model, ...args) => ({ id, name: `${id}名`, model, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args] });
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({
    port, humanName: '主持人', timeoutSec: 30,
    participants: [
      fake('planner', 'claude-fake', 'record', path.join(base, 'prompt.txt'), '```json\n' + JSON.stringify(DRAFT) + '\n```'),
      fake('broken', 'claude-fake', 'say', '我不想用 json'),
    ],
  }));
  const env = { ...process.env, WETALK_CONFIG: path.join(base, 'config.json'), WETALK_DATA: path.join(base, 'data'), WETALK_PROJECTS: path.join(base, '项目资料'), WETALK_PORT: String(port), DEEPSEEK_API_KEY: '' };
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`服务没有启动：${out}`)), 15_000);
    server.stdout.on('data', () => out.includes('工坊已启动') && (clearTimeout(t), resolve()));
    server.on('exit', (code) => (clearTimeout(t), reject(new Error(`服务退出（${code}）：${out}`))));
  });
});
after(async () => {
  if (server?.exitCode === null) {
    const exited = new Promise((r) => server.on('exit', r));
    server.kill();
    await exited;
  }
  await cleanup();
});

const url = (p) => `http://127.0.0.1:${port}${p}`;
let token;
async function call(method, p, body, host = true) {
  token ??= (await (await fetch(url('/'))).text()).match(/name="wb-host-token" content="([0-9a-f]+)"/)[1];
  const res = await fetch(url(p), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(host ? { 'X-Workbench-Host': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const P = `/api/projects/${encodeURIComponent('八')}`;
const until = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${what}`);
};

test('HTTP：派 Agent 起草约定 → 草案按节合并 → 页面确认写入；只限主持人；起草任务只由 /plan 发起、外部会话不能认领、不进调度', async () => {
  assert.equal((await call('POST', '/api/projects', { name: '八' })).status, 200);
  const o = (await call('GET', P)).body;
  assert.equal(o.missing.length, 5);
  assert.match(o.hashes.conventions, /^[0-9a-f]{64}$/);
  const js = await fetch(url('/conventions.js'));
  assert.deepEqual([js.status, js.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  await js.text();

  // 只限主持人；说明不能为空；参与者要存在
  assert.equal((await call('POST', `${P}/plan`, { participant: 'planner', brief: '给老师讲' }, false)).status, 403);
  assert.equal((await call('POST', `${P}/conventions`, { text: 'x', expected: o.hashes.conventions }, false)).status, 403);
  assert.equal((await call('POST', `${P}/protocol`, { override: {}, expected: o.hashes.protocol }, false)).status, 403);
  assert.equal((await call('POST', `${P}/plan`, { participant: 'planner', brief: ' ' })).status, 400);
  assert.equal((await call('POST', `${P}/plan`, { participant: 'nobody', brief: '给老师讲' })).status, 404);
  // 起草任务不能从任务接口直接建
  assert.equal((await call('POST', `${P}/tasks`, { type: 'plan_project', title: 'x' })).status, 400);

  const r = await call('POST', `${P}/plan`, { participant: 'planner', brief: '给没有编程背景的老师讲多 AI 核验，15 分钟。' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tid = r.body.task.id;
  assert.equal(r.body.task.visibility, 'plan');
  let pl;
  await until(async () => (pl = (await call('GET', `${P}/plan`)).body).task.state === 'done', '草案交来');
  assert.deepEqual(pl.proposal.sections, { 受众: '没有编程背景的老师', 观众看完后应当理解什么: '1. 单个 AI 难核对出处。' });
  assert.deepEqual(pl.proposal.ignored, ['没有这节']);
  assert.deepEqual([pl.proposal.questions, pl.proposal.queries, pl.stale], [['讲多久？'], ['交叉核验'], false]);
  // 草案不直接写进 project.md
  assert.equal((await call('GET', P)).body.conventions, o.conventions);
  // 提示词：说明在“目标”里，现在的约定（含引导语）作为输入给一次，不再重复一份项目约定
  const prompt = fs.readFileSync(path.join(base, 'prompt.txt'), 'utf8');
  assert.match(prompt, /目标：给没有编程背景的老师讲多 AI 核验/);
  assert.match(prompt, /【现在的项目约定\.md】[\s\S]*（谁来看：身份/);
  assert.doesNotMatch(prompt, /======== 项目约定 ========/);
  // 外部会话不能认领起草任务（交来的是草案，不是 changes）
  const again = (await call('POST', `${P}/plan`, { participant: 'broken', brief: '再来一份' })).body.task.id;
  await until(async () => ['open', 'failed'].includes((await call('GET', `${P}/tasks/${again}`)).body.state), '不合格式的草案退回');
  const t2 = (await call('GET', `${P}/tasks/${again}`)).body;
  assert.match(t2.history.at(-1).reason, /草案不能用：回复里没有 ```json/);
  if (t2.state === 'open') {
    assert.equal((await call('POST', `${P}/tasks/${again}/claim`, { agent: '外部' }, false)).status, 409);
    // 留在 open 的起草任务不会被调度派给别人
    const run = (await call('POST', `${P}/scheduler/run`, {})).body;
    assert.equal(run.round, null);
    assert.ok(!(run.last?.skipped ?? []).some((x) => x.task === again));
    await call('POST', `${P}/tasks/${again}/cancel`, {});
  }

  // 确认第一份草案：写入约定
  const ok = await call('POST', `${P}/conventions`, { text: pl.proposal.conventions, expected: o.hashes.conventions });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.changed, true);
  assert.deepEqual(ok.body.missing.map((m) => m.title), ['篇幅与页数', '风格', '不在本项目范围内']);
  const o2 = (await call('GET', P)).body;
  assert.equal(o2.conventions, pl.proposal.conventions);
  // 拿着旧 hash 再存：拒绝
  assert.equal((await call('POST', `${P}/conventions`, { text: 'x', expected: o.hashes.conventions })).status, 409);
  // 草案记着它按哪一版约定合并；约定改过之后，最近一份草案算过时（页面不再提示“待确认”）
  const t1 = (await call('GET', `${P}/tasks/${tid}`)).body;
  assert.equal(t1.plan.base, o.hashes.conventions);
  const third = (await call('POST', `${P}/plan`, { participant: 'planner', brief: '第三次' })).body.task.id;
  await until(async () => (pl = (await call('GET', `${P}/plan`)).body).task.state === 'done', '第三份草案');
  assert.equal(pl.task.id, third);
  assert.equal(pl.stale, false);
  await call('POST', `${P}/conventions`, { text: `${o2.conventions}\n补一行\n`, expected: o2.hashes.conventions });
  assert.equal((await call('GET', `${P}/plan`)).body.stale, true);
  const o3 = (await call('GET', P)).body;

  // 参数：不合法拒绝，合法写入并生效
  assert.equal((await call('POST', `${P}/protocol`, { override: { compete: { drafts: 9 } }, expected: o3.hashes.protocol })).status, 400);
  const pr = await call('POST', `${P}/protocol`, { override: { budget: { calls: 40 } }, expected: o3.hashes.protocol });
  assert.equal(pr.status, 200, JSON.stringify(pr.body));
  assert.equal(pr.body.config.budget.calls, 40);
});
