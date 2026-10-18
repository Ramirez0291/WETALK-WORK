// DeepSeek Search / Fetch 的工坊封装。
// - Search 只给线索：结果里的 summary / snippet / content 一律不存成来源正文，也不能成为引文的依据。
// - Fetch 抓到的正文存成来源正文快照（blob ＋ 快照登记），需要时经提交入口更新来源卡（升版 → 下游待复核）。
// - 抓取与来源卡的地址绑定：给了 source_id 就从来源卡自己的地址抓；请求里的地址与之不同就拒绝，
//   迁址必须由主持人显式进行（relocate），不会把 B 的正文挂到 A 的出处下面，也不会拿 B 的失败标记 A。
// - Fetch 失败只说明来源暂不可获取：记在用量账本里，可获取性由它派生；已有快照保留，照样可以作证据。
// - 账户限速、预算名额都在客户端里按每次物理请求（含重试）执行；重试策略取项目的生效配置。
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import { blobStore, kindOfId } from './records.mjs';
import { registerSnapshot } from './snapshots.mjs';

export const SYSTEM_FETCH = { kind: 'system', participant: 'web-fetch', verified: true, basis: 'web-fetch' };

// 来源卡里由主持人或抓取维护的业务字段（去掉系统字段后原样带到新版本）
const SOURCE_FIELDS = ['title', 'author', 'edition', 'citation', 'url', 'origin', 'note', 'text_blob', 'retrieved_at'];

