// 工坊用到的 git 操作。git 只做留档，失败不影响数据提交，所以这里从不抛出，只返回 { ok, error }。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // 参数直接传给 git，不经过 shell：路径和项目名里的中日文字符不需要转义。
      // --literal-pathspecs：路径一律按字面匹配。否则 `文稿[ab]` 会被 git 当成通配，匹配到 `文稿a`，
      // 把别的项目的改动一起提交。工坊只传确切路径，从不需要通配。
      child = spawn('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: e.message });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : (stderr || stdout).trim() || `git 退出码 ${code}` });
    });
  });
}

// 目录还不是 git 仓库时初始化它。留档要逐字节保存正式文件（崩溃恢复按 hash 比对），
// 所以每次都在仓库级关掉换行转换，不受全局 core.autocrlf 影响。
export async function ensureRepo(dir) {
  const created = !fs.existsSync(path.join(dir, '.git'));
  if (created) {
    const r = await git(dir, ['init', '-b', 'main']);
    if (!r.ok) return { ...r, created: false };
  }
  const r = await git(dir, ['config', 'core.autocrlf', 'false']);
  return { ...r, created };
}

// 只提交给定的路径：先 add，再用 `commit -- <paths>` 提交，其他已暂存的改动不会被带上。
// paths 相对于仓库根目录。
export async function commitPaths(repo, paths, message) {
  if (!paths.length) return { ok: true, skipped: true };
  const add = await git(repo, ['add', '--', ...paths]);
  if (!add.ok) return add;
  const r = await git(repo, ['commit', '-m', message, '--', ...paths]);
  // 内容和上次提交一样时 git 会报 "nothing to commit"，对留档来说等于已经完成
  if (!r.ok && /nothing (added )?to commit|no changes added/i.test(r.stdout + r.stderr)) return { ok: true, skipped: true };
  return r;
}
