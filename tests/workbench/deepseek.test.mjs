// WP3：DeepSeek 适配器（重试、超时、中止、用量与费用、预算）、Search / Fetch 与来源快照、来源可获取性。
// 全部打到本地模拟服务，不访问外网。
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDeepseekClient, createRateLimiter, chatCost, isPeak } from '../../lib/workbench/deepseek.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createWebTools, SYSTEM_FETCH } from '../../lib/workbench/web.mjs';
import { runAgent } from '../../lib/agents.mjs';
import { startMock, chatOk, apiError } from './mock-deepseek.mjs';
import { setup, restart, submit, rid, HUMAN, DEFAULTS, cleanup } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock();
});
after(async () => {
  await mock.close();
  await cleanup();
});
beforeEach(() => mock.reset());

const FAST = { max: 3, delaysSec: [0.01, 0.02, 0.03] };
const client = (opts = {}) => createDeepseekClient({ apiKey: 'sk-test', baseUrl: mock.url, retry: FAST, ...opts });
const P = '样本';

// ---------- 对话、重试 ----------

test('对话：发出 OpenAI 兼容请求，带密钥、模型与推理强度；排队时的空行保活不影响解析', async () => {
  mock.script('/chat/completions', { ...chatOk('回答'), keepAlive: 3 });
  const r = await client().chat({ model: 'deepseek-flash', prompt: '问题', effort: 'high' });
  assert.equal(r.text, '回答');
  assert.equal(r.reasoning, '想一想');
  assert.equal(r.usage.prompt_cache_hit_tokens, 200);
  const req = mock.requests[0];
  assert.equal(req.auth, 'Bearer sk-test');
  assert.deepEqual(req.body, { model: 'deepseek-flash', messages: [{ role: 'user', content: '问题' }], stream: false, reasoning_effort: 'high' });
});

test('429 和 5xx 会重试，成功后返回；每次尝试都有记录', async () => {
  mock.script('/chat/completions', apiError(429), apiError(503), apiError(500), chatOk('终于'));
  const r = await client().chat({ model: 'deepseek-flash', prompt: 'x' });
  assert.equal(r.text, '终于');
  assert.deepEqual(r.attempts.map((a) => a.status), [429, 503, 500, 200]);
});

test('400、401、402、422 不重试', async () => {
  for (const status of [400, 401, 402, 422]) {
    mock.reset();
    mock.script('/chat/completions', apiError(status, `坏请求 ${status}`), chatOk());
    await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }), (e) => e.kind === 'http' && e.details.status === status && e.message === `坏请求 ${status}`);
    assert.equal(mock.requests.length, 1, String(status));
  }
});

test('408 和网络错误也重试；重试次数用完后放弃，并标明是否被限流', async () => {
  mock.script('/chat/completions', apiError(408), { close: true }, chatOk('好了'));
  assert.equal((await client().chat({ model: 'deepseek-flash', prompt: 'x' })).text, '好了');
  mock.reset();
  mock.script('/chat/completions', apiError(429), apiError(429), apiError(429), apiError(429), chatOk());
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }), (e) => e.details.rateLimited === true && e.details.attempts.length === 4);
  assert.equal(mock.requests.length, 4); // 首次 ＋ 重试 3 次
});

test('Retry-After 优先于配置的退避间隔', async () => {
  mock.script('/chat/completions', apiError(429, '慢点', { headers: { 'Retry-After': '0.3' } }), chatOk());
  const t0 = Date.now();
  const r = await client({ retry: { max: 3, delaysSec: [0] } }).chat({ model: 'deepseek-flash', prompt: 'x' });
  assert.ok(Date.now() - t0 >= 280, '应等待 Retry-After 指定的时间');
  assert.equal(r.attempts[0].waitMs, 300);
});

test('超时能退出：整次调用（含重试）超过时限就中止', async () => {
  mock.script('/chat/completions', { ...chatOk(), delayMs: 3000 });
  const t0 = Date.now();
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }, { timeoutMs: 200 }), { kind: 'timeout' });
  assert.ok(Date.now() - t0 < 1500);
  // 在等待重试的时候到时限，同样立即退出
  mock.reset();
  mock.script('/chat/completions', apiError(503));
  const t1 = Date.now();
  await assert.rejects(client({ retry: { max: 3, delaysSec: [10] } }).chat({ model: 'deepseek-flash', prompt: 'x' }, { timeoutMs: 200 }), { kind: 'timeout' });
  assert.ok(Date.now() - t1 < 1500);
});

