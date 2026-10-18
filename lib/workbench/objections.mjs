// 异议（契约一）：写入检查（纯函数，提交入口在晋升时调用）。
// 状态机：
//   新建 → open（指针有效）或 needs_evidence（发现了问题，暂时定位不到原文；只限三类阻塞异议）
//   open → upheld / rejected：由作者和提出者之外、与作者不同厂商的核验者裁定，写明理由
//   open → needs_user：核验结论不一致或对分类有争议
//   needs_evidence → open：补到了有效指针；→ needs_user：补证次数用完（规则）或主持人决定
//   upheld → resolved：目标已经改版，新版本核验通过（论断）或已是当前版本（作品、来源）
//   needs_user → 任一状态：只限主持人
//   open / needs_evidence → withdrawn：只限提出者（或主持人）
//   rejected、withdrawn、resolved 是终态；被驳回的提出者可以附新证据另提一条
// 目标与类别一经提出不能改；指针只在 needs_evidence → open 时补上。
import { locateQuote, kindOfId, canonical, OBJECTION_STATES } from './records.mjs';
import { BLOCKING_CATEGORIES } from './deps.mjs';
import { actorKey, vendorOfActor } from './verify.mjs';

export const FINAL_OBJECTION_STATES = ['rejected', 'withdrawn', 'resolved'];
const VERIFIABLE = ['quote', 'fetch_failure', 'missing_source', 'gone'];
// 每类阻塞异议可用的指针（location 只是文字描述，只能用于 needs_evidence）
const POINTERS_FOR = {
  source_missing: ['fetch_failure', 'missing_source', 'gone'],
  quote_unsupported: ['quote'],
  number_error: ['quote'],
};

// role：judge（裁定）、verified（身份已证实的任何一方）、rule_or_host、host、raiser
const TRANSITIONS = {
  open: { upheld: 'judge', rejected: 'judge', needs_user: 'verified', withdrawn: 'raiser' },
  needs_evidence: { open: 'verified', needs_user: 'rule_or_host', withdrawn: 'raiser' },
  upheld: { resolved: 'verified' },
  needs_user: { open: 'host', upheld: 'host', rejected: 'host', withdrawn: 'host', resolved: 'host' },
};
const NEEDS_RESOLUTION = ['upheld', 'rejected', 'needs_user', 'resolved'];

export const STATE_LABEL = {
  open: '待裁定', needs_evidence: '待补证', upheld: '成立', rejected: '不成立',
  needs_user: '待你决定', withdrawn: '已撤回', resolved: '已解决',
};

// 指针是否有效；有效返回 null。ctx 见 checkObjection
export function pointerProblem(p, target, actor, ctx) {
  switch (p.type) {
    case 'quote': {
      const src = ctx.recordAt(p.source.id, p.source.version);
      if (!src) return { type: 'pointer_source_missing', source: `${p.source.id}@${p.source.version}` };
      const text = ctx.textOf(src);
      if (text == null) return { type: 'pointer_unverifiable', source: p.source.id, note: '该来源版本没有正文快照，引文无法核对' };
      if (!locateQuote(text, p.quote)) return { type: 'pointer_quote_not_found', source: p.source.id, quote: p.quote.slice(0, 80) };
      return null;
    }
    case 'fetch_failure':
      return ctx.fetchFailed(p.source.id, p.attempt) ? null : { type: 'pointer_fetch_failure_not_found', source: p.source.id, attempt: p.attempt, note: '用量账本里没有这次针对该来源的失败抓取' };
    case 'missing_source': {
      const t = ctx.recordAt(target.id, target.version);
      if (kindOfId(target.id) !== 'claim') return { type: 'pointer_not_claim', note: 'missing_source 只能指向论断' };
      return (t?.sources || []).length ? { type: 'pointer_claim_has_sources', target: target.id } : null;
    }
    case 'gone':
      if (actor?.kind !== 'system') return { type: 'pointer_gone_rule_only', note: '“来源已不存在”的异议由规则在主持人确认 gone 时自动提出' };
      return ctx.isGone(p.source.id) ? null : { type: 'pointer_not_gone', source: p.source.id };
    default:
      return null;
  }
}

