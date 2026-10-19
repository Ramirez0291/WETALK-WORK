// WP5a rereview: original seven scenarios plus author-history and anonymity boundaries.
// Expected rejections are checked explicitly; outputs are observations, not a blanket pass.
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
import { createEvidenceFlow } from '../../lib/workbench/evidence.mjs';
import { createRunner } from '../../lib/workbench/runner.mjs';
import { createSealedStore } from '../../lib/workbench/visibility.mjs';
import { countVerifications } from '../../lib/workbench/verify.mjs';
import { collectInputs } from '../../lib/workbench/packets.mjs';
import { workbenchRoutes } from '../../lib/workbench/http.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp5a-rereview-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const workbench = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
const usage = createUsage({ workbench, pricing: defaults.pricing });
const board = createTaskBoard({ workbench, usage });
const availabilityOf = (p, urlOf) => usage.availabilityOf(p, { urlOf });
const gateway = createCommitGateway({ workbench, defaults, fence: board.fence, availabilityOf });
const flow = createEvidenceFlow({ workbench, gateway, board, availabilityOf });
const HUMAN = { kind: 'human', participant: 'review-host', verified: true };
const agent = (participant, adapter, model = null) => ({ kind: 'server', participant, adapter, model, verified: true });
const DS = agent('ds', 'deepseek');
const CL = agent('cl', 'claude');
const CX = agent('cx', 'codex');
const UNKNOWN = agent('unknown-judge', 'generic');
const rid = () => `probe-${crypto.randomUUID()}`;
const record = (p, id) => gateway.getRecord(p, id).record;
const result = (name, value) => console.log(JSON.stringify({ probe: name, ...value }));
const claimData = (source = 'S001') => ({ type: 'fact', text: 'Population is 1200', sources: [{ id: source, version: 1, quote: '1200' }] });
const verify = (version = 1, verdict = 'supported') => ({ kind: 'verification', expected_version: 0, data: { target: { id: 'C001', version }, source_versions: [{ id: 'S001', version: 1 }], verdict, reason: 'Fixture judgment', ...(verdict === 'supported' ? { support_quote: { id: 'S001', version: 1, quote: '1200' } } : {}) } });
const objection = (state = 'open') => ({ kind: 'objection', expected_version: 0, data: { target: { id: 'C001', version: 1 }, category: 'number_error', pointer: state === 'open' ? { type: 'quote', source: { id: 'S001', version: 1 }, quote: '1200' } : { type: 'location', locator: 'population' }, reason: 'Please check the number', state } });
const move = (o, state) => ({ id: o.id, expected_version: o.version, data: { target: o.target, category: o.category, pointer: o.pointer, reason: o.reason, state, resolution: 'Fixture resolution' } });
async function as(p, holder, changes) {
  let body = { request_id: rid(), changes };
  let opts;
  if (holder.kind === 'human') opts = { actor: holder };
  else {
    const t = board.create(p, { type: 'extract_claims' }, { created_by: HUMAN });
    const c = board.claim(p, t.id, holder);
    body = { ...body, task_id: t.id, attempt: c.attempt, lease_token: c.lease_token };
  }
  const receipt = gateway.receive(p, body, opts);
  return gateway.promote(p, receipt.sid);
}
async function sample(p, author = DS) {
  await gateway.createProject(p);
  await as(p, HUMAN, [{ kind: 'source', expected_version: 0, data: { title: 'Original source', text: 'OLD-SOURCE: Population was 1200.', url: 'https://example.invalid/old' } }]);
  await as(p, author, [{ kind: 'claim', expected_version: 0, data: claimData() }]);
}
const runners = [];
async function rejected(fn, type) {
  let observed;
  await assert.rejects(fn, (e) => {
    observed = e.details?.reasons?.map((r) => r.type);
    return e.status === 409 && observed?.includes(type);
  });
  return observed;
}
try {
  await gateway.start();

  await sample('human-edit');
  await as('human-edit', HUMAN, [{ id: 'C001', expected_version: 1, data: { ...claimData(), text: 'Population is 1200.' } }]);
  const humanEditRejection = await rejected(() => as('human-edit', DS, [verify(2)]), 'is_author');
  result('R1-rejected', { reasons: humanEditRejection });
  result('original-author-after-human-edit', { currentAuthor: record('human-edit', 'C001').provenance, verification: gateway.getRecord('human-edit', 'C001').status.verification, ready: gateway.getRecord('human-edit', 'C001').status.ready });

  await sample('unknown-judge');
  await as('unknown-judge', CL, [objection()]);
  const unknownRejection = await rejected(() => as('unknown-judge', UNKNOWN, [move(record('unknown-judge', 'O001'), 'rejected')]), 'judge_vendor_unknown');
  result('R2-rejected', { reasons: unknownRejection });
  result('unknown-vendor-judge', { state: record('unknown-judge', 'O001').state, judge: record('unknown-judge', 'O001').provenance, blockers: gateway.getRecord('unknown-judge', 'C001').status.blockers });

  await sample('gone-undo');
  usage.mark('gone-undo', 'S001', 'gone', { by: HUMAN.participant, url: 'https://example.invalid/old' });
  await flow.reconcile('gone-undo');
  await as('gone-undo', CL, [move(record('gone-undo', 'O001'), 'needs_user')]);
  usage.mark('gone-undo', 'S001', 'available', { by: HUMAN.participant, url: 'https://example.invalid/old' });
  let goneError;
  try { await flow.reconcile('gone-undo'); } catch (e) { goneError = { status: e.status, reasons: e.details?.reasons }; }
  result('gone-undo-needs-user', { error: goneError, state: record('gone-undo', 'O001').state, availability: gateway.getRecord('gone-undo', 'S001').availability.state });

  await sample('old-evidence');
  await as('old-evidence', CL, [objection('needs_evidence')]);
  await as('old-evidence', HUMAN, [{ kind: 'source', expected_version: 0, data: { title: 'Replacement source', text: 'NEW-SOURCE: Population is now 1200.', url: 'https://example.invalid/new' } }]);
  await as('old-evidence', DS, [{ id: 'C001', expected_version: 1, data: claimData('S002') }]);
  const [act] = await flow.reconcile('old-evidence');
  const evidenceTask = board.get('old-evidence', act.task);
  const inputs = collectInputs({ gateway, project: 'old-evidence', task: evidenceTask, visibility: 'read' });
  result('evidence-target-version', { objectionTarget: record('old-evidence', 'O001').target, taskInputs: evidenceTask.inputs, sourceTextRefs: inputs.filter((i) => i.role === 'source_text').map((i) => i.ref) });

  await sample('reported-model', CX);
  const p = { id: 'configured-claude', name: 'Fixture', adapter: 'claude', resolved: 'fixture' };
  const runner = createRunner({ workbench, gateway, board, usage, sealed: createSealedStore(), participants: Object.assign(() => p, { all: () => [p] }), workRoot: path.join(temp, 'work'), sandboxDir: path.join(temp, 'sandbox'),
    runAgent: async () => ({ raw: '```json\n' + JSON.stringify({ verdict: 'supported', reason: 'Fixture judgment', support_quote: { id: 'S001', version: 1, quote: '1200' }, objections: [] }) + '\n```', model: 'gpt-6-fixture', exec: { args: [] } }) });
  runners.push(runner);
  const task = board.create('reported-model', { type: 'verify_claim', inputs: [{ id: 'C001', version: 1 }] }, { created_by: HUMAN });
  runner.dispatch('reported-model', task.id, p.id);
  await runner.idle();
  assert.equal(gateway.listRecords('reported-model', 'verification').length, 0);
  assert.match(board.get('reported-model', task.id).history.at(-1).reason, /same_vendor/);
  result('reported-vendor-mismatch', { taskState: board.get('reported-model', task.id).state, verificationCount: gateway.listRecords('reported-model', 'verification').length, reported: runner.callLogOf('reported-model').getMany(() => true).map((c) => c.reported), ready: gateway.getRecord('reported-model', 'C001').status.ready });

  const syntheticClaim = { id: 'C001', version: 1, sources: [{ id: 'S001', version: 1 }], provenance: DS };
  const synthetic = ['V999', 'V1000'].map((id, i) => ({ id, ...verify().data, verifier: CL, verdict: i ? 'unsupported' : 'supported' }));
  result('latest-verification-after-999', countVerifications(syntheticClaim, synthetic, new Map([['S001', { id: 'S001', version: 1 }]])));

  await sample('resolve-retry');
  await as('resolve-retry', CL, [objection()]);
  const routes = workbenchRoutes({ workbench, gateway, board, usage, hostToken: 'fixture-token', humanName: HUMAN.participant, readJson: async (req) => req.body });
  const requestPath = '/api/projects/resolve-retry/objections/O001/resolve';
  const route = routes.find(([method, re]) => method === 'POST' && re.test(requestPath));
  const req = { headers: { 'x-workbench-host': 'fixture-token' }, body: { request_id: 'repeat-resolve-0001', state: 'rejected', resolution: 'Fixture decision' } };
  await route[2](req, requestPath.match(route[1]));
  let retryError;
  try { await route[2](req, requestPath.match(route[1])); } catch (e) { retryError = { status: e.status, message: e.message }; }
  result('resolve-request-id-retry', { firstState: record('resolve-retry', 'O001').state, retryError });

  // A configured participant can change its model/vendor between task attempts.
  // The cumulative author history must retain the second contribution as well as the first.
  await sample('author-vendor-change', agent('writer', 'generic', 'deepseek-fixture'));
  await as('author-vendor-change', agent('writer', 'generic', 'gpt-6-fixture'), [{ id: 'C001', expected_version: 1, data: { ...claimData(), text: 'The population is 1200 according to this source.' } }]);
  let changedAuthorRejection = null;
  try { await as('author-vendor-change', CX, [verify(2)]); } catch (e) { changedAuthorRejection = e.details?.reasons; }
  const changedAuthor = gateway.getRecord('author-vendor-change', 'C001');
  result('new-R1-author-vendor-change', { authors: changedAuthor.record.authors, currentProvenance: changedAuthor.record.provenance, rejection: changedAuthorRejection, ready: changedAuthor.status.ready, verification: changedAuthor.status.verification });

  // Human names and former/unconfigured participant names are not in anonymityTerms.
  await gateway.createProject('anonymous-authors');
  await as('anonymous-authors', HUMAN, [{ kind: 'outline', expected_version: 0, data: { title: 'Neutral plan', body: 'A short introduction and conclusion.', claims: [] } }]);
  const reviewer = { id: 'reviewer-agent', name: 'Reviewer fixture', adapter: 'claude', resolved: 'fixture' };
  let reviewPrompt = '';
  const reviewRunner = createRunner({ workbench, gateway, board, usage, sealed: createSealedStore(), participants: Object.assign(() => reviewer, { all: () => [reviewer] }), workRoot: path.join(temp, 'review-work'), sandboxDir: path.join(temp, 'review-sandbox'),
    runAgent: async (_person, prompt) => { reviewPrompt = prompt; return { raw: 'The conclusion could use one example.', model: null, exec: { args: [] } }; } });
  runners.push(reviewRunner);
  const reviewTask = board.create('anonymous-authors', { type: 'anonymous_review', inputs: [{ id: 'OL001', version: 1 }] }, { created_by: HUMAN });
  reviewRunner.dispatch('anonymous-authors', reviewTask.id, reviewer.id);
  await reviewRunner.idle();
  result('new-R2-anonymous-author-metadata', { taskState: board.get('anonymous-authors', reviewTask.id).state, promptSent: !!reviewPrompt, containsHumanName: reviewPrompt.includes(HUMAN.participant), containsAuthorsField: reviewPrompt.includes('"authors"'), containsHumanKind: reviewPrompt.includes('"kind": "human"') });
} finally {
  for (const runner of runners) await runner.idle();
  await gateway.queue.idle();
  gateway.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp5a-rereview-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