test('“停止”能中断：请求进行中、等待重试时都立即返回 aborted', async () => {
  mock.script('/chat/completions', { ...chatOk(), delayMs: 3000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }, { signal: ac.signal }), { kind: 'aborted' });
  mock.reset();
  mock.script('/chat/completions', apiError(500));
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(client({ retry: { max: 3, delaysSec: [10] } }).chat({ model: 'deepseek-flash', prompt: 'x' }, { signal: ac2.signal }), { kind: 'aborted' });
  assert.ok(Date.now() - t0 < 1500);
});

test('没有密钥时不发请求', async () => {
  await assert.rejects(createDeepseekClient({ apiKey: '', baseUrl: mock.url }).chat({ model: 'deepseek-flash', prompt: 'x' }), /DEEPSEEK_API_KEY/);
  assert.equal(mock.requests.length, 0);
});

test('内容审查或资源不足中断时报错，并带上已用掉的用量', async () => {
  mock.script('/chat/completions', { body: { model: 'deepseek-flash', choices: [{ finish_reason: 'content_filter', message: { content: '' } }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } } });
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }), (e) => /content_filter/.test(e.message) && e.details.usage.prompt_tokens === 1);
});

// ---------- 适配器 ----------

test('deepseek 适配器：runAgent 返回发言、实际模型、用量和执行细节；空回复按 empty 失败', async () => {
  mock.script('/chat/completions', chatOk('发言正文'));
  const p = { id: 'deepseek', name: 'DeepSeek', adapter: 'deepseek', model: 'deepseek-flash', effort: 'none' };
  const r = await runAgent(p, '提示词', { timeoutMs: 5000, deepseek: client() });
  assert.equal(r.raw, '发言正文');
  assert.equal(r.model, 'deepseek-flash');
  assert.equal(r.usage.completion_tokens, 500);
  assert.equal(r.exec.api, 'deepseek');
  assert.deepEqual(r.exec.attempts.map((a) => a.status), [200]);
  assert.equal(mock.requests[0].body.reasoning_effort, 'none');
  mock.script('/chat/completions', chatOk('   '));
  await assert.rejects(runAgent(p, '提示词', { timeoutMs: 5000, deepseek: client() }), (e) => e.kind === 'empty' && e.details.exec.api === 'deepseek');
});

// ---------- 费用 ----------

test('费用：按缓存命中、未命中、输出分别计价；高峰与低谷；不认识的模型按最贵的价格估算', () => {
  const usage = { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 400_000, prompt_cache_miss_tokens: 600_000, completion_tokens: 100_000 };
  const peak = new Date('2026-10-19T02:00:00Z'); // 周一 UTC 02 点：高峰
  const off = new Date('2026-10-19T12:00:00Z'); // 周一 UTC 12 点：低谷
  const weekend = new Date('2026-10-18T02:00:00Z'); // 周日：低谷
  assert.equal(isPeak(peak, DEFAULTS.pricing.peakHoursUtc), true);
  assert.equal(isPeak(off, DEFAULTS.pricing.peakHoursUtc), false);
  assert.equal(isPeak(weekend, DEFAULTS.pricing.peakHoursUtc), false);
  const expectPeak = 0.4 * 0.006 + 0.6 * 0.3 + 0.1 * 1.2;
  assert.ok(Math.abs(chatCost(usage, 'deepseek-flash', DEFAULTS.pricing, peak).usd - expectPeak) < 1e-9);
  assert.ok(Math.abs(chatCost(usage, 'deepseek-flash', DEFAULTS.pricing, off).usd - expectPeak / 2) < 1e-9);
  const unknown = chatCost(usage, 'deepseek-v9', DEFAULTS.pricing, peak);
  assert.equal(unknown.estimated, true);
  assert.ok(Math.abs(unknown.usd - (0.4 * 0.044 + 0.6 * 1.32 + 0.1 * 3.96)) < 1e-9);
});

// ---------- 预算与账本 ----------

