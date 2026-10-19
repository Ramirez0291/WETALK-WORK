// 调度（WP6）：规则循环，只执行规则，不调用模型做派发判断。
// - 自动调度按项目开关（默认关）；“跑一轮”只把当前已就绪的任务派一次。
// - 一轮 = 一批派发到全部结束：开一轮时把已就绪的任务派出去；这批任务都不在进行中了（密封任务交稿、等你揭晓也算）就收轮，
//   用 changelog.mjs 判断这一轮：有进展、没有任务完成、只有读者或评审、内容没有变化、有变化但质量指标没有提升。
//   连续 plateau.rounds 轮停滞时按 plateau.action 处理：派观众型新读者，或交给你决定。
// - 挑参与者：任务指派了谁就派给谁；否则按分工表（routing）找可用、不在冷却中、手上没有进行中任务的参与者。
//   对抗核验的 different_vendor 逐个试，资格不够的（runner 拒绝）换下一位。
// - 冷却：API 被限流（429）按 Retry-After，没有就 cooldown.apiSeconds；命令行 Agent 额度用完或被限流，cooldown.cliMinutes。
//   冷却按参与者记，所有项目共用。冷却期间调度不派给它。
// - 上限：认领时超出调用次数或费用上限，任务转“待你决定”（tasks.mjs），这个项目这一轮不再往下派。
// - 争议分流：补证任务由规则（evidence.mjs）生成、这里照常派发；核验结论不一致、补证用完的进“待你决定”。
// - 阶段：七步流程，由你切换（phases.mjs）。切换时生成交接单，旧阶段的工作记忆先归档再清空，新阶段换记忆空间。
// 流程状态存在 <项目>/workflow.json（服务维护，不进 git）；交接单存在 <项目>/handoff/H###.md。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';
import { writeJsonSync } from './tasks.mjs';
import { visibilityOf } from './visibility.mjs';
import { isPeak } from './deepseek.mjs';
import { snapshot, assessRound, createChangelog, ROUND_KIND_LABEL } from './changelog.mjs';
import { PHASES, phaseOf, phaseSpace, resetPhase, buildHandoff } from './phases.mjs';

export const SCHEDULER_ACTOR = { kind: 'system', participant: 'workbench-scheduler', verified: true, basis: 'rule' };

// 任务类型 → 分工表（routing）里的工作类型
const TYPE_ROUTE = {
  collect_sources: 'search', extract_claims: 'extract', check_citations: 'verify', find_evidence: 'extract',
  angle: 'outline', outline: 'outline', core_explanation: 'key_writing', causal_explanation: 'key_writing',
  core_claim: 'verify', key_number: 'verify', verify_claim: 'verify', anonymous_review: 'outline', audience_reader: 'summarize',
};
// 命令行 Agent 的额度用完或被限流：只看报错的类别词，判断完就丢掉报错原文（密封任务的报错不能落盘）
const CLI_LIMIT = /usage limit|rate.?limit|quota|\b429\b|too many requests|overloaded|额度|限流/i;
const WORK_ORDER = ['slide', 'script', 'outline'];

const bad = (status, msg) => new WorkbenchError(status, msg);

