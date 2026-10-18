// Run from the repository root: node dev-lib/astra-log/WP1-review-probes-2026-10-18.mjs
// Review probes only: all writes are confined to a freshly created temporary directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults, resolveConfig } from '../../lib/workbench/project.mjs';
import { git } from '../../lib/workbench/git.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-wp1-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
const templates = path.join(root, 'templates/project');
const results = [];
try {
  const localTemplates = path.join(temp, 'templates');
  fs.cpSync(templates, localTemplates, { recursive: true });
  fs.writeFileSync(path.join(localTemplates, 'protocol.json'), JSON.stringify({ git: { autoCommit: false } }));
  const repo1 = path.join(temp, 'override');
  const wb1 = createWorkbench({ projectsDir: repo1, defaults, templateDir: localTemplates });
  await wb1.init();
  const before = (await git(repo1, ['rev-parse', 'HEAD'])).stdout.trim();
  const made = await wb1.create('关闭自动留档');
  const after = (await git(repo1, ['rev-parse', 'HEAD'])).stdout.trim();
  results.push({ probe: 'project autoCommit override', effective: made.project.config.git.autoCommit, committedDespiteDisabled: before !== after, archive: made.archive });

  const repo2 = path.join(temp, 'pathspec');
  const wb2 = createWorkbench({ projectsDir: repo2, defaults, templateDir: templates });
  await wb2.init();
  await wb2.create('文稿a');
  fs.appendFileSync(path.join(repo2, '文稿a/project.md'), '\nUnrelated user edit\n');
  const second = await wb2.create('文稿[ab]');
  const changed = await git(repo2, ['show', '--name-only', '--format=', 'HEAD']);
  results.push({ probe: 'literal project path', archive: second.archive, committedPaths: changed.stdout.trim().split('\n') });

  for (const override of [
    { git: { autoCommit: null } },
    { export: { formats: null } },
    { modes: { custom: 42 } },
    { routing: { custom: 'claude' } },
  ]) {
    try {
      const config = resolveConfig(defaults, override);
      results.push({ probe: 'configuration validation', override, accepted: true, effective: config[Object.keys(override)[0]] });
    } catch (error) {
      results.push({ probe: 'configuration validation', override, accepted: false, error: error.message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  const absolute = path.resolve(temp);
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith('astra-wp1-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(absolute, { recursive: true, force: true });
}
