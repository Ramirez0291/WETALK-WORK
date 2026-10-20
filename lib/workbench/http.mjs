// 工坊的 HTTP 路由。和 server.mjs 里的路由同一格式：[method, 正则, handler(req, match)]。
// 错误一律抛出带 status 的异常（可附 details），由 server.mjs 统一回复。
import { WorkbenchError } from './project.mjs';
import { KINDS } from './records.mjs';
import { restorePacket, listPackets } from './packets.mjs';
import { visibilityOf, VISIBILITY } from './visibility.mjs';
import { vendorOf } from './vendors.mjs';
import { eligibility, vendorOfActor, actorKey, authorsOf } from './verify.mjs';
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

// 待你决定：各模块的事项合在一起（接口和交接单都用这一份）
export function inboxItems({ gateway, board = null, usage = null, competitions = null, scheduler = null }, p) {
  const items = gateway.inbox(p);
  // 任务：失败（不再自动重派）与待你决定
  if (board) for (const t of board.list(p)) {
    if (t.state === 'failed' || t.state === 'needs_user') items.push({ type: `task_${t.state}`, project: p, task: t.id, title: t.title, reason: t.history.at(-1)?.reason ?? null });
  }
  // 契约一：待你裁决的异议、核验结论不一致的论断
  for (const { record: r } of gateway.listRecords(p, 'objection')) {
    if (r.state === 'needs_user') items.push({ type: 'objection_needs_user', project: p, objection: r.id, target: r.target, category: r.category, resolution: r.resolution ?? null });
  }
  for (const { record: r, status } of gateway.listRecords(p, 'claim')) {
    if (status.verification?.state === 'disputed') items.push({ type: 'claim_disputed', project: p, claim: r.id, counted: status.verification.counted });
  }
  // 竞争：每一步需要你做的事（揭晓、发起评审、选定、接受或拒绝补丁、应用）
  if (competitions) items.push(...competitions.inbox(p));
  // 调度：连续停滞要你决定、派发时到了上限
  if (scheduler) items.push(...scheduler.inbox(p));
  // 用量到达上限：新调用和重试都会被拒，需要你决定是否提高上限
  if (usage) {
    const t = usage.totals(p);
    if (t.calls >= t.limits.calls || t.usd >= t.limits.usd) items.push({ type: 'budget_exceeded', project: p, ...t });
  }
  return items;
}

// 接口返回这种对象时，服务端按文件发送（导出的 PPTX、Markdown、PDF、页面图片），不当 JSON
export const FILE_RESPONSE = Symbol('file-response');

