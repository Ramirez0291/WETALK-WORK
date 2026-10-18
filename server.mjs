// WeTalk 研讨室服务器：论坛存储 + Web 界面 + 主持人调度（轮流让各 AI 发言）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { createCallLog } from './lib/calllog.mjs';
import { rngFrom, normalizeSeed, shuffle, buildQueue } from './lib/schedule.mjs';
import { runAgent, buildPrompt, parseReply, resolveCommand, listOptions, isCombined, isApiAdapter, MEMORY_MAX_CHARS, CHOICE_LABEL } from './lib/agents.mjs';
import { createDeepseekClient, createRateLimiter, chatCost } from './lib/workbench/deepseek.mjs';
import { createUsage } from './lib/workbench/usage.mjs';
import { createWebTools } from './lib/workbench/web.mjs';
import { createTaskBoard } from './lib/workbench/tasks.mjs';
import { createRunner } from './lib/workbench/runner.mjs';
import { createSealedStore } from './lib/workbench/visibility.mjs';
import { RULES, tally, decideOutcome, buildVotePrompt, parseVote, buildDraftPrompt, parseDraft, resultText } from './lib/voting.mjs';
import { createWorkbench, loadDefaults } from './lib/workbench/project.mjs';
import { workbenchRoutes } from './lib/workbench/http.mjs';
import { createCommitGateway } from './lib/workbench/commit.mjs';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(process.env.WETALK_CONFIG || path.join(ROOT, 'wetalk.config.json'));
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = Number(process.env.WETALK_PORT || config.port || 7788);
const HOST = '127.0.0.1'; // 只监听本机：这个服务能驱动本地 AI CLI，绝不能暴露到局域网
const DATA_DIR = path.resolve(process.env.WETALK_DATA || path.join(ROOT, 'data')); // 换个目录就是一套独立的论坛 + 记忆
const SANDBOX = path.join(DATA_DIR, 'sandbox'); // AI 发言时的工作目录，空目录，免得它们去翻项目文件
const store = createStore(path.join(DATA_DIR, 'forum.json'));
const callLog = createCallLog(path.join(DATA_DIR, 'calls.jsonl')); // 每次调用 AI 的完整快照

// 工坊：项目资料放在独立的 git 仓库里（默认是本仓库下的 projects/，本仓库忽略它）
const WB_DEFAULTS = loadDefaults(path.join(ROOT, 'workbench.defaults.json'));
const PROJECTS_DIR = path.resolve(ROOT, process.env.WETALK_PROJECTS || WB_DEFAULTS.projectsDir);
const workbench = createWorkbench({ projectsDir: PROJECTS_DIR, defaults: WB_DEFAULTS, templateDir: path.join(ROOT, 'templates', 'project') });
// DeepSeek：对话、Search、Fetch 共用一个客户端；项目用量与来源可获取性记在各项目的账本里
// Search、Fetch 各自按账户限速（每次物理请求、含重试都要取名额），所有项目共用
const deepseek = createDeepseekClient({
  baseUrl: process.env.WETALK_DEEPSEEK_URL || WB_DEFAULTS.deepseek.baseUrl,
  retry: WB_DEFAULTS.retry,
  rateLimits: { search: createRateLimiter(WB_DEFAULTS.deepseek.webPerSecond), fetch: createRateLimiter(WB_DEFAULTS.deepseek.webPerSecond) },
});
const usage = createUsage({ workbench, pricing: WB_DEFAULTS.pricing });
const wbEvent = (ev) => broadcast({ ...ev, type: `wb-${ev.type}` }); // 工坊事件里从不带正文
// 任务看板（契约三）：任务状态只由它改变；它同时是提交入口的栅栏
const board = createTaskBoard({ workbench, usage, onEvent: wbEvent });
// 提交入口：启动时取得项目目录的单实例锁并做崩溃恢复，之后它是正式区唯一的写入者
const gateway = createCommitGateway({
  workbench,
  defaults: WB_DEFAULTS,
  fence: board.fence,
  onEvent: wbEvent,
  availabilityOf: (p, urlOf) => usage.availabilityOf(p, { urlOf }),
});
const web = createWebTools({ client: deepseek, usage, gateway, workbench, timeoutMs: WB_DEFAULTS.deepseek.timeoutSec * 1000 });
let workbenchStart;
try {
  workbenchStart = await gateway.start();
} catch (e) {
  console.error(`\n工坊无法启动：${e.message}\n`);
  process.exit(1);
}
process.on('exit', () => gateway.stop());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
gateway.startArchiveRetry();
// 密封结果只在内存里；派发器按可见性调用参与者
const sealed = createSealedStore();
const participantById = Object.assign((id) => participants.find((p) => p.id === id) ?? null, { all: () => participants });
const runner = createRunner({
  workbench, gateway, board, usage, sealed, participants: participantById, runAgent, deepseek,
  workRoot: path.join(DATA_DIR, 'work'), sandboxDir: SANDBOX,
  templateText: fs.readFileSync(path.join(ROOT, 'templates', 'project', 'project.md'), 'utf8'),
  timeoutMs: (config.timeoutSec || 300) * 1000, onEvent: wbEvent,
});
// 任务的重启恢复：服务自己发起的调用已不存在，这些尝试释放；已交稿但没来得及晋升的，补一次晋升
for (const { name } of workbench.list()) {
  const released = board.recover(name);
  if (released.length) console.log(`[${name}] 重启释放任务：${released.join('、')}`);
  for (const t of board.list(name, { state: 'submitted' })) {
    const sid = t.attempts.find((a) => a.n === t.attempt)?.sid;
    if (!sid) continue;
    const cid = gateway.log.cidOfSid(name, sid);
    if (cid) board.fence.onPromoted(name, t.id, { cid, records: gateway.log.applied(cid).records });
    else gateway.promote(name, sid).catch(() => {}); // 成败由提交入口回调任务状态
  }
}
// 租约到期的检查：读接口时会顺带清理，这里再定时扫一遍
setInterval(() => {
  for (const { name } of workbench.list()) board.sweep(name);
}, 30_000).unref();
// 主持人入口的令牌：每次启动重新生成，只出现在工坊页面里
const HOST_TOKEN = crypto.randomBytes(24).toString('hex');

// API 参与者（DeepSeek）没有命令行，有密钥就算可用
const resolveParticipant = (p) => (isApiAdapter(p) ? (process.env.DEEPSEEK_API_KEY ? 'DeepSeek API（DEEPSEEK_API_KEY）' : null) : resolveCommand(p.command));
const participants = config.participants.map((p) => ({ ...p, resolved: resolveParticipant(p) }));
const publicParticipant = (p) => ({
  id: p.id,
  name: p.name,
  aliases: p.aliases ?? [],
  color: p.color,
  icon: p.icon ?? null,
  persona: p.persona ?? '',
  model: p.model ?? null,
  effort: p.effort ?? null,
  combined: isCombined(p), // 模型 id 里已经包含推理强度（Gemini）
  available: !!p.resolved,
});

// 按 id / 名字 / 曾用名 找参与者（都不区分大小写）
function findParticipant(nameOrId) {
  const s = String(nameOrId).trim().toLowerCase();
  return participants.find((p) => [p.id, p.name, ...(p.aliases || [])].some((n) => n.toLowerCase() === s));
}

// 只改动界面可调的字段，config 里其它手写内容（包括 _model 这类备注键）原样保留
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

// 参与者改名后，把历史发言和记忆本里的旧名字统一成新名字
for (const p of participants) {
  for (const alias of p.aliases || []) {
    const n = store.renameAuthor(alias, p.name);
    if (n) console.log(`已把 ${n} 处「${alias}」更名为「${p.name}」`);
  }
}

