// Independent WP6 review probes for aa0b469. Exit 0 confirms the documented bugs
// were reproduced; it is not a passing product acceptance test. No real models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createScheduler } from '../../lib/workbench/scheduler.mjs';
import { phaseSpace } from '../../lib/workbench/phases.mjs';
import { createStore } from '../../lib/store.mjs';
import { formatTranscript } from '../../lib/agents.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp6-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const workbench = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
const usage = createUsage({ workbench, pricing: defaults.pricing });
const board = createTaskBoard({ workbench, usage });
const gateway = createCommitGateway({ workbench, defaults, fence: board.fence });
const people = [{ id: 'writer', name: 'Writer', adapter: 'claude', resolved: 'fixture' }];
const participants = Object.assign(id => people.find(p => p.id === id), { all: () => people });
const host = { kind: 'human', participant: 'review-host', verified: true };
let dispatches = 0;
const runner = { dispatch() { dispatches++; throw new Error('This probe must never invoke a model'); } };
const store = createStore(path.join(temp, 'forum.json'));
let clock = Date.parse('2026-10-19T00:00:00Z');
const scheduler = createScheduler({ workbench, gateway, board, runner, participants, store, now: () => new Date(clock) });
const observe = (probe, data) => console.log(JSON.stringify({ probe, ...data }));
try {
  await gateway.start();
  // An auto tick computes skip reasons but discards them if no round opens/closes.
  const p1 = 'no-auto-candidate';
  await gateway.createProject(p1);
  board.create(p1, { type: 'extract_claims' }, { created_by: host });
  scheduler.setAuto(p1, true, host.participant);
  await new Promise(resolve => setImmediate(resolve));
  const computed = scheduler.step(p1).st.last;
  const persisted = scheduler.state(p1).last;
  assert.equal(computed.dispatched.length, 0);
  assert.match(computed.skipped[0].reason, /没有能做/);
  assert.equal(persisted, null);
  observe('auto-skipped-not-persisted', { computed, persisted, dispatches });
  scheduler.setAuto(p1, false, host.participant);

  // Handoff persistence fails AFTER the old memory is archived and cleared.
  const p2 = 'phase-write-failure';
  await gateway.createProject(p2);
  scheduler.switchPhase(p2, 'goal', host.participant);
  const oldSpace = phaseSpace(store, p2, '明确目标');
  const memoryKey = `${oldSpace.id}/writer`;
  store.addMemory(memoryKey, { name: 'Writer', content: 'UNIQUE-PHASE-NOTE', source: 'review' });
  const target = path.resolve(workbench.get(p2).dir, 'handoff', 'H002.md');
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (path.resolve(String(to)) === target) throw Object.assign(new Error('Injected handoff rename failure'), { code: 'ENOSPC' });
    return rename(from, to, ...args);
  };
  try { assert.throws(() => scheduler.switchPhase(p2, 'sources', host.participant), /Injected/); }
  finally { fs.renameSync = rename; }
  const afterFailure = scheduler.state(p2);
  assert.equal(afterFailure.phase.id, 'goal');
  assert.equal(store.getMemory(memoryKey), null);
  clock += 1000;
  scheduler.switchPhase(p2, 'sources', host.participant);
  const history = scheduler.state(p2).phase_history.at(-1);
  const linkedArchive = JSON.parse(fs.readFileSync(path.join(workbench.get(p2).dir, history.memory.file), 'utf8'));
  assert.deepEqual(linkedArchive.notebooks, {});
  const archives = fs.readdirSync(path.join(workbench.get(p2).dir, 'archive', 'memory'));
  observe('phase-failed-after-memory-reset', { phaseAfterFailure: afterFailure.phase.id, liveMemoryAfterFailure: null, historyAfterRetry: history, linkedArchiveNotes: linkedArchive.notebooks, archives });

  // Three ordinary result posts with evidence-request text exceed the input budget:
  // tail is budgeted first, then full results are added without reserving any space.
  const posts = [
    { author: 'Host', kind: 'human', content: 'Opening' },
    ...Array.from({ length: 3 }, (_, i) => ({ author: 'Vote', kind: 'system', type: 'result', content: `Result ${i}: evidence requested ${'x'.repeat(2400)}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ author: 'Writer', kind: 'ai', content: `Recent ${i}: ${'y'.repeat(260)}` })),
  ];
  const maxChars = 3000;
  const text = formatTranscript(posts, maxChars, null, 'Project conventions and handoff.');
  assert.ok(text.includes('Recent 7'));
  assert.ok(text.length > maxChars * 3);
  observe('transcript-budget-overrun', { maxChars, actualChars: text.length, containsOldResults: [0, 1, 2].every(i => text.includes(`Result ${i}:`)) });
} finally {
  scheduler.stop();
  await gateway.queue.idle();
  gateway.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp6-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
