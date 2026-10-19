// Independent review observations. Assertions confirm fixture setup; printed results expose product behavior.
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
// Fail only the workflow JSON rename after the formal record is already committed.
async function failWorkflowSave(project, operation) {
  const target = path.resolve(wb.get(project).dir, 'competitions', 'K001.json');
  const original = fs.renameSync;
  let hit = 0;
  fs.renameSync = (from, to, ...rest) => {
    if (path.resolve(String(to)) === target) { hit++; throw Object.assign(new Error('Injected workflow write failure'), { code: 'ENOSPC' }); }
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
  await submit(p1, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'Corrected population statement.', sources: [{ id: 'S001', version: 1, quote: '1200' }] } }]);
  observe('claims-via-outline-input', { body: selected1.record.body, claims: selected1.record.claims, readyBefore: selected1.status.ready, claimReady: gw.getRecord(p1, 'C001').status.ready, statusAfterClaimUpdate: gw.getRecord(p1, 'OL002').status });

  const p2 = 'select-save-failure';
  await gw.createProject(p2);
  const w2 = world(p2);
  const labels2 = await reviewed(p2, w2);
  const failedSelect = await failWorkflowSave(p2, () => w2.c.select(p2, 'K001', { label: labels2.a, reason: 'First choice' }, host));
  const stageAfterFailedSelect = w2.c.view(p2, 'K001').stage;
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
  const closed3 = await w3.c.close(p3, 'K001', host);
  observe('apply-save-failure', { error: failedApply, recordedAppliedVersion: viewAfterFailure.applied.version, realRecord: viewAfterFailure.record, patch: closed3.patches[0], minority: closed3.minority, stage: closed3.stage });

  const p4 = 'more-than-six-drafts';
  await gw.createProject(p4);
  fs.writeFileSync(path.join(wb.get(p4).dir, 'protocol.json'), JSON.stringify({ compete: { drafts: 8 } }));
  const more = Array.from({ length: 8 }, (_, i) => ({ id: `draft-${i + 1}`, name: `Drafter ${i + 1}`, adapter: 'generic', resolved: 'fixture' }));
  people.push(...more);
  const w4 = world(p4);
  w4.c.create(p4, { type: 'outline', participants: more.map(p => p.id) }, host);
  await w4.runner.idle();
  const revealed4 = w4.c.reveal(p4, 'K001');
  await w4.c.review(p4, 'K001', { reviewers: ['reviewer'] }, host);
  await w4.runner.idle();
  observe('more-than-six-drafts', { eligibleDrafts: revealed4.drafts.filter(d => d.eligible).length, labels: revealed4.label_drafts.map(d => d.label), reviewTasks: w4.c.view(p4, 'K001').reviews.at(-1).tasks.map(t => ({ ...t, reason: board.get(p4, t.task).history.at(-1).reason })) });

  observe('review-claim-token', parseReview('方案甲 C100：This claim needs checking.', { drafts: { '方案甲': '## Section\nOnly C1000 is used here.' }, claimExists: id => ['C100', 'C1000'].includes(id) }));

  const p5 = 'division-input-truncation';
  await gw.createProject(p5);
  const w5 = world(p5, { a: '```json\n[{"kind":"source","expected_version":0,"data":{"title":"One output","url":"https://example.invalid/one"}}]\n```' });
  const division = createDivisions({ workbench: wb, gateway: gw, board, runner: w5.runner, participants: lookup });
  const items = Array.from({ length: 12 }, (_, i) => `ITEM-${String(i + 1).padStart(2, '0')}: ${'x'.repeat(480)}`);
  const dv = division.create(p5, { type: 'collect_sources', items, participants: ['writer-a'] }, host);
  await w5.runner.idle();
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
  observe('division-pointer-scope', { firstPartInputs: dv6.parts[0].inputs, secondPartInputs: dv6.parts[1].inputs, firstPromptHasOutsideSource: w6.prompts[0].includes('OUTSIDE_ONLY'), firstTaskState: board.get(p6, dv6.parts[0].task).state, objections: gw.listRecords(p6, 'objection').map(x => ({ target: x.record.target, pointer: x.record.pointer })), blockers: gw.getRecord(p6, 'C001').status.blockers });
} finally {
  for (const runner of runners) await runner.idle();
  await gw.queue.idle();
  gw.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp5b-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
