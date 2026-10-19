// Independent WP6 rereview probes for 9af43ad/6a96c59. Exit 0 means the expected
// corrected behaviors passed. No real models.
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
  // An automatic check with no dispatch must persist reasons without repeated writes.
  const p1 = 'no-auto-candidate';
  await gateway.createProject(p1);
  board.create(p1, { type: 'extract_claims' }, { created_by: host });
  scheduler.setAuto(p1, true, host.participant);
  await new Promise(resolve => setImmediate(resolve));
  const computed = scheduler.step(p1).st.last;
  const persisted = scheduler.state(p1).last;
  assert.equal(computed.dispatched.length, 0);
  assert.match(computed.skipped[0].reason, /没有能做/);
  assert.deepEqual(persisted, computed);
  clock += 1000;
  scheduler.tick();
  scheduler.tick();
  assert.deepEqual(scheduler.state(p1).last, persisted);
  observe('auto-skipped-persisted', { computed, persisted, dispatches, unchangedAfterTicks: true });
  scheduler.setAuto(p1, false, host.participant);

  // Handoff persistence fails BEFORE memory is cleared; pending remains retryable.
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
  assert.equal(store.getMemory(memoryKey).content, 'UNIQUE-PHASE-NOTE');
  assert.equal(afterFailure.switching.to, 'sources');
  assert.throws(() => scheduler.runOnce(p2, host.participant), e => e.status === 409);
  assert.throws(() => scheduler.switchPhase(p2, 'claims', host.participant), e => e.status === 409);
  clock += 1000;
  scheduler.switchPhase(p2, 'sources', host.participant);
  const history = scheduler.state(p2).phase_history.at(-1);
  const linkedArchive = JSON.parse(fs.readFileSync(path.join(workbench.get(p2).dir, history.memory.file), 'utf8'));
  assert.equal(linkedArchive.notebooks[memoryKey][0].content, 'UNIQUE-PHASE-NOTE');
  const archives = fs.readdirSync(path.join(workbench.get(p2).dir, 'archive', 'memory'));
  assert.equal(archives.length, 1);
  assert.equal(scheduler.state(p2).switching, null);
  observe('phase-handoff-failure-recovered', { phaseAfterFailure: afterFailure.phase.id, liveMemoryAfterFailure: 'UNIQUE-PHASE-NOTE', historyAfterRetry: history, linkedArchiveNotes: linkedArchive.notebooks, archives });

  // Fail the final workflow write AFTER archiving/clearing, then restart the
  // actual memory store and scheduler and add a note before resuming.
  const sourceSpace = phaseSpace(store, p2, '收集来源');
  const sourceKey = `${sourceSpace.id}/writer`;
  store.addMemory(sourceKey, { name: 'Writer', content: 'BEFORE-FINAL-SAVE-FAILURE', source: 'review' });
  const workflowFile = path.resolve(workbench.get(p2).dir, 'workflow.json');
  let workflowWrites = 0;
  fs.renameSync = (from, to, ...args) => {
    if (path.resolve(String(to)) === workflowFile && ++workflowWrites === 2) throw new Error('Injected final workflow save failure');
    return rename(from, to, ...args);
  };
  try { assert.throws(() => scheduler.switchPhase(p2, 'claims', host.participant), /Injected final/); }
  finally { fs.renameSync = rename; }
  assert.equal(scheduler.state(p2).phase.id, 'sources');
  assert.equal(store.getMemory(sourceKey), null);
  const pendingArchive = scheduler.state(p2).switching.archive;
  scheduler.stop();
  const freshStore = createStore(path.join(temp, 'forum.json'));
  const fresh = createScheduler({ workbench, gateway, board, runner, participants, store: freshStore, now: () => new Date(clock) });
  try {
    freshStore.addMemory(sourceKey, { name: 'Writer', content: 'AFTER-RESTART', source: 'review' });
    fresh.switchPhase(p2, 'claims', host.participant);
    const done = fresh.state(p2);
    const h = done.phase_history.at(-1);
    const notes = JSON.parse(fs.readFileSync(path.join(workbench.get(p2).dir, h.memory.file), 'utf8')).notebooks[sourceKey];
    assert.equal(h.memory.file, pendingArchive);
    assert.deepEqual(notes.map(n => n.content), ['BEFORE-FINAL-SAVE-FAILURE', 'AFTER-RESTART']);
    assert.equal(done.switching, null);
    assert.equal(done.phase.id, 'claims');
    assert.equal(freshStore.getMemory(sourceKey), null);
    observe('phase-final-save-restart-recovered', { phase: done.phase.id, archive: h.memory.file, notes: notes.map(n => n.content), historyIds: done.phase_history.map(h => h.id) });
  } finally { fresh.stop(); }

  // The original long-result fixture now fits its overall budget.
  const posts = [
    { author: 'Host', kind: 'human', content: 'Opening' },
    ...Array.from({ length: 3 }, (_, i) => ({ author: 'Vote', kind: 'system', type: 'result', content: `Result ${i}: evidence requested ${'x'.repeat(2400)}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ author: 'Writer', kind: 'ai', content: `Recent ${i}: ${'y'.repeat(260)}` })),
  ];
  const maxChars = 3000;
  const text = formatTranscript(posts, maxChars, null, 'Project conventions and handoff.');
  assert.ok(text.includes('Recent 7'));
  assert.ok(text.length <= maxChars);
  observe('transcript-budget-respected', { maxChars, actualChars: text.length, containsOldResults: [0, 1, 2].every(i => text.includes(`Result ${i}:`)) });
  // Cover boundary sizes, long backgrounds and a long newest post independently.
  let transcriptCases = 0;
  for (const preface of [null, 'Short background', 'B'.repeat(10000)]) {
    for (const cap of [500, 1000, 1500, 3000, 6000]) {
      for (const newestLength of [50, 10000]) {
        const fixture = [...posts, { author: 'Writer', kind: 'ai', content: `LATEST-MARKER ${'z'.repeat(newestLength)}` }];
        const out = formatTranscript(fixture, cap, null, preface);
        assert.ok(out.length <= cap, `budget ${cap}, actual ${out.length}`);
        assert.ok(out.includes('LATEST-MARKER'));
        transcriptCases++;
      }
    }
  }
  observe('transcript-boundaries', { passedCases: transcriptCases });
} finally {
  scheduler.stop();
  await gateway.queue.idle();
  gateway.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp6-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

