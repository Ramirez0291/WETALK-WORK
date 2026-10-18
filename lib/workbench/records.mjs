// 正式记录：种类与编号、字段校验、读取，以及按内容 hash 寻址的 blob 存储。
// 记录文件只保存事实；based_on、核验状态、新鲜度这些派生量从不写进文件（见 deps.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './project.mjs';

// 种类 → 目录与编号前缀。编号按“前缀＋数字”整体匹配，OL 与 O、SC/SL 与 S 不会混淆。
export const KINDS = {
  source: { dir: 'sources', prefix: 'S' },
  claim: { dir: 'claims', prefix: 'C' },
  verification: { dir: 'verifications', prefix: 'V' },
  objection: { dir: 'objections', prefix: 'O' },
  outline: { dir: 'outline', prefix: 'OL' },
  script: { dir: 'script', prefix: 'SC' },
  slide: { dir: 'slides', prefix: 'SL' },
};
export const WORK_KINDS = ['outline', 'script', 'slide'];
const BY_PREFIX = Object.entries(KINDS).sort((a, b) => b[1].prefix.length - a[1].prefix.length);
const ID_RE = /^([A-Z]{1,2})(\d{3,6})$/;

export function kindOfId(id) {
  const m = typeof id === 'string' && id.match(ID_RE);
  if (!m) return null;
  return BY_PREFIX.find(([, k]) => k.prefix === m[1])?.[0] ?? null;
}

export const recordRelPath = (project, id) => `${project}/${KINDS[kindOfId(id)].dir}/${id}.json`;

export function formatId(kind, n) {
  return `${KINDS[kind].prefix}${String(n).padStart(3, '0')}`;
}

// 由提交入口写入的字段，提交内容里不能出现
export const SYSTEM_FIELDS = ['id', 'version', 'provenance', 'commit', 'updated_at', 'based_on', 'verifier', 'raised_by'];

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const HASH_RE = /^[0-9a-f]{64}$/;

// 记录序列化：固定缩进和结尾换行，内容相同则字节相同
export const serialize = (record) => JSON.stringify(record, null, 2) + '\n';

