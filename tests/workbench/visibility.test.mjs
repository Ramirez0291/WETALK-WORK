// 契约四：上下文与可见性；以及任务包的保存与还原、手动派发。全部用假 Agent，不调用真实模型。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner, parseChanges } from '../../lib/workbench/runner.mjs';
import { createSealedStore, anonymityTerms, findNames } from '../../lib/workbench/visibility.mjs';
import { restorePacket, cleanConventions } from '../../lib/workbench/packets.mjs';
import { resetPhase, phaseSpace } from '../../lib/workbench/phases.mjs';
import { createStore } from '../../lib/store.mjs';
import { runAgent, parseCodexEvents } from '../../lib/agents.mjs';
import { setup, restart, seed, submit, DEFAULTS, ROOT, TEMPLATES, tmpBase, cleanup, readJson } from './helpers.mjs';

after(cleanup);
const P = '样本';
const HOST = { kind: 'human', participant: '主持人', verified: true, basis: 'host-session' };
const FAKE = path.join(ROOT, 'tests/workbench/fixtures/fake-agent.mjs');
const fake = (id, ...args) => ({ id, name: id, adapter: 'generic', command: [process.execPath], args: [FAKE, ...args], model: `fake-${id}`, resolved: process.execPath });

async function runnerEnv(people = [], { participants: extra = [] } = {}) {
  const env = await setup();
  const usage = createUsage({ workbench: env.workbench, pricing: DEFAULTS.pricing });
  const board = createTaskBoard({ workbench: env.workbench, usage });
  const { gw } = await restart(env, { fence: board.fence, availabilityOf: (p, urlOf) => usage.availabilityOf(p, { urlOf }) });
  const sealed = createSealedStore();
  const all = [...people, ...extra];
  const lookup = Object.assign((id) => all.find((p) => p.id === id), { all: () => all });
  const base = tmpBase();
  const runner = createRunner({
    workbench: env.workbench, gateway: gw, board, usage, sealed, participants: lookup, runAgent,
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'),
    templateText: fs.readFileSync(path.join(TEMPLATES, 'project.md'), 'utf8'), timeoutMs: 20_000,
  });
  return { ...env, gw, usage, board, sealed, runner, base };
}

// 在目录树里找含某段文字的文件
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (fs.readFileSync(f).includes(Buffer.from(needle, 'utf8'))) hits.push(path.relative(dir, f));
    }
  };
  walk(dir);
  return hits;
}
const waitFor = async (fn, ms = 15_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 30));
  }
};

// ---------- 契约四 ----------

test('密封起草期间，另一 Agent 的草稿不出现在任何文件、调用记录、归档、任务状态和接口数据里；揭晓后才写盘', async () => {
  const release = path.join(tmpBase(), 'B可以交稿了');
  const b64 = (s) => Buffer.from(s).toString('base64');
  const env = await runnerEnv([fake('alpha', 'say64', b64('甲的草稿 SECRET-ALPHA-31')), fake('beta', 'say64', b64('乙的草稿 SECRET-BETA-77'), release)]);
  const a = env.board.create(P, { type: 'outline', title: '大纲甲' }, { created_by: HOST });
  const b = env.board.create(P, { type: 'outline', title: '大纲乙' }, { created_by: HOST });
  env.sealed.open(P, 'R1', [a.id, b.id]);
  env.runner.dispatch(P, a.id, 'alpha');
  env.runner.dispatch(P, b.id, 'beta');
  after(() => fs.writeFileSync(release, '')); // 断言失败时也放行乙，免得后台进程一直等
  await waitFor(() => env.board.get(P, a.id).state === 'submitted');
  // 甲已完成、乙还在写：甲的草稿哪里都找不到
  assert.deepEqual(filesContaining(env.projectsDir, 'SECRET-ALPHA-31'), []);
  assert.deepEqual(filesContaining(env.base, 'SECRET-ALPHA-31'), []); // 工作目录、沙箱目录
  assert.doesNotMatch(JSON.stringify(env.board.list(P)), /SECRET-ALPHA/);
  assert.doesNotMatch(JSON.stringify(env.sealed.status('R1')), /SECRET-ALPHA/);
  const calls = env.runner.callLogOf(P).list();
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(env.runner.callLogOf(P).getMany(() => true)), /SECRET-ALPHA/);
  assert.equal(calls[0].sealed, true);
  assert.throws(() => env.runner.reveal(P, 'R1'), /还有 1 份没完成/);
  fs.writeFileSync(release, '');
  await waitFor(() => env.board.get(P, b.id).state === 'submitted');
  await env.runner.idle();
  const r = env.runner.reveal(P, 'R1');
  assert.equal(r.results.length, 2);
  assert.equal(env.board.get(P, a.id).state, 'done');
  assert.ok(filesContaining(env.projectsDir, 'SECRET-ALPHA-31').length >= 2); // 正文 blob ＋ 调用记录的补写
  const fill = env.runner.callLogOf(P).getMany(() => true).find((c) => c.fill_of === calls[0].id);
  assert.match(fill.raw, /SECRET-ALPHA-31/);
});