// 写入检查。next：新版本（已带 raised_by）；prev：上一版本（新建时为 null）；actor：这次提交者（服务端认定）
// ctx：{ records（晋升前的正式状态）, recordAt(id, version), textOf(source), fetchFailed(sourceId, attempt),
//        isGone(sourceId), settled(objection) → 目标是否已改版并重新核验通过 }
export function checkObjection(next, prev, actor, ctx) {
  const reasons = [];
  const r = (type, extra = {}) => reasons.push({ type, id: next.id, ...extra });
  const blocking = BLOCKING_CATEGORIES.includes(next.category);

  if (!prev) {
    const target = ctx.records.get(next.target.id);
    if (!target) r('missing_target', { target: next.target.id });
    else if (target.version !== next.target.version) r('stale_target', { target: next.target.id, based: next.target.version, current: target.version, note: '只能对目标的当前版本提出异议' });
    if (!['open', 'needs_evidence'].includes(next.state)) r('bad_initial_state', { state: next.state, note: '新异议只能是 open 或 needs_evidence' });
    if (next.state === 'needs_evidence' && !blocking) r('needs_evidence_blocking_only', { note: '待补证只用于三类阻塞异议' });
    pointerRules(next, actor, ctx, r);
    return reasons;
  }

  // 已有异议的新版本
  if (canonical(next.target) !== canonical(prev.target)) r('immutable_field', { field: 'target' });
  if (next.category !== prev.category) r('immutable_field', { field: 'category' });
  if (FINAL_OBJECTION_STATES.includes(prev.state)) {
    r('final_state', { state: prev.state, note: '已是终态；需要时另提一条新异议' });
    return reasons;
  }
  const role = TRANSITIONS[prev.state]?.[next.state];
  if (!role) {
    r('bad_transition', { from: prev.state, to: next.state });
    return reasons;
  }
  const pointerChanged = canonical(next.pointer) !== canonical(prev.pointer);
  if (pointerChanged && !(prev.state === 'needs_evidence' && next.state === 'open')) r('immutable_field', { field: 'pointer', note: '指针只在 needs_evidence → open 时补上' });
  if (prev.state === 'needs_evidence' && next.state === 'open') pointerRules(next, actor, ctx, r);
  if (NEEDS_RESOLUTION.includes(next.state) && !next.resolution) r('resolution_required', { note: `转为 ${next.state} 必须写明理由（resolution）` });
  if (next.state === 'resolved' && prev.state === 'upheld' && !ctx.settled(next)) {
    r('not_settled', { target: next.target.id, note: '目标还没有改版，或新版本还没有核验通过' });
  }

  const raiser = prev.raised_by;
  const author = ctx.recordAt(next.target.id, next.target.version)?.provenance ?? null;
  const isHost = actor?.kind === 'human' && actor.verified === true;
  switch (role) {
    case 'host':
      if (!isHost) r('role', { need: 'host', note: '待你决定的异议只能由主持人裁决' });
      break;
    case 'rule_or_host':
      if (!(isHost || (actor?.kind === 'system' && actor.verified))) r('role', { need: 'rule_or_host' });
      break;
    case 'raiser':
      if (!isHost && actorKey(actor) !== actorKey(raiser)) r('role', { need: 'raiser', note: '只有提出者（或主持人）可以撤回' });
      break;
    case 'verified':
      if (!actor?.verified) r('role', { need: 'verified', note: '这一步需要身份已证实的一方（服务派发的任务、主持人或规则）' });
      break;
    case 'judge': {
      if (!actor?.verified || !['server', 'human'].includes(actor.kind)) r('role', { need: 'judge', note: '裁定需要身份已证实的核验者或主持人' });
      else {
        if (actorKey(actor) === actorKey(raiser)) r('judge_is_raiser', { note: '提出者不能裁定自己的异议' });
        if (author && actorKey(actor) === actorKey(author)) r('judge_is_author', { note: '作者不能裁定针对自己的异议' });
        const av = vendorOfActor(author);
        if (!isHost && av !== 'unknown' && av === vendorOfActor(actor)) r('same_vendor', { note: '裁定者必须与作者分属不同厂商' });
      }
      break;
    }
  }
  return reasons;
}

function pointerRules(next, actor, ctx, r) {
  const blocking = BLOCKING_CATEGORIES.includes(next.category);
  const p = next.pointer;
  if (next.state === 'open' && blocking) {
    if (!VERIFIABLE.includes(p.type) || !POINTERS_FOR[next.category].includes(p.type)) {
      r('pointer_type', { category: next.category, pointer: p.type, allowed: POINTERS_FOR[next.category], note: '定位不到原文时提为 needs_evidence' });
      return;
    }
  }
  if (next.state === 'needs_evidence' && p.type !== 'location' && !POINTERS_FOR[next.category]?.includes(p.type)) {
    r('pointer_type', { category: next.category, pointer: p.type });
    return;
  }
  const problem = pointerProblem(p, next.target, actor, ctx);
  if (problem) r(problem.type, problem);
}

export { OBJECTION_STATES };
