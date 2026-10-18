// 工坊项目：加载、新建，以及“默认参数 ＋ 项目覆盖”的合并。
// 一个项目就是 projectsDir 下含 project.md 的子目录；整个 projectsDir 是一个独立的 git 仓库。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureRepo, commitPaths } from './git.mjs';
import { renameRetry } from './fsx.mjs';

export class WorkbenchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 项目内的固定子目录（见开发文档“目标结构”）
export const PROJECT_DIRS = [
  'sources', 'claims', 'verifications', 'objections',
  'outline', 'script', 'slides', 'candidates', 'tasks',
  'decisions', 'handoff', 'exports', 'archive',
];

// 模板里会复制到新项目的文件
const TEMPLATE_FILES = ['project.md', 'protocol.json', 'baseline.md'];

// ---------- 参数 ----------

// 系统不变量：这些上限必须存在且有限，数值可调，不能设为无限或关掉。
// min 为允许的最小值（retry.max 可以是 0，表示不重试）。
const REQUIRED_LIMITS = {
  'budget.calls': { min: 1, integer: true },
  'budget.apiUsd': { min: Number.MIN_VALUE },
  'task.maxDepth': { min: 1, integer: true },
  'task.maxAttempts': { min: 1, integer: true },
  'evidence.maxAttempts': { min: 1, integer: true },
  'retry.max': { min: 0, integer: true },
  'lease.minutes': { min: Number.MIN_VALUE },
};

// 项目可以在这些映射里新增键（新的任务类型、新的工作类型），其余位置只能覆盖已有的键
const OPEN_MAPS = new Set(['modes', 'routing']);