test('服务在揭晓前重启：密封结果随进程消失，这些任务本轮重跑', async () => {
  const env = await runnerEnv([fake('alpha', 'say', '甲的草稿')]);
  const a = env.board.create(P, { type: 'outline' }, { created_by: HOST });
  env.runner.dispatch(P, a.id, 'alpha');
  await waitFor(() => env.board.get(P, a.id).state === 'submitted');
  const board2 = createTaskBoard({ workbench: env.workbench, usage: env.usage });
  assert.deepEqual(board2.recover(P), [a.id]);
  assert.equal(board2.get(P, a.id).state, 'open');
  assert.equal(board2.get(P, a.id).attempts[0].outcome, 'abandoned');
});

test('Codex 在密封任务中执行了读文件命令或调用了 MCP 工具：该稿被标为“独立性未证明”；干净的稿子不标', async () => {
  const dir = tmpBase();
  const cmd = path.join(dir, 'codex.cmd');
  fs.writeFileSync(cmd, `@"${process.execPath}" "${path.join(ROOT, 'tests/workbench/fixtures/fake-codex.mjs')}" %*\r\n`);
  const argsFile = path.join(dir, 'args.json');
  const codex = { id: 'codex', name: 'Codex', adapter: 'codex', command: [cmd], model: 'gpt-6-astra', resolved: cmd };
  const env = await runnerEnv([codex]);
  const results = {};
  for (const mode of ['reads', 'mcp', 'clean']) {
    process.env.FAKE_CODEX_MODE = mode;
    process.env.FAKE_CODEX_ARGS = argsFile;
    const t = env.board.create(P, { type: 'outline', title: mode }, { created_by: HOST });
    env.runner.dispatch(P, t.id, 'codex');
    await waitFor(() => env.board.get(P, t.id).state === 'submitted');
    results[mode] = env.board.get(P, t.id).attempts[0].independence;
    const args = readJson(argsFile);
    // 密封类调用：JSON 事件、不加载用户配置（不带 MCP 服务）、关掉 shell；不写最后消息的临时文件
    for (const flag of ['--json', '--ignore-user-config', 'shell_tool', 'unified_exec', '-m']) assert.ok(args.includes(flag), `${mode} 缺少 ${flag}`);
    assert.ok(!args.includes('-o'));
    const r = env.runner.reveal(P, `R-${t.id}`);
    assert.equal(r.results[0].independence, results[mode]);
  }
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_CODEX_ARGS;
  assert.deepEqual(results, { reads: 'unproven', mcp: 'unproven', clean: 'clean' });
  assert.match(env.board.list(P)[0].history.at(-1).reason, /独立性未证明/);
});

