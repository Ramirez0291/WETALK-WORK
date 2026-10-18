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

// 归档到 <项目>/archive/memory/<阶段>-<时间>.json，再清空该空间
export function resetPhase({ store, projectDir, project, phase, now = () => new Date() }) {
  const space = phaseSpace(store, project, phase);
  const taken = store.takeSpaceMemories(space.id);
  const at = now().toISOString();
  const file = path.join(projectDir, 'archive', 'memory', `${phase}-${at.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ project, phase, space: space.id, at, notebooks: taken }, null, 2) + '\n', { flag: 'wx' });
  return { space: space.id, archived: Object.keys(taken).length, file };
}
