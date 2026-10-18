// Review reproductions. Run from the repo root with Node; only a fresh temp tree is modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createCommitLog, acquireLock, LOCK_FILE } from '../../lib/workbench/txn.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tempParent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempParent, 'astra-wp2-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const gateways = [];
const actor = { kind: 'human', participant: 'review-fixture', verified: true, basis: 'host-session' };
const P = '样本';
let request = 0;
const results = [];
const source = (title, id) => ({ ...(id ? { id, expected_version: 1 } : { kind: 'source', expected_version: 0 }), data: { title, citation: 'review fixture', text: title } });
async function open(name, options = {}) {
  const projectsDir = path.join(temp, name);
  const workbench = createWorkbench({ projectsDir, defaults, templateDir: path.join(root, 'templates/project') });
  const gw = createCommitGateway({ workbench, defaults, ...options });
  gateways.push(gw);
  await gw.start();
  if (!fs.existsSync(path.join(projectsDir, P))) await gw.createProject(P);
  await gw.queue.idle();
  return { gw, projectsDir };
}
async function submit(gw, changes) {
  const receipt = gw.receive(P, { request_id: `review-${++request}`, changes }, { actor });
  const applied = await gw.promote(P, receipt.sid);
  await gw.queue.idle();
  return applied;
}
async function close(gw) { await gw.queue.idle(); gw.stop(); }

try {
  // Deterministically interleave two stale-lock claimants using the supplied liveness seam.
  {
    const dir = path.join(temp, 'stale-lock');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 99999999, token: 'dead-owner' }));
    let second;
    const first = acquireLock(dir, { purpose: 'claimant-A', isAlive: () => {
      // A has read the old lock. B now removes it and acquires a fresh live lock.
      second = acquireLock(dir, { purpose: 'claimant-B', isAlive: () => false });
      return false; // A resumes its stale-owner observation.
    } });
    results.push({ probe: 'stale-lock takeover interleaving', bothAcquired: Boolean(first && second),
      distinctTokens: first.token !== second.token, diskOwner: JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).purpose });
    first.release();
    second.release();
  }
  // Deleted IDs must remain reserved: old refs must never silently bind to a new source.
  {
    const { gw, projectsDir } = await open('deleted-id');
    await submit(gw, [source('original'), { kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'old claim', sources: [{ id: 'S001', version: 1 }] } }]);
    fs.unlinkSync(path.join(projectsDir, P, 'sources/S001.json'));
    const before = gw.inbox(P);
    const newCommit = await submit(gw, [source('unrelated replacement')]);
    results.push({ probe: 'deleted ID reuse', deletionDetected: before.length > 0, allocated: newCommit.records,
      inboxAfter: gw.inbox(P), claimFreshness: gw.getRecord(P, 'C001').status.freshness,
      oldClaimNowTracesTo: gw.trace(P, 'C001').root.sources[0].title });
    await close(gw);
  }

  // A prepared transaction fails, but the process survives and accepts another write.
  {
    const { gw, projectsDir } = await open('failed-write');
    await submit(gw, [source('v1')]);
    const nativeRename = fs.renameSync;
    const blockedFile = path.join(projectsDir, P, 'sources/S001.json');
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === blockedFile) throw Object.assign(new Error('simulated persistent Windows file lock'), { code: 'EPERM' });
      return nativeRename(from, to);
    };
    let error;
    try { await submit(gw, [source('failed request content', 'S001')]); }
    catch (e) { error = e.message; }
    finally { fs.renameSync = nativeRename; }
    const acknowledged = await submit(gw, [source('acknowledged later content', 'S001')]);
    const before = gw.getRecord(P, 'S001').record.title;
    await close(gw);
    const reopened = await open('failed-write');
    results.push({ probe: 'write after prepared failure', error, acknowledged: acknowledged.cid, beforeRestart: before,
      afterRestart: reopened.gw.getRecord(P, 'S001').record.title, inbox: reopened.gw.inbox(P) });
    await close(reopened.gw);
  }

  // Valid JSON with its final newline missing is indexed, then truncated from the file.
  {
    let armed = false;
    const { gw, projectsDir } = await open('log-tail', { crash: (step) => {
      if (armed && step === 'applied') { armed = false; throw new Error('stop after applied'); }
    } });
    await submit(gw, [source('v1')]);
    armed = true;
    try { await submit(gw, [source('v2', 'S001')]); } catch {}
    await close(gw);
    const logFile = path.join(projectsDir, 'commits.jsonl');
    fs.truncateSync(logFile, fs.statSync(logFile).size - 1);
    const reopened = await open('log-tail');
    results.push({ probe: 'JSON-complete tail without newline', inMemoryCids: reopened.gw.commits(P).map((c) => c.cid),
      persistedCids: createCommitLog(projectsDir).list(P).map((c) => c.cid),
      remainingManifests: fs.readdirSync(path.join(projectsDir, '_txn')) });
    await close(reopened.gw);
    const again = await open('log-tail');
    results.push({ probe: 'second restart after tail repair', commits: again.gw.commits(P).map((c) => c.cid), inbox: again.gw.inbox(P).map((i) => ({ type: i.type, path: i.path })) });
    await close(again.gw);
  }

  // An edited upstream keeps its version number, so dependency version checks alone pass.
  {
    const { gw, projectsDir } = await open('external-upstream');
    await submit(gw, [source('committed source')]);
    const file = path.join(projectsDir, P, 'sources/S001.json');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
    edited.title = 'unaccepted external edit';
    fs.writeFileSync(file, JSON.stringify(edited));
    const applied = await submit(gw, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'depends on edited source', sources: [{ id: 'S001', version: 1 }] } }]);
    results.push({ probe: 'external upstream accepted', applied: applied.records, status: gw.getRecord(P, 'C001').status.freshness, traceTitle: gw.trace(P, 'C001').root.sources[0].title, inbox: gw.inbox(P).map((i) => i.type) });
    await close(gw);
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const gw of gateways) await close(gw);
  const absolute = path.resolve(temp);
  if (path.dirname(absolute) !== tempParent || !path.basename(absolute).startsWith('astra-wp2-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(absolute, { recursive: true, force: true });
}
