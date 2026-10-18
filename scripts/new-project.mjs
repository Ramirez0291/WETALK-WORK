#!/usr/bin/env node
// npm run new-project <名称>：从模板新建工坊项目。
// 服务进程是正式区唯一的写入者，所以先走服务接口。接口连不上并不能证明服务已经退出，
// 所以本地创建前要先取得项目目录的单实例锁：服务还活着就取不到，直接报错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../lib/workbench/project.mjs';
import { createCommitGateway } from '../lib/workbench/commit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.error('用法：npm run new-project <名称>');
  process.exit(1);
}

function serverPort() {
  if (process.env.WETALK_PORT) return Number(process.env.WETALK_PORT);
  const file = path.resolve(process.env.WETALK_CONFIG || path.join(ROOT, 'wetalk.config.json'));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).port || 7788;
  } catch {
    return 7788;
  }
}

async function viaServer(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    return null; // 服务没在运行
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { name: data.name, archive: data.archive, via: `服务 127.0.0.1:${port}` };
}

async function locally() {
  const defaults = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
  const projectsDir = path.resolve(ROOT, process.env.WETALK_PROJECTS || defaults.projectsDir);
  const workbench = createWorkbench({ projectsDir, defaults, templateDir: path.join(ROOT, 'templates', 'project') });
  const gateway = createCommitGateway({ workbench, defaults, lockOpts: { purpose: 'new-project' } });
  await gateway.start(); // 取锁、做和服务启动时一样的恢复
  try {
    const { project, archive } = await gateway.createProject(name);
    await gateway.queue.idle();
    return { name: project.name, archive, via: '本地（服务未运行）', dir: project.dir };
  } finally {
    gateway.stop();
  }
}

try {
  const r = (await viaServer(serverPort())) ?? (await locally());
  console.log(`已新建项目「${r.name}」（${r.via}）`);
  if (r.dir) console.log(`目录：${r.dir}`);
  const archive = { done: 'git 留档：完成', disabled: 'git 留档：本项目已关闭自动留档（git.autoCommit = false）' };
  console.log(archive[r.archive?.state] ?? `git 留档：失败（${r.archive?.error}）`);
  console.log('下一步：填写 project.md 里的受众、观众应理解什么、篇幅、风格和验收标准。');
} catch (e) {
  console.error(`新建失败：${e.message}`);
  process.exit(1);
}
