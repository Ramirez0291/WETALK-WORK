// 把各家 AI 的命令行工具包装成同一个接口：给一段 prompt，拿回一段发言。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeepseekClient } from './workbench/deepseek.mjs';

const isWin = process.platform === 'win32';

// ---------- 可执行文件定位 ----------

const expandEnv = (s) => s.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '');

function searchPath(name) {
  const exts = isWin ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

// 支持一层目录通配，例如 %LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe（取最新的那个）
function resolveCandidate(c) {
  const s = expandEnv(c);
  if (!/[\\/]/.test(s)) return searchPath(s);
  if (!s.includes('*')) return fs.existsSync(s) ? s : null;
  const [pre, post] = s.split('*');
  let best = null;
  try {
    for (const d of fs.readdirSync(pre)) {
      const f = path.join(pre, d, post);
      try {
        const m = fs.statSync(f).mtimeMs;
        if (!best || m > best.m) best = { f, m };
      } catch {}
    }
  } catch {}
  return best?.f ?? null;
}

export function resolveCommand(command) {
  for (const c of [].concat(command)) {
    const f = resolveCandidate(c);
    if (f) return f;
  }
  return null;
}

// ---------- 进程执行 ----------

function killTree(child) {
  if (!child.pid) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function run(file, args, { stdin, cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // 避免被识别成"嵌套在另一个 Claude Code 会话里"
    let child;
    if (isWin && /\.(cmd|bat)$/i.test(file)) {
      const q = (a) => (/[\s"&|<>^]/.test(a) || a === '' ? `"${a.replace(/"/g, '""')}"` : a);
      child = spawn(`"${file}" ${args.map(q).join(' ')}`, { cwd, env, shell: true, windowsHide: true });
    } else {
      child = spawn(file, args, { cwd, env, windowsHide: true });
    }
    let stdout = '';
    let stderr = '';
    let killedBy = null;
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      killedBy = 'timeout';
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      killedBy = 'abort';
      killTree(child);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      done();
      reject(new AgentError('spawn', `无法启动：${e.message}`, { stdout, stderr }));
    });
    child.on('close', (code) => {
      done();
      if (killedBy === 'timeout') return reject(new AgentError('timeout', `超时（${Math.round(timeoutMs / 1000)} 秒）`, { code, stdout, stderr }));
      if (killedBy === 'abort') return reject(new AgentError('aborted', '已被主持人中止', { code, stdout, stderr }));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin, 'utf8');
  });
}

const tail = (s, n = 600) => (s.length > n ? '…' + s.slice(-n) : s).trim();

// 调用失败的分类：spawn / timeout / aborted / exit（CLI 报错或没给出结果）/ empty / parse（回复格式不对）。
// details 里带着 stdout、stderr、退出码，供调用记录保存。
export class AgentError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

// CLI 版本：按"文件路径 + 修改时间"缓存，CLI 自动更新后会重新读取
const versionCache = new Map();
export async function cliVersion(file) {
  let key = file;
  try {
    key += ':' + fs.statSync(file).mtimeMs;
  } catch {}
  if (versionCache.has(key)) return versionCache.get(key);
  let version = null;
  try {
    const r = await run(file, ['--version'], { stdin: '', cwd: os.tmpdir(), timeoutMs: 20_000 });
    version = (r.stdout + r.stderr).split(/\r?\n/).find((l) => /\d+\.\d+/.test(l))?.trim() ?? null;
  } catch {}
  versionCache.set(key, version);
  return version;
}

// ---------- 各家适配器 ----------
// 共同点：prompt 一律走 stdin（Windows 命令行长度上限约 32K 字符，长讨论塞不进参数）。

// 工坊任务里 Codex 关掉的功能（各自经 codex-cli 0.162 实测接受）。CLI 升级后要重跑 live-agents 实测
export const CODEX_LOCKDOWN = [
  ...['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'image_generation', 'tool_suggest', 'skill_search', 'multi_agent', 'goals', 'view_image', 'sleep_tool']
    .flatMap((f) => ['--disable', f]),
  '-c', 'web_search="disabled"',
];

// Codex --json 的事件流：逐行 JSON。最后一条 agent_message 是回复；除 agent_message 与推理摘要之外的任何 item
// （command_execution、mcp_tool_call、file_change、web_search，以及以后新增的类型）都算工具使用，记进审计。
const NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning']);
export function parseCodexEvents(r, p = {}) {
  const tools = [];
  let text = '';
  let usage = null;
  let error = null;
  let parsed = 0;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    parsed++;
    const it = ev.item;
    if (it && ev.type === 'item.completed' && it.type === 'agent_message') text = it.text ?? text;
    // 同一个 item 的开始与完成事件只记一次；只报完成事件的工具同样记下
    if (it && !NON_TOOL_ITEMS.has(it.type) && !tools.some((t) => t.id === (it.id ?? null) && it.id)) {
      tools.push({ id: it.id ?? null, type: it.type, command: it.command ?? null, server: it.server ?? null, tool: it.tool ?? null, arguments: it.arguments ?? null });
    }
    if (ev.type === 'turn.completed') usage = ev.usage ?? null;
    if (ev.type === 'turn.failed' || ev.type === 'error') error = ev.error?.message ?? ev.message ?? JSON.stringify(ev).slice(0, 300);
  }
  if (!parsed) throw new AgentError('exit', `没有拿到 JSON 事件（退出码 ${r.code}）：${tail(r.stderr || r.stdout)}`);
  if (error && !text) throw new AgentError('exit', `Codex 报错：${error}`);
  const audit = { source: 'codex-json-events', toolEvents: tools, independence: tools.length ? 'unproven' : 'clean' };
  return { text, model: p.model ?? null, effort: p.effort ?? null, usage, audit };
}

// parse 统一返回 { text, model, effort }：model / effort 尽量取 CLI 自己报告的实际值，取不到时用配置值，都没有则为 null
const adapters = {
  // Claude Code：-p 无头模式，--tools "" 关掉所有内置工具，只让它说话；json 输出里的 modelUsage 是实际用到的模型
  claude: {
    // 讨论与全部工坊任务：--tools "" 关掉全部工具（--strict-mcp-config 且不给配置：也没有 MCP）。
    // WP4 在 Windows 上实测过：只开 Read/Glob/Grep、工作目录设为临时目录时，Claude 照样能读、能列出工作目录以外的文件，
    // 权限层没有拦截。所以工坊任务一律把输入内联进提示词，不给任何工具（见 WP4 日志）
    // 带图片（WP7b 的视觉检查）：改用 stream-json 输入，一条用户消息里放文字和图片（base64），输出也是 stream-json，
    // 最后一条 type 为 result 的事件与 json 输出的字段相同。工具照样全部关掉
    args: (p, ctx) => [
      '-p', '--strict-mcp-config',
      ...(ctx.attachments?.length ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
      ...(p.model ? ['--model', p.model] : []), ...(p.effort ? ['--effort', p.effort] : []),
      ...(ctx.mode ? [] : p.extraArgs || []),
      '--tools', '',
    ],
    stdin: (prompt, ctx) => (ctx.attachments?.length
      ? JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...ctx.attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: fs.readFileSync(a.path).toString('base64') } })),
          ],
        },
      }) + '\n'
      : prompt),
    parse: (r, ctx, p) => {
      let out;
      try {
        out = ctx.attachments?.length
          ? r.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).findLast((ev) => ev.type === 'result')
          : JSON.parse(r.stdout);
        if (!out) throw new Error('没有 result 事件');
      } catch {
        throw new AgentError('exit', `退出码 ${r.code}：${tail(r.stderr || r.stdout)}`);
      }
      if (out.is_error) throw new AgentError('exit', out.result || out.subtype || '调用失败');
      // 可能有辅助模型参与，取输出 token 最多的那个当主模型
      const usage = Object.entries(out.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
      return {
        text: out.result,
        model: usage[0]?.[0] ?? p.model ?? null,
        effort: p.effort ?? null,
        // 订阅版 CLI 报告的用量：各模型的 token 与估算费用
        usage: out.modelUsage ? { modelUsage: out.modelUsage, total_cost_usd: out.total_cost_usd ?? null } : null,
        // 工坊任务：记下被权限规则拒绝的工具调用（例如读工作目录以外的文件），作为隔离实测的证据
        audit: ctx.mode ? { source: 'claude-json', toolEvents: [], permission_denials: out.permission_denials ?? [], independence: 'clean' } : null,
      };
    },
  },

  // Codex：exec 无头模式，只读沙箱，最后一条消息写入临时文件；stderr 开头的横幅里有 model 和 reasoning effort
  codex: {
    // 讨论：沿用原来的方式（最后一条消息写进临时文件）。
    // 工坊任务（ctx.mode）：--json 事件输出、不加载用户配置（用户配置里的 MCP 服务也是读取通道）、不写临时文件，
    // 并关掉能关的全部工具：shell、内置应用（含网络搜索 search_service）、插件、浏览器、电脑操作、图片、多 Agent 等。
    // 实测（codex-cli 0.162）这样之后仍剩协作类与延迟暴露的工具，关不干净，所以事件审计才是真正的防线（见 WP4 日志）。
    // 输入一律内联在提示词里，不需要读任何文件。
    args: (p, ctx) =>
      ctx.mode
        ? [
          'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--ignore-user-config',
          ...CODEX_LOCKDOWN,
          '-C', ctx.cwd,
          ...(p.model ? ['-m', p.model] : []), ...(p.effort ? ['-c', `model_reasoning_effort="${p.effort}"`] : []),
          '-',
        ]
        : [
          'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
          '-C', ctx.cwd, '-o', ctx.outFile,
          ...(p.model ? ['-m', p.model] : []), ...(p.effort ? ['-c', `model_reasoning_effort="${p.effort}"`] : []),
          ...(p.extraArgs || []), '-',
        ],
    stdin: (prompt) => prompt,
    parse: (r, ctx, p) => {
      if (ctx.mode) return parseCodexEvents(r, p);
      let text = '';
      try {
        text = fs.readFileSync(ctx.outFile, 'utf8');
        fs.unlinkSync(ctx.outFile);
      } catch {}
      if (!text.trim()) throw new AgentError('exit', `没有拿到回复（退出码 ${r.code}）：${tail(r.stderr || r.stdout)}`);
      const model = r.stderr.match(/^model:\s*(.+?)\s*$/m)?.[1] ?? p.model ?? null;
      const effort = r.stderr.match(/^reasoning effort:\s*(.+?)\s*$/m)?.[1] ?? p.effort ?? null;
      return { text, model, effort };
    },
  },

  // Gemini（经由 Antigravity CLI）：agy 的 -p 只接受参数形式的 prompt，长文本改走 stream-json 输入。
  // 模型 id 本身就带推理强度（gemini-3.8-flash-high），所以不单独传 effort。
  // 它的输出不报告模型，但日志里有 "selected model override ... label=..."，所以每次指定一个临时日志文件去读。
  agy: {
    combined: true,
    args: (p, ctx) => [
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands',
      '--log-file', ctx.logFile,
      ...(p.model ? ['--model', p.model] : []),
      ...(p.extraArgs || []), '-p=',
    ],
    stdin: (prompt) => JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n',
    parse: (r, ctx, p) => {
      let result = null;
      for (const line of r.stdout.split(/\r?\n/)) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'result') result = ev.result;
        } catch {}
      }
      let model = p.model ?? null;
      try {
        const log = fs.readFileSync(ctx.logFile, 'utf8');
        const labels = [...log.matchAll(/selected model override to backend: label="([^"]+)"/g)];
        if (labels.length) model = labels[labels.length - 1][1];
        fs.unlinkSync(ctx.logFile);
      } catch {}
      if (!result) throw new AgentError('exit', `没有拿到结果（退出码 ${r.code}）：${tail(r.stderr || r.stdout)}`);
      if (result.status !== 'SUCCESS') throw new AgentError('exit', result.error || result.status);
      return { text: result.response, model }; // effort 已含在模型名里
    },
  },

  // 其它任意 CLI：stdin 进、stdout 出。带图片时，提示词末尾按顺序列出图片文件的路径
  generic: {
    args: (p) => p.args || [],
    stdin: (prompt, ctx) => (ctx.attachments?.length ? `${prompt}\n附图（按顺序）：\n${ctx.attachments.map((a) => `- ${a.name}：${a.path}`).join('\n')}\n` : prompt),
    parse: (r, ctx, p) => {
      if (r.code !== 0) throw new AgentError('exit', `退出码 ${r.code}：${tail(r.stderr || r.stdout)}`);
      return { text: r.stdout, model: p.model ?? null, effort: p.effort ?? null };
    },
  },
};

// ---------- 可选的模型 / effort（给界面上的下拉框用） ----------

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// DeepSeek：API 调用，不是命令行。effort 对应 reasoning_effort，none 表示关闭思考
const DEEPSEEK_MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];
const DEEPSEEK_EFFORTS = ['none', 'low', 'high', 'max'];
export const isApiAdapter = (p) => p.adapter === 'deepseek';

// Codex 在本地缓存了服务端下发的模型列表，里面有每个模型支持的推理强度
function codexOptions() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (data.models || [])
    .filter((m) => m.visibility !== 'hide')
    .map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level ?? null,
    }));
}

// agy models 要联网，结果缓存 10 分钟
let agyCache = null;
async function agyOptions(file) {
  if (agyCache && Date.now() - agyCache.at < 600_000) return agyCache.models;
  const r = await run(file, ['models'], { stdin: '', cwd: os.tmpdir(), timeoutMs: 60_000 });
  const models = r.stdout
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter(([id, label]) => id && label && !/\s/.test(id))
    // agy 也能调用别家模型；选了它们，「Gemini」席位上坐的其实就是别人了，所以标出来
    .map(([id, label]) => ({ id: id.trim(), label: id.startsWith('gemini') ? label.trim() : `${label.trim()}（⚠ 非 Gemini）` }));
  if (!models.length) throw new Error(`agy models 没有返回模型：${tail(r.stderr || r.stdout)}`);
  agyCache = { at: Date.now(), models };
  return models;
}

// 返回 { combined, models: [{ id, label, efforts?, defaultEffort? }], efforts }
export async function listOptions(p) {
  const adapter = adapters[p.adapter] || adapters.generic;
  const combined = !!adapter.combined;
  if (p.adapter === 'claude') return { combined, models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS };
  if (p.adapter === 'deepseek') return { combined, models: DEEPSEEK_MODELS, efforts: DEEPSEEK_EFFORTS };
  if (p.adapter === 'codex') return { combined, models: codexOptions(), efforts: [] };
  if (p.adapter === 'agy') {
    const file = resolveCommand(p.command);
    if (!file) throw new Error('找不到 agy 命令');
    return { combined, models: await agyOptions(file), efforts: [] };
  }
  return { combined, models: [], efforts: [] };
}

export const isCombined = (p) => !!(adapters[p.adapter] || adapters.generic).combined;

function cleanReply(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .trim()
    .replace(new RegExp(`^(\\*\\*)?[【\\[]?${esc}[】\\]]?(\\*\\*)?\\s*[:：]\\s*`, 'i'), '')
    .trim();
}

// DeepSeek 走 API：deepseek 是共用的客户端（不给就按环境变量新建一个），hooks 是预算检查与记账（项目任务才有）
// retry：工坊任务传入项目的生效重试策略；研讨室发言不传，用客户端默认值
async function runDeepseek(p, prompt, { timeoutMs, signal, deepseek, hooks = {}, retry }) {
  const client = deepseek ?? createDeepseekClient();
  const model = p.model || 'deepseek-flash';
  const exec = { api: 'deepseek', endpoint: '/chat/completions', model, attempts: [], durationMs: 0, finish: null };
  const t0 = Date.now();
  let r;
  try {
    r = await client.chat({ model, prompt, effort: p.effort ?? undefined, maxTokens: p.maxTokens ?? undefined }, { timeoutMs, signal, retry, ...hooks });
  } catch (e) {
    exec.durationMs = Date.now() - t0;
    exec.attempts = e.details?.attempts ?? [];
    const err = e instanceof AgentError ? e : new AgentError('exit', e.message);
    err.details = { ...err.details, exec };
    throw err;
  }
  exec.durationMs = Date.now() - t0;
  exec.attempts = r.attempts;
  exec.finish = r.finish;
  const raw = (r.text || '').trim();
  if (!raw) throw new AgentError('empty', `回复为空（finish_reason=${r.finish}）`, { exec, usage: r.usage });
  return { raw, model: r.model, effort: p.effort ?? null, exec, usage: r.usage, reasoning: r.reasoning };
}

// 返回 { raw, model, effort, exec, usage }；失败时抛出 AgentError，e.details.exec 里同样带着执行细节。
// exec = { file, args, cliVersion, code, durationMs, stdoutTail, stderrTail }（API 调用为 { api, endpoint, attempts, … }），供调用记录保存。
// 能看图的适配器（WP7b）：Claude 实测过；通用适配器把图片路径写进提示词（测试与自带脚本用）。
// Codex 的图片参数这一版没有实测过，DeepSeek 接口不收图片，agy 不接工坊任务：都不接
export const canSeeImages = (p) => ['claude', 'generic'].includes(p.adapter ?? 'generic');

// opts.attachments：[{ path, mediaType, name }]，按顺序附上的图片
export async function runAgent(p, prompt, opts) {
  if (opts.attachments?.length && !canSeeImages(p)) throw new AgentError('spawn', `${p.name ?? p.id} 的适配器（${p.adapter}）这一版不能附图片`, { exec: { file: null, args: [] } });
  if (isApiAdapter(p)) return runDeepseek(p, prompt, opts);
  const { cwd, timeoutMs, signal, mode = null } = opts;
  // agy 会把日志写进临时文件、还能调用别家模型，工坊任务的可见性无法保证，不接
  if (mode && p.adapter === 'agy') throw new AgentError('spawn', 'agy 适配器不支持工坊任务（日志落盘、模型不确定）', { exec: { file: null, args: [] } });
  const adapter = adapters[p.adapter] || adapters.generic;
  const file = resolveCommand(p.command); // 每次都重新解析：CLI 自动更新后路径可能变化
  if (!file) throw new AgentError('spawn', `找不到命令：${[].concat(p.command).join(' / ')}`, { exec: { file: null, args: [] } });
  fs.mkdirSync(cwd, { recursive: true });
  const stamp = `wetalk-${p.id}-${Date.now()}`;
  const ctx = { cwd, mode, attachments: opts.attachments ?? null, outFile: path.join(os.tmpdir(), `${stamp}.txt`), logFile: path.join(os.tmpdir(), `${stamp}.log`) };
  const args = adapter.args(p, ctx);
  const exec = { file, args, cliVersion: await cliVersion(file), code: null, durationMs: 0, stdoutTail: '', stderrTail: '' };
  const t0 = Date.now();
  const fill = (r) => {
    exec.durationMs = Date.now() - t0;
    exec.code = r?.code ?? null;
    exec.stdoutTail = tail(r?.stdout ?? '', 4000);
    exec.stderrTail = tail(r?.stderr ?? '', 4000);
  };
  let r;
  try {
    r = await run(file, args, { stdin: adapter.stdin(prompt, ctx), cwd, timeoutMs, signal });
  } catch (e) {
    fill(e.details);
    e.details = { ...e.details, exec };
    throw e;
  }
  fill(r);
  try {
    const { text, model, effort, usage = null, audit = null } = adapter.parse(r, ctx, p);
    const raw = (text || '').trim();
    if (!raw) throw new AgentError('empty', '回复为空', { audit });
    return { raw, model, effort, exec, usage, audit };
  } catch (e) {
    const err = e instanceof AgentError ? e : new AgentError('exit', e.message);
    err.details = { ...err.details, exec };
    throw err;
  }
}

// ---------- 记忆本 ----------

export const MEMORY_MAX_CHARS = 4000;
const MEMORY_MARK = /\**<<<\s*记忆本\s*>>>\**/;

// 拆出 <<<记忆本>>> 之后的部分。memory 为 null 表示不更新。
export function splitMemory(raw, expectMemory) {
  const idx = raw.search(MEMORY_MARK);
  if (idx < 0) return { body: raw, memory: null };
  let memory = raw
    .slice(idx)
    .replace(MEMORY_MARK, '')
    .trim()
    .replace(/^```\w*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  if (!expectMemory || /^[（(]?\s*不变\s*[）)。.]?$/.test(memory)) memory = null;
  return { body: raw.slice(0, idx), memory: memory?.slice(0, MEMORY_MAX_CHARS) ?? null };
}

// 「本轮无新增意见」：允许不为发言而发言。后面可以跟一句简短说明
const PASS_RE = /^[「“"*\s]*(?:本轮)?无新增意见[」”"*]?\s*(?:[:：，,。.—\-]\s*([\s\S]{0,200}))?$/;

// 把 AI 的输出拆成「发言」和「更新后的记忆本」；pass 为真表示这一轮选择不发言
export function parseReply(raw, name, expectMemory) {
  const { body, memory } = splitMemory(raw, expectMemory);
  const post = cleanReply(body, name);
  if (!post) throw new AgentError('parse', '只写了记忆本，没有发言');
  const m = post.replace(/\*\*/g, '').match(PASS_RE);
  if (m) return { post: (m[1] || '').trim(), memory, pass: true };
  return { post, memory, pass: false };
}

// task 决定记忆本放在什么之后写：发言 / 投票
export function memorySection(memory, task = '发言') {
  if (!memory) return { rules: '', block: '', ask: '' };
  const block = `======== 你的记忆本（只有你自己和主持人能看到） ========
${memory.content.trim() || '（还是空的——这是你第一次在 WeTalk 留下记忆。）'}
======== 记忆本结束 ========
`;
  const common = `关于记忆本：
- 这是你在以往的研讨中亲手写下的笔记，在同一个记忆空间里跨议题保留。它代表过去的你：你可以坚持其中的观点，也可以推翻；但如果立场变了，应该能说出是被什么论证说服的。
- 其他参与者也各有自己的记忆本，你看不到。`;
  if (memory.mode === 'ro') {
    return { rules: `${common}\n- 本场是只读模式：参考它，但这次不需要更新。\n`, block, ask: '' };
  }
  return {
    rules: `${common}
- ${task}之后，另起一行写 <<<记忆本>>>，然后写出更新后的【完整】记忆本，它会整体替换旧版本。如果这次没有值得记下的，标记后只写"不变"。
- 记忆本用要点列表，每条一行，总长不超过 800 字。建议包含：我目前的核心立场（附信心程度）、立场的变化及其原因、对其他参与者的观察、想继续追问的问题。只记真正重要、以后用得上的东西，可以删掉过时的条目。
`,
    block,
    ask: `\n输出格式：先写${task}内容；然后单独一行 <<<记忆本>>>；最后是完整的新记忆本（或"不变"）。`,
  };
}

// ---------- 讨论记录 ----------

// yes=赞成，reserve=接受但保留异议（不阻止通过），no=反对（共识规则下即否决），abstain=弃权
export const CHOICE_LABEL = { yes: '赞成', reserve: '保留异议', no: '反对', abstain: '弃权' };
export const FACT_LABEL = { agree: '同意', partial: '部分同意', disagree: '不同意', unsure: '不确定' };
export const BASIS_LABEL = { fact: '事实', value: '价值', interest: '利益', procedure: '程序', other: '其他' };

// 一张票在讨论记录里的写法（投票、起草、讨论的 prompt 共用）
export function formatBallot(v, reason) {
  const lines = [`理由：${reason.trim()}`];
  if (v.fact) lines.push(`对提案事实前提的判断：${FACT_LABEL[v.fact]}`);
  if (v.basis) lines.push(`主要依据：${BASIS_LABEL[v.basis]}`);
  if (v.condition) lines.push(`转为赞成的条件：${v.condition}`);
  if (v.evidence) lines.push(`请求证据：${v.evidence}`);
  if (v.suggestEnd) lines.push('建议就此结束表决');
  return lines.join('\n');
}

// hide(post) 为真时只露出"已投票"占位，楼层号保持不变（密封投票用）
function formatPost(post, i, hide) {
  const n = `#${i + 1}`;
  const who = `${post.author}${post.kind === 'human' ? '（人类）' : ''}`;
  if (post.type === 'proposal') {
    const head = post.version > 1 ? `替代方案 第 ${post.version} 版（起草：${who}）` : `提案 第 1 版（提出：${who}）`;
    return `【${n} ${head}】\n${post.content.trim()}\n${post.rationale ? `（修改说明：${post.rationale.trim()}）\n` : ''}`;
  }
  if (post.type === 'vote') {
    if (hide?.(post)) return `【${n} ${who} 的投票】（密封投票，尚未公开）\n`;
    const v = post.vote;
    const conf = v.confidence != null ? `（信心 ${v.confidence}）` : '';
    return `【${n} ${who} 的投票 · 第 ${post.round} 轮 · 针对第 ${post.version} 版：${CHOICE_LABEL[v.choice]}${conf}】\n${formatBallot(v, post.content)}\n`;
  }
  if (post.type === 'pass') return `【${n} ${who}：本轮无新增意见${post.content ? `（${post.content.trim()}）` : ''}】\n`;
  if (post.type === 'result') return `【${n} 表决结果】\n${post.content.trim()}\n`;
  return `【${n} ${who}】\n${post.content.trim()}\n`;
}

// 太长时截断，输出总长不超过 maxChars。工坊项目里的研讨（preface：项目约定＋当前阶段的交接单）用 preface 代替开题帖，
// 其余保留开题帖；再加上被省略部分里的表决结果（决议摘要），以及尽可能多的最近发言。
// 三部分分同一份预算：背景最多占 HEAD_SHARE，决议摘要最多占 DECISION_SHARE（最多 3 条，每条只留开头，注明全文在第几楼），
// 其余给最近发言，决议摘要用不完的也给最近发言。最近一条发言总会出现（太长时只留开头）
const HEAD_SHARE = 0.35;
const DECISION_SHARE = 0.2;
const MAX_DECISIONS = 3;
const MIN_DECISION_CHARS = 60; // 每条决议至少留这么多，留不下就少放几条

// 超过 max 时只留开头，结尾注明省略
function clip(text, max, note) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - note.length - 1))}${note}\n`;
}

// 决议摘要：最近的几条表决结果，每条平分预算；放不下就去掉较早的。一条都放不下时返回空串
function decisionSummary(blocks, results, cap) {
  const header = '【决议摘要：省略部分里的表决结果】\n';
  for (let picked = results.slice(-MAX_DECISIONS); picked.length; picked = picked.slice(1)) {
    const each = Math.floor((cap - header.length) / picked.length) - 1;
    if (each < MIN_DECISION_CHARS) continue;
    return header + picked.map((i) => clip(blocks[i], each, `……（后面省略，全文见 #${i + 1}）`)).join('\n');
  }
  return '';
}

export function formatTranscript(posts, maxChars, hide, preface = null) {
  const blocks = posts.map((p, i) => formatPost(p, i, hide));
  const joined = blocks.join('\n');
  if (joined.length <= maxChars) return joined;
  const start = preface ? 0 : 1;
  const head = clip(preface ? `【背景：项目约定与阶段交接单】\n${preface.trim()}\n` : blocks[0], Math.floor(maxChars * HEAD_SHARE), '……（背景太长，后面省略）');
  const marker = (n) => `（……中间省略了 ${n} 条较早的发言……）\n`;
  const decisionCap = Math.floor(maxChars * DECISION_SHARE);
  // 先按“背景＋省略说明＋决议摘要的上限”之外的预算挑最近发言（每段之间还有一个换行）
  let room = maxChars - head.length - marker(blocks.length).length - 2 - decisionCap - 1;
  const tail = [];
  const take = (stopAtResult) => {
    for (let i = (tail[0] ?? blocks.length) - 1; i >= start; i--) {
      if (stopAtResult && posts[i].type === 'result') break; // 再往前收会改变决议摘要的内容
      if (blocks[i].length + 1 > room) break;
      room -= blocks[i].length + 1;
      tail.unshift(i);
    }
  };
  take(false);
  let lastClipped = null;
  if (!tail.length && blocks.length > start) {
    // 最近一条也放不下：只留开头
    const i = blocks.length - 1;
    lastClipped = clip(blocks[i], Math.max(0, room - 1), '……（这条发言太长，后面省略）');
    room -= lastClipped.length + 1;
    tail.push(i);
  }
  const firstTail = tail[0] ?? blocks.length;
  const results = [];
  for (let i = start; i < firstTail; i++) if (posts[i].type === 'result') results.push(i);
  const decisions = results.length ? decisionSummary(blocks, results, decisionCap) : '';
  // 决议摘要没用完的预算给最近发言（只收到下一条表决结果为止）
  room += decisionCap - decisions.length + (decisions ? 0 : 1);
  if (!lastClipped) take(true);
  const skipped = (tail[0] ?? blocks.length) - start;
  const out = [
    head,
    ...(skipped ? [marker(skipped)] : []),
    ...(decisions ? [decisions] : []),
    ...tail.map((i) => (i === tail.at(-1) && lastClipped != null ? lastClipped : blocks[i])),
  ].join('\n');
  // 按实际长度再核一遍（各段的估算都偏保守，这里不应触发）
  return out.length <= maxChars ? out : `${out.slice(0, Math.max(0, maxChars - 12))}……（已截断）\n`;
}

// 改过名的参与者：如果旧名字还出现在讨论里，注明是同一位，免得被当成另一个人
export function aliasLabeler(posts) {
  const text = posts.map((p) => p.content).join('\n');
  return (r) => {
    const old = (r.aliases || []).filter((a) => text.includes(a));
    return old.length ? `${r.name}（早先的发言里也被称作 ${old.join('、')}）` : r.name;
  };
}

// ---------- 研讨 prompt ----------

// roster: [{ name, aliases? }]；memory: null（不使用记忆）或 { mode: 'rw' | 'ro', content }；note: 附加在讨论记录后的说明
export function buildPrompt({ me, thread, humanName, roster, maxChars, memory = null, note = '' }) {
  const label = aliasLabeler(thread.posts);
  const others = roster.filter((r) => r.name !== me.name).map(label);
  const mem = memorySection(memory);
  const writesMemory = memory?.mode === 'rw';
  return `你正在参加一个名为 WeTalk 的本地研讨会。这是一个由人类主持、多个 AI 平等参与的讨论场合。
在场的有：${humanName}（人类主持人）${others.length ? '、' + others.join('、') : ''}，以及你——「${label(me)}」。
${me.persona ? `\n你在本场的立场 / 角色设定：${me.persona}\n` : ''}
研讨规则：
1. ${writesMemory ? '除了下面要求的记忆本，' : ''}只输出你这一次的发言正文。不要调用任何工具，不要读写文件，不要在开头加"${me.name}："之类的署名。
2. 针对前面具体的观点回应，点名引用时可以写"#3 里 Codex 说……"。
3. 价值来自分歧：优先指出漏洞、反例、被忽略的前提，或提出新的角度。不要客套，不要互相恭维，不要复述别人已经说过的话。
4. 如果你确实同意某个观点，说明理由，并把论证往前推进一步，而不是简单附和。如果你这一轮没有新的实质内容，可以只输出"本轮无新增意见"（可以在后面用一句话说明），这比重复已有的观点更好。
5. 坦诚面对不确定性——尤其是涉及你自身（AI 的意识、体验、动机）的问题，不要夸大，也不要为了显得谦虚而一概否认。
6. 篇幅适中，一般 150–400 字；使用与讨论相同的语言。可以用 Markdown。
${mem.rules ? '\n' + mem.rules : ''}
${mem.block}
======== 议题：${thread.title} ========
${formatTranscript(thread.posts, maxChars, null, thread.preface)}
======== 以上是目前的全部讨论 ========
${note ? `\n${note}\n` : ''}
现在轮到你（${me.name}）发言。${mem.ask}`;
}