// override：写进项目 protocol.json 的覆盖；测试里默认把重试间隔调成毫秒级
async function projectEnv(budget, override = {}) {
  const env = await setup();
  fs.writeFileSync(path.join(env.projectsDir, P, 'protocol.json'), JSON.stringify({ retry: { max: 3, delaysSec: [0.01, 0.02, 0.03] }, ...(budget ? { budget } : {}), ...override }));
  const usage = createUsage({ workbench: env.workbench, pricing: DEFAULTS.pricing, now: () => new Date('2026-10-19T12:00:00Z') });
  // 和 server.mjs 一样把来源可获取性接进提交入口
  const { gw } = await restart(env, { availabilityOf: (p) => usage.availabilityOf(p) });
  return { ...env, gw, usage };
}

test('重试计入项目调用上限：到上限后不再发请求，账本里每次尝试一行', async () => {
  const env = await projectEnv({ calls: 3 });
  mock.script('/chat/completions', apiError(429), apiError(429), apiError(429), chatOk());
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }, env.usage.hooks(P, { purpose: 'test' })), (e) => e.kind === 'budget');
  assert.equal(mock.requests.length, 3);
  // 每次尝试：发请求前一行 start（占名额），结束后一行 end（结算）
  const lines = fs.readFileSync(path.join(env.projectsDir, P, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
  assert.deepEqual(env.usage.entries(P).map((l) => [l.api, l.status, l.ok, l.attempt]), [['chat', 429, false, 1], ['chat', 429, false, 2], ['chat', 429, false, 3]]);
  assert.deepEqual(env.usage.totals(P), { calls: 3, usd: 0, limits: { calls: 3, usd: DEFAULTS.budget.apiUsd } });
  // 重新加载账本（模拟重启）后上限依然生效
  const again = createUsage({ workbench: env.workbench, pricing: DEFAULTS.pricing });
  assert.throws(() => again.check(P), { kind: 'budget' });
});

test('费用上限：成功调用按价目记账，累计到上限后拒绝', async () => {
  const env = await projectEnv({ apiUsd: 0.0001 });
  mock.script('/chat/completions', chatOk('a'), chatOk('b'));
  await client().chat({ model: 'deepseek-flash', prompt: 'x' }, env.usage.hooks(P));
  const t = env.usage.totals(P);
  const expected = (200 * 0.006 + 800 * 0.3 + 500 * 1.2) / 1e6 / 2; // 低谷
  assert.ok(Math.abs(t.usd - expected) < 1e-12);
  await assert.rejects(client().chat({ model: 'deepseek-flash', prompt: 'x' }, env.usage.hooks(P)), { kind: 'budget' });
  assert.equal(mock.requests.length, 1);
});

// ---------- 限速 ----------

