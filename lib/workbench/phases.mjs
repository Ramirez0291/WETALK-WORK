// 阶段与工作记忆（契约四“阶段重置的范围”）：每个“项目＋阶段”使用一个独立的 WeTalk 记忆空间。
// 重置只归档并清空当前项目、当前阶段的那个空间，不碰全局共享记忆，也不碰其他项目、其他阶段。
// 阶段切换时何时重置、交接单怎么写，在 WP6 接入调度。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';

export const phaseSpaceName = (project, phase) => `工坊·${project}·${phase}`;

// 取得（没有就新建）某个项目某个阶段的记忆空间
export function phaseSpace(store, project, phase) {
  if (typeof phase !== 'string' || !/^[\w\u4e00-\u9fff-]{1,40}$/.test(phase)) throw new WorkbenchError(400, '阶段名只能是 1–40 个字母、数字、汉字、下划线或连字符');
  const name = phaseSpaceName(project, phase);
  return store.listSpaces().find((s) => s.name === name) ?? store.createSpace({ name, parent: null });
}

// 先归档到 <项目>/archive/memory/<阶段>-<时间>.json（临时文件写完再改名），归档成功后才清空该空间。
// 归档失败时记忆原样保留，错误抛给调用方
export function resetPhase({ store, projectDir, project, phase, now = () => new Date() }) {
  const space = phaseSpace(store, project, phase);
  const at = now().toISOString();
  const file = path.join(projectDir, 'archive', 'memory', `${phase}-${at.replace(/[:.]/g, '-')}.json`);
  const { taken } = store.takeSpaceMemories(space.id, (notebooks) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) throw new WorkbenchError(409, `归档文件已存在：${path.basename(file)}`);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ project, phase, space: space.id, at, notebooks }, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  });
  return { space: space.id, archived: Object.keys(taken).length, file };
}
