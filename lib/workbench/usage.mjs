// 项目的 API 用量账本与预算（契约三的“上限”中与 API 相关的部分），以及来源可获取性。
//
// <项目>/usage.jsonl：每一次物理请求（对话、Search、Fetch，含失败与重试）两行——
//   { id, phase: 'start', … }：发请求之前写入，同时占用一个调用名额；
//   { id, phase: 'end', ok, status, usd, … }：结束后结算这个名额（只结算，不再计数）。
// 调用次数 = start 行数（含正在进行和服务中途退出、没来得及结算的），所以是硬上限：
// 检查与占用在同一个同步步骤里完成，并发的调用不会看到同一份剩余额度；中途退出也按已发送保守计数。
// 费用 = end 行的 usd 之和。费用要等返回才知道，所以是软上限：并发在途的请求都可能在上限之下出发，
// 超出量最多是这些在途请求的费用之和。
//
// <项目>/availability.jsonl：主持人对来源可获取性的确认（gone / available）。
// 来源可获取性由这两份记录派生：主持人确认 gone 优先；否则看最近一次与该来源地址绑定的 Fetch 结果。
// 不写进来源卡，所以 Fetch 失败不会让来源升版、也不会让下游失效——已有快照照样可以作证据。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentError } from '../agents.mjs';
import { chatCost, webCost } from './deepseek.mjs';

// 比较地址时只做 URL 规范化（协议与主机大小写、默认端口、空路径），路径和查询原样比较；都没有地址也算相同
export const sameUrl = (a, b) => {
  if (!a || !b) return !a && !b;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {} // 半行：最后一次写入没写完，忽略
  }
  return out;
}

function append(file, line) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  // 上一次写入断在半行时，先补一个换行，免得这一行接在半行后面
  if (size) {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    fs.closeSync(fd);
    if (b[0] !== 10) fs.appendFileSync(file, '\n');
  }
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

