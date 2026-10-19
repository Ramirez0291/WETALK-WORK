// 渲染检查（WP7）：PPTX → PDF 与逐页图片 → 逐页查文字溢出与重叠、字体缺失、图表（标签裁切要人工看）、图片变形。
// 渲染用本机 PowerPoint（render.ps1，自动化）；没有 PowerPoint 时只能查字体、图片和图表，溢出与重叠记为“未检查”。
// LibreOffice 本机没有安装、无法实测，这一版不接（见 WP7 日志）。
// 程序检查是初查；逐页的视觉检查（模型初查、你终审）在 WP7b。
import { spawnSync } from 'node:child_process';
import { psRender } from './proc.mjs';

const TOL = 2; // pt：排版范围超出这么多才算
const MIN_OVERLAP = 4; // pt²

let pptAvailable = null;
export function powerpointAvailable() {
  if (pptAvailable === null) {
    if (process.platform !== 'win32') pptAvailable = false;
    else {
      const r = spawnSync('reg', ['query', 'HKCR\\PowerPoint.Application\\CLSID'], { windowsHide: true, encoding: 'utf8' });
      pptAvailable = r.status === 0;
    }
  }
  return pptAvailable;
}

// 一次只开一个 PowerPoint 渲染
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

// engine：'auto' | 'powerpoint' | 'libreoffice'。返回 render.ps1 的原始结果（engine 为 powerpoint 或 fonts）
export function renderWith(engine, { pptx, outDir, resultFile, timeoutMs = 180_000 }) {
  if (engine === 'libreoffice') return Promise.reject(Object.assign(new Error('LibreOffice 渲染这一版没有接（本机没有安装，无法实测）；render.engine 请用 auto 或 powerpoint'), { status: 409 }));
  if (engine === 'powerpoint' && !powerpointAvailable()) return Promise.reject(Object.assign(new Error('本机没有 PowerPoint'), { status: 409 }));
  if (powerpointAvailable()) return serial(() => psRender(['-In', pptx, '-OutDir', outDir], resultFile, { timeoutMs }));
  return psRender(['-FontsOnly'], resultFile, { timeoutMs: 60_000 });
}

const flat = (shapes) => shapes.flatMap((s) => (s.children ? flat(s.children) : [s]));
const rect = (s) => ({ l: s.boundLeft, t: s.boundTop, r: s.boundLeft + s.boundWidth, b: s.boundTop + s.boundHeight });
const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
const r1 = (n) => Math.round(n);
const label = (s) => `「${String(s.text ?? s.name).replace(/\s+/g, ' ').slice(0, 16)}」`;

// 字体名比较：忽略大小写；“+mn-lt”这类主题占位名不算
const used = (names) => [...new Set(names.filter((n) => n && !n.startsWith('+')))];

// raw：render.ps1 的结果；readback：pptx_export.py readback 的结果；spec：交给 pptx 的幻灯片源（页 → 幻灯片编号）
export function analyze({ raw, readback, spec }) {
  const installed = new Set((raw.installed ?? []).map((n) => n.toLowerCase()));
  const fontsUsed = used([...(raw.fonts ?? []), ...(readback.theme_fonts ?? []), ...readback.slides.flatMap((s) => s.fonts ?? [])]).sort();
  const missing = fontsUsed.filter((n) => !installed.has(n.toLowerCase()));
  const rendered = raw.engine === 'powerpoint';
  const W = raw.slideWidth ?? readback.slide_width;
  const H = raw.slideHeight ?? readback.slide_height;
  const pages = readback.slides.map((rb, i) => {
    const issues = [];
    const page = i + 1;
    const r = rendered ? raw.slides?.[i] : null;
    if (r) {
      const texts = flat(r.shapes ?? []).filter((s) => s.text != null && String(s.text).trim() && s.boundHeight != null);
      for (const s of texts) {
        const b = rect(s);
        if (b.b > s.top + s.height + TOL || b.r > s.left + s.width + TOL) {
          issues.push({ level: 'error', code: 'overflow', message: `文字溢出：${label(s)} 排版范围 ${r1(s.boundWidth)}×${r1(s.boundHeight)}pt，文本框 ${r1(s.width)}×${r1(s.height)}pt`, shape: s.name });
        }
        if (b.l < -TOL || b.t < -TOL || b.r > W + TOL || b.b > H + TOL) {
          issues.push({ level: 'error', code: 'off_slide', message: `文字超出页面：${label(s)}（页面 ${r1(W)}×${r1(H)}pt，文字到 ${r1(b.r)}，${r1(b.b)}）`, shape: s.name });
        }
      }
      for (let a = 0; a < texts.length; a++) {
        for (let c = a + 1; c < texts.length; c++) {
          const ov = area(rect(texts[a]), rect(texts[c]));
          if (ov > MIN_OVERLAP) issues.push({ level: 'error', code: 'overlap', message: `文字重叠：${label(texts[a])} 与 ${label(texts[c])}（约 ${r1(ov)}pt²）`, shapes: [texts[a].name, texts[c].name] });
        }
      }
    }
    const pageMissing = used(rb.fonts ?? []).filter((n) => !installed.has(n.toLowerCase()));
    if (pageMissing.length) issues.push({ level: 'error', code: 'font_missing', message: `这一页用到本机没有的字体：${pageMissing.join('、')}（会被替换成别的字体）`, fonts: pageMissing });
    const shapes = flat(rb.shapes ?? []);
    for (const s of shapes.filter((x) => x.kind === 'picture' && x.image_ratio && x.shape_ratio)) {
      const d = s.shape_ratio / s.image_ratio;
      if (Math.abs(d - 1) > 0.02) issues.push({ level: 'error', code: 'distorted', message: `图片变形：${s.name} 显示宽高比 ${s.shape_ratio.toFixed(2)}，原图 ${s.image_ratio.toFixed(2)}`, shape: s.name });
    }
    if (shapes.some((x) => x.kind === 'chart') || flat(r?.shapes ?? []).some((x) => x.hasChart)) {
      issues.push({ level: 'warn', code: 'chart', message: '这一页有图表：标签是否被裁切，程序查不出来，要看图确认' });
    }
    return { page, slide: spec.slides[i]?.id ?? null, version: spec.slides[i]?.version ?? null, png: r?.png ?? null, issues };
  });
  const deckIssues = [];
  const themeMissing = missing.filter((n) => !pages.some((p) => p.issues.some((x) => x.fonts?.includes(n))));
  if (themeMissing.length) deckIssues.push({ level: 'error', code: 'font_missing', message: `演示文稿用到本机没有的字体：${themeMissing.join('、')}（主题或母版里的字体，会被替换）`, fonts: themeMissing });
  const errors = deckIssues.length + pages.reduce((n, p) => n + p.issues.filter((x) => x.level === 'error').length, 0);
  return {
    engine: raw.engine,
    powerpoint: raw.version ?? null,
    unchecked: rendered ? [] : ['overflow', 'overlap'],
    // 没有渲染（只查了字体等）时不给“通过”的结论
    ok: errors ? false : rendered ? true : null,
    errors,
    fonts: { used: fontsUsed, missing },
    pdf: raw.pdf ?? null,
    issues: deckIssues,
    pages,
  };
}