// 比较地址时只做 URL 规范化（大小写不敏感的协议与主机、默认端口、空路径），路径和查询原样比较
const sameUrl = (a, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

export function createWebTools({ client, usage, gateway, workbench, timeoutMs = 120_000, now = () => new Date() }) {
  const asHttp = (e, api) => {
    if (e.kind === 'budget') return Object.assign(new WorkbenchError(429, e.message), { details: e.details });
    const status = e.details?.status;
    let mapped = 502; // 限流用尽、5xx、超时、网络、响应结构不对
    if (e.kind === 'invalid' && api === 'fetch') mapped = 404; // 拿不到可用正文
    else if (e.kind === 'http' && (status === 404 || status === 403)) mapped = 404;
    else if (e.kind === 'http' && status >= 400 && status < 500 && status !== 429 && status !== 408) mapped = 400;
    else if (e.kind === 'aborted' || e.kind === 'timeout') mapped = 504;
    return Object.assign(new WorkbenchError(mapped, `DeepSeek ${e.message}`), { details: { kind: e.kind, status: status ?? null, attempts: e.details?.attempts ?? [] } });
  };
  // 每次逻辑调用取项目当时的生效重试策略（快照），不改共享客户端
  const callOpts = (project, meta) => ({ timeoutMs, retry: workbench.get(project).config.retry, ...usage.hooks(project, meta) });

  async function search(project, { query, count, ori_question, need_content = false }) {
    workbench.get(project);
    if (typeof query !== 'string' || !query.trim() || [...query].length > 128) throw new WorkbenchError(400, 'query 必须是 1–128 字的非空字符串');
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50)) throw new WorkbenchError(400, 'count 必须是 1–50 的整数');
    try {
      const r = await client.search({ query, count, ori_question, need_content: !!need_content }, callOpts(project, { query }));
      return {
        // 明确标出：这些只是检索线索，不是证据
        evidence: false,
        note: '搜索结果只作建来源卡的线索；summary、snippet、content 都不能作为引文。需要原文时对 url 调用 Fetch。',
        results: r.results.map((x) => ({
          title: x.title, url: x.url, snippet: x.snippet, summary: x.summary, content: x.content || undefined,
          site_name: x.site_name ?? null, date: x.date ?? null, authority: x.authority ?? null, rerank_score: x.rerank_score ?? null,
        })),
      };
    } catch (e) {
      throw asHttp(e, 'search');
    }
  }

  // { url?, source_id?, create?, relocate? }
  // - source_id：从这张来源卡的地址抓，结果更新到它；url 可省略，给了必须与来源卡地址一致；
  //   relocate = true（只限主持人）：改从 url 抓，并把来源卡的地址一起改掉；来源卡还没有地址时同样需要 relocate。
  // - create：新建来源卡；都不给就只存快照、返回 blob。
  async function fetchUrl(project, { url, source_id, create = false, relocate = false }, { actor = null } = {}) {
    const p = workbench.get(project);
    let current = null;
    let target = url;
    if (source_id !== undefined) {
      if (kindOfId(source_id) !== 'source') throw new WorkbenchError(400, 'source_id 必须是来源编号');
      current = gateway.getRecord(project, source_id).record; // 已提交的版本
      if (relocate) {
        if (actor?.kind !== 'human') throw new WorkbenchError(403, '更改来源卡的地址（relocate）只能由主持人进行');
        if (!url) throw new WorkbenchError(400, 'relocate 需要给出新地址 url');
      } else if (!current.url) {
        throw new WorkbenchError(400, `来源 ${source_id} 没有地址；要给它补地址并抓取，请由主持人以 relocate 进行`);
      } else if (url !== undefined && !sameUrl(url, current.url)) {
        throw new WorkbenchError(400, `url 与来源 ${source_id} 的地址不一致（${current.url}）；迁址请由主持人以 relocate 进行`);
      } else target = current.url;
    } else if (relocate) throw new WorkbenchError(400, 'relocate 只用于已有来源卡');
    if (typeof target !== 'string' || !/^https?:\/\/[^/\s]+/i.test(target) || target.length > 8192) throw new WorkbenchError(400, 'url 必须是 http(s) 地址，且不超过 8192 字');
    if (/^https?:\/\/[^/]*@/i.test(target)) throw new WorkbenchError(400, 'url 里不能带用户名或密码');

    // 只有地址与来源卡绑定的抓取才计入这张来源卡的可获取性
    const meta = { url: target, ...(current ? { source_id } : {}) };
    let page;
    try {
      page = await client.fetchPage(target, callOpts(project, meta));
    } catch (e) {
      const err = asHttp(e, 'fetch');
      if (current) {
        err.details.availability = usage.availabilityOf(project).get(source_id) ?? null;
        err.details.snapshot_kept = !!current.text_blob;
      }
      throw err;
    }
    const blob = blobStore(p.dir).put(page.content);
    const retrieved_at = now().toISOString();
    registerSnapshot(p.dir, { blob, origin: 'fetch', url: target, title: page.title || null, retrieved_at, service: 'deepseek-fetch' });
    const base = { url: target, title: page.title || null, text_blob: blob, chars: page.content.length, retrieved_at };

    const submitSource = async (change) => {
      const receipt = gateway.receive(project, { request_id: `fetch-${crypto.randomUUID()}`, changes: [change] }, { actor: relocate ? actor : SYSTEM_FETCH });
      return gateway.promote(project, receipt.sid);
    };
    if (current) {
      if (current.text_blob === blob && !relocate) return { ...base, source: { id: source_id, version: current.version, changed: false } };
      const data = {};
      for (const k of SOURCE_FIELDS) if (current[k] !== undefined) data[k] = current[k];
      Object.assign(data, { text_blob: blob, retrieved_at, url: target });
      const r = await submitSource({ id: source_id, expected_version: current.version, data });
      return { ...base, source: { ...r.records[0], changed: true, cid: r.cid, relocated: !!relocate } };
    }
    if (create) {
      const r = await submitSource({ kind: 'source', expected_version: 0, data: { title: page.title || target, url: target, text_blob: blob, retrieved_at } });
      return { ...base, source: { ...r.records[0], changed: true, cid: r.cid } };
    }
    return base;
  }

  return { search, fetch: fetchUrl };
}
