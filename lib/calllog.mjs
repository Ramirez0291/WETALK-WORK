// 调用记录：每一次调用 AI（成功、失败、超时、被中止、解析失败、记忆写入冲突）都留下一条完整快照，
// 包括实际送入的 prompt、原始回复、有效的角色 / 模型配置、CLI 版本和实际命令行参数。
// 存成追加写入的 JSONL（prompt 很大，不适合塞进每次整体重写的 forum.json）；内存里只保留不含大字段的摘要和行偏移。
import fs from 'node:fs';

const BIG = ['prompt', 'raw', 'reasoning', 'stdoutTail', 'stderrTail', 'memoryAttempt'];

function summarize(rec) {
  const s = {};
  for (const [k, v] of Object.entries(rec)) if (!BIG.includes(k)) s[k] = v;
  s.promptChars = rec.prompt?.length ?? 0;
  s.rawChars = rec.raw?.length ?? 0;
  return s;
}

export function createCallLog(file) {
  const index = []; // { offset, length, summary }
  let size = 0;
  let nextId = 1;

  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i < buf.length && buf[i] !== 10) continue;
      if (i > start) {
        try {
          const rec = JSON.parse(buf.subarray(start, i).toString('utf8'));
          index.push({ offset: start, length: i - start, summary: summarize(rec) });
          nextId = Math.max(nextId, rec.id + 1);
        } catch {} // 半行（例如写到一半断电）直接跳过
      }
      start = i + 1;
    }
    size = buf.length;
  }

  function read(entry) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(entry.length);
      fs.readSync(fd, buf, 0, entry.length, entry.offset);
      return JSON.parse(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    // 先领号再写入：发言可以在调用结束前就记下自己对应的调用记录
    newId() {
      return nextId++;
    },

    append(rec) {
      rec.id ??= nextId++;
      const b = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
      fs.appendFileSync(file, b);
      index.push({ offset: size, length: b.length - 1, summary: summarize(rec) });
      size += b.length;
      return summarize(rec);
    },

    list(filter = () => true) {
      return index.map((e) => e.summary).filter(filter);
    },

    get(id) {
      const e = index.find((x) => x.summary.id === id);
      return e ? read(e) : null;
    },

    getMany(filter) {
      return index.filter((e) => filter(e.summary)).map(read);
    },
  };
}