// 键排序后的 JSON，用来比较两次提交内容是否相同
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---------- 引文定位 ----------
// Fetch 返回的是 Markdown：ASCII 标点会被反斜杠转义（`permission\.`），换行和空白也会被重排。
// 定位引文时两边都去掉这类转义、把连续空白压成一个空格，其余字符（含全半角、标点）原样比较。
// 返回 { index, length }（相对原文），找不到为 null。
const MD_ESCAPE = /\\([!-/:-@[-`{-~])/g;
function normalizeWithMap(text) {
  let out = '';
  const map = []; // out 的第 i 个字符对应原文的位置
  let lastSpace = false;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (ch === '\\' && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) continue; // 去掉转义用的反斜杠
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      ch = ' ';
      lastSpace = true;
    } else lastSpace = false;
    out += ch;
    map.push(i);
  }
  return { out, map };
}
export function locateQuote(text, quote) {
  if (!quote) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { index: exact, length: quote.length };
  const q = quote.replace(MD_ESCAPE, '$1').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const { out, map } = normalizeWithMap(text);
  const i = out.indexOf(q);
  if (i < 0) return null;
  const start = map[i];
  const end = map[i + q.length - 1] + 1;
  return { index: start, length: end - start };
}

// ---------- blob 存储 ----------
// <项目>/archive/blobs/ab/abcdef…：只增不改。先写临时文件再改名，已存在就跳过。

export function blobStore(projectDir) {
  const root = path.join(projectDir, 'archive', 'blobs');
  const fileOf = (hash) => path.join(root, hash.slice(0, 2), hash);
  return {
    fileOf,
    relOf: (hash) => `archive/blobs/${hash.slice(0, 2)}/${hash}`,
    has: (hash) => HASH_RE.test(hash) && fs.existsSync(fileOf(hash)),
    put(data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const hash = sha256(buf);
      const file = fileOf(hash);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, buf);
        try {
          fs.renameSync(tmp, file);
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          if (!fs.existsSync(file)) throw e; // 同一内容被并发写入时，别人先写完也算成功
        }
      }
      return hash;
    },
    get(hash) {
      if (!HASH_RE.test(hash)) throw new WorkbenchError(400, `不是合法的 blob hash：${hash}`);
      return fs.readFileSync(fileOf(hash));
    },
  };
}

// ---------- 读取 ----------

// 返回 Map<id, record>。文件名必须与 id 一致，否则视为外部改动的坏文件，记入 problems。
export function loadRecords(projectDir) {
  const records = new Map();
  const problems = [];
  for (const [kind, { dir }] of Object.entries(KINDS)) {
    const full = path.join(projectDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(full, name), 'utf8'));
        if (rec.id !== id || kindOfId(id) !== kind || !Number.isInteger(rec.version) || rec.version < 1) throw new Error('id、种类或版本号不符');
        records.set(id, rec);
      } catch (e) {
        problems.push({ file: `${dir}/${name}`, error: e.message });
      }
    }
  }
  return { records, problems };
}

// ---------- 字段校验 ----------

const bad = (msg) => {
  throw new WorkbenchError(400, msg);
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function text(v, field, { required = true, max = 20_000 } = {}) {
  if (v == null || v === '') {
    if (required) bad(`缺少 ${field}`);
    return undefined;
  }
  if (typeof v !== 'string') bad(`${field} 必须是字符串`);
  if (required && !v.trim()) bad(`${field} 不能为空`);
  if (v.length > max) bad(`${field} 超过 ${max} 字`);
  return v;
}

function onlyKeys(obj, allowed, field) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${field} 里有未知字段 ${k}`);
}

// 引用：{ id, version }。id 可以是本次提交里的临时编号（$开头），这时 version 必须省略或为 1。
function ref(v, field, expectKind, extra = []) {
  if (!isObj(v)) bad(`${field} 必须是 { id, version } 对象`);
  onlyKeys(v, ['id', 'version', ...extra], field);
  if (typeof v.id !== 'string') bad(`${field}.id 必须是字符串`);
  if (v.id.startsWith('$')) {
    if (!/^\$[\w-]{1,32}$/.test(v.id)) bad(`${field}.id 临时编号格式不对`);
    if (v.version !== undefined && v.version !== 1) bad(`${field} 引用本次新建的记录，version 只能省略或为 1`);
    return { ...v, version: 1 };
  }
  if (kindOfId(v.id) !== expectKind) bad(`${field}.id 必须是${expectKind}编号（${KINDS[expectKind].prefix}###）`);
  if (!Number.isInteger(v.version) || v.version < 1) bad(`${field}.version 必须是正整数：引用一律写成 {id, version}`);
  return v;
}

const CLAIM_TYPES = ['fact', 'textual', 'interpretation', 'speculation'];
export const AVAILABILITY = ['available', 'temporarily_unavailable', 'gone'];

// 每种记录的业务字段。返回规范化后的数据；source 的 text 原样留着，由提交入口转成 text_blob。
const SCHEMAS = {
  source(d) {
    // 可获取性（availability）不在来源卡里：它由抓取记录和主持人的确认派生，变化时来源不升版（见 usage.mjs）
    onlyKeys(d, ['title', 'author', 'edition', 'citation', 'url', 'origin', 'text', 'text_blob', 'retrieved_at', 'note'], 'source');
    const out = { title: text(d.title, 'title', { max: 500 }) };
    for (const k of ['author', 'edition', 'citation', 'origin', 'note']) {
      const v = text(d[k], k, { required: false, max: 2000 });
      if (v !== undefined) out[k] = v;
    }
    if (d.url !== undefined) {
      const u = text(d.url, 'url', { max: 2000 });
      if (!/^https?:\/\//i.test(u)) bad('url 必须以 http:// 或 https:// 开头');
      out.url = u;
    }
    if (!out.citation && !out.url) bad('来源卡至少要有 citation 或 url 之一');
    if (d.text !== undefined && d.text_blob !== undefined) bad('text 和 text_blob 只能给一个');
    if (d.text !== undefined) out.text = text(d.text, 'text', { max: 900_000 });
    if (d.text_blob !== undefined) {
      if (!HASH_RE.test(d.text_blob)) bad('text_blob 必须是 sha256');
      out.text_blob = d.text_blob;
    }
    if (d.retrieved_at !== undefined) {
      if (typeof d.retrieved_at !== 'string' || !Number.isFinite(Date.parse(d.retrieved_at))) bad('retrieved_at 必须是 ISO 时间');
      out.retrieved_at = d.retrieved_at;
    }
    return out;
  },

  claim(d) {
    onlyKeys(d, ['type', 'text', 'core', 'sources', 'earliest_attestation'], 'claim');
    if (!CLAIM_TYPES.includes(d.type)) bad(`type 只能是 ${CLAIM_TYPES.join(' / ')}`);
    const out = { type: d.type, text: text(d.text, 'text', { max: 2000 }) };
    if (d.core !== undefined) {
      if (typeof d.core !== 'boolean') bad('core 必须是 true 或 false');
      out.core = d.core;
    }
    if (d.type === 'textual') {
      const ea = d.earliest_attestation;
      if (!isObj(ea)) bad('文献记载类论断（textual）必须填 earliest_attestation（最早出处）');
      onlyKeys(ea, ['work', 'author', 'period'], 'earliest_attestation');
      out.earliest_attestation = { work: text(ea.work, 'earliest_attestation.work', { max: 500 }) };
      for (const k of ['author', 'period']) if (ea[k] !== undefined) out.earliest_attestation[k] = text(ea[k], `earliest_attestation.${k}`, { max: 500 });
    } else if (d.earliest_attestation !== undefined) bad('只有 textual 论断填 earliest_attestation');
    if (!Array.isArray(d.sources ?? [])) bad('sources 必须是数组');
    out.sources = (d.sources ?? []).map((s, i) => {
      const r = ref(s, `sources[${i}]`, 'source', ['locator', 'quote']);
      const o = { id: r.id, version: r.version };
      if (s.locator !== undefined) o.locator = text(s.locator, `sources[${i}].locator`, { max: 500 });
      if (s.quote !== undefined) o.quote = text(s.quote, `sources[${i}].quote`, { max: 5000 });
      return o;
    });
    return out;
  },
};

// ---------- 核验记录与异议（契约一）----------
// verifier、raised_by 由提交入口按服务端认定的身份填写，提交内容里不能出现。
// 两者的 target 都不能是本次提交里新建的记录（$临时编号）：核验者与作者不能是同一次提交。

export const VERDICTS = ['supported', 'unsupported'];
export const OBJECTION_CATEGORIES = ['source_missing', 'number_error', 'quote_unsupported', 'interpretation', 'narrative', 'extension'];
export const OBJECTION_STATES = ['open', 'needs_evidence', 'upheld', 'rejected', 'needs_user', 'withdrawn', 'resolved'];
export const POINTER_TYPES = ['quote', 'fetch_failure', 'missing_source', 'gone', 'location'];

function fixedRef(v, field, kinds) {
  if (!isObj(v)) bad(`${field} 必须是 { id, version } 对象`);
  onlyKeys(v, ['id', 'version'], field);
  if (typeof v.id !== 'string' || v.id.startsWith('$')) bad(`${field}.id 必须是已有记录的编号（不能是本次新建的临时编号）`);
  if (!kinds.includes(kindOfId(v.id))) bad(`${field}.id 必须是 ${kinds.map((k) => KINDS[k].prefix).join(' / ')} 编号`);
  if (!Number.isInteger(v.version) || v.version < 1) bad(`${field}.version 必须是正整数`);
  return { id: v.id, version: v.version };
}

SCHEMAS.verification = (d) => {
  onlyKeys(d, ['target', 'source_versions', 'verdict', 'reason', 'support_quote'], 'verification');
  const out = { target: fixedRef(d.target, 'target', ['claim']) };
  if (!Array.isArray(d.source_versions)) bad('source_versions 必须是数组：写明核验时读的每个来源版本');
  out.source_versions = d.source_versions.map((s, i) => fixedRef(s, `source_versions[${i}]`, ['source']));
  if (!VERDICTS.includes(d.verdict)) bad(`verdict 只能是 ${VERDICTS.join(' / ')}（证据不足也写 unsupported）`);
  out.verdict = d.verdict;
  out.reason = text(d.reason, 'reason', { max: 4000 });
  if (d.verdict === 'supported') {
    const q = d.support_quote;
    if (!isObj(q)) bad('判为 supported 时必须附支持引文 support_quote：{ id, version, quote, locator? }');
    onlyKeys(q, ['id', 'version', 'quote', 'locator'], 'support_quote');
    const r = fixedRef({ id: q.id, version: q.version }, 'support_quote', ['source']);
    out.support_quote = { ...r, quote: text(q.quote, 'support_quote.quote', { max: 5000 }) };
    if (q.locator !== undefined) out.support_quote.locator = text(q.locator, 'support_quote.locator', { max: 500 });
  } else if (d.support_quote !== undefined) bad('只有 supported 需要 support_quote');
  return out;
};

function pointerOf(p) {
  if (!isObj(p)) bad('pointer 必须是对象：{ type, … }');
  if (!POINTER_TYPES.includes(p.type)) bad(`pointer.type 只能是 ${POINTER_TYPES.join(' / ')}`);
  switch (p.type) {
    case 'quote': {
      onlyKeys(p, ['type', 'source', 'quote', 'locator'], 'pointer');
      const out = { type: 'quote', source: fixedRef(p.source, 'pointer.source', ['source']), quote: text(p.quote, 'pointer.quote', { max: 5000 }) };
      if (p.locator !== undefined) out.locator = text(p.locator, 'pointer.locator', { max: 500 });
      return out;
    }
    case 'fetch_failure':
      onlyKeys(p, ['type', 'source', 'attempt'], 'pointer');
      if (!isObj(p.source) || kindOfId(p.source.id) !== 'source') bad('pointer.source 必须是 { id: S### }');
      return { type: 'fetch_failure', source: { id: p.source.id }, attempt: text(p.attempt, 'pointer.attempt', { max: 64 }) };
    case 'gone':
      onlyKeys(p, ['type', 'source'], 'pointer');
      if (!isObj(p.source) || kindOfId(p.source.id) !== 'source') bad('pointer.source 必须是 { id: S### }');
      return { type: 'gone', source: { id: p.source.id } };
    case 'missing_source':
      onlyKeys(p, ['type'], 'pointer');
      return { type: 'missing_source' };
    default:
      onlyKeys(p, ['type', 'locator'], 'pointer');
      return { type: 'location', locator: text(p.locator, 'pointer.locator', { max: 1000 }) };
  }
}

SCHEMAS.objection = (d) => {
  onlyKeys(d, ['target', 'category', 'pointer', 'reason', 'state', 'resolution'], 'objection');
  const out = { target: fixedRef(d.target, 'target', ['claim', 'source', ...WORK_KINDS]) };
  if (!OBJECTION_CATEGORIES.includes(d.category)) bad(`category 只能是 ${OBJECTION_CATEGORIES.join(' / ')}`);
  out.category = d.category;
  out.pointer = pointerOf(d.pointer);
  out.reason = text(d.reason, 'reason', { max: 4000 });
  if (!OBJECTION_STATES.includes(d.state)) bad(`state 只能是 ${OBJECTION_STATES.join(' / ')}`);
  out.state = d.state;
  const res = text(d.resolution, 'resolution', { required: false, max: 4000 });
  if (res !== undefined) out.resolution = res;
  return out;
};

function workSchema(d, kind) {
  onlyKeys(d, ['title', 'body', 'notes', 'order', 'claims'], kind);
  const out = { title: text(d.title, 'title', { max: 500 }) };
  for (const k of ['body', 'notes']) {
    const v = text(d[k], k, { required: false });
    if (v !== undefined) out[k] = v;
  }
  if (d.order !== undefined) {
    if (typeof d.order !== 'number' || !Number.isFinite(d.order)) bad('order 必须是数字');
    out.order = d.order;
  }
  if (!Array.isArray(d.claims ?? [])) bad('claims 必须是数组');
  out.claims = (d.claims ?? []).map((c, i) => {
    const r = ref(c, `claims[${i}]`, 'claim');
    return { id: r.id, version: r.version };
  });
  return out;
}
for (const k of WORK_KINDS) SCHEMAS[k] = (d) => workSchema(d, k);

// 核验记录与异议的写入规则（跨厂商、引文、异议状态机）在晋升时检查，见 verify.mjs、objections.mjs
export const WRITABLE_KINDS = ['source', 'claim', ...WORK_KINDS, 'verification', 'objection'];

export function validateData(kind, data) {
  if (!WRITABLE_KINDS.includes(kind)) bad(`${kind} 记录不能经提交入口写入`);
  if (!isObj(data)) bad('data 必须是对象');
  for (const f of SYSTEM_FIELDS) if (f in data) bad(`${f} 由提交入口填写，提交内容里不能出现`);
  return SCHEMAS[kind](data);
}

// 一条记录引用了哪些记录（权威引用字段）。based_on 只从这里派生。
export function refsOf(rec) {
  const kind = kindOfId(rec.id);
  if (kind === 'claim') return (rec.sources || []).map((s) => ({ id: s.id, version: s.version }));
  if (WORK_KINDS.includes(kind)) return (rec.claims || []).map((c) => ({ id: c.id, version: c.version }));
  return [];
}
