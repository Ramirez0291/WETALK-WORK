// 工坊用到的 git 操作。git 只做留档，失败不影响数据提交，所以这里从不抛出，只返回 { ok, error }。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// bin 可以换成别的可执行文件（测试里用来模拟 git 不可用）；env 只追加，不替换
export function git(cwd, args, { timeoutMs = 60_000, env = null, bin = 'git' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // 参数直接传给 git，不经过 shell：路径和项目名里的中日文字符不需要转义。
      // --literal-pathspecs：路径一律按字面匹配。否则 `文稿[ab]` 会被 git 当成通配，匹配到 `文稿a`，
      // 把别的项目的改动一起提交。工坊只传确切路径，从不需要通配。
      child = spawn(bin, ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      });
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
export async function ensureRepo(dir, opts = {}) {
  const created = !fs.existsSync(path.join(dir, '.git'));
  if (created) {
    const r = await git(dir, ['init', '-b', 'main'], opts);
    if (!r.ok) return { ...r, created: false };
  }
  const r = await git(dir, ['config', 'core.autocrlf', 'false'], opts);
  return { ...r, created };
}

// 只提交给定的路径：先 add，再用 `commit -- <paths>` 提交，其他已暂存的改动不会被带上。
// paths 相对于仓库根目录。
export async function commitPaths(repo, paths, message, opts = {}) {
  if (!paths.length) return { ok: true, skipped: true };
  const add = await git(repo, ['add', '--', ...paths], opts);
  if (!add.ok) return add;
  const r = await git(repo, ['commit', '-m', message, '--', ...paths], opts);
  // 内容和上次提交一样时 git 会报 "nothing to commit"，对留档来说等于已经完成
  if (!r.ok && /nothing (added )?to commit|no changes added/i.test(r.stdout + r.stderr)) return { ok: true, skipped: true };
  return r;
}

// 把给定文件的确切字节提交为 HEAD 的下一个提交：files = [{ path: 仓库内路径, file: 内容所在的绝对路径 }]。
// 用临时索引构造树，不经过工作区，也不动用户已暂存的其他改动；hash-object --no-filters 跳过换行转换与过滤器，
// 所以留档内容与正式文件逐字节一致，也不受工作区里之后又被改写的影响。
export async function commitBlobs(repo, files, message, opts = {}) {
  if (!files.length) return { ok: true, skipped: true };
  const index = path.join(repo, '.git', `wb-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const run = (args, env) => git(repo, args, { ...opts, env });
  const withIndex = { GIT_INDEX_FILE: index };
  try {
    const head = await run(['rev-parse', '--verify', '-q', 'HEAD']);
    const parent = head.ok ? head.stdout.trim() : null;
    let r = await run(parent ? ['read-tree', parent] : ['read-tree', '--empty'], withIndex);
    if (!r.ok) return r;
    for (const f of files) {
      const h = await run(['hash-object', '-w', '--no-filters', '--', f.file]);
      if (!h.ok) return h;
      r = await run(['update-index', '--add', '--cacheinfo', `100644,${h.stdout.trim()},${f.path}`], withIndex);
      if (!r.ok) return r;
    }
    const tree = await run(['write-tree'], withIndex);
    if (!tree.ok) return tree;
    if (parent) {
      const prev = await run(['rev-parse', `${parent}^{tree}`]);
      if (prev.ok && prev.stdout.trim() === tree.stdout.trim()) return { ok: true, skipped: true };
    }
    const commit = await run(['commit-tree', tree.stdout.trim(), ...(parent ? ['-p', parent] : []), '-m', message]);
    if (!commit.ok) return commit;
    const sha = commit.stdout.trim();
    // 带旧值更新：期间 HEAD 被别人移动过就失败，不会覆盖别人的提交
    r = await run(['update-ref', 'HEAD', sha, parent ?? '']);
    if (!r.ok) return r;
    // 让用户的索引在这些路径上跟上新的 HEAD，免得 git status 显示成“已暂存的回退”；失败不影响留档
    await run(['reset', '-q', '--', ...files.map((f) => f.path)]);
    return { ok: true, commit: sha };
  } finally {
    fs.rmSync(index, { force: true });
  }
}
