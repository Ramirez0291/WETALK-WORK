// 核验（契约一第二步）：核验记录的写入检查与份数计算。全部是纯函数，提交入口在晋升时调用写入检查，
// deps.mjs 用份数计算派生论断的核验状态。
// - 写入检查：目标是论断的当前版本；source_versions 正好是论断所引的每个来源的当前版本；
//   判为 supported 时附的支持引文出自论断所引的来源、能在该版本的正文快照里找到；核验者与作者不能同厂商。
// - 份数：只计入绑定当前论断版本与来源版本、身份已证实、与作者跨厂商的记录；同一核验者只算最新的一份。
//   主持人（human）算一个核验者。身份未证实（MCP 外部会话）或厂商推断不出的记录照样保存，但不计入。
import { locateQuote } from './records.mjs';
import { vendorOf } from './vendors.mjs';

// 记录里保存的身份摘要（核验者、异议提出者）：只取服务端认定的字段
export function actorSummary(prov) {
  if (!prov) return { kind: 'unknown', participant: null, vendor: 'unknown', verified: false };
  const out = { kind: prov.kind ?? 'unknown', participant: prov.participant ?? null, vendor: vendorOfActor(prov), verified: prov.verified === true };
  if (prov.model) out.model = prov.model;
  if (prov.reported_model) out.reported_model = prov.reported_model;
  // 实际报告的厂商与配置冲突：厂商取报告的，配置的另记，计数时标为待确认
  if (prov.vendor_conflict) Object.assign(out, { vendor_conflict: true, configured_vendor: prov.configured_vendor ?? null });
  if (prov.basis) out.basis = prov.basis;
  return out;
}

export function vendorOfActor(prov) {
  if (!prov) return 'unknown';
  if (prov.kind === 'human') return 'human';
  if (prov.vendor && prov.vendor !== 'unknown') return prov.vendor;
  return vendorOf(prov);
}

// 同一个核验者：主体类型＋参与者
export const actorKey = (a) => `${a?.kind ?? 'unknown'}:${a?.participant ?? '?'}`;

// 一条记录的作者集合（内容来源关系）：各版本内容来源的并集，由提交入口写进 authors。
// 人工小改、换人改写都不会抹掉之前的作者；早期没有 authors 的记录退回到当前版本的 provenance。
// 规则与抓取（system）不是内容作者，不参与厂商判断。
export function authorsOf(rec) {
  const list = Array.isArray(rec?.authors) && rec.authors.length ? rec.authors : rec?.provenance ? [rec.provenance] : [];
  return list.filter((a) => a && a.kind !== 'system');
}

// 能否计入份数（或能否裁定针对这条记录的异议）；能计入返回 null，否则返回原因。
// authors：作者集合（authorsOf）。is_author、same_vendor 在写入时就被拒绝
export function eligibility(verifier, authors) {
  const list = (Array.isArray(authors) ? authors : [authors]).filter((a) => a && a.kind !== 'system');
  const vv = vendorOfActor(verifier);
  for (const a of list) {
    if (actorKey(a) === actorKey(verifier)) return 'is_author';
    if (vv !== 'unknown' && vv === vendorOfActor(a)) return 'same_vendor';
  }
  if (!verifier?.verified) return 'identity_unverified';
  if (vv === 'unknown') return 'vendor_unknown';
  if (verifier.vendor_conflict) return 'vendor_conflict';
  if (vv !== 'human' && list.some((a) => vendorOfActor(a) === 'unknown')) return 'author_vendor_unknown';
  return null;
}
export const WRITE_REJECTED = ['is_author', 'same_vendor'];

export const ELIGIBILITY_LABEL = {
  is_author: '核验者是这条论断（某个版本）的作者',
  vendor_conflict: '这次调用实际报告的模型与配置的厂商不一致，待确认',
  same_vendor: '核验者与作者同厂商',
  identity_unverified: '核验者身份未证实（MCP 外部会话）',
  vendor_unknown: '推断不出核验者的厂商',
  author_vendor_unknown: '推断不出作者的厂商，无法确认跨厂商',
};

const idNumber = (id) => Number(String(id).replace(/^\D+/, ''));

// 核验记录绑定的来源版本是否正好是论断当前所引来源的当前版本
function boundToCurrent(v, claim, records) {
  const bound = new Map((v.source_versions || []).map((s) => [s.id, s.version]));
  if (bound.size !== (claim.sources || []).length) return false;
  return (claim.sources || []).every((s) => {
    const cur = records.get(s.id);
    return cur && bound.get(s.id) === cur.version && s.version === cur.version;
  });
}

