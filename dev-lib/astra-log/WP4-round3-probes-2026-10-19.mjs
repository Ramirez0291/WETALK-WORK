// Local-only review probe: partial reveal-log append, then retry and reopen the log.
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
import { createCallLog } from '../../lib/calllog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp4-round3-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const workbench = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
const usage = createUsage({ workbench, pricing: defaults.pricing });
const board = createTaskBoard({ workbench, usage });
const gateway = createCommitGateway({ workbench, defaults, fence: board.fence });
let runner;
try {
  await gateway.start();
  await gateway.createProject('A');
  const sealed = createSealedStore();
  const person = { id: 'fixture', name: 'Fixture', adapter: 'generic', resolved: 'fixture' };
  runner = createRunner({ workbench, gateway, board, usage, sealed,
    participants: Object.assign(() => person, { all: () => [person] }),
    runAgent: async () => ({ raw: 'REVEAL-PARTIAL-APPEND', model: 'fixture', exec: { args: [] } }),
    workRoot: path.join(temp, 'work'), sandboxDir: path.join(temp, 'sandbox') });
  const t = board.create('A', { type: 'outline' }, { created_by: { kind: 'human', participant: 'review-host', verified: true } });
  const dispatch = runner.dispatch('A', t.id, person.id);
  await runner.idle();
  const logFile = path.join(workbench.get('A').dir, 'calls.jsonl');
  const original = fs.appendFileSync;
  let armed = true;
  let firstError;
  fs.appendFileSync = function (file, data, ...args) {
    if (armed && typeof file === 'string' && path.resolve(file) === logFile) {
      armed = false;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      original.call(this, file, bytes.subarray(0, Math.floor(bytes.length / 2)), ...args);
      throw Object.assign(new Error('fixture: partial append then disk full'), { code: 'ENOSPC' });
    }
    return original.call(this, file, data, ...args);
  };
  try { runner.reveal('A', dispatch.round); } catch (e) { firstError = e.code; }
  finally { fs.appendFileSync = original; }
  const retry = runner.reveal('A', dispatch.round);
  const log = runner.callLogOf('A');
  let readError = null;
  try { log.getMany((x) => x.fill_of != null); } catch (e) { readError = e.name; }
  const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
  const invalidLines = lines.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } }).length;
  const reopened = createCallLog(logFile);
  console.log(JSON.stringify({ firstError, retriedResults: retry.results.length,
    taskState: board.get('A', t.id).state, round: sealed.status('A', dispatch.round),
    inMemoryFillCount: log.list((x) => x.fill_of != null).length, fillReadError: readError,
    invalidJsonLines: invalidLines, fillCountAfterReopen: reopened.list((x) => x.fill_of != null).length }, null, 2));
} finally {
  if (runner) await runner.idle();
  await gateway.queue.idle();
  gateway.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp4-round3-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
