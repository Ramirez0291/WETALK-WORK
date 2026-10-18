// 来源正文快照登记：<项目>/snapshots.jsonl，每个可以作为来源正文的 blob 一行。
// blob 目录里也存着记录 JSON 等其他内容，“blob 存在”不等于“它是一份正文快照”。来源卡的 text_blob 只能指向登记过的快照：
// - origin = 'fetch'：DeepSeek Fetch 返回的 Markdown（第三方服务加工过的正文，不保证与网页逐字一致），带实际请求的 url 和时间；
// - origin = 'manual'：主持人在受控入口手工录入（例如纸质书的引文段落），带录入人。
// 只由服务进程写入。
import fs from 'node:fs';
import path from 'node:path';

const fileOf = (projectDir) => path.join(projectDir, 'snapshots.jsonl');

function readAll(projectDir) {
  const file = fileOf(projectDir);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {}
  }
  return out;
}

export function snapshotInfo(projectDir, blob) {
  return readAll(projectDir).find((s) => s.blob === blob) ?? null;
}

// 同一 blob 只登记一次（第一次的来处为准）
export function registerSnapshot(projectDir, entry) {
  const existing = snapshotInfo(projectDir, entry.blob);
  if (existing) return existing;
  const line = { at: new Date().toISOString(), ...entry };
  const file = fileOf(projectDir);
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size && fs.readFileSync(file).at(-1) !== 10) fs.appendFileSync(file, '\n');
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  return line;
}