export function workbenchRoutes({ workbench, gateway, web, usage, board, runner, sealed, flow = null, competitions = null, divisions = null, scheduler = null, exports = null, report = null, readJson, hostToken, humanName, participantByName = () => null, participants = () => [] }) {
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
  const K = '/competitions/(K\\d{3,6})';

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

    ['GET', re('/inbox'), (req, m) => inboxItems({ gateway, board, usage, competitions, scheduler }, project(m))],

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
      const p = project(m);
      const requestId = requestIdOf(body, 'resolve');
      const { record: o } = gateway.getRecord(p, m[2]);
      // 同一个 request_id 的重试：沿用第一次收稿时的 expected_version。内容相同就返回第一次的结果，内容不同照样冲突
      // 补齐不变的字段时用的“基准”：第一次请求时构造的内容（重试），或异议的当前版本（第一次）
      const first = gateway.priorRequest(p, requestId)?.changes?.[0];
      const base = first?.id === o.id ? first.data : o;
      const expected = first?.id === o.id ? first.expected_version : o.version;
      const data = { target: base.target, category: base.category, pointer: body.pointer ?? base.pointer, reason: base.reason, state: body.state };
      const resolution = body.resolution ?? base.resolution;
      if (resolution !== undefined) data.resolution = resolution;
      return writeNow(p, requestId, [{ id: o.id, expected_version: expected, data }], actor);
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
      const authors = authorsOf(claim);
      const authorText = authors.map((a) => `${a.participant}/${vendorOfActor(a)}`).join('、');
      const usable = (x) => x.resolved && !eligibility({ ...holderOf(x), vendor: vendorOf(holderOf(x)) }, authors) && !done.has(actorKey(holderOf(x)));
      let chosen;
      if (Array.isArray(body.participants) && body.participants.length) {
        chosen = [...new Set(body.participants.map(String))];
        // 先全部检查，再建任务：不会建了一半才发现某个参与者不合格
        for (const pid of chosen) {
          const x = participants().find((q) => q.id === pid);
          if (!x) throw new WorkbenchError(404, `参与者 ${pid} 不存在`);
          if (!usable(x)) throw new WorkbenchError(409, `${pid} 不能核验 ${claim.id}：不可用、是作者或与作者（${authorText}）同厂商、厂商不明，或已核验过当前版本`);
        }
      } else {
        const need = Math.max(1, v.required - v.independent);
        chosen = participants().filter(usable).slice(0, need).map((x) => x.id);
        if (!chosen.length) throw new WorkbenchError(409, `没有能核验 ${claim.id} 的参与者：需要与每一位作者（${authorText}）不同厂商、可用、还没核验过当前版本`);
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

    // ---------- WP5b：分工、竞争 ----------

    // 分工：{ type, title, goal, inputs: [{id, version}], items: [文本], participants: [id…], assignments? }（只限主持人）。
    // 拆成互不重叠的几份，每份一个子任务并派发
    ['GET', re('/divisions'), (req, m) => divisions.list(project(m))],
    ['POST', re('/divide'), async (req, m) => {
      const host = requireHost(req, '发起分工');
      return divisions.create(project(m), await readJson(req), host);
    }],

    // 竞争：{ type, title, goal, inputs: [{id, version}], participants: [id…], kind? }（只限主持人）
    ['GET', re('/competitions'), (req, m) => competitions.list(project(m))],
    ['POST', re('/compete'), async (req, m) => {
      const host = requireHost(req, '发起竞争');
      return competitions.create(project(m), await readJson(req), host);
    }],
    ['GET', re(K), (req, m) => competitions.view(project(m), m[2])],
    // 揭晓当前这一步（方案或评审）的密封轮次；重新派发还没开始的成员
    ['POST', re(`${K}/reveal`), (req, m) => {
      requireHost(req, '揭晓');
      return competitions.reveal(project(m), m[2]);
    }],
    ['POST', re(`${K}/dispatch`), (req, m) => {
      requireHost(req, '派发');
      return competitions.redispatch(project(m), m[2]);
    }],
    // 匿名评审：{ reviewers: [id…] }
    ['POST', re(`${K}/review`), async (req, m) => {
      const host = requireHost(req, '发起匿名评审');
      return competitions.review(project(m), m[2], await readJson(req), host);
    }],
    // 选定：{ label, reason }
    ['POST', re(`${K}/select`), async (req, m) => {
      const host = requireHost(req, '选定方案');
      return competitions.select(project(m), m[2], await readJson(req), host);
    }],
    // 移植补丁：{ from: { draft, section, quote? }, to: { section, position }, note?, comment? }。主持人或 MCP 会话（带 agent）都可以提出
    ['POST', re(`${K}/patches`), async (req, m) => {
      const body = await readJson(req);
      return competitions.propose(project(m), m[2], body, writerOf(req, body));
    }],
    // 接受或拒绝：{ decision: accept | reject, reason }（只限主持人）
    ['POST', re(`${K}/patches/(P\\d{1,4})/decide`), async (req, m) => {
      const host = requireHost(req, '接受或拒绝移植补丁');
      return competitions.decide(project(m), m[2], m[3], await readJson(req), host);
    }],
    // 书记：应用全部已接受的补丁，写成作品的新版本
    ['POST', re(`${K}/apply`), (req, m) => competitions.apply(project(m), m[2], requireHost(req, '让书记应用补丁'))],
    ['POST', re(`${K}/close`), (req, m) => competitions.close(project(m), m[2], requireHost(req, '结束竞争'))],
    ['POST', re(`${K}/cancel`), async (req, m) => {
      const host = requireHost(req, '取消竞争');
      const body = await readJson(req);
      return competitions.cancel(project(m), m[2], host, typeof body.reason === 'string' ? body.reason.slice(0, 500) : null);
    }],

    // ---------- WP6：调度与阶段 ----------

    // 调度状态：自动调度开关、当前阶段、进行中的轮与最近几轮的结论、冷却中的参与者
    ['GET', re('/scheduler'), (req, m) => scheduler.state(project(m))],
    // 自动调度开关：{ on }（只限主持人；默认关）
    ['POST', re('/scheduler/auto'), async (req, m) => {
      const host = requireHost(req, '开关自动调度');
      return scheduler.setAuto(project(m), (await readJson(req)).on === true, host.participant);
    }],
    // 跑一轮：把当前已就绪的任务派一次（只限主持人）
    ['POST', re('/scheduler/run'), (req, m) => scheduler.runOnce(project(m), requireHost(req, '跑一轮').participant)],
    // 切换阶段：{ to }（只限主持人）。生成交接单；旧阶段的工作记忆先归档再清空，新阶段换记忆空间
    ['POST', re('/phase'), async (req, m) => {
      const host = requireHost(req, '切换阶段');
      return scheduler.switchPhase(project(m), String((await readJson(req)).to ?? ''), host.participant);
    }],
    ['GET', re('/handoffs/(H\\d{3,6})'), (req, m) => ({ id: m[2], text: scheduler.handoff(project(m), m[2]) })],

    // ---------- WP7：导出与成品检查 ----------

    // 导出列表、进行中的导出任务、可选的模板与 skill
    ['GET', re('/exports'), (req, m) => exports.list(project(m))],
    // 导出：{ formats, via（script 或参与者 id）, template, skill }，不写的按项目配置（只限主持人）
    ['POST', re('/export'), async (req, m) => {
      const host = requireHost(req, '导出');
      return exports.create(project(m), await readJson(req), host.participant);
    }],
    // 按 Agent 交的版式方案再生成一次（上次生成失败时）
    ['POST', re('/exports/tasks/(T\\d{3,6})/build'), async (req, m) => {
      requireHost(req, '按版式方案生成');
      const r = await exports.onTaskDone(project(m), m[2]);
      if (!r) throw new WorkbenchError(409, `${m[2]} 不是已完成、还没生成的导出任务`);
      return r;
    }],
    ['GET', re('/exports/(EX\\d{3,6})'), (req, m) => exports.view(project(m), m[2])],
    // 渲染检查：PowerPoint 转 PDF 与逐页图片，程序查溢出、重叠、字体、图片变形（只限主持人）
    ['POST', re('/exports/(EX\\d{3,6})/render'), (req, m) => exports.render(project(m), m[2], requireHost(req, '渲染检查').participant)],
    ['GET', re('/exports/(EX\\d{3,6})/files/(.+)'), (req, m) => ({ [FILE_RESPONSE]: true, ...exports.file(project(m), m[2], decode(m[3], '文件名')) })],
    // 逐页的视觉检查（WP7b）：派一位能看图的参与者初查（只限主持人）；主持人终审一页
    ['POST', re('/exports/(EX\\d{3,6})/review-request'), async (req, m) => {
      const host = requireHost(req, '派视觉检查');
      return exports.requestReview(project(m), m[2], String((await readJson(req)).participant ?? ''), host);
    }],
    ['POST', re('/exports/(EX\\d{3,6})/pages/(\\d{1,3})/review'), async (req, m) => {
      const host = requireHost(req, '终审');
      return exports.finalReview(project(m), m[2], Number(m[3]), await readJson(req), host);
    }],

    // 试运行报告（WP7b）：与单 Agent 基线逐项对比；你填的数值（修改时间、抽查发现的实质错误）只限主持人写
    ['GET', re('/report'), (req, m) => report.build(project(m))],
    ['POST', re('/report/manual'), async (req, m) => {
      const host = requireHost(req, '填写试运行报告');
      return report.setManual(project(m), await readJson(req), host.participant);
    }],
    ['GET', re('/report\\.md'), (req, m) => ({ [FILE_RESPONSE]: true, ...report.markdownFile(project(m)) })],
  ];
}
