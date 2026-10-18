// DeepSeek Search / Fetch 的工坊封装。
// - Search 只给线索：结果里的 summary / snippet / content 一律不存成来源正文，也不能成为引文的依据。
// - Fetch 抓到的正文存成来源正文快照（blob），需要时经提交入口更新来源卡（升版 → 下游待复核）。
// - Fetch 失败只说明来源暂不可获取：记在用量账本里，可获取性由它派生；已有快照保留，照样可以作证据。
// - 遵守账户限速：Search、Fetch 各自每秒 5 次，所有项目共用。
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';
import { blobStore, kindOfId } from './records.mjs';
import { createRateLimiter } from './deepseek.mjs';

export const SYSTEM_FETCH = { kind: 'system', participant: 'web-fetch', verified: true, basis: 'web-fetch' };

// 来源卡里由主持人或抓取维护的业务字段（去掉系统字段后原样带到新版本）
const SOURCE_FIELDS = ['title', 'author', 'edition', 'citation', 'url', 'origin', 'note', 'text_blob', 'retrieved_at'];

export function createWebTools({ client, usage, gateway, workbench, perSecond = 5, timeoutMs = 120_000, now = () => new Date() }) {
  const limiter = { search: createRateLimiter(perSecond), fetch: createRateLimiter(perSecond) };
  const asHttp = (e) => {
    if (e.kind === 'budget') return Object.assign(new WorkbenchError(429, e.message), { details: e.details });
    const status = e.details?.status;
    // 上游的请求错误（4xx）原样转成 400/404；其余（限流用尽、5xx、超时、网络）算 502
    const mapped = status === 404 || status === 403 ? 404 : status >= 400 && status < 500 && status !== 429 && status !== 408 ? 400 : 502;
    return Object.assign(new WorkbenchError(mapped, `DeepSeek ${e.message}`), { details: { kind: e.kind, status: status ?? null, attempts: e.details?.attempts ?? [] } });
  };

  async function search(project, { query, count, ori_question, need_content = false }) {
    workbench.get(project);
    if (typeof query !== 'string' || !query.trim() || [...query].length > 128) throw new WorkbenchError(400, 'query 必须是 1–128 字的非空字符串');
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50)) throw new WorkbenchError(400, 'count 必须是 1–50 的整数');
    await limiter.search.take();
    try {
      const r = await client.search({ query, count, ori_question, need_content: !!need_content }, { timeoutMs, ...usage.hooks(project, { query }) });
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
      throw asHttp(e);
    }
  }

  // source_id：抓取结果更新到这张来源卡；create：没有来源卡时新建一张。都不给就只存快照、返回 blob。
  async function fetchUrl(project, { url, source_id, create = false }) {
    const p = workbench.get(project);
    if (typeof url !== 'string' || !/^https?:\/\/[^/\s]+/i.test(url) || url.length > 8192) throw new WorkbenchError(400, 'url 必须是 http(s) 地址，且不超过 8192 字');
    if (/^https?:\/\/[^/]*@/i.test(url)) throw new WorkbenchError(400, 'url 里不能带用户名或密码');
    let current = null;
    if (source_id !== undefined) {
      if (kindOfId(source_id) !== 'source') throw new WorkbenchError(400, 'source_id 必须是来源编号');
      current = gateway.getRecord(project, source_id).record; // 已提交的版本
    }
    await limiter.fetch.take();
    let page;
    try {
      page = await client.fetchPage(url, { timeoutMs, ...usage.hooks(project, { url, ...(source_id ? { source_id } : {}) }) });
    } catch (e) {
      const err = asHttp(e);
      if (current) {
        err.details.availability = usage.availabilityOf(project).get(source_id) ?? null;
        err.details.snapshot_kept = !!current.text_blob;
      }
      throw err;
    }
    if (!page.content) throw new WorkbenchError(404, 'Fetch 没有拿到正文');
    const blob = blobStore(p.dir).put(page.content);
    const retrieved_at = now().toISOString();
    const base = { url, title: page.title || null, text_blob: blob, chars: page.content.length, retrieved_at };

    const submitSource = async (change) => {
      const receipt = gateway.receive(project, { request_id: `fetch-${crypto.randomUUID()}`, changes: [change] }, { actor: SYSTEM_FETCH });
      return gateway.promote(project, receipt.sid);
    };
    if (current) {
      if (current.text_blob === blob) return { ...base, source: { id: source_id, version: current.version, changed: false } };
      const data = {};
      for (const k of SOURCE_FIELDS) if (current[k] !== undefined) data[k] = current[k];
      Object.assign(data, { text_blob: blob, retrieved_at, url: current.url ?? url });
      const r = await submitSource({ id: source_id, expected_version: current.version, data });
      return { ...base, source: { ...r.records[0], changed: true, cid: r.cid } };
    }
    if (create) {
      const r = await submitSource({ kind: 'source', expected_version: 0, data: { title: page.title || url, url, text_blob: blob, retrieved_at } });
      return { ...base, source: { ...r.records[0], changed: true, cid: r.cid } };
    }
    return base;
  }

  return { search, fetch: fetchUrl };
}