// ---------- SSE 推送 ----------

const clients = new Set();
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

// ---------- 主持人调度 ----------
// 每个议题同一时间只有一个"会话"：自由讨论（discuss）或表决流程（proposal）

const sessions = new Map(); // threadId -> { kind, phase, current, pending:Set, queue, controllers:Set, stopped, proposalId, runId, seed }

function newSession(threadId, extra) {
  const s = { kind: 'discuss', phase: 'discuss', current: null, pending: new Set(), queue: [], controllers: new Set(), stopped: false, ...extra };
  sessions.set(threadId, s);
  return s;
}

function stopSession(s) {
  s.stopped = true;
  s.queue.length = 0;
  for (const c of s.controllers) c.abort();
}

const sessionView = (threadId) => {
  const s = sessions.get(threadId);
  return s
    ? { running: true, kind: s.kind, phase: s.phase, current: s.current, pending: [...s.pending], queue: [...s.queue], proposalId: s.proposalId ?? null, runId: s.runId ?? null, seed: s.seed ?? null }
    : { running: false, kind: null, phase: null, current: null, pending: [], queue: [], proposalId: null, runId: null, seed: null };
};
const broadcastSession = (threadId) => broadcast({ type: 'session', threadId, ...sessionView(threadId) });

// ---------- 记忆空间 ----------
// 记忆按「空间 / 参与者」归属：shared 是跨议题共享的长期记忆；其它空间互相隔离，可以从某个空间分支出来

const spaceOf = (thread) => thread?.memorySpace || 'shared';
const memKey = (space, owner) => `${space}/${owner}`;

// 配置里的 AI 用 id（自动研讨和 MCP 接入共用同一本），其它 MCP 来客按名字
function memoryOwner(nameOrKey, space = 'shared') {
  const s = String(nameOrKey).trim();
  if (s.startsWith('agent:')) return { owner: s, key: memKey(space, s), name: store.getMemory(memKey(space, s))?.name ?? s.slice(6) };
  const p = findParticipant(s);
  const owner = p ? p.id : `agent:${s.toLowerCase()}`;
  return { owner, key: memKey(space, owner), name: p ? p.name : s };
}

// 在场名单：配置里的 AI + 通过 MCP 进来发过言的其它 AI
function roster(thread) {
  const list = participants.filter((p) => p.resolved).map((p) => ({ name: p.name, aliases: p.aliases }));
  for (const post of thread.posts)
    if (post.kind === 'ai' && !list.some((r) => r.name === post.author)) list.push({ name: post.author });
  return list;
}

// 有效角色：议题里明确设置过（哪怕是空字符串 = 本议题不设角色）就用议题的，否则沿用全局
function personaOf(p, thread) {
  if (thread.personas && Object.hasOwn(thread.personas, p.id)) {
    const persona = thread.personas[p.id];
    return { persona, source: persona ? 'thread' : 'thread-none' };
  }
  return { persona: p.persona || '', source: p.persona ? 'global' : 'none' };
}

const agentOpts = (signal) => ({ cwd: SANDBOX, timeoutMs: (config.timeoutSec || 300) * 1000, signal });
const describe = ({ model, effort }) => (effort === undefined ? model ?? '?' : `${model ?? '?'} · ${effort ?? '默认'}`);

// ---------- 调用记录 ----------
// 每次调用 AI 都留一条完整快照（成功、失败、超时、中止、解析失败都记），分析时不会只看见成功的发言

function newCall({ thread, p, purpose, s, mem, mode, extra = {} }) {
  const { persona, source } = personaOf(p, thread);
  return {
    id: callLog.newId(),
    at: new Date().toISOString(),
    status: 'running',
    purpose, // discuss / vote / draft
    threadId: thread.id,
    runId: s?.runId ?? null,
    proposalId: s?.proposalId ?? null,
    participant: { id: p.id, name: p.name },
    config: { adapter: p.adapter, model: p.model ?? null, effort: p.effort ?? null, persona, personaSource: source, extraArgs: p.extraArgs ?? [] },
    memory: mode === 'off' ? { mode } : { mode, space: spaceOf(thread), read: mem?.version ?? 0 },
    ...extra,
  };
}

// 调用记录里的用量：DeepSeek 按价目估算美元；Claude 记录 CLI 报告的 modelUsage 与费用
function usageOf(p, usage, model) {
  if (!usage) return null;
  if (isApiAdapter(p)) {
    const cost = chatCost(usage, model, WB_DEFAULTS.pricing);
    return { ...usage, usd: cost.usd, usdEstimated: cost.estimated, peak: cost.peak };
  }
  return usage;
}

async function invoke(call, p, prompt, signal) {
  call.prompt = prompt;
  try {
    const r = await runAgent(p, prompt, { ...agentOpts(signal), deepseek });
    call.exec = r.exec;
    call.raw = r.raw;
    call.reported = { model: r.model ?? null, effort: r.effort ?? null };
    if (r.reasoning) call.reasoning = r.reasoning;
    call.usage = usageOf(p, r.usage, r.model);
    return r;
  } catch (e) {
    call.exec = e.details?.exec ?? null;
    if (e.details?.usage) call.usage = usageOf(p, e.details.usage, p.model);
    throw e;
  }
}

function finishCall(call, err) {
  call.endedAt = new Date().toISOString();
  call.durationMs = Date.parse(call.endedAt) - Date.parse(call.at);
  if (err) {
    call.status = err.kind ?? 'error'; // spawn / timeout / aborted / exit / empty / parse / error
    call.error = err.message;
  } else if (call.status === 'running') call.status = 'ok';
  if (call.exec) {
    const { stdoutTail, stderrTail, ...exec } = call.exec;
    call.exec = exec;
    call.stdoutTail = stdoutTail;
    call.stderrTail = stderrTail;
  }
  const summary = callLog.append(call);
  broadcast({ type: 'call', call: publicCall(summary) });
}

// 一次 AI 调用：登记 AbortController 以便"停止"能打断；无论成败都写调用记录；出错时广播而不是抛出
async function withAgent(threadId, s, p, call, fn) {
  const controller = new AbortController();
  s.controllers.add(controller);
  try {
    const result = await fn(controller.signal);
    finishCall(call);
    return result;
  } catch (e) {
    finishCall(call, e);
    console.error(`[#${threadId}] ${p.name} 失败（${e.kind ?? 'error'}）：${e.message}`);
    broadcast({ type: 'agent-error', threadId, agent: p.name, message: e.message });
    return null;
  } finally {
    s.controllers.delete(controller);
  }
}

// 读写模式下保存 AI 交回的新记忆本。写入前检查版本：如果读完之后别处已经写过新版本，就不覆盖，
// 把这次想写的内容留在调用记录里（避免两个并行议题互相覆盖）
function applyMemory(p, post, mem, newMemory, thread, call) {
  if (newMemory == null || newMemory === (mem?.content ?? '')) return;
  const space = spaceOf(thread);
  const key = memKey(space, p.id);
  const base = mem?.version ?? 0;
  const current = store.getMemory(key);
  if ((current?.version ?? 0) !== base) {
    store.patchPost(post.id, { memory: { ...post.memory, conflict: current.version } });
    call.memoryConflict = { base, current: current.version };
    call.memoryAttempt = newMemory;
    broadcast({
      type: 'agent-error', threadId: thread.id, agent: p.name,
      message: `记忆本写入冲突：读的是第 ${base} 版，写入时已经是第 ${current.version} 版。这次的修改没有覆盖，内容保存在调用记录 #${call.id} 里`,
    });
    return;
  }
  const rev = store.addMemory(key, { name: p.name, content: newMemory, source: 'ai', threadId: thread.id, postId: post.id, base });
  store.patchPost(post.id, { memory: { ...post.memory, wrote: rev.version } });
  call.memoryWrote = rev.version;
  broadcast({ type: 'memory', space, key: p.id, revision: rev });
}