// participants(id)：参与者配置（含 resolved），participants.all()：全部
export function createScheduler({
  workbench, gateway, board, runner, participants, competitions = null,
  store = null, // WeTalk 的记忆存储（阶段切换时归档、清空、换空间）；测试可以不给
  cooldownFile = null, inboxCount = () => 0,
  now = () => new Date(), onEvent = () => {},
}) {
  const iso = () => now().toISOString();
  const fileOf = (project) => path.join(workbench.get(project).dir, 'workflow.json');
  const blank = () => ({ auto: false, phase: null, phases: [], rounds: [], round: null, streak: 0, last: null });

  function load(project) {
    const file = fileOf(project);
    if (!fs.existsSync(file)) return blank();
    return { ...blank(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  function save(project, st) {
    st.rounds = st.rounds.slice(-200);
    writeJsonSync(fileOf(project), st);
    onEvent({ type: 'scheduler', project, round: st.round?.n ?? null, auto: st.auto });
    return st;
  }

  // ---------- 冷却（所有项目共用，按参与者） ----------
  let cooling = {};
  try {
    if (cooldownFile && fs.existsSync(cooldownFile)) cooling = JSON.parse(fs.readFileSync(cooldownFile, 'utf8'));
  } catch {}
  const coolUntil = (pid) => {
    const c = cooling[pid];
    return c && Date.parse(c.until) > now().getTime() ? c : null;
  };
  function cooldowns() {
    return Object.entries(cooling).filter(([pid]) => coolUntil(pid)).map(([participant, c]) => ({ participant, ...c }));
  }
  function persistCooling() {
    for (const pid of Object.keys(cooling)) if (!coolUntil(pid)) delete cooling[pid];
    if (cooldownFile) writeJsonSync(cooldownFile, cooling);
  }
  // runner 的调用失败回调：被限流、额度用完的参与者进入冷却
  function noteFailure({ project, participant: p, error: e }) {
    let config;
    try {
      config = workbench.get(project).config;
    } catch {
      return;
    }
    const t = now().getTime();
    let until = null;
    let reason = null;
    if (e?.details?.rateLimited) {
      until = t + (e.details.retryAfterMs ?? config.cooldown.apiSeconds * 1000);
      reason = 'API 被限流（429）';
    } else if (p?.adapter !== 'deepseek' && ['exit', 'empty'].includes(e?.kind) && CLI_LIMIT.test(String(e.message))) {
      until = t + config.cooldown.cliMinutes * 60_000;
      reason = '命令行 Agent 额度用完或被限流';
    }
    if (!until || !p?.id) return;
    const prev = coolUntil(p.id);
    if (prev && Date.parse(prev.until) >= until) return;
    cooling[p.id] = { until: new Date(until).toISOString(), reason, at: iso(), project };
    persistCooling();
    onEvent({ type: 'cooldown', participant: p.id, until: cooling[p.id].until });
  }

  // ---------- 派发 ----------
  function candidatesFor(task, config) {
    if (task.assigned_to) return [task.assigned_to];
    const route = config.routing?.[TYPE_ROUTE[task.type] ?? task.type] ?? [];
    const all = participants.all?.() ?? [];
    const out = [];
    for (const r of route) {
      if (r === 'different_vendor') out.push(...all.map((p) => p.id));
      else for (const p of all) if (p.id === r || p.adapter === r) out.push(p.id);
    }
    return [...new Set(out)];
  }

  // 各参与者手上进行中的任务数（服务自己派发的，所有项目合计）
  function busy() {
    const m = new Map();
    for (const { name } of workbench.list()) {
      for (const t of board.list(name, { state: 'claimed' })) {
        if (t.holder?.kind === 'server') m.set(t.holder.participant, (m.get(t.holder.participant) ?? 0) + 1);
      }
    }
    return m;
  }

  const depsDone = (project, t) => t.depends_on.every((d) => {
    try {
      return board.get(project, d).state === 'done';
    } catch {
      return false;
    }
  });

  // 开一轮：把已就绪的任务派出去。一个都没派出去就不开轮，只记下原因
  function openRound(project, st, by) {
    const config = workbench.get(project).config;
    const ready = board.list(project, { state: 'open' }).filter((t) => visibilityOf(t) !== 'export' && depsDone(project, t));
    const load = busy();
    const max = config.scheduler.maxPerParticipant;
    const peak = config.offPeak.defer && isPeak(now(), config.pricing.peakHoursUtc);
    const before = snapshot({ gateway, board, project });
    const dispatched = [];
    const skipped = [];
    let budgetHit = false;
    for (const t of ready) {
      const cands = candidatesFor(t, config);
      if (!cands.length) {
        skipped.push({ task: t.id, reason: `分工表（routing）里没有能做 ${t.type} 的参与者` });
        continue;
      }
      const why = [];
      let started = false;
      for (const pid of cands) {
        const p = participants(pid);
        const c = coolUntil(pid);
        if (!p) why.push(`${pid} 不存在`);
        else if (!p.resolved) why.push(`${pid} 不可用`);
        else if (c) why.push(`${pid} 冷却到 ${c.until}（${c.reason}）`);
        else if ((load.get(pid) ?? 0) >= max) why.push(`${pid} 手上还有进行中的任务`);
        else if (peak && p.adapter === 'deepseek') why.push(`${pid}：高峰时段，批量任务推迟到低谷（offPeak.defer）`);
        else {
          try {
            runner.dispatch(project, t.id, pid);
            load.set(pid, (load.get(pid) ?? 0) + 1);
            dispatched.push(t.id);
            started = true;
            break;
          } catch (e) {
            why.push(`${pid}：${e.message}`);
            if (e.status === 429) {
              budgetHit = true; // 到了调用次数或费用上限：任务已转“待你决定”
              break;
            }
          }
        }
      }
      if (!started) skipped.push({ task: t.id, reason: why.join('；') });
      if (budgetHit) break;
    }
    st.last = { at: iso(), by, dispatched, skipped, budget_hit: budgetHit };
    if (!dispatched.length) return null;
    const n = (st.rounds.at(-1)?.n ?? 0) + 1;
    const phase = st.phase ? phaseOf(st.phase.id) : null;
    st.round = { n, phase: phase?.id ?? null, phase_name: phase?.name ?? null, by, started_at: iso(), tasks: dispatched, skipped, baseline: before };
    return st.round;
  }

  // 这一轮的任务都不在进行中了吗：进行中 = 已认领，或已交稿等晋升（密封任务交稿后等你揭晓，不算进行中）
  function settled(project, round) {
    return round.tasks.every((id) => {
      let t;
      try {
        t = board.get(project, id);
      } catch {
        return true;
      }
      if (t.state === 'claimed') return false;
      if (t.state === 'submitted') return !!t.attempts.find((a) => a.n === t.attempt)?.sealed_round;
      return true;
    });
  }

  // 收轮：判断这一轮，连续停滞时按 plateau.action 处理
  function closeRound(project, st) {
    const config = workbench.get(project).config;
    const r = st.round;
    const tasks = r.tasks.map((id) => board.get(project, id));
    const after = snapshot({ gateway, board, project });
    const changelog = createChangelog(workbench.get(project).dir).list((e) => r.tasks.includes(e.task) && !e.invalid);
    const a = assessRound({ before: r.baseline, after, tasks, changelog });
    delete r.baseline;
    r.ended_at = iso();
    r.states = tasks.map((t) => ({ task: t.id, type: t.type, state: t.state }));
    r.assessment = { ...a, label: ROUND_KIND_LABEL[a.kind] };
    if (a.stagnant) st.streak += 1;
    else if (a.kind === 'progress') st.streak = 0; // 没有任务完成、只有读者：不算停滞，也不打断连续停滞
    r.streak = st.streak;
    if (a.stagnant && st.streak >= config.plateau.rounds) {
      r.action = plateauAction(project, config, r);
      st.streak = 0;
    }
    st.rounds.push(r);
    st.round = null;
    return r;
  }

  function plateauAction(project, config, r) {
    if (config.plateau.action === 'needs_user') return { type: 'needs_user', reason: `连续 ${config.plateau.rounds} 轮停滞，交给你决定` };
    const pending = board.list(project).find((t) => t.type === 'audience_reader' && t.created_by?.participant === SCHEDULER_ACTOR.participant && !board.FINAL.has(t.state));
    if (pending) return { type: 'audience_reader', task: pending.id, note: '上一份新读者任务还没结束，不再加' };
    // 新读者只读作品：有幻灯片读幻灯片，否则讲稿，再否则大纲（当前版本）
    const works = gateway.listRecords(project);
    const kind = WORK_ORDER.find((k) => works.some((w) => w.kind === k));
    if (!kind) return { type: 'needs_user', reason: '连续停滞，但还没有作品可以给新读者看，交给你决定' };
    const inputs = works.filter((w) => w.kind === kind).slice(0, 20).map((w) => ({ id: w.record.id, version: w.record.version }));
    const t = board.create(project, {
      type: 'audience_reader', title: `新读者：第 ${r.n} 轮起连续停滞`,
      goal: '你第一次看到这份材料。复述核心观点，标出看不懂、觉得跳跃或有疑问的地方。',
      inputs,
    }, { created_by: SCHEDULER_ACTOR });
    return { type: 'audience_reader', task: t.id };
  }

  // 一步：先看这一轮能不能收；然后（自动调度开着，或你点了“跑一轮”）开下一轮
  function step(project, { force = false, by = 'auto' } = {}) {
    const st = load(project);
    let closed = null;
    if (st.round && settled(project, st.round)) closed = closeRound(project, st);
    let opened = null;
    if (!st.round && (st.auto || force)) opened = openRound(project, st, by);
    if (closed || opened || force) save(project, st);
    return { closed, opened, st };
  }

  function runOnce(project, by) {
    const st = load(project);
    if (st.round && !settled(project, st.round)) {
      const running = st.round.tasks.filter((id) => board.get(project, id).state === 'claimed' || board.get(project, id).state === 'submitted');
      throw bad(409, `第 ${st.round.n} 轮还没结束（进行中：${running.join('、')}），结束后再跑下一轮`);
    }
    const r = step(project, { force: true, by });
    return { round: r.opened ? view(r.opened, project) : null, closed: r.closed, last: r.st.last };
  }

  function setAuto(project, on, by) {
    const st = load(project);
    st.auto = !!on;
    st.auto_changed = { at: iso(), by, on: !!on };
    save(project, st);
    if (st.auto) poke(project);
    return state(project);
  }

  const pokes = new Set();
  function poke(project) {
    if (pokes.has(project)) return;
    pokes.add(project);
    setImmediate(() => {
      pokes.delete(project);
      try {
        step(project);
      } catch (e) {
        recordError(project, e);
      }
    });
  }
  function recordError(project, e) {
    try {
      const st = load(project);
      st.last_error = { at: iso(), message: String(e.message).slice(0, 300) };
      save(project, st);
    } catch {}
    console.error(`[工坊] 调度出错（${project}）：`, e);
  }

  // 定时检查所有开着自动调度的项目（也负责收已经结束的轮）
  function tick() {
    for (const { name } of workbench.list()) {
      try {
        const st = load(name);
        if (st.auto || st.round) step(name);
      } catch (e) {
        recordError(name, e);
      }
    }
  }
  let timer = null;
  function start(intervalMs) {
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }
  const stop = () => timer && clearInterval(timer);

  // ---------- 阶段 ----------
  function switchPhase(project, to, by) {
    const target = phaseOf(to);
    if (!target) throw bad(400, `阶段只能是 ${PHASES.map((p) => p.id).join(' / ')}`);
    const st = load(project);
    if (st.round) throw bad(409, `第 ${st.round.n} 轮还没收轮：等这一批任务结束再切换阶段`);
    if (st.phase?.id === to) throw bad(409, `已经在“${target.name}”阶段`);
    const from = st.phase ? phaseOf(st.phase.id) : null;
    const p = workbench.get(project);
    const at = iso();
    const text = buildHandoff({
      title: p.title, from, to: target, at, records: gateway.listRecords(project),
      competitions: competitions ? competitions.list(project) : [], inboxCount: inboxCount(project),
      rounds: st.rounds,
    });
    // 旧阶段的工作记忆：先归档再清空（归档失败时原样保留，切换不进行）；新阶段换一个记忆空间
    const memory = store && from ? resetPhase({ store, projectDir: p.dir, project, phase: from.name, now }) : null;
    const id = `H${String(st.phases.length + 1).padStart(3, '0')}`;
    const file = path.join(p.dir, 'handoff', `${id}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    const space = store ? phaseSpace(store, project, target.name).id : null;
    st.phases.push({ id, from: from?.id ?? null, to, at, by, space, memory: memory ? { space: memory.space, archived: memory.archived, file: path.relative(p.dir, memory.file) } : null });
    st.phase = { id: to, since: at, handoff: id, space };
    save(project, st);
    return { phase: st.phase, handoff: { id, text } };
  }

  function handoff(project, id) {
    if (!/^H\d{3,6}$/.test(id)) throw bad(400, '交接单编号格式不对');
    const file = path.join(workbench.get(project).dir, 'handoff', `${id}.md`);
    if (!fs.existsSync(file)) throw bad(404, `交接单 ${id} 不存在`);
    return fs.readFileSync(file, 'utf8');
  }
  // 当前阶段的交接单（任务包用）
  function handoffOf(project) {
    const st = load(project);
    if (!st.phase?.handoff) return null;
    try {
      return { id: st.phase.handoff, text: handoff(project, st.phase.handoff) };
    } catch {
      return null;
    }
  }
  const currentPhase = (project) => {
    const st = load(project);
    return st.phase ? { ...phaseOf(st.phase.id), ...st.phase } : null;
  };

  // ---------- 视图 ----------
  function view(round, project) {
    if (!round) return null;
    const { baseline, ...rest } = round;
    return { ...rest, live: round.ended_at ? undefined : round.tasks.map((id) => ({ task: id, state: board.get(project, id).state })) };
  }
  function state(project) {
    const st = load(project);
    const config = workbench.get(project).config;
    return {
      auto: st.auto, auto_changed: st.auto_changed ?? null,
      phase: st.phase ? { ...phaseOf(st.phase.id), ...st.phase } : null, phases: PHASES, phase_history: st.phases,
      round: view(st.round, project), rounds: st.rounds.slice(-20).reverse(), streak: st.streak,
      plateau: config.plateau, last: st.last, last_error: st.last_error ?? null, cooldowns: cooldowns(),
    };
  }

  // 待你决定：连续停滞且按规则要你决定（最近一轮）；调度出错
  function inbox(project) {
    const st = load(project);
    const items = [];
    const last = st.rounds.at(-1);
    if (last?.action?.type === 'needs_user') items.push({ type: 'stagnation', project, round: last.n, reason: `${last.assessment.label}；${last.action.reason}` });
    if (st.last?.budget_hit) items.push({ type: 'scheduler_budget', project, reason: '自动调度派发时到了调用次数或费用上限，相关任务已转“待你决定”' });
    return items;
  }

  return { state, setAuto, runOnce, step, poke, tick, start, stop, noteFailure, cooldowns, switchPhase, handoff, handoffOf, currentPhase, inbox };
}