test('Codex 事件流的审计：所有非发言类 item 都记下，开始与完成只记一次', () => {
  const lines = [
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '先看看' } },
    { type: 'item.started', item: { id: 'b', type: 'command_execution', command: 'cat x' } },
    { type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'cat x', aggregated_output: '…' } },
    { type: 'item.completed', item: { id: 'c', type: 'web_search', query: 'x' } },
    { type: 'item.completed', item: { id: 'd', type: 'some_future_tool' } },
    { type: 'item.completed', item: { id: 'e', type: 'agent_message', text: '结论' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
  ];
  const r = parseCodexEvents({ stdout: lines.map((l) => JSON.stringify(l)).join('\n'), stderr: '', code: 0 });
  assert.equal(r.text, '结论');
  assert.deepEqual(r.audit.toolEvents.map((t) => t.type), ['command_execution', 'web_search', 'some_future_tool']);
  assert.equal(r.audit.independence, 'unproven');
  assert.throws(() => parseCodexEvents({ stdout: '不是 JSON', stderr: '', code: 1 }), /没有拿到 JSON 事件/);
});

test('匿名评审实际发送的提示词里搜不到任何作者、模型、厂商名称；对应关系只在服务端', async () => {
  const people = [
    { id: 'claude', name: 'Claude', adapter: 'claude', model: 'claude-opus-5-5', aliases: ['小克'] },
    { id: 'codex', name: 'Codex', adapter: 'codex', model: 'gpt-6-astra' },
    { id: 'antigravity', name: 'Gemini', adapter: 'agy', model: 'gemini-3.8-flash-high', aliases: ['Antigravity'] },
  ];
  const promptFile = path.join(tmpBase(), 'prompt.txt');
  const env = await runnerEnv([fake('reviewer', 'record', promptFile, '方案甲 第 2 节：论证跳跃。')], { participants: people });
  const blobs = (await import('../../lib/workbench/records.mjs')).blobStore(path.join(env.projectsDir, P));
  const d1 = blobs.put('# 方案（Claude Opus 起草，小克 署名）\n用 claude-opus-5-5 写的；参考了 Anthropic 的写法。');
  const d2 = blobs.put('# 方案（Codex / GPT 起草）\nOpenAI 的 gpt-6-astra 输出；Gemini 和 DeepSeek 没参与。');
  const t = env.board.create(P, { type: 'anonymous_review', inputs: [{ blob: d1, name: 'claude的方案.md' }, { blob: d2, name: 'codex的方案.md' }] }, { created_by: HOST });
  env.runner.dispatch(P, t.id, 'reviewer');
  await waitFor(() => env.board.get(P, t.id).state === 'submitted');
  const sent = fs.readFileSync(promptFile, 'utf8');
  const terms = anonymityTerms([...people, fake('reviewer')]);
  assert.deepEqual(findNames(sent, terms.filter((x) => x !== 'reviewer')), []);
  assert.match(sent, /方案甲/);
  assert.match(sent, /方案乙/);
  assert.doesNotMatch(sent, /claude的方案|codex的方案/);
  // 任务包里存的也是匿名后的内容；揭晓时才给出标签与原稿的对应
  const restored = restorePacket(path.join(env.projectsDir, P), `${t.id}-a1`);
  assert.equal(restored.prompt, sent);
  assert.deepEqual(findNames(restored.inputs.map((i) => i.text).join('\n'), terms.filter((x) => x !== 'reviewer')), []);
  const r = env.runner.reveal(P, `R-${t.id}`);
  assert.deepEqual(Object.keys(r.results[0].mapping).sort(), ['方案乙', '方案甲']);
});