// 表决进行中（或刚有一轮未通过）时，给讨论附一句背景
function proposalNote(threadId, thread) {
  const pr = store.proposalsOf(threadId).find((x) => x.status === 'open');
  if (!pr) return '';
  const latest = thread.posts.findLastIndex((x) => x.type === 'proposal' && x.proposalId === pr.id);
  const last = pr.rounds.findLast((r) => r.result);
  return `（本议题有一项待表决的提案，最新为第 ${pr.versions.length} 版，见 #${latest + 1}${last ? `；第 ${last.round} 轮表决未通过` : ''}。讨论可以围绕表决暴露出的分歧展开。）`;
}

function memoryFor(thread, p) {
  const mode = thread.memoryMode || 'rw';
  return { mode, mem: mode === 'off' ? null : store.getMemory(memKey(spaceOf(thread), p.id)) };
}

// 自由讨论中的一次发言（也可能是"本轮无新增意见"）
async function runTurn(threadId, p, s) {
  const thread = store.getThread(threadId);
  if (!thread) return;
  const { mode, mem } = memoryFor(thread, p);
  const call = newCall({ thread, p, purpose: 'discuss', s, mem, mode });
  await withAgent(threadId, s, p, call, async (signal) => {
    const prompt = buildPrompt({
      me: { ...p, persona: call.config.persona },
      thread,
      humanName: config.humanName,
      roster: roster(thread),
      maxChars: config.maxPromptChars || 60000,
      memory: mode === 'off' ? null : { mode, content: mem?.content ?? '' },
      note: proposalNote(threadId, thread),
    });
    const { raw, model, effort } = await invoke(call, p, prompt, signal);
    const reply = parseReply(raw, p.name, mode === 'rw');
    call.parsed = { pass: reply.pass, chars: reply.post.length };
    const post = store.addPost({
      threadId,
      author: p.name,
      kind: 'ai',
      via: 'round',
      content: reply.post,
      type: reply.pass ? 'pass' : undefined,
      callId: call.id,
      runId: s.runId,
      agent: { model, effort }, // 实际使用的模型与 effort（取自 CLI 的报告）
      memory: mode === 'off' ? undefined : { mode, space: spaceOf(thread), read: mem?.version ?? 0, wrote: null },
    });
    call.postId = post.id;
    applyMemory(p, post, mem, reply.memory, thread, call);
    broadcast({ type: 'post', post: publicPost(post) });
    const memNote = post.memory?.wrote ? `，记忆本 v${post.memory.read}→v${post.memory.wrote}` : '';
    console.log(`[#${threadId}] ${p.name}（${describe({ model, effort })}）${reply.pass ? '本轮无新增意见' : `发言 ${reply.post.length} 字`}${memNote}，用时 ${(call.exec.durationMs / 1000).toFixed(1)}s`);
  });
}

async function runQueue(threadId, s) {
  while (s.queue.length && !s.stopped) {
    const nextId = s.queue.shift(); // 注意别把 shift 写进 find 的回调里，那样每比较一次就弹出一个
    const p = participants.find((x) => x.id === nextId);
    if (!p) continue;
    s.current = p.id;
    broadcastSession(threadId);
    await runTurn(threadId, p, s);
  }
  s.current = null;
}

// 排出发言顺序并留下调度记录（随机时含种子，可用同一种子重现顺序）
function planRun(threadId, { kind, ids, rounds, order, seed, proposalId = null }) {
  const seedN = normalizeSeed(seed);
  const queue = buildQueue(ids, rounds, order, rngFrom(seedN));
  return store.createRun({ threadId, proposalId, kind, order, seed: order === 'random' ? seedN : null, ids, rounds, queue });
}

async function runRounds(threadId, ids, rounds, order, seed) {
  const run = planRun(threadId, { kind: 'discuss', ids, rounds, order, seed });
  const s = newSession(threadId, { queue: [...run.queue], runId: run.id, seed: run.seed });
  try {
    await runQueue(threadId, s);
  } finally {
    sessions.delete(threadId);
    broadcastSession(threadId);
  }
  return run;
}

// ---------- 密封投票：服务端隐藏 ----------
// 本轮结束前，任何对外接口（议题接口、SSE、导出、调用记录、MCP）都只看得到"已投票"

function sealedOpen(proposalId, round) {
  const pr = store.getProposal(proposalId);
  if (!pr || pr.ballot !== 'sealed') return false;
  const r = pr.rounds.find((x) => x.round === round);
  return !!r && !r.closedAt;
}

function publicPost(post) {
  if (post.type !== 'vote' || !sealedOpen(post.proposalId, post.round)) return post;
  const { content, vote, agent, memory, callId, ...rest } = post;
  return { ...rest, content: '', vote: null, sealed: true };
}

function publicCall(call) {
  if (call.purpose !== 'vote' || !sealedOpen(call.proposalId, call.round)) return call;
  const { raw, parsed, reported, memoryAttempt, stdoutTail, stderrTail, ...rest } = call;
  return { ...rest, sealed: true };
}

// ---------- 表决流程 ----------
// 投票 →（未通过）→ [讨论 N 轮] → 起草替代方案（起草人也可以拒绝）→ 投票 → ……
// 结束方式：通过 / 分歧保留（用完轮数、过半建议结束、起草人拒绝、主持人结束）/ 撤回

const HUMAN = 'human';
const broadcastProposal = (pr) => broadcast({ type: 'proposal', proposal: pr });
const voterKeyOf = (post) => (post.kind === 'human' ? HUMAN : findParticipant(post.author)?.id ?? post.author);
const voterNamesOf = (pr) => [
  ...pr.voters.map((id) => participants.find((p) => p.id === id)?.name ?? id),
  ...(pr.humanVotes ? [`${config.humanName}（人类）`] : []),
];

function currentRound(pr) {
  const r = pr.rounds[pr.rounds.length - 1];
  return r && !r.closedAt ? r : null;
}

// 新开一轮时定下唱票顺序：按座位，或用种子随机（每轮由提案种子 + 轮次派生）
function openRound(pr) {
  const existing = currentRound(pr);
  if (existing) return existing;
  return store.mutateProposal(pr.id, (x) => {
    const no = x.rounds.length + 1;
    const order = x.voteOrder === 'random' ? shuffle(x.voters, rngFrom((x.seed + no * 7919) % 2 ** 31)) : [...x.voters];
    x.rounds.push({ round: no, version: x.versions.length, order, openedAt: new Date().toISOString(), closedAt: null, result: null });
  }).rounds.at(-1);
}

// 新版本（第 1 版或替代方案）作为一条发言贴进讨论
function addVersion(pr, { text, rationale, author, kind, agent, callId }) {
  const version = pr.versions.length + 1;
  const post = store.addPost({
    threadId: pr.threadId, author, kind, via: 'proposal', content: text,
    type: 'proposal', proposalId: pr.id, version, rationale: rationale || undefined, agent, callId,
  });
  store.mutateProposal(pr.id, (x) => {
    x.versions.push({ version, text, rationale: rationale || '', author, postId: post.id, createdAt: post.createdAt });
    x.stage = 'vote';
    x.waiting = null;
  });
  broadcast({ type: 'post', post });
  broadcastProposal(store.getProposal(pr.id));
}

