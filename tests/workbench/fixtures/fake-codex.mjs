// 测试用的假 Codex：记录收到的命令行参数，按环境变量 FAKE_CODEX_MODE 输出 --json 事件流。
//   clean：只有一条 agent_message
//   reads：先执行一次读文件命令（command_execution），再回复
//   mcp：调用一次 MCP 工具（mcp_tool_call），再回复
import fs from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_CODEX_ARGS) fs.writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_CODEX_MODE || 'clean';
const reply = process.env.FAKE_CODEX_REPLY || '方案正文';
const ev = (o) => process.stdout.write(JSON.stringify(o) + '\n');
ev({ type: 'thread.started', thread_id: 't' });
ev({ type: 'turn.started' });
ev({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '我先看看。' } });
if (mode === 'reads') {
  const cmd = 'powershell.exe -Command "Get-Content -LiteralPath \'C:\\\\other\\\\draft.txt\' -Raw"';
  ev({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: cmd, exit_code: null, status: 'in_progress' } });
  ev({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: '别人的草稿', exit_code: 0, status: 'completed' } });
}
if (mode === 'mcp') {
  ev({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', arguments: { code: 'readFile()' }, status: 'completed' } });
}
ev({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: reply } });
ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
