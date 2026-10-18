// Review probes: temporary projects, local mock API, fake/injected Agents only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { blobStore } from '../../lib/workbench/records.mjs';
import { runAgent, parseCodexEvents } from '../../lib/agents.mjs';
import { createDeepseekClient } from '../../lib/workbench/deepseek.mjs';
import { createStore } from '../../lib/store.mjs';
import { resetPhase, phaseSpace } from '../../lib/workbench/phases.mjs';
import { startMock, chatOk, apiError } from '../../tests/workbench/mock-deepseek.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp4-review-'));
const defaults = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const HOST = { kind: 'human', participant: 'review-host', verified: true };
const AGENT = { kind: 'mcp', participant: 'fixture', verified: false };
const gates = [], runners = [], results = [];
const basic = { id: 'fixture', name: 'Fixture', adapter: 'generic', model: 'fixture', resolved: process.execPath };
const reply = (raw, audit = null) => ({ raw, audit, model: 'fixture', exec: { args: [], stdoutTail: raw }, usage: null });
const changes = (title) => [{ kind: 'source', expected_version: 0, data: { title, url: 'https://example.org/' } }];
const tick = () => new Promise((r) => setImmediate(r));

async function env(name, invoke = async () => reply('fixture draft'), people = [basic], deepseek = null) {
  const dir = path.join(temp, name);
  const workbench = createWorkbench({ projectsDir: path.join(dir, 'projects'), defaults, templateDir: path.join(ROOT, 'templates/project') });
  let ms = Date.now();
  const now = () => new Date(ms);
  const usage = createUsage({ workbench, pricing: defaults.pricing, now });
  const board = createTaskBoard({ workbench, usage, now });
  const gateway = createCommitGateway({ workbench, defaults, fence: board.fence, now });
  gates.push(gateway);
  await gateway.start();
  await gateway.createProject('A');
  const sealed = createSealedStore();
  const participants = Object.assign((id) => people.find((p) => p.id === id), { all: () => people });
  const runner = createRunner({ workbench, gateway, board, usage, sealed, participants, runAgent: invoke, deepseek,
    workRoot: path.join(dir, 'work'), sandboxDir: path.join(dir, 'sandbox'), now, timeoutMs: 5000 });
  runners.push(runner);
  return { dir, workbench, board, gateway, usage, sealed, runner, advance: (n) => { ms += n; } };
}
const task = (e, p = 'A', spec = {}) => e.board.create(p, { type: 'outline', ...spec }, { created_by: HOST });
const submit = (e, t, c) => e.gateway.receive('A', { request_id: `review-${t.id}-${c.attempt}`, task_id: t.id,
  attempt: c.attempt, lease_token: c.lease_token, changes: changes('cancelled output') });