test('Search / Fetch 限速：1 秒内最多 5 次，第 6 次等到最早那次满 1 秒', async () => {
  let t = 0;
  const waits = [];
  const limiter = createRateLimiter(5, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  const starts = [];
  for (let i = 0; i < 7; i++) {
    await limiter.take();
    starts.push(t);
    t += 10;
  }
  assert.deepEqual(starts.slice(0, 5), [0, 10, 20, 30, 40]);
  assert.ok(starts[5] >= 1000 && starts[6] >= 1010);
  for (let i = 5; i < 7; i++) assert.ok(starts.slice(i - 5, i + 1).at(-1) - starts[i - 5] >= 1000);
});

// ---------- Search / Fetch 与来源快照 ----------

const SEARCH_RESULT = { rerank_score: 2, title: '三五历纪', url: 'https://example.org/sanwu', snippet: '盘古开天辟地，一日九变', summary: '据说盘古开天辟地的故事出自三国时期', content: '', site_name: null, site_icon: null, date: null, authority: 2 };
const PAGE = { title: '三五历纪（辑佚）', content: '# 三五历纪\n\n天地混沌如鸡子，盘古生其中。万八千岁，天地开辟。' };

async function webEnv(opts = {}) {
  const env = await projectEnv(opts.budget, opts.override);
  const c = opts.client ?? client();
  const web = createWebTools({ client: c, usage: env.usage, gateway: env.gw, workbench: env.workbench, timeoutMs: opts.timeoutMs ?? 5000 });
  return { ...env, web };
}

test('Search 只给线索：结果标为非证据、不存成快照；按成功且非空计费', async () => {
  const env = await webEnv();
  const blobDir = path.join(env.projectsDir, P, 'archive', 'blobs');
  const before = fs.existsSync(blobDir) ? fs.readdirSync(blobDir).length : 0;
  mock.script('/v1/tools/search', { body: { results: [SEARCH_RESULT] } }, { body: { results: [] } });
  const r = await env.web.search(P, { query: '盘古 site:example.org', count: 5 });
  assert.equal(r.evidence, false);
  assert.equal(r.results[0].snippet, SEARCH_RESULT.snippet);
  assert.deepEqual(mock.requests[0].body, { query: '盘古 site:example.org', need_content: false, count: 5 });
  await env.web.search(P, { query: '没有结果' });
  assert.equal(fs.existsSync(blobDir) ? fs.readdirSync(blobDir).length : 0, before);
  const lines = env.usage.entries(P);
  assert.deepEqual(lines.map((l) => [l.api, l.usd, l.results]), [['search', 0.00075, 1], ['search', 0, 0]]);
  await assert.rejects(env.web.search(P, { query: '' }), { status: 400 });
  await assert.rejects(env.web.search(P, { query: 'x', count: 51 }), { status: 400 });
});

test('搜索结果的 summary / snippet 不能作为引文进入论断；Fetch 抓到的原文可以', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/search', { body: { results: [SEARCH_RESULT] } });
  const found = (await env.web.search(P, { query: '三五历纪' })).results[0];
  mock.script('/v1/tools/fetch', { body: PAGE });
  const fetched = await env.web.fetch(P, { url: found.url, create: true });
  assert.deepEqual({ id: fetched.source.id, version: fetched.source.version }, { id: 'S001', version: 1 });
  const src = env.gw.getRecord(P, 'S001').record;
  assert.equal(src.text_blob, fetched.text_blob);
  assert.equal(src.provenance.kind, 'system');
  assert.ok(src.retrieved_at);
  const claim = (quote) => [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: '盘古', sources: [{ id: 'S001', version: 1, quote }] } }];
  for (const quote of [found.snippet, found.summary]) {
    const r = env.gw.receive(P, { request_id: rid(), changes: claim(quote) }, { actor: HUMAN });
    await assert.rejects(env.gw.promote(P, r.sid), (e) => e.details.reasons[0].type === 'quote_not_found', quote);
  }
  const ok = await submit(env.gw, P, claim('天地混沌如鸡子，盘古生其中'));
  assert.equal(ok.result.state, 'applied');
  // Agent（非主持人）不能把任何文字直接写成来源正文
  assert.throws(() => env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'https://a', text: found.summary } }] }, { actor: SYSTEM_FETCH }), { status: 403 });
  // 没有正文快照的来源：引文无法核对
  await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: '无正文', citation: '某书' } }]);
  const r = env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'y', sources: [{ id: 'S002', version: 1, quote: '任何文字' }] } }] }, { actor: HUMAN });
  await assert.rejects(env.gw.promote(P, r.sid), (e) => e.details.reasons[0].type === 'quote_unverifiable');
});

test('Fetch 失败：来源标为暂不可获取，已有快照保留且仍可作证据，来源不升版、下游不失效', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: PAGE });
  await env.web.fetch(P, { url: 'https://example.org/sanwu', create: true });
  await submit(env.gw, P, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001', version: 1, quote: '万八千岁' }] } }]);
  mock.script('/v1/tools/fetch', apiError(404, 'no usable content'));
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/sanwu', source_id: 'S001' }), (e) =>
    e.status === 404 && e.details.availability.state === 'temporarily_unavailable' && e.details.snapshot_kept === true);
  assert.equal(env.gw.getRecord(P, 'S001').record.version, 1);
  assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'temporarily_unavailable');
  assert.equal(env.gw.getRecord(P, 'C001').status.freshness, 'current');
  const t = env.gw.trace(P, 'C001').root.sources[0];
  assert.equal(t.availability, 'temporarily_unavailable');
  assert.equal(t.quote_found, true); // 快照照样能核对引文
  // 失败的 Fetch 不计费，但有记录（契约一的 fetch_failure 指针）
  const fail = env.usage.entries(P).find((l) => l.api === 'fetch' && !l.ok);
  assert.deepEqual([fail.status, fail.usd, fail.source_id], [404, 0, 'S001']);
  // 恢复后再抓：内容没变，不升版，可获取性恢复
  mock.script('/v1/tools/fetch', { body: PAGE });
  const same = await env.web.fetch(P, { url: 'https://example.org/sanwu', source_id: 'S001' });
  assert.equal(same.source.changed, false);
  assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'available');
  // 内容变了：来源升版，依赖它的论断待复核
  mock.script('/v1/tools/fetch', { body: { ...PAGE, content: PAGE.content + '\n\n（更正）' } });
  const changed = await env.web.fetch(P, { url: 'https://example.org/sanwu', source_id: 'S001' });
  assert.deepEqual([changed.source.version, changed.source.changed], [2, true]);
  assert.equal(env.gw.getRecord(P, 'C001').status.freshness, 'stale');
});