// 一条论断的核验状态。verifs：指向它的全部核验记录；required：{ core, other }
export function countVerifications(claim, verifs, records, required = { core: 2, other: 1 }) {
  const need = claim.core ? required.core : required.other;
  // 按编号的数值排序（编号会长到四位以上，字符串排序会把 V1000 排到 V999 前面）
  const bound = verifs.filter((v) => v.target.version === claim.version && boundToCurrent(v, claim, records)).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const uncounted = [];
  const latest = new Map(); // 核验者 -> 最新一份
  for (const v of bound) {
    const verifier = v.verifier ?? v.provenance;
    const why = eligibility(verifier, authorsOf(claim));
    if (why) {
      uncounted.push({ id: v.id, reason: why });
      continue;
    }
    const key = actorKey(verifier);
    if (latest.has(key)) uncounted.push({ id: latest.get(key).id, reason: 'superseded' });
    latest.set(key, v);
  }
  const counted = [...latest.values()];
  const verdicts = new Set(counted.map((v) => v.verdict));
  let state = 'unreviewed';
  if (counted.length) {
    if (verdicts.size === 1 && verdicts.has('supported')) state = 'supported';
    else if (verdicts.size === 1 && verdicts.has('unsupported')) state = 'unsupported';
    else state = 'disputed';
  }
  const independent = counted.filter((v) => v.verdict === 'supported').length;
  return { state, counted: counted.map((v) => v.id), independent, required: need, enough: state === 'supported' && independent >= need, uncounted };
}

// 写入检查。ctx：{ records（晋升前的正式状态）, textOf(sourceRecord) → 正文或 null }
// rec 已带 verifier（提交入口按服务端身份填写）
export function checkVerification(rec, ctx) {
  const reasons = [];
  const claim = ctx.records.get(rec.target.id);
  if (!claim) return [{ type: 'missing_target', id: rec.id, target: rec.target.id }];
  if (claim.version !== rec.target.version) reasons.push({ type: 'stale_target', id: rec.id, target: rec.target.id, based: rec.target.version, current: claim.version });

  const want = new Map((claim.sources || []).map((s) => [s.id, s.version]));
  const got = new Map(rec.source_versions.map((s) => [s.id, s.version]));
  const sameSet = want.size === got.size && [...want].every(([id]) => got.has(id));
  if (!sameSet) reasons.push({ type: 'source_versions_mismatch', id: rec.id, expected: [...want.keys()], got: [...got.keys()], note: 'source_versions 必须正好列出论断所引的每个来源' });
  for (const [id, version] of got) {
    const cur = ctx.records.get(id);
    if (!cur) reasons.push({ type: 'missing_dependency', id: rec.id, ref: id });
    else if (cur.version !== version) reasons.push({ type: 'stale_dependency', id: rec.id, ref: id, based: version, current: cur.version });
    else if (want.has(id) && want.get(id) !== cur.version) reasons.push({ type: 'claim_stale', id: rec.id, target: claim.id, note: `论断引用的 ${id} 不是当前版本，先更新论断再核验` });
  }

  if (rec.verdict === 'supported') {
    const q = rec.support_quote;
    if (!want.has(q.id)) reasons.push({ type: 'support_quote_foreign', id: rec.id, source: q.id, note: '支持引文必须出自论断所引的来源' });
    else {
      const src = ctx.records.get(q.id);
      const text = src && src.version === q.version ? ctx.textOf(src) : null;
      if (text == null) reasons.push({ type: 'quote_unverifiable', id: rec.id, source: q.id, note: '该来源版本没有正文快照，支持引文无法核对' });
      else if (!locateQuote(text, q.quote)) reasons.push({ type: 'quote_not_found', id: rec.id, source: q.id, quote: q.quote.slice(0, 80) });
    }
  }

  const why = eligibility(rec.verifier, authorsOf(claim));
  if (WRITE_REJECTED.includes(why)) {
    reasons.push({ type: why, id: rec.id, vendor: vendorOfActor(rec.verifier), authors: authorsOf(claim).map((a) => `${a.participant}（${vendorOfActor(a)}）`), note: why === 'is_author' ? '作者不能核验自己写过的论断' : '核验者必须与论断的每一位作者分属不同厂商' });
  }
  return reasons;
}
