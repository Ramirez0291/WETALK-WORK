// 项目的 API 用量账本与预算（契约三的“上限”中与 API 相关的部分），以及来源可获取性。
// <项目>/usage.jsonl：每一次 API 尝试一行（对话、Search、Fetch，含失败和重试）。调用次数、费用都从这里累计。
// <项目>/availability.jsonl：主持人对来源可获取性的确认（例如“来源已不存在”）。
// 来源可获取性由这两份记录派生：主持人确认 gone 优先；否则看最近一次 Fetch 的结果。不写进来源卡，
// 所以 Fetch 失败不会让来源升版、也不会让下游失效——已有快照照样可以作证据。
import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../agents.mjs';
import { chatCost, webCost } from './deepseek.mjs';

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
  const cache = new Map(); // project -> { calls, usd, entries }

  function ledger(project) {
    if (!cache.has(project)) {
      const entries = readLines(path.join(workbench.get(project).dir, 'usage.jsonl'));
      cache.set(project, { entries, calls: entries.length, usd: entries.reduce((s, e) => s + (e.usd || 0), 0) });
    }
    return cache.get(project);
  }

  const totals = (project) => {
    const l = ledger(project);
    const { budget } = workbench.get(project).config;
    return { calls: l.calls, usd: l.usd, limits: { calls: budget.calls, usd: budget.apiUsd } };
  };

  // 每次尝试之前检查：已到上限就不再发请求。费用要等返回才知道，所以最后一次调用可能略超费用上限。
  function check(project) {
    const t = totals(project);
    if (t.calls >= t.limits.calls) throw new AgentError('budget', `项目 ${project} 的调用次数已到上限（${t.calls}/${t.limits.calls}），需要你决定是否提高上限`, { budget: t });
    if (t.usd >= t.limits.usd) throw new AgentError('budget', `项目 ${project} 的 API 费用已到上限（$${t.usd.toFixed(4)}/$${t.limits.usd}），需要你决定是否提高上限`, { budget: t });
  }

  function record(project, entry) {
    const l = ledger(project);
    const line = { at: now().toISOString(), ...entry };
    append(path.join(workbench.get(project).dir, 'usage.jsonl'), line);
    l.entries.push(line);
    l.calls++;
    l.usd += line.usd || 0;
    return line;
  }

  // 给 DeepSeek 客户端用的两个钩子：每次尝试前查预算，结束后记账（含失败与重试）
  function hooks(project, meta = {}) {
    return {
      beforeAttempt: () => check(project),
      onAttempt: ({ api, ok, status, error, data }) => {
        const at = now();
        let usd = 0;
        let usage = null;
        if (api === 'chat') {
          usage = data?.usage ?? null;
          usd = ok ? chatCost(usage, data?.model ?? meta.model, pricing, at).usd : 0;
        } else usd = webCost(api, ok, data, pricing);
        const line = { api, ok, status, usd, ...meta };
        if (usage) line.usage = usage;
        if (error) line.error = String(error).slice(0, 300);
        if (api === 'search' && ok) line.results = data?.results?.length ?? 0;
        record(project, line);
      },
    };
  }

  // ---------- 来源可获取性 ----------

  function availabilityOf(project) {
    const dir = workbench.get(project).dir;
    const events = [
      ...ledger(project).entries.filter((e) => e.api === 'fetch' && e.source_id).map((e) => ({ at: e.at, id: e.source_id, kind: 'fetch', ok: e.ok, status: e.status, error: e.error })),
      ...readLines(path.join(dir, 'availability.jsonl')).map((e) => ({ ...e, kind: 'mark' })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const state = new Map(); // id -> { state, since, reason }
    for (const e of events) {
      const cur = state.get(e.id);
      if (e.kind === 'mark') state.set(e.id, { state: e.state, since: e.at, by: e.by ?? null, note: e.note ?? null });
      else if (cur?.state === 'gone') continue; // 主持人确认已不存在：抓取结果不改变它，只能由主持人撤销
      else if (e.ok) state.set(e.id, { state: 'available', since: e.at });
      else if (e.status === null || e.status >= 400) state.set(e.id, { state: 'temporarily_unavailable', since: e.at, reason: e.error ?? `HTTP ${e.status}` });
    }
    return state;
  }

  function mark(project, sourceId, state, { by, note } = {}) {
    if (!['gone', 'available'].includes(state)) throw new AgentError('exit', 'state 只能是 gone 或 available');
    const line = { at: now().toISOString(), id: sourceId, state, by: by ?? null, note: note ?? null };
    append(path.join(workbench.get(project).dir, 'availability.jsonl'), line);
    return line;
  }

  return { totals, check, record, hooks, availabilityOf, mark, entries: (project) => ledger(project).entries };
}
