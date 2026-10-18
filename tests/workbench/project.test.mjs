import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults, resolveConfig, validateProjectName, PROJECT_DIRS } from '../../lib/workbench/project.mjs';
import { git } from '../../lib/workbench/git.mjs';
import { renameRetry } from '../../lib/workbench/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULTS = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
const TEMPLATES = path.join(ROOT, 'templates', 'project');

// 临时目录名里故意带日文和中文：用户目录本身就含日文字符
const created = [];
function tmpProjects() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-れいげつ-'));
  created.push(base);
  return path.join(base, '项目资料');
}
after(() => {
  for (const base of created) fs.rmSync(base, { recursive: true, force: true });
});

const gitAvailable = (await git(os.tmpdir(), ['--version'])).ok;

test('new project gets template files, fixed subdirectories and a creation event', async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  const { project, archive } = await wb.create('工坊方案介绍');
  assert.equal(project.name, '工坊方案介绍');
  assert.equal(project.title, '工坊方案介绍');
  for (const sub of PROJECT_DIRS) assert.ok(fs.statSync(path.join(project.dir, sub)).isDirectory(), sub);
  for (const f of ['project.md', 'protocol.json', 'baseline.md']) assert.ok(fs.existsSync(path.join(project.dir, f)), f);
  assert.match(project.conventions, /## 受众/);
  assert.doesNotMatch(project.conventions, /\{\{\w+\}\}/);
  const events = fs.readFileSync(path.join(project.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'project_created');
  assert.ok(archive.ok, archive.error);
  // 没有留下临时目录
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('_staging-')), []);
});

test('git archive commits only the new project files, even with other changes staged', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
  await git(dir, ['add', 'unrelated.txt']);
  await wb.create('甲');
  const files = (await git(dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n').sort();
  assert.deepEqual(files, ['甲/baseline.md', '甲/project.md', '甲/protocol.json']);
  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).stdout.trim();
  assert.equal(staged, 'unrelated.txt');
});

test('list shows only directories with project.md, skipping internal and raw-material folders', async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  await wb.create('乙');
  fs.mkdirSync(path.join(dir, '旧资料'));
  fs.mkdirSync(path.join(dir, '_txn'));
  fs.mkdirSync(path.join(dir, '_hidden'));
  fs.writeFileSync(path.join(dir, '_hidden', 'project.md'), '# x');
  assert.deepEqual(wb.list().map((p) => p.name), ['乙']);
});

test('duplicate and unsafe project names are rejected', async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  await wb.create('丙');
  await assert.rejects(wb.create('丙'), { status: 409 });
  for (const bad of ['', '  ', '../x', 'a/b', 'a\\b', 'CON', 'nul.txt', '.git', '_txn', 'x.', 'a:b', 'x'.repeat(65), 42]) {
    assert.throws(() => validateProjectName(bad), { status: 400 }, String(bad));
  }
  assert.equal(validateProjectName(' 创世物语 第二集 '), '创世物语 第二集');
  assert.throws(() => wb.get('不存在'), { status: 404 });
});

test('project override deep-merges onto defaults and is reflected in the effective config', async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  const { project } = await wb.create('丁');
  fs.writeFileSync(path.join(project.dir, 'protocol.json'), JSON.stringify({ budget: { calls: 50 }, modes: { glossary: 'divide' } }));
  const { config } = wb.get('丁');
  assert.equal(config.budget.calls, 50);
  assert.equal(config.budget.apiUsd, DEFAULTS.budget.apiUsd);
  assert.equal(config.modes.glossary, 'divide');
  assert.equal(config.modes.outline, 'compete');
});

test('limits are invariants: they cannot be removed, made infinite or zero', () => {
  const bad = [
    { budget: { calls: null } },
    { budget: { calls: 0 } },
    { budget: { calls: 1.5 } },
    { budget: { apiUsd: 0 } },
    { budget: { apiUsd: '10' } },
    { task: { maxDepth: -1 } },
    { task: { maxAttempts: null } },
    { evidence: { maxAttempts: 0 } },
    { lease: { minutes: 0 } },
    { retry: { max: -1 } },
    { budget: null },
  ];
  for (const o of bad) assert.throws(() => resolveConfig(DEFAULTS, o), { status: 400 }, JSON.stringify(o));
  assert.equal(resolveConfig(DEFAULTS, { retry: { max: 0 } }).retry.max, 0);
  // JSON 里写不出 Infinity，但程序内部传进来也要拦住
  assert.throws(() => resolveConfig(DEFAULTS, { budget: { calls: Infinity } }), { status: 400 });
});

test('unknown keys and global-only keys are rejected; notes keys are ignored', () => {
  assert.throws(() => resolveConfig(DEFAULTS, { budgett: {} }), /未知参数 budgett/);
  assert.throws(() => resolveConfig(DEFAULTS, { lease: { minute: 5 } }), /未知参数 lease.minute/);
  assert.throws(() => resolveConfig(DEFAULTS, { projectsDir: 'elsewhere' }), /只能在全局设置/);
  assert.throws(() => resolveConfig(DEFAULTS, { slides: 100 }), /必须是对象/);
  assert.throws(() => resolveConfig(DEFAULTS, { export: { formats: 'md' } }), /类型应为 array/);
  assert.equal(resolveConfig(DEFAULTS, { _comment: 'x', export: { template: 'templates/a.pptx' } }).export.template, 'templates/a.pptx');
  assert.throws(() => resolveConfig(DEFAULTS, []), { status: 400 });
});

test('a malformed protocol.json is reported, not silently ignored', async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  const { project } = await wb.create('戊');
  fs.writeFileSync(path.join(project.dir, 'protocol.json'), '{ budget: ');
  assert.throws(() => wb.get('戊'), /protocol.json 格式错误/);
});

test('the shipped defaults themselves satisfy every invariant', () => {
  assert.doesNotThrow(() => resolveConfig(DEFAULTS, {}));
});

test('the projects repo archives exact bytes regardless of the global autocrlf setting', { skip: !gitAvailable && 'git 不可用' }, async () => {
  const dir = tmpProjects();
  const wb = createWorkbench({ projectsDir: dir, defaults: DEFAULTS, templateDir: TEMPLATES });
  await wb.init();
  assert.equal((await git(dir, ['config', '--local', 'core.autocrlf'])).stdout.trim(), 'false');
});

test('rename retries while the target is briefly locked, but gives up on other errors', async () => {
  let calls = 0;
  const busyTwice = () => {
    if (++calls <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  await renameRetry('a', 'b', { rename: busyTwice, delayMs: 1 });
  assert.equal(calls, 3);
  let other = 0;
  const missing = () => {
    other++;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  await assert.rejects(renameRetry('a', 'b', { rename: missing, delayMs: 1 }), { code: 'ENOENT' });
  assert.equal(other, 1);
  const alwaysBusy = () => {
    throw Object.assign(new Error('locked'), { code: 'EPERM' });
  };
  await assert.rejects(renameRetry('a', 'b', { rename: alwaysBusy, attempts: 3, delayMs: 1 }), { code: 'EPERM' });
});
