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

export function workbenchRoutes({ workbench, gateway, web, usage, readJson, hostToken, humanName }) {
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

    ['GET', re('/inbox'), (req, m) => {
      const items = gateway.inbox(project(m));
      // 用量到达上限：新调用和重试都会被拒，需要你决定是否提高上限
      if (usage) {
        const t = usage.totals(project(m));
        if (t.calls >= t.limits.calls || t.usd >= t.limits.usd) items.push({ type: 'budget_exceeded', project: project(m), ...t });
      }
      return items;
    }],

    // ---------- WP3：DeepSeek Search / Fetch、用量、来源可获取性 ----------

    // { query, count?, ori_question?, need_content? }：只返回线索，不存快照
    ['POST', re('/web/search'), async (req, m) => web.search(project(m), await readJson(req))],

    // { url, source_id?, create? }：抓正文存成快照；给了 source_id 就更新那张来源卡，create 为真时新建来源卡
    ['POST', re('/web/fetch'), async (req, m) => web.fetch(project(m), await readJson(req))],

    ['GET', re('/usage'), (req, m) => {
      const p = project(m);
      const entries = usage.entries(p);
      return { ...usage.totals(p), recent: entries.slice(-50).reverse() };
    }],

    // 主持人确认来源已不存在（gone），或撤销确认（available）。只接受主持人入口
    ['POST', re('/sources/(S\\d{3,6})/availability'), async (req, m) => {
      const actor = actorOf(req);
      if (!actor) throw new WorkbenchError(403, '来源可获取性只能由主持人确认');
      const body = await readJson(req);
      gateway.getRecord(project(m), m[2]);
      return usage.mark(project(m), m[2], body.state, { by: actor.participant, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null });
    }],
  ];
}