test('主持人确认来源已不存在（gone）：之后抓取成功也不改变，只能由主持人撤销', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: PAGE }, { body: PAGE });
  await env.web.fetch(P, { url: 'https://example.org/sanwu', create: true });
  env.usage.mark(P, 'S001', 'gone', { by: '主持人' });
  assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'gone');
  await env.web.fetch(P, { url: 'https://example.org/sanwu', source_id: 'S001' });
  assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'gone');
  env.usage.mark(P, 'S001', 'available', { by: '主持人' });
  assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'available');
});

test('Fetch 的地址校验：只接受 http(s)，不能带用户名密码', async () => {
  const env = await webEnv();
  for (const url of ['ftp://a/b', 'https://user:pw@example.org/', 'not a url', '']) {
    await assert.rejects(env.web.fetch(P, { url }), { status: 400 }, url);
  }
  assert.equal(mock.requests.length, 0);
});

test('上游被限流且重试用完：返回 502，并带上每次尝试的状态', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', apiError(429), apiError(429), apiError(429), apiError(429));
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/x' }), (e) => e.status === 502 && e.details.attempts.length === 4);
});

test('引文定位：Fetch 的 Markdown 转义和空白重排不影响定位；其余字符原样比较', async () => {
  const { locateQuote } = await import('../../lib/workbench/records.mjs');
  const md = 'This domain is for use in documentation examples without needing permission\. Avoid use in\n  operations\.';
  const hit = locateQuote(md, 'without needing permission. Avoid use in operations.');
  assert.ok(hit);
  assert.equal(md.slice(hit.index, hit.index + hit.length), 'without needing permission\. Avoid use in\n  operations\.');
  assert.equal(locateQuote(md, 'without needing permission, Avoid'), null); // 标点不同就不算
  assert.equal(locateQuote('天地混沌如鸡子，盘古生其中', '天地混沌如鸡子,盘古生其中'), null); // 全半角不归一
  assert.deepEqual(locateQuote('甲乙丙', '乙'), { index: 1, length: 1 });
  assert.equal(locateQuote('甲乙丙', ''), null);
});

// ---------- WP3 评审（R1–R6）的回归用例 ----------

const searchOk = () => ({ body: { results: [{ ...SEARCH_RESULT }] } });

test('R1: 调用次数是硬上限：并发的 Search / Fetch 不会一起越过上限，超额的在发出之前就被拦住', async () => {
  const env = await webEnv({ budget: { calls: 1 } });
  mock.script('/v1/tools/search', { ...searchOk(), delayMs: 150 }, { ...searchOk(), delayMs: 150 }, { ...searchOk(), delayMs: 150 });
  mock.script('/v1/tools/fetch', { body: PAGE, delayMs: 150 }, { body: PAGE, delayMs: 150 });
  const settled = await Promise.allSettled([
    ...Array.from({ length: 3 }, (_, i) => env.web.search(P, { query: `q${i}` })),
    ...Array.from({ length: 2 }, (_, i) => env.web.fetch(P, { url: `https://example.org/${i}` })),
  ]);
  assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(settled.filter((x) => x.status === 'rejected').every((x) => x.reason.status === 429));
  assert.equal(mock.requests.length, 1);
  assert.equal(env.usage.totals(P).calls, 1);
});

