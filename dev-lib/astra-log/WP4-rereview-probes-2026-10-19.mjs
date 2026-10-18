// WP4 follow-up review: local fake Agent, fresh temporary projects, no real API calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { runAgent } from '../../lib/agents.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp4-rereview-'));
const defaults = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const gates = [], runners = [], results = [];
const host = { kind: 'human', participant: 'review-host', verified: true };
const basic = { id: 'fixture', name: 'Fixture', adapter: 'generic', model: 'fixture', resolved: process.execPath };
const reply = (raw) => ({ raw, model: 'fixture', exec: { args: [], stdoutTail: raw }, audit: null });
async function env(name, invoke = async () => reply('draft'), person = basic) {
  const base = path.join(temp, name);
  const workbench = createWorkbench({ projectsDir: path.join(base, 'projects'), defaults, templateDir: path.join(ROOT, 'templates/project') });
  const usage = createUsage({ workbench, pricing: defaults.pricing });
  const board = createTaskBoard({ workbench, usage });
  const gateway = createCommitGateway({ workbench, defaults, fence: board.fence });
  gates.push(gateway);
  await gateway.start();
  await gateway.createProject('A');
  const sealed = createSealedStore();
  const runner = createRunner({ workbench, gateway, board, usage, sealed,
    participants: Object.assign(() => person, { all: () => [person] }), runAgent: invoke,
    workRoot: path.join(base, 'work'), sandboxDir: path.join(base, 'sandbox'), timeoutMs: 5000 });
  runners.push(runner);
  return { workbench, gateway, board, usage, sealed, runner, dir: workbench.get('A').dir };
}
const task = (e) => e.board.create('A', { type: 'outline' }, { created_by: host });
try {
  // R1: sanitizing calls.jsonl and tasks does not sanitize the usage ledger.
  {
    const secret = 'SEALED-USAGE-CANARY-1931';
    const file = path.join(temp, 'failing-agent.mjs');
    fs.writeFileSync(file, `for await (const x of process.stdin) {} process.stdout.write('${secret}'); process.exitCode=1;`);
    const e = await env('usage-leak', runAgent, { ...basic, command: [process.execPath], args: [file] });
    const t = task(e);
    e.runner.dispatch('A', t.id, basic.id);
    await e.runner.idle();
    results.push({ probe: 'R1 sealed failed output in usage',
      callsLeak: fs.readFileSync(path.join(e.dir, 'calls.jsonl'), 'utf8').includes(secret),
      taskLeak: JSON.stringify(e.board.get('A', t.id)).includes(secret),
      usageFileLeak: fs.readFileSync(path.join(e.dir, 'usage.jsonl'), 'utf8').includes(secret),
      usageRecentLeak: JSON.stringify(e.usage.entries('A').slice(-50)).includes(secret) });
  }
  // R2a: cancelling one collected task must not destroy the other collected results.
  {
    let n = 0;
    const e = await env('cancel-reveal', async () => reply(++n === 1 ? 'CANCELLED-DRAFT' : 'KEEP-THIS-DRAFT'));
    const a = task(e), b = task(e);
    e.sealed.open('A', 'R-pair', [a.id, b.id]);
    e.runner.dispatch('A', a.id, basic.id); await e.runner.idle();
    e.runner.dispatch('A', b.id, basic.id); await e.runner.idle();
    e.board.cancel('A', a.id, 'review-host');
    let first, second;
    try { e.runner.reveal('A', 'R-pair'); } catch (err) { first = { status: err.status, message: err.message }; }
    try { e.runner.reveal('A', 'R-pair'); } catch (err) { second = { status: err.status, message: err.message }; }
    const calls = fs.readFileSync(path.join(e.dir, 'calls.jsonl'), 'utf8');
    results.push({ probe: 'R2a cancelled member reveal', first, second,
      round: e.sealed.status('A', 'R-pair'), states: [e.board.get('A', a.id).state, e.board.get('A', b.id).state],
      cancelledDraftWritten: calls.includes('CANCELLED-DRAFT'), otherDraftWritten: calls.includes('KEEP-THIS-DRAFT') });
  }
  // R2b: one recoverable blob-write error consumes the only in-memory copy before it is saved.
  {
    const e = await env('disk-error', async () => reply('UNIQUE-REVEAL-DRAFT'));
    const t = task(e);
    const dispatched = e.runner.dispatch('A', t.id, basic.id); await e.runner.idle();
    const original = fs.writeFileSync;
    const blobRoot = path.join(e.dir, 'archive', 'blobs') + path.sep;
    let first, second;
    fs.writeFileSync = function (file, ...args) {
      if (typeof file === 'string' && path.resolve(file).startsWith(blobRoot)) throw Object.assign(new Error('fixture blob disk failure'), { code: 'ENOSPC' });
      return original.call(this, file, ...args);
    };
    try { e.runner.reveal('A', dispatched.round); } catch (err) { first = err.code ?? err.message; }
    finally { fs.writeFileSync = original; }
    try { e.runner.reveal('A', dispatched.round); } catch (err) { second = err.status; }
    results.push({ probe: 'R2b reveal write failure', first, retryStatus: second,
      taskState: e.board.get('A', t.id).state, round: e.sealed.status('A', dispatched.round) });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const r of runners) await r.idle();
  for (const g of gates) { await g.queue.idle(); g.stop(); }
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp4-rereview-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
