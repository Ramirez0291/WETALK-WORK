// 竞争（WP5b）：密封起草 → 揭晓 → 匿名评审（每条意见指向具体的节、页或论断编号，指不到的退回）→ 你选定一份 →
// 落选方案里值得保留的内容写成移植补丁，逐条接受或拒绝 → 书记（规则）只应用已接受的补丁。表决选择以后再接。
//
// - 流程记录存在 <项目>/competitions/K###.json，和任务一样由服务进程整体重写、不进 git；
//   每一步（发起、评审、选定、补丁的提出与接受或拒绝、书记应用、结束）都记在 history 里。
// - 选定的方案经提交入口写成正式作品，内容来源是起草那次尝试的身份（不是选定它的你）；
//   书记写的每一版，内容来源是规则（workbench-scribe），作者集合并上搬来原文的起草者。
// - 书记只在自己上次写的版本上继续：作品在竞争之外被改过，书记不覆盖，返回冲突。
// - 少数意见记录：被拒的补丁（含理由）、没被任何已接受补丁采纳的评审意见，以及落选方案原文（blob）。
// - 标签（方案甲、方案乙……）在方案全部揭晓后由这里统一分配，几位评审看到的一致；标签与起草者的对应关系
//   在评审全部结束之前不出现在竞争的接口里（评审拿到的只有标签和去掉署名的正文）。
// - 作品引用的论断：发起时按输入快照固定“可引用论断”（输入里的论断，以及输入作品里引用的论断，版本按输入）；
//   作品正文里的论断编号按它绑定版本，对不上的明确拒绝，不静默省略。
// - 先记下、再提交、后补记：选定与书记先把要做的事记进竞争记录（pending），再经提交入口晋升，晋升后补记结果。
//   补记没写成（进程中断、磁盘写失败）时，下一次读取按提交入口的结果补齐；结果还确认不了时，只允许原样重试。
//   这些候选稿只能由竞争自己晋升（owner），候选稿页面不能替它晋升。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import { writeJsonSync } from './tasks.mjs';
import { LABELS } from './visibility.mjs';
import { blobStore, WORK_KINDS, sha256 } from './records.mjs';
import { actorSummary } from './verify.mjs';
import { parseReview, sectionsOf, bindClaims, checkPatch, patchConflict, patchContent, applyPatches, PATCH_POSITIONS } from './modes.mjs';

export const SCRIBE_ACTOR = { kind: 'system', participant: 'workbench-scribe', verified: true, basis: 'rule' };

// 竞争产出的作品种类：选题角度、大纲写成大纲；核心解释写成讲稿。发起时可以另指定
const KIND_OF_TYPE = { outline: 'outline', angle: 'outline', core_explanation: 'script' };

export const STAGE_LABEL = {
  drafting: '密封起草中', insufficient: '有效方案不足两份', review_ready: '待发起匿名评审', reviewing: '匿名评审中',
  selecting: '待你选定', patching: '移植补丁', closed: '已结束', cancelled: '已取消',
};

const ID_RE = /^K\d{3,6}$/;
const bad = (status, msg, details) => Object.assign(new WorkbenchError(status, msg), details ? { details } : {});
const str = (v, field, max, required = true) => {
  if (v == null || v === '') {
    if (required) throw bad(400, `缺少 ${field}`);
    return null;
  }
  if (typeof v !== 'string') throw bad(400, `${field} 必须是字符串`);
  if (required && !v.trim()) throw bad(400, `${field} 不能为空`);
  if (v.length > max) throw bad(400, `${field} 超过 ${max} 字`);
  return v.trim();
};