test('R1: 并发调用各自重试，名额按每次物理请求占用，总数不超过上限', async () => {
  const env = await webEnv({ budget: { calls: 4 } });
  mock.script('/v1/tools/search', apiError(503), apiError(503), apiError(503), apiError(503), searchOk(), searchOk());
  const settled = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => env.web.search(P, { query: `q${i}` })));
  assert.equal(mock.requests.length, 4);
  assert.equal(env.usage.totals(P).calls, 4);
  assert.ok(settled.some((x) => x.status === 'rejected' && x.reason.status === 429));
});

test('R1: 请求发出后、响应之前服务退出：重启后这次尝试照样计数（保守），不会被当成没发生', async () => {
  const env = await projectEnv({ calls: 2 });
  const id = env.usage.reserve(P, { api: 'search', attempt: 1, query: 'x' }); // 只有 start，没有 end
  assert.ok(id);
  const again = createUsage({ workbench: env.workbench, pricing: DEFAULTS.pricing });
  assert.equal(again.totals(P).calls, 1);
  assert.deepEqual(again.entries(P).map((e) => e.settled), [false]);
  again.reserve(P, { api: 'search', attempt: 1 });
  assert.throws(() => again.reserve(P, { api: 'search', attempt: 1 }), { kind: 'budget' });
});

test('R2: 已有来源卡的抓取绑定它自己的地址：不同 host、不同 path 都被拒绝，不会把别处的正文挂到它名下', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: { title: 'A', content: 'A 的正文' } });
  await env.web.fetch(P, { url: 'https://example.org/A', create: true });
  for (const url of ['https://example.org/B', 'https://other.example/A', 'https://example.org/A?x=1']) {
    await assert.rejects(env.web.fetch(P, { url, source_id: 'S001' }), (e) => e.status === 400 && /地址不一致/.test(e.message), url);
  }
  assert.equal(mock.requests.length, 1); // 被拒的都没有发出去
  // 同一地址（含规范化：主机大小写、默认端口）可以；省略 url 时从来源卡地址抓
  mock.script('/v1/tools/fetch', { body: { title: 'A', content: 'A 的正文' } }, { body: { title: 'A', content: 'A 的正文（新）' } });
  const same = await env.web.fetch(P, { url: 'https://EXAMPLE.org:443/A', source_id: 'S001' });
  assert.equal(same.source.changed, false);
  const noUrl = await env.web.fetch(P, { source_id: 'S001' });
  assert.equal(noUrl.url, 'https://example.org/A');
  assert.equal(mock.requests.at(-1).body.url, 'https://example.org/A');
  assert.equal(env.gw.getRecord(P, 'S001').record.version, 2);
});

test('R2: 迁址只能由主持人显式进行，地址与正文一起更新；没有地址的来源同样需要迁址；失败抓取不会标记别的来源', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: { title: 'A', content: 'A 的正文' } });
  await env.web.fetch(P, { url: 'https://example.org/A', create: true });
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/B', source_id: 'S001', relocate: true }), { status: 403 });
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/B', source_id: 'S001', relocate: true }, { actor: SYSTEM_FETCH }), { status: 403 });
  mock.script('/v1/tools/fetch', { body: { title: 'B', content: 'B 的正文' } });
  const moved = await env.web.fetch(P, { url: 'https://example.org/B', source_id: 'S001', relocate: true }, { actor: HUMAN });
  assert.equal(moved.source.relocated, true);
  const rec = env.gw.getRecord(P, 'S001').record;
  assert.deepEqual([rec.url, rec.version, rec.provenance.kind], ['https://example.org/B', 2, 'human']);
  // 没有地址的来源（书目）：不能直接抓，也不能借别人的地址
  await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: '某书', citation: '某书，第 3 页', text: '书里的一段' } }]);
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/C', source_id: 'S002' }), (e) => e.status === 400 && /没有地址/.test(e.message));
  // B 失败只影响 S001（地址绑定的抓取），S002 不受影响
  mock.script('/v1/tools/fetch', apiError(404));
  await assert.rejects(env.web.fetch(P, { source_id: 'S001' }), { status: 404 });
  const av = env.usage.availabilityOf(P);
  assert.equal(av.get('S001').state, 'temporarily_unavailable');
  assert.equal(av.has('S002'), false);
  // 不绑定来源卡的抓取，失败不计入任何来源
  mock.script('/v1/tools/fetch', apiError(404));
  await assert.rejects(env.web.fetch(P, { url: 'https://example.org/A' }), { status: 404 });
  assert.equal(env.usage.availabilityOf(P).size, 1);
});

