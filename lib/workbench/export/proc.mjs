// 导出用的外部程序（Python 的 pptx_export.py、PowerShell 的 render.ps1）：参数里给出输入输出文件，
// 结果一律从 UTF-8 文件读（不经控制台）。超时就结束进程；失败时报错里只带 stderr 的末尾。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPORT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function run(cmd, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(Object.assign(new Error(`无法启动 ${path.basename(cmd)}：${e.message}`), { kind: 'spawn' }));
      return;
    }
    let err = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`${path.basename(cmd)} 超时（${Math.round(timeoutMs / 1000)} 秒）`), { kind: 'timeout' }));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`无法启动 ${path.basename(cmd)}：${e.message}`), { kind: 'spawn' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.trim().split(/\r?\n/).slice(-6).join(' ⏎ ')}`), { kind: 'exit', code }));
    });
  });
}

export const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

// pptx_export.py：build / readback / layouts。-I：不把脚本目录加进模块搜索路径，也不读环境变量和用户目录的包
export async function pyExport(python, cmd, args, resultFile, opts) {
  await run(python, ['-I', path.join(EXPORT_DIR, 'pptx_export.py'), cmd, ...args, resultFile], opts);
  return readJsonFile(resultFile);
}

export async function psRender(args, resultFile, opts) {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(EXPORT_DIR, 'render.ps1'), ...args, '-Result', resultFile], opts);
  return readJsonFile(resultFile);
}
