// 工坊的 HTTP 路由。和 server.mjs 里的路由同一格式：[method, 正则, handler(req, match)]。
// 错误一律抛出带 status 的异常，由 server.mjs 统一回复。
import { WorkbenchError } from './project.mjs';

const projectOf = (m) => {
  try {
    return decodeURIComponent(m[1]);
  } catch {
    throw new WorkbenchError(400, '项目名编码错误');
  }
};

export function workbenchRoutes({ workbench, readJson, broadcast }) {
  return [
    ['GET', /^\/api\/projects$/, () => workbench.list()],

    ['POST', /^\/api\/projects$/, async (req) => {
      const body = await readJson(req);
      const { project, archive } = await workbench.create(body.name);
      const summary = { name: project.name, title: project.title };
      broadcast({ type: 'project', project: summary });
      return { ...summary, archive };
    }],

    // 项目概况：约定原文与生效配置（WP2 起补充记录数和派生状态统计）
    ['GET', /^\/api\/projects\/([^/]+)$/, (req, m) => {
      const { name, title, conventions, override, config } = workbench.get(projectOf(m));
      return { name, title, conventions, override, config };
    }],
  ];
}