// workbench：取项目目录和生效配置；pricing：全局价目；now：可注入时钟
export function createUsage({ workbench, pricing, now = () => new Date() }) {
  const cache = new Map(); // project -> { calls, usd, attempts: Map<id, entry> }

  function ledger(project) {
    if (!cache.has(project)) {
      const attempts = new Map();
      let calls = 0;
      let usd = 0;
      let lineNo = 0;
      for (const line of readLines(path.join(workbench.get(project).dir, 'usage.jsonl'))) {
        lineNo++;
        if (!line.phase) {
          // 第一版 WP3 的单行格式（每次尝试一行、已结算）：照样计数和计费，按行号给一个稳定的 id。
          // 只读兼容、不改写文件，所以重启多少次都不会重复计数
          const id = line.id ?? `legacy-${lineNo}`;
          calls++;
          usd += line.usd || 0;
          attempts.set(id, { ...line, id, settled: true, legacy: true });
        } else if (line.phase === 'start') {
          calls++;
          attempts.set(line.id, { ...line, settled: false });
        } else if (line.phase === 'end') {
          usd += line.usd || 0;
          const a = attempts.get(line.id);
          if (a) Object.assign(a, line, { phase: undefined, settled: true });
          else attempts.set(line.id, { ...line, settled: true }); // 没有 start 的结算行（不应出现）：只算费用
        }
      }
      cache.set(project, { calls, usd, attempts });
    }
    return cache.get(project);
  }

  const totals = (project) => {
    const l = ledger(project);
    const { budget } = workbench.get(project).config;
    return { calls: l.calls, usd: l.usd, limits: { calls: budget.calls, usd: budget.apiUsd } };
  };

  function check(project) {
    const t = totals(project);
    if (t.calls >= t.limits.calls) throw new AgentError('budget', `项目 ${project} 的调用次数已到上限（${t.calls}/${t.limits.calls}），需要你决定是否提高上限`, { budget: t });
    if (t.usd >= t.limits.usd) throw new AgentError('budget', `项目 ${project} 的 API 费用已到上限（$${t.usd.toFixed(4)}/$${t.limits.usd}），需要你决定是否提高上限`, { budget: t });
  }

  // 检查并占用一个调用名额：同步完成，中间不会插进别的调用；start 行在发请求之前落盘
  function reserve(project, meta) {
    check(project);
    const l = ledger(project);
    const line = { id: crypto.randomBytes(6).toString('hex'), phase: 'start', at: now().toISOString(), ...meta };
    append(path.join(workbench.get(project).dir, 'usage.jsonl'), line);
    l.calls++;
    l.attempts.set(line.id, { ...line, settled: false });
    return line.id;
  }

  function settle(project, id, result) {
    const l = ledger(project);
    const a = l.attempts.get(id);
    if (!a || a.settled) return; // 只结算一次
    const line = { id, phase: 'end', at: now().toISOString(), ...result };
    append(path.join(workbench.get(project).dir, 'usage.jsonl'), line);
    l.usd += line.usd || 0;
    Object.assign(a, line, { phase: undefined, settled: true });
  }

  // 给 DeepSeek 客户端用的两个钩子（每次逻辑调用一组）：发请求前占名额，结束后结算（含失败与重试）
  function hooks(project, meta = {}) {
    let current = null;
    return {
      beforeAttempt: ({ api, attempt }) => {
        current = reserve(project, { api, attempt, ...meta });
      },
      onAttempt: ({ api, ok, status, error, data }) => {
        if (!current) return;
        let usd = 0;
        let usage = null;
        if (api === 'chat') {
          usage = data?.usage ?? null;
          usd = usage ? chatCost(usage, data?.model ?? meta.model, pricing, now()).usd : 0;
        } else usd = webCost(api, ok, data, pricing);
        const result = { ok, status, usd };
        if (usage) result.usage = usage;
        if (error) result.error = String(error).slice(0, 300);
        if (api === 'search' && ok) result.results = data?.results?.length ?? 0;
        settle(project, current, result);
        current = null;
      },
    };
  }

  // 每次尝试合并成一条（start 的元数据 ＋ end 的结果）；没结算的标 settled: false
  const entries = (project) => [...ledger(project).attempts.values()].sort((a, b) => a.at.localeCompare(b.at));

  // ---------- 来源可获取性 ----------

  // urlOf(id)：来源卡当前（已提交）的地址。只有抓取地址与之相同的事件才算这张来源卡的可获取性：
  // 迁址失败、迁址成功前在途的旧地址请求、晋升冲突的抓取，都不会改变来源卡现在那个地址的状态。
  // 主持人的确认同样带着确认时的地址；旧版没有地址的确认对任何地址都有效。
  // urlOf 必须给：漏传时宁可报错，也不悄悄退回“不按地址过滤”。
  function availabilityOf(project, { urlOf } = {}) {
    if (typeof urlOf !== 'function') throw new Error('availabilityOf 需要 urlOf（来源卡当前地址）');
    const dir = workbench.get(project).dir;
    const matches = (id, url, legacyNoUrl = false) => legacyNoUrl || sameUrl(url, urlOf(id));
    const events = [
      ...entries(project)
        .filter((e) => e.api === 'fetch' && e.source_id && e.settled && matches(e.source_id, e.url))
        .map((e) => ({ at: e.at, id: e.source_id, kind: 'fetch', ok: e.ok, status: e.status, error: e.error })),
      ...readLines(path.join(dir, 'availability.jsonl'))
        .filter((e) => matches(e.id, e.url, !('url' in e)))
        .map((e) => ({ ...e, kind: 'mark' })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const state = new Map(); // id -> { state, since, reason }
    for (const e of events) {
      const cur = state.get(e.id);
      if (e.kind === 'mark') state.set(e.id, { state: e.state, since: e.at, by: e.by ?? null, note: e.note ?? null });
      else if (cur?.state === 'gone') continue; // 主持人确认已不存在：抓取结果不改变它，只能由主持人撤销
      else if (e.ok) state.set(e.id, { state: 'available', since: e.at });
      else state.set(e.id, { state: 'temporarily_unavailable', since: e.at, reason: e.error ?? `HTTP ${e.status}` });
    }
    return state;
  }

  // url：确认时来源卡的地址（确认针对的是这个地址）
  function mark(project, sourceId, state, { by, note, url = null } = {}) {
    if (!['gone', 'available'].includes(state)) throw Object.assign(new Error('state 只能是 gone 或 available'), { status: 400 });
    const line = { at: now().toISOString(), id: sourceId, url, state, by: by ?? null, note: note ?? null };
    append(path.join(workbench.get(project).dir, 'availability.jsonl'), line);
    return line;
  }

  return { totals, check, reserve, settle, hooks, availabilityOf, mark, entries };
}
