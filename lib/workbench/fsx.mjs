// 文件操作的 Windows 兼容层：杀毒软件、索引服务或编辑器短暂占用文件时，改名会报 EPERM / EBUSY / EACCES，稍等重试即可。
import fs from 'node:fs';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export async function renameRetry(from, to, { attempts = 8, delayMs = 50, rename = fs.renameSync } = {}) {
  for (let i = 1; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (!BUSY.has(e.code) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}