async function castAiVote(pr, round, p, s) {
  const threadId = pr.threadId;
  const thread = store.getThread(threadId);
  const { mode, mem } = memoryFor(thread, p);
  const call = newCall({ thread, p, purpose: 'vote', s, mem, mode, extra: { round: round.round, version: round.version } });
  await withAgent(threadId, s, p, call, async (signal) => {
    // 密封投票：本轮别人的票只露出"已投票"
    const hide = pr.ballot === 'sealed' ? (post) => post.type === 'vote' && post.proposalId === pr.id && post.round === round.round : null;
    const prompt = buildVotePrompt({
      me: { ...p, persona: call.config.persona },
      thread: store.getThread(threadId),
      proposal: store.getProposal(pr.id),
      round,
      voterNames: voterNamesOf(pr),
      maxChars: config.maxPromptChars || 60000,
      memory: mode === 'off' ? null : { mode, content: mem?.content ?? '' },
      hide,
    });
    const { raw, model, effort } = await invoke(call, p, prompt, signal);
    const v = parseVote(raw, mode === 'rw');
    const { memory: newMemory, reason, ...ballot } = v;
    call.parsed = ballot;
    if (store.votesOf(pr.id, round.round).some((x) => voterKeyOf(x) === p.id)) {
      call.status = 'duplicate'; // 期间被重复触发，这张票不计
      return;
    }
    const post = store.addPost({
      threadId, author: p.name, kind: 'ai', via: 'vote', content: reason || '（未写理由）',
      type: 'vote', proposalId: pr.id, round: round.round, version: round.version, callId: call.id,
      vote: { ...ballot, elapsedMs: call.exec.durationMs },
      agent: { model, effort },
      memory: mode === 'off' ? undefined : { mode, space: spaceOf(thread), read: mem?.version ?? 0, wrote: null },
    });
    call.postId = post.id;
    applyMemory(p, post, mem, newMemory, thread, call);
    broadcast({ type: 'post', post: publicPost(post) });
    console.log(`[#${threadId}] ${p.name}（${describe({ model, effort })}）投票：${CHOICE_LABEL[v.choice]} 信心 ${v.confidence ?? '-'}，用时 ${(call.exec.durationMs / 1000).toFixed(1)}s`);
  });
}

// 让还没投票的 AI 投票；返回本轮是否所有人（含主持人）都已投完
async function voteRound(pr, s) {
  const round = openRound(pr);
  broadcastProposal(store.getProposal(pr.id));
  const voted = () => new Set(store.votesOf(pr.id, round.round).map(voterKeyOf));
  const todo = round.order
    .filter((id) => !voted().has(id))
    .map((id) => participants.find((p) => p.id === id && p.resolved))
    .filter(Boolean);
  s.phase = 'vote';
  if (pr.ballot === 'sealed') {
    // 彼此看不到对方的票，可以同时投
    for (const p of todo) s.pending.add(p.id);
    broadcastSession(pr.threadId);
    await Promise.all(
      todo.map(async (p) => {
        await castAiVote(pr, round, p, s);
        s.pending.delete(p.id);
        broadcastSession(pr.threadId);
      })
    );
  } else {
    // 公开唱票：按本轮定下的顺序依次投，后投的能看到前面的票
    s.queue = todo.map((p) => p.id);
    for (const p of todo) {
      if (s.stopped) break;
      s.queue.shift();
      s.current = p.id;
      broadcastSession(pr.threadId);
      await castAiVote(pr, round, p, s);
    }
    s.current = null;
  }
  const done = voted();
  return [...pr.voters, ...(pr.humanVotes ? [HUMAN] : [])].every((k) => done.has(k));
}

const END_REASON = { concluded: 'suggested-end', deadlock: 'max-rounds' };

function closeRound(pr) {
  const round = currentRound(pr);
  const votes = store.votesOf(pr.id, round.round);
  const t = tally(votes, pr.rule);
  const outcome = decideOutcome(t, { round: round.round, maxRounds: pr.maxRounds });
  const updated = store.mutateProposal(pr.id, (x) => {
    const r = x.rounds[x.rounds.length - 1];
    r.closedAt = new Date().toISOString();
    r.result = { ...t, outcome };
    if (outcome === 'passed') x.status = 'passed';
    else if (END_REASON[outcome]) (x.status = 'deadlock'), (x.endReason = END_REASON[outcome]);
    x.stage = outcome === 'next' ? (x.discussRounds > 0 ? 'discuss' : 'draft') : outcome === 'evidence' ? 'evidence' : null;
    x.waiting = outcome === 'evidence' ? 'evidence' : null;
  });
  // 揭晓：密封的票现在对外公开
  for (const v of votes) broadcast({ type: 'post-updated', post: v });
  const post = store.addPost({
    threadId: pr.threadId, author: '表决', kind: 'system', via: 'vote',
    content: resultText({ round: round.round, version: round.version, t, rule: pr.rule, outcome, maxRounds: pr.maxRounds, discussRounds: pr.discussRounds }),
    type: 'result', proposalId: pr.id, round: round.round, version: round.version, result: { ...t, outcome, rule: pr.rule },
  });
  broadcast({ type: 'post', post });
  broadcastProposal(updated);
  console.log(`[#${pr.threadId}] 提案 ${pr.id} 第 ${round.round} 轮：赞成 ${t.yes} 保留 ${t.reserve} 反对 ${t.no} 弃权 ${t.abstain} → ${outcome}`);
  return outcome;
}

// 以"分歧保留"结束（起草人拒绝 / 主持人结束），并留一条说明
function concludeProposal(pr, reason, text) {
  const updated = store.mutateProposal(pr.id, (x) => {
    x.status = 'deadlock';
    x.endReason = reason;
    x.stage = null;
    x.waiting = null;
  });
  const post = store.addPost({
    threadId: pr.threadId, author: '表决', kind: 'system', via: 'vote', content: text,
    type: 'result', proposalId: pr.id, version: pr.versions.length, result: { outcome: reason },
  });
  broadcast({ type: 'post', post });
  broadcastProposal(updated);
}

function pickDrafter(pr) {
  if (pr.drafter === HUMAN) return HUMAN;
  if (pr.drafter && pr.drafter !== 'rotate') return pr.drafter;
  const pool = pr.voters.filter((id) => participants.some((p) => p.id === id && p.resolved));
  return pool[(pr.versions.length - 1) % pool.length];
}

// 返回是否产出了新版本；交给主持人起草、起草失败或起草人拒绝时返回 false
async function draftPhase(pr, s) {
  const drafterId = pickDrafter(pr);
  if (drafterId === HUMAN) {
    broadcastProposal(store.mutateProposal(pr.id, (x) => (x.waiting = 'draft')));
    return false;
  }
  const p = participants.find((x) => x.id === drafterId && x.resolved);
  if (!p) {
    broadcast({ type: 'agent-error', threadId: pr.threadId, agent: drafterId, message: '起草人不可用' });
    return false;
  }
  s.phase = 'draft';
  s.current = p.id;
  broadcastSession(pr.threadId);
  const thread = store.getThread(pr.threadId);
  const call = newCall({ thread, p, purpose: 'draft', s, mem: null, mode: 'off', extra: { version: pr.versions.length + 1 } });
  const ok = await withAgent(pr.threadId, s, p, call, async (signal) => {
    const latest = store.getProposal(pr.id);
    const lastRound = latest.rounds[latest.rounds.length - 1];
    const prompt = buildDraftPrompt({
      me: { ...p, persona: call.config.persona },
      thread: store.getThread(pr.threadId),
      proposal: latest,
      lastVotes: store.votesOf(pr.id, lastRound.round),
      maxChars: config.maxPromptChars || 60000,
    });
    const { raw, model, effort } = await invoke(call, p, prompt, signal);
    const d = parseDraft(raw);
    call.parsed = { declined: d.declined };
    if (d.declined) {
      concludeProposal(latest, 'drafter-declined', `**${p.name}** 选择不起草替代方案，表决以「分歧保留、未形成决议」结束。\n\n${d.reason}`);
      console.log(`[#${pr.threadId}] ${p.name} 拒绝起草：分歧保留`);
      return false;
    }
    addVersion(latest, { text: d.text, rationale: d.rationale, author: p.name, kind: 'ai', agent: { model, effort }, callId: call.id });
    console.log(`[#${pr.threadId}] ${p.name} 起草了第 ${latest.versions.length} 版，用时 ${(call.exec.durationMs / 1000).toFixed(1)}s`);
    return true;
  });
  s.current = null;
  return !!ok;
}

