// DeepSeek API 客户端：对话（OpenAI 兼容）、Search、Fetch。只用 Node 自带的 fetch，不引入依赖。
// 密钥只从环境变量 DEEPSEEK_API_KEY 读取。
// 重试：408、429、5xx 和网络错误按退避重试，其他 4xx 不重试；每一次尝试（含重试）都先过 beforeAttempt（预算检查），
// 结束后交给 onAttempt（记账），所以重试同样计入项目的调用上限。
// timeoutMs 是整次调用（含全部重试和等待）的总时限；signal 中止时立即停止，包括正在等待重试的时候。
import { AgentError } from '../agents.mjs';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const RETRYABLE = (status) => status === 408 || status === 429 || status >= 500;

// 按“最近 1 秒内开始的请求数”限速：Search、Fetch 各自每个账户每秒 5 次（官方限额），所有项目共用。
// 每一次物理请求（含重试）之前都要取一个名额。等待者按先来后到排队；每个等待者从排队那一刻起就监听自己的 signal，
// 被中止（总时限、“停止”）时立即离队返回，不占名额，也不影响其他等待者的顺序。
// schedule(fn, ms)：可注入的定时器（测试用假时钟）。
export function createRateLimiter(perSecond, { now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const starts = [];
  const waiters = [];
  let timer = null;
  function pump() {
    timer = null;
    const t = now();
    while (starts.length && t - starts[0] >= 1000) starts.shift();
    while (waiters.length && starts.length < perSecond) {
      const w = waiters.shift();
      w.signal?.removeEventListener('abort', w.onAbort);
      starts.push(t);
      w.resolve();
    }
    if (waiters.length && !timer) timer = schedule(pump, 1000 - (t - starts[0]) + 1);
  }
  return {
    take(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const w = { resolve, signal };
        w.onAbort = () => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(signal.reason);
        };
        signal?.addEventListener('abort', w.onAbort, { once: true });
        waiters.push(w);
        pump();
      });
    },
    waiting: () => waiters.length,
  };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry-After：秒数或 HTTP 日期。官方文档没有承诺会给，没有时用配置的退避间隔。
function retryAfterMs(res, nowMs) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