// participants(id)：参与者配置（含 resolved）
export function createCompetitions({ workbench, gateway, board, runner, participants, now = () => new Date(), onEvent = () => {} }) {
  const FINAL = board.FINAL;
  const iso = () => now().toISOString();
  const dirOf = (project) => path.join(workbench.get(project).dir, 'competitions');
  const fileOf = (project, id) => path.join(dirOf(project), `${id}.json`);

  // 同一个竞争的改动逐个执行（选定、书记要等提交入口晋升），免得两次请求交错、后写的盖掉先写的
  const locks = new Map();
  function serial(project, id, fn) {
    const key = `${project}/${id}`;
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }

  function list(project) {
    const dir = dirOf(project);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => /^K\d+\.json$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
  }

  function get(project, id) {
    if (!ID_RE.test(id)) throw bad(400, `竞争编号格式不对：${id}`);
    const file = fileOf(project, id);
    if (!fs.existsSync(file)) throw bad(404, `竞争 ${id} 不存在`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // ---------- 先记下、再提交、后补记 ----------
  const owner = (id) => `competition:${id}`;
  const inflight = new Set(); // 正在提交的竞争（本进程里），这期间不判定它的 pending
  function finishSelect(comp, p, result) {
    const record = result.records[0];
    comp.selection = { label: p.label, task: p.task, participant: comp.drafts.find((d) => d.task === p.task)?.participant ?? null, by: p.by, at: p.at, reason: p.reason, record, cid: result.cid };
    comp.applied = { version: record.version, patches: [] };
    comp.history.push({ at: iso(), by: p.by, action: 'select', label: p.label, task: p.task, record, reason: p.reason });
  }
  function finishApply(comp, p, result) {
    const version = result.records[0].version;
    for (const x of comp.patches) if (p.patches.includes(x.id) && !x.applied) x.applied = { version, cid: result.cid };
    comp.applied = { version, patches: p.patches };
    comp.history.push({ at: iso(), by: SCRIBE_ACTOR.participant, action: 'apply', requested_by: p.by, record: { id: comp.selection.record.id, version }, patches: p.patches });
  }
  // 补齐 pending：提交入口已经晋升了就按结果补记；确定没有晋升（没收稿或晋升被拒）就撤掉；
  // 还确认不了（收了稿却没有晋升结果，例如写入故障待重启恢复）就留着，只允许原样重试
  function settle(project, comp) {
    const p = comp.pending;
    if (!p || inflight.has(`${project}/${comp.id}`)) return comp;
    const out = gateway.requestOutcome(project, p.request_id);
    if (out.state === 'unknown') return comp;
    if (out.state === 'applied') (p.action === 'select' ? finishSelect : finishApply)(comp, p, out);
    else comp.history.push({ at: iso(), action: 'pending_dropped', pending: p.action, request_id: p.request_id, outcome: out.state });
    delete comp.pending;
    save(project, comp);
    return comp;
  }
  const load = (project, id) => settle(project, get(project, id));
  // 列表与待你决定：补齐时写盘失败不影响整页，照原样显示
  const settleQuiet = (project, comp) => {
    try {
      return settle(project, comp);
    } catch {
      return comp;
    }
  };
  function assertNoPending(comp, requestId = null) {
    if (comp.pending && comp.pending.request_id !== requestId) {
      throw bad(409, `上一个操作（${comp.pending.action === 'select' ? '选定' : '书记应用补丁'}）的结果还没确认：只能原样重试它，或等服务重启恢复后再操作`, { pending: comp.pending });
    }
  }
  // 先把 pending 写进竞争记录，再收稿、晋升；无论成败都按提交入口的结果收尾
  async function commitPending(project, id, comp, pending, change, opts) {
    comp.pending = pending;
    save(project, comp);
    const key = `${project}/${id}`;
    inflight.add(key);
    let error = null;
    try {
      const receipt = gateway.receive(project, { request_id: pending.request_id, changes: [change] }, { ...opts, owner: owner(id) });
      await gateway.promote(project, receipt.sid, { owner: owner(id) });
    } catch (e) {
      error = e;
    } finally {
      inflight.delete(key);
    }
    settle(project, get(project, id));
    if (error) throw error;
    return view(project, id);
  }

  function save(project, comp) {
    comp.updated_at = iso();
    writeJsonSync(fileOf(project, comp.id), comp);
    onEvent({ type: 'competition', project, id: comp.id, stage: stageOf(project, comp) }); // 事件里不带任何正文
    return comp;
  }

  function nextId(project) {
    let max = 0;
    const dir = dirOf(project);
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) { const m = n.match(/^K(\d+)\.json$/); if (m) max = Math.max(max, Number(m[1])); }
    return `K${String(max + 1).padStart(3, '0')}`;
  }

  const blobs = (project) => blobStore(workbench.get(project).dir);
  const textOfTask = (project, taskId) => {
    const t = board.get(project, taskId);
    return t.result?.text_blob ? blobs(project).get(t.result.text_blob).toString('utf8') : null;
  };

  // 每份方案的状况：只有揭晓（任务完成）之后才有正文；独立性未证明的方案不参与比较
  function draftState(project, comp) {
    return comp.drafts.map((d) => {
      const t = board.get(project, d.task);
      const eligible = t.state === 'done' && !!t.result?.text_blob && t.result.independence !== 'unproven';
      return { task: d.task, participant: d.participant, state: t.state, eligible, independence: t.result?.independence ?? null, round: t.attempts.find((a) => a.n === t.attempt)?.sealed_round ?? null };
    });
  }

  const reviewTasks = (project, comp) => comp.reviews.flatMap((r) => r.tasks.map((id) => board.get(project, id)));

  function stageOf(project, comp) {
    if (comp.cancelled) return 'cancelled';
    if (comp.closed) return 'closed';
    if (comp.selection) return 'patching';
    const drafts = draftState(project, comp);
    if (drafts.some((d) => !FINAL.has(d.state))) return 'drafting';
    if (drafts.filter((d) => d.eligible).length < 2) return 'insufficient';
    const reviews = reviewTasks(project, comp);
    if (reviews.some((t) => !FINAL.has(t.state))) return 'reviewing';
    // 没有评审，或评审全部失败、取消：可以（再）发起一轮
    if (!reviews.some((t) => t.state === 'done')) return 'review_ready';
    return 'selecting';
  }

  const labelTexts = (project, comp) => Object.fromEntries(Object.entries(comp.labels ?? {}).map(([label, task]) => [label, textOfTask(project, task)]));
  const winnerText = (project, comp) => textOfTask(project, comp.selection.task);
  const losingTexts = (project, comp) => {
    const all = labelTexts(project, comp);
    delete all[comp.selection.label];
    return all;
  };

  // 评审一轮全部结束后，把意见解析出来并固定下来：指不到具体位置的退回（保留原文与原因）。
  // 独立性未证明（执行过工具）的评审整份退回，不参与比较
  function sync(project, comp) {
    let changed = false;
    // 方案全部揭晓（任务都结束）后随机分配标签：之后界面按标签显示方案，评审也用同一套标签；对应关系评审结束后才公开
    if (!comp.labels && !comp.cancelled) {
      const drafts = draftState(project, comp);
      if (drafts.every((d) => FINAL.has(d.state)) && drafts.filter((d) => d.eligible).length >= 2) {
        const order = drafts.filter((d) => d.eligible).map((d) => ({ d, k: crypto.randomInt(1 << 30) })).sort((a, b) => a.k - b.k);
        comp.labels = Object.fromEntries(order.map((x, i) => [LABELS[i], x.d.task]));
        changed = true;
      }
    }
    for (const r of comp.reviews) {
      if (r.comments) continue;
      const tasks = r.tasks.map((id) => board.get(project, id));
      if (tasks.some((t) => !FINAL.has(t.state))) continue;
      const drafts = labelTexts(project, comp);
      const claimExists = (id) => {
        try {
          return gateway.getRecord(project, id).kind === 'claim';
        } catch {
          return false;
        }
      };
      r.comments = [];
      r.returned = [];
      for (const t of tasks) {
        if (t.state !== 'done' || !t.result?.text_blob) continue;
        if (t.result.independence === 'unproven') {
          r.returned.push({ task: t.id, text: '（整份评审）', reason: '评审的独立性未证明（调用里执行过工具），不参与比较' });
          continue;
        }
        const raw = blobs(project).get(t.result.text_blob).toString('utf8');
        const { comments, returned } = parseReview(raw, { drafts, claimExists });
        for (const c of comments) r.comments.push({ id: `${r.n}.${r.comments.length + 1}`, task: t.id, ...c });
        for (const x of returned) r.returned.push({ task: t.id, ...x });
      }
      r.frozen_at = iso();
      changed = true;
    }
    if (changed) save(project, comp);
    return comp;
  }

  const allComments = (comp) => comp.reviews.flatMap((r) => r.comments ?? []);
  // 可引用论断：发起时按输入固定（早期没有记下的，退回到输入里直接给的论断）
  const citableOf = (comp) => comp.citable ?? comp.inputs.filter((x) => /^C\d/.test(x.id));
  const citableText = (comp) => citableOf(comp).map((c) => `${c.id}@${c.version}`).join('、') || '输入里没有论断';

  function checkParticipant(id, what) {
    const p = participants(id);
    if (!p) throw bad(404, `参与者 ${id} 不存在`);
    if (!p.resolved) throw bad(409, `${what} ${p.name ?? id} 不可用（找不到命令或没有密钥）`);
    return p;
  }

  // 建了任务之后竞争记录没写成：把刚建的任务取消，不留下竞争不知道的任务
  function saveOrCancel(project, comp, tasks, host) {
    try {
      save(project, comp);
    } catch (e) {
      for (const t of tasks) {
        try {
          board.cancel(project, t.id, host.participant);
        } catch {}
      }
      throw e;
    }
  }

  // 派发还没开始的成员（新建时，或服务重启后密封结果随内存消失、任务回到 open 时）。同组进同一个密封轮次
  function dispatchOpen(project, comp, tasks) {
    const out = [];
    for (const id of tasks) {
      const t = board.get(project, id);
      if (t.state !== 'open') continue;
      try {
        runner.dispatch(project, id, t.assigned_to, { roundId: t.sealed_group });
        out.push({ task: id, dispatched: true });
      } catch (e) {
        out.push({ task: id, dispatched: false, error: e.message });
      }
    }
    if (out.some((x) => !x.dispatched)) {
      comp.history.push({ at: iso(), action: 'dispatch_failed', failed: out.filter((x) => !x.dispatched) });
      save(project, comp);
    }
    return out;
  }

  // ---------- 发起 ----------
  // spec：{ type, title, goal, inputs: [{id, version}], participants: [id…], kind? }
  function create(project, spec, host) {
    const config = workbench.get(project).config;
    if (!spec || typeof spec !== 'object') throw bad(400, '请求体必须是对象');
    const type = spec.type;
    const competeTypes = Object.entries(config.modes).filter(([, m]) => m === 'compete').map(([t]) => t);
    if (!competeTypes.includes(type)) throw bad(400, `${type ?? '（没写类型）'} 不是竞争方式的任务类型（modes 里是 compete 的：${competeTypes.join('、')}）`);
    const kind = spec.kind ?? KIND_OF_TYPE[type] ?? 'outline';
    if (!WORK_KINDS.includes(kind)) throw bad(400, `kind 只能是 ${WORK_KINDS.join(' / ')}`);
    const title = str(spec.title, 'title', 200, false) ?? type;
    // 目标要和固定说明一起放进任务的 goal（任务只收 4000 字以内）：这里留出余量，超出就明确拒绝，不截断
    const goal = str(spec.goal, 'goal', 3600, false) ?? '';
    const ids = (Array.isArray(spec.participants) ? spec.participants : []).map(String);
    if (new Set(ids).size !== ids.length) throw bad(400, '起草者不能重复：每份方案由不同的参与者独立起草');
    const want = config.compete.drafts;
    if (want > LABELS.length) throw bad(400, `竞争方案最多 ${LABELS.length} 份（匿名评审的标签只有${LABELS.join('、')}），compete.drafts 现在是 ${want}`);
    if (ids.length !== want) throw bad(400, `竞争方案的份数是 ${want}（compete.drafts），要指定 ${want} 位不同的起草者`);
    for (const id of ids) checkParticipant(id, '起草者');
    // 输入固定为各记录的当前版本：几份方案看到的是同样的输入
    const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
    // 可引用论断：输入里的论断，以及输入作品（大纲、讲稿、页面）里引用的论断，版本一律按输入快照
    const citable = new Map();
    const cite = (cid, version, from) => {
      if (citable.has(cid) && citable.get(cid) !== version) throw bad(409, `输入里的论断 ${cid} 有两个版本（第 ${citable.get(cid)} 版，以及 ${from} 里的第 ${version} 版）：先把输入统一到同一版本`);
      citable.set(cid, version);
    };
    for (const [i, x] of inputs.entries()) {
      if (!x || typeof x.id !== 'string' || !Number.isInteger(x.version)) throw bad(400, `inputs[${i}] 必须是 {id, version}`);
      const { record, kind: k } = gateway.getRecord(project, x.id);
      if (record.version !== x.version) throw bad(409, `${x.id} 当前是第 ${record.version} 版，不是第 ${x.version} 版`);
      if (k === 'claim') cite(x.id, x.version, `${x.id}@${x.version}`);
      if (WORK_KINDS.includes(k)) for (const c of record.claims ?? []) cite(c.id, c.version, `${x.id}@${x.version}`);
    }
    const id = nextId(project);
    const group = `${id}-drafts`;
    const tasks = ids.map((pid, i) => board.create(project, {
      type, title: `${title}（竞争 ${id}，第 ${i + 1}/${ids.length} 份方案）`,
      goal: `${goal ? `${goal}\n` : ''}这是一次竞争：几份方案同时独立起草，完成前互不可见；之后匿名评审，由主持人选定一份，落选方案里值得保留的内容按节移植。`,
      inputs: inputs.map((x) => ({ id: x.id, version: x.version })), assigned_to: pid,
    }, { created_by: host, internal: { competition: id, sealed_group: group } }));
    const comp = {
      id, project, type, kind, title, goal, inputs: inputs.map((x) => ({ id: x.id, version: x.version })),
      citable: [...citable].map(([cid, version]) => ({ id: cid, version })),
      created_by: actorSummary(host), created_at: iso(), updated_at: iso(),
      drafts: tasks.map((t, i) => ({ task: t.id, participant: ids[i] })), draft_group: group,
      labels: null, reviews: [], selection: null, patches: [], applied: null, closed: null, cancelled: null,
      history: [{ at: iso(), by: host.participant, action: 'create', drafts: tasks.map((t) => t.id) }],
    };
    saveOrCancel(project, comp, tasks, host);
    const dispatched = dispatchOpen(project, comp, tasks.map((t) => t.id));
    return { ...view(project, comp.id), dispatched };
  }

  // ---------- 揭晓、重派 ----------
  // 当前这一步（起草或最近一轮评审）里已交稿的成员所在的密封轮次，交给 runner 揭晓（全部交稿才能揭晓）
  function reveal(project, id) {
    const comp = load(project, id);
    const stage = stageOf(project, comp);
    const tasks = stage === 'drafting' ? comp.drafts.map((d) => d.task) : stage === 'reviewing' ? comp.reviews.at(-1).tasks : [];
    if (!tasks.length) throw bad(409, `竞争 ${id} 当前是“${STAGE_LABEL[stage]}”，没有要揭晓的密封轮次`);
    const rounds = [...new Set(tasks.map((t) => board.get(project, t)).filter((t) => t.state === 'submitted').map((t) => t.attempts.find((a) => a.n === t.attempt)?.sealed_round).filter(Boolean))];
    if (!rounds.length) throw bad(409, '还没有交稿的成员');
    const results = rounds.map((r) => runner.reveal(project, r));
    return { ...view(project, id), revealed: results.map((r) => ({ round: r.round, tasks: r.results.map((x) => x.task), dropped: r.dropped })) };
  }

  function redispatch(project, id) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      const stage = stageOf(project, comp);
      const tasks = stage === 'drafting' ? comp.drafts.map((d) => d.task) : stage === 'reviewing' ? comp.reviews.at(-1).tasks : [];
      const dispatched = dispatchOpen(project, comp, tasks);
      if (!dispatched.length) throw bad(409, '没有等待派发的成员');
      return { ...view(project, id), dispatched };
    });
  }

  // ---------- 匿名评审 ----------
  // { reviewers: [id…] }。评审者不能是起草者：会认出自己的方案，匿名就失效了
  function review(project, id, body, host) {
    return serial(project, id, async () => {
      const comp = sync(project, load(project, id));
      assertNoPending(comp);
      const stage = stageOf(project, comp);
      if (!['review_ready', 'selecting'].includes(stage)) throw bad(409, `竞争 ${id} 当前是“${STAGE_LABEL[stage]}”，不能发起评审`);
      const ids = (Array.isArray(body?.reviewers) ? body.reviewers : []).map(String);
      if (!ids.length) throw bad(400, 'reviewers 至少一位');
      if (new Set(ids).size !== ids.length) throw bad(400, '评审者不能重复');
      const drafters = new Set(comp.drafts.map((d) => d.participant));
      for (const r of ids) {
        if (drafters.has(r)) throw bad(409, `${r} 是这次竞争的起草者，会认出自己的方案，不能做匿名评审`);
        checkParticipant(r, '评审者');
      }
      const n = comp.reviews.length + 1;
      const group = `${id}-review-${n}`;
      const inputs = Object.entries(comp.labels).map(([label, task]) => ({ blob: board.get(project, task).result.text_blob, name: label }));
      const tasks = ids.map((pid) => board.create(project, {
        type: 'anonymous_review', title: `匿名评审（竞争 ${id}，第 ${n} 轮）`,
        goal: `评审同一题目的 ${inputs.length} 份方案：${comp.title}。${comp.goal ? `\n题目要求：${comp.goal}` : ''}`,
        inputs, assigned_to: pid,
      }, { created_by: host, internal: { competition: id, sealed_group: group } }));
      comp.reviews.push({ n, group, tasks: tasks.map((t) => t.id), reviewers: ids, at: iso(), comments: null, returned: null });
      comp.history.push({ at: iso(), by: host.participant, action: 'review', round: n, tasks: tasks.map((t) => t.id) });
      saveOrCancel(project, comp, tasks, host);
      const dispatched = dispatchOpen(project, comp, tasks.map((t) => t.id));
      return { ...view(project, id), dispatched };
    });
  }

  // ---------- 选定 ----------
  // { label, reason }：选定的方案写成正式作品。内容来源是起草那次尝试（服务端保存的身份），选定者另记
  function select(project, id, body, host) {
    return serial(project, id, async () => {
      const comp = sync(project, load(project, id));
      const label = str(body?.label, 'label', 10);
      const requestId = `compete-${id}-select-${LABELS.indexOf(label)}`;
      assertNoPending(comp, requestId);
      const stage = stageOf(project, comp);
      if (stage !== 'selecting') throw bad(409, `竞争 ${id} 当前是“${STAGE_LABEL[stage]}”，不能选定`);
      if (!comp.labels?.[label]) throw bad(400, `没有${label}`);
      const reason = str(body?.reason, 'reason（选定的理由）', 4000);
      const taskId = comp.labels[label];
      const t = board.get(project, taskId);
      const text = textOfTask(project, taskId);
      // 正文里的论断编号都要对得上可引用论断（版本按输入快照），对不上的明确拒绝
      const { refs, unknown } = bindClaims(text, citableOf(comp));
      if (unknown.length) throw bad(409, `${label}的正文提到了 ${unknown.join('、')}，不在这次竞争可引用的论断里（${citableText(comp)}）：编号对不上固定的版本，不能选定`);
      const actor = { ...board.identityOfAttempt(project, taskId, t.attempt), basis: 'compete-selected', competition: id, draft_task: taskId, draft_attempt: t.attempt, selected_by: host.participant };
      const change = { kind: comp.kind, expected_version: 0, data: { title: comp.title, body: text, claims: refs } };
      const pending = comp.pending ?? { action: 'select', request_id: requestId, label, task: taskId, reason, by: host.participant, at: iso() };
      return commitPending(project, id, comp, pending, change, { actor });
    });
  }

  // ---------- 移植补丁 ----------
  // { from: { draft, section, quote? }, to: { section, position }, note?, comment? }。
  // 主持人入口或 MCP 会话都可以提出（提出者记在补丁上）；接受或拒绝只限主持人
  function propose(project, id, body, actor) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      assertNoPending(comp); // 书记的结果确认不了时，补丁集合冻结：否则原样重试就对不上了
      const stage = stageOf(project, comp);
      if (stage !== 'patching') throw bad(409, `竞争 ${id} 当前是“${STAGE_LABEL[stage]}”，选定方案之后才能提移植补丁`);
      const from = body?.from ?? {};
      const to = body?.to ?? {};
      const p = {
        from: { draft: typeof from.draft === 'string' ? from.draft.trim() : null, section: Number(from.section), ...(from.quote != null && from.quote !== '' ? { quote: String(from.quote) } : {}) },
        to: { section: Number(to.section), position: to.position },
      };
      const why = checkPatch(p, { base: winnerText(project, comp), sources: losingTexts(project, comp) });
      if (why) throw bad(400, why);
      const note = str(body?.note, 'note', 1000, false);
      const comment = body?.comment != null && body.comment !== '' ? String(body.comment) : null;
      if (comment && !allComments(comp).some((c) => c.id === comment)) throw bad(400, `没有评审意见 ${comment}`);
      const content = patchContent(p.from, losingTexts(project, comp)[p.from.draft]);
      const { unknown } = bindClaims(content, citableOf(comp));
      if (unknown.length) throw bad(400, `要搬运的原文提到了 ${unknown.join('、')}，不在这次竞争可引用的论断里（${citableText(comp)}）：编号对不上固定的版本`);
      const patch = { id: `P${comp.patches.length + 1}`, ...p, content, ...(note ? { note } : {}), ...(comment ? { comment } : {}), proposed_by: actorSummary(actor), at: iso(), state: 'proposed', decision: null, applied: null };
      comp.patches.push(patch);
      comp.history.push({ at: iso(), by: actor.participant, action: 'patch_proposed', patch: patch.id });
      save(project, comp);
      return view(project, id);
    });
  }

  // { decision: accept | reject, reason }：每条补丁都留接受或拒绝的记录（拒绝必须写理由），决定后不再改
  function decide(project, id, patchId, body, host) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      assertNoPending(comp);
      if (stageOf(project, comp) !== 'patching') throw bad(409, `竞争 ${id} 当前不在移植补丁阶段`);
      const p = comp.patches.find((x) => x.id === patchId);
      if (!p) throw bad(404, `没有补丁 ${patchId}`);
      if (p.state !== 'proposed') throw bad(409, `补丁 ${patchId} 已经${p.state === 'accepted' ? '接受' : '拒绝'}，决定后不再改`);
      const decision = body?.decision;
      if (!['accept', 'reject'].includes(decision)) throw bad(400, 'decision 只能是 accept 或 reject');
      const reason = str(body?.reason, 'reason（拒绝补丁必须写理由）', 2000, decision === 'reject');
      if (decision === 'accept') {
        const conflict = patchConflict(p, comp.patches.filter((x) => x.state === 'accepted'));
        if (conflict) throw bad(409, conflict);
      }
      p.state = decision === 'accept' ? 'accepted' : 'rejected';
      p.decision = { by: host.participant, at: iso(), ...(reason ? { reason } : {}) };
      comp.history.push({ at: iso(), by: host.participant, action: `patch_${p.state}`, patch: p.id, ...(reason ? { reason } : {}) });
      save(project, comp);
      return view(project, id);
    });
  }

  // ---------- 书记 ----------
  // 按规则应用已接受的补丁：底稿（选定的方案原文）＋ 全部已接受补丁 → 作品的新版本。
  // 只在书记上次写的版本上继续；作品在竞争之外被改过时版本对不上，提交入口拒绝，书记不覆盖
  function apply(project, id, host) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      if (stageOf(project, comp) !== 'patching') throw bad(409, `竞争 ${id} 当前不在移植补丁阶段`);
      // 有没确认的书记操作时，原样重试它：补丁集合取 pending 里记下的那一组，不取后来的已接受集合
      const retry = comp.pending?.action === 'apply' ? comp.pending.patches : null;
      const accepted = comp.patches.filter((p) => (retry ? retry.includes(p.id) : p.state === 'accepted')).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
      const requestId = `compete-${id}-apply-${sha256(accepted.map((p) => p.id).join(',')).slice(0, 16)}`;
      assertNoPending(comp, requestId);
      if (!accepted.some((p) => !p.applied)) throw bad(409, '没有待应用的已接受补丁');
      const sources = labelTexts(project, comp);
      for (const p of accepted) if (patchContent(p.from, sources[p.from.draft]) !== p.content) throw bad(409, `补丁 ${p.id} 搬运的原文与接受时不一致`);
      const body = applyPatches(winnerText(project, comp), accepted, (label) => sources[label]);
      const rec = comp.selection.record;
      const carry = [...new Set(accepted.map((p) => comp.labels[p.from.draft]))].map((task) => board.identityOfAttempt(project, task, board.get(project, task).attempt));
      const actor = { ...SCRIBE_ACTOR, competition: id, patches: accepted.map((p) => p.id) };
      const { refs, unknown } = bindClaims(body, citableOf(comp));
      if (unknown.length) throw bad(409, `应用补丁后的正文提到了 ${unknown.join('、')}，不在这次竞争可引用的论断里（${citableText(comp)}）`);
      const change = { id: rec.id, expected_version: comp.applied.version, data: { title: comp.title, body, claims: refs } };
      const pending = comp.pending ?? { action: 'apply', request_id: requestId, patches: accepted.map((p) => p.id), by: host.participant, at: iso() };
      try {
        return await commitPending(project, id, comp, pending, change, { actor, carryAuthors: carry });
      } catch (e) {
        const vc = e.details?.reasons?.find((r) => r.type === 'version_conflict');
        if (vc) throw bad(409, `${rec.id} 已在竞争之外改到第 ${vc.current} 版（书记上次写的是第 ${vc.expected} 版）：书记不覆盖别人的改动`, e.details);
        throw e;
      }
    });
  }

  // ---------- 结束、取消 ----------
  function close(project, id, host) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      assertNoPending(comp);
      if (stageOf(project, comp) !== 'patching') throw bad(409, `竞争 ${id} 还没选定方案（或已结束）`);
      const open = comp.patches.filter((p) => p.state === 'proposed').map((p) => p.id);
      if (open.length) throw bad(409, `还有补丁没决定：${open.join('、')}`);
      const unapplied = comp.patches.filter((p) => p.state === 'accepted' && !p.applied);
      // 作品在竞争之外被改过时，书记不能再应用（不覆盖别人的改动）：这些补丁记为没有应用，竞争照样可以结束
      let diverged = false;
      try {
        diverged = divergedFrom(comp, gateway.getRecord(project, comp.selection.record.id).record);
      } catch {}
      if (unapplied.length && !diverged) throw bad(409, `已接受的补丁还没应用：${unapplied.map((p) => p.id).join('、')}`);
      for (const p of unapplied) p.skipped = '作品已在竞争之外被改过，书记没有应用（不覆盖别人的改动）';
      comp.closed = { by: host.participant, at: iso() };
      comp.history.push({ at: iso(), by: host.participant, action: 'close', ...(unapplied.length ? { skipped: unapplied.map((p) => p.id) } : {}) });
      save(project, comp);
      return view(project, id);
    });
  }

  function cancel(project, id, host, reason = null) {
    return serial(project, id, async () => {
      const comp = load(project, id);
      assertNoPending(comp);
      if (comp.selection || comp.cancelled || comp.closed) throw bad(409, `竞争 ${id} 已${comp.cancelled ? '取消' : '选定方案'}，不能取消${comp.selection ? '（结束请用“结束竞争”）' : ''}`);
      for (const t of [...comp.drafts.map((d) => d.task), ...comp.reviews.flatMap((r) => r.tasks)]) {
        if (!FINAL.has(board.get(project, t).state)) board.cancel(project, t, host.participant);
      }
      comp.cancelled = { by: host.participant, at: iso(), ...(reason ? { reason } : {}) };
      comp.history.push({ at: iso(), by: host.participant, action: 'cancel', ...(reason ? { reason } : {}) });
      save(project, comp);
      return view(project, id);
    });
  }

  // ---------- 视图 ----------
  // 起草者与标签的对应关系，评审全部结束（待你选定）之后才公开；正文只在揭晓（任务完成）之后才有
  // 作品在竞争之外被改过：当前版本不是书记上次写的那一版，而且不是这次竞争自己的提交（内容来源里记着竞争编号）
  const divergedFrom = (comp, record) => !!comp.applied && record.version !== comp.applied.version && record.provenance?.competition !== comp.id;

  function view(project, id) {
    const comp = sync(project, load(project, id));
    const stage = stageOf(project, comp);
    const mappingPublic = ['selecting', 'patching', 'closed'].includes(stage) || (stage === 'cancelled' && !!comp.labels);
    const drafts = draftState(project, comp);
    const labels = Object.entries(comp.labels ?? {}).map(([label, task]) => ({
      label, text: textOfTask(project, task),
      ...(mappingPublic ? { task, participant: comp.drafts.find((d) => d.task === task)?.participant ?? null } : {}),
    }));
    const record = comp.selection ? (() => {
      try {
        return gateway.getRecord(project, comp.selection.record.id).record;
      } catch {
        return null;
      }
    })() : null;
    const accepted = new Set(comp.patches.filter((p) => p.state === 'accepted' && p.comment).map((p) => p.comment));
    return {
      ...comp,
      labels: undefined,
      stage, stage_label: STAGE_LABEL[stage], mapping_public: mappingPublic,
      drafts, label_drafts: labels,
      sections: Object.fromEntries(labels.filter((l) => l.text != null).map((l) => [l.label, sectionsOf(l.text).sections.map((s) => ({ n: s.n, title: s.title }))])),
      reviews: comp.reviews.map((r) => ({ ...r, tasks: r.tasks.map((t) => ({ task: t, reviewer: board.get(project, t).assigned_to, state: board.get(project, t).state })) })),
      record: record ? { id: record.id, version: record.version, body: record.body ?? '', title: record.title, claims: record.claims ?? [], diverged: divergedFrom(comp, record) } : null,
      citable: citableOf(comp),
      positions: PATCH_POSITIONS,
      // 少数意见记录：被拒的补丁（含理由），以及没被任何已接受补丁采纳的评审意见
      minority: comp.selection ? {
        rejected_patches: comp.patches.filter((p) => p.state === 'rejected').map((p) => ({ id: p.id, from: p.from, to: p.to, note: p.note ?? null, content: p.content, reason: p.decision?.reason ?? null, by: p.decision?.by ?? null })),
        unadopted_comments: allComments(comp).filter((c) => !accepted.has(c.id)),
        skipped_patches: comp.patches.filter((p) => p.skipped).map((p) => ({ id: p.id, reason: p.skipped })),
        losing_drafts: labels.filter((l) => l.label !== comp.selection.label).map((l) => ({ label: l.label, task: comp.labels?.[l.label] ?? null })),
      } : null,
    };
  }

  function summaries(project) {
    return list(project).map((x) => settleQuiet(project, x)).map((c) => {
      const stage = stageOf(project, c);
      return { id: c.id, type: c.type, kind: c.kind, title: c.title, stage, stage_label: STAGE_LABEL[stage], created_at: c.created_at, updated_at: c.updated_at, selection: c.selection ? { label: c.selection.label, record: c.selection.record } : null, patches: c.patches.length };
    });
  }

  // 待你决定：每个竞争下一步需要你做的事
  function inbox(project) {
    const items = [];
    for (const c of list(project).map((x) => settleQuiet(project, x))) {
      const stage = stageOf(project, c);
      const push = (action, text) => items.push({ type: 'competition', project, competition: c.id, action, reason: text });
      if (c.pending) push('pending', `上一个操作（${c.pending.action === 'select' ? '选定' : '书记应用补丁'}）的结果还没确认：原样重试，或重启服务恢复后再看`);
      if (stage === 'drafting') {
        const ts = c.drafts.map((d) => board.get(project, d.task));
        if (ts.every((t) => t.state === 'submitted' || FINAL.has(t.state))) push('reveal', '方案都已交稿，等你揭晓');
        else if (ts.some((t) => t.state === 'open')) push('dispatch', '有方案还没派发（服务重启后需要重新派发）');
      } else if (stage === 'reviewing') {
        const ts = c.reviews.at(-1).tasks.map((id) => board.get(project, id));
        if (ts.every((t) => t.state === 'submitted' || FINAL.has(t.state))) push('reveal', '评审都已交稿，等你揭晓');
        else if (ts.some((t) => t.state === 'open')) push('dispatch', '有评审还没派发');
      } else if (stage === 'insufficient') push('cancel', '有效方案不足两份（失败、取消或独立性未证明），只能取消后重来');
      else if (stage === 'review_ready') push('review', '方案已揭晓，等你发起匿名评审');
      else if (stage === 'selecting') push('select', '评审已揭晓，等你选定一份方案');
      else if (stage === 'patching') {
        const proposed = c.patches.filter((p) => p.state === 'proposed').length;
        const unapplied = c.patches.filter((p) => p.state === 'accepted' && !p.applied).length;
        if (proposed) push('decide', `有 ${proposed} 条移植补丁等你接受或拒绝`);
        if (unapplied) push('apply', `有 ${unapplied} 条已接受的补丁还没应用`);
      }
    }
    return items;
  }

  return { create, list: summaries, get, view, reveal, redispatch, review, select, propose, decide, apply, close, cancel, inbox, stageOf };
}
