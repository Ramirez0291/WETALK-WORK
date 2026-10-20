// 任务与租约（契约三）。任务状态只由这里（调度程序）改变，每次转换都整体重写 tasks/T###.json（临时文件 ＋ 改名）。
// - 租约防止两人同时做一件事：认领时 attempt 加 1、生成新的 lease_token，租约到期自动释放；
// - 栅栏防止旧执行者迟到：只有“处于 claimed、token 与 attempt 是当前值、租约未过期”的提交才能收稿；
// - request_id 防止重传产生第二个结果（在提交入口实现）。
// 所有公开方法都是同步的：在同一个服务进程里，检查与状态转换之间不会插进别的调用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import { vendorOf } from './vendors.mjs';

export const TASK_STATES = ['proposed', 'open', 'claimed', 'submitted', 'done', 'failed', 'cancelled', 'needs_user'];
const FINAL = new Set(['done', 'failed', 'cancelled']);
const ID_RE = /^T\d{3,6}$/;

// 不在 modes 里、但工坊本身支持的任务类型：匿名评审、观众型读者、导出（WP7），
// 以及契约一的对抗核验（verify_claim）和补证（find_evidence）
export const SPECIAL_TYPES = ['anonymous_review', 'audience_reader', 'export', 'verify_claim', 'find_evidence', 'render_review', 'plan_project'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 整体重写一个 JSON 文件（临时文件 ＋ 改名，Windows 上短暂被占用时同步重试）。竞争的流程记录也用它
export function writeJsonSync(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 1; ; i++) {
    try {
      return fs.renameSync(tmp, file);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 8) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(25 * i); // Windows 上文件被短暂占用：同步地等一下再试，保持整个转换是同步的
    }
  }
}

const bad = (status, msg, details) => Object.assign(new WorkbenchError(status, msg), details ? { details } : {});