test('观众型读者实际发送的提示词里不含任何来源或论断；任务包里放了来源或论断就拒绝', async () => {
  const promptFile = path.join(tmpBase(), 'prompt.txt');
  const env = await runnerEnv([fake('reader', 'record', promptFile, '我理解的核心观点是……')]);
  await seed(env.gw); // S001（正文含“三五历纪”）← C001 ← SL001
  const t = env.board.create(P, { type: 'audience_reader', inputs: [{ id: 'SL001', version: 1 }] }, { created_by: HOST });
  env.runner.dispatch(P, t.id, 'reader');
  await waitFor(() => env.board.get(P, t.id).state === 'submitted');
  const sent = fs.readFileSync(promptFile, 'utf8');
  assert.match(sent, /盘古来晚了/); // 页面正文在
  for (const leak of ['C001', 'S001', '神话学家指出', '最早见于三国吴徐整', 'earliest_attestation', '"sources"', '"claims"']) assert.ok(!sent.includes(leak), `不该出现：${leak}`);
  const bad = env.board.create(P, { type: 'audience_reader', inputs: [{ id: 'C001', version: 1 }] }, { created_by: HOST });
  env.runner.dispatch(P, bad.id, 'reader');
  await waitFor(() => ['open', 'failed'].includes(env.board.get(P, bad.id).state));
  assert.match(env.board.get(P, bad.id).history.at(-1).reason, /观众型读者的任务包不能包含 C001/);
});

test('重置某项目的一个阶段：只归档并清空这个空间，全局记忆和其他项目、其他阶段的记忆空间不变', () => {
  const dir = tmpBase();
  const store = createStore(path.join(dir, 'forum.json'));
  const mine = phaseSpace(store, '样本', '起草');
  const otherPhase = phaseSpace(store, '样本', '核验');
  const otherProject = phaseSpace(store, '别的项目', '起草');
  store.addMemory('shared/claude', { name: 'Claude', content: '全局', source: 'test' });
  store.addMemory(`${mine.id}/claude`, { name: 'Claude', content: '本阶段笔记', source: 'test' });
  store.addMemory(`${otherPhase.id}/claude`, { name: 'Claude', content: '核验阶段', source: 'test' });
  store.addMemory(`${otherProject.id}/claude`, { name: 'Claude', content: '别的项目', source: 'test' });
  const projectDir = path.join(dir, '样本');
  const r = resetPhase({ store, projectDir, project: '样本', phase: '起草' });
  assert.equal(r.archived, 1);
  assert.equal(store.getMemory(`${mine.id}/claude`), null);
  assert.equal(store.getMemory('shared/claude').content, '全局');
  assert.equal(store.getMemory(`${otherPhase.id}/claude`).content, '核验阶段');
  assert.equal(store.getMemory(`${otherProject.id}/claude`).content, '别的项目');
  assert.equal(readJson(r.file).notebooks[`${mine.id}/claude`][0].content, '本阶段笔记');
  assert.equal(phaseSpace(store, '样本', '起草').id, mine.id); // 空间本身还在，只是空了
  assert.throws(() => store.takeSpaceMemories('shared'), /全局共享记忆/);
});

// ---------- 任务包与派发 ----------

