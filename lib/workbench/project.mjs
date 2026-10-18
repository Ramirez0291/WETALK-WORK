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

// projects 仓库忽略的运行时文件。git 只留历史：正式记录按提交清单单独留档，
// 提交日志、写前日志、审计事件、候选稿、旧版本副本和 blob 目录都不随 git 走（已留档的正文快照照样被跟踪）。
const IGNORE_LINES = [
  '# 工坊运行时文件（由服务维护，git 只留正式记录的历史）',
  '/.workbench.lock',
  '*.tmp',
  '/_staging-*/',
  '/_txn/',
  '/commits.jsonl',
  '/*/events.jsonl',
  '/*/candidates/',
  '/*/archive/versions/',
  '/*/archive/blobs/',
  '/*/usage.jsonl',
  '/*/availability.jsonl',
];

// 模板里会复制到新项目的文件
const TEMPLATE_FILES = ['project.md', 'protocol.json', 'baseline.md'];

// ---------- 参数 ----------

// 每个参数的取值约束。合并之后整份生效配置逐项校验，默认值本身也必须通过。
// 校验函数返回错误说明，合法时返回 null。
const fail = (cond, msg) => (cond ? msg : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (min) => (v) => fail(!Number.isInteger(v) || v < min, `必须是不小于 ${min} 的整数`);
const positive = () => (v) => fail(!isNum(v) || v <= 0, '必须是大于 0 的有限数字');
const nonNegative = () => (v) => fail(!isNum(v) || v < 0, '必须是不小于 0 的有限数字');
const bool = () => (v) => fail(typeof v !== 'boolean', '必须是 true 或 false');
const str = () => (v) => fail(typeof v !== 'string' || !v.trim(), '必须是非空字符串');
const oneOf = (values) => (v) => fail(!values.includes(v), `只能是 ${values.join(' / ')}`);
const nullable = (check) => (v) => (v === null ? null : check(v));
const arrayOf = (check, { min = 0 } = {}) => (v) => {
  if (!Array.isArray(v)) return '必须是数组';
  if (v.length < min) return `至少要有 ${min} 项`;
  for (const [i, x] of v.entries()) {
    const e = check(x);
    if (e) return `第 ${i + 1} 项${e}`;
  }
  return null;
};

export const WORK_MODES = ['divide', 'compete', 'adversarial'];
export const MEMORY_LAYERS = ['conventions', 'shared', 'notes', 'archive'];

// 系统不变量：调用次数、费用、任务深度、尝试次数等上限必须存在且有限，数值可调，不能取消。
// 它们的校验函数都拒绝 null 和 Infinity，没有“关掉”的写法。
const LIMITS = new Set(['budget.calls', 'budget.apiUsd', 'task.maxDepth', 'task.maxAttempts', 'evidence.maxAttempts', 'retry.max', 'lease.minutes']);

const SCHEMA = {
  projectsDir: str(),
  'compete.drafts': int(2),
  'verify.coreClaimVerifiers': int(1),
  'verify.otherClaimVerifiers': int(1),
  'evidence.maxAttempts': int(1),
  'reader.default': oneOf(['audience', 'reviewer']),
  'reader.addReviewerFor': arrayOf(str()),
  rounds: nullable(int(1)), // null：沿用 WeTalk 现有的讨论与表决轮次设置
  'lease.minutes': positive(),
  'cooldown.apiSeconds': positive(),
  'cooldown.cliMinutes': positive(),
  'retry.max': int(0),
  'retry.delaysSec': arrayOf(nonNegative()),
  'task.maxAttempts': int(1),
  'task.maxDepth': int(1),
  'budget.calls': int(1),
  'budget.apiUsd': positive(),
  'memory.loadByDefault': arrayOf(oneOf(MEMORY_LAYERS)),
  'plateau.rounds': int(1),
  'plateau.action': oneOf(['audience_reader', 'needs_user']),
  'slides.maxCharsPerPage': int(1),
  'offPeak.defer': bool(),
  'git.autoCommit': bool(),
  'export.formats': arrayOf(oneOf(['md', 'pptx']), { min: 1 }),
  'export.via': str(),
  'export.template': nullable(str()),
  'export.skill': nullable(str()),
  'export.python': str(),
  'render.engine': oneOf(['auto', 'powerpoint', 'libreoffice']),
  'deepseek.baseUrl': (v) => fail(typeof v !== 'string' || !/^https?:\/\/\S+$/.test(v), '必须是 http(s) 地址'),
  'deepseek.timeoutSec': positive(),
  'deepseek.webPerSecond': positive(),
  'pricing.offPeakFactor': (v) => fail(!isNum(v) || v <= 0 || v > 1, '必须在 (0, 1] 之间'),
  'pricing.peakHoursUtc': arrayOf((v) => fail(!Array.isArray(v) || v.length !== 2 || !v.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) || v[0] >= v[1], '必须是 [起, 止) 小时对，0–24')),
  'pricing.webUsdPerRequest': nonNegative(),
};

