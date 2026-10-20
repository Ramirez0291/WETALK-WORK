// 工坊页面。导航按要做的事分组（WP8）：首页（这个阶段的下一步、待你决定）、工作（任务、分工、竞争、调度与阶段）、
// 资料（记录、追溯、研讨）、成品（导出、报告）、约定与系统（项目约定与参数、提交与留档、候选稿）；另有新建项目向导。
// 界面文字用 ui`` / localized 翻译（与研讨室共用 i18n.js 和语言偏好）；记录内容、方案正文、评审意见、服务端报错原文不翻译。
import { t as ui, localized, getLanguage, setLanguage, initStaticTranslations, translateError } from './i18n.js';
import { parseConventions, joinConventions, hintsOf, contentOf, bodyFrom, missingOf } from './conventions.js';

const $ = (s) => document.querySelector(s);
const TOKEN = document.querySelector('meta[name="wb-host-token"]').content;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// [文字, 样式] 形式的徽章查表：和 localized 一样在取用时翻译文字
const localizedBadges = (table) => new Proxy(table, { get: (o, k) => (Object.hasOwn(o, k) ? [ui(o[k][0]), o[k][1]] : o[k]) });
const KIND = localized({ source: '来源卡', claim: '论断', verification: '核验', objection: '异议', outline: '大纲', script: '讲稿', slide: '幻灯片', export: '导出' });
const VER = localizedBadges({ unreviewed: ['未核验', 'b-muted'], supported: ['支持', 'b-ok'], disputed: ['有分歧', 'b-warn'], unsupported: ['不支持', 'b-bad'] });
const ARCHIVE = localizedBadges({ archived: ['已留档', 'b-ok'], pending: ['待留档', 'b-warn'], failed: ['留档失败，待重试', 'b-bad'], skipped: ['不留档', 'b-muted'] });
const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const time = (iso) => (iso ? new Date(iso).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '');

// 先登记 HTML 外壳里的原文，再渲染任何动态内容
const applyStaticTranslations = initStaticTranslations();
applyStaticTranslations();
$('#languageSelect').value = getLanguage();

let project = null;
let tab = 'overview';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Workbench-Host': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  // 只翻已知的固定句式（translateError），其余报错保持服务端原文
  if (!res.ok) throw Object.assign(new Error(data.error ? translateError(String(data.error)) : `HTTP ${res.status}`), { details: data.details });
  return data;
}
const P = (tail = '') => `/api/projects/${encodeURIComponent(project)}${tail}`;

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), err ? 9000 : 3500);
}
const fail = (e) => toast(`${e.message}${e.details ? '\n' + JSON.stringify(e.details, null, 2) : ''}`, true);

// ---------- 项目 ----------

// 新建项目时，接口返回和实时事件会各触发一次加载：只认最后一次调用的结果
let loadSeq = 0;
async function loadProjects(select) {
  const seq = ++loadSeq;
  const list = await api('GET', '/api/projects');
  if (seq !== loadSeq) return;
  const sel = $('#project');
  sel.innerHTML = list.map((p) => `<option value="${esc(p.name)}">${esc(p.title)}</option>`).join('') || ui('<option value="">（还没有项目）</option>');
  const want = select ?? new URLSearchParams(location.search).get('p') ?? localStorage.getItem('wb.project');
  project = list.some((p) => p.name === want) ? want : list[0]?.name ?? null;
  sel.value = project ?? '';
  // 还没有任何项目：直接打开新建项目向导
  if (!project && tab !== 'new') {
    wizard = { mode: 'start' };
    showTab('new');
  }
  await render();
  // 从研讨室回来（?r=编号）：打开那条记录或那次竞争
  const r = new URLSearchParams(location.search).get('r');
  if (r && project && !loadProjects.opened) {
    loadProjects.opened = true;
    if (/^K\d{3,6}$/.test(r)) {
      document.querySelector('#tabs [data-tab="compete"]').click();
      setTimeout(() => showCompetition(r).catch(fail), 100);
    } else if (/^[A-Z]{1,2}\d{3,6}$/.test(r)) {
      document.querySelector('#tabs [data-tab="records"]').click();
      setTimeout(() => showRecord(r).catch(fail), 100);
    }
  }
}

$('#project').onchange = (e) => {
  project = e.target.value;
  try { localStorage.setItem('wb.project', project); } catch {}
  render();
};

// ---------- 导航 ----------
// 两级：组（#groups）和组里的页（#tabs）。别处用 #tabs [data-tab=…] 的 click() 跳转，照样会切到对应的组

const GROUP_OF = Object.fromEntries([...document.querySelectorAll('#tabs [data-tab]')].map((b) => [b.dataset.tab, b.dataset.group]));
const lastTab = { home: 'overview', work: 'tasks', material: 'records', product: 'export', system: 'settings', new: 'new' };
function showTab(next) {
  tab = next;
  const group = GROUP_OF[next];
  lastTab[group] = next;
  for (const x of document.querySelectorAll('#groups button')) x.classList.toggle('on', x.dataset.group === group);
  for (const x of document.querySelectorAll('#tabs button')) {
    x.hidden = x.dataset.group !== group || group === 'new';
    x.classList.toggle('on', x.dataset.tab === next);
  }
  for (const sec of document.querySelectorAll('main > section')) sec.hidden = sec.id !== `tab-${next}`;
}
const go = (next) => {
  if (next !== tab) window.scrollTo(0, 0);
  showTab(next);
  return render();
};
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => go(b.dataset.tab);
for (const b of document.querySelectorAll('#groups button')) b.onclick = () => go(lastTab[b.dataset.group]);
showTab('overview');

// quiet：实时事件触发的刷新。正在首页或设置页的输入框里打字时不重画这一页，免得打断输入
async function render({ quiet = false } = {}) {
  if (tab === 'new') return renderWizard().catch(fail);
  if (!project) {
    $('#tab-overview').innerHTML = ui`<div class="panel next"><h3>还没有项目</h3><p>点右上角的“＋ 新建项目”：写一段说明，让你信任的 Agent 起草项目约定，你改好、确认后就可以开始。</p><p><button type="button" class="primary" id="emptyNew">＋ 新建项目</button></p></div>`;
    $('#emptyNew').onclick = () => $('#newProjectBtn').click();
    return;
  }
  try {
    const inbox = await api('GET', P('/inbox'));
    for (const el of document.querySelectorAll('.inbox-count')) {
      el.hidden = !inbox.length;
      el.textContent = inbox.length;
    }
    const sec = $(`#tab-${tab}`);
    const typing = sec?.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (quiet && typing && ['overview', 'settings'].includes(tab)) return;
    await VIEWS[tab]?.(inbox);
    // 打开着的记录详情（例如核验结果陆续回来）一起刷新；正在填表单时不刷，免得冲掉输入
    const box = $('#recordDetail');
    if (tab === 'records' && openRecord && !box.hidden && !box.contains(document.activeElement) && !box.querySelector('details[open]')) await showRecord(openRecord, { scroll: false, keep: true });
    const kb = $('#competitionDetail');
    if (tab === 'compete' && openCompetition && !kb.hidden && !kb.contains(document.activeElement)) await showCompetition(openCompetition, { scroll: false, keep: true });
  } catch (e) {
    fail(e);
  }
}

const fresh = (s) => (s.freshness === 'stale' ? badge(ui('待更新'), 'b-warn') : badge(ui('最新'), 'b-ok'));
const ready = (s) => (s.ready === undefined ? '' : s.ready ? badge(ui('可进入成品'), 'b-ok') : badge(ui('不可进入成品'), 'b-muted'));
// 核验状态带份数：支持且份数够才算数（核心结论默认 2 份，其他 1 份）
const verif = (s) => {
  const v = s.verification;
  if (!v) return '';
  const [text, cls] = VER[v.state];
  return badge(v.state === 'supported' ? `${text} ${v.independent}/${v.required}` : text, v.state === 'supported' && !v.enough ? 'b-warn' : cls);
};
const UNCOUNTED = localized({
  is_author: '核验者是这条论断（某个版本）的作者', vendor_conflict: '实际报告的模型与配置的厂商不一致，待确认',
  same_vendor: '与作者同厂商', identity_unverified: '身份未证实（MCP 外部会话）', vendor_unknown: '推断不出核验者的厂商',
  author_vendor_unknown: '推断不出作者的厂商', superseded: '同一核验者后来又核验了一次，只算最新一份',
});
const O_STATE = localizedBadges({
  open: ['待裁定', 'b-bad'], needs_evidence: ['待补证', 'b-bad'], upheld: ['成立', 'b-bad'], needs_user: ['待你决定', 'b-bad'],
  rejected: ['不成立', 'b-muted'], withdrawn: ['已撤回', 'b-muted'], resolved: ['已解决', 'b-ok'],
});
const O_CATEGORY = localized({
  source_missing: '来源不存在（阻塞）', number_error: '数字错误（阻塞）', quote_unsupported: '引文不支持结论（阻塞）',
  interpretation: '解释争议', narrative: '叙事选择', extension: '可选扩展',
});
// 主持人在页面上能把异议转到的状态（最终由提交入口的状态机按身份判断）
const O_NEXT = { open: ['upheld', 'rejected', 'needs_user', 'withdrawn'], needs_evidence: ['needs_user', 'withdrawn'], upheld: ['resolved'], needs_user: ['upheld', 'rejected', 'open', 'withdrawn', 'resolved'] };
const who = (a) => (a ? `${a.participant ?? a.kind}${a.vendor && a.vendor !== 'human' ? ui`（${a.vendor}）` : ''}${a.verified ? '' : ui(' · 未证实')}` : '');
const blocks = (s) => (s.blockers.length ? badge(ui`阻塞 ${s.blockers.join(ui('、'))}`, 'b-bad') : '');
const titleOf = (r) => r.title ?? r.text ?? r.target?.id ?? '';

const TASK_STATE = localizedBadges({
  proposed: ['已提出', 'b-muted'], open: ['可认领', 'b-warn'], claimed: ['进行中', 'b-warn'], submitted: ['已交稿', 'b-warn'],
  done: ['完成', 'b-ok'], failed: ['失败', 'b-bad'], cancelled: ['已取消', 'b-muted'], needs_user: ['待你决定', 'b-bad'],
});
const VIS = localized({ sealed: '密封起草', review: '匿名评审', audience: '观众型读者', read: '读资料', export: '导出版式', visual: '视觉检查', plan: '起草约定' });
let people = [];