test('读资料的任务：输入副本放进专用工作目录；结果经栅栏收稿并晋升；任务包能完整还原当时的输入与提示词', async () => {
  const promptFile = path.join(tmpBase(), 'prompt.txt');
  const changes = [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '盘古开天辟地见于《三五历纪》', sources: [{ id: 'S001', version: 1, quote: '最早见于三国吴徐整的《三五历纪》' }] } }];
  const env = await runnerEnv([
    fake('extractor', 'json', Buffer.from(JSON.stringify(changes)).toString('base64')),
    fake('recorder', 'record', promptFile, '没有结果'),
  ]);
  await seed(env.gw);
  const t = env.board.create(P, { type: 'extract_claims', title: '抽取论断', goal: '从 S001 抽取论断', inputs: [{ id: 'S001', version: 1 }] }, { created_by: HOST });
  env.runner.dispatch(P, t.id, 'extractor');
  await waitFor(() => ['done', 'failed', 'open'].includes(env.board.get(P, t.id).state));
  const task = env.board.get(P, t.id);
  assert.equal(task.state, 'done', JSON.stringify(task.history.at(-1)));
  assert.deepEqual(task.result.records, [{ id: 'C002', version: 1 }]);
  const prov = env.gw.getRecord(P, 'C002').record.provenance;
  assert.deepEqual([prov.kind, prov.participant, prov.verified, prov.task_id, prov.attempt], ['server', 'extractor', true, t.id, 1]);
  // 还原任务包：约定、来源卡、正文快照、提示词、有效配置
  const restored = restorePacket(path.join(env.projectsDir, P), `${t.id}-a1`);
  assert.equal(restored.packet.visibility, 'read');
  assert.deepEqual(restored.inputs.map((i) => i.name), ['S001.v1.json', 'S001.v1.正文.md']);
  assert.match(restored.inputs[1].text, /神话学家指出/);
  assert.match(restored.prompt, /只读取这些文件/);
  assert.equal(restored.config.budget.calls, DEFAULTS.budget.calls);
  assert.deepEqual(restored.files.map((f) => f.path), ['S001.v1.json', 'S001.v1.正文.md']);
  assert.doesNotMatch(restored.conventions, /（谁来看：身份、已有知识/); // 模板引导语不进任务包
  assert.ok(!fs.existsSync(path.join(env.base, 'work', `${t.id}-a1`))); // 用完的工作目录已清理
  // 另一次尝试：实际收到的提示词与任务包里存的逐字相同
  const t2 = env.board.create(P, { type: 'extract_claims', inputs: [{ id: 'S001', version: 1 }] }, { created_by: HOST });
  env.runner.dispatch(P, t2.id, 'recorder');
  await waitFor(() => ['open', 'failed'].includes(env.board.get(P, t2.id).state));
  assert.equal(restorePacket(path.join(env.projectsDir, P), `${t2.id}-a1`).prompt, fs.readFileSync(promptFile, 'utf8'));
  assert.match(env.board.get(P, t2.id).history.at(-1).reason, /结果无法解析/);
  // 命令行 Agent 的调用同样占项目调用名额
  assert.equal(env.usage.totals(P).calls, 2);
});

test('MCP 外部会话认领：拿到凭证与内联任务包；密封类任务不能由外部会话认领', async () => {
  const env = await runnerEnv([]);
  await seed(env.gw);
  const t = env.board.create(P, { type: 'check_citations', inputs: [{ id: 'C001', version: 1 }] }, { created_by: HOST });
  const ext = { kind: 'mcp', participant: 'Codex', verified: false, basis: 'mcp-self-reported' };
  const c = env.runner.claimExternal(P, t.id, ext);
  assert.match(c.packet.prompt, /盘古故事最早见于《三五历纪》/); // 输入内联
  assert.equal(restorePacket(path.join(env.projectsDir, P), c.packet.id).prompt, c.packet.prompt);
  const r = env.gw.receive(P, { request_id: 'mcp-req-0001', task_id: t.id, attempt: c.attempt, lease_token: c.lease_token, changes: [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'https://a' } }] });
  await env.gw.promote(P, r.sid);
  assert.equal(env.board.get(P, t.id).state, 'done');
  assert.equal(env.gw.getRecord(P, 'S002').record.provenance.verified, false); // 外部会话的身份未证实
  const s = env.board.create(P, { type: 'outline' }, { created_by: HOST });
  assert.throws(() => env.runner.claimExternal(P, s.id, ext), /只能由服务端派发/);
});

test('辅助：结果解析与约定清理', () => {
  assert.deepEqual(parseChanges('说明\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.throws(() => parseChanges('没有代码块'), /没有 ```json/);
  assert.throws(() => parseChanges('```json\n{}\n```'), /changes 数组/);
  const tpl = '## 受众\n\n（谁来看：身份。）\n\n> 引导\n';
  assert.equal(cleanConventions('## 受众\n\n（谁来看：身份。）\n\n> 引导\n（我自己写的括号）\n<!-- 注释 -->', tpl), '## 受众\n\n（我自己写的括号）');
});
