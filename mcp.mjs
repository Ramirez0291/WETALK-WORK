#!/usr/bin/env node
// WeTalk 的 MCP 接入口（stdio）。任何支持 MCP 的 AI 客户端注册它之后，就能自己进研讨室看帖、发言。
// 身份由环境变量 WETALK_AGENT 决定；需要 server.mjs 已经在运行。
import readline from 'node:readline';

const BASE = (process.env.WETALK_URL || 'http://127.0.0.1:7788').replace(/\/$/, '');
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