// 开放映射：项目可以新增键（新的任务类型、新的工作类型），但每个值仍按这里的规则校验
const OPEN_MAPS = {
  modes: oneOf(WORK_MODES),
  routing: arrayOf(str(), { min: 1 }),
  // 每个模型：缓存命中输入、未命中输入、输出，美元 / 100 万 token（高峰价）
  'pricing.models': (v) =>
    fail(!isPlainObject(v) || Object.keys(v).sort().join() !== 'cacheHit,cacheMiss,output' || !Object.values(v).every((x) => isNum(x) && x >= 0), '必须是 { cacheHit, cacheMiss, output }，都是不小于 0 的数字'),
};

// 只能全局设置、项目不能覆盖的参数
const GLOBAL_ONLY = new Set(['projectsDir', 'deepseek', 'pricing']); // 账户级的限速与价目，项目不能各改各的

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadDefaults(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 只处理结构：未知键、对象与非对象。值的合法性留给 validate 统一检查。
function merge(base, override, at) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const p = at ? `${at}.${key}` : key;
    if (key.startsWith('_')) continue; // _comment 之类的备注键
    if (!at && GLOBAL_ONLY.has(key)) throw new WorkbenchError(400, `${p} 只能在全局设置，项目不能覆盖`);
    if (!(key in base) && !(at in OPEN_MAPS)) throw new WorkbenchError(400, `未知参数 ${p}`);
    if (isPlainObject(base[key])) {
      if (!isPlainObject(value)) throw new WorkbenchError(400, `${p} 必须是对象`);
      out[key] = merge(base[key], value, p);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// 列出配置里所有叶子的路径（开放映射整体算一个叶子）
function leaves(obj, at = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = at ? `${at}.${k}` : k;
    if (k.startsWith('_')) return [];
    return isPlainObject(v) && !(p in OPEN_MAPS) ? leaves(v, p) : [p];
  });
}

const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function validate(config) {
  for (const p of leaves(config)) {
    if (p in OPEN_MAPS) {
      const map = getPath(config, p);
      if (!isPlainObject(map)) throw new WorkbenchError(400, `${p} 必须是对象`);
      for (const [k, v] of Object.entries(map)) {
        const e = OPEN_MAPS[p](v);
        if (e) throw new WorkbenchError(400, `${p}.${k} ${e}`);
      }
      continue;
    }
    // 默认值里出现了 SCHEMA 没覆盖的参数：说明加参数时漏了约束，宁可报错
    if (!SCHEMA[p]) throw new WorkbenchError(500, `参数 ${p} 没有定义取值约束`);
  }
  for (const [p, check] of Object.entries(SCHEMA)) {
    const e = check(getPath(config, p));
    if (e) throw new WorkbenchError(400, `${p} ${e}${LIMITS.has(p) ? '（这是上限，不能取消）' : ''}`);
  }
}

// 返回生效配置；任何一项不合法都直接报错
export function resolveConfig(defaults, override = {}) {
  if (!isPlainObject(override)) throw new WorkbenchError(400, 'protocol.json 必须是 JSON 对象');
  const config = merge(defaults, override, '');
  validate(config);
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

    // 建目录、初始化 git 仓库、补齐仓库级 .gitignore。git 不可用时照常工作，只是没有留档。
    // 服务和命令行工具都在取得单实例锁之后才调用它。
    async init() {
      fs.mkdirSync(projectsDir, { recursive: true });
      const repo = await ensureRepo(projectsDir);
      const ignore = path.join(projectsDir, '.gitignore');
      const had = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
      const lines = new Set(had.split(/\r?\n/));
      const missing = IGNORE_LINES.filter((l) => l.startsWith('#') ? false : !lines.has(l));
      if (missing.length || !had) {
        fs.writeFileSync(ignore, had ? `${had.replace(/\n?$/, '\n')}${missing.join('\n')}\n` : IGNORE_LINES.join('\n') + '\n');
        if (repo.ok) await commitPaths(projectsDir, ['.gitignore'], '[工坊] 更新项目仓库的忽略规则');
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
      let effective;
      try {
        fs.mkdirSync(staging);
        for (const sub of PROJECT_DIRS) fs.mkdirSync(path.join(staging, sub));
        for (const file of TEMPLATE_FILES) {
          const text = fs.readFileSync(path.join(templateDir, file), 'utf8');
          fs.writeFileSync(path.join(staging, file), fillTemplate(text, { name: n, date: at.slice(0, 10) }));
        }
        // 是否留档看新项目自己的生效配置；模板里的覆盖也必须合法
        effective = resolveConfig(defaults, readOverride(staging));
        appendEvent(staging, { at, type: 'project_created', project: n });
        if (fs.existsSync(dir)) throw new WorkbenchError(409, `项目 ${n} 已存在`);
        await renameRetry(staging, dir);
      } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw e;
      }
      // archive.state：done（已留档）/ disabled（项目关闭了自动留档）/ failed
      let archive = { state: 'disabled', error: null };
      if (effective.git.autoCommit) {
        const r = await commitPaths(projectsDir, TEMPLATE_FILES.map((f) => `${n}/${f}`), `[工坊] 新建项目 ${n}`);
        archive = { state: r.ok ? 'done' : 'failed', error: r.ok ? null : r.error };
        if (!r.ok) appendEvent(dir, { at: now().toISOString(), type: 'archive_failed', reason: r.error });
      }
      return { project: this.get(n), archive };
    },
  };
}
