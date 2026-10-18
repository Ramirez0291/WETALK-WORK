// 本地模拟的 DeepSeek 服务：按脚本依次返回响应，记录收到的请求。
// 脚本里每一项：{ status, body, headers, delayMs, keepAlive, close }；用完之后按 fallback 回复。
import http from 'node:http';

export async function startMock({ fallback = null } = {}) {
  const queues = new Map(); // 路径 -> 响应脚本
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    const step = queues.get(req.url)?.shift() ?? fallback?.(req.url, body);
    if (!step) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `mock：${req.url} 没有准备响应` } }));
    }
    if (step.close) return req.socket.destroy();
    res.writeHead(step.status ?? 200, { 'Content-Type': 'application/json', ...(step.headers || {}) });
    // 保活：正式内容之前先发几个空行（DeepSeek 非流式请求排队时的行为）
    if (step.keepAlive) for (let i = 0; i < step.keepAlive; i++) res.write('\n');
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (!res.destroyed) res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}));
  });
  server.keepAliveTimeout = 1;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    script(path, ...steps) {
      queues.set(path, [...(queues.get(path) || []), ...steps]);
    },
    reset() {
      queues.clear();
      requests.length = 0;
    },
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}

export const chatOk = (content = '你好', usage = {}, extra = {}) => ({
  body: {
    id: 'x', model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: '想一想' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, ...usage },
  },
  ...extra,
});
export const apiError = (status, message = `错误 ${status}`, extra = {}) => ({ status, body: { error: { message, type: 'invalid_request_error', param: null, code: 'x' } }, ...extra });
