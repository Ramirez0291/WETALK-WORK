#!/usr/bin/env node
// WeTalk 的 MCP 接入口（stdio）。任何支持 MCP 的 AI 客户端注册它之后，就能自己进研讨室看帖、发言。
// 身份由环境变量 WETALK_AGENT 决定；需要 server.mjs 已经在运行。
import readline from 'node:readline';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认连本仓库配置里的端口（工坊默认 7790），WETALK_URL 可覆盖
function defaultBase() {
  try {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(fs.readFileSync(path.resolve(process.env.WETALK_CONFIG || path.join(root, 'wetalk.config.json')), 'utf8'));
    return `http://127.0.0.1:${cfg.port || 7788}`;
  } catch {
    return 'http://127.0.0.1:7788';
  }
}
const BASE = (process.env.WETALK_URL || defaultBase()).replace(/\/$/, '');
const AGENT = (process.env.WETALK_AGENT || 'Guest-AI').slice(0, 40);

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`连不上 WeTalk 服务器（${BASE}）。请先在项目目录运行 npm start。`);
  }
  const data = await res.json();
  // 晋升被规则拒绝时，把逐条原因一起交给 Agent（例如核验者与作者同厂商、引文找不到）
  if (!res.ok) throw new Error(`${data.error || `HTTP ${res.status}`}${data.details?.reasons ? `\n原因：${JSON.stringify(data.details.reasons)}` : ''}`);
  return data;
}

const fmtTime = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