// rateLimits：{ search, fetch } 账户级限速器（按 api 名取用），所有调用共享
export function createDeepseekClient({
  apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = DEFAULT_BASE_URL,
  retry = { max: 3, delaysSec: [2, 4, 8] },
  rateLimits = {},
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const base = baseUrl.replace(/\/$/, '');

  // 返回 { data, status, attempts }；失败抛 AgentError，kind 为 timeout / aborted / http / network / invalid / parse / budget。
  // 每次物理请求的顺序：取限速名额 → beforeAttempt（预算：原子地检查并占用一个调用名额）→ 发请求 → 读完正文 → onAttempt（结算）。
  // retry：这次逻辑调用的重试策略（项目生效配置的快照）；不给时用客户端默认值。
  // validate(data)：HTTP 200 且 JSON 合法之后的业务检查，返回错误说明则这次尝试算失败（不重试）。
  async function request(pathname, body, { signal, timeoutMs = 600_000, beforeAttempt, onAttempt, api = pathname, retry: callRetry, validate } = {}) {
    if (!apiKey) throw new AgentError('spawn', '没有设置环境变量 DEEPSEEK_API_KEY');
    const policy = callRetry ?? retry;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new AgentError('timeout', `超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    const onOuterAbort = () => deadline.abort(new AgentError('aborted', '已被主持人中止'));
    if (signal?.aborted) onOuterAbort();
    else signal?.addEventListener('abort', onOuterAbort, { once: true });
    const attempts = [];
    const fail = (e) => Object.assign(e, { details: { ...(e.details || {}), attempts } });
    try {
      for (let i = 0; ; i++) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        await rateLimits[api]?.take(deadline.signal);
        await beforeAttempt?.({ api, attempt: i + 1 }); // 预算不够时在这里抛出，请求不会发出
        const t0 = now();
        let res = null;
        let text = '';
        let networkError = null;
        try {
          res = await fetchImpl(`${base}${pathname}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: deadline.signal,
          });
          // 等待期间服务端会发空行保活，读完整个正文再解析；读正文时断连同样算网络错误
          text = await res.text();
        } catch (e) {
          if (deadline.signal.aborted) {
            attempts.push({ status: res?.status ?? null, ms: now() - t0, error: deadline.signal.reason.kind });
            await onAttempt?.({ api, ok: false, status: res?.status ?? null, error: deadline.signal.reason.kind });
            throw deadline.signal.reason;
          }
          networkError = e;
        }
        const status = res?.status ?? null;
        const entry = { status, ms: now() - t0 };
        attempts.push(entry);
        if (res?.ok && !networkError) {
          let data;
          try {
            data = JSON.parse(text.trim());
          } catch {
            entry.error = 'parse';
            await onAttempt?.({ api, ok: false, status, error: 'parse' });
            throw new AgentError('parse', `返回的不是 JSON：${text.slice(0, 200)}`, { status });
          }
          const invalid = validate?.(data) ?? null;
          if (invalid) {
            entry.error = invalid;
            await onAttempt?.({ api, ok: false, status, error: invalid, data });
            throw new AgentError('invalid', invalid, { status });
          }
          await onAttempt?.({ api, ok: true, status, data });
          return { data, status, attempts };
        }
        let message = networkError ? `网络错误：${networkError.cause?.code || networkError.message}` : `HTTP ${status}`;
        if (!networkError) {
          try {
            message = JSON.parse(text).error?.message || message;
          } catch {}
        }
        entry.error = message;
        await onAttempt?.({ api, ok: false, status: networkError ? null : status, error: message });
        const retryable = networkError || RETRYABLE(status);
        if (!retryable || i >= policy.max) {
          const kind = networkError ? 'network' : 'http';
          throw new AgentError(kind, status === 429 && !networkError ? `被限流（429），重试 ${i} 次后放弃：${message}` : message, {
            status: networkError ? null : status,
            rateLimited: status === 429 && !networkError,
            retryAfterMs: res && !networkError ? retryAfterMs(res, now()) : null,
          });
        }
        // Retry-After 只在完整收到的响应上读取；读不到（含正文断连）时一律回退到配置的退避间隔
        const fromHeader = res && !networkError ? retryAfterMs(res, now()) : null;
        const wait = fromHeader ?? (policy.delaysSec[Math.min(i, policy.delaysSec.length - 1)] ?? 2) * 1000;
        entry.waitMs = wait;
        await abortableSleep(wait, deadline.signal);
      }
    } catch (e) {
      throw fail(e instanceof AgentError ? e : new AgentError('exit', e?.message || String(e)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  return {
    request,
    hasKey: () => !!apiKey,

    // 对话：一条 user 消息进，一段文本出。effort 对应 reasoning_effort（none 即关闭思考）
    async chat({ model, prompt, effort, maxTokens }, opts = {}) {
      const body = { model, messages: [{ role: 'user', content: prompt }], stream: false };
      if (effort) body.reasoning_effort = effort;
      if (maxTokens) body.max_tokens = maxTokens;
      const r = await request('/chat/completions', body, { ...opts, api: 'chat' });
      const choice = r.data.choices?.[0];
      const finish = choice?.finish_reason;
      if (['content_filter', 'insufficient_system_resource', 'aborted'].includes(finish)) {
        throw new AgentError('exit', `生成被中断（finish_reason=${finish}）`, { attempts: r.attempts, usage: r.data.usage });
      }
      return {
        text: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning_content ?? null,
        model: r.data.model ?? model,
        finish,
        usage: r.data.usage ?? null,
        attempts: r.attempts,
      };
    },

    async search({ query, count, need_content = false, ori_question }, opts = {}) {
      const body = { query, need_content };
      if (count) body.count = count;
      if (ori_question) body.ori_question = ori_question;
      const r = await request('/v1/tools/search', body, {
        ...opts,
        api: 'search',
        validate: (d) => (Array.isArray(d?.results) ? null : '响应里没有 results 数组'),
      });
      return { results: r.data.results, attempts: r.attempts };
    },

    // 只有拿到非空的字符串正文才算成功；空正文、缺 content、类型不对都算这次抓取失败
    async fetchPage(url, opts = {}) {
      const r = await request('/v1/tools/fetch', { url }, {
        ...opts,
        api: 'fetch',
        validate: (d) => (typeof d?.content !== 'string' ? '响应里没有字符串正文 content' : !d.content.trim() ? '正文为空' : null),
      });
      return { title: typeof r.data.title === 'string' ? r.data.title : '', content: r.data.content, attempts: r.attempts };
    },
  };
}

// ---------- 费用 ----------
// 价格是每 100 万 token 的高峰价（美元），低谷按 offPeakFactor 打折。高峰：周一至周五 UTC 的 peakHoursUtc 区间。
// 中国法定节假日也算低谷，这里不识别节假日，一律按高峰算——宁可高估，不会让预算被突破。
export function isPeak(date, peakHoursUtc) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return peakHoursUtc.some(([from, to]) => h >= from && h < to);
}

export function chatCost(usage, model, pricing, at = new Date()) {
  if (!usage) return { usd: 0, estimated: true };
  const known = pricing.models[model];
  // 不认识的模型按最贵的已知价格算，并标出来
  const price = known ?? Object.values(pricing.models).reduce((a, b) => (b.output > a.output ? b : a));
  const factor = isPeak(at, pricing.peakHoursUtc) ? 1 : pricing.offPeakFactor;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  const out = usage.completion_tokens ?? 0;
  const usd = ((hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1e6) * factor;
  return { usd, estimated: !known, peak: factor === 1 };
}

// Search / Fetch：只有成功且有结果才计费（Search 结果非空、Fetch 有正文）
export function webCost(api, ok, data, pricing) {
  if (!ok) return 0;
  if (api === 'search' && !(data?.results?.length > 0)) return 0;
  if (api === 'fetch' && !data?.content) return 0;
  return pricing.webUsdPerRequest;
}
