// 派生状态：based_on、反向索引、新鲜度、核验状态、未解决阻塞、可进入成品。
// 全部由记录当场算出，从不写回文件，所以崩溃在“写完上游、还没标记下游”之间也不会留下不一致。
// 纯函数：输入 Map<id, record>，输出派生结果，不碰磁盘。
// external：正式文件被服务进程之外改过或删掉的记录（id -> 'modified' / 'deleted'）。这些记录按已提交的内容参与计算，
// 但本身和全部下游都算 stale，直到主持人处理完。
import { kindOfId, refsOf, WORK_KINDS } from './records.mjs';

// 三类事实性异议才阻塞；解释争议、叙事选择、可选扩展永不阻塞
export const BLOCKING_CATEGORIES = ['source_missing', 'number_error', 'quote_unsupported'];
export const BLOCKING_STATES = ['open', 'needs_evidence', 'upheld', 'needs_user'];

export function derive(records, { external = new Map() } = {}) {
  const basedOn = new Map();
  const downstream = new Map();
  for (const [id, rec] of records) {
    const refs = refsOf(rec);
    basedOn.set(id, refs);
    for (const r of refs) {
      if (!downstream.has(r.id)) downstream.set(r.id, new Set());
      downstream.get(r.id).add(id);
    }
  }

  // ---- 新鲜度：直接引用的版本落后，或任一上游本身不是 current，都是 stale（多级传播）。
  // 引用不存在的记录也算 stale；循环引用整圈标为 stale 并报告。
  const freshness = new Map(); // id -> { state, reasons[] }
  const cycles = [];
  const visiting = new Set();
  function fresh(id, trail) {
    if (freshness.has(id)) return freshness.get(id);
    if (visiting.has(id)) {
      const cycle = trail.slice(trail.indexOf(id));
      cycles.push(cycle);
      return { state: 'stale', reasons: [{ type: 'cycle', cycle }] };
    }
    visiting.add(id);
    const reasons = [];
    if (external.has(id)) reasons.push({ type: 'external', change: external.get(id) });
    for (const r of basedOn.get(id) || []) {
      const up = records.get(r.id);
      if (!up) {
        reasons.push({ type: 'missing', id: r.id });
        continue;
      }
      if (up.version !== r.version) reasons.push({ type: 'version', id: r.id, based: r.version, current: up.version });
      const f = fresh(r.id, [...trail, id]);
      if (f.state !== 'current') reasons.push({ type: 'upstream', id: r.id });
    }
    visiting.delete(id);
    const result = { state: reasons.length ? 'stale' : 'current', reasons };
    freshness.set(id, result);
    return result;
  }
  for (const id of records.keys()) fresh(id, []);

  // ---- 核验状态：只计入绑定“当前论断版本 ＋ 每个来源的当前版本”的核验记录
  const verificationsOf = new Map();
  const objectionsOf = new Map();
  for (const rec of records.values()) {
    const kind = kindOfId(rec.id);
    const target = rec.target?.id;
    if (kind === 'verification' && target) (verificationsOf.get(target) ?? verificationsOf.set(target, []).get(target)).push(rec);
    if (kind === 'objection' && target) (objectionsOf.get(target) ?? objectionsOf.set(target, []).get(target)).push(rec);
  }

  const verification = new Map(); // claimId -> { state, counted: [V ids] }
  const blockers = new Map(); // id -> [O ids]
  for (const [id, rec] of records) {
    if (kindOfId(id) !== 'claim') continue;
    const counted = (verificationsOf.get(id) || []).filter((v) => {
      if (v.target.version !== rec.version) return false;
      const bound = new Map((v.source_versions || []).map((s) => [s.id, s.version]));
      return (rec.sources || []).every((s) => {
        const cur = records.get(s.id);
        return cur && bound.get(s.id) === cur.version;
      });
    });
    const verdicts = new Set(counted.map((v) => v.verdict));
    let state = 'unreviewed';
    if (counted.length) {
      if (verdicts.size === 1 && verdicts.has('supported')) state = 'supported';
      else if (verdicts.size === 1 && verdicts.has('unsupported')) state = 'unsupported';
      else state = 'disputed';
    }
    verification.set(id, { state, counted: counted.map((v) => v.id) });
  }
  for (const [id] of records) {
    const open = (objectionsOf.get(id) || []).filter((o) => BLOCKING_CATEGORIES.includes(o.category) && BLOCKING_STATES.includes(o.state));
    blockers.set(id, open.map((o) => o.id));
  }

  // ---- 可进入成品：论断 = supported ＋ current ＋ 无阻塞；作品 = current ＋ 无阻塞 ＋ 引用的论断全部可进入
  const ready = new Map();
  for (const [id, rec] of records) {
    const kind = kindOfId(id);
    const isCurrent = freshness.get(id).state === 'current';
    if (kind === 'claim') {
      ready.set(id, verification.get(id).state === 'supported' && isCurrent && blockers.get(id).length === 0);
    }
  }
  for (const [id, rec] of records) {
    if (!WORK_KINDS.includes(kindOfId(id))) continue;
    const claimsReady = (rec.claims || []).every((c) => ready.get(c.id) === true);
    ready.set(id, freshness.get(id).state === 'current' && blockers.get(id).length === 0 && claimsReady);
  }

  return { basedOn, downstream, freshness, verification, blockers, ready, cycles };
}

// 一条记录的派生状态，供接口返回
export function statusOf(d, id) {
  const s = {
    based_on: d.basedOn.get(id) || [],
    downstream: [...(d.downstream.get(id) || [])].sort(),
    freshness: d.freshness.get(id)?.state ?? 'current',
    stale_reasons: d.freshness.get(id)?.reasons ?? [],
    blockers: d.blockers.get(id) || [],
  };
  if (d.verification.has(id)) s.verification = d.verification.get(id);
  if (d.ready.has(id)) s.ready = d.ready.get(id);
  return s;
}

// 汇总：每种记录数、论断核验分布、stale 数、可进入成品数
export function summarize(records, d) {
  const byKind = {};
  for (const id of records.keys()) {
    const k = kindOfId(id);
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const claims = { unreviewed: 0, supported: 0, disputed: 0, unsupported: 0 };
  for (const v of d.verification.values()) claims[v.state]++;
  let stale = 0;
  for (const f of d.freshness.values()) if (f.state === 'stale') stale++;
  let ready = 0;
  for (const r of d.ready.values()) if (r) ready++;
  let blocked = 0;
  for (const b of d.blockers.values()) if (b.length) blocked++;
  return { byKind, claims, stale, ready, blocked, cycles: d.cycles.length };
}