test('R3: 账户限速按每次物理请求执行：并发首发与重试交错时，任意 1 秒内都不超过 5 次', async () => {
  const limits = { search: createRateLimiter(5), fetch: createRateLimiter(5) };
  const c = client({ rateLimits: limits });
  const env = await webEnv({ client: c, override: { retry: { max: 3, delaysSec: [0] } }, timeoutMs: 15_000 });
  const starts = [];
  let n = 0;
  const mock2 = await startMock({ fallback: () => { starts.push(Date.now()); return ++n <= 5 ? apiError(503) : searchOk(); } });
  try {
    const c2 = createDeepseekClient({ apiKey: 'sk-test', baseUrl: mock2.url, rateLimits: limits });
    const web = createWebTools({ client: c2, usage: env.usage, gateway: env.gw, workbench: env.workbench, timeoutMs: 15_000 });
    await Promise.all(Array.from({ length: 5 }, (_, i) => web.search(P, { query: `q${i}` })));
  } finally {
    await mock2.close();
  }
  assert.equal(starts.length, 10);
  for (let i = 5; i < starts.length; i++) assert.ok(starts[i] - starts[i - 5] >= 990, `第 ${i + 1} 次与第 ${i - 4} 次相隔 ${starts[i] - starts[i - 5]}ms`);
});

test('R3: 等待限速名额同样受总时限和“停止”约束', async () => {
  let t = 0;
  const limiter = createRateLimiter(1);
  await limiter.take();
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('stop')), 50);
  const t0 = Date.now();
  await assert.rejects(limiter.take(ac.signal), /stop/);
  assert.ok(Date.now() - t0 < 500);
  // 客户端的总时限也覆盖等待名额的时间
  const busy = createRateLimiter(1);
  await busy.take();
  const c = client({ rateLimits: { search: busy } });
  await assert.rejects(c.search({ query: 'x' }, { timeoutMs: 100 }), { kind: 'timeout' });
  assert.equal(mock.requests.length, 0);
  void t;
});

test('R4: 项目的重试配置对 Web 调用生效；两个项目各用各的，互不串扰', async () => {
  const noRetry = await webEnv({ override: { retry: { max: 0, delaysSec: [0] } } });
  mock.script('/v1/tools/search', apiError(503), searchOk());
  await assert.rejects(noRetry.web.search(P, { query: 'x' }), { status: 502 });
  assert.equal(mock.requests.length, 1);
  mock.reset();
  const twoRetries = await webEnv({ override: { retry: { max: 2, delaysSec: [0.01] } } });
  mock.script('/v1/tools/search', apiError(503), apiError(503), apiError(503), searchOk());
  mock.script('/v1/tools/fetch', apiError(503), { body: PAGE });
  const [a, b] = await Promise.allSettled([twoRetries.web.search(P, { query: 'y' }), noRetry.web.fetch(P, { url: 'https://example.org/z' })]);
  assert.equal(a.status, 'rejected'); // 3 次都 503：重试 2 次后放弃
  assert.equal(b.status, 'rejected'); // 不重试的项目：第一次 503 就停
  assert.equal(mock.requests.filter((r) => r.path === '/v1/tools/search').length, 3);
  assert.equal(mock.requests.filter((r) => r.path === '/v1/tools/fetch').length, 1);
});