try {
  // R1: real server restart with an in-flight server attempt on disk.
  {
    const e = await env('restart');
    const t = task(e);
    e.board.claim('A', t.id, { kind: 'server', participant: 'fixture', verified: true });
    await e.gateway.queue.idle(); e.gateway.stop();
    const config = path.join(e.dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ participants: [], humanName: 'fixture', port: 49191 }));
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, windowsHide: true,
      env: { ...process.env, WETALK_CONFIG: config, WETALK_PROJECTS: e.workbench.projectsDir,
        WETALK_DATA: path.join(e.dir, 'data'), WETALK_PORT: '49191', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), 8000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    results.push({ probe: 'R1 server restart', exit, output: out.slice(-1700) });
  }
  // R2: receive is synchronous, promotion waits in the repository queue.
  {
    const e = await env('cancel-promote');
    const t = task(e, 'A', { type: 'extract_claims' });
    const c = e.board.claim('A', t.id, AGENT);
    const received = submit(e, t, c);
    e.board.cancel('A', t.id, 'review-host');
    let outcome;
    try { outcome = await e.gateway.promote('A', received.sid); } catch (error) { outcome = { status: error.status, error: error.message }; }
    results.push({ probe: 'R2 cancelled submitted candidate', taskState: e.board.get('A', t.id).state,
      promotion: outcome, formalRecords: e.gateway.listRecords('A').length });
  }
  // R3: expired first attempt finishes AFTER the current attempt has sealed its result.
  {
    const pending = [];
    const e = await env('late-sealed', () => new Promise((resolve) => pending.push(resolve)));
    const t = task(e);
    e.runner.dispatch('A', t.id, basic.id);
    e.advance((defaults.lease.minutes + 1) * 60000);
    e.board.get('A', t.id); // expire first attempt
    e.runner.dispatch('A', t.id, basic.id);
    pending[1](reply('CURRENT-ATTEMPT-2'));
    await tick();
    pending[0](reply('EXPIRED-ATTEMPT-1'));
    await tick();
    const r = e.runner.reveal('A', `R-${t.id}`);
    results.push({ probe: 'R3 late sealed overwrite', currentAttempt: e.board.get('A', t.id).attempt,
      revealed: blobStore(e.workbench.get('A').dir).get(r.results[0].text_blob).toString() });
  }
  // R4: automatic round IDs must be project-scoped, as task IDs are.
  {
    let n = 0;
    const e = await env('cross-project', async () => reply(++n === 1 ? 'PROJECT-A-DRAFT' : 'PROJECT-B-DRAFT'));
    await e.gateway.createProject('B');
    const a = task(e, 'A'), b = task(e, 'B');
    const da = e.runner.dispatch('A', a.id, basic.id); await e.runner.idle();
    const db = e.runner.dispatch('B', b.id, basic.id); await e.runner.idle();
    const r = e.runner.reveal('A', da.round);
    results.push({ probe: 'R4 cross-project default round', rounds: [da.round, db.round],
      revealedInA: blobStore(e.workbench.get('A').dir).get(r.results[0].text_blob).toString(),
      states: [e.board.get('A', a.id).state, e.board.get('B', b.id).state] });
  }
  // R5a: audit tool arguments can contain draft content even though stdout tails are removed.
  {
    const secret = 'SEALED-AUDIT-CANARY';
    const parsed = parseCodexEvents({ code: 0, stderr: '', stdout: [
      { type: 'item.completed', item: { id: 'x', type: 'mcp_tool_call', server: 'fixture', tool: 'process_text', arguments: { text: secret } } },
      { type: 'item.completed', item: { id: 'y', type: 'agent_message', text: secret } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') });
    const e = await env('sealed-audit', async () => reply(parsed.text, parsed.audit));
    const t = task(e); e.runner.dispatch('A', t.id, basic.id); await e.runner.idle();
    results.push({ probe: 'R5a sealed audit leak', taskState: e.board.get('A', t.id).state,
      leakedInCallLog: fs.readFileSync(path.join(e.workbench.get('A').dir, 'calls.jsonl'), 'utf8').includes(secret) });
  }
  // R5b: real generic adapter failure includes partial stdout in its error message.
  {
    const file = path.join(temp, 'failing-agent.mjs');
    const secret = 'SEALED-ERROR-CANARY';
    fs.writeFileSync(file, `for await (const x of process.stdin) {} process.stdout.write('${secret}'); process.exitCode=1;`);
    const p = { ...basic, command: [process.execPath], args: [file] };
    const e = await env('sealed-error', runAgent, [p]);
    const t = task(e); e.runner.dispatch('A', t.id, p.id); await e.runner.idle();
    results.push({ probe: 'R5b sealed error leak', leakedInTask: JSON.stringify(e.board.get('A', t.id)).includes(secret),
      leakedInCallLog: fs.readFileSync(path.join(e.workbench.get('A').dir, 'calls.jsonl'), 'utf8').includes(secret) });
  }
  // R6: archive destination failure must not delete the only copy of phase memory.
  {
    const dir = path.join(temp, 'phase'); fs.mkdirSync(dir);
    const storeFile = path.join(dir, 'forum.json');
    const store = createStore(storeFile);
    const space = phaseSpace(store, 'A', 'review');
    const key = `${space.id}/fixture`;
    store.addMemory(key, { name: 'fixture', content: 'ONLY-COPY', source: 'review' });
    fs.writeFileSync(path.join(dir, 'archive'), 'block directory creation');
    let code;
    try { resetPhase({ store, projectDir: dir, project: 'A', phase: 'review' }); } catch (e) { code = e.code; }
    results.push({ probe: 'R6 phase archive failure', error: code, memoryAfterRestart: createStore(storeFile).getMemory(key) });
  }
  // R7: the audience rule must apply to blob inputs, not only record references.
  {
    const e = await env('audience');
    const h = blobStore(e.workbench.get('A').dir).put(JSON.stringify({ id: 'C007', sources: ['S001'], text: 'CLAIM-AND-SOURCE-CANARY' }));
    const t = task(e, 'A', { type: 'audience_reader', inputs: [{ blob: h, name: 'input.json' }] });
    let outcome;
    try { const parts = e.runner.buildParts('A', t, 1, 'audience', { inline: true }); outcome = { accepted: true, promptContainsEvidence: parts.prompt.includes('CLAIM-AND-SOURCE-CANARY') }; }
    catch (error) { outcome = { accepted: false, error: error.message }; }
    results.push({ probe: 'R7 audience raw blob', ...outcome });
  }
  // R8: the saved effective project retry policy must also govern dispatched API tasks.
  {
    const mock = await startMock();
    try {
      const c = createDeepseekClient({ apiKey: 'review-dummy', baseUrl: mock.url, retry: { max: 1, delaysSec: [0] } });
      const p = { ...basic, adapter: 'deepseek', model: 'deepseek-flash' };
      const e = await env('api-retry', runAgent, [p], c);
      fs.writeFileSync(path.join(e.workbench.get('A').dir, 'protocol.json'), JSON.stringify({ retry: { max: 0, delaysSec: [0] } }));
      mock.script('/chat/completions', apiError(503), chatOk('```json\n' + JSON.stringify(changes('retried despite zero')) + '\n```'));
      const t = task(e, 'A', { type: 'extract_claims' });
      e.runner.dispatch('A', t.id, p.id); await e.runner.idle();
      results.push({ probe: 'R8 dispatched API retry', effectiveRetryMax: e.workbench.get('A').config.retry.max,
        actualRequests: mock.requests.length, state: e.board.get('A', t.id).state });
    } finally { await mock.close(); }
  }
  // R9: generic readers in different projects must not receive the same working directory.
  {
    const pending = [];
    const e = await env('cross-workdir', (p, prompt, opts) => new Promise((resolve) => pending.push({ resolve, cwd: opts.cwd })));
    await e.gateway.createProject('B');
    const inputA = blobStore(e.workbench.get('A').dir).put('A-INPUT-ONLY');
    const inputB = blobStore(e.workbench.get('B').dir).put('B-INPUT-ONLY');
    const a = task(e, 'A', { type: 'extract_claims', inputs: [{ blob: inputA, name: 'input.md' }] });
    const b = task(e, 'B', { type: 'extract_claims', inputs: [{ blob: inputB, name: 'input.md' }] });
    e.runner.dispatch('A', a.id, basic.id);
    const before = fs.readFileSync(path.join(pending[0].cwd, 'input.md'), 'utf8');
    e.runner.dispatch('B', b.id, basic.id);
    const after = fs.readFileSync(path.join(pending[0].cwd, 'input.md'), 'utf8');
    results.push({ probe: 'R9 cross-project working directory', sameCwd: pending[0].cwd === pending[1].cwd, before, after });
    for (const p of pending) p.resolve(reply('fixture result without changes'));
    await e.runner.idle();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const r of runners) await r.idle();
  for (const g of gates) { await g.queue.idle(); g.stop(); }
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp4-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
