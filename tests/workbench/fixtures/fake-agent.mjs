// 测试用的假 Agent（generic 适配器：stdin 进、stdout 出）。
// 用法：node fake-agent.mjs <行为> [参数…]
//   say <文本> [等待文件]      输出文本；给了等待文件就等它出现再输出（模拟慢的一方）
//   say64 <base64 文本> [等待文件]  同上，文本以 base64 传入（命令行参数会进调用记录，密封测试里不能明文出现）
//   json <base64 的 changes>   输出一个 ```json 代码块
//   record <文件> <回复>       把收到的提示词原样写进文件，再输出回复
//   fail                        以非零退出码退出
import fs from 'node:fs';

const [mode, a, b] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

if (mode === 'say' || mode === 'say64') {
  if (b) while (!fs.existsSync(b)) await new Promise((r) => setTimeout(r, 20));
  process.stdout.write(mode === 'say64' ? Buffer.from(a, 'base64').toString('utf8') : a);
} else if (mode === 'json') {
  process.stdout.write('结果如下：\n```json\n' + Buffer.from(a, 'base64').toString('utf8') + '\n```\n');
} else if (mode === 'record') {
  fs.writeFileSync(a, input);
  process.stdout.write(b);
} else {
  process.exit(3);
}