test('R5: 收到 200 头后正文断连按网络错误重试；完整但不合法的 JSON 仍是 parse 错误；超时和中止不误重试', async () => {
  const http = await import('node:http');
  let calls = 0;
  let mode = 'break';
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req) void _;
    calls++;
    if (mode === 'break-non200') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.write('{"error":');
      return setTimeout(() => res.destroy(), 20);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'bad-json') return res.end('{not json');
    if (mode === 'slow') return void setTimeout(() => res.end(JSON.stringify(searchOk().body)), 3000);
    if (calls === 1) {
      res.write('\n'); // 保活空行之后断开
      return setTimeout(() => res.destroy(), 30);
    }
    res.end(JSON.stringify(searchOk().body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = createDeepseekClient({ apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${srv.address().port}`, retry: { max: 3, delaysSec: [0] } });
  try {
    const r = await c.search({ query: 'x' });
    assert.equal(r.results.length, 1);
    assert.equal(calls, 2);
    assert.equal(r.attempts[0].status, 200);
    assert.match(r.attempts[0].error, /网络错误/);
    calls = 1;
    mode = 'break-non200';
    await assert.rejects(c.search({ query: 'x' }), (e) => e.kind === 'network' && e.details.attempts.length === 4);
    calls = 0;
    mode = 'bad-json';
    await assert.rejects(c.search({ query: 'x' }), (e) => e.kind === 'parse');
    assert.equal(calls, 1);
    calls = 0;
    mode = 'slow';
    await assert.rejects(c.search({ query: 'x' }, { timeoutMs: 200 }), { kind: 'timeout' });
    assert.equal(calls, 1);
    calls = 0;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(c.search({ query: 'x' }, { signal: ac.signal }), { kind: 'aborted' });
    assert.equal(calls, 1);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('R6: Fetch 拿不到可用正文（空、缺 content、类型不对）是失败：HTTP 结果、账本、可获取性三者一致，快照保留', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: PAGE });
  await env.web.fetch(P, { url: 'https://example.org/sanwu', create: true });
  for (const body of [{ title: 't', content: '' }, { title: 't', content: '  \n ' }, { title: 't' }, { title: 't', content: 42 }]) {
    mock.script('/v1/tools/fetch', apiError(404), { body });
    await assert.rejects(env.web.fetch(P, { source_id: 'S001' }), { status: 404 }); // 先变成暂不可获取
    await assert.rejects(env.web.fetch(P, { source_id: 'S001' }), (e) => e.status === 404 && e.details.kind === 'invalid', JSON.stringify(body));
    const last = env.usage.entries(P).at(-1);
    assert.deepEqual([last.api, last.ok, last.status, last.usd], ['fetch', false, 200, 0], JSON.stringify(body));
    assert.equal(env.gw.getRecord(P, 'S001').availability.state, 'temporarily_unavailable', JSON.stringify(body));
  }
  assert.equal(env.gw.getRecord(P, 'S001').record.version, 1);
  assert.equal(env.gw.trace(P, 'S001').root.quote_found, null);
});

test('正文快照登记：text_blob 只能指向登记过的快照，记录 JSON 之类的其他 blob 不行；追溯显示快照来处', async () => {
  const env = await webEnv();
  mock.script('/v1/tools/fetch', { body: PAGE });
  const f = await env.web.fetch(P, { url: 'https://example.org/sanwu', create: true });
  await submit(env.gw, P, [{ kind: 'claim', expected_version: 0, data: { type: 'fact', text: 'x', sources: [{ id: 'S001', version: 1, quote: '万八千岁' }] } }]);
  // 记录 C001 自己的 JSON 也在 blob 目录里
  const line = env.gw.commits(P).find((c) => c.records.some((r) => r.id === 'C001'));
  const recordBlob = line.files[0].blob;
  assert.throws(() => env.gw.receive(P, { request_id: rid(), changes: [{ kind: 'source', expected_version: 0, data: { title: 'x', url: 'https://a', text_blob: recordBlob } }] }, { actor: HUMAN }), /不是登记过的正文快照/);
  // 登记过的快照可以被引用（例如主持人把同一份快照挂到另一张来源卡）
  const ok = await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: '同一份', url: 'https://example.org/sanwu', text_blob: f.text_blob } }]);
  assert.equal(ok.result.state, 'applied');
  const t = env.gw.trace(P, 'C001').root.sources[0];
  assert.deepEqual([t.snapshot.origin, t.snapshot.url, t.snapshot.service], ['fetch', 'https://example.org/sanwu', 'deepseek-fetch']);
  // 主持人录入的正文登记为 manual
  await submit(env.gw, P, [{ kind: 'source', expected_version: 0, data: { title: '纸质书', citation: '某书，第 12 页', text: '引文所在的那一段' } }]);
  const blob = env.gw.getRecord(P, 'S003').record.text_blob;
  const { snapshotInfo } = await import('../../lib/workbench/snapshots.mjs');
  assert.deepEqual([snapshotInfo(path.join(env.projectsDir, P), blob).origin, snapshotInfo(path.join(env.projectsDir, P), blob).by], ['manual', '主持人']);
});
