// 工坊测试的公共夹具：临时项目目录（路径含中日文）、提交入口、常用记录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULTS = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
export const TEMPLATES = path.join(ROOT, 'templates', 'project');
export const HUMAN = { kind: 'human', participant: '主持人', verified: true, basis: 'host-session' };

const created = [];
const gateways = [];
export function tmpBase(prefix = 'wb-れいげつ-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(base);
  return base;
}
// 先等每个提交入口队列里的 git 留档做完，再删临时目录
export async function cleanup() {
  for (const gw of gateways.splice(0)) {
    await gw.queue.idle();
    gw.stop();
  }
  for (const base of created.splice(0)) fs.rmSync(base, { recursive: true, force: true });
}

export const rid = () => `req-${crypto.randomBytes(6).toString('hex')}`;

// 建一个项目目录和提交入口；opts 原样传给 createCommitGateway
export async function setup({ projects = ['样本'], dir, ...opts } = {}) {
  const projectsDir = dir ?? path.join(tmpBase(), '项目资料');
  const workbench = createWorkbench({ projectsDir, defaults: DEFAULTS, templateDir: TEMPLATES });
  const gw = createCommitGateway({ workbench, defaults: DEFAULTS, lock: false, ...opts });
  gateways.push(gw);
  await gw.start();
  for (const p of projects) if (!fs.existsSync(path.join(projectsDir, p))) await gw.createProject(p);
  return { projectsDir, workbench, gw };
}

// 换一个新的提交入口实例读同一个目录：模拟服务重启。
// 先让同一目录上的旧实例把队列里的留档做完并停下——生产环境里单实例锁保证同一时间只有一个实例。
export async function restart({ projectsDir, workbench }, opts = {}) {
  for (const old of gateways) {
    if (old.projectsDir !== projectsDir) continue;
    await old.queue.idle();
    old.stop();
  }
  const gw = createCommitGateway({ workbench, defaults: DEFAULTS, lock: false, ...opts });
  gateways.push(gw);
  const r = await gw.start();
  return { gw, recovered: r.recovered };
}

export async function submit(gw, project, changes, extra = {}) {
  const receipt = gw.receive(project, { request_id: rid(), changes, ...extra }, { actor: HUMAN });
  return { receipt, result: await gw.promote(project, receipt.sid) };
}

export const newSource = (tmp, text, extra = {}) => ({ kind: 'source', expected_version: 0, tmp, data: { title: `来源${tmp}`, url: 'https://example.org/a', text, ...extra } });

// 样本：S001（含正文）← C001 ← SL001
export async function seed(gw, project = '样本') {
  return submit(gw, project, [
    newSource('$s', '神话学家指出，盘古开天辟地的故事最早见于三国吴徐整的《三五历纪》。'),
    { kind: 'claim', expected_version: 0, tmp: '$c', data: { type: 'textual', text: '盘古故事最早见于《三五历纪》', earliest_attestation: { work: '《三五历纪》', author: '徐整', period: '三国·吴' }, sources: [{ id: '$s', locator: '第 1 段', quote: '最早见于三国吴徐整的《三五历纪》' }] } },
    { kind: 'slide', expected_version: 0, data: { title: '第 1 页', body: '盘古来晚了', claims: [{ id: '$c' }] } },
  ]);
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