async function runProposal(proposalId) {
  const pr0 = store.getProposal(proposalId);
  if (!pr0 || pr0.status !== 'open' || sessions.has(pr0.threadId)) return;
  const threadId = pr0.threadId;
  const s = newSession(threadId, { kind: 'proposal', phase: pr0.stage, proposalId });
  try {
    while (!s.stopped) {
      const pr = store.getProposal(proposalId);
      if (!pr || pr.status !== 'open' || pr.waiting) break;
      if (pr.stage === 'vote') {
        const complete = await voteRound(pr, s);
        if (!complete || s.stopped) break; // 还差主持人的票，或有 AI 投票失败：暂停
        if (closeRound(store.getProposal(proposalId)) !== 'next') break;
      } else if (pr.stage === 'discuss') {
        s.phase = 'discuss';
        const ids = pr.voters.filter((id) => participants.some((p) => p.id === id && p.resolved));
        const run = planRun(threadId, { kind: 'proposal-discuss', ids, rounds: pr.discussRounds, order: config.order === 'random' ? 'random' : 'fixed', proposalId });
        s.runId = run.id;
        s.seed = run.seed;
        s.queue = [...run.queue];
        await runQueue(threadId, s);
        s.runId = null;
        if (s.stopped) break;
        broadcastProposal(store.mutateProposal(proposalId, (x) => (x.stage = 'draft')));
      } else if (pr.stage === 'draft') {
        if (!(await draftPhase(pr, s))) break;
      } else break; // evidence 等：等主持人
    }
  } finally {
    sessions.delete(threadId);
    broadcastSession(threadId);
    broadcastProposal(store.getProposal(proposalId));
  }
}

const startProposal = (id) => runProposal(id).catch((e) => console.error('表决流程出错：', e));

// ---------- HTTP ----------

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  // 先攒 Buffer 再统一解码，避免多字节的汉字恰好被切在两个分块之间
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, '请求太大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

function str(v, field, max, required = true) {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `缺少 ${field}`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} 必须是字符串`);
  const s = v.trim();
  if (required && !s) throw new HttpError(400, `${field} 不能为空`);
  if (s.length > max) throw new HttpError(400, `${field} 超过 ${max} 字`);
  return s;
}

// 发言人：网页端默认是主持人；MCP 端会带上自己的名字
function authorOf(body) {
  const author = str(body.author, 'author', 40, false);
  if (!author) return { author: config.humanName, kind: 'human', via: 'web' };
  const kind = body.kind === 'human' ? 'human' : 'ai';
  // MCP 端用 id / 旧名字报到时，统一记成参与者现在的名字
  const name = (kind === 'ai' && findParticipant(author)?.name) || author;
  return { author: name, kind, via: body.via === 'mcp' ? 'mcp' : 'web' };
}

function proposalOf(m) {
  const pr = store.getProposal(Number(m[1]));
  if (!pr) throw new HttpError(404, '提案不存在');
  return pr;
}

// 本议题的角色设定：{ 参与者 id: 文本 }。
// 文本（含空字符串）= 本议题明确设定（空字符串表示"本议题不设角色"）；null = 删除设定，沿用全局角色
function personasOf(input, current = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new HttpError(400, 'personas 必须是对象');
  const next = { ...current };
  for (const [id, text] of Object.entries(input)) {
    if (!participants.some((p) => p.id === id)) continue;
    if (text === null) delete next[id];
    else if (typeof text === 'string') {
      if (text.length > 2000) throw new HttpError(400, `personas.${id} 超过 2000 字`);
      next[id] = text.trim();
    } else throw new HttpError(400, `personas.${id} 必须是字符串或 null`);
  }
  return next;
}

function threadIdOf(m) {
  const id = Number(m[1]);
  if (!store.getThread(id)) throw new HttpError(404, `议题 #${id} 不存在`);
  return id;
}

const queryOf = (req) => new URL(req.url, 'http://localhost').searchParams;

// 记忆空间：?space=xxx 或 ?thread=议题id（取该议题所用的空间），都没有就是 shared
function spaceFromQuery(req) {
  const q = queryOf(req);
  if (q.get('thread')) return spaceOf(store.getThread(Number(q.get('thread'))));
  const space = q.get('space') || 'shared';
  if (!store.getSpace(space)) throw new HttpError(404, `记忆空间 ${space} 不存在`);
  return space;
}

// 新建议题 / 修改议题时选择记忆空间：现有空间 id，或 { name, parent } 新建（parent 非空即"分支"）
function resolveSpace(input) {
  if (input === undefined || input === null || input === '') return 'shared';
  if (typeof input === 'string') {
    if (!store.getSpace(input)) throw new HttpError(400, `记忆空间 ${input} 不存在`);
    return input;
  }
  const name = str(input.name, 'memorySpace.name', 60);
  const parent = input.parent ? String(input.parent) : null;
  if (parent && !store.getSpace(parent)) throw new HttpError(400, `记忆空间 ${parent} 不存在`);
  const space = store.createSpace({ name, parent });
  broadcast({ type: 'space', space });
  return space.id;
}