// usage：用量账本（预算判断）；onEvent：广播；now：可注入时钟
export function createTaskBoard({ workbench, usage = null, now = () => new Date(), onEvent = () => {} }) {
  const cache = new Map(); // project -> Map<id, task>
  const controllers = new Map(); // `${project}/${id}` -> AbortController（服务自己发起的调用，取消时中止）
  const promoting = new Set(); // `${project}/${id}`：候选稿正在写入正式区，这期间不能取消

  const dirOf = (project) => path.join(workbench.get(project).dir, 'tasks');
  const configOf = (project) => workbench.get(project).config;

  function load(project) {
    if (!cache.has(project)) {
      const m = new Map();
      const dir = dirOf(project);
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          if (!/^T\d+\.json$/.test(name)) continue;
          try {
            const t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (t.id === name.slice(0, -5)) m.set(t.id, t);
          } catch {} // 坏文件：不当任务处理（写入是原子的，正常不会出现）
        }
      }
      cache.set(project, m);
    }
    return cache.get(project);
  }

  // 状态转换先改内存里的对象再落盘；落盘失败时丢掉改了一半的对象，按磁盘上的版本重新读回，
  // 免得内存里是 done、磁盘上还是 submitted
  function save(project, task) {
    const file = path.join(dirOf(project), `${task.id}.json`);
    try {
      writeJsonSync(file, task);
    } catch (e) {
      const m = load(project);
      try {
        m.set(task.id, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        m.delete(task.id); // 还没写成过（新建时失败）
      }
      throw e;
    }
    load(project).set(task.id, task);
    onEvent({ type: 'task', project, id: task.id, state: task.state, attempt: task.attempt });
    return task;
  }

  function get(project, id) {
    if (!ID_RE.test(id)) throw bad(400, `任务编号格式不对：${id}`);
    sweep(project);
    const t = load(project).get(id);
    if (!t) throw bad(404, `任务 ${id} 不存在`);
    return t;
  }

  const iso = () => now().toISOString();
  function transition(project, task, to, reason, extra = {}) {
    const from = task.state;
    task.state = to;
    task.updated_at = iso();
    task.history.push({ at: task.updated_at, from, to, reason, ...extra });
    return save(project, task);
  }

  function overBudget(project) {
    if (!usage) return null;
    const t = usage.totals(project);
    if (t.calls >= t.limits.calls) return `调用次数已到上限（${t.calls}/${t.limits.calls}）`;
    if (t.usd >= t.limits.usd) return `API 费用已到上限（$${t.usd.toFixed(4)}/$${t.limits.usd}）`;
    return null;
  }

  // 一次尝试结束而没有成功：还有尝试次数就回到 open（超预算时进入待你决定），用完就 failed
  function reopenOrFail(project, task, reason) {
    if (task.attempt >= task.max_attempts) return transition(project, task, 'failed', `${reason}；尝试次数已达上限（${task.max_attempts}），不再自动重派`);
    const over = overBudget(project);
    if (over) return transition(project, task, 'needs_user', `${reason}；${over}，重试需要你决定`);
    return transition(project, task, 'open', reason);
  }

  function endAttempt(task, outcome) {
    const a = task.attempts.find((x) => x.n === task.attempt);
    if (a && !a.ended_at) Object.assign(a, { ended_at: iso(), outcome });
    task.holder = null;
    task.lease_token = null;
    task.lease_until = null;
  }

  // 租约到期：当前尝试记为 abandoned，任务回到 open（或 failed / needs_user）
  function sweep(project) {
    const t0 = now().getTime();
    for (const task of load(project).values()) {
      if (task.state === 'claimed' && Date.parse(task.lease_until) <= t0) {
        endAttempt(task, 'abandoned');
        reopenOrFail(project, task, '租约到期未续租，当前尝试记为 abandoned');
      }
    }
  }

  function nextId(project) {
    let max = 0;
    for (const id of load(project).keys()) max = Math.max(max, Number(id.slice(1)));
    const dir = dirOf(project);
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) { const m = n.match(/^T(\d+)\.json/); if (m) max = Math.max(max, Number(m[1])); }
    return `T${String(max + 1).padStart(3, '0')}`;
  }

  // ---------- 新建 / 提议 ----------
  // spec：{ type, title, goal, inputs: [{ id, version } | { blob, name }], depends_on: [T…], parent, assigned_to }
  // created_by：服务端给出的身份（主持人入口、Agent 的提议、规则），不从请求体里取。
  // maxAttempts：只供规则内部使用（补证任务每个只做一次，次数上限按任务数算），不能从接口传入。
  // internal：工坊内部流程附在任务上的字段，同样不能从接口传入——
  //   competition（所属竞争）、sealed_group（同组的密封任务进同一个密封轮次）、division（分工的第几份，提交入口据此检查越界）
  function create(project, spec, { created_by, maxAttempts = null, internal = {} }) {
    const config = configOf(project);
    if (!spec || typeof spec !== 'object') throw bad(400, '任务内容必须是对象');
    const type = spec.type;
    if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(type)) throw bad(400, 'type 必须是小写字母、数字、下划线组成的类型名');
    const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 200) : type;
    const goal = typeof spec.goal === 'string' ? spec.goal.slice(0, 4000) : '';
    const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
    for (const [i, x] of inputs.entries()) {
      const ok = x && typeof x === 'object' && ((typeof x.id === 'string' && Number.isInteger(x.version)) || (typeof x.blob === 'string' && typeof x.name === 'string'));
      if (!ok) throw bad(400, `inputs[${i}] 必须是 {id, version}（正式记录）或 {blob, name}（正文快照等）`);
    }
    // 观众型读者只拿作品（讲稿、大纲、幻灯片记录）；任意 blob 无法确认不含证据，不接受
    if (type === 'audience_reader' && inputs.some((x) => x.blob)) throw bad(400, '观众型读者的输入只能是讲稿、大纲或幻灯片记录，不能直接给 blob');
    // 导出任务（Agent 出版式方案）只由“导出”发起：它要带上导出的设置（格式、模板、skill）
    if (type === 'export' && !internal.export) throw bad(400, '导出任务由“导出”页面发起（POST /export，via 选一位参与者）');
    // 视觉检查任务（模型看截图初查）只由导出详情发起：它要带上那次渲染的页面与截图
    if (type === 'render_review' && !internal.render_review) throw bad(400, '视觉检查任务由导出详情发起（POST /exports/:id/review-request）');
    // 起草项目约定的任务只由“新建项目”向导或首页发起：它要记下起草时约定的版本，草案按那一版合并
    if (type === 'plan_project' && !internal.plan) throw bad(400, '起草项目约定的任务由新建项目向导发起（POST /plan）');
    const depends = Array.isArray(spec.depends_on) ? spec.depends_on : [];
    for (const d of depends) if (!load(project).has(d)) throw bad(400, `依赖的任务 ${d} 不存在`);
    let depth = 0;
    let parent = null;
    if (spec.parent !== undefined && spec.parent !== null) {
      parent = get(project, spec.parent);
      depth = (parent.depth ?? 0) + 1;
    }
    const allowed = [...Object.keys(config.modes), ...SPECIAL_TYPES];
    const at = iso();
    const task = {
      id: nextId(project),
      project,
      type,
      mode: config.modes[type] ?? null,
      title,
      goal,
      inputs,
      depends_on: depends,
      assigned_to: typeof spec.assigned_to === 'string' ? spec.assigned_to : null,
      state: 'proposed',
      attempt: 0,
      max_attempts: Number.isInteger(maxAttempts) && maxAttempts >= 1 ? Math.min(maxAttempts, config.task.maxAttempts) : config.task.maxAttempts,
      holder: null,
      lease_token: null,
      lease_until: null,
      depth,
      parent: parent?.id ?? null,
      created_by: created_by ?? null,
      ...(internal.competition ? { competition: internal.competition } : {}),
      ...(internal.sealed_group ? { sealed_group: internal.sealed_group } : {}),
      ...(internal.division ? { division: internal.division } : {}),
      ...(internal.export ? { export: internal.export } : {}),
      ...(internal.render_review ? { render_review: internal.render_review } : {}),
      ...(internal.plan ? { plan: internal.plan } : {}),
      created_at: at,
      updated_at: at,
      attempts: [],
      result: null,
      history: [{ at, from: null, to: 'proposed', reason: '提出' }],
    };
    // proposed → open：类型在允许列表内、深度与预算未超限；否则进入待你决定
    let why = null;
    if (!allowed.includes(type)) why = `类型 ${type} 不在允许列表内（modes 与 ${SPECIAL_TYPES.join('、')}）`;
    else if (depth > config.task.maxDepth) why = `自动提议的深度 ${depth} 超过上限 ${config.task.maxDepth}`;
    else why = overBudget(project);
    save(project, task);
    return why ? transition(project, task, 'needs_user', why) : transition(project, task, 'open', '类型、深度与预算检查通过');
  }

  // ---------- 认领、续租、释放 ----------
  // holder：服务端给出的身份 { kind: 'server' | 'mcp' | 'human', participant, model?, vendor?, verified, basis }
  function claim(project, id, holder) {
    const task = get(project, id);
    if (task.state !== 'open') throw bad(409, `任务 ${id} 当前是 ${task.state}，不能认领`);
    for (const d of task.depends_on) {
      const dep = load(project).get(d);
      if (dep?.state !== 'done') throw bad(409, `依赖的任务 ${d} 还没完成（${dep?.state ?? '不存在'}）`);
    }
    if (task.assigned_to && holder.participant !== task.assigned_to) throw bad(409, `任务 ${id} 已指派给 ${task.assigned_to}`);
    if (task.attempt >= task.max_attempts) {
      transition(project, task, 'failed', `尝试次数已达上限（${task.max_attempts}）`);
      throw bad(409, `任务 ${id} 尝试次数已达上限`);
    }
    const over = overBudget(project);
    if (over) {
      transition(project, task, 'needs_user', `${over}，新的尝试需要你决定`);
      throw bad(429, `项目已到上限：${over}`);
    }
    const lease = configOf(project).lease.minutes;
    task.attempt += 1;
    task.lease_token = crypto.randomBytes(16).toString('hex');
    task.lease_until = new Date(now().getTime() + lease * 60_000).toISOString();
    task.holder = { ...holder, vendor: holder.vendor ?? vendorOf(holder) };
    task.attempts.push({ n: task.attempt, holder: task.holder, started_at: iso(), ended_at: null, outcome: null, packet: null, sid: null });
    transition(project, task, 'claimed', `${holder.participant ?? holder.kind} 认领第 ${task.attempt} 次尝试`);
    return { task, lease_token: task.lease_token, attempt: task.attempt, lease_until: task.lease_until };
  }

  // 持有凭证：当前 attempt ＋ 当前 lease_token ＋ 租约未过期
  function assertHolder(project, task, { lease_token, attempt }) {
    if (task.state !== 'claimed') throw bad(409, `任务 ${task.id} 当前是 ${task.state}，不在租约中`);
    if (attempt !== task.attempt || lease_token !== task.lease_token) throw bad(409, '租约凭证不是当前值（可能已过期并被别人接手）');
  }

  function renew(project, id, cred) {
    const task = get(project, id); // get 里会先清理过期租约
    assertHolder(project, task, cred);
    task.lease_until = new Date(now().getTime() + configOf(project).lease.minutes * 60_000).toISOString();
    transition(project, task, 'claimed', '续租');
    return { lease_until: task.lease_until };
  }

  function release(project, id, cred, reason = '持有者主动释放') {
    const task = get(project, id);
    assertHolder(project, task, cred);
    endAttempt(task, 'abandoned');
    return reopenOrFail(project, task, `${reason}，当前尝试记为 abandoned`);
  }

  // 任一未完成状态 → cancelled；服务自己发起的调用被中止，之后到达的结果只存历史（栅栏不通过）
  function cancel(project, id, by) {
    const task = get(project, id);
    if (FINAL.has(task.state)) throw bad(409, `任务 ${id} 已是 ${task.state}`);
    if (promoting.has(`${project}/${id}`)) throw bad(409, `任务 ${id} 的候选稿正在写入正式区，写完后再处理`);
    if (task.state === 'claimed') endAttempt(task, 'cancelled');
    controllers.get(`${project}/${id}`)?.abort(new Error('任务已取消'));
    return transition(project, task, 'cancelled', `由 ${by ?? '规则'} 取消`);
  }

  // 待你决定：needs_user → open 或 cancelled；提高上限后重开等
  function decide(project, id, to, by) {
    const task = get(project, id);
    if (task.state !== 'needs_user') throw bad(409, `任务 ${id} 当前是 ${task.state}，不在“待你决定”`);
    if (!['open', 'cancelled'].includes(to)) throw bad(400, '只能决定为 open 或 cancelled');
    if (to === 'open') {
      const over = overBudget(project);
      if (over) throw bad(429, `${over}：先在 protocol.json 里提高上限再重开`);
      if (task.depth > configOf(project).task.maxDepth) throw bad(409, `深度 ${task.depth} 仍超过上限，先提高 task.maxDepth`);
      const allowed = [...Object.keys(configOf(project).modes), ...SPECIAL_TYPES];
      if (!allowed.includes(task.type)) throw bad(409, `类型 ${task.type} 仍不在允许列表内，先在 modes 里加上`);
    }
    return transition(project, task, to, `由 ${by} 决定`);
  }

  // ---------- 栅栏与提交入口的回调（作为提交入口的 fence） ----------

  const fence = {
    check(project, { task_id, attempt, lease_token }) {
      let task;
      try {
        task = get(project, task_id);
      } catch (e) {
        if (e.status === 404 || e.status === 400) return { notFound: true };
        throw e;
      }
      const reasons = [];
      if (task.state !== 'claimed') reasons.push(`任务处于 ${task.state}`);
      if (attempt !== task.attempt) reasons.push(`尝试号 ${attempt} 不是当前的 ${task.attempt}`);
      if (lease_token !== task.lease_token) reasons.push('租约凭证不是当前值');
      if (task.lease_until && Date.parse(task.lease_until) <= now().getTime()) reasons.push('租约已过期');
      // 身份按“提交所声称的那次尝试”派生；凭证不对时那次尝试的持有者也只作记录，不作证实
      const claimed = task.attempts.find((a) => a.n === attempt);
      const holder = claimed ? identityOf(claimed) : null;
      const provenance = holder
        ? { ...holder, verified: reasons.length ? false : holder.verified, task_attempt_holder: true }
        : { kind: 'unknown', verified: false, basis: 'fence-failed' };
      return reasons.length ? { ok: false, reason: reasons.join('；'), provenance } : { ok: true, provenance };
    },
    // 收稿成功（栅栏已通过）：claimed → submitted
    onReceived(project, task_id, sid) {
      const task = get(project, task_id);
      const a = task.attempts.find((x) => x.n === task.attempt);
      if (a) a.sid = sid;
      task.lease_until = null; // 已交稿，不再需要续租
      return transition(project, task, 'submitted', `收稿：候选稿 ${sid}`);
    },
    // 晋升前（在提交入口的队列里）再查一次：任务仍是已交稿、候选稿就是当前尝试交的那份。
    // 收稿之后、排队晋升之前任务可能被取消或重开，这时候选稿不再晋升。返回不能晋升的原因，可以晋升时返回 null
    promotable(project, task_id, { attempt, sid }) {
      let task;
      try {
        task = get(project, task_id);
      } catch (e) {
        if (e.status === 404 || e.status === 400) return `任务 ${task_id} 不存在`;
        throw e;
      }
      if (task.state !== 'submitted') return `任务 ${task_id} 当前是 ${task.state}`;
      if (attempt !== task.attempt) return `候选稿属于第 ${attempt} 次尝试，任务当前是第 ${task.attempt} 次`;
      if (task.attempts.find((a) => a.n === task.attempt)?.sid !== sid) return `候选稿 ${sid} 不是当前尝试交的稿`;
      return null;
    },
    // 从检查通过到写完（或失败）这段时间，任务不能被取消；返回解除函数
    holdPromotion(project, task_id) {
      const key = `${project}/${task_id}`;
      promoting.add(key);
      return () => promoting.delete(key);
    },
    onPromoted(project, task_id, { cid, records }) {
      const task = get(project, task_id);
      if (task.state !== 'submitted') return task;
      endAttempt(task, 'done');
      task.result = { cid, records };
      return transition(project, task, 'done', `晋升成功：提交 ${cid}`);
    },
    // 分工的子任务：只能写自己那一份的范围（提交入口在晋升时检查）；不是分工任务返回 null
    scopeOf(project, task_id) {
      let task;
      try {
        task = get(project, task_id);
      } catch {
        return null;
      }
      return task.division ? { division: task.division, inputs: task.inputs.filter((i) => i.id) } : null;
    },
    // 视觉检查任务（WP7b）：这次要看的导出版本、渲染与每页截图；不是视觉检查任务返回 null（提交入口据此核对初查记录）
    renderReviewOf(project, task_id) {
      try {
        return get(project, task_id).render_review ?? null;
      } catch {
        return null;
      }
    },
    onPromoteFailed(project, task_id, reasons) {
      const task = get(project, task_id);
      if (task.state !== 'submitted') return task;
      endAttempt(task, 'promote_failed');
      // 版本过期类的原因要基于新版本重做；其余（越界、引文找不到等）是结果本身不合规则
      const stale = reasons.every((r) => ['version_conflict', 'stale_dependency', 'missing_dependency', 'external_change', 'external_dependency'].includes(r.type));
      return reopenOrFail(project, task, `晋升失败（${[...new Set(reasons.map((r) => r.type))].join('、')}），${stale ? '需要基于新版本重做' : '结果不合规则，需要重做'}`);
    },
  };

  // 这次尝试的身份：认领时的持有者；服务自己发起的调用若报告了实际模型，厂商以报告为准，
  // 与配置不一致时保留两者（vendor_conflict），作者与核验者两侧都用这同一个依据
  function identityOf(a) {
    const h = a.holder;
    const rv = a.reported?.vendor;
    if (!rv || rv === 'unknown') return h;
    const conflict = h.vendor && h.vendor !== 'unknown' && h.vendor !== rv;
    return { ...h, vendor: rv, reported_model: a.reported.model ?? null, ...(conflict ? { configured_vendor: h.vendor, vendor_conflict: true } : {}) };
  }

  // 某次尝试的身份（同上），供竞争选定方案时按起草那次尝试写内容来源
  function identityOfAttempt(project, id, n) {
    const a = get(project, id).attempts.find((x) => x.n === n);
    if (!a) throw bad(404, `任务 ${id} 没有第 ${n} 次尝试`);
    return identityOf(a);
  }

  // 记下服务自己发起的这次调用实际报告的模型与厂商（收稿之前调用）。凭证不是当前值时不记
  function noteReported(project, id, cred, reported) {
    const task = get(project, id);
    if (task.state !== 'claimed' || task.attempt !== cred.attempt || task.lease_token !== cred.lease_token) return null;
    const a = task.attempts.find((x) => x.n === task.attempt);
    if (!a || !reported) return null;
    a.reported = { model: reported.model ?? null, vendor: reported.vendor ?? null };
    return save(project, task);
  }

  // 服务自己发起的调用：登记 AbortController，取消任务时中止
  function track(project, id, controller) {
    const key = `${project}/${id}`;
    controllers.set(key, controller);
    return () => controllers.get(key) === controller && controllers.delete(key);
  }

  // 记下这次尝试实际用的任务包
  function attachPacket(project, id, attempt, packetId) {
    const task = get(project, id);
    const a = task.attempts.find((x) => x.n === attempt);
    if (!a) throw bad(404, `任务 ${id} 没有第 ${attempt} 次尝试`);
    a.packet = packetId;
    return save(project, task);
  }

  // 只结束尝试、不回到 open 的场合（例如调用失败、结果解析失败）
  function failAttempt(project, id, cred, reason) {
    const task = get(project, id);
    if (task.state !== 'claimed' || task.attempt !== cred.attempt || task.lease_token !== cred.lease_token) return task;
    endAttempt(task, 'error');
    return reopenOrFail(project, task, reason);
  }

  // 密封类任务：调用完成，结果只在内存里的密封轮次中。claimed → submitted，不写任何内容
  // 凭证不是当前值（租约已过期、任务已被接手或取消）时返回 null：迟到的结果不能进密封轮次
  function markSealed(project, id, cred, roundId, unproven) {
    const task = get(project, id);
    if (task.state !== 'claimed' || task.attempt !== cred.attempt || task.lease_token !== cred.lease_token) return null;
    const a = task.attempts.find((x) => x.n === task.attempt);
    if (a) Object.assign(a, { sealed_round: roundId, independence: unproven ? 'unproven' : 'clean' });
    task.lease_until = null;
    return transition(project, task, 'submitted', `密封结果已收集（轮次 ${roundId}），揭晓前只在服务进程内存里`);
  }

  // 揭晓后：submitted → done，结果只记 blob 与独立性结论
  function completeSealed(project, id, result) {
    const task = get(project, id);
    if (task.state !== 'submitted') throw bad(409, `任务 ${id} 当前是 ${task.state}，不能完成揭晓`);
    endAttempt(task, 'done');
    task.result = result;
    return transition(project, task, 'done', `揭晓${result.independence === 'unproven' ? '（独立性未证明，不参与本轮比较）' : ''}`);
  }

  // 结果不进正式区的任务（导出的版式方案）：凭证仍是当前值时 claimed → done，结果只记在任务上。
  // 凭证已过期（任务被接手、取消）时返回 null，迟到的结果丢弃
  function completeDirect(project, id, cred, result, reason) {
    const task = get(project, id);
    if (task.state !== 'claimed' || task.attempt !== cred.attempt || task.lease_token !== cred.lease_token) return null;
    endAttempt(task, 'done');
    task.result = result;
    task.lease_until = null;
    return transition(project, task, 'done', reason);
  }

  // 服务重启：服务自己拉起的调用已不存在，这些尝试记为 abandoned；MCP 外部会话的租约保持到期为止。
  // 密封结果只在内存里，重启后已经没有了：这些任务本轮重跑
  function recover(project) {
    const released = [];
    for (const task of load(project).values()) {
      const a = task.attempts.find((x) => x.n === task.attempt);
      if (task.state === 'submitted' && a?.sealed_round && !task.result) {
        endAttempt(task, 'abandoned');
        reopenOrFail(project, task, '服务重启，揭晓前的密封结果已随进程消失，本轮重跑');
        released.push(task.id);
        continue;
      }
      if (task.state === 'claimed' && task.holder?.kind === 'server') {
        endAttempt(task, 'abandoned');
        reopenOrFail(project, task, '服务重启，服务自己发起的调用已不存在');
        released.push(task.id);
      }
    }
    sweep(project);
    return released;
  }

  function list(project, { state } = {}) {
    sweep(project);
    return [...load(project).values()].filter((t) => !state || t.state === state).sort((a, b) => a.id.localeCompare(b.id));
  }

  // 每个任务实际用掉的调用与费用，从用量账本里按任务号汇总
  function budgetUsed(project, id) {
    if (!usage) return { calls: 0, usd: 0 };
    const mine = usage.entries(project).filter((e) => e.task === id);
    return { calls: mine.length, usd: mine.reduce((s, e) => s + (e.usd || 0), 0) };
  }

  return { create, get, list, claim, renew, release, cancel, decide, fence, track, attachPacket, noteReported, identityOfAttempt, failAttempt, markSealed, completeSealed, completeDirect, recover, sweep, budgetUsed, overBudget, FINAL };
}
