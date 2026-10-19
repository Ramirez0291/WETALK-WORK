// WP5b rereview of f0701da/d787f9e. Uses fake model output and disposable projects only.
// Exit 0 means the observations (including the pending-apply deadlock) were reproduced,
// not that the product has passed review. See WP5b-rereview-2026-10-19.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { createCompetitions } from '../../lib/workbench/compete.mjs';
import { createDivisions } from '../../lib/workbench/divide.mjs';
import { parseReview } from '../../lib/workbench/modes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp5b-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const wb = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
const usage = createUsage({ workbench: wb, pricing: defaults.pricing });
const board = createTaskBoard({ workbench: wb, usage });
const gw = createCommitGateway({ workbench: wb, defaults, fence: board.fence });
const host = { kind: 'human', participant: 'review-host', verified: true };
const people = [
  { id: 'writer-a', name: 'Writer A', adapter: 'claude', resolved: 'fixture' },
  { id: 'writer-b', name: 'Writer B', adapter: 'codex', resolved: 'fixture' },
  { id: 'reviewer', name: 'Reviewer', adapter: 'generic', model: 'gemini-fixture', resolved: 'fixture' },
];
const lookup = Object.assign(id => people.find(p => p.id === id), { all: () => people });
const runners = [];
const observe = (probe, data) => console.log(JSON.stringify({ probe, ...data }));
const errorOf = e => ({ message: e.message, status: e.status, reasons: e.details?.reasons });
async function submit(project, changes) {
  const receipt = gw.receive(project, { request_id: `review-${crypto.randomUUID()}`, changes }, { actor: host });
  return gw.promote(project, receipt.sid);
}
function world(project, { a = '## Opening\nBASE-A.\n', b = '## Alternative\nEXTRA-B.\n', review = '方案甲 第 1 节：Clarify the introduction.' } = {}) {
  const prompts = [];
  const runner = createRunner({ workbench: wb, gateway: gw, board, usage, sealed: createSealedStore(), participants: lookup,
    runAgent: async (p, prompt) => { prompts.push(prompt); return { raw: p.id === 'writer-a' ? a : p.id === 'writer-b' ? b : review, model: null, exec: { args: [] } }; },
    workRoot: path.join(temp, project, 'work'), sandboxDir: path.join(temp, project, 'sandbox') });
  runners.push(runner);
  return { runner, prompts, c: createCompetitions({ workbench: wb, gateway: gw, board, runner, participants: lookup }) };
}
async function reviewed(project, w, inputs = []) {
  w.c.create(project, { type: 'outline', title: 'Review fixture', participants: ['writer-a', 'writer-b'], inputs }, host);
  await w.runner.idle();
  w.c.reveal(project, 'K001');
  await w.c.review(project, 'K001', { reviewers: ['reviewer'] }, host);
  await w.runner.idle();
  w.c.reveal(project, 'K001');
  const v = w.c.view(project, 'K001');
  assert.equal(v.stage, 'selecting');
  return { a: v.label_drafts.find(d => d.participant === 'writer-a').label, b: v.label_drafts.find(d => d.participant === 'writer-b').label };
}
// Fail the nth workflow JSON rename: 1 = before submission, 2 = after promotion.
async function failWorkflowSave(project, operation, nth = 1) {
  const target = path.resolve(wb.get(project).dir, 'competitions', 'K001.json');
  const original = fs.renameSync;
  let hit = 0;
  fs.renameSync = (from, to, ...rest) => {
    if (path.resolve(String(to)) === target && ++hit === nth) { throw Object.assign(new Error('Injected workflow write failure'), { code: 'ENOSPC' }); }
    return original(from, to, ...rest);
  };
  let error;
  try { await operation(); } catch (e) { error = errorOf(e); }
  finally { fs.renameSync = original; }
  assert.ok(hit > 0);
  return error;
}
try {
  await gw.start();

  const p1 = 'inherited-claims';
  await gw.createProject(p1);
  await submit(p1, [
    { kind: 'source', expected_version: 0, tmp: '$s', data: { title: 'Book', citation: 'Fixture book', text: 'Population is 1200.' } },
    { kind: 'claim', expected_version: 0, tmp: '$c', data: { type: 'fact', text: 'Population is 1200.', sources: [{ id: '$s', quote: '1200' }] } },
    { kind: 'outline', expected_version: 0, data: { title: 'Existing outline', body: 'C001 says population is 1200.', claims: [{ id: '$c' }] } },
  ]);
  const w1 = world(p1, { a: '## Opening\nC001 says population is 1200.\n' });
  const labels1 = await reviewed(p1, w1, [{ id: 'OL001', version: 1 }]);
  await w1.c.select(p1, 'K001', { label: labels1.a, reason: 'Use this structure' }, host);
  const selected1 = gw.getRecord(p1, 'OL002');
  assert.deepEqual(selected1.record.claims, [{ id: 'C001', version: 1 }]);
  assert.equal(selected1.status.ready, false);
  await submit(p1, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'Corrected population statement.', sources: [{ id: 'S001', version: 1, quote: '1200' }] } }]);
  assert.equal(gw.getRecord(p1, 'OL002').status.freshness, 'stale');
  observe('claims-via-outline-input', { body: selected1.record.body, claims: selected1.record.claims, readyBefore: selected1.status.ready, claimReady: gw.getRecord(p1, 'C001').status.ready, statusAfterClaimUpdate: gw.getRecord(p1, 'OL002').status });

  const p2 = 'select-save-failure';
  await gw.createProject(p2);
  const w2 = world(p2);
  const labels2 = await reviewed(p2, w2);
  const failedSelect = await failWorkflowSave(p2, () => w2.c.select(p2, 'K001', { label: labels2.a, reason: 'First choice' }, host));
  const stageAfterFailedSelect = w2.c.view(p2, 'K001').stage;
  assert.equal(gw.listRecords(p2, 'outline').length, 0);
  await w2.c.select(p2, 'K001', { label: labels2.b, reason: 'Choose the other visible option after error' }, host);
  observe('select-save-failure', { error: failedSelect, stageAfterFailedSelect, outlines: gw.listRecords(p2, 'outline').map(x => ({ id: x.record.id, body: x.record.body })), selection: w2.c.view(p2, 'K001').selection });

  const p3 = 'apply-save-failure';
  await gw.createProject(p3);
  const w3 = world(p3, { b: '## Alternative\nEXTRA-B.\n\n## Closing\nSECOND-B.\n' });
  const labels3 = await reviewed(p3, w3);
  await w3.c.select(p3, 'K001', { label: labels3.a, reason: 'First choice' }, host);
  await w3.c.propose(p3, 'K001', { from: { draft: labels3.b, section: 1 }, to: { section: 1, position: 'after' } }, host);
  await w3.c.decide(p3, 'K001', 'P1', { decision: 'accept' }, host);
  const failedApply = await failWorkflowSave(p3, () => w3.c.apply(p3, 'K001', host));
  const viewAfterFailure = w3.c.view(p3, 'K001');
  assert.equal(viewAfterFailure.record.version, 1);
  assert.equal(viewAfterFailure.record.diverged, false);
  let closeError3; try { await w3.c.close(p3, 'K001', host); } catch (e) { closeError3 = errorOf(e); } assert.equal(closeError3?.status, 409); const closed3 = w3.c.view(p3, 'K001');
  observe('apply-save-failure', { error: failedApply, recordedAppliedVersion: viewAfterFailure.applied.version, realRecord: viewAfterFailure.record, patch: closed3.patches[0], minority: closed3.minority, stage: closed3.stage });

  const p4 = 'more-than-six-drafts';
  await gw.createProject(p4);
  fs.writeFileSync(path.join(wb.get(p4).dir, 'protocol.json'), JSON.stringify({ compete: { drafts: 8 } }));
  const more = Array.from({ length: 8 }, (_, i) => ({ id: `draft-${i + 1}`, name: `Drafter ${i + 1}`, adapter: 'generic', resolved: 'fixture' }));
  people.push(...more);
  const w4 = world(p4);
  let draftsError;
  try { w4.c.create(p4, { type: 'outline', participants: more.map(p => p.id) }, host); } catch (e) { draftsError = errorOf(e); }
  assert.match(draftsError.message, /2 到 6/);
  fs.writeFileSync(path.join(temp, 'projects', p4, 'protocol.json'), '{}');
  assert.equal(board.list(p4).length, 0);
  observe('more-than-six-drafts', { error: draftsError, taskCount: board.list(p4).length });
  observe('review-claim-token', parseReview('方案甲 C100：This claim needs checking.', { drafts: { '方案甲': '## Section\nOnly C1000 is used here.' }, claimExists: id => ['C100', 'C1000'].includes(id) }));
  assert.equal(parseReview('方案甲 C100：Check.', { drafts: { '方案甲': 'Only C1000.' }, claimExists: () => true }).comments.length, 0);

  const p5 = 'division-input-truncation';
  await gw.createProject(p5);
  const w5 = world(p5, { a: '```json\n[{"kind":"source","expected_version":0,"data":{"title":"One output","url":"https://example.invalid/one"}}]\n```' });
  const division = createDivisions({ workbench: wb, gateway: gw, board, runner: w5.runner, participants: lookup });
  const items = Array.from({ length: 12 }, (_, i) => `ITEM-${String(i + 1).padStart(2, '0')}: ${'x'.repeat(480)}`);
  const dv = division.create(p5, { type: 'collect_sources', items, participants: ['writer-a'] }, host);
  await w5.runner.idle();
  assert.ok(items.every(item => w5.prompts[0].includes(item)));
  assert.equal(board.get(p5, dv.parts[0].task).state, 'done');
  observe('division-input-truncation', { declaredItems: dv.parts[0].items.length, taskGoalLength: board.get(p5, dv.parts[0].task).goal.length, missingItemsInSentPrompt: items.map((_, i) => `ITEM-${String(i + 1).padStart(2, '0')}`).filter(marker => !w5.prompts[0].includes(marker)), state: board.get(p5, dv.parts[0].task).state });

  const p6 = 'division-pointer-scope';
  await gw.createProject(p6);
  await submit(p6, [
    { kind: 'source', expected_version: 0, tmp: '$s', data: { title: 'Assigned source', citation: 'Fixture one', text: 'Population is 1200.' } },
    { kind: 'source', expected_version: 0, data: { title: 'Other part source', citation: 'Fixture two', text: 'OUTSIDE_ONLY 1200.' } },
    { kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'Population is 1200.', sources: [{ id: '$s', quote: '1200' }] } },
  ]);
  const w6 = world(p6, { a: '```json\n' + JSON.stringify([{ kind: 'objection', expected_version: 0, data: {
    target: { id: 'C001', version: 1 }, category: 'number_error', pointer: { type: 'quote', source: { id: 'S002', version: 1 }, quote: 'OUTSIDE_ONLY 1200' }, reason: 'Compare this outside source', state: 'open',
  } }]) + '\n```' });
  const d6 = createDivisions({ workbench: wb, gateway: gw, board, runner: w6.runner, participants: lookup });
  const dv6 = d6.create(p6, { type: 'check_citations', inputs: [{ id: 'C001', version: 1 }, { id: 'S002', version: 1 }], participants: ['writer-a', 'writer-b'] }, host);
  await w6.runner.idle();
  assert.deepEqual(gw.listRecords(p6, 'objection'), []);
  assert.equal(board.get(p6, dv6.parts[0].task).state, 'open');
  observe('division-pointer-scope', { firstPartInputs: dv6.parts[0].inputs, secondPartInputs: dv6.parts[1].inputs, firstPromptHasOutsideSource: w6.prompts[0].includes('OUTSIDE_ONLY'), firstTaskState: board.get(p6, dv6.parts[0].task).state, objections: gw.listRecords(p6, 'objection').map(x => ({ target: x.record.target, pointer: x.record.pointer })), blockers: gw.getRecord(p6, 'C001').status.blockers });
  // Successful promotion followed by failed workflow bookkeeping must recover on read.
  const p7 = 'post-commit-bookkeeping';
  await gw.createProject(p7);
  const w7 = world(p7);
  const labels7 = await reviewed(p7, w7);
  await failWorkflowSave(p7, () => w7.c.select(p7, 'K001', { label: labels7.a, reason: 'select' }, host), 2);
  assert.equal(gw.listRecords(p7, 'outline').length, 1);
  assert.equal(w7.c.view(p7, 'K001').selection.label, labels7.a);
  await assert.rejects(w7.c.select(p7, 'K001', { label: labels7.b, reason: 'other' }, host), e => e.status === 409);
  await w7.c.propose(p7, 'K001', { from: { draft: labels7.b, section: 1 }, to: { section: 1, position: 'after' } }, host);
  await w7.c.decide(p7, 'K001', 'P1', { decision: 'accept' }, host);
  await failWorkflowSave(p7, () => w7.c.apply(p7, 'K001', host), 2);
  assert.equal(w7.c.view(p7, 'K001').patches[0].applied.version, 2);
  const closed7 = await w7.c.close(p7, 'K001', host);
  assert.deepEqual(closed7.minority.skipped_patches, []);
  observe('post-commit-bookkeeping', { stage: closed7.stage, version: closed7.record.version, skipped: closed7.minority.skipped_patches });

  // Simulate interruption after receive() but before promote(), then ordinary patch actions.
  const p8 = 'pending-apply-new-decision';
  await gw.createProject(p8);
  const w8 = world(p8, { b: '## First\nDONOR-ONE.\n\n## Second\nDONOR-TWO.\n' });
  const labels8 = await reviewed(p8, w8);
  await w8.c.select(p8, 'K001', { label: labels8.a, reason: 'select' }, host);
  await w8.c.propose(p8, 'K001', { from: { draft: labels8.b, section: 1 }, to: { section: 1, position: 'after' } }, host);
  await w8.c.decide(p8, 'K001', 'P1', { decision: 'accept' }, host);
  const originalPromote = gw.promote;
  gw.promote = async () => { throw Object.assign(new Error('Injected interruption before promotion'), { status: 503 }); };
  try { await assert.rejects(w8.c.apply(p8, 'K001', host), /Injected interruption/); }
  finally { gw.promote = originalPromote; }
  const pending8 = w8.c.view(p8, 'K001').pending;
  assert.equal(gw.requestOutcome(p8, pending8.request_id).state, 'unknown');
  // Both mutations unexpectedly succeed while pending is unresolved.
  await w8.c.propose(p8, 'K001', { from: { draft: labels8.b, section: 2 }, to: { section: 1, position: 'before' } }, host);
  await w8.c.decide(p8, 'K001', 'P2', { decision: 'accept' }, host);
  let applyError8, closeError8;
  try { await w8.c.apply(p8, 'K001', host); } catch (e) { applyError8 = errorOf(e); }
  try { await w8.c.close(p8, 'K001', host); } catch (e) { closeError8 = errorOf(e); }
  assert.equal(applyError8?.status, 409);
  assert.equal(closeError8?.status, 409);
  observe('pending-apply-changed-patches', { pendingPatches: pending8.patches, acceptedPatches: w8.c.view(p8, 'K001').patches.filter(p => p.state === 'accepted').map(p => p.id), applyError: applyError8, closeError: closeError8 });

  // Restart the actual commit gateway, not just the competition wrapper.
  await gw.queue.idle(); gw.stop();
  const restartedGateway = createCommitGateway({ workbench: wb, defaults, fence: board.fence });
  try {
    const startup = await restartedGateway.start();
    const restarted = createCompetitions({ workbench: wb, gateway: restartedGateway, board, runner: w8.runner, participants: lookup });
    let afterRestartError;
    try { await restarted.apply(p8, 'K001', host); } catch (e) { afterRestartError = errorOf(e); }
    assert.equal(afterRestartError?.status, 409);
    const cand = restartedGateway.candidates(p8).find(x => x.request_id === pending8.request_id);
    await assert.rejects(restartedGateway.promote(p8, cand.sid), e => e.status === 409);
    observe('pending-apply-after-restart', { recovered: startup.recovered, pending: restarted.view(p8, 'K001').pending, outcome: restartedGateway.requestOutcome(p8, pending8.request_id), recordVersion: restartedGateway.getRecord(p8, 'OL001').record.version, error: afterRestartError });
  } finally { await restartedGateway.queue.idle(); restartedGateway.stop(); }
} finally {
  for (const runner of runners) await runner.idle();
  await gw.queue.idle();
  gw.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp5b-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