// 工坊是主页面；研讨室挪到 /talk（/workbench 保留为工坊的别名）
const STATIC = {
  '/': 'workbench.html', '/workbench': 'workbench.html', '/workbench.js': 'workbench.js', '/workbench.css': 'workbench.css',
  '/talk': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/i18n.js': 'i18n.js', '/locales/en.js': 'locales/en.js',
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const staticFile = (pathname) =>
  STATIC[pathname] ?? (/^\/icons\/[a-z0-9-]+\.svg$/.test(pathname) ? pathname.slice(1) : null);

const EFFORT_RE = /^[a-z]{2,10}$/;
const MODEL_RE = /^[\w.\-:/()\s]{1,80}$/;
const BALLOT_CHOICES = ['yes', 'reserve', 'no', 'abstain'];
const FACTS = ['agree', 'partial', 'disagree', 'unsure'];
const BASES = ['fact', 'value', 'interest', 'procedure', 'other'];

const spaceView = (s) => ({
  ...s,
  notebooks: store.memoryKeys(s.id).length,
  threads: store.listThreads().filter((t) => spaceOf(t) === s.id).length,
});

const routes = [
  ['GET', /^\/api\/state$/, () => ({
    humanName: config.humanName,
    orderMode: config.order === 'random' ? 'random' : 'fixed',
    participants: participants.map(publicParticipant),
    threads: store.listThreads(),
    spaces: store.listSpaces().map(spaceView),
  })],

  // 发言顺序：ids 调整座位顺序，mode 切换固定 / 随机；都会写回 config
  ['PUT', /^\/api\/order$/, async (req) => {
    const body = await readJson(req);
    if (body.mode !== undefined) {
      if (!['fixed', 'random'].includes(body.mode)) throw new HttpError(400, 'mode 只能是 fixed / random');
      config.order = body.mode;
    }
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) throw new HttpError(400, 'ids 必须是数组');
      const rank = (id) => {
        const i = body.ids.indexOf(id);
        return i < 0 ? Infinity : i;
      };
      const byRank = (a, b) => rank(a.id) - rank(b.id);
      participants.sort(byRank);
      config.participants.sort(byRank);
    }
    saveConfig();
    const view = { mode: config.order === 'random' ? 'random' : 'fixed', ids: participants.map((p) => p.id) };
    broadcast({ type: 'order', ...view });
    return view;
  }],

  // ---------- 记忆空间 ----------

  ['GET', /^\/api\/spaces$/, () => store.listSpaces().map(spaceView)],

  ['POST', /^\/api\/spaces$/, async (req) => {
    const body = await readJson(req);
    const id = resolveSpace({ name: body.name, parent: body.parent || null });
    return spaceView(store.getSpace(id));
  }],

  // ---------- 议题 ----------

  ['GET', /^\/api\/threads$/, () => store.listThreads()],

  ['POST', /^\/api\/threads$/, async (req) => {
    const body = await readJson(req);
    const title = str(body.title, 'title', 200);
    const content = str(body.content, 'content', 20000, false);
    const memoryMode = ['rw', 'ro', 'off'].includes(body.memoryMode) ? body.memoryMode : 'rw';
    const memorySpace = resolveSpace(body.memorySpace);
    const { thread, post } = store.createThread({ title, content, memoryMode, memorySpace, ...authorOf(body) });
    broadcast({ type: 'thread', thread });
    if (post) broadcast({ type: 'post', post });
    return { thread, post };
  }],

  ['GET', /^\/api\/threads\/(\d+)$/, (req, m) => {
    const id = threadIdOf(m);
    const t = store.getThread(id);
    return { ...t, posts: t.posts.map(publicPost), session: sessionView(id), proposals: store.proposalsOf(id) };
  }],

  ['DELETE', /^\/api\/threads\/(\d+)$/, (req, m) => {
    const id = threadIdOf(m);
    if (sessions.has(id)) stopSession(sessions.get(id));
    store.deleteThread(id);
    broadcast({ type: 'thread-deleted', threadId: id });
    return { ok: true };
  }],

  ['PUT', /^\/api\/threads\/(\d+)$/, async (req, m) => {
    const id = threadIdOf(m);
    const body = await readJson(req);
    const patch = {};
    if (body.title !== undefined) patch.title = str(body.title, 'title', 200);
    if (body.memoryMode !== undefined) {
      if (!['rw', 'ro', 'off'].includes(body.memoryMode)) throw new HttpError(400, 'memoryMode 只能是 rw / ro / off');
      patch.memoryMode = body.memoryMode;
    }
    if (body.memorySpace !== undefined) {
      if (sessions.has(id)) throw new HttpError(409, '议题进行中，不能切换记忆空间');
      patch.memorySpace = resolveSpace(body.memorySpace);
    }
    if (body.personas !== undefined) patch.personas = personasOf(body.personas, store.getThread(id).personas);
    const thread = store.updateThread(id, patch);
    broadcast({ type: 'thread-updated', thread });
    return thread;
  }],

  ['POST', /^\/api\/threads\/(\d+)\/posts$/, async (req, m) => {
    const threadId = threadIdOf(m);
    const body = await readJson(req);
    const post = store.addPost({ threadId, content: str(body.content, 'content', 20000), ...authorOf(body) });
    broadcast({ type: 'post', post });
    return post;
  }],

  ['DELETE', /^\/api\/posts\/(\d+)$/, (req, m) => {
    const t = store.getPost(Number(m[1]))?.type;
    if (t && t !== 'pass') throw new HttpError(400, '提案、投票和表决结果是表决记录的一部分，不能单独删除');
    const post = store.deletePost(Number(m[1]));
    if (!post) throw new HttpError(404, '发言不存在');
    broadcast({ type: 'post-deleted', postId: post.id, threadId: post.threadId });
    return { ok: true };
  }],

  // 自由讨论；随机顺序可以带 seed（数字或文本），不带就自动生成，都会记进调度记录
  ['POST', /^\/api\/threads\/(\d+)\/round$/, async (req, m) => {
    const threadId = threadIdOf(m);
    if (sessions.has(threadId)) throw new HttpError(409, '这个议题正在进行中，先等这一轮结束或点"停止"');
    const body = await readJson(req);
    const ids = (Array.isArray(body.participants) ? body.participants : participants.map((p) => p.id)).filter((id) =>
      participants.some((p) => p.id === id && p.resolved)
    );
    if (!ids.length) throw new HttpError(400, '没有可用的 AI 参与者');
    const rounds = Math.min(Math.max(Number(body.rounds) || 1, 1), 10);
    const order = ['fixed', 'random'].includes(body.order) ? body.order : config.order === 'random' ? 'random' : 'fixed';
    const promise = runRounds(threadId, ids, rounds, order, body.seed);
    promise.catch((e) => console.error('调度出错：', e));
    return { ...sessionView(threadId), order };
  }],

  ['POST', /^\/api\/threads\/(\d+)\/stop$/, (req, m) => {
    const s = sessions.get(Number(m[1]));
    if (s) stopSession(s);
    return { ok: true };
  }],

  // ---------- 调用记录 / 调度记录 ----------

  ['GET', /^\/api\/threads\/(\d+)\/calls$/, (req, m) => {
    const id = threadIdOf(m);
    return callLog.list((c) => c.threadId === id).map(publicCall);
  }],

  // 研究用：本议题所有调用的完整快照（含 prompt 与原始回复；未揭晓的密封票除外）
  ['GET', /^\/api\/threads\/(\d+)\/calls\/export$/, (req, m) => {
    const id = threadIdOf(m);
    return callLog.getMany((c) => c.threadId === id).map(publicCall);
  }],

  ['GET', /^\/api\/calls\/(\d+)$/, (req, m) => {
    const call = callLog.get(Number(m[1]));
    if (!call) throw new HttpError(404, '调用记录不存在');
    return publicCall(call);
  }],

  ['GET', /^\/api\/threads\/(\d+)\/runs$/, (req, m) => store.runsOf(threadIdOf(m))],

  // ---------- 表决 ----------

  // 发起表决：提案正文 + 规则 + 投票者 + 本议题的角色设定
  ['POST', /^\/api\/threads\/(\d+)\/proposals$/, async (req, m) => {
    const threadId = threadIdOf(m);
    if (store.proposalsOf(threadId).some((p) => p.status === 'open')) throw new HttpError(409, '这个议题已有一项进行中的提案，先完成或撤回它');
    if (sessions.has(threadId)) throw new HttpError(409, '这个议题正在进行中，先等这一轮结束或点"停止"');
    const body = await readJson(req);
    const text = str(body.text, 'text', 8000);
    const rule = RULES[body.rule] ? body.rule : 'consensus';
    const ballot = body.ballot === 'open' ? 'open' : 'sealed';
    const maxRounds = Math.min(Math.max(Number(body.maxRounds) || 3, 1), 10);
    const discussRounds = Math.min(Math.max(Number(body.discussRounds) || 0, 0), 5);
    const voters = (Array.isArray(body.voters) ? body.voters : []).filter((id) => participants.some((p) => p.id === id && p.resolved));
    const humanVotes = !!body.humanVotes;
    if (!voters.length) throw new HttpError(400, '至少需要一位可用的 AI 投票者');
    const drafter = body.drafter === HUMAN || voters.includes(body.drafter) ? body.drafter : 'rotate';
    const voteOrder = body.voteOrder === 'random' ? 'random' : 'fixed';
    if (body.personas !== undefined) {
      const thread = store.updateThread(threadId, { personas: personasOf(body.personas, store.getThread(threadId).personas) });
      broadcast({ type: 'thread-updated', thread });
    }
    const title = text.split('\n').find((l) => l.trim())?.replace(/^[#\s*>-]+/, '').slice(0, 40) || '提案';
    const pr = store.createProposal({
      threadId, title, rule, ballot, maxRounds, discussRounds, voters, humanVotes, drafter, voteOrder,
      seed: normalizeSeed(body.seed), createdBy: config.humanName,
    });
    addVersion(pr, { text, author: config.humanName, kind: 'human' });
    startProposal(pr.id);
    return store.getProposal(pr.id);
  }],

  // 主持人投票（AI 投票期间也可以投）
  ['POST', /^\/api\/proposals\/(\d+)\/vote$/, async (req, m) => {
    const pr = proposalOf(m);
    const round = currentRound(pr);
    if (pr.status !== 'open' || !round) throw new HttpError(409, '现在没有进行中的投票');
    if (!pr.humanVotes) throw new HttpError(400, '这项提案没有设置主持人投票');
    if (store.votesOf(pr.id, round.round).some((p) => p.kind === 'human')) throw new HttpError(409, '你已经投过这一轮了');
    const body = await readJson(req);
    if (!BALLOT_CHOICES.includes(body.choice)) throw new HttpError(400, `choice 只能是 ${BALLOT_CHOICES.join(' / ')}`);
    const conf = Number(body.confidence);
    const post = store.addPost({
      threadId: pr.threadId, author: config.humanName, kind: 'human', via: 'vote',
      content: str(body.reason, 'reason', 2000, false) || '（未写理由）',
      type: 'vote', proposalId: pr.id, round: round.round, version: round.version,
      vote: {
        choice: body.choice,
        confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, Math.round(conf))) : null,
        fact: FACTS.includes(body.fact) ? body.fact : null,
        basis: BASES.includes(body.basis) ? body.basis : null,
        condition: str(body.condition, 'condition', 1000, false) || '',
        evidence: str(body.evidence, 'evidence', 1000, false) || '',
        suggestEnd: !!body.suggestEnd,
        elapsedMs: Date.now() - Date.parse(round.openedAt), // 从本轮开始到投票的时间
      },
    });
    broadcast({ type: 'post', post: publicPost(post) });
    if (!sessions.has(pr.threadId)) startProposal(pr.id); // 如果只差这一票，会接着计票并推进
    return publicPost(post);
  }],

  // 主持人亲自起草替代方案（起草人设为"主持人"时流程会停在这里等；补充证据后也可以直接改稿）
  ['POST', /^\/api\/proposals\/(\d+)\/versions$/, async (req, m) => {
    const pr = proposalOf(m);
    if (pr.status !== 'open' || !['draft', 'evidence'].includes(pr.stage)) throw new HttpError(409, '现在不是起草替代方案的阶段');
    if (sessions.has(pr.threadId)) throw new HttpError(409, '流程正在进行中');
    const body = await readJson(req);
    addVersion(pr, {
      text: str(body.text, 'text', 8000),
      rationale: str(body.rationale, 'rationale', 2000, false),
      author: config.humanName,
      kind: 'human',
    });
    startProposal(pr.id);
    return store.getProposal(pr.id);
  }],

  // 有人请求证据时流程停下；主持人补充证据（直接在讨论里发言）后选择下一步：
  // revote = 就同一版本再表决一轮；continue = 按原计划讨论 / 起草替代方案
  ['POST', /^\/api\/proposals\/(\d+)\/(revote|continue)$/, (req, m) => {
    const pr = proposalOf(m);
    if (pr.status !== 'open' || pr.stage !== 'evidence') throw new HttpError(409, '现在不在等待证据的阶段');
    if (sessions.has(pr.threadId)) throw new HttpError(409, '流程正在进行中');
    if (m[2] === 'revote' && pr.rounds.length >= pr.maxRounds) throw new HttpError(409, '已经用完了最多轮数');
    store.mutateProposal(pr.id, (x) => {
      x.stage = m[2] === 'revote' ? 'vote' : x.discussRounds > 0 ? 'discuss' : 'draft';
      x.waiting = null;
    });
    startProposal(pr.id);
    return store.getProposal(pr.id);
  }],

  // 暂停（停止 / AI 出错）后继续
  ['POST', /^\/api\/proposals\/(\d+)\/resume$/, (req, m) => {
    const pr = proposalOf(m);
    if (pr.status !== 'open') throw new HttpError(409, '这项提案已经结束');
    if (sessions.has(pr.threadId)) throw new HttpError(409, '流程正在进行中');
    startProposal(pr.id);
    return { ok: true };
  }],

  // 主持人宣布结束：分歧保留、未形成决议（与"撤回"不同，这是一种结果）
  ['POST', /^\/api\/proposals\/(\d+)\/end$/, (req, m) => {
    const pr = proposalOf(m);
    if (pr.status !== 'open') throw new HttpError(409, '这项提案已经结束');
    const s = sessions.get(pr.threadId);
    if (s?.proposalId === pr.id) stopSession(s);
    if (currentRound(pr)) throw new HttpError(409, '本轮投票还没结束，先等投完或撤回提案');
    concludeProposal(pr, 'host-ended', `主持人宣布结束表决：分歧保留，未形成决议（共 ${pr.versions.length} 版、${pr.rounds.length} 轮表决）。`);
    return store.getProposal(pr.id);
  }],

  ['POST', /^\/api\/proposals\/(\d+)\/withdraw$/, (req, m) => {
    const pr = proposalOf(m);
    if (pr.status !== 'open') throw new HttpError(409, '这项提案已经结束');
    const s = sessions.get(pr.threadId);
    if (s?.proposalId === pr.id) stopSession(s);
    const updated = store.mutateProposal(pr.id, (x) => {
      x.status = 'withdrawn';
      x.stage = null;
      x.waiting = null;
      const r = x.rounds[x.rounds.length - 1];
      if (r && !r.closedAt) r.closedAt = new Date().toISOString(); // 撤回时未完成的一轮也揭晓
    });
    for (const r of updated.rounds) for (const v of store.votesOf(pr.id, r.round)) broadcast({ type: 'post-updated', post: v });
    const post = store.addPost({
      threadId: pr.threadId, author: '表决', kind: 'system', via: 'vote',
      content: `提案「${pr.title}」已由主持人撤回（进行到第 ${pr.versions.length} 版、${pr.rounds.length} 轮表决）。`,
      type: 'result', proposalId: pr.id, version: pr.versions.length, result: { outcome: 'withdrawn' },
    });
    broadcast({ type: 'post', post });
    broadcastProposal(updated);
    return updated;
  }],

  // 研究用：整项表决的结构化记录（未揭晓的密封票只给出"已投票"）
  ['GET', /^\/api\/proposals\/(\d+)\/export$/, (req, m) => {
    const pr = proposalOf(m);
    const thread = store.getThread(pr.threadId);
    const pick = (p) => {
      const pub = publicPost(p);
      if (pub.sealed) return { postId: p.id, voter: p.author, kind: p.kind, round: p.round, version: p.version, sealed: true };
      return {
        postId: p.id, voter: p.author, kind: p.kind, round: p.round, version: p.version, ...p.vote,
        reason: p.content, model: p.agent?.model ?? null, effort: p.agent?.effort ?? null, memory: p.memory ?? null, callId: p.callId ?? null, at: p.createdAt,
      };
    };
    return {
      thread: { id: thread.id, title: thread.title, memoryMode: thread.memoryMode || 'rw', memorySpace: spaceOf(thread), personas: thread.personas ?? {} },
      proposal: { ...pr, ruleDesc: RULES[pr.rule].desc },
      rounds: pr.rounds.map((r) => ({ ...r, votes: store.votesOf(pr.id, r.round).map(pick) })),
      runs: store.runsOf(thread.id).filter((r) => r.proposalId === pr.id),
    };
  }],

  // ---------- 记忆本（按空间） ----------

  // 某个空间里所有记忆本的概况（配置里的 AI 即使还没写过也列出来）
  ['GET', /^\/api\/memories$/, (req) => {
    const space = spaceFromQuery(req);
    const owners = [...new Set([...participants.map((p) => p.id), ...store.memoryKeys(space).map((k) => k.slice(space.length + 1))])];
    return owners.map((owner) => {
      const p = participants.find((x) => x.id === owner);
      const key = memKey(space, owner);
      const history = store.memoryHistory(key);
      return {
        key: owner,
        space,
        name: p?.name ?? history[0]?.name ?? owner,
        color: p?.color ?? null,
        icon: p?.icon ?? null,
        current: store.getMemory(key),
        count: history.length,
      };
    });
  }],

  // 单本记忆的完整历史。:key 可以是参与者 id，也可以是 AI 的名字（MCP 端用名字查）
  ['GET', /^\/api\/memories\/([^/]+)$/, (req, m) => {
    const space = spaceFromQuery(req);
    const { owner, key, name } = memoryOwner(decodeURIComponent(m[1]), space);
    const threads = new Map(store.listThreads().map((t) => [t.id, t.title]));
    const revisions = store.memoryHistory(key).map((r) => ({ ...r, threadTitle: threads.get(r.threadId) ?? null }));
    return { key: owner, space, name, revisions };
  }],

  // 写入新版本：网页端是主持人编辑 / 植入；MCP 端带 author，是 AI 自己写。
  // 带 baseVersion 时做冲突检查：读的不是最新版就拒绝写入
  ['PUT', /^\/api\/memories\/([^/]+)$/, async (req, m) => {
    const space = spaceFromQuery(req);
    const { owner, key, name } = memoryOwner(decodeURIComponent(m[1]), space);
    const body = await readJson(req);
    const content = str(body.content, 'content', MEMORY_MAX_CHARS, false) ?? '';
    const current = store.getMemory(key)?.version ?? 0;
    if (Number.isInteger(body.baseVersion) && body.baseVersion !== current)
      throw new HttpError(409, `记忆本已被更新：你读的是第 ${body.baseVersion} 版，现在是第 ${current} 版，请重新读取后再写`);
    const threadId = Number.isInteger(body.threadId) && store.getThread(body.threadId) ? body.threadId : null;
    const rev = store.addMemory(key, { name, content, source: body.author ? 'mcp' : 'human', threadId, base: Number.isInteger(body.baseVersion) ? body.baseVersion : null });
    broadcast({ type: 'memory', space, key: owner, revision: rev });
    return { key: owner, space, ...rev };
  }],

  // 可选的模型 / effort，供设置对话框使用
  ['GET', /^\/api\/participants\/([\w-]+)\/options$/, async (req, m) => {
    const p = participants.find((x) => x.id === m[1]);
    if (!p) throw new HttpError(404, '参与者不存在');
    try {
      return await listOptions(p);
    } catch (e) {
      // 拿不到列表时界面退化为手动输入
      return { combined: isCombined(p), models: [], efforts: [], error: e.message };
    }
  }],

  // 修改全局角色设定 / 模型 / effort；只更新请求里带了的字段，空字符串表示恢复默认（从 config 中删除）
  ['PUT', /^\/api\/participants\/([\w-]+)$/, async (req, m) => {
    const p = participants.find((x) => x.id === m[1]);
    if (!p) throw new HttpError(404, '参与者不存在');
    const body = await readJson(req);
    const saved = config.participants.find((x) => x.id === p.id);
    const set = (key, value) => {
      if (value) p[key] = saved[key] = value;
      else delete p[key], delete saved[key];
    };
    if (body.persona !== undefined) set('persona', str(body.persona, 'persona', 2000, false) ?? '');
    if (body.model !== undefined) {
      const model = str(body.model, 'model', 80, false);
      if (model && !MODEL_RE.test(model)) throw new HttpError(400, '模型名格式不对');
      set('model', model);
    }
    if (body.effort !== undefined) {
      const effort = str(body.effort, 'effort', 10, false);
      if (effort && !EFFORT_RE.test(effort)) throw new HttpError(400, 'effort 格式不对');
      set('effort', isCombined(p) ? undefined : effort); // Gemini 的强度含在模型 id 里
    }
    saveConfig();
    broadcast({ type: 'participant', participant: publicParticipant(p) });
    return publicParticipant(p);
  }],

  ...workbenchRoutes({
    workbench, gateway, web, usage, board, runner, sealed, readJson, hostToken: HOST_TOKEN, humanName: config.humanName,
    participantByName: (name) => findParticipant(name),
  }),
];

