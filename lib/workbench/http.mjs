// 工坊的 HTTP 路由。和 server.mjs 里的路由同一格式：[method, 正则, handler(req, match)]。
// 错误一律抛出带 status 的异常（可附 details），由 server.mjs 统一回复。
import { WorkbenchError } from './project.mjs';
import { KINDS } from './records.mjs';
import { restorePacket, listPackets } from './packets.mjs';
import { visibilityOf, VISIBILITY } from './visibility.mjs';
import { vendorOf } from './vendors.mjs';
import { eligibility, vendorOfActor, actorKey } from './verify.mjs';
import crypto from 'node:crypto';

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

export function workbenchRoutes({ workbench, gateway, web, usage, board, runner, sealed, flow = null, readJson, hostToken, humanName, participantByName = () => null, participants = () => [] }) {
  const P = '/api/projects/([^/]+)';
  const re = (tail = '') => new RegExp(`^${P}${tail}$`);
  const project = (m) => decode(m[1], '项目名');
  const actorOf = (req) =>
    hostToken && req.headers[HOST_HEADER] === hostToken
      ? { kind: 'human', participant: humanName, verified: true, basis: 'host-session' }
      : null;

  const requireHost = (req, what) => {
    const actor = actorOf(req);
    if (!actor) throw new WorkbenchError(403, `${what}只能由主持人进行`);
    return actor;
  };
  // MCP 外部会话：自报的名字，对得上配置里的参与者就用它的 id；身份一律未证实
  const agentOf = (body) => {
    const name = typeof body.agent === 'string' ? body.agent.trim().slice(0, 40) : '';
    if (!name) throw new WorkbenchError(400, '缺少 agent（MCP 会话的名字）');
    const p = participantByName(name);
    return { kind: 'mcp', participant: p?.id ?? name, adapter: p?.adapter ?? null, model: null, verified: false, basis: 'mcp-self-reported' };
  };
  const taskView = (p, t) => ({ ...t, lease_token: undefined, visibility: visibilityOf(t), budget_used: board.budgetUsed(p, t.id) });
  const requestIdOf = (body, prefix) => (typeof body.request_id === 'string' ? body.request_id : `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
  // 主持人入口或 MCP 会话（带 agent 名字，身份未证实）；契约一的核验与异议两种都接受，MCP 的核验照样保存但不计入份数
  const writerOf = (req, body) => actorOf(req) ?? agentOf(body);
  // 收稿并立即晋升；晋升被规则拒绝时返回 409 与原因
  async function writeNow(p, requestId, changes, actor) {
    const receipt = gateway.receive(p, { request_id: requestId, changes }, { actor });
    const result = await gateway.promote(p, receipt.sid);
    flow?.poke(p);
    return { receipt, result };
  }
  const cred = (body) => ({ attempt: body.attempt, lease_token: body.lease_token });
  const T = '/tasks/(T\\d{3,6})';

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
      // 任务：失败（不再自动重派）与待你决定
      if (board) for (const t of board.list(project(m))) {
        if (t.state === 'failed' || t.state === 'needs_user') items.push({ type: `task_${t.state}`, project: project(m), task: t.id, title: t.title, reason: t.history.at(-1)?.reason ?? null });
      }
      // 契约一：待你裁决的异议、核验结论不一致的论断
      for (const { record: r } of gateway.listRecords(project(m), 'objection')) {
        if (r.state === 'needs_user') items.push({ type: 'objection_needs_user', project: project(m), objection: r.id, target: r.target, category: r.category, resolution: r.resolution ?? null });
      }
      for (const { record: r, status } of gateway.listRecords(project(m), 'claim')) {
        if (status.verification?.state === 'disputed') items.push({ type: 'claim_disputed', project: project(m), claim: r.id, counted: status.verification.counted });
      }
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

    // { url?, source_id?, create?, relocate? }：抓正文存成快照；给了 source_id 就从那张来源卡的地址抓并更新它，
    // create 为真时新建来源卡；relocate（迁址）只接受主持人入口
    ['POST', re('/web/fetch'), async (req, m) => web.fetch(project(m), await readJson(req), { actor: actorOf(req) })],

    ['GET', re('/usage'), (req, m) => {
      const p = project(m);
      const entries = usage.entries(p);
      return { ...usage.totals(p), recent: entries.slice(-50).reverse() };
    }],

    // ---------- WP4：任务（契约三）、任务包、手动派发、密封轮次 ----------

    ['GET', re('/tasks'), (req, m) => {
      const state = new URL(req.url, 'http://localhost').searchParams.get('state');
      return board.list(project(m), { state: state || undefined }).map((t) => taskView(project(m), t));
    }],

    // 新建或提议任务。主持人入口记为主持人；MCP 会话带 agent 名字，记为未证实的提议者（受深度上限约束）
    ['POST', re('/tasks'), async (req, m) => {
      const body = await readJson(req);
      const by = actorOf(req) ?? agentOf(body);
      return taskView(project(m), board.create(project(m), body, { created_by: by }));
    }],

    ['GET', re(T), (req, m) => taskView(project(m), board.get(project(m), m[2]))],

    // MCP 外部会话认领：返回租约凭证和任务包（输入内联）
    ['POST', re(`${T}/claim`), async (req, m) => runner.claimExternal(project(m), m[2], agentOf(await readJson(req)))],
    ['POST', re(`${T}/renew`), async (req, m) => board.renew(project(m), m[2], cred(await readJson(req)))],
    ['POST', re(`${T}/release`), async (req, m) => taskView(project(m), board.release(project(m), m[2], cred(await readJson(req))))],

    // 外部会话交稿：收稿（栅栏检查）后立即晋升
    ['POST', re(`${T}/submit`), async (req, m) => {
      const body = await readJson(req);
      const receipt = gateway.receive(project(m), { request_id: body.request_id, task_id: m[2], attempt: body.attempt, lease_token: body.lease_token, changes: body.changes });
      if (receipt.state !== 'received') return { receipt, task: taskView(project(m), board.get(project(m), m[2])) };
      try {
        const result = await gateway.promote(project(m), receipt.sid);
        return { receipt, result, task: taskView(project(m), board.get(project(m), m[2])) };
      } catch (e) {
        if (e.status === 409) return { receipt, rejected: e.details, task: taskView(project(m), board.get(project(m), m[2])) };
        throw e;
      }
    }],

    ['POST', re(`${T}/cancel`), (req, m) => taskView(project(m), board.cancel(project(m), m[2], requireHost(req, '取消任务').participant))],
    ['POST', re(`${T}/decide`), async (req, m) => {
      const by = requireHost(req, '“待你决定”的裁决').participant;
      return taskView(project(m), board.decide(project(m), m[2], (await readJson(req)).to, by));
    }],

    // 手动派发给指定参与者（只限主持人）。立即返回，调用在后台进行
    ['POST', re(`${T}/dispatch`), async (req, m) => {
      requireHost(req, '派发任务');
      const body = await readJson(req);
      const r = runner.dispatch(project(m), m[2], String(body.participant ?? ''), { roundId: typeof body.round === 'string' ? body.round : null });
      return { ...r, task: taskView(project(m), r.task) };
    }],

    // 任务包：按尝试号还原当时的全部输入与实际发送的提示词
    ['GET', re(`${T}/packet`), (req, m) => {
      const p = project(m);
      const task = board.get(p, m[2]);
      const attempt = Number(new URL(req.url, 'http://localhost').searchParams.get('attempt')) || task.attempt;
      const ids = listPackets(workbench.get(p).dir, task.id);
      if (!ids.length) throw new WorkbenchError(404, `任务 ${task.id} 还没有任务包`);
      return { packets: ids, ...restorePacket(workbench.get(p).dir, `${task.id}-a${attempt}`) };
    }],

    // 密封轮次：开一轮（几份同时起草的任务）、查看进度（只有进度，没有内容）、揭晓（只限主持人）
    ['POST', re('/rounds'), async (req, m) => {
      requireHost(req, '开启密封轮次');
      const body = await readJson(req);
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      if (tasks.length < 1) throw new WorkbenchError(400, 'tasks 至少一项');
      for (const id of tasks) {
        const v = visibilityOf(board.get(project(m), id));
        if (VISIBILITY[v].input !== 'stdin') throw new WorkbenchError(400, `任务 ${id} 不是密封类任务`);
      }
      const id = typeof body.id === 'string' && /^[\w-]{1,40}$/.test(body.id) ? body.id : `R-${Date.now().toString(36)}`;
      sealed.open(project(m), id, tasks);
      return sealed.status(project(m), id);
    }],
    ['GET', re('/rounds/([\\w-]{1,40})'), (req, m) => {
      const s = sealed.status(project(m), m[2]);
      if (!s) throw new WorkbenchError(404, `密封轮次 ${m[2]} 不存在`);
      return s;
    }],
    ['POST', re('/rounds/([\\w-]{1,40})/reveal'), (req, m) => {
      requireHost(req, '揭晓密封轮次');
      return runner.reveal(project(m), m[2]);
    }],

    // 主持人确认来源已不存在（gone），或撤销确认（available）。只接受主持人入口
    ['POST', re('/sources/(S\\d{3,6})/availability'), async (req, m) => {
      const actor = actorOf(req);
      if (!actor) throw new WorkbenchError(403, '来源可获取性只能由主持人确认');
      const body = await readJson(req);
      const { record } = gateway.getRecord(project(m), m[2]);
      const r = usage.mark(project(m), m[2], body.state, { by: actor.participant, url: record.url ?? null, note: typeof body.note === 'string' ? body.note.slice(0, 500) : null });
      flow?.poke(project(m)); // gone：对引用它的论断提出“来源不存在”异议；撤销：撤回规则提出的这类异议
      return r;
    }],

    // ---------- WP5a：契约一（核验、异议）与对抗核验 ----------

    // 写一份核验记录：{ target: {id, version}, verdict, reason, support_quote?, source_versions?, request_id? }。
    // 主持人入口记为 human；MCP 会话带 agent，记为未证实（保存但不计入份数）。source_versions 省略时取论断当前所引的来源版本
    ['POST', re('/verifications'), async (req, m) => {
      const body = await readJson(req);
      const actor = writerOf(req, body);
      const p = project(m);
      const claimId = body.target?.id;
      if (typeof claimId !== 'string') throw new WorkbenchError(400, '缺少 target：{ id, version }');
      const { record: claim } = gateway.getRecord(p, claimId);
      const data = {
        target: body.target,
        source_versions: Array.isArray(body.source_versions) ? body.source_versions : (claim.sources || []).map((s) => ({ id: s.id, version: s.version })),
        verdict: body.verdict,
        reason: body.reason,
      };
      if (body.support_quote !== undefined) data.support_quote = body.support_quote;
      return writeNow(p, requestIdOf(body, 'verify'), [{ kind: 'verification', expected_version: 0, data }], actor);
    }],

    // 提出异议：{ target, category, pointer, reason, state: open | needs_evidence, request_id? }
    ['POST', re('/objections'), async (req, m) => {
      const body = await readJson(req);
      const actor = writerOf(req, body);
      const data = { target: body.target, category: body.category, pointer: body.pointer, reason: body.reason, state: body.state ?? 'open' };
      return writeNow(project(m), requestIdOf(body, 'object'), [{ kind: 'objection', expected_version: 0, data }], actor);
    }],

    // 改变异议的状态：{ state, resolution, pointer?, request_id? }。主持人入口；能做哪一步由状态机按身份判断
    // （待你决定的只有主持人能裁决；open 的主持人可以作为核验者裁定；提出者可以撤回）
    ['POST', re('/objections/(O\\d{3,6})/resolve'), async (req, m) => {
      const body = await readJson(req);
      const actor = writerOf(req, body);
      const { record: o } = gateway.getRecord(project(m), m[2]);
      const data = { target: o.target, category: o.category, pointer: body.pointer ?? o.pointer, reason: o.reason, state: body.state };
      if (body.resolution !== undefined) data.resolution = body.resolution;
      else if (o.resolution) data.resolution = o.resolution;
      return writeNow(project(m), requestIdOf(body, 'resolve'), [{ id: o.id, expected_version: o.version, data }], actor);
    }],

    // 对抗核验：为论断的当前版本建核验任务并派发（只限主持人）。{ participants?: [id] }；
    // 不指定时自动挑能计入份数的参与者（与作者不同厂商、可用、还没核验过当前版本），凑够还差的份数
    ['POST', re('/claims/(C\\d{3,6})/verify'), async (req, m) => {
      const host = requireHost(req, '派发对抗核验');
      const body = await readJson(req);
      const p = project(m);
      const { record: claim, status } = gateway.getRecord(p, m[2]);
      const v = status.verification;
      const done = new Set(v.counted.map((id) => actorKey(gateway.getRecord(p, id).record.verifier)));
      const holderOf = (x) => ({ kind: 'server', participant: x.id, adapter: x.adapter, model: x.model ?? null, verified: true });
      const usable = (x) => x.resolved && !eligibility({ ...holderOf(x), vendor: vendorOf(holderOf(x)) }, claim.provenance) && !done.has(actorKey(holderOf(x)));
      let chosen;
      if (Array.isArray(body.participants) && body.participants.length) {
        chosen = [...new Set(body.participants.map(String))];
        // 先全部检查，再建任务：不会建了一半才发现某个参与者不合格
        for (const pid of chosen) {
          const x = participants().find((q) => q.id === pid);
          if (!x) throw new WorkbenchError(404, `参与者 ${pid} 不存在`);
          if (!usable(x)) throw new WorkbenchError(409, `${pid} 不能核验 ${claim.id}：不可用、与作者（${vendorOfActor(claim.provenance)}）同厂商或厂商不明，或已核验过当前版本`);
        }
      } else {
        const need = Math.max(1, v.required - v.independent);
        chosen = participants().filter(usable).slice(0, need).map((x) => x.id);
        if (!chosen.length) throw new WorkbenchError(409, `没有能核验 ${claim.id} 的参与者：需要与作者（${vendorOfActor(claim.provenance)}）不同厂商、可用、还没核验过当前版本`);
      }
      const out = [];
      for (const pid of chosen) {
        const t = board.create(p, { type: 'verify_claim', title: `对抗核验 ${claim.id}@${claim.version}（${pid}）`, goal: `核验论断 ${claim.id} 第 ${claim.version} 版是否被所引来源支持。`, inputs: [{ id: claim.id, version: claim.version }], assigned_to: pid }, { created_by: host });
        try {
          out.push({ ...runner.dispatch(p, t.id, pid), task: taskView(p, board.get(p, t.id)) });
        } catch (e) {
          board.cancel(p, t.id, '规则');
          throw e;
        }
      }
      return { claim: claim.id, version: claim.version, required: v.required, independent: v.independent, dispatched: out };
    }],
  ];
}
