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

// 文件边界：size 是最后一条完整记录（含换行）之后的位置，内存索引和它始终一致。
// 追加失败（磁盘满等）时可能已经写进了半条：截回 size，保证下一条从完整的行首开始；
// 截不回去时记下，下次追加前先再截一次，仍然不行就拒绝写入（报错给调用方），绝不在半行后面接着写。
export function createCallLog(file) {
  const index = []; // { offset, length, summary }
  let size = 0;
  let nextId = 1;
  let dirty = false; // 文件尾部可能有没截掉的半条

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
        } catch {
          // 中间的坏行（早先版本留下的）跳过；文件末尾没有换行的半条（写到一半断电或磁盘满）截掉
          if (i === buf.length) {
            fs.truncateSync(file, start);
            size = start;
            start = -1;
            break;
          }
        }
      }
      start = i + 1;
    }
    if (start !== -1) {
      size = buf.length;
      // 最后一条完整、只是缺了换行：补上换行，下一条才不会接在它后面
      if (buf.length && buf[buf.length - 1] !== 10) {
        fs.appendFileSync(file, '\n');
        size += 1;
      }
    }
  }

  // 把文件截回已确认的边界
  function repair() {
    fs.truncateSync(file, size);
    dirty = false;
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
      if (dirty) repair(); // 截不回去就在这里抛错，不写入
      rec.id ??= nextId++;
      const b = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
      try {
        fs.appendFileSync(file, b);
      } catch (e) {
        // 可能已经写进去一部分，甚至整条都写进去了但报了错：一律截回追加前的边界，
        // 这条记录算没写成（调用方重试时再写一次，所以每条最终只有一份）
        try {
          if (fs.existsSync(file)) repair();
        } catch {
          dirty = true;
        }
        throw e;
      }
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