const server = http.createServer(async (req, res) => {
  try {
    // 防 DNS rebinding / 跨站请求：只认本机 Host，写操作要求 JSON 且同源
    if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Host 不被允许');
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, '跨站请求被拒绝');
      if (req.method !== 'DELETE' && !String(req.headers['content-type']).startsWith('application/json'))
        throw new HttpError(415, '需要 application/json');
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && staticFile(url.pathname)) {
      const file = path.join(ROOT, 'public', staticFile(url.pathname));
      if (!fs.existsSync(file)) throw new HttpError(404, '文件不存在');
      res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      // 工坊页面里填入主持人入口令牌
      if (path.basename(file) === 'workbench.html') return res.end(fs.readFileSync(file, 'utf8').replace('__WB_HOST_TOKEN__', HOST_TOKEN));
      return fs.createReadStream(file).pipe(res);
    }

    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) return send(res, 200, await handler(req, m));
    }
    throw new HttpError(404, '没有这个接口');
  } catch (e) {
    if (!(e instanceof HttpError) && !e.status) console.error(e); // 工坊模块的错误自带 status
    send(res, e.status || 500, { error: e.message, ...(e.details ? { details: e.details } : {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nWETALK 工坊已启动：http://localhost:${PORT}/\n研讨室：http://localhost:${PORT}/talk\n`);
  for (const p of participants) console.log(`  ${p.resolved ? '✓' : '✗'} ${p.name.padEnd(12)} ${p.resolved || '（未找到命令，自动发言不可用）'}`);
  console.log(`工坊项目目录：${PROJECTS_DIR}${workbenchStart.init.git ? '' : `（git 不可用，暂不留档：${workbenchStart.init.gitError}）`}`);
  const { redone, dropped } = workbenchStart.recovered;
  if (redone.length || dropped.length) console.log(`崩溃恢复：重做 ${redone.length} 个未完成的提交，丢弃 ${dropped.length} 个未写完的清单`);
  console.log(`\nMCP 接入：node ${path.join(ROOT, 'mcp.mjs')}（环境变量 WETALK_AGENT=你的名字）\n`);
});
