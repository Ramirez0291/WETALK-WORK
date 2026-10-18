// 工坊的 HTTP 路由。和 server.mjs 里的路由同一格式：[method, 正则, handler(req, match)]。
// 错误一律抛出带 status 的异常（可附 details），由 server.mjs 统一回复。
import { WorkbenchError } from './project.mjs';
import { KINDS } from './records.mjs';

const decode = (s, what) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new WorkbenchError(400, `${what}编码错误`);
  }
};

// 主持人入口：工坊页面加载时拿到本次服务启动生成的令牌，提交时放在请求头里。
// 请求体里自报的 author / kind 一律不看。令牌只证明请求来自加载过工坊页面的客户端，
// 防不住刻意抓取页面的本机进程——本机进程隔离不在 WP2 的范围内（见 WP2 日志）。
export const HOST_HEADER = 'x-workbench-host';

export function workbenchRoutes({ workbench, gateway, readJson, hostToken, humanName }) {
  const P = '/api/projects/([^/]+)';
  const re = (tail = '') => new RegExp(`^${P}${tail}$`);
  const project = (m) => decode(m[1], '项目名');
  const actorOf = (req) =>
    hostToken && req.headers[HOST_HEADER] === hostToken
      ? { kind: 'human', participant: humanName, verified: true, basis: 'host-session' }
      : null;

  return [
    ['GET', /^\/api\/projects$/, () => workbench.list()],

    ['POST', /^\/api\/projects$/, async (req) => {
      const body = await readJson(req);
      const { project: p, archive } = await gateway.createProject(body.name);
      return { name: p.name, title: p.title, archive };
    }],

    // 概况：项目约定原文、生效配置、记录数与派生状态统计、待你决定数
    ['GET', re(), (req, m) => {
      const { name, title, conventions, override, config } = workbench.get(project(m));
      return { name, title, conventions, override, config, ...gateway.overview(name) };
    }],

    ['GET', re('/records'), (req, m) => {
      const kind = new URL(req.url, 'http://localhost').searchParams.get('kind');
      if (kind && !KINDS[kind]) throw new WorkbenchError(400, `kind 只能是 ${Object.keys(KINDS).join(' / ')}`);
      return gateway.listRecords(project(m), kind || null);
    }],

    ['GET', re('/records/([A-Z]{1,2}\\d{3,6})'), (req, m) => gateway.getRecord(project(m), m[2])],

    ['GET', re('/trace/([A-Z]{1,2}\\d{3,6})'), (req, m) => gateway.trace(project(m), m[2])],

    // 收稿：{ request_id, task_id?, attempt?, lease_token?, changes: [{ kind?, id?, tmp?, expected_version, data }] }
    ['POST', re('/submissions'), async (req, m) => {
      const body = await readJson(req);
      return gateway.receive(project(m), body, { actor: body.task_id ? null : actorOf(req) });
    }],

    ['GET', re('/submissions'), (req, m) => gateway.candidates(project(m))],

    ['POST', re('/submissions/([\\w-]{1,80})/promote'), (req, m) => gateway.promote(project(m), m[2])],

    ['GET', re('/commits'), (req, m) => gateway.commits(project(m))],

    ['GET', re('/inbox'), (req, m) => gateway.inbox(project(m))],
  ];
}