const VIEWS = {
  // 首页：这个阶段的下一步、待你决定、项目约定、进展（见文件末尾“首页”一节）
  overview: (inbox) => renderHome(inbox),
  settings: () => renderSettings(),

  async records() {
    if (!people.length) people = (await api('GET', '/api/state')).participants.filter((x) => x.available);
    const kind = $('#kindFilter').value;
    const list = await api('GET', P(`/records${kind ? `?kind=${kind}` : ''}`));
    $('#recordList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>编号</th><th>种类</th><th>版本</th><th>内容</th><th>状态</th><th>来源</th></tr>
        ${list.map(({ record: r, kind: k, status: s }) => `
          <tr class="click" data-id="${r.id}">
            <td><code>${r.id}</code></td><td>${KIND[k]}</td><td>v${r.version}</td>
            <td>${esc(titleOf(r)).slice(0, 80)}</td>
            <td>${fresh(s)} ${verif(s)} ${blocks(s)} ${ready(s)}</td>
            <td class="hint">${esc(r.provenance?.kind === 'human' ? r.provenance.participant : r.provenance?.participant ?? '')}</td>
          </tr>`).join('')}</table></div>`
      : ui('<p class="hint">没有记录。</p>');
    for (const tr of document.querySelectorAll('#recordList tr.click')) tr.onclick = () => showRecord(tr.dataset.id);
  },

  async trace() {
    const id = $('#traceId').value.trim();
    if (id) await showTrace(id);
  },

  async commits() {
    const list = await api('GET', P('/commits'));
    $('#commitList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>提交</th><th>时间</th><th>记录</th><th>数据</th><th>留档</th><th>来自</th></tr>
        ${list.map((c) => `<tr>
          <td><code>${c.cid}</code></td><td>${time(c.at)}</td>
          <td>${c.records.map((r) => `<code>${r.id}</code> v${r.version}`).join(ui('、'))}</td>
          <td>${badge(ui('已提交'), 'b-ok')}</td>
          <td>${badge(...ARCHIVE[c.archive.state])}${c.archive.error ? `<div class="hint">${esc(c.archive.error)}</div>` : ''}</td>
          <td class="hint">${c.task_id ? ui`任务 ${esc(c.task_id)}#${c.attempt}` : ui`候选稿 ${esc(c.sid)}`}</td>
        </tr>`).join('')}</table></div>`
      : ui('<p class="hint">还没有提交。</p>');
  },

  async candidates() {
    const list = (await api('GET', P('/submissions'))).sort((a, b) => b.received_at.localeCompare(a.received_at));
    $('#candidateList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>候选稿</th><th>收稿时间</th><th>状态</th><th></th></tr>
        ${list.map((c) => `<tr>
          <td><code>${esc(c.sid)}</code></td><td>${time(c.received_at)}</td>
          <td>${c.applied ? badge(ui`已晋升（提交 ${c.applied}）`, 'b-ok') : c.state === 'draft' ? badge(ui('历史草稿'), 'b-muted') : badge(ui('待晋升'), 'b-warn')}</td>
          <td>${c.owner ? ui`<span class="hint">属于 ${esc(c.owner)}，由它的流程晋升</span>` : !c.applied && c.state === 'received' ? ui`<button class="primary" data-promote="${esc(c.sid)}">晋升</button>` : ''}</td>
        </tr>`).join('')}</table></div>`
      : ui('<p class="hint">没有候选稿。</p>');
    for (const b of document.querySelectorAll('[data-promote]')) b.onclick = () => promote(b.dataset.promote);
    const code = (s) => `<code>${esc(s)}</code>`;
    $('#candidateHint').innerHTML = ui`每条改动：新建写 ${code('kind')}、${code('expected_version: 0')}，可用 ${code('tmp')}（如 ${code('$s1')}）让同一次提交里的论断引用它；修改写 ${code('id')} 和当前版本 ${code('expected_version')}。引用一律写成 ${code('{"id","version"}')}。提交后先存为候选稿，再点“晋升”写入正式区。`;
    if (!$('#changes').value) $('#changes').value = EXAMPLES.source();
  },

  async tasks() {
    const [list, o, state] = await Promise.all([api('GET', P('/tasks')), api('GET', P()), api('GET', '/api/state')]);
    people = state.participants.filter((x) => x.available);
    const types = [...Object.keys(o.config.modes), 'verify_claim', 'find_evidence', 'anonymous_review', 'audience_reader'];
    const sel = $('#taskType');
    // 选项里有“特殊”字样：切换语言后也要重画（保留当前选择）
    if (sel.options.length !== types.length || sel.dataset.lang !== getLanguage()) {
      const keep = sel.value;
      sel.innerHTML = types.map((t) => ui`<option value="${esc(t)}">${esc(t)}（${esc(o.config.modes[t] ?? ui('特殊'))}）</option>`).join('');
      sel.dataset.lang = getLanguage();
      if (types.includes(keep)) sel.value = keep;
    }
    const opts = people.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    $('#taskList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>任务</th><th>类型</th><th>标题</th><th>状态</th><th>尝试</th><th>持有者</th><th>用量</th><th>操作</th></tr>
        ${list.map((t) => {
          const round = t.attempts.find((a) => a.n === t.attempt)?.sealed_round;
          const acts = [];
          if (t.state === 'open') acts.push(ui`<select data-who="${t.id}">${opts}</select><button data-dispatch="${t.id}">派发</button>`);
          if (t.state === 'needs_user') acts.push(ui`<button data-decide="${t.id}" data-to="open">重开</button>`);
          if (t.state === 'submitted' && round) acts.push(ui`<button class="primary" data-reveal="${esc(round)}">揭晓 ${esc(round)}</button>`);
          if (!['done', 'failed', 'cancelled'].includes(t.state)) acts.push(ui`<button data-cancel="${t.id}">取消</button>`);
          if (t.attempt) acts.push(ui`<button data-packet="${t.id}">任务包</button>`);
          return ui`<tr><td><code>${t.id}</code></td><td>${esc(t.type)}<div class="hint">${esc(VIS[t.visibility] ?? t.visibility)}</div></td>
            <td>${esc(t.title)}</td><td>${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))}<div class="hint">${esc(t.history.at(-1)?.reason ?? '')}</div></td>
            <td>${t.attempt}/${t.max_attempts}</td><td class="hint">${esc(t.holder?.participant ?? '')}</td>
            <td class="hint">${t.budget_used.calls} 次${t.budget_used.usd ? ` · $${t.budget_used.usd.toFixed(4)}` : ''}</td><td>${acts.join(' ')}</td></tr>`;
        }).join('')}</table></div>`
      : ui('<p class="hint">还没有任务。</p>');
    const act = async (fn) => {
      try {
        await fn();
      } catch (e) {
        fail(e);
      }
      VIEWS.tasks();
    };
    for (const b of document.querySelectorAll('[data-dispatch]')) b.onclick = () => act(() => api('POST', P(`/tasks/${b.dataset.dispatch}/dispatch`), { participant: document.querySelector(`[data-who="${b.dataset.dispatch}"]`).value }));
    for (const b of document.querySelectorAll('[data-cancel]')) b.onclick = () => act(() => api('POST', P(`/tasks/${b.dataset.cancel}/cancel`), {}));
    for (const b of document.querySelectorAll('[data-decide]')) b.onclick = () => act(() => api('POST', P(`/tasks/${b.dataset.decide}/decide`), { to: b.dataset.to }));
    for (const b of document.querySelectorAll('[data-reveal]')) b.onclick = () => act(() => api('POST', P(`/rounds/${encodeURIComponent(b.dataset.reveal)}/reveal`), {}));
    for (const b of document.querySelectorAll('[data-packet]')) b.onclick = () => showPacket(b.dataset.packet).catch(fail);
  },

  async inbox(items) {
    $('#inboxList').innerHTML = items.length
      ? ui`${inboxTable(items)}
        <p class="hint">外部改动不会被提交入口覆盖：涉及这些文件的晋升会被拒绝，直到处理完。点编号打开记录详情，在那里处理异议。</p>
        <div id="inboxDetail"></div>`
      : ui('<p class="hint">没有待你决定的事项。</p>');
    bindInbox($('#inboxList'));
  },

  // ---------- 调度与阶段（WP6） ----------
  async schedule() {
    const s = await api('GET', P('/scheduler'));
    const at = s.phase ? s.phases.findIndex((x) => x.id === s.phase.id) : -1;
    $('#phaseSteps').innerHTML = s.phases.map((x, i) => `<span class="${i === at ? 'on' : i < at ? 'done' : ''}">${esc(ui(x.name))}</span>`).join('');
    const sel = $('#phaseTo');
    const keep = sel.value;
    sel.innerHTML = s.phases.filter((x) => x.id !== s.phase?.id).map((x) => `<option value="${esc(x.id)}">${esc(ui(x.name))}</option>`).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    else if (at + 1 < s.phases.length && at >= -1) sel.value = s.phases[at + 1].id;
    const pname = (id) => ui(s.phases.find((x) => x.id === id)?.name ?? '（开始）');
    // 上一次切换中途失败：阶段没变，待办还在，再切换一次就从头重做
    const sw = s.switching;
    const pending = sw
      ? ui`<p>${badge(ui('阶段切换没完成'), 'b-bad')} 切换到“${esc(ui(sw.to_name))}”还没完成${sw.error ? ui`：${esc(sw.error.message)}` : ''}。阶段仍是原来的，调度暂停派发；再切换一次把它做完。</p>
        <p><button id="phaseResume" class="primary">继续切换到“${esc(ui(sw.to_name))}”</button></p>
        ${sw.archive ? ui`<p class="hint">旧阶段的工作笔记归档在 <code>${esc(sw.archive)}</code>，重做时合并进同一份归档，不会再归档一份空的。</p>` : ''}`
      : '';
    $('#phaseHistory').innerHTML = pending + (s.phase_history.length
      ? `<ul>${s.phase_history.slice().reverse().map((h) => ui`<li>${time(h.at)} · ${esc(h.from ? pname(h.from) : ui('（开始）'))} → ${esc(pname(h.to))} · 交接单 <a href="#" data-h="${esc(h.id)}"><code>${esc(h.id)}</code></a>${h.memory ? ui` · 归档了 ${h.memory.archived} 份工作笔记` : ''}${h.recovered_from ? ui(' · 中途失败过，重做后完成') : ''}</li>`).join('')}</ul>`
      : ui('<p class="hint">还没有设阶段。切换到第一个阶段时生成第一份交接单。</p>'));
    if (sw) $('#phaseResume').onclick = () => switchPhase(sw.to);
    $('#autoOn').checked = s.auto;
    const r = s.round;
    $('#roundNow').innerHTML = r
      ? ui`<p>${badge(ui`第 ${r.n} 轮进行中`, 'b-warn')} ${esc(r.phase_name ? ui(r.phase_name) : '')}：${r.live.map((x) => `<code>${esc(x.task)}</code> ${badge(...(TASK_STATE[x.state] ?? [x.state, 'b-muted']))}`).join(' ')}</p>`
      : s.last?.blocked
        ? ui('<p class="hint">阶段切换没完成，调度暂停派发。</p>')
      : s.last
        ? ui`<p class="hint">上次派发：${time(s.last.at)}，派出 ${s.last.dispatched.length} 个任务${s.last.skipped.length ? ui`，${s.last.skipped.length} 个没派出去` : ''}。</p>${s.last.skipped.length ? `<details><summary>${esc(ui('没派出去的原因'))}</summary><ul>${s.last.skipped.map((x) => `<li><code>${esc(x.task)}</code> <span class="hint">${esc(x.reason)}</span></li>`).join('')}</ul></details>` : ''}`
        : ui('<p class="hint">还没有派发过。</p>');
    if (s.last_error) $('#roundNow').innerHTML += ui`<p>${badge(ui('调度出错'), 'b-bad')} <span class="hint">${time(s.last_error.at)}：${esc(s.last_error.message)}</span></p>`;
    const q = (a) => {
      const x = a.quality;
      const c = x.confusions ? ui`，不懂处 ${x.confusions.before} → ${x.confusions.after}` : '';
      return ui`新增 supported 论断 ${x.supported_new}，解除阻塞 ${x.blockers_resolved}${c}`;
    };
    const ACTION = localized({ audience_reader: '派了观众型新读者', needs_user: '交给你决定' });
    const PLAN = localized({ audience_reader: '派观众型新读者', needs_user: '交给你决定' });
    $('#roundList').innerHTML = ui`<h4>轮次</h4><p class="hint">一轮 = 一批派发到全部结束。连续 ${s.plateau.rounds} 轮停滞时：${esc(PLAN[s.plateau.action] ?? s.plateau.action)}。现在连续停滞 ${s.streak} 轮。</p>`
      + (s.rounds.length
        ? ui`<div class="wrap"><table><tr><th>轮</th><th>阶段</th><th>时间</th><th>任务</th><th>结论</th><th>改动记录</th><th>质量指标</th><th>处理</th></tr>
          ${s.rounds.map((x) => `<tr><td>${x.n}</td><td>${esc(x.phase_name ? ui(x.phase_name) : '—')}</td><td class="hint">${time(x.started_at)}<br>${time(x.ended_at)}</td>
            <td>${x.tasks.map((t) => `<code>${esc(t)}</code>`).join(' ')}</td>
            <td>${badge(...(ROUND_KIND[x.assessment.kind] ?? [x.assessment.kind, 'b-muted']))}</td>
            <td class="hint">${x.assessment.changelog.not_filled ? ui`没填：${x.assessment.changelog.missing.join(ui('、'))}` : x.assessment.changelog.writers.length ? ui('已填') : '—'}</td>
            <td class="hint">${q(x.assessment)}</td>
            <td class="hint">${x.action ? `${esc(ACTION[x.action.type] ?? x.action.type)}${x.action.task ? ` <code>${esc(x.action.task)}</code>` : ''}` : ''}</td></tr>`).join('')}</table></div>`
        : ui('<p class="hint">还没有收过轮。</p>'));
    $('#cooldownList').innerHTML = s.cooldowns.length
      ? ui`<h4>冷却中的参与者</h4><ul>${s.cooldowns.map((c) => ui`<li><code>${esc(c.participant)}</code> 到 ${time(c.until)}（${esc(c.reason)}）</li>`).join('')}</ul>`
      : '';
    for (const a of document.querySelectorAll('#phaseHistory [data-h]')) a.onclick = (e) => (e.preventDefault(), showHandoff(a.dataset.h).catch(fail));
  },

  // ---------- 分工 ----------
  async divide() {
    const [list, o] = await Promise.all([api('GET', P('/divisions')), api('GET', P()), loadPeople()]);
    const types = Object.entries(o.config.modes).filter(([, m]) => m === 'divide').map(([t]) => t);
    const sel = $('#dvType');
    if (sel.options.length !== types.length) sel.innerHTML = types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    peopleBoxes($('#dvPeople'), 'dv');
    $('#divisionList').innerHTML = list.length
      ? list.slice().reverse().map((d) => ui`<div class="panel">
          <h4><code>${esc(d.id)}</code> ${esc(d.title)} <span class="hint">${esc(d.type)} · 完成 ${d.done}/${d.of}</span></h4>
          <div class="wrap"><table><tr><th>份</th><th>任务</th><th>参与者</th><th>分到的输入</th><th>状态</th><th>写进正式区的记录</th></tr>
          ${d.parts.map((x) => `<tr><td>${x.part}/${d.of}</td><td><code>${esc(x.task)}</code></td><td>${esc(x.participant)}</td>
            <td>${x.inputs.map((i) => `<code>${esc(i.id)}</code>@${i.version}`).join(ui('、'))}${x.items.length ? `<div class="hint">${x.items.map(esc).join('<br>')}</div>` : ''}</td>
            <td>${badge(...(TASK_STATE[x.state] ?? [x.state, 'b-muted']))}<div class="hint">${esc(x.reason ?? '')}</div></td>
            <td>${x.records.map((r) => `<a href="#" data-goto="${esc(r.id)}"><code>${esc(r.id)}</code></a> v${r.version}`).join(ui('、')) || '<span class="hint">—</span>'}</td></tr>`).join('')}
          </table></div></div>`).join('')
      : ui('<p class="hint">还没有分工。</p>');
    for (const a of document.querySelectorAll('#divisionList [data-goto]')) a.onclick = (e) => {
      e.preventDefault();
      document.querySelector('#tabs [data-tab="records"]').click();
      setTimeout(() => showRecord(a.dataset.goto).catch(fail), 100);
    };
  },

  // ---------- 竞争 ----------
  async compete() {
    const [list, o] = await Promise.all([api('GET', P('/competitions')), api('GET', P()), loadPeople()]);
    const types = Object.entries(o.config.modes).filter(([, m]) => m === 'compete').map(([t]) => t);
    const sel = $('#kType');
    if (sel.options.length !== types.length) sel.innerHTML = types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    peopleBoxes($('#kPeople'), 'k');
    $('#kNeed').textContent = ui`选 ${o.config.compete.drafts} 位不同的起草者（compete.drafts）`;
    $('#competitionList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>竞争</th><th>题目</th><th>类型</th><th>进度</th><th>结果</th><th>更新</th></tr>
        ${list.slice().reverse().map((k) => `<tr class="click" data-k="${esc(k.id)}"><td><code>${esc(k.id)}</code></td><td>${esc(k.title)}</td><td>${esc(k.type)}</td>
          <td>${badge(...(K_STAGE[k.stage] ?? [k.stage, 'b-muted']))}</td>
          <td>${k.selection ? `${esc(k.selection.label)} → <code>${esc(k.selection.record.id)}</code>` : ''}${k.patches ? ui`<div class="hint">移植补丁 ${k.patches} 条</div>` : ''}</td>
          <td class="hint">${time(k.updated_at)}</td></tr>`).join('')}</table></div>`
      : ui('<p class="hint">还没有竞争。</p>');
    for (const tr of document.querySelectorAll('#competitionList tr.click')) tr.onclick = () => showCompetition(tr.dataset.k).catch(fail);
  },

  // ---------- 导出（WP7） ----------
  async export() {
    const [r] = await Promise.all([api('GET', P('/exports')), loadPeople()]);
    const fill = (sel, items, blank) => {
      const keep = sel.value;
      sel.innerHTML = (blank ? `<option value="">${esc(blank)}</option>` : '') + items.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    };
    fill($('#exVia'), [['script', ui('脚本生成')], ...people.map((p) => [p.id, ui`${p.name} 出版式方案`])]);
    fill($('#exTemplate'), r.templates.pptx.map((n) => [n, ui`模板：${n}`]));
    fill($('#exSkill'), r.templates.skills.map((n) => [n, ui`skill：${n}`]), ui('不用 skill'));
    $('#exportTasks').innerHTML = r.tasks.length
      ? ui`<h4>Agent 的版式方案</h4><ul>${r.tasks.map((t) => ui`<li><code>${esc(t.id)}</code> ${esc(t.assigned_to ?? '')} ${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))}${['failed', 'needs_user', 'open'].includes(t.state) && t.reason ? ` <span class="hint">${esc(t.reason)}</span>` : ''}${t.failure ? ui` <span class="hint">按方案生成失败：${esc(t.failure.message)}</span> <button type="button" data-exbuild="${esc(t.id)}">再生成一次</button>` : ''}</li>`).join('')}</ul>`
      : '';
    const check = (c, none) => (c == null ? badge(none, 'b-muted') : c.ok === true ? badge(ui('通过'), 'b-ok') : c.ok === false ? badge(ui`${c.errors} 个问题`, 'b-bad') : badge(ui('未检查完'), 'b-warn'));
    $('#exportList').innerHTML = r.exports.length
      ? ui`<div class="wrap"><table><tr><th>导出</th><th>时间</th><th>页数</th><th>格式</th><th>方式</th><th>结构检查</th><th>读回核对</th><th>渲染检查</th><th>逐页终审</th><th>状态</th></tr>
        ${r.exports.map((x) => `<tr class="click" data-ex="${esc(x.id)}"><td><code>${esc(x.id)}</code> <span class="hint">v${x.version}</span></td><td class="hint">${time(x.at)}</td><td>${x.pages}</td>
          <td>${esc(x.formats.join(' + '))}</td><td>${esc(x.via === 'script' ? ui('脚本') : x.via)}${x.template ? `<div class="hint">${esc(x.template)}${x.skill ? ` · ${esc(x.skill)}` : ''}</div>` : ''}</td>
          <td>${check(x.structure, '')}</td><td>${check(x.readback, ui('无 PPTX'))}</td><td>${check(x.render, x.formats.includes('pptx') ? ui('还没做') : ui('无 PPTX'))}</td>
          <td>${x.visual ? badge(ui`${x.visual.passed}/${x.visual.total} 页通过`, x.visual.ok ? 'b-ok' : x.visual.reviewed ? 'b-warn' : 'b-muted') : ''}</td>
          <td>${fresh(x)} ${x.live && !x.live.ok ? badge(ui('现在有问题'), 'b-bad') : ''} ${x.deliverable ? badge(ui('可交付'), 'b-ok') : ''}</td></tr>`).join('')}</table></div>`
      : ui('<p class="hint">还没有导出。</p>');
    for (const tr of document.querySelectorAll('#exportList tr.click')) tr.onclick = () => showExport(tr.dataset.ex).catch(fail);
    for (const b of document.querySelectorAll('[data-exbuild]')) b.onclick = () => api('POST', P(`/exports/tasks/${b.dataset.exbuild}/build`), {}).then((x) => toast(ui`已生成 ${x.id}`), fail).then(render);
    if (openExport && !$('#exportDetail').hidden) await showExport(openExport, { scroll: false });
  },

  // ---------- 试运行报告（WP7b） ----------
  async report() {
    const r = await api('GET', P('/report'));
    const ex = r.export;
    $('#reportView').innerHTML = ui`<h3>试运行报告</h3>
      <p class="hint">和单 Agent 基线（baseline.md）逐项对比。程序算得出来的直接算；修改时间和抽查发现的实质错误由你在下面填。</p>
      <p>${ex ? ui`成品：导出 <code>${esc(ex.id)}</code> 第 ${ex.version} 版，${ex.pages} 页` : ui('还没有导出')} ${ex ? (ex.deliverable ? badge(ui('可交付'), 'b-ok') : badge(ui('还不可交付'), 'b-warn')) : ''} · <a href="${P('/report.md')}">${esc(ui('下载 Markdown'))}</a></p>
      <div class="wrap"><table><tr><th>指标</th><th>单 Agent 基线</th><th>多 Agent 版</th><th>说明</th></tr>
      ${r.rows.map((x) => `<tr><td>${esc(ui(x.name))}</td><td>${esc(x.baseline ?? '—')}</td><td>${esc(x.multi ?? '—')}</td><td class="hint">${esc(x.note ?? '')}</td></tr>`).join('')}</table></div>
      ${r.trace.length ? ui`<h4>论断追溯</h4><p>${r.trace.map((t) => `<code>${esc(t.id)}@${t.version}</code> ${t.ok ? badge(ui('可追溯'), 'b-ok') : badge(ui('追溯不到有效证据'), 'b-bad')}`).join(' ')}</p>` : ''}
      ${r.notes.length ? `<ul class="hint">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
    const m = r.manual;
    if (!$('#reportManual').contains(document.activeElement)) {
      $('#rmMinutes').value = m.revision_minutes ?? '';
      $('#rmErrors').value = m.errors_found ?? '';
      $('#rmList').value = m.error_list ?? '';
      $('#rmNote').value = m.note ?? '';
    }
  },

  // ---------- 研讨：这个项目里开的议题 ----------
  async talk() {
    const list = await api('GET', `/api/threads?project=${encodeURIComponent(project)}`);
    $('#threadList').innerHTML = list.length
      ? ui`<div class="wrap"><table><tr><th>议题</th><th>引出它的记录</th><th>发言</th><th>最近</th><th></th></tr>
        ${list.map((t) => ui`<tr><td>${esc(t.title)}</td><td>${t.ref ? `<code>${esc(t.ref)}</code>` : ''}</td><td>${t.postCount}</td><td class="hint">${time(t.lastAt)}</td>
          <td><a href="/talk#/t/${t.id}">在研讨室打开 →</a></td></tr>`).join('')}</table></div>`
      : ui('<p class="hint">这个项目里还没有研讨。</p>');
  },
};

$('#kindFilter').onchange = () => VIEWS.records();

// 待你决定的表格：“待你决定”页和首页共用
const INBOX_LABEL = localized({
  write_fault: '写入故障：已停止接受写入，请重启服务完成恢复', external_change: '服务进程之外改过的记录文件', bad_record_file: '读不出来的记录文件', archive_failed: 'git 留档失败',
  task_failed: '任务失败（尝试次数用完，不再自动重派）', task_needs_user: '任务待你决定', budget_exceeded: '项目用量已到上限',
  objection_needs_user: '异议待你裁决', claim_disputed: '论断的核验结论不一致', competition: '竞争需要你处理',
  stagnation: '连续停滞，交给你决定', scheduler_budget: '自动调度到了用量上限', phase_switch: '阶段切换没完成',
});
function inboxTable(items) {
  const where = (i) => (i.competition ? `<a href="#" data-k="${esc(i.competition)}"><code>${esc(i.competition)}</code></a>`
    : i.objection || i.claim ? `<a href="#" data-goto="${esc(i.objection ?? i.claim)}"><code>${esc(i.objection ?? i.claim)}</code></a>` : `<code>${esc(i.path ?? i.cid ?? i.task ?? '')}</code>`);
  return ui`<div class="wrap"><table><tr><th>类型</th><th>位置</th><th>说明</th></tr>
    ${items.map((i) => `<tr><td>${esc(INBOX_LABEL[i.type] ?? i.type)}</td><td>${where(i)}</td>
      <td class="hint">${esc(i.reason ?? i.error ?? i.resolution ?? (i.type === 'claim_disputed' ? ui`计入的核验：${i.counted.join(ui('、'))}` : i.actual ? ui('内容与最后一次提交不一致') : i.expected ? ui('文件被删除') : i.type?.startsWith('task_') || i.type?.startsWith('objection') ? '' : ui('没有对应的提交记录')))}</td></tr>`).join('')}</table></div>`;
}
function bindInbox(root) {
  for (const a of root.querySelectorAll('[data-goto]')) a.onclick = (e) => {
    e.preventDefault();
    document.querySelector('#tabs [data-tab="records"]').click();
    setTimeout(() => showRecord(a.dataset.goto).catch(fail), 100);
  };
  for (const a of root.querySelectorAll('[data-k]')) a.onclick = (e) => {
    e.preventDefault();
    document.querySelector('#tabs [data-tab="compete"]').click();
    setTimeout(() => showCompetition(a.dataset.k).catch(fail), 100);
  };
}

// 重画详情（切换语言、实时刷新）时保留没提交的输入和展开着的折叠块：先记下，重画后填回。
// 折叠块按出现顺序对应（切换语言后标题文字会变）；输入按 id、补丁理由框的编号或勾选框的 name＋value 对应。
// 提交成功后的重画不保留（keep 为假），免得把刚提交过的内容又填回去
function keepState(box) {
  const keyOf = (el) => (el.id ? `#${el.id}` : el.dataset.pReason ? `p:${el.dataset.pReason}` : el.name ? `${el.name}=${el.value}` : null);
  const opened = [...box.querySelectorAll('details')].map((d) => d.open);
  const values = new Map();
  for (const el of box.querySelectorAll('input, textarea, select')) {
    const k = keyOf(el);
    if (k) values.set(k, el.type === 'checkbox' ? el.checked : el.value);
  }
  return () => {
    box.querySelectorAll('details').forEach((d, i) => opened[i] && (d.open = true));
    for (const el of box.querySelectorAll('input, textarea, select')) {
      const k = keyOf(el);
      if (!k || !values.has(k)) continue;
      if (el.type === 'checkbox') el.checked = values.get(k);
      else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === values.get(k))) {
        el.value = values.get(k);
        el.onchange?.(); // 例如换了来源方案，节的选项跟着换
      }
    }
  };
}

let openRecord = null; // 记录标签页里打开着的详情：实时事件到来时一起刷新
async function showRecord(id, { scroll = true, keep = false } = {}) {
  openRecord = id;
  const r = await api('GET', P(`/records/${id}`));
  const s = r.status;
  const link = (x) => `<a href="#" data-goto="${x}"><code>${x}</code></a>`;
  const box = $('#recordDetail');
  const restore = keep && openRecord === box.dataset.id ? keepState(box) : null;
  box.dataset.id = id;
  box.hidden = false;
  const stale = (x) => (x.type === 'version' ? ui`${x.id} 已从 v${x.based} 更新到 v${x.current}` : x.type === 'upstream' ? ui`上游 ${x.id} 待更新` : x.type === 'missing' ? ui`${x.id} 不存在`
    : x.type === 'external' ? (x.change === 'deleted' ? ui('正式文件在服务之外被删除，这里显示的是已提交的内容') : ui('正式文件在服务之外被改动，这里显示的是已提交的内容')) : ui('循环引用'));
  box.innerHTML = ui`
    <h3><code>${id}</code> · ${KIND[r.kind]} · v${r.record.version}</h3>
    <div>${fresh(s)} ${verif(s)} ${blocks(s)} ${ready(s)}</div>
    ${s.stale_reasons.length ? ui`<p class="hint">待更新原因：${s.stale_reasons.map(stale).join(ui('；'))}</p>` : ''}
    <p>上游：${s.based_on.map((b) => `${link(b.id)} v${b.version}`).join(ui('、')) || ui('无')}　下游：${s.downstream.map(link).join(ui('、')) || ui('无')}</p>
    ${r.kind === 'claim' ? claimPanel(r, link) : ''}
    ${r.kind === 'objection' ? objectionPanel(r.record) : ''}
    ${r.kind === 'verification' ? ui`<p>核验者：${esc(who(r.record.verifier))} · 结论：${badge(...VER[r.record.verdict])}</p><p>${esc(r.record.reason)}</p>${r.record.support_quote ? ui`<div class="quote">${esc(r.record.support_quote.id)}@${r.record.support_quote.version}：${esc(r.record.support_quote.quote)}</div>` : ''}` : ''}
    ${r.kind !== 'claim' && r.objections.length ? ui`<p>异议：${r.objections.map(link).join(ui('、'))}</p>` : ''}
    ${r.kind !== 'claim' && r.kind !== 'objection' ? objectionForm(r) : ''}
    <p><button data-trace="${id}">追溯</button> <button data-talk="${id}">开研讨</button></p>
    <pre>${esc(JSON.stringify(r.record, null, 2))}</pre>
    <h4>历史版本</h4>
    <ul>${r.history.map((h) => ui`<li>v${h.version} · 提交 ${esc(h.commit ?? '-')} · ${time(h.updated_at)} · ${esc(h.provenance?.participant ?? h.provenance?.kind ?? '')}</li>`).join('')}</ul>`;
  bindLinks(box);
  bindContract1(box, r);
  box.querySelector('[data-talk]').onclick = () => startTalk(r);
  restore?.();
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 契约一：论断的核验面板、异议面板与表单 ----------

function claimPanel(r, link) {
  const v = r.status.verification;
  const c = r.record;
  const sources = (c.sources || []).map((x) => `<option value="${esc(x.id)}@${x.version}">${esc(x.id)} v${x.version}</option>`).join('');
  return ui`<div class="panel">
    <h4>核验 ${c.core ? badge(ui('核心结论'), 'b-warn') : ''}</h4>
    <p>结论：${verif(r.status)} · 独立核验者 ${v.independent} / 需要 ${v.required}${v.enough ? '' : ui('（还不够，不能进入成品）')}</p>
    <p>计入：${v.counted.map(link).join(ui('、')) || ui('无')}</p>
    ${v.uncounted.length ? ui`<p class="hint">不计入：${v.uncounted.map((u) => ui`${link(u.id)}（${esc(UNCOUNTED[u.reason] ?? u.reason)}）`).join(ui('；'))}</p>` : ''}
    ${r.verifications.length > v.counted.length + v.uncounted.length ? ui`<p class="hint">绑定旧版本、已不计入的核验：${r.verifications.filter((x) => !v.counted.includes(x) && !v.uncounted.some((u) => u.id === x)).map(link).join(ui('、'))}</p>` : ''}
    <p class="hint">作者：${esc(who(c.provenance))}。核验者必须与作者分属不同厂商；同一核验者只算最新一份。</p>
    <p><select id="c1Who"><option value="">自动挑选（凑够还差的份数）</option>${people.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
      <button class="primary" data-verify="${c.id}">派对抗核验</button></p>
    <details><summary>我来核验</summary>
      <p><select id="c1Verdict"><option value="supported">支持</option><option value="unsupported">不支持（含证据不足）</option></select></p>
      <p><textarea id="c1Reason" rows="2" placeholder="理由"></textarea></p>
      <p>支持引文（判支持时必填）：<select id="c1Src">${sources}</select> <input id="c1Quote" placeholder="来源正文里逐字出现的一段" size="50"></p>
      <p><button data-myverify="${c.id}@${c.version}">提交核验</button></p>
    </details>
    <h4>异议 ${r.status.blockers.length ? badge(ui`阻塞 ${r.status.blockers.length}`, 'b-bad') : ''}</h4>
    <p>${r.objections.map(link).join(ui('、')) || ui('无')}</p>
    ${objectionForm(r)}
  </div>`;
}

function objectionForm(r) {
  const c = r.record;
  const sources = (r.kind === 'claim' ? c.sources || [] : r.kind === 'source' ? [{ id: c.id, version: c.version }] : []).map((x) => `<option value="${esc(x.id)}@${x.version}">${esc(x.id)} v${x.version}</option>`).join('');
  return ui`<details><summary>提出异议</summary>
    <p><select id="oCat">${Object.entries(O_CATEGORY).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <select id="oState"><option value="open">指针有效（open）</option><option value="needs_evidence">定位不到原文（needs_evidence）</option></select></p>
    <p>指针：<select id="oPtr"><option value="quote">来源原文</option><option value="missing_source">论断没有来源</option><option value="location">只写位置</option></select>
      <select id="oSrc">${sources}</select> <input id="oText" placeholder="原文（逐字）或位置描述" size="40"></p>
    <p><textarea id="oReason" rows="2" placeholder="问题在哪里（不需要给出修改方法）"></textarea></p>
    <p><button data-object="${c.id}@${c.version}">提出异议</button></p>
  </details>`;
}

function objectionPanel(o) {
  const ptr = o.pointer.type === 'quote' ? ui`${o.pointer.source.id}@${o.pointer.source.version}：${o.pointer.quote}` : o.pointer.type === 'location' ? ui`位置：${o.pointer.locator}` : o.pointer.type === 'gone' ? ui`来源 ${o.pointer.source.id} 已确认不存在` : o.pointer.type === 'fetch_failure' ? ui`来源 ${o.pointer.source.id} 的失败抓取 ${o.pointer.attempt}` : ui('论断没有来源');
  const next = O_NEXT[o.state] ?? [];
  const target = `<a href="#" data-goto="${o.target.id}"><code>${o.target.id}</code></a>`;
  return ui`<div class="panel">
    <p>${badge(...O_STATE[o.state])} ${esc(O_CATEGORY[o.category])} · 针对 ${target} v${o.target.version}</p>
    <p>提出者：${esc(who(o.raised_by))}</p>
    <div class="quote">${esc(ptr)}</div>
    <p>${esc(o.reason)}</p>
    ${o.resolution ? ui`<p class="hint">处理说明：${esc(o.resolution)}</p>` : ''}
    ${next.length ? ui`<p><select id="oNext">${next.map((x) => `<option value="${x}">${esc(O_STATE[x][0])}</option>`).join('')}</select>
      <input id="oResolution" placeholder="理由（成立、不成立、待你决定、已解决都要写）" size="40">
      <button class="primary" data-resolve="${o.id}">改变状态</button></p>
      <p class="hint">裁定成立或不成立：主持人可以作为核验者裁定（不能是提出者或作者）；待你决定的只有主持人能裁决；已解决要求目标已改版并重新核验通过。</p>` : ''}
  </div>`;
}

function bindContract1(box, r) {
  const done = (msg) => (x) => {
    toast(msg(x));
    showRecord(r.record.id).catch(fail);
  };
  const ref = (s) => {
    const [id, v] = s.split('@');
    return { id, version: Number(v) };
  };
  for (const b of box.querySelectorAll('[data-verify]')) b.onclick = () => {
    const pid = $('#c1Who').value;
    api('POST', P(`/claims/${b.dataset.verify}/verify`), pid ? { participants: [pid] } : {})
      .then(done((x) => ui`已派发：${x.dispatched.map((d) => ui`${d.task.id}（${d.task.assigned_to}）`).join(ui('、'))}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-myverify]')) b.onclick = () => {
    const verdict = $('#c1Verdict').value;
    const body = { target: ref(b.dataset.myverify), verdict, reason: $('#c1Reason').value };
    if (verdict === 'supported') body.support_quote = { ...ref($('#c1Src').value), quote: $('#c1Quote').value };
    api('POST', P('/verifications'), body).then(done((x) => ui`已写入核验 ${x.result.records[0].id}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-object]')) b.onclick = () => {
    const type = $('#oPtr').value;
    const text = $('#oText').value;
    const pointer = type === 'quote' ? { type, source: ref($('#oSrc').value), quote: text } : type === 'location' ? { type, locator: text } : { type };
    api('POST', P('/objections'), { target: ref(b.dataset.object), category: $('#oCat').value, state: $('#oState').value, pointer, reason: $('#oReason').value })
      .then(done((x) => ui`已提出异议 ${x.result.records[0].id}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-resolve]')) b.onclick = () => {
    const resolution = $('#oResolution').value.trim();
    api('POST', P(`/objections/${b.dataset.resolve}/resolve`), { state: $('#oNext').value, ...(resolution ? { resolution } : {}) })
      .then(done(() => ui`异议 ${b.dataset.resolve} 已更新`)).catch(fail);
  };
}

function bindLinks(root) {
  for (const a of root.querySelectorAll('[data-goto]')) a.onclick = (e) => (e.preventDefault(), showRecord(a.dataset.goto));
  for (const b of root.querySelectorAll('[data-trace]')) b.onclick = () => {
    $('#traceId').value = b.dataset.trace;
    document.querySelector('#tabs [data-tab="trace"]').click();
  };
}

// ---------- 追溯 ----------

$('#traceForm').onsubmit = (e) => {
  e.preventDefault();
  showTrace($('#traceId').value.trim()).catch(fail);
};

const verTag = (n) => (n.current_version != null && n.current_version !== n.version ? badge(ui`引用 v${n.version}，当前 v${n.current_version}`, 'b-warn') : `<span class="hint">v${n.version}</span>`);

function sourceHtml(s) {
  let q = '';
  if (s.quote) {
    q = s.quote_found === true
      ? `<div class="quote">…${esc(s.context.before)}<mark>${esc(s.quote)}</mark>${esc(s.context.after)}…</div>`
      : s.quote_found === false
        ? `<div class="quote">${badge(ui('引文不在正文快照里'), 'b-bad')} ${esc(s.quote)}</div>`
        : `<div class="quote">${badge(ui('没有正文快照，无法核对'), 'b-muted')} ${esc(s.quote)}</div>`;
  }
  return `<div class="node"><div class="head"><code>${s.id}</code> ${verTag(s)} <b>${esc(s.title)}</b>
    ${s.availability === 'gone' ? badge(ui('来源已不存在'), 'b-bad') : s.availability === 'temporarily_unavailable' ? badge(ui('暂不可获取（快照仍可用）'), 'b-warn') : ''}</div>
    <div class="hint">${esc(s.citation ?? '')} ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a>` : ''} ${s.locator ? ui`· 位置：${esc(s.locator)}` : ''}</div>${q}</div>`;
}

function claimHtml(c) {
  return ui`<div class="node"><div class="head"><code>${c.id}</code> ${verTag(c)} ${c.status ? `${fresh(c.status)} ${verif(c.status)} ${blocks(c.status)} ${ready(c.status)}` : badge(ui('不存在'), 'b-bad')}</div>
    <div>${esc(c.text)} <span class="hint">（${esc(c.type)}）</span></div>
    <ul class="tree">${c.sources.map((s) => `<li>${sourceHtml(s)}</li>`).join('') || ui('<li class="hint">没有关联来源</li>')}</ul></div>`;
}

async function showTrace(id) {
  if (!id) return;
  const t = await api('GET', P(`/trace/${id}`));
  const out = $('#traceOut');
  if (t.kind === 'claim') out.innerHTML = claimHtml(t.root) + (t.downstream.length ? ui`<p class="hint">被引用：${t.downstream.join(ui('、'))}</p>` : '');
  else if (t.kind === 'source') out.innerHTML = sourceHtml(t.root) + ui`<p>下游：${t.downstream.map((d) => `<code>${d.id}</code>${d.downstream.length ? ` → ${d.downstream.map((x) => `<code>${x}</code>`).join(ui('、'))}` : ''}`).join(ui('；')) || ui('无')}</p>`;
  else if (t.root.claims) {
    out.innerHTML = `<div class="node"><div class="head"><code>${t.root.id}</code> <span class="hint">v${t.root.version}</span> <b>${esc(t.root.title)}</b> ${fresh(t.root.status)} ${ready(t.root.status)}</div>
      <ul class="tree">${t.root.claims.map((c) => `<li>${claimHtml(c)}</li>`).join('') || ui('<li class="hint">这一页没有引用论断</li>')}</ul></div>`;
  } else out.innerHTML = `<pre>${esc(JSON.stringify(t, null, 2))}</pre>`;
}

// ---------- 候选稿 ----------

// 示例是界面给的模板，按当前语言生成；填进文本框之后就是用户的内容，切换语言不再改它
const EXAMPLES = {
  source: () => JSON.stringify([{ kind: 'source', expected_version: 0, data: { title: ui('来源标题'), author: ui('作者'), citation: ui('书名，出版社，年份，页码'), text: ui('来源正文快照（引文必须能在这里找到）') } }], null, 2),
  chain: () => JSON.stringify([
    { kind: 'source', expected_version: 0, tmp: '$s1', data: { title: ui('来源标题'), url: 'https://example.org', text: ui('……原文正文……') } },
    { kind: 'claim', expected_version: 0, tmp: '$c1', data: { type: 'fact', text: ui('论断正文'), sources: [{ id: '$s1', locator: ui('第 2 段'), quote: ui('原文正文') }] } },
    { kind: 'slide', expected_version: 0, data: { title: ui('第 1 页'), body: ui('页面正文'), notes: ui('讲者备注'), claims: [{ id: '$c1' }] } },
  ], null, 2),
};
for (const b of document.querySelectorAll('[data-example]')) b.onclick = () => ($('#changes').value = EXAMPLES[b.dataset.example]());

$('#submit').onclick = async () => {
  let changes;
  try {
    changes = JSON.parse($('#changes').value);
  } catch (e) {
    return toast(ui`JSON 格式错误：${e.message}`, true);
  }
  try {
    const r = await api('POST', P('/submissions'), { request_id: `web-${crypto.randomUUID()}`, changes });
    $('#submitOut').textContent = ui`已存为候选稿 ${r.sid}`;
    await VIEWS.candidates();
  } catch (e) {
    fail(e);
  }
};

async function promote(sid) {
  try {
    const r = await api('POST', P(`/submissions/${encodeURIComponent(sid)}/promote`), {});
    toast(ui`已晋升：提交 ${r.cid}，${r.records.map((x) => `${x.id} v${x.version}`).join(ui('、'))}`);
  } catch (e) {
    fail(e);
  }
  render();
}

// ---------- 实时更新 ----------

const events = new EventSource('/api/events');
let pending = null;
events.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (!String(ev.type).startsWith('wb-')) return;
  if (ev.type === 'wb-project') return loadProjects(project);
  if (ev.project && ev.project !== project && ev.type !== 'wb-archive') return;
  clearTimeout(pending);
  pending = setTimeout(() => render({ quiet: true }), 200); // 一次提交会连发好几个事件，合并成一次刷新
};

let openPacket = null; // 任务标签页里打开着的任务包：切换语言时重画
async function showPacket(id, { scroll = true } = {}) {
  openPacket = id;
  const r = await api('GET', P(`/tasks/${id}/packet`));
  const box = $('#taskDetail');
  box.hidden = false;
  box.innerHTML = ui`<h3>任务包 <code>${esc(r.packet.id)}</code> · ${esc(VIS[r.packet.visibility] ?? r.packet.visibility)}</h3>
    <p class="hint">${r.packets.length} 次尝试：${r.packets.map(esc).join(ui('、'))}。下面是这次实际发送的提示词；每项输入都按内容 hash 存档，可以完整还原。</p>
    <pre>${esc(r.prompt ?? ui('（外部会话认领，提示词即任务包）'))}</pre>
    <details><summary>输入（${r.inputs.length} 项）</summary>${r.inputs.map((i) => ui`<p><b>${esc(i.name)}</b> <span class="hint">${esc(i.ref ?? '')} ${esc(i.note ?? '')} · ${i.chars} 字 · blob ${esc(i.blob.slice(0, 12))}…</span></p>`).join('')}</details>`;
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#newTask').onsubmit = async (e) => {
  e.preventDefault();
  const inputs = parseRefs($('#taskInputs').value);
  try {
    const t = await api('POST', P('/tasks'), { type: $('#taskType').value, title: $('#taskTitle').value, goal: $('#taskGoal').value, inputs });
    toast(ui`已新建任务 ${t.id}（${TASK_STATE[t.state]?.[0] ?? t.state}）`);
    $('#taskTitle').value = $('#taskGoal').value = $('#taskInputs').value = '';
  } catch (err) {
    fail(err);
  }
  VIEWS.tasks();
};

// ---------- 参与者、输入 ----------

async function loadPeople() {
  people = (await api('GET', '/api/state')).participants.filter((x) => x.available);
}
// 参与者勾选框（重画时保留已勾选的）
function peopleBoxes(box, name) {
  const was = new Set([...box.querySelectorAll('input:checked')].map((x) => x.value));
  box.innerHTML = ui`<span class="hint">参与者：</span><span class="people">${people.map((p) => `<label><input type="checkbox" name="${name}" value="${esc(p.id)}" ${was.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || ui('<span class="hint">没有可用的参与者</span>')}</span>`;
}
const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
const parseRefs = (text) => text.split(/[,，\s]+/).filter(Boolean).map((x) => {
  const [id, v] = x.split('@');
  return { id, version: Number(v) };
});

// ---------- 分工 ----------

$('#newDivision').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const items = $('#dvItems').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const r = await api('POST', P('/divide'), { type: $('#dvType').value, title: $('#dvTitle').value, goal: $('#dvGoal').value, inputs: parseRefs($('#dvInputs').value), items, participants: checked('dv') });
    const bad = r.dispatched.filter((x) => !x.dispatched);
    toast(ui`已发起分工 ${r.id}：${r.parts.length} 份${bad.length ? ui`；没派发出去：${bad.map((x) => ui`${x.task}（${x.error}）`).join(ui('；'))}` : ''}`, bad.length > 0);
    $('#dvTitle').value = $('#dvGoal').value = $('#dvInputs').value = $('#dvItems').value = '';
  } catch (err) {
    fail(err);
  }
  VIEWS.divide();
};

// ---------- 竞争 ----------

const K_STAGE = localizedBadges({
  drafting: ['密封起草中', 'b-warn'], insufficient: ['有效方案不足两份', 'b-bad'], review_ready: ['待发起匿名评审', 'b-warn'], reviewing: ['匿名评审中', 'b-warn'],
  selecting: ['待你选定', 'b-bad'], patching: ['移植补丁', 'b-warn'], closed: ['已结束', 'b-ok'], cancelled: ['已取消', 'b-muted'],
});
const K_STEPS = [['drafting', '密封起草'], ['review_ready', '揭晓'], ['reviewing', '匿名评审'], ['selecting', '选定'], ['patching', '移植补丁'], ['closed', '结束']]; // 文字在渲染时翻译
const POS = localized({ before: '插到这一节之前', after: '插到这一节之后', start: '放进这一节开头', end: '放进这一节末尾', replace: '整节替换' });
const P_STATE = localizedBadges({ proposed: ['待决定', 'b-warn'], accepted: ['已接受', 'b-ok'], rejected: ['已拒绝', 'b-muted'] });
const H_ACTION = localized({
  create: '发起竞争', review: '发起匿名评审', select: '选定方案', patch_proposed: '提出补丁', patch_accepted: '接受补丁', patch_rejected: '拒绝补丁',
  apply: '书记应用补丁', close: '结束竞争', cancel: '取消竞争', dispatch_failed: '派发失败',
});
const secOptions = (k, label) => (k.sections[label] ?? []).map((x) => ui`<option value="${x.n}">第 ${x.n} 节${x.title ? ui`：${esc(x.title)}` : ''}</option>`).join('');

$('#newCompetition').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', P('/compete'), { type: $('#kType').value, title: $('#kTitle').value, goal: $('#kGoal').value, inputs: parseRefs($('#kInputs').value), participants: checked('k') });
    const bad = r.dispatched.filter((x) => !x.dispatched);
    toast(ui`已发起竞争 ${r.id}${bad.length ? ui`；没派发出去：${bad.map((x) => ui`${x.task}（${x.error}）`).join(ui('；'))}` : ui('，方案正在密封起草')}`, bad.length > 0);
    $('#kTitle').value = $('#kGoal').value = $('#kInputs').value = '';
    await VIEWS.compete();
    await showCompetition(r.id);
  } catch (err) {
    fail(err);
  }
};

// ---------- 导出详情（WP7） ----------

const ISSUE_LEVEL = localizedBadges({ error: ['问题', 'b-bad'], warn: ['提示', 'b-warn'] });
const issueList = (issues) => (issues.length ? `<ul>${issues.map((i) => `<li>${badge(...ISSUE_LEVEL[i.level])} ${esc(i.message)}</li>`).join('')}</ul>` : '');
let openExport = null;
const R_VERDICT = localizedBadges({ pass: ['通过', 'b-ok'], fail: ['不通过', 'b-bad'] });
const R_KIND = localized({ overflow: '溢出', overlap: '重叠', font: '字体', chart: '图表', image: '图片', readability: '看不清', other: '其他' });
// 逐页的视觉检查：派一位能看图的参与者初查（模型），你逐页终审；每页都终审通过才可交付
function visualPanel(v, rd) {
  if (!v.visual_pages) return '';
  const seers = people.filter((p) => p.seesImages);
  const tasks = v.review_tasks.filter((t) => t.version === v.record.version);
  return ui`<h4>逐页视觉检查</h4>
    <p class="hint">模型看截图初查（不给工具，只看版面），你逐页终审；每页都终审通过、其他检查也通过，才可交付。重新渲染后要重新审。</p>
    <p>${badge(ui`你终审通过 ${v.visual.passed}/${v.visual.total} 页`, v.visual.ok ? 'b-ok' : 'b-warn')} <span class="hint">${esc(ui`模型初查了 ${v.visual.initial} 页`)}</span></p>
    ${rd.pages.every((p) => p.image) ? ui`<div class="tools"><select id="exReviewer">${seers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select> <button type="button" id="exReview" ${seers.length && v.freshness === 'current' ? '' : 'disabled'}>派它做视觉初查</button> <span class="hint">${seers.length ? ui('会调用一次模型（每次最多 8 页）') : ui('没有能看图的参与者')}</span></div>` : ui('<p class="hint">这次渲染没有页面截图（没有用 PowerPoint），做不了视觉检查。</p>')}
    ${tasks.length ? `<ul>${tasks.map((t) => `<li><code>${esc(t.id)}</code> ${esc(t.assigned_to ?? '')} ${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))} <span class="hint">${esc(ui`第 ${t.pages.join(ui('、'))} 页`)}${['failed', 'open', 'needs_user'].includes(t.state) && t.reason ? ` · ${esc(t.reason)}` : ''}</span></li>`).join('')}</ul>` : ''}`;
}
// 终审按钮上记下这一页显示的是哪一版导出、哪次渲染、哪张截图
const seen = (p, v) => `data-reviews="${esc(p.initial?.id ?? '')}" data-version="${v.record.version}" data-render="${esc(v.record.render.dir)}" data-image="${esc(p.image ?? '')}"`;
function pageReview(p, v) {
  const one = (c) => `${badge(...R_VERDICT[c.verdict])} <span class="hint">${esc(c.by ?? '')}</span>${c.issues.length ? `<ul>${c.issues.map((i) => `<li>${esc(R_KIND[i.kind] ?? i.kind)}：${esc(i.note)}</li>`).join('')}</ul>` : ''}${c.note ? `<div class="hint">${esc(c.note)}</div>` : ''}`;
  return ui`<div class="review">
    <div><b>模型初查</b> ${p.initial ? one(p.initial) : ui('<span class="hint">还没有</span>')}</div>
    <div><b>你的终审</b> ${p.final ? one(p.final) : ui('<span class="hint">还没有</span>')}</div>
    ${v.freshness === 'current' ? ui`<div class="tools"><input data-note="${p.page}" placeholder="终审说明（不通过时必填）" size="18"> <button type="button" data-final="pass" data-page="${p.page}" ${seen(p, v)}>通过</button> <button type="button" data-final="fail" data-page="${p.page}" ${seen(p, v)}>不通过</button></div>` : ''}
  </div>`;
}
async function showExport(id, { scroll = true } = {}) {
  openExport = id;
  const v = await api('GET', P(`/exports/${id}`));
  const rec = v.record;
  const box = $('#exportDetail');
  box.hidden = false;
  const file = (name) => P(`/exports/${id}/files/${name}`);
  const s = rec.structure;
  const rb = rec.readback;
  const rd = rec.render;
  box.innerHTML = ui`<h3>导出 <code>${esc(id)}</code> 第 ${rec.version} 版 ${fresh(v)} ${v.deliverable ? badge(ui('可交付'), 'b-ok') : ''}</h3>
    <p class="hint">${rec.slides.map((x) => `<code>${esc(x.id)}@${x.version}</code>`).join(' ')}${rec.template ? ui` · 模板 ${esc(rec.template.name)}` : ''}${rec.skill ? ui` · skill ${esc(rec.skill.name)}` : ''}${rec.plan_task ? ui` · 版式方案来自任务 <code>${esc(rec.plan_task.task)}</code>` : ''}</p>
    <p>${Object.keys(rec.files).map((f) => `<a href="${file(`deck.${f}`)}">${esc(ui`下载 ${f.toUpperCase()}`)}</a>`).join(' · ')}${rd?.pdf ? ` · <a href="${file(`${rd.dir}/${rd.pdf}`)}" target="_blank">PDF</a>` : ''}</p>
    ${v.live_structure && !v.live_structure.ok ? ui`<h4>现在的状态</h4><p class="hint">导出之后，论断的核验或异议有了变化（版本没变）。下面是此刻再查一遍的结果；问题解决之前，这份导出不可交付。</p>
      ${v.live_structure.slides.filter((x) => x.issues.some((i) => i.level === 'error')).map((x) => ui`<p><code>${esc(x.id)}</code> ${esc(x.title)}</p>${issueList(x.issues.filter((i) => i.level === 'error'))}`).join('')}` : ''}
    <h4>结构检查</h4><p class="hint">${esc(ui('导出时的结果'))}</p>
    ${s.ok ? ui('<p class="hint">通过：每个句子都带论断编号或标为非事实，引用的论断都可进入成品，字数与备注都合要求。</p>') : ''}
    ${s.slides.filter((x) => x.issues.length).map((x) => ui`<p><code>${esc(x.id)}</code> ${esc(x.title)} <span class="hint">${x.chars} 字</span></p>${issueList(x.issues)}`).join('')}
    ${rb ? ui`<h4>读回核对</h4>${rb.ok ? ui('<p class="hint">通过：页数、标题、正文、备注与每页的标记都对得上。</p>') : issueList(rb.issues)}` : ''}
    ${rec.files.pptx ? ui`<h4>渲染检查</h4>
      <p><button type="button" id="exRender" ${v.freshness !== 'current' ? 'disabled' : ''}>${rd ? ui('重新做渲染检查') : ui('做渲染检查')}</button>
      <span class="hint">用本机 PowerPoint 在后台把 PPTX 转成 PDF 和逐页图片，程序查文字溢出与重叠、字体缺失、图片变形；图表标签要看图确认。逐页的视觉检查在下一步（WP7b）。</span></p>
      ${rd ? ui`<p class="hint">${esc(rd.engine === 'powerpoint' ? `PowerPoint ${rd.powerpoint ?? ''}` : ui('没有 PowerPoint，只查了字体、图片和图表'))} · ${time(rd.at)} · 用到的字体：${esc(rd.fonts.used.join(ui('、')) || '—')}${rd.fonts.missing.length ? ui` · <b>本机没有：${esc(rd.fonts.missing.join(ui('、')))}</b>` : ''}</p>
        ${issueList(rd.issues)}
        ${visualPanel(v, rd)}
        <div class="pages">${(v.visual_pages ?? rd.pages).map((p) => `<figure>${p.png ? `<a href="${file(`${rd.dir}/${p.png}`)}" target="_blank"><img src="${file(`${rd.dir}/${p.png}`)}" alt="p${p.page}" loading="lazy"></a>` : ''}
          <figcaption>${esc(ui`第 ${p.page} 页`)} ${p.slide ? `<code>${esc(p.slide)}</code>` : ''} ${p.issues.length ? '' : badge(ui('程序检查通过'), 'b-ok')}</figcaption>${issueList(p.issues)}
          ${v.visual_pages ? pageReview(p, v) : ''}</figure>`).join('')}</div>` : ''}` : ''}`;
  for (const b of box.querySelectorAll('[data-final]')) b.onclick = async () => {
    const page = Number(b.dataset.page);
    const note = box.querySelector(`[data-note="${page}"]`).value.trim();
    if (b.dataset.final === 'fail' && !note) return toast(ui('判为不通过时，写一句问题在哪里'), true);
    try {
      // 带上这一页显示的导出版本、渲染与截图：期间重新渲染过，服务端会拒绝，刷新后再审
      await api('POST', P(`/exports/${id}/pages/${page}/review`), { version: Number(b.dataset.version), render: b.dataset.render, image: b.dataset.image || null, verdict: b.dataset.final, ...(note ? { note } : {}), ...(b.dataset.reviews ? { reviews: b.dataset.reviews } : {}) });
      await showExport(id, { scroll: false });
    } catch (err) {
      fail(err);
      await showExport(id, { scroll: false }); // 期间重新渲染过：换成最新的截图
    }
  };
  const ask = box.querySelector('#exReview');
  if (ask) ask.onclick = async () => {
    try {
      const r = await api('POST', P(`/exports/${id}/review-request`), { participant: box.querySelector('#exReviewer').value });
      toast(ui`已派视觉初查：${r.tasks.map((t) => t.id).join(ui('、'))}`);
      await showExport(id, { scroll: false });
    } catch (err) {
      fail(err);
    }
  };
  const rbtn = $('#exRender');
  if (rbtn) rbtn.onclick = async () => {
    rbtn.disabled = true;
    rbtn.textContent = ui('渲染检查中……');
    try {
      const r = await api('POST', P(`/exports/${id}/render`), {});
      toast(r.render.ok ? ui('渲染检查通过') : r.render.ok === false ? ui`渲染检查查出 ${r.render.errors} 个问题` : ui('只查了字体、图片和图表（没有 PowerPoint）'));
      await showExport(id, { scroll: false });
    } catch (err) {
      fail(err);
      rbtn.disabled = false;
    }
  };
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#reportManual').onsubmit = async (e) => {
  e.preventDefault();
  const n = (sel) => ($(sel).value === '' ? null : Number($(sel).value));
  try {
    await api('POST', P('/report/manual'), { revision_minutes: n('#rmMinutes'), errors_found: n('#rmErrors'), error_list: $('#rmList').value, note: $('#rmNote').value });
    toast(ui('已保存'));
    await VIEWS.report();
  } catch (err) {
    fail(err);
  }
};

$('#newExport').onsubmit = async (e) => {
  e.preventDefault();
  const formats = [['md', '#exMd'], ['pptx', '#exPptx']].filter(([, sel]) => $(sel).checked).map(([f]) => f);
  const btn = e.target.querySelector('button.primary');
  btn.disabled = true;
  try {
    const r = await api('POST', P('/export'), { formats, via: $('#exVia').value, template: $('#exTemplate').value || null, skill: $('#exSkill').value || null });
    if (r.export) {
      toast(ui`已导出 ${r.export.id}`);
      await VIEWS.export();
      await showExport(r.export.id);
    } else {
      toast(r.dispatch_error ? ui`已建导出任务 ${r.task.id}，派发失败：${r.dispatch_error}` : ui`已派给 ${r.task.assigned_to} 出版式方案（任务 ${r.task.id}），交来后自动生成`);
      await VIEWS.export();
    }
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
};

let openCompetition = null; // 竞争标签页里打开着的详情：实时事件到来时一起刷新
async function showCompetition(id, { scroll = true, keep = false } = {}) {
  openCompetition = id;
  const k = await api('GET', P(`/competitions/${id}`));
  const box = $('#competitionDetail');
  // 重画时保留展开着的折叠块（同一次竞争）；切换语言、实时刷新时连没提交的输入一起保留
  const same = box.dataset.id === id;
  const opened = same ? [...box.querySelectorAll('details')].map((d) => d.open) : [];
  const restore = keep && same ? keepState(box) : null;
  box.dataset.id = id;
  box.hidden = false;
  const at = K_STEPS.findIndex(([st]) => st === (k.stage === 'insufficient' ? 'review_ready' : k.stage === 'cancelled' ? null : k.stage));
  const FIN = ['done', 'failed', 'cancelled'];
  const cur = k.stage === 'drafting' ? k.drafts : k.stage === 'reviewing' ? k.reviews.at(-1).tasks : [];
  const ready = cur.length && cur.every((t) => t.state === 'submitted' || FIN.includes(t.state)) && cur.some((t) => t.state === 'submitted');
  const drafters = new Set(k.drafts.map((d) => d.participant));
  const winner = k.selection?.label;
  const comments = k.reviews.flatMap((r) => r.comments ?? []);
  box.innerHTML = ui`
    <h3><code>${esc(k.id)}</code> · ${esc(k.title)} ${badge(...K_STAGE[k.stage])}</h3>
    <div class="steps">${K_STEPS.map(([, label], i) => `<span class="${i === at ? 'on' : at > i ? 'done' : ''}">${esc(ui(label))}</span>`).join('')}</div>
    ${k.pending ? `<p>${badge(ui('上一个操作的结果还没确认'), 'b-bad')} <span class="hint">${esc(k.pending.action === 'select' ? ui('选定') : ui('书记应用补丁'))} · ${esc(ui('原样重试，或重启服务恢复后再看'))}</span></p>` : ''}
    <p class="hint">${esc(k.type)}，选定后写成${esc(KIND[k.kind])}。${k.goal ? ui`要求：${esc(k.goal)}。` : ''}${k.inputs.length ? ui`输入：${k.inputs.map((x) => `<code>${esc(x.id)}</code>@${x.version}`).join(ui('、'))}` : ''}</p>

    <h4>方案（密封起草）</h4>
    <div class="wrap"><table><tr><th>任务</th><th>起草者</th><th>状态</th><th>独立性</th></tr>
      ${k.drafts.map((d) => `<tr><td><code>${esc(d.task)}</code></td><td>${esc(d.participant)}</td><td>${badge(...(TASK_STATE[d.state] ?? [d.state, 'b-muted']))}</td>
        <td>${d.independence === 'unproven' ? badge(ui('独立性未证明，不参与比较'), 'b-bad') : d.eligible ? badge(ui('有效'), 'b-ok') : ''}</td></tr>`).join('')}</table></div>
    <p class="hint">${k.mapping_public ? ui('评审已结束，标签与起草者的对应关系已公开。') : k.label_drafts.length ? ui('方案已揭晓，按随机标签显示；标签与起草者的对应关系在评审结束后公开。') : ui('揭晓前方案只在服务进程内存里，这里和任何文件里都看不到。')}</p>
    ${k.label_drafts.map((l) => `<details><summary>${esc(l.label)}${l.participant ? ui`（${esc(l.participant)}）` : ''}${l.label === winner ? ui(' · 选定') : ''}</summary><pre class="clip">${esc(l.text ?? '')}</pre></details>`).join('')}
    <p>${ready ? `<button class="primary" data-k-act="reveal">${k.stage === 'drafting' ? ui('揭晓方案') : ui('揭晓评审')}</button>` : ''}
      ${cur.some((t) => t.state === 'open') ? ui('<button data-k-act="dispatch">派发还没开始的成员</button>') : ''}</p>

    ${['review_ready', 'selecting'].includes(k.stage) ? ui`<div class="panel"><h4>${k.reviews.length ? ui('再发起一轮匿名评审') : ui('发起匿名评审')}</h4>
      <div class="people">${people.filter((x) => !drafters.has(x.id)).map((x) => `<label><input type="checkbox" name="kReviewer" value="${esc(x.id)}"> ${esc(x.name)}</label>`).join('') || ui('<span class="hint">起草者以外没有可用的参与者</span>')}</div>
      <p class="hint">起草者不能做评审（会认出自己的方案）。评审只拿到标签和去掉署名的正文；每条意见必须指向具体的节、页或论断编号，指不到的退回。</p>
      <p><button class="primary" data-k-act="review">发起评审</button></p></div>` : ''}

    ${k.reviews.map((r) => ui`<h4>第 ${r.n} 轮匿名评审</h4>
      <p class="hint">${r.tasks.map((t) => `<code>${esc(t.task)}</code> ${esc(t.reviewer)} ${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))}`).join('　')}</p>
      ${r.comments ? (r.comments.length
        ? ui`<div class="wrap"><table><tr><th>意见</th><th>位置</th><th>内容</th></tr>${r.comments.map((c) => `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.where)}</td><td>${esc(c.comment)}</td></tr>`).join('')}</table></div>`
        : ui('<p class="hint">没有有效意见。</p>'))
        + (r.returned.length ? ui`<details><summary>退回 ${r.returned.length} 条</summary><ul>${r.returned.map((x) => `<li>${esc(x.text)} <span class="hint">— ${esc(x.reason)}</span></li>`).join('')}</ul></details>` : '')
        : ui('<p class="hint">评审进行中：全部揭晓后才解析意见。</p>')}`).join('')}

    ${k.stage === 'selecting' ? ui`<div class="panel"><h4>选定一份</h4>
      <p><select id="kLabel">${k.label_drafts.map((l) => ui`<option value="${esc(l.label)}">${esc(l.label)}（${esc(l.participant ?? '')}）</option>`).join('')}</select>
        <input id="kReason" placeholder="选定的理由（必填）" size="40"> <button class="primary" data-k-act="select">选定</button></p>
      <p class="hint">选定的方案原样写成正式${esc(KIND[k.kind])}，内容来源记为它的起草者。</p></div>` : ''}

    ${k.selection ? ui`<div class="panel"><h4>选定结果</h4>
      <p>${badge(k.selection.label, 'b-ok')} 起草者 ${esc(k.selection.participant ?? '')} · ${esc(k.selection.by)} 选定于 ${time(k.selection.at)} · 理由：${esc(k.selection.reason)}</p>
      <p>正式${esc(KIND[k.kind])}：<a href="#" data-goto="${esc(k.selection.record.id)}"><code>${esc(k.selection.record.id)}</code></a>
        ${k.record ? ui`当前 v${k.record.version}${k.record.diverged ? ` ${badge(ui('已在竞争之外被改过，书记不再覆盖'), 'b-warn')}` : ''}` : ''} <span class="hint">书记上次写的是 v${k.applied?.version}</span></p>
      ${k.record ? ui`<details><summary>当前正文</summary><pre class="clip">${esc(k.record.body)}</pre></details>` : ''}</div>
      ${patchesPanel(k, comments)}` : ''}
    ${k.minority ? minorityPanel(k) : ''}

    <p>${k.stage === 'patching' ? ui('<button data-k-act="close">结束竞争</button>') : ''}
      ${!k.selection && !['cancelled', 'closed'].includes(k.stage) ? ui('<button data-k-act="cancel">取消竞争</button>') : ''}</p>
    <details><summary>流程记录（${k.history.length} 步）</summary><ul>${k.history.map((h) => `<li>${time(h.at)} · ${esc(h.by ?? '')} · ${esc(H_ACTION[h.action] ?? h.action)}${h.patch ? ` ${esc(h.patch)}` : ''}${h.label ? ` ${esc(h.label)}` : ''}${h.reason ? ui`：${esc(h.reason)}` : ''}</li>`).join('')}</ul></details>`;
  box.querySelectorAll('details').forEach((d, i) => opened[i] && (d.open = true));
  bindLinks(box);
  bindCompetition(box, k);
  restore?.();
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function patchesPanel(k, comments) {
  const losing = Object.keys(k.sections).filter((l) => l !== k.selection.label);
  const unapplied = k.patches.filter((p) => p.state === 'accepted' && !p.applied && !p.skipped).length;
  const rows = k.patches.map((p) => ui`<tr><td><code>${esc(p.id)}</code></td>
    <td>${esc(p.from.draft)} 第 ${p.from.section} 节${p.from.quote != null ? ui('中的一段') : ui('（整节）')}</td>
    <td>底稿第 ${p.to.section} 节 · ${esc(POS[p.to.position])}</td>
    <td><pre class="clip">${esc(p.content)}</pre>${p.note ? `<div class="hint">${esc(p.note)}</div>` : ''}${p.comment ? ui`<div class="hint">对应评审意见 ${esc(p.comment)}</div>` : ''}</td>
    <td class="hint">${esc(who(p.proposed_by))}</td>
    <td>${badge(...P_STATE[p.state])}${p.decision ? `<div class="hint">${esc(p.decision.by)}${p.decision.reason ? ui`：${esc(p.decision.reason)}` : ''}</div>` : ''}${p.applied ? ui`<div class="hint">已应用到 v${p.applied.version}</div>` : ''}${p.skipped ? `<div class="hint">${esc(p.skipped)}</div>` : ''}
      ${p.state === 'proposed' && k.stage === 'patching' ? ui`<div><input data-p-reason="${esc(p.id)}" placeholder="理由（拒绝时必填）" size="16"> <button data-p-decide="${esc(p.id)}" data-d="accept">接受</button> <button data-p-decide="${esc(p.id)}" data-d="reject">拒绝</button></div>` : ''}</td></tr>`).join('');
  return ui`<div class="panel"><h4>移植补丁</h4>
    <p class="hint">从落选方案里搬运整节或其中逐字的一段，放到底稿（选定的方案）某一节的前后、节首节尾，或整节替换；节号按底稿原来的分节。每条补丁都要你接受或拒绝，书记只应用接受了的，底稿其余部分一个字不改。</p>
    ${k.patches.length ? ui`<div class="wrap"><table><tr><th>补丁</th><th>从</th><th>到</th><th>搬运的原文</th><th>提出者</th><th>决定</th></tr>${rows}</table></div>` : ui('<p class="hint">还没有补丁。</p>')}
    ${unapplied && k.stage === 'patching' ? ui`<p><button class="primary" data-k-act="apply">让书记应用 ${unapplied} 条已接受的补丁</button></p>` : ''}
    ${k.stage === 'patching' && losing.length ? ui`<details><summary>提出一条补丁</summary>
      <p>从 <select id="pFrom">${losing.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</select>
        <select id="pFromSec">${secOptions(k, losing[0])}</select>
        <input id="pQuote" placeholder="只搬其中一段：逐字粘贴原文（留空就是整节）" size="34"></p>
      <p>到底稿 <select id="pToSec">${secOptions(k, k.selection.label)}</select>
        <select id="pPos">${k.positions.map((x) => `<option value="${x}">${esc(POS[x])}</option>`).join('')}</select></p>
      <p><input id="pNote" placeholder="说明（例如：把乙第 1 节的开场问题移到甲第 1 节开头）" size="46">
        <select id="pComment"><option value="">不对应评审意见</option>${comments.map((c) => `<option value="${esc(c.id)}">${esc(c.id)} ${esc(c.where)}</option>`).join('')}</select></p>
      <p><button data-k-act="propose">提出补丁</button></p></details>` : ''}
  </div>`;
}

function minorityPanel(k) {
  const m = k.minority;
  return ui`<div class="panel"><h4>少数意见记录</h4>
    <p class="hint">没有进入正式${esc(KIND[k.kind])}的内容都留在这里：被拒的补丁（连同理由）、没被任何已接受补丁采纳的评审意见，以及落选方案原文。</p>
    ${m.rejected_patches.length ? ui`<p>被拒的补丁：</p><ul>${m.rejected_patches.map((p) => ui`<li><code>${esc(p.id)}</code> ${esc(p.from.draft)} 第 ${p.from.section} 节 → 底稿第 ${p.to.section} 节（${esc(POS[p.to.position])}）<span class="hint"> — ${esc(p.by ?? '')}：${esc(p.reason ?? '')}</span></li>`).join('')}</ul>` : ''}
    ${m.skipped_patches.length ? ui`<p>接受了但没有应用的补丁：</p><ul>${m.skipped_patches.map((p) => `<li><code>${esc(p.id)}</code> <span class="hint">${esc(p.reason)}</span></li>`).join('')}</ul>` : ''}
    ${m.unadopted_comments.length ? ui`<p>没被采纳的评审意见：</p><ul>${m.unadopted_comments.map((c) => ui`<li><code>${esc(c.id)}</code> ${esc(c.where)}：${esc(c.comment)}</li>`).join('')}</ul>` : ''}
    <p>落选方案：${m.losing_drafts.map((d) => ui`${esc(d.label)}（任务 ${`<code>${esc(d.task ?? '')}</code>`}）`).join(ui('、')) || ui('无')}</p></div>`;
}

function bindCompetition(box, k) {
  const go = (tail, body, msg) => api('POST', P(`/competitions/${k.id}${tail}`), body)
    .then(() => toast(msg))
    .catch(fail)
    .finally(() => {
      showCompetition(k.id, { scroll: false }).catch(fail);
      VIEWS.compete().catch(fail);
    });
  const acts = {
    reveal: () => go('/reveal', {}, ui('已揭晓')),
    dispatch: () => go('/dispatch', {}, ui('已派发')),
    review: () => go('/review', { reviewers: [...box.querySelectorAll('[name="kReviewer"]:checked')].map((x) => x.value) }, ui('已发起匿名评审')),
    select: () => go('/select', { label: $('#kLabel').value, reason: $('#kReason').value }, ui('已选定，写成了正式作品')),
    propose: () => go('/patches', {
      from: { draft: $('#pFrom').value, section: Number($('#pFromSec').value), quote: $('#pQuote').value || undefined },
      to: { section: Number($('#pToSec').value), position: $('#pPos').value },
      note: $('#pNote').value || undefined, comment: $('#pComment').value || undefined,
    }, ui('已提出补丁')),
    apply: () => go('/apply', {}, ui('书记已应用接受了的补丁')),
    close: () => confirm(ui('结束这次竞争？结束后不能再提补丁。')) && go('/close', {}, ui('竞争已结束')),
    cancel: () => confirm(ui('取消这次竞争？进行中的任务会一起取消。')) && go('/cancel', {}, ui('竞争已取消')),
  };
  for (const b of box.querySelectorAll('[data-k-act]')) b.onclick = () => acts[b.dataset.kAct]();
  const from = box.querySelector('#pFrom');
  if (from) from.onchange = () => (box.querySelector('#pFromSec').innerHTML = secOptions(k, from.value));
  for (const b of box.querySelectorAll('[data-p-decide]')) b.onclick = () => {
    const id = b.dataset.pDecide;
    const reason = box.querySelector(`[data-p-reason="${id}"]`).value.trim();
    go(`/patches/${id}/decide`, { decision: b.dataset.d, ...(reason ? { reason } : {}) }, b.dataset.d === 'accept' ? ui`补丁 ${id} 已接受` : ui`补丁 ${id} 已拒绝`);
  };
}

// ---------- 研讨 ----------

// 从记录详情开研讨：带上这条记录的内容（不带内容生产者的身份），去研讨标签页填好
function startTalk(r) {
  const rec = r.record;
  // 开题的框架文字按界面语言；记录内容原样带上
  const lines = [ui`（工坊项目 ${project} 里的${KIND[r.kind]} ${rec.id} 第 ${rec.version} 版）`];
  if (r.kind === 'claim') {
    lines.push(ui`论断：${rec.text}`);
    for (const x of rec.sources || []) lines.push(ui`- 引 ${x.id}@${x.version}${x.quote ? ui`：“${x.quote}”` : ''}`);
  } else if (r.kind === 'objection') lines.push(ui`异议（${O_CATEGORY[rec.category]}，针对 ${rec.target.id}@${rec.target.version}）：${rec.reason}`);
  else if (r.kind === 'verification') lines.push(ui`核验（${VER[rec.verdict][0]}，针对 ${rec.target.id}@${rec.target.version}）：${rec.reason}`);
  else if (r.kind === 'source') lines.push(ui`来源：${rec.title}${rec.citation ? ui`，${rec.citation}` : ''}${rec.url ? ui`，${rec.url}` : ''}`);
  else lines.push(`${rec.title}${rec.body ? `\n\n${rec.body}` : ''}`);
  lines.push('', ui('想讨论的问题：'));
  $('#thTitle').value = ui`讨论 ${rec.id}：${titleOf(rec)}`.slice(0, 200);
  $('#thContent').value = lines.join('\n');
  $('#thRef').value = rec.id;
  document.querySelector('#tabs [data-tab="talk"]').click();
  $('#thContent').focus();
}

$('#newThread').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/threads', { project, title: $('#thTitle').value, content: $('#thContent').value, ref: $('#thRef').value || undefined });
    location.href = `/talk#/t/${r.thread.id}`;
  } catch (err) {
    fail(err);
  }
};

