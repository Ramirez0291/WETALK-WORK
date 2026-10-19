// 契约一里由规则驱动的两件事（规则只执行，不做内容判断）：
// 1. 补证：异议处于 needs_evidence 时，生成补证任务（find_evidence，每个任务只做一次）；
//    最近一个补证任务结束后异议仍待补证，就再生成一个，直到 evidence.maxAttempts 个；用完后由规则把异议转为 needs_user。
// 2. 来源已不存在：主持人确认来源 gone 后，对每条（当前版本）引用它的论断提出“来源不存在”异议；
//    主持人撤销 gone 确认时，规则撤回自己提出、还没结束的这类异议。
// 规则的写入同样经提交入口晋升，身份是 system（workbench-rules），request_id 由内容决定，重复执行不会写两次。
// reconcile 按项目串行执行；执行中又被触发时，结束后再跑一遍。
import { kindOfId } from './records.mjs';
import { FINAL_OBJECTION_STATES } from './objections.mjs';

export const RULES_ACTOR = { kind: 'system', participant: 'workbench-rules', verified: true, basis: 'rule' };

export function createEvidenceFlow({ workbench, gateway, board, availabilityOf = () => new Map(), onError = (e) => console.error('[工坊] 规则执行出错：', e) }) {
  const busy = new Map(); // project -> { again }
  const FINAL_TASK = new Set(['done', 'failed', 'cancelled']);

  async function write(project, requestId, change) {
    const receipt = gateway.receive(project, { request_id: requestId, changes: [change] }, { actor: RULES_ACTOR });
    return gateway.promote(project, receipt.sid);
  }

  function evidenceTasks(project, objectionId) {
    return board.list(project).filter((t) => t.type === 'find_evidence' && t.inputs.some((i) => i.id === objectionId));
  }

  async function once(project) {
    const records = new Map(gateway.listRecords(project).map((x) => [x.record.id, x.record]));
    const objections = [...records.values()].filter((r) => kindOfId(r.id) === 'objection');
    const max = workbench.get(project).config.evidence.maxAttempts;
    const done = [];
    // 每一项单独执行：某一条被拒（例如状态已被别人改过）不影响其余各条，错误在本轮结束后统一报告
    const act = async (entry, fn) => {
      try {
        const extra = await fn();
        done.push({ ...entry, ...(extra ?? {}) });
      } catch (e) {
        done.push({ ...entry, action: 'error', failed: entry.action, error: e.message, reasons: e.details?.reasons ?? null });
      }
    };

    // ---- 补证
    for (const o of objections) {
      if (o.state !== 'needs_evidence') continue;
      const tasks = evidenceTasks(project, o.id);
      if (tasks.some((t) => !FINAL_TASK.has(t.state))) continue; // 还有补证任务在进行
      if (tasks.length < max) {
        // 补证针对的是异议所指的那个版本：任务输入固定为 o.target（目标后来改版也一样），
        // 任务包按这个版本附上当时所引的来源与正文
        await act({ action: 'evidence_task', objection: o.id }, () => ({ task: board.create(project, {
          type: 'find_evidence',
          title: `为异议 ${o.id} 补证（第 ${tasks.length + 1}/${max} 次）`,
          goal: `异议 ${o.id}（${o.category}）针对 ${o.target.id}@${o.target.version}，暂时定位不到原文：${o.reason}\n请在给出的来源正文里找到能定位的原文，把 ${o.id} 改为 open 并给出有效指针；找不到就如实说明，不要编造引文。`,
          inputs: [{ id: o.id, version: o.version }, { id: o.target.id, version: o.target.version }],
        }, { created_by: RULES_ACTOR, maxAttempts: 1 }).id }));
      } else {
        await act({ action: 'evidence_limit', objection: o.id }, () => write(project, `rule-evidence-limit-${o.id}-v${o.version}`, {
          id: o.id, expected_version: o.version,
          data: { target: o.target, category: o.category, pointer: o.pointer, reason: o.reason, state: 'needs_user', resolution: `补证任务已做 ${tasks.length} 次（上限 ${max}），仍定位不到原文，交由主持人裁决` },
        }).then(() => null));
      }
    }

    // ---- 来源已不存在
    const avail = availabilityOf(project, (id) => records.get(id)?.url ?? null);
    const gone = new Set([...avail].filter(([, a]) => a.state === 'gone').map(([id]) => id));
    const byRule = objections.filter((o) => o.raised_by?.kind === 'system' && o.pointer?.type === 'gone');
    for (const claim of records.values()) {
      if (kindOfId(claim.id) !== 'claim') continue;
      for (const s of claim.sources || []) {
        if (!gone.has(s.id)) continue;
        const open = byRule.some((o) => o.target.id === claim.id && o.pointer.source.id === s.id && !FINAL_OBJECTION_STATES.includes(o.state));
        // 同一论断版本上已被核验者驳回过的不再重提（规则因撤销 gone 而撤回的不算，重新确认 gone 时照样再提）
        const rejected = byRule.some((o) => o.target.id === claim.id && o.target.version === claim.version && o.pointer.source.id === s.id && o.state === 'rejected');
        if (open || rejected) continue;
        const n = objections.filter((o) => o.target.id === claim.id).length;
        await act({ action: 'gone_objection', claim: claim.id, source: s.id }, () => write(project, `rule-gone-${claim.id}-v${claim.version}-${s.id}-${n}`, {
          kind: 'objection', expected_version: 0,
          data: { target: { id: claim.id, version: claim.version }, category: 'source_missing', pointer: { type: 'gone', source: { id: s.id } }, reason: `主持人确认来源 ${s.id} 已不存在`, state: 'open' },
        }).then(() => null));
      }
    }
    for (const o of byRule) {
      if (FINAL_OBJECTION_STATES.includes(o.state) || o.state === 'upheld' || gone.has(o.pointer.source.id)) continue;
      // 撤回包括已转待你决定的（规则撤回自己因 gone 提出的异议是状态机里唯一的例外）；成立的保留
      await act({ action: 'gone_withdrawn', objection: o.id }, () => write(project, `rule-ungone-${o.id}-v${o.version}`, {
        id: o.id, expected_version: o.version,
        data: { target: o.target, category: o.category, pointer: o.pointer, reason: o.reason, state: 'withdrawn', resolution: `主持人撤销了来源 ${o.pointer.source.id} 的 gone 确认` },
      }).then(() => null));
    }
    return done;
  }

  // 触发一次（可重复调用）；返回本轮做了什么
  async function reconcile(project) {
    if (busy.has(project)) {
      busy.get(project).again = true;
      return [];
    }
    const state = { again: false };
    busy.set(project, state);
    const all = [];
    try {
      do {
        state.again = false;
        all.push(...(await once(project)));
      } while (state.again);
    } finally {
      busy.delete(project);
    }
    for (const x of all.filter((a) => a.action === 'error')) onError(Object.assign(new Error(`规则 ${x.failed} 没能执行：${x.error}`), { details: x }));
    return all;
  }

  // 事件驱动的触发：出错只记日志，不影响触发它的那次写入
  function poke(project) {
    setImmediate(() => reconcile(project).catch(onError));
  }

  return { reconcile, poke };
}
