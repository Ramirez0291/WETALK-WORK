// 子进程：执行一次提交，在写前日志的指定步骤之后直接退出进程（不走任何 finally），模拟服务被强制杀掉。
// 用法：node crash-child.mjs <projectsDir> <project> <step> <changes.json>
import fs from 'node:fs';
import { createWorkbench } from '../../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../../lib/workbench/commit.mjs';
import { DEFAULTS, TEMPLATES, HUMAN } from '../helpers.mjs';

const [projectsDir, project, step, changesFile] = process.argv.slice(2);
const workbench = createWorkbench({ projectsDir, defaults: DEFAULTS, templateDir: TEMPLATES });
const gw = createCommitGateway({
  workbench,
  defaults: DEFAULTS,
  lock: false,
  crash: (s) => {
    if (s === step) process.exit(77);
  },
});
await gw.start();
const receipt = gw.receive(project, { request_id: `crash-${Date.now()}`, changes: JSON.parse(fs.readFileSync(changesFile, 'utf8')) }, { actor: HUMAN });
await gw.promote(project, receipt.sid);
process.exit(0); // 没有在指定步骤崩溃