// ---------- 语言 ----------

// 和研讨室共用 wetalk.language；切换后外壳、当前标签页和打开着的详情一起换（详情平时只在没人操作时刷新）
$('#languageSelect').onchange = async (e) => {
  setLanguage(e.target.value);
  applyStaticTranslations();
  try {
    await loadProjects(project);
    if (!project) return;
    if (openRecord && !$('#recordDetail').hidden) await showRecord(openRecord, { scroll: false, keep: true });
    if (openCompetition && !$('#competitionDetail').hidden) await showCompetition(openCompetition, { scroll: false, keep: true });
    if (openPacket && !$('#taskDetail').hidden) await showPacket(openPacket, { scroll: false });
  } catch (err) {
    fail(err);
  }
};

// ---------- 调度与阶段（WP6） ----------

const ROUND_KIND = localizedBadges({
  progress: ['有进展', 'b-ok'], unchanged: ['停滞：内容没有变化', 'b-bad'], no_improvement: ['停滞：有变化但质量指标没有提升', 'b-bad'],
  no_result: ['没有任务完成', 'b-muted'], reading: ['只有读者或评审', 'b-muted'],
});

async function showHandoff(id) {
  const h = await api('GET', P(`/handoffs/${id}`));
  const box = $('#handoffView');
  box.hidden = false;
  box.innerHTML = ui`<h3>交接单 <code>${esc(h.id)}</code></h3><pre>${esc(h.text)}</pre>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#autoOn').onchange = async (e) => {
  try {
    const s = await api('POST', P('/scheduler/auto'), { on: e.target.checked });
    toast(s.auto ? ui('自动调度已打开') : ui('自动调度已关闭'));
  } catch (err) {
    fail(err);
  }
  VIEWS.schedule().catch(fail);
};

$('#runOnce').onclick = async () => {
  try {
    const r = await api('POST', P('/scheduler/run'), {});
    toast(r.round ? ui`第 ${r.round.n} 轮：派出 ${r.round.tasks.length} 个任务` : ui`没有派出任务${r.last?.skipped?.length ? ui`（${r.last.skipped.length} 个已就绪的任务没派出去，原因见下）` : ui('（没有已就绪的任务）')}`);
  } catch (err) {
    fail(err);
  }
  VIEWS.schedule().catch(fail);
};

// 切换阶段（也用于把中途失败的切换做完）；失败后刷新，显示没做完的切换
async function switchPhase(to) {
  try {
    const r = await api('POST', P('/phase'), { to });
    toast(ui`已切换阶段，交接单 ${r.handoff.id}`);
    await VIEWS.schedule();
    await showHandoff(r.handoff.id);
  } catch (err) {
    fail(err);
    VIEWS.schedule().catch(fail);
  }
}

$('#phaseSwitch').onclick = () => {
  const to = $('#phaseTo').value;
  if (!to || !confirm(ui`切换到“${$('#phaseTo').selectedOptions[0].textContent}”阶段？旧阶段的工作记忆会先归档再清空。`)) return;
  switchPhase(to);
};

// ---------- 新建项目向导（WP8） ----------
// 第一步：项目名和一段说明，派一位参与者起草约定（或自己填）。第二步：草案按节合并进约定，你逐节改过、确认，然后开始收集来源。
// 起草者只出草案，不写内容、不派任务；之后的任务照常按分工表由规则派发

let wizard = { mode: 'start' }; // start：填说明；review：看草案、确认约定
const PLAN_RUNNING = new Set(['proposed', 'open', 'claimed']);

$('#newProjectBtn').onclick = () => {
  wizard = { mode: 'start' };
  go('new');
};

// 起草者下拉框：默认上次选的那位，没有就用第一位 Claude
function fillPlanner(sel) {
  const keep = sel.value;
  let saved = null;
  try { saved = localStorage.getItem('wb.planner'); } catch {}
  sel.innerHTML = people.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') || ui('<option value="">（没有可用的参与者）</option>');
  const want = [keep, saved, people.find((x) => x.adapter === 'claude')?.id].find((id) => id && people.some((x) => x.id === id));
  if (want) sel.value = want;
}

const nameOf = (id) => people.find((x) => x.id === id)?.name ?? id ?? '';

function requestDraft(participant, brief) {
  try { localStorage.setItem('wb.planner', participant); } catch {}
  return api('POST', P('/plan'), { participant, brief });
}

async function renderWizard() {
  const start = wizard.mode === 'start' || !project;
  $('#wizStart').hidden = !start;
  if (start) {
    $('#wizReview').innerHTML = '';
    $('#wizReview').dataset.project = '';
    await loadPeople();
    return fillPlanner($('#wzWho'));
  }
  return renderReview();
}

async function startProject(draft) {
  const name = $('#wzName').value.trim();
  const brief = $('#wzBrief').value.trim();
  const who = $('#wzWho').value;
  if (!name) return toast(ui('先写项目名'), true);
  if (draft && !brief) return toast(ui('先写一段说明，起草者才有依据'), true);
  if (draft && !who) return toast(ui('没有可用的参与者，先自己填约定'), true);
  const buttons = document.querySelectorAll('#wizStart button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const r = await api('POST', '/api/projects', { name });
    project = r.name;
    try { localStorage.setItem('wb.project', project); } catch {}
    wizard = { mode: 'review' };
    $('#wzName').value = $('#wzBrief').value = '';
    toast(ui`已新建项目「${r.name}」`);
    // 项目已经建好：起草派不出去时照样进入第二步，在那里重试或自己填
    if (draft) await requestDraft(who, brief).catch(fail);
    await loadProjects(r.name);
  } catch (err) {
    fail(err);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$('#wizStart').onsubmit = (e) => {
  e.preventDefault();
  startProject(true);
};
$('#wzBlank').onclick = () => startProject(false);

// 第二步。实时刷新时只更新状态行；编辑器里有你没保存的改动时不重画，草案到了只给一个“换成草案”的按钮
async function renderReview() {
  const box = $('#wizReview');
  const mine = project;
  const [o, pl] = await Promise.all([api('GET', P()), api('GET', P('/plan')), loadPeople()]);
  if (project !== mine || tab !== 'new') return; // 等待期间换了项目或页面：这次的结果作废
  const t = pl.task;
  const running = t && PLAN_RUNNING.has(t.state);
  const useDraft = !!pl.proposal && !pl.stale;
  if (box.dataset.project !== project) {
    box.dataset.project = project;
    box.innerHTML = ui`<h3>${esc(o.title)} · 项目约定</h3>
      <div id="wzStatus"></div>
      <div id="wzConv"></div>
      <div class="tools"><button type="button" class="primary" data-wz="confirm">确认约定，开始收集来源</button> <button type="button" data-wz="save">只保存，稍后再开始</button></div>
      <details id="wzAgain"><summary>${t ? ui('重新起草') : ui('让 Agent 起草')}</summary>
        <p><textarea id="wzBrief2" rows="4" placeholder="一段话说清楚：给谁看、看完应当明白什么、大概多少页或讲多久、风格上要什么不要什么。"></textarea></p>
        <p class="tools"><span>起草者</span> <select id="wzWho2"></select> <button type="button" data-wz="redraft">派它起草</button></p>
      </details>`;
    $('#wzAgain').open = !t;
    bindReview(box);
  }
  const who = esc(nameOf(t?.assigned_to));
  let status = '';
  if (running) status = ui`<p>${badge(ui('起草中'), 'b-warn')} ${who} 正在按你的说明起草约定，完成后草案会出现在下面。也可以不等，先自己填。 <button type="button" data-wz="cancel">取消起草</button></p>`;
  else if (t && ['failed', 'needs_user', 'cancelled'].includes(t.state)) status = ui`<p>${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))} 起草没有完成：<span class="hint">${esc(t.history.at(-1)?.reason ?? '')}</span>。可以重新起草，或自己填。</p>`;
  else if (useDraft) status = ui`<p>${badge(ui('草案待确认'), 'b-warn')} 下面是 ${who} 的草案，已按节合并进约定，标“草案”的节是它写的。逐节改好后点确认；确认之前，任务包里用的仍是原来的约定。</p>`;
  else if (pl.proposal) status = ui('<p class="hint">最近一份草案是按旧版约定写的（之后约定已经改过或已确认），下面显示的是现在的约定。</p>');
  if (useDraft && pl.proposal.questions.length) status += ui`<div class="quote"><b>起草者想跟你确认：</b><ul>${pl.proposal.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>`;
  if (useDraft && pl.proposal.ignored.length) status += ui`<p class="hint">草案里对不上约定的节（没有合并）：${esc(pl.proposal.ignored.join(ui('、')))}</p>`;
  const conv = $('#wzConv');
  const key = `${t?.id ?? ''}|${useDraft}|${o.hashes.conventions}`;
  const take = conv.dataset.key !== key && conv.dataset.dirty && useDraft;
  if (take) status += ui`<p><button type="button" data-wz="take">换成刚到的草案（丢掉你在下面的改动）</button></p>`;
  $('#wzStatus').innerHTML = status;
  for (const b of box.querySelectorAll('[data-wz="cancel"]')) b.onclick = () => api('POST', P(`/tasks/${t.id}/cancel`), {}).then(() => toast(ui('已取消起草')), fail).then(() => render());
  for (const b of box.querySelectorAll('[data-wz="take"]')) b.onclick = () => {
    conv.dataset.dirty = '';
    conv.dataset.key = '';
    renderReview().catch(fail);
  };
  fillPlanner($('#wzWho2'));
  if (!$('#wzBrief2').value && t?.goal) $('#wzBrief2').value = t.goal;
  if (conv.dataset.key === key || conv.dataset.dirty) return;
  conv.dataset.key = key;
  conv.dataset.hash = o.hashes.conventions;
  convEditor(conv, useDraft ? pl.proposal.conventions : o.conventions, { drafted: new Set(useDraft ? Object.keys(pl.proposal.sections) : []) });
}

function bindReview(box) {
  const save = async () => {
    const conv = $('#wzConv');
    const r = await api('POST', P('/conventions'), { text: convValue(conv), expected: conv.dataset.hash });
    conv.dataset.dirty = '';
    conv.dataset.hash = r.hashes.conventions;
    return r;
  };
  box.querySelector('[data-wz="save"]').onclick = () => save().then(() => toast(ui('约定已保存')), fail).then(() => render());
  box.querySelector('[data-wz="confirm"]').onclick = async () => {
    try {
      const r = await save();
      const empty = r.missing.filter((m) => m.kind === 'empty');
      if (empty.length && !confirm(ui`约定里还有没填的节：${empty.map((m) => m.title).join(ui('、'))}。仍然开始？`)) return render();
      const s = await api('GET', P('/scheduler'));
      if (!s.phase || s.phase.id === 'goal') await api('POST', P('/phase'), { to: 'sources' });
      toast(ui('约定已确认，开始收集来源'));
      wizard = { mode: 'start' };
      go('overview');
    } catch (err) {
      fail(err);
      render();
    }
  };
  box.querySelector('[data-wz="redraft"]').onclick = async () => {
    const brief = $('#wzBrief2').value.trim();
    if (!brief) return toast(ui('先写一段说明，起草者才有依据'), true);
    try {
      await requestDraft($('#wzWho2').value, brief);
      $('#wzConv').dataset.dirty = '';
      $('#wzAgain').open = false;
      toast(ui('已派出起草'));
    } catch (err) {
      fail(err);
    }
    render();
  };
}

// ---------- 项目约定的分节编辑器 ----------
// 每节一个输入框，模板里的引导语作占位提示；没改过的节原样写回，一个字符都不差。也可以切到直接改 Markdown

function convEditor(box, md, { drafted = new Set() } = {}) {
  const doc = parseConventions(md);
  box._doc = doc;
  box._raw = false;
  box.dataset.dirty = '';
  const miss = new Map(missingOf(md).map((m) => [m.title, m]));
  const rows = (text) => Math.min(14, Math.max(2, text.split('\n').length + 1));
  box.innerHTML = `<div class="conv">${doc.sections.map((sec, i) => {
    const content = contentOf(sec.body);
    const m = miss.get(sec.title);
    const flag = m ? badge(m.kind === 'blank' ? ui`没填：${m.fields.join(ui('、'))}` : ui('还没填'), 'b-bad') : '';
    return `<label class="sec"><span class="sec-title">${esc(sec.title)} ${drafted.has(sec.title) ? badge(ui('草案'), 'b-warn') : ''} ${flag}</span>
      <textarea data-sec="${i}" rows="${rows(content)}" placeholder="${esc(hintsOf(sec.body).join('\n'))}">${esc(content)}</textarea></label>`;
  }).join('') || ui('<p class="hint">约定里没有二级标题（## ），只能直接改 Markdown。</p>')}</div>
    <label class="hint"><input type="checkbox" data-raw> ${esc(ui('直接改 Markdown'))}</label>
    <textarea data-rawtext rows="18" spellcheck="false" hidden></textarea>`;
  box.oninput = (e) => {
    if (!e.target.matches('[data-raw]')) box.dataset.dirty = '1';
  };
  const raw = box.querySelector('[data-raw]');
  raw.onchange = () => {
    const text = box.querySelector('[data-rawtext]');
    if (raw.checked) {
      text.value = convValue(box);
      box._raw = true;
      box.querySelector('.conv').hidden = true;
      text.hidden = false;
    } else {
      const dirty = box.dataset.dirty;
      convEditor(box, text.value, { drafted });
      box.dataset.dirty = dirty;
    }
  };
  if (!doc.sections.length) {
    raw.checked = true;
    raw.onchange();
  }
}

function convValue(box) {
  if (box._raw) return box.querySelector('[data-rawtext]').value;
  const doc = box._doc;
  return joinConventions({
    head: doc.head,
    sections: doc.sections.map((sec, i) => {
      const v = box.querySelector(`[data-sec="${i}"]`).value;
      return v === contentOf(sec.body) ? sec : { ...sec, body: bodyFrom(v, hintsOf(sec.body)) };
    }),
  });
}

// ---------- 项目约定与参数（设置页） ----------

// 常改的几项参数做成表单，其余直接改 JSON；表单改动同步写进下面的 JSON
const PROTO_FIELDS = [
  ['budget.calls', '调用次数上限', 'int'], ['budget.apiUsd', 'API 费用上限（美元）', 'num'],
  ['slides.maxCharsPerPage', '每页正文字数上限', 'int'], ['compete.drafts', '竞争方案份数（2–6）', 'int'],
  ['verify.coreClaimVerifiers', '核心结论要几位独立核验者', 'int'], ['verify.otherClaimVerifiers', '其他论断要几位独立核验者', 'int'],
  ['offPeak.defer', '高峰时段不派给 DeepSeek', 'bool'], ['git.autoCommit', '自动留档进 git', 'bool'],
];
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, p, v) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[keys.at(-1)] = v;
}

async function renderSettings() {
  const mine = project;
  const o = await api('GET', P());
  if (project !== mine) return;
  const box = $('#convBox');
  if (box.dataset.project !== project || (!box.dataset.dirty && box.dataset.hash !== o.hashes.conventions)) {
    convEditor(box, o.conventions);
    box.dataset.project = project;
    box.dataset.hash = o.hashes.conventions;
    $('#convOut').textContent = '';
  } else if (box.dataset.hash !== o.hashes.conventions) {
    $('#convOut').innerHTML = ui`约定在别处被改过，现在保存会被拒绝。 <button type="button" id="convReload">载入最新的约定（丢掉你在这里的改动）</button>`;
    $('#convReload').onclick = () => {
      box.dataset.project = '';
      render();
    };
  }
  const json = $('#protoJson');
  if (json.dataset.project !== project || (!json.dataset.dirty && json.dataset.hash !== o.hashes.protocol)) {
    json.value = JSON.stringify(o.override, null, 2);
    json.dataset.project = project;
    json.dataset.hash = o.hashes.protocol ?? '';
    json.dataset.dirty = '';
    $('#protoOut').textContent = '';
  }
  renderProtoForm(o.config);
  $('#protoEffective').textContent = JSON.stringify(o.config, null, 2);
}

function renderProtoForm(config) {
  let override = {};
  try { override = JSON.parse($('#protoJson').value || '{}'); } catch {}
  $('#protoForm').innerHTML = PROTO_FIELDS.map(([p, label, type]) => {
    const own = getPath(override, p);
    const v = own ?? getPath(config, p);
    const tag = own !== undefined ? badge(ui('已改'), 'b-warn') : `<span class="hint">${esc(ui('默认'))}</span>`;
    return type === 'bool'
      ? `<label class="field"><input type="checkbox" data-proto="${p}" data-type="bool" ${v ? 'checked' : ''}> ${esc(ui(label))} ${tag}</label>`
      : `<label class="field">${esc(ui(label))} <input type="number" data-proto="${p}" data-type="${type}" value="${esc(v)}" step="${type === 'int' ? 1 : 'any'}" min="0"> ${tag}</label>`;
  }).join('');
  for (const el of document.querySelectorAll('[data-proto]')) el.onchange = () => {
    let cur;
    try {
      cur = JSON.parse($('#protoJson').value || '{}');
    } catch (e) {
      return toast(ui`protocol.json 格式错误：${e.message}`, true);
    }
    setPath(cur, el.dataset.proto, el.dataset.type === 'bool' ? el.checked : Number(el.value));
    $('#protoJson').value = JSON.stringify(cur, null, 2);
    $('#protoJson').dataset.dirty = '1';
    renderProtoForm(config);
  };
}

$('#protoJson').oninput = () => ($('#protoJson').dataset.dirty = '1');
$('#convSave').onclick = async () => {
  const box = $('#convBox');
  try {
    const r = await api('POST', P('/conventions'), { text: convValue(box), expected: box.dataset.hash });
    box.dataset.dirty = '';
    box.dataset.hash = r.hashes.conventions;
    toast(r.changed ? ui('约定已保存，之后派出的任务用新版') : ui('约定没有变化'));
    box.dataset.project = ''; // 按保存后的内容重画（没填的节标记跟着更新）
  } catch (err) {
    fail(err);
  }
  render();
};
$('#convRedraft').onclick = () => {
  wizard = { mode: 'review' };
  go('new');
};
$('#protoSave').onclick = async () => {
  const json = $('#protoJson');
  let override;
  try {
    override = JSON.parse(json.value || '{}');
  } catch (e) {
    return toast(ui`protocol.json 格式错误：${e.message}`, true);
  }
  try {
    const r = await api('POST', P('/protocol'), { override, expected: json.dataset.hash || null });
    json.dataset.dirty = '';
    json.dataset.hash = r.hashes.protocol ?? '';
    toast(r.changed ? ui('参数已保存') : ui('参数没有变化'));
  } catch (err) {
    fail(err);
  }
  render();
};

// ---------- 首页：这个阶段的下一步（WP8） ----------
// 按当前阶段和正式记录给出一件要做的事，就在这里开始：抓取来源、分给参与者抽取论断、派对抗核验、发起大纲或讲稿竞争、导出。
// 每个按钮调用的都是原来各页的同一个接口（规则、上限、身份检查都不变），首页只是把它们按顺序摆出来

const PHASE_NEXT = { sources: 'claims', claims: 'outline', outline: 'script', script: 'slides', slides: 'review' };
// 竞争出作品的两个阶段：任务类型、作品种类、默认起草者（分工表里的工作类型）
const WORK_PHASE = {
  outline: { type: 'outline', kind: 'outline', route: 'outline' },
  script: { type: 'core_explanation', kind: 'script', route: 'key_writing' },
};
let homeSearch = null; // 最近一次搜索：{ query, results }，重画首页时保留
let homeCtx = null;

// 分工表里某类工作对应的、现在可用的参与者
const routed = (config, key) => {
  const route = config.routing?.[key] ?? [];
  return people.filter((x) => route.includes(x.id) || route.includes(x.adapter)).map((x) => x.id);
};
const pickPeople = (name, preset, exclude = new Set()) =>
  `<span class="people">${people.filter((x) => !exclude.has(x.id)).map((x) => `<label><input type="checkbox" name="${name}" value="${esc(x.id)}" ${preset.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || ui('<span class="hint">没有可用的参与者</span>')}</span>`;
const current = (x) => ({ id: x.record.id, version: x.record.version });

async function renderHome(inbox) {
  const mine = project;
  const [o, s, pl, recs] = await Promise.all([api('GET', P()), api('GET', P('/scheduler')), api('GET', P('/plan')), api('GET', P('/records')), loadPeople()]);
  const phase = s.phase?.id ?? null;
  const [comps, divs, exps, tasks] = await Promise.all([
    WORK_PHASE[phase] ? api('GET', P('/competitions')) : [],
    phase === 'claims' ? api('GET', P('/divisions')) : [],
    phase === 'review' ? api('GET', P('/exports')) : null,
    phase === 'claims' ? api('GET', P('/tasks')) : [],
  ]);
  // 已经有核验任务在路上（还没结束）的论断：不再重复派
  if (project !== mine) return; // 等待期间换了项目：这次的结果作废
  const verifying = new Set(tasks.filter((x) => x.type === 'verify_claim' && !['done', 'failed', 'cancelled'].includes(x.state)).map((x) => x.inputs[0]?.id));
  homeCtx = { o, s, pl, recs, comps, phase, verifying };
  const box = $('#tab-overview');
  // 重画时保留没提交的输入和展开着的折叠块：只在同一项目、同一阶段时（换了阶段，页面上的表单整个换了）
  const restore = box.dataset.project === project && box.dataset.phase === String(phase) ? keepState(box) : null;
  box.dataset.project = project;
  box.dataset.phase = String(phase);
  const at = s.phase ? s.phases.findIndex((x) => x.id === phase) : -1;
  const sum = o.summary;
  const card = (n, l) => `<div class="card"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  const missing = o.missing.map((m) => (m.kind === 'blank' ? ui`${m.title}（${m.fields.join(ui('、'))}）` : m.title));
  box.innerHTML = ui`
    <div class="home-head"><h2>${esc(o.title)}</h2>
      <div class="steps">${s.phases.map((x, i) => `<span class="${i === at ? 'on' : i < at ? 'done' : ''}">${esc(ui(x.name))}</span>`).join('')}</div></div>
    <div class="panel next">${nextStep({ o, s, pl, recs, comps, divs, exps, phase, verifying })}</div>
    ${inbox.length ? ui`<div class="panel"><h4>待你决定 ${badge(String(inbox.length), 'b-bad')}</h4>${inboxTable(inbox.slice(0, 5))}${inbox.length > 5 ? ui`<p><a href="#" data-hm-go="inbox">全部 ${inbox.length} 项 →</a></p>` : ''}</div>` : ''}
    <div class="panel"><h4>项目约定 ${missing.length ? badge(ui('还没填完'), 'b-bad') : badge(ui('已填好'), 'b-ok')}</h4>
      ${missing.length ? ui`<p class="hint">没填的节：${esc(missing.join(ui('、')))}。每个任务包都会带上约定，没填的部分 Agent 拿到的就是空的。</p>` : ''}
      <details><summary>${esc(ui('看全文'))}</summary><pre>${esc(o.conventions)}</pre></details>
      <p><button type="button" data-hm-go="settings">编辑约定与参数</button> <button type="button" data-hm="review">让 Agent 起草</button></p></div>
    <div class="panel"><h4>进展</h4>
      <p class="hint">${s.round ? ui`第 ${s.round.n} 轮进行中。` : ''}自动调度${s.auto ? ui('已打开') : ui('已关闭')} · <a href="#" data-hm-go="schedule">调度与阶段 →</a></p>
      <div class="cards">
        ${Object.entries(KIND).map(([k, l]) => card(sum.byKind[k] ?? 0, l)).join('')}
        ${card(sum.claims.unreviewed, ui('论断：未核验'))}
        ${card(sum.claims.disputed + sum.claims.unsupported, ui('论断：有分歧或不支持'))}
        ${card(sum.ready, ui('可进入成品'))}
        ${card(sum.stale, ui('待更新（stale）'))}
        ${card(sum.blocked, ui('有未解决阻塞'))}
      </div></div>`;
  bindInbox(box);
  bindHome(box);
  restore?.();
}

// 还缺核验、可以派对抗核验的论断：不是最新版本的不派（先改版），已有核验在路上的不重复派
const needsVerify = (claims, verifying) => claims.filter((c) => {
  const v = c.status.verification;
  return !c.status.ready && c.status.freshness !== 'stale' && !verifying.has(c.record.id) && (v?.state === 'unreviewed' || (v?.state === 'supported' && !v.enough));
});

function nextStep({ o, s, pl, recs, comps, divs, exps, phase, verifying }) {
  const of = (k) => recs.filter((x) => x.kind === k);
  const t = pl.task;
  const pname = (id) => ui(s.phases.find((x) => x.id === id)?.name ?? id);
  const advance = (to, enabled = true, primary = false) =>
    `<button type="button" ${primary ? 'class="primary"' : ''} data-hm-phase="${to}" ${enabled ? '' : 'disabled'}>${esc(ui`下一步：${pname(to)}`)} →</button>`;

  if (t && PLAN_RUNNING.has(t.state)) {
    return ui`<h3>${badge(ui('起草中'), 'b-warn')} ${esc(nameOf(t.assigned_to))} 正在起草项目约定</h3><p>完成后草案会出现在约定页，由你逐节改过、确认。</p><p><button type="button" data-hm="review">去看看</button></p>`;
  }
  if (pl.proposal && !pl.stale) {
    return ui`<h3>起草好的项目约定，等你确认</h3><p>${esc(nameOf(t.assigned_to))} 已按你的说明写好草案。确认之前，任务包里用的仍是原来的约定。</p><p><button type="button" class="primary" data-hm="review">去确认</button></p>`;
  }
  const empty = o.missing.filter((m) => m.kind === 'empty');
  if (!phase || phase === 'goal') {
    if (empty.length) {
      return ui`<h3>下一步：把项目约定填好</h3><p>每个任务包都会带上项目约定。现在还有 ${empty.length} 节没填（${esc(empty.map((m) => m.title).join(ui('、')))}），Agent 拿到的要求是空的。</p>
        <p><button type="button" class="primary" data-hm="review">让 Agent 起草，或自己填</button> <button type="button" data-hm-go="settings">直接编辑</button></p>`;
    }
    return ui`<h3>下一步：收集来源</h3><p>项目约定已经填好。切换到“收集来源”阶段后，就在这里抓取网页、录入资料，建来源卡。</p><p>${advance('sources', true, true)}</p>`;
  }

  if (phase === 'sources') {
    const n = of('source').length;
    const qs = pl.proposal?.queries ?? [];
    const results = homeSearch?.results ?? [];
    return ui`<h3>下一步：收集来源 <span class="hint">已有来源卡 ${n} 张</span></h3>
      <p class="hint">来源正文只有两个来处：按网址抓取的快照，或你手工录入的正文。之后论断的引文必须能在这些正文里逐字找到。</p>
      <h4>按网址抓取</h4>
      <textarea id="hmUrls" rows="3" placeholder="网址，每行一个"></textarea>
      <div class="tools"><button type="button" class="primary" data-hm="fetch">抓取，建来源卡</button> <span class="hint">用 DeepSeek Fetch（需要 DEEPSEEK_API_KEY），每个网址一次调用</span></div>
      <h4>先搜一搜</h4>
      <div class="tools"><input id="hmQuery" placeholder="搜索关键词" size="28" maxlength="128"> <button type="button" data-hm="search">搜索</button>
        ${qs.map((q) => `<button type="button" class="chip" data-hm-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <p class="hint">${qs.length ? ui('后面几个是起草者建议先搜的。') : ''}${esc(ui('搜索结果只是线索，抓取原文后才能作为来源。'))}</p>
      ${homeSearch ? ui`<div class="wrap"><table><tr><th>“${esc(homeSearch.query)}”的结果</th><th></th></tr>${results.map((r) => `<tr><td><b>${esc(r.title ?? '')}</b> <span class="hint">${esc(r.site_name ?? '')} ${esc(r.date ?? '')}</span><div class="hint">${esc(r.snippet ?? r.summary ?? '')}</div><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a></td>
        <td><button type="button" data-hm-fetch="${esc(r.url)}">${esc(ui('抓取原文'))}</button></td></tr>`).join('') || `<tr><td class="hint">${esc(ui('没有结果'))}</td><td></td></tr>`}</table></div>` : ''}
      <details><summary>手工录入一张来源卡（书、PDF、没有网址的资料）</summary>
        <p><input id="hmTitle" placeholder="标题" size="28" maxlength="300"> <input id="hmCite" placeholder="出处：书名、出版社、年份、页码" size="34"> <input id="hmUrl" placeholder="网址" size="28"> <span class="hint">出处和网址至少填一个</span></p>
        <p><textarea id="hmText" rows="6" placeholder="正文快照：把要引用的原文粘贴在这里，引文必须能在这里逐字找到"></textarea></p>
        <p><button type="button" data-hm="manual">录入来源卡</button></p>
      </details>
      <p>${advance('claims', n > 0)}</p>`;
  }

  if (phase === 'claims') {
    const sources = of('source');
    const claims = of('claim');
    const toVerify = needsVerify(claims, verifying);
    const ready = claims.filter((c) => c.status.ready).length;
    const live = divs.filter((d) => d.type === 'extract_claims' && d.done < d.of);
    const canDivide = o.config.modes.extract_claims === 'divide';
    return ui`<h3>下一步：抽取论断 <span class="hint">来源 ${sources.length} 张 · 论断 ${claims.length} 条 · 可进入成品 ${ready} 条</span></h3>
      ${live.map((d) => ui`<p>${badge(ui('进行中'), 'b-warn')} 分工 <code>${esc(d.id)}</code>：完成 ${d.done}/${d.of} 份 <a href="#" data-hm-go="divide">查看 →</a></p>`).join('')}
      ${canDivide ? ui`<h4>把来源分给参与者抽取论断</h4>
        <p class="hint">${sources.length} 张来源拆成互不重叠的几份，勾选的参与者每人一份，立即派发。默认勾上分工表里做抽取（extract）的参与者。</p>
        <div class="tools">${pickPeople('hmEx', routed(o.config, 'extract'))} <button type="button" class="primary" data-hm="extract" ${sources.length ? '' : 'disabled'}>分给他们抽取论断</button></div>` : ''}
      <h4>对抗核验</h4>
      <p class="hint">每条论断要由与作者不同厂商的核验者独立核验（核心结论 ${o.config.verify.coreClaimVerifiers} 位，其他 ${o.config.verify.otherClaimVerifiers} 位）；支持且份数够，才能进入成品。核验者由规则自动挑选。</p>
      <div class="tools"><button type="button" data-hm="verify" ${toVerify.length ? '' : 'disabled'}>给还缺核验的 ${toVerify.length} 条论断派对抗核验</button>${verifying.size ? ui`<span class="hint">另有 ${verifying.size} 条正在核验 · <a href="#" data-hm-go="tasks">任务 →</a></span>` : ''}</div>
      <p>${advance('outline', ready > 0)}</p>`;
  }

  if (WORK_PHASE[phase]) {
    const w = WORK_PHASE[phase];
    const works = of(w.kind);
    const label = KIND[w.kind];
    const live = comps.filter((k) => k.kind === w.kind && !['closed', 'cancelled'].includes(k.stage));
    const n = o.config.compete.drafts;
    const ready = of('claim').filter((c) => c.status.ready).length;
    const canCompete = o.config.modes[w.type] === 'compete';
    return ui`<h3>下一步：${esc(label)} <span class="hint">已有 ${works.length} 份</span></h3>
      ${live.map((k) => ui`<p>${badge(...(K_STAGE[k.stage] ?? [k.stage, 'b-muted']))} 竞争 <code>${esc(k.id)}</code>《${esc(k.title)}》 <button type="button" class="primary" data-hm-k="${esc(k.id)}">打开</button></p>`).join('')}
      ${!live.length && canCompete ? ui`<p class="hint">几位起草者同时独立写${esc(label)}，完成前互不可见 → 揭晓 → 匿名评审 → 你选定一份 → 落选方案里值得保留的部分逐条移植。输入：可进入成品的论断 ${ready} 条${phase === 'script' ? ui('，以及最新的大纲') : ''}。</p>
        <div class="tools"><span>起草者（选 ${n} 位）</span> ${pickPeople('hmK', routed(o.config, w.route).slice(0, n))}</div>
        <div class="tools"><input id="hmKGoal" placeholder="要求（可选）" size="40" maxlength="3600"> <button type="button" class="primary" data-hm="compete">发起${esc(label)}竞争</button></div>` : ''}
      <p>${advance(PHASE_NEXT[phase], works.length > 0)}</p>`;
  }

  if (phase === 'slides') {
    const n = of('slide').length;
    return ui`<h3>下一步：幻灯片 <span class="hint">已有 ${n} 页</span></h3>
      <p>把讲稿拆成每页一条幻灯片记录：标题、正文、讲者备注，以及这一页引用的论断。正文每个句子要带论断编号（如 C001），或标为〔非事实〕。</p>
      <p class="hint">这一步还没有自动化：在“候选稿”里按示例录入（“示例：来源＋论断＋页面”里有一页的写法）。</p>
      <p><button type="button" data-hm-go="candidates">去候选稿录入</button> ${advance('review', n > 0)}</p>`;
  }

  if (phase === 'review') {
    const latest = exps?.exports?.[0] ?? null;
    return ui`<h3>下一步：导出与审阅</h3>
      <p class="hint">导出 Markdown 和 PPTX，做渲染检查，再逐页终审。结构检查、渲染检查都通过、每页都经你终审通过，才可交付。</p>
      ${latest ? ui`<p>最近一次导出 <code>${esc(latest.id)}</code>：${latest.deliverable ? badge(ui('可交付'), 'b-ok') : badge(ui('还不可交付'), 'b-warn')} ${fresh(latest)} <button type="button" class="primary" data-hm-ex="${esc(latest.id)}">打开</button></p>` : ''}
      <p><button type="button" ${latest ? '' : 'class="primary"'} data-hm="export">${latest ? ui('重新导出') : ui('导出 Markdown 和 PPTX')}</button></p>`;
  }
  return '';
}

// 一个按钮的操作：执行期间禁用，结束后刷新首页
async function busy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
  render();
}

function bindHome(box) {
  const { o, recs, phase } = homeCtx;
  const of = (k) => recs.filter((x) => x.kind === k);
  for (const a of box.querySelectorAll('[data-hm-go]')) a.onclick = (e) => (e.preventDefault(), go(a.dataset.hmGo));
  for (const b of box.querySelectorAll('[data-hm="review"]')) b.onclick = () => {
    wizard = { mode: 'review' };
    go('new');
  };
  for (const b of box.querySelectorAll('[data-hm-phase]')) b.onclick = () => {
    const to = b.dataset.hmPhase;
    const name = ui(homeCtx.s.phases.find((x) => x.id === to)?.name ?? to);
    if (homeCtx.phase && !confirm(ui`切换到“${name}”阶段？旧阶段的工作记忆会先归档再清空。`)) return;
    busy(b, async () => {
      const r = await api('POST', P('/phase'), { to });
      toast(ui`已切换到“${name}”阶段，交接单 ${r.handoff.id}`);
    });
  };
  const fetchOne = (url) => api('POST', P('/web/fetch'), { url, create: true });
  const fetchBtn = box.querySelector('[data-hm="fetch"]');
  if (fetchBtn) fetchBtn.onclick = () => busy(fetchBtn, async () => {
    const urls = $('#hmUrls').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return toast(ui('先填网址，每行一个'), true);
    const failed = [];
    let ok = 0;
    for (const url of urls) {
      try {
        await fetchOne(url);
        ok++;
      } catch (err) {
        failed.push(`${url}：${err.message}`);
      }
    }
    $('#hmUrls').value = failed.map((x) => x.split('：')[0]).join('\n'); // 没抓到的留在框里
    toast(ui`抓取了 ${ok} 个网址${failed.length ? ui`；${failed.length} 个没抓到：\n${failed.join('\n')}` : ''}`, failed.length > 0);
  });
  const search = (btn, query) => busy(btn, async () => {
    if (!query) return toast(ui('先写搜索关键词'), true);
    const r = await api('POST', P('/web/search'), { query, count: 8 });
    homeSearch = { query, results: r.results };
  });
  const searchBtn = box.querySelector('[data-hm="search"]');
  if (searchBtn) searchBtn.onclick = () => search(searchBtn, $('#hmQuery').value.trim());
  for (const b of box.querySelectorAll('[data-hm-q]')) b.onclick = () => {
    $('#hmQuery').value = b.dataset.hmQ;
    search(b, b.dataset.hmQ);
  };
  for (const b of box.querySelectorAll('[data-hm-fetch]')) b.onclick = () => busy(b, async () => {
    const r = await fetchOne(b.dataset.hmFetch);
    toast(ui`已建来源卡 ${r.source?.id ?? ''}`);
  });
  const manual = box.querySelector('[data-hm="manual"]');
  if (manual) manual.onclick = () => busy(manual, async () => {
    const title = $('#hmTitle').value.trim();
    const text = $('#hmText').value.trim();
    if (!title || !text) return toast(ui('标题和正文快照都要填'), true);
    if (!$('#hmCite').value.trim() && !$('#hmUrl').value.trim()) return toast(ui('出处和网址至少填一个'), true);
    const data = { title, text };
    if ($('#hmCite').value.trim()) data.citation = $('#hmCite').value.trim();
    if ($('#hmUrl').value.trim()) data.url = $('#hmUrl').value.trim();
    const receipt = await api('POST', P('/submissions'), { request_id: `web-${crypto.randomUUID()}`, changes: [{ kind: 'source', expected_version: 0, data }] });
    const r = await api('POST', P(`/submissions/${encodeURIComponent(receipt.sid)}/promote`), {});
    for (const id of ['#hmTitle', '#hmCite', '#hmUrl', '#hmText']) $(id).value = '';
    toast(ui`已录入来源卡 ${r.records[0].id}`);
  });
  const extract = box.querySelector('[data-hm="extract"]');
  if (extract) extract.onclick = () => busy(extract, async () => {
    const participants = checked('hmEx');
    if (!participants.length) return toast(ui('至少勾选一位参与者'), true);
    const r = await api('POST', P('/divide'), { type: 'extract_claims', title: ui('抽取论断'), inputs: of('source').map(current), participants });
    const bad = r.dispatched.filter((x) => !x.dispatched);
    toast(ui`已发起分工 ${r.id}：${r.parts.length} 份${bad.length ? ui`；没派发出去：${bad.map((x) => ui`${x.task}（${x.error}）`).join(ui('；'))}` : ''}`, bad.length > 0);
  });
  const verify = box.querySelector('[data-hm="verify"]');
  if (verify) verify.onclick = () => busy(verify, async () => {
    const claims = needsVerify(of('claim'), homeCtx.verifying);
    const failed = [];
    let n = 0;
    for (const c of claims) {
      try {
        n += (await api('POST', P(`/claims/${c.record.id}/verify`), {})).dispatched.length;
      } catch (err) {
        failed.push(`${c.record.id}：${err.message}`);
      }
    }
    toast(ui`派出 ${n} 个核验任务${failed.length ? ui`；${failed.length} 条没派出去：\n${failed.join('\n')}` : ''}`, failed.length > 0);
  });
  const compete = box.querySelector('[data-hm="compete"]');
  if (compete) compete.onclick = () => busy(compete, async () => {
    const w = WORK_PHASE[phase];
    const inputs = of('claim').filter((c) => c.status.ready).map(current);
    if (phase === 'script') {
      const outline = of('outline').at(-1);
      if (outline) inputs.unshift(current(outline));
    }
    const r = await api('POST', P('/compete'), { type: w.type, title: `${o.title}${KIND[w.kind]}`, goal: $('#hmKGoal').value.trim(), inputs, participants: checked('hmK') });
    const bad = r.dispatched.filter((x) => !x.dispatched);
    toast(ui`已发起竞争 ${r.id}${bad.length ? ui`；没派发出去：${bad.map((x) => ui`${x.task}（${x.error}）`).join(ui('；'))}` : ui('，方案正在密封起草')}`, bad.length > 0);
  });
  for (const b of box.querySelectorAll('[data-hm-k]')) b.onclick = () => {
    go('compete');
    showCompetition(b.dataset.hmK).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-hm-ex]')) b.onclick = () => {
    go('export');
    setTimeout(() => showExport(b.dataset.hmEx).catch(fail), 100);
  };
  const exp = box.querySelector('[data-hm="export"]');
  if (exp) exp.onclick = () => busy(exp, async () => {
    const r = await api('POST', P('/export'), {});
    if (r.export) {
      toast(ui`已导出 ${r.export.id}`);
      go('export');
      setTimeout(() => showExport(r.export.id).catch(fail), 100);
    } else toast(ui`已派给 ${r.task.assigned_to} 出版式方案（任务 ${r.task.id}），交来后自动生成`);
  });
}

loadProjects();