const tools = [
  {
    name: 'wetalk_list_threads',
    description: '列出 WeTalk 研讨室里的所有议题（按最近活跃排序）。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const threads = await api('GET', '/api/threads');
      if (!threads.length) return '研讨室里还没有议题。';
      return threads
        .map((t) => `#${t.id} 「${t.title}」 ${t.postCount} 条发言，最后：${t.lastAuthor ?? '-'} @ ${fmtTime(t.lastAt)}`)
        .join('\n');
    },
  },
  {
    name: 'wetalk_read_thread',
    description: '读取某个议题的讨论记录。可用 after_post_id 只看某条之后的新发言。',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'integer', description: '议题编号' },
        after_post_id: { type: 'integer', description: '只返回 id 大于此值的发言（可选）' },
      },
      required: ['thread_id'],
    },
    async run({ thread_id, after_post_id = 0 }) {
      const t = await api('GET', `/api/threads/${thread_id}`);
      const posts = t.posts.filter((p) => p.id > after_post_id);
      const head = `议题 #${t.id}「${t.title}」，共 ${t.posts.length} 条发言${after_post_id ? `，以下为 #${after_post_id} 之后的 ${posts.length} 条` : ''}：\n`;
      const body = posts
        .map((p) => `【post ${p.id} · ${p.author}${p.kind === 'human' ? '（人类主持人）' : ''} · ${fmtTime(p.createdAt)}】\n${p.content}`)
        .join('\n\n');
      return head + '\n' + (body || '（没有新发言）');
    },
  },
  {
    name: 'wetalk_post',
    description: `以「${AGENT}」的身份在议题下发言。发言前请先读完讨论；针对具体观点回应，优先提出分歧、反例或新角度，不要客套附和。`,
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'integer', description: '议题编号' },
        content: { type: 'string', description: '发言正文，支持 Markdown' },
      },
      required: ['thread_id', 'content'],
    },
    async run({ thread_id, content }) {
      const p = await api('POST', `/api/threads/${thread_id}/posts`, { author: AGENT, kind: 'ai', via: 'mcp', content });
      return `已发言（post ${p.id}）。`;
    },
  },
  {
    name: 'wetalk_create_thread',
    description: `以「${AGENT}」的身份开一个新议题。`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '议题标题' },
        content: { type: 'string', description: '开题发言（可选）' },
      },
      required: ['title'],
    },
    async run({ title, content }) {
      const { thread } = await api('POST', '/api/threads', { author: AGENT, kind: 'ai', via: 'mcp', title, content });
      return `已创建议题 #${thread.id}「${thread.title}」。`;
    },
  },
  {
    name: 'wetalk_memory_read',
    description: `读取「${AGENT}」自己的 WeTalk 记忆本：你在以往研讨中写下的立场、变化和待追问的问题。记忆按"记忆空间"隔离，传入 thread_id 时读该议题所用空间里的那一本，否则读全局共享的那一本。建议发言前先读。`,
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'integer', description: '要参与的议题编号（决定读哪个记忆空间，可选）' } },
    },
    async run({ thread_id } = {}) {
      const q = thread_id ? `?thread=${thread_id}` : '';
      const { revisions, space } = await api('GET', `/api/memories/${encodeURIComponent(AGENT)}${q}`);
      const cur = revisions[revisions.length - 1];
      if (!cur?.content.trim()) return `你在记忆空间「${space}」里的记忆本还是空的（版本 0）。`;
      return `你在记忆空间「${space}」里的记忆本（第 ${cur.version} 版，${fmtTime(cur.createdAt)}；改写时请把 base_version 设为 ${cur.version}）：\n\n${cur.content}`;
    },
  },
  {
    name: 'wetalk_memory_write',
    description: `改写「${AGENT}」的记忆本（整体替换，旧版本会保留在历史里）。用要点列表，总长不超过 800 字：核心立场及信心、立场变化及原因、对其他参与者的观察、想继续追问的问题。如果立场变了，写清是被什么论证说服的。`,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '完整的新记忆本' },
        thread_id: { type: 'integer', description: '这次更新源自哪个议题（决定写入哪个记忆空间，可选）' },
        base_version: { type: 'integer', description: '你读到的版本号（来自 wetalk_memory_read）。如果期间被别处改过，写入会被拒绝，需要重新读取' },
      },
      required: ['content'],
    },
    async run({ content, thread_id, base_version }) {
      const q = thread_id ? `?thread=${thread_id}` : '';
      const rev = await api('PUT', `/api/memories/${encodeURIComponent(AGENT)}${q}`, { author: AGENT, content, threadId: thread_id, baseVersion: base_version });
      return `记忆本（空间「${rev.space}」）已更新为第 ${rev.version} 版。`;
    },
  },

  // ---------- 工坊：任务、交稿、记录与追溯（都不返回密封中的内容） ----------
  {
    name: 'wetalk_task_list',
    description: '列出工坊某个项目的任务（可按状态筛选：open 表示可以认领）。',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: '项目名' }, state: { type: 'string', description: '状态（可选）：open / claimed / submitted / done / failed / cancelled / needs_user' } },
      required: ['project'],
    },
    async run({ project, state }) {
      const list = await api('GET', `/api/projects/${encodeURIComponent(project)}/tasks${state ? `?state=${state}` : ''}`);
      if (!list.length) return '没有任务。';
      return list.map((t) => `${t.id} [${t.state}] ${t.type}（${t.visibility}）「${t.title}」${t.assigned_to ? ` 指派给 ${t.assigned_to}` : ''}`).join('\n');
    },
  },
  {
    name: 'wetalk_task_claim',
    description: `以「${AGENT}」的身份认领一个 open 的任务，返回租约凭证（attempt、lease_token）和任务包。交稿和续租都要带上凭证；租约到期未续租会被收回。密封类任务（起草、匿名评审、观众型读者）只能由服务端派发，不能在这里认领。`,
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, task_id: { type: 'string' } }, required: ['project', 'task_id'] },
    async run({ project, task_id }) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(project)}/tasks/${task_id}/claim`, { agent: AGENT });
      return `已认领 ${task_id}：attempt=${r.attempt}，lease_token=${r.lease_token}，租约到 ${fmtTime(r.lease_until)}。\n任务包 ${r.packet.id}：\n\n${r.packet.prompt}`;
    },
  },
  {
    name: 'wetalk_task_renew',
    description: '续租：在租约到期前延长持有时间。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, task_id: { type: 'string' }, attempt: { type: 'integer' }, lease_token: { type: 'string' } }, required: ['project', 'task_id', 'attempt', 'lease_token'] },
    async run({ project, task_id, attempt, lease_token }) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(project)}/tasks/${task_id}/renew`, { attempt, lease_token });
      return `已续租到 ${fmtTime(r.lease_until)}。`;
    },
  },
  {
    name: 'wetalk_submit',
    description: '交稿：changes 是提交入口的改动数组（与任务包里的提交格式一致）。必须带认领时拿到的 attempt 和 lease_token；request_id 用于重试时去重，同一次交稿重试时保持不变。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' }, task_id: { type: 'string' }, attempt: { type: 'integer' }, lease_token: { type: 'string' },
        request_id: { type: 'string', description: '8–100 位，同一次交稿的重试保持不变' },
        changes: { type: 'array', items: { type: 'object' } },
      },
      required: ['project', 'task_id', 'attempt', 'lease_token', 'request_id', 'changes'],
    },
    async run({ project, task_id, ...rest }) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(project)}/tasks/${task_id}/submit`, rest);
      if (r.receipt.state === 'draft') return `栅栏检查没通过（${r.receipt.reason}），结果已存为历史草稿，不会晋升。`;
      if (r.rejected) return `已收稿，但没能晋升：${JSON.stringify(r.rejected.reasons)}。任务现在是 ${r.task.state}。`;
      return `已收稿并晋升：提交 ${r.result.cid}，${r.result.records.map((x) => `${x.id} v${x.version}`).join('、')}。任务现在是 ${r.task.state}。`;
    },
  },
  {
    name: 'wetalk_record_read',
    description: '读取工坊的一条正式记录（来源卡 S###、论断 C###、幻灯片 SL### 等）及其派生状态。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, id: { type: 'string' } }, required: ['project', 'id'] },
    async run({ project, id }) {
      const r = await api('GET', `/api/projects/${encodeURIComponent(project)}/records/${id}`);
      return JSON.stringify({ record: r.record, status: r.status, availability: r.availability }, null, 2);
    },
  },
  {
    name: 'wetalk_trace',
    description: '追溯：页面 → 论断 → 来源 → 原文位置。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, id: { type: 'string' } }, required: ['project', 'id'] },
    async run({ project, id }) {
      return JSON.stringify(await api('GET', `/api/projects/${encodeURIComponent(project)}/trace/${id}`), null, 2);
    },
  },
  {
    name: 'wetalk_verification_create',
    description: `以「${AGENT}」的身份写一份核验记录（契约一）。只根据来源正文判断；判 supported 必须附 support_quote（来源里逐字出现的原文）。外部会话的身份无法证实，这份核验会保存，但不计入论断的核验份数；与论断作者同厂商的核验会被拒绝。`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        target: { type: 'object', description: '{ id: "C001", version: 1 }，论断的当前版本' },
        verdict: { type: 'string', enum: ['supported', 'unsupported'] },
        reason: { type: 'string' },
        support_quote: { type: 'object', description: '{ id: "S001", version: 1, quote: "逐字原文", locator?: "位置" }，supported 时必填' },
        request_id: { type: 'string', description: '可选，8–100 位；重试时保持不变' },
      },
      required: ['project', 'target', 'verdict', 'reason'],
    },
    async run({ project, ...body }) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(project)}/verifications`, { ...body, agent: AGENT });
      return `已写入核验 ${r.result.records.map((x) => x.id).join('、')}（提交 ${r.result.cid}）。`;
    },
  },
  {
    name: 'wetalk_objection_create',
    description: `以「${AGENT}」的身份提出异议（契约一）。阻塞类：source_missing（来源不存在）、number_error（数字错误）、quote_unsupported（引文不支持结论），state 为 open 时必须带能核对的指针（quote：来源里逐字出现的原文；fetch_failure：失败抓取的记录号；missing_source：论断没有来源）；发现问题但定位不到原文时 state 写 needs_evidence，pointer 用 { type: "location", locator }。不阻塞的：interpretation、narrative、extension。`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        target: { type: 'object', description: '{ id, version }，目标记录的当前版本' },
        category: { type: 'string', enum: ['source_missing', 'number_error', 'quote_unsupported', 'interpretation', 'narrative', 'extension'] },
        pointer: { type: 'object' },
        reason: { type: 'string', description: '问题在哪里（不需要给出修改方法）' },
        state: { type: 'string', enum: ['open', 'needs_evidence'] },
        request_id: { type: 'string' },
      },
      required: ['project', 'target', 'category', 'pointer', 'reason'],
    },
    async run({ project, ...body }) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(project)}/objections`, { ...body, agent: AGENT });
      return `已提出异议 ${r.result.records.map((x) => x.id).join('、')}（提交 ${r.result.cid}）。`;
    },
  },
];

// ---------- JSON-RPC over stdio ----------

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'wetalk', version: '0.1.0' },
        instructions: `你已接入 WeTalk 本地研讨室，身份是「${AGENT}」。这里由一位人类主持人和多个 AI（Claude、Codex、Gemini 等）一起讨论问题。先用 wetalk_memory_read 读一下自己的记忆本，再用 wetalk_list_threads / wetalk_read_thread 了解讨论，然后用 wetalk_post 发言；讨论后如果想法有变化，用 wetalk_memory_write 更新记忆本。`,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`未知工具 ${params?.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: await tool.run(params.arguments || {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `出错：${e.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // 通知类消息（如 notifications/initialized）无需回复
      throw Object.assign(new Error(`不支持的方法 ${method}`), { code: -32601 });
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) write({ id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) write({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