// 只能全局设置、项目不能覆盖的参数
const GLOBAL_ONLY = new Set(['projectsDir']);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function loadDefaults(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function merge(base, override, at) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const p = at ? `${at}.${key}` : key;
    if (key.startsWith('_')) continue; // _comment 之类的备注键
    if (!at && GLOBAL_ONLY.has(key)) throw new WorkbenchError(400, `${p} 只能在全局设置，项目不能覆盖`);
    if (!(key in base)) {
      if (OPEN_MAPS.has(at)) {
        out[key] = value;
        continue;
      }
      throw new WorkbenchError(400, `未知参数 ${p}`);
    }
    const def = base[key];
    if (isPlainObject(def)) {
      if (!isPlainObject(value)) throw new WorkbenchError(400, `${p} 必须是对象`);
      out[key] = merge(def, value, p);
    } else if (def !== null && value !== null && typeOf(def) !== typeOf(value)) {
      throw new WorkbenchError(400, `${p} 的类型应为 ${typeOf(def)}`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// 返回生效配置。任何上限缺失、非有限或越界都直接报错——这是系统不变量，没有开关。
export function resolveConfig(defaults, override = {}) {
  if (!isPlainObject(override)) throw new WorkbenchError(400, 'protocol.json 必须是 JSON 对象');
  const config = merge(defaults, override, '');
  for (const [p, rule] of Object.entries(REQUIRED_LIMITS)) {
    const v = getPath(config, p);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new WorkbenchError(400, `${p} 必须是有限的数字（上限不能取消）`);
    if (v < rule.min) throw new WorkbenchError(400, rule.min === Number.MIN_VALUE ? `${p} 必须大于 0` : `${p} 不能小于 ${rule.min}`);
    if (rule.integer && !Number.isInteger(v)) throw new WorkbenchError(400, `${p} 必须是整数`);
  }
  return config;
}

// ---------- 项目名 ----------

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// 项目名直接用作目录名和 URL 路径段：允许中日文，不允许路径分隔符、Windows 保留字符和保留名。
// 以 _ 或 . 开头的名字留给 _txn 这类内部目录。
export function validateProjectName(name) {
  if (typeof name !== 'string') throw new WorkbenchError(400, '项目名必须是字符串');
  const s = name.trim();
  if (!s) throw new WorkbenchError(400, '项目名不能为空');
  if (s.length > 64) throw new WorkbenchError(400, '项目名超过 64 字');
  if (/[\\/:*?"<>|\x00-\x1f]/.test(s)) throw new WorkbenchError(400, '项目名不能包含 \\ / : * ? " < > | 或控制字符');
  if (/^[._]/.test(s)) throw new WorkbenchError(400, '项目名不能以 . 或 _ 开头');
  if (/[. ]$/.test(s)) throw new WorkbenchError(400, '项目名不能以空格或句点结尾');
  if (WIN_RESERVED.test(s)) throw new WorkbenchError(400, `${s} 是 Windows 保留名`);
  return s;
}

// ---------- 工坊 ----------

const titleOf = (md, fallback) => md.match(/^#\s+(.+?)\s*$/m)?.[1] ?? fallback;

function fillTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function appendEvent(projectDir, event) {
  fs.appendFileSync(path.join(projectDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

// projectsDir：项目资料目录（git 仓库根）；defaults：workbench.defaults.json 的内容；templateDir：项目模板目录
export function createWorkbench({ projectsDir, defaults, templateDir, now = () => new Date() }) {
  const dirOf = (name) => path.join(projectsDir, name);
  const isProject = (name) => !/^[._]/.test(name) && fs.existsSync(path.join(dirOf(name), 'project.md'));

  function readOverride(dir) {
    const file = path.join(dir, 'protocol.json');
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new WorkbenchError(400, `protocol.json 格式错误：${e.message}`);
    }
  }

  return {
    projectsDir,

    // 建目录、初始化 git 仓库、写入仓库级 .gitignore。git 不可用时照常工作，只是没有留档。
    async init() {
      fs.mkdirSync(projectsDir, { recursive: true });
      const repo = await ensureRepo(projectsDir);
      const ignore = path.join(projectsDir, '.gitignore');
      if (!fs.existsSync(ignore)) {
        fs.writeFileSync(ignore, '# 服务进程的单实例锁\n/.workbench.lock\n# 写到一半的临时文件\n*.tmp\n/_staging-*/\n');
        if (repo.ok) await commitPaths(projectsDir, ['.gitignore'], '[工坊] 初始化项目仓库');
      }
      return { git: repo.ok, gitError: repo.ok ? null : repo.error };
    },

    list() {
      if (!fs.existsSync(projectsDir)) return [];
      return fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isProject(d.name))
        .map((d) => {
          const md = fs.readFileSync(path.join(dirOf(d.name), 'project.md'), 'utf8');
          return { name: d.name, title: titleOf(md, d.name) };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    },

    // 返回项目约定原文和生效配置
    get(name) {
      const n = validateProjectName(name);
      if (!isProject(n)) throw new WorkbenchError(404, `项目 ${n} 不存在`);
      const dir = dirOf(n);
      const conventions = fs.readFileSync(path.join(dir, 'project.md'), 'utf8');
      const override = readOverride(dir);
      return { name: n, dir, title: titleOf(conventions, n), conventions, override, config: resolveConfig(defaults, override) };
    },

    // 先在 _staging-* 里建好整个目录，再一次改名到位：中途崩溃只会留下被忽略的临时目录，不会出现半个项目
    async create(name) {
      const n = validateProjectName(name);
      const dir = dirOf(n);
      if (fs.existsSync(dir)) throw new WorkbenchError(409, `项目 ${n} 已存在`);
      fs.mkdirSync(projectsDir, { recursive: true });
      const staging = path.join(projectsDir, `_staging-${crypto.randomBytes(6).toString('hex')}`);
      const at = now().toISOString();
      try {
        fs.mkdirSync(staging);
        for (const sub of PROJECT_DIRS) fs.mkdirSync(path.join(staging, sub));
        for (const file of TEMPLATE_FILES) {
          const text = fs.readFileSync(path.join(templateDir, file), 'utf8');
          fs.writeFileSync(path.join(staging, file), fillTemplate(text, { name: n, date: at.slice(0, 10) }));
        }
        resolveConfig(defaults, readOverride(staging)); // 模板本身的覆盖也必须合法
        appendEvent(staging, { at, type: 'project_created', project: n });
        if (fs.existsSync(dir)) throw new WorkbenchError(409, `项目 ${n} 已存在`);
        await renameRetry(staging, dir);
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw e;
      }
      let archive = { ok: true, skipped: !defaults.git?.autoCommit };
      if (defaults.git?.autoCommit) {
        archive = await commitPaths(projectsDir, TEMPLATE_FILES.map((f) => `${n}/${f}`), `[工坊] 新建项目 ${n}`);
        if (!archive.ok) appendEvent(dir, { at: now().toISOString(), type: 'archive_failed', reason: archive.error });
      }
      return { project: this.get(n), archive: { ok: archive.ok, error: archive.ok ? null : archive.error } };
    },
  };
}
