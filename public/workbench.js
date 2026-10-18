// 工坊页面：项目概况、记录与派生状态、追溯、提交与留档、候选稿、待你决定。
const $ = (s) => document.querySelector(s);
const TOKEN = document.querySelector('meta[name="wb-host-token"]').content;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND = { source: '来源卡', claim: '论断', verification: '核验', objection: '异议', outline: '大纲', script: '讲稿', slide: '幻灯片' };
const VER = { unreviewed: ['未核验', 'b-muted'], supported: ['支持', 'b-ok'], disputed: ['有分歧', 'b-warn'], unsupported: ['不支持', 'b-bad'] };
const ARCHIVE = { archived: ['已留档', 'b-ok'], pending: ['待留档', 'b-warn'], failed: ['留档失败，待重试', 'b-bad'], skipped: ['不留档', 'b-muted'] };
const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');

let project = null;
let tab = 'overview';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Workbench-Host': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { details: data.details });
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

async function loadProjects(select) {
  const list = await api('GET', '/api/projects');
  const sel = $('#project');
  sel.innerHTML = list.map((p) => `<option value="${esc(p.name)}">${esc(p.title)}</option>`).join('') || '<option value="">（还没有项目）</option>';
  const want = select ?? new URLSearchParams(location.search).get('p') ?? localStorage.getItem('wb.project');
  project = list.some((p) => p.name === want) ? want : list[0]?.name ?? null;
  sel.value = project ?? '';
  render();
}

$('#project').onchange = (e) => {
  project = e.target.value;
  try { localStorage.setItem('wb.project', project); } catch {}
  render();
};

$('#newProject').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#newName').value.trim();
  if (!name) return;
  try {
    const r = await api('POST', '/api/projects', { name });
    $('#newName').value = '';
    toast(`已新建项目「${r.name}」`);
    await loadProjects(r.name);
  } catch (err) {
    fail(err);
  }
};

// ---------- 标签页 ----------

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== `tab-${tab}`;
    render();
  };
}

async function render() {
  if (!project) {
    $('#tab-overview').innerHTML = '<p class="hint">还没有项目。在右上角输入名字新建一个，或运行 <code>npm run new-project 名称</code>。</p>';
    return;
  }
  try {
    const inbox = await api('GET', P('/inbox'));
    $('#inboxCount').hidden = !inbox.length;
    $('#inboxCount').textContent = inbox.length;
    await VIEWS[tab]?.(inbox);
    // 打开着的记录详情（例如核验结果陆续回来）一起刷新；正在填表单时不刷，免得冲掉输入
    const box = $('#recordDetail');
    if (tab === 'records' && openRecord && !box.hidden && !box.contains(document.activeElement) && !box.querySelector('details[open]')) await showRecord(openRecord, { scroll: false });
  } catch (e) {
    fail(e);
  }
}

const fresh = (s) => (s.freshness === 'stale' ? badge('待更新', 'b-warn') : badge('最新', 'b-ok'));
const ready = (s) => (s.ready === undefined ? '' : s.ready ? badge('可进入成品', 'b-ok') : badge('不可进入成品', 'b-muted'));
// 核验状态带份数：支持且份数够才算数（核心结论默认 2 份，其他 1 份）
const verif = (s) => {
  const v = s.verification;
  if (!v) return '';
  const [text, cls] = VER[v.state];
  return badge(v.state === 'supported' ? `${text} ${v.independent}/${v.required}` : text, v.state === 'supported' && !v.enough ? 'b-warn' : cls);
};
const UNCOUNTED = {
  same_vendor: '与作者同厂商', identity_unverified: '身份未证实（MCP 外部会话）', vendor_unknown: '推断不出核验者的厂商',
  author_vendor_unknown: '推断不出作者的厂商', superseded: '同一核验者后来又核验了一次，只算最新一份',
};
const O_STATE = {
  open: ['待裁定', 'b-bad'], needs_evidence: ['待补证', 'b-bad'], upheld: ['成立', 'b-bad'], needs_user: ['待你决定', 'b-bad'],
  rejected: ['不成立', 'b-muted'], withdrawn: ['已撤回', 'b-muted'], resolved: ['已解决', 'b-ok'],
};
const O_CATEGORY = {
  source_missing: '来源不存在（阻塞）', number_error: '数字错误（阻塞）', quote_unsupported: '引文不支持结论（阻塞）',
  interpretation: '解释争议', narrative: '叙事选择', extension: '可选扩展',
};
// 主持人在页面上能把异议转到的状态（最终由提交入口的状态机按身份判断）
const O_NEXT = { open: ['upheld', 'rejected', 'needs_user', 'withdrawn'], needs_evidence: ['needs_user', 'withdrawn'], upheld: ['resolved'], needs_user: ['upheld', 'rejected', 'open', 'withdrawn', 'resolved'] };
const who = (a) => (a ? `${a.participant ?? a.kind}${a.vendor && a.vendor !== 'human' ? `（${a.vendor}）` : ''}${a.verified ? '' : ' · 未证实'}` : '');
const blocks = (s) => (s.blockers.length ? badge(`阻塞 ${s.blockers.join('、')}`, 'b-bad') : '');
const titleOf = (r) => r.title ?? r.text ?? r.target?.id ?? '';

const TASK_STATE = {
  proposed: ['已提出', 'b-muted'], open: ['可认领', 'b-warn'], claimed: ['进行中', 'b-warn'], submitted: ['已交稿', 'b-warn'],
  done: ['完成', 'b-ok'], failed: ['失败', 'b-bad'], cancelled: ['已取消', 'b-muted'], needs_user: ['待你决定', 'b-bad'],
};
const VIS = { sealed: '密封起草', review: '匿名评审', audience: '观众型读者', read: '读资料', export: '导出' };
let people = [];

const VIEWS = {
  async overview() {
    const o = await api('GET', P());
    const s = o.summary;
    const card = (n, l) => `<div class="card"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
    $('#tab-overview').innerHTML = `
      <div class="cards">
        ${Object.entries(KIND).map(([k, l]) => card(s.byKind[k] ?? 0, l)).join('')}
      </div>
      <div class="cards">
        ${card(s.claims.supported, '论断：核验支持')}
        ${card(s.claims.unreviewed, '论断：未核验')}
        ${card(s.claims.disputed + s.claims.unsupported, '论断：有分歧或不支持')}
        ${card(s.stale, '待更新（stale）')}
        ${card(s.blocked, '有未解决阻塞')}
        ${card(s.ready, '可进入成品')}
        ${card(o.candidates.pending, '待晋升的候选稿')}
        ${card(o.commits.archivePending, '待留档的提交')}
        ${card(o.inbox, '待你决定')}
      </div>
      <h3>项目约定（project.md）</h3>
      <pre>${esc(o.conventions)}</pre>
      <details><summary>生效配置</summary><pre>${esc(JSON.stringify(o.config, null, 2))}</pre></details>`;
  },

  async records() {
    if (!people.length) people = (await api('GET', '/api/state')).participants.filter((x) => x.available);
    const kind = $('#kindFilter').value;
    const list = await api('GET', P(`/records${kind ? `?kind=${kind}` : ''}`));
    $('#recordList').innerHTML = list.length
      ? `<div class="wrap"><table><tr><th>编号</th><th>种类</th><th>版本</th><th>内容</th><th>状态</th><th>来源</th></tr>
        ${list.map(({ record: r, kind: k, status: s }) => `
          <tr class="click" data-id="${r.id}">
            <td><code>${r.id}</code></td><td>${KIND[k]}</td><td>v${r.version}</td>
            <td>${esc(titleOf(r)).slice(0, 80)}</td>
            <td>${fresh(s)} ${verif(s)} ${blocks(s)} ${ready(s)}</td>
            <td class="hint">${esc(r.provenance?.kind === 'human' ? r.provenance.participant : r.provenance?.participant ?? '')}</td>
          </tr>`).join('')}</table></div>`
      : '<p class="hint">没有记录。</p>';
    for (const tr of document.querySelectorAll('#recordList tr.click')) tr.onclick = () => showRecord(tr.dataset.id);
  },

  async trace() {
    const id = $('#traceId').value.trim();
    if (id) await showTrace(id);
  },

  async commits() {
    const list = await api('GET', P('/commits'));
    $('#commitList').innerHTML = list.length
      ? `<div class="wrap"><table><tr><th>提交</th><th>时间</th><th>记录</th><th>数据</th><th>留档</th><th>来自</th></tr>
        ${list.map((c) => `<tr>
          <td><code>${c.cid}</code></td><td>${time(c.at)}</td>
          <td>${c.records.map((r) => `<code>${r.id}</code> v${r.version}`).join('、')}</td>
          <td>${badge('已提交', 'b-ok')}</td>
          <td>${badge(...ARCHIVE[c.archive.state])}${c.archive.error ? `<div class="hint">${esc(c.archive.error)}</div>` : ''}</td>
          <td class="hint">${c.task_id ? `任务 ${esc(c.task_id)}#${c.attempt}` : `候选稿 ${esc(c.sid)}`}</td>
        </tr>`).join('')}</table></div>`
      : '<p class="hint">还没有提交。</p>';
  },

  async candidates() {
    const list = (await api('GET', P('/submissions'))).sort((a, b) => b.received_at.localeCompare(a.received_at));
    $('#candidateList').innerHTML = list.length
      ? `<div class="wrap"><table><tr><th>候选稿</th><th>收稿时间</th><th>状态</th><th></th></tr>
        ${list.map((c) => `<tr>
          <td><code>${esc(c.sid)}</code></td><td>${time(c.received_at)}</td>
          <td>${c.applied ? badge(`已晋升（提交 ${c.applied}）`, 'b-ok') : c.state === 'draft' ? badge('历史草稿', 'b-muted') : badge('待晋升', 'b-warn')}</td>
          <td>${!c.applied && c.state === 'received' ? `<button class="primary" data-promote="${esc(c.sid)}">晋升</button>` : ''}</td>
        </tr>`).join('')}</table></div>`
      : '<p class="hint">没有候选稿。</p>';
    for (const b of document.querySelectorAll('[data-promote]')) b.onclick = () => promote(b.dataset.promote);
    if (!$('#changes').value) $('#changes').value = EXAMPLES.source();
  },

  async tasks() {
    const [list, o, state] = await Promise.all([api('GET', P('/tasks')), api('GET', P()), api('GET', '/api/state')]);
    people = state.participants.filter((x) => x.available);
    const types = [...Object.keys(o.config.modes), 'verify_claim', 'find_evidence', 'anonymous_review', 'audience_reader'];
    const sel = $('#taskType');
    if (sel.options.length !== types.length) sel.innerHTML = types.map((t) => `<option value="${esc(t)}">${esc(t)}（${esc(o.config.modes[t] ?? '特殊')}）</option>`).join('');
    const opts = people.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    $('#taskList').innerHTML = list.length
      ? `<div class="wrap"><table><tr><th>任务</th><th>类型</th><th>标题</th><th>状态</th><th>尝试</th><th>持有者</th><th>用量</th><th>操作</th></tr>
        ${list.map((t) => {
          const round = t.attempts.find((a) => a.n === t.attempt)?.sealed_round;
          const acts = [];
          if (t.state === 'open') acts.push(`<select data-who="${t.id}">${opts}</select><button data-dispatch="${t.id}">派发</button>`);
          if (t.state === 'needs_user') acts.push(`<button data-decide="${t.id}" data-to="open">重开</button>`);
          if (t.state === 'submitted' && round) acts.push(`<button class="primary" data-reveal="${esc(round)}">揭晓 ${esc(round)}</button>`);
          if (!['done', 'failed', 'cancelled'].includes(t.state)) acts.push(`<button data-cancel="${t.id}">取消</button>`);
          if (t.attempt) acts.push(`<button data-packet="${t.id}">任务包</button>`);
          return `<tr><td><code>${t.id}</code></td><td>${esc(t.type)}<div class="hint">${esc(VIS[t.visibility] ?? t.visibility)}</div></td>
            <td>${esc(t.title)}</td><td>${badge(...(TASK_STATE[t.state] ?? [t.state, 'b-muted']))}<div class="hint">${esc(t.history.at(-1)?.reason ?? '')}</div></td>
            <td>${t.attempt}/${t.max_attempts}</td><td class="hint">${esc(t.holder?.participant ?? '')}</td>
            <td class="hint">${t.budget_used.calls} 次${t.budget_used.usd ? ` · $${t.budget_used.usd.toFixed(4)}` : ''}</td><td>${acts.join(' ')}</td></tr>`;
        }).join('')}</table></div>`
      : '<p class="hint">还没有任务。</p>';
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
    const label = {
      write_fault: '写入故障：已停止接受写入，请重启服务完成恢复', external_change: '服务进程之外改过的记录文件', bad_record_file: '读不出来的记录文件', archive_failed: 'git 留档失败',
      task_failed: '任务失败（尝试次数用完，不再自动重派）', task_needs_user: '任务待你决定', budget_exceeded: '项目用量已到上限',
      objection_needs_user: '异议待你裁决', claim_disputed: '论断的核验结论不一致',
    };
    const where = (i) => (i.objection || i.claim ? `<a href="#" data-goto="${esc(i.objection ?? i.claim)}"><code>${esc(i.objection ?? i.claim)}</code></a>` : `<code>${esc(i.path ?? i.cid ?? i.task ?? '')}</code>`);
    $('#inboxList').innerHTML = items.length
      ? `<div class="wrap"><table><tr><th>类型</th><th>位置</th><th>说明</th></tr>
        ${items.map((i) => `<tr><td>${esc(label[i.type] ?? i.type)}</td><td>${where(i)}</td>
          <td class="hint">${esc(i.reason ?? i.error ?? i.resolution ?? (i.type === 'claim_disputed' ? `计入的核验：${i.counted.join('、')}` : i.actual ? '内容与最后一次提交不一致' : i.expected ? '文件被删除' : i.type?.startsWith('task_') || i.type?.startsWith('objection') ? '' : '没有对应的提交记录'))}</td></tr>`).join('')}</table></div>
        <p class="hint">外部改动不会被提交入口覆盖：涉及这些文件的晋升会被拒绝，直到处理完。点编号打开记录详情，在那里处理异议。</p>
        <div id="inboxDetail"></div>`
      : '<p class="hint">没有待你决定的事项。</p>';
    for (const a of document.querySelectorAll('#inboxList [data-goto]')) a.onclick = (e) => {
      e.preventDefault();
      document.querySelector('#tabs [data-tab="records"]').click();
      setTimeout(() => showRecord(a.dataset.goto).catch(fail), 100);
    };
  },
};

$('#kindFilter').onchange = () => VIEWS.records();

let openRecord = null; // 记录标签页里打开着的详情：实时事件到来时一起刷新
async function showRecord(id, { scroll = true } = {}) {
  openRecord = id;
  const r = await api('GET', P(`/records/${id}`));
  const s = r.status;
  const link = (x) => `<a href="#" data-goto="${x}"><code>${x}</code></a>`;
  const box = $('#recordDetail');
  box.hidden = false;
  box.innerHTML = `
    <h3><code>${id}</code> · ${KIND[r.kind]} · v${r.record.version}</h3>
    <div>${fresh(s)} ${verif(s)} ${blocks(s)} ${ready(s)}</div>
    ${s.stale_reasons.length ? `<p class="hint">待更新原因：${s.stale_reasons.map((x) => x.type === 'version' ? `${x.id} 已从 v${x.based} 更新到 v${x.current}` : x.type === 'upstream' ? `上游 ${x.id} 待更新` : x.type === 'missing' ? `${x.id} 不存在` : x.type === 'external' ? `正式文件在服务之外被${x.change === 'deleted' ? '删除' : '改动'}，这里显示的是已提交的内容` : '循环引用').join('；')}</p>` : ''}
    <p>上游：${s.based_on.map((b) => `${link(b.id)} v${b.version}`).join('、') || '无'}　下游：${s.downstream.map(link).join('、') || '无'}</p>
    ${r.kind === 'claim' ? claimPanel(r, link) : ''}
    ${r.kind === 'objection' ? objectionPanel(r.record) : ''}
    ${r.kind === 'verification' ? `<p>核验者：${esc(who(r.record.verifier))} · 结论：${badge(...VER[r.record.verdict])}</p><p>${esc(r.record.reason)}</p>${r.record.support_quote ? `<div class="quote">${esc(r.record.support_quote.id)}@${r.record.support_quote.version}：${esc(r.record.support_quote.quote)}</div>` : ''}` : ''}
    ${r.kind !== 'claim' && r.objections.length ? `<p>异议：${r.objections.map(link).join('、')}</p>` : ''}
    ${r.kind !== 'claim' && r.kind !== 'objection' ? objectionForm(r) : ''}
    <p><button data-trace="${id}">追溯</button></p>
    <pre>${esc(JSON.stringify(r.record, null, 2))}</pre>
    <h4>历史版本</h4>
    <ul>${r.history.map((h) => `<li>v${h.version} · 提交 ${esc(h.commit ?? '-')} · ${time(h.updated_at)} · ${esc(h.provenance?.participant ?? h.provenance?.kind ?? '')}</li>`).join('')}</ul>`;
  bindLinks(box);
  bindContract1(box, r);
  if (scroll) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- 契约一：论断的核验面板、异议面板与表单 ----------

function claimPanel(r, link) {
  const v = r.status.verification;
  const c = r.record;
  const sources = (c.sources || []).map((x) => `<option value="${esc(x.id)}@${x.version}">${esc(x.id)} v${x.version}</option>`).join('');
  return `<div class="panel">
    <h4>核验 ${c.core ? badge('核心结论', 'b-warn') : ''}</h4>
    <p>结论：${verif(r.status)} · 独立核验者 ${v.independent} / 需要 ${v.required}${v.enough ? '' : '（还不够，不能进入成品）'}</p>
    <p>计入：${v.counted.map(link).join('、') || '无'}</p>
    ${v.uncounted.length ? `<p class="hint">不计入：${v.uncounted.map((u) => `${link(u.id)}（${esc(UNCOUNTED[u.reason] ?? u.reason)}）`).join('；')}</p>` : ''}
    ${r.verifications.length > v.counted.length + v.uncounted.length ? `<p class="hint">绑定旧版本、已不计入的核验：${r.verifications.filter((x) => !v.counted.includes(x) && !v.uncounted.some((u) => u.id === x)).map(link).join('、')}</p>` : ''}
    <p class="hint">作者：${esc(who(c.provenance))}。核验者必须与作者分属不同厂商；同一核验者只算最新一份。</p>
    <p><select id="c1Who"><option value="">自动挑选（凑够还差的份数）</option>${people.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
      <button class="primary" data-verify="${c.id}">派对抗核验</button></p>
    <details><summary>我来核验</summary>
      <p><select id="c1Verdict"><option value="supported">支持</option><option value="unsupported">不支持（含证据不足）</option></select></p>
      <p><textarea id="c1Reason" rows="2" placeholder="理由"></textarea></p>
      <p>支持引文（判支持时必填）：<select id="c1Src">${sources}</select> <input id="c1Quote" placeholder="来源正文里逐字出现的一段" size="50"></p>
      <p><button data-myverify="${c.id}@${c.version}">提交核验</button></p>
    </details>
    <h4>异议 ${r.status.blockers.length ? badge(`阻塞 ${r.status.blockers.length}`, 'b-bad') : ''}</h4>
    <p>${r.objections.map(link).join('、') || '无'}</p>
    ${objectionForm(r)}
  </div>`;
}

function objectionForm(r) {
  const c = r.record;
  const sources = (r.kind === 'claim' ? c.sources || [] : r.kind === 'source' ? [{ id: c.id, version: c.version }] : []).map((x) => `<option value="${esc(x.id)}@${x.version}">${esc(x.id)} v${x.version}</option>`).join('');
  return `<details><summary>提出异议</summary>
    <p><select id="oCat">${Object.entries(O_CATEGORY).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <select id="oState"><option value="open">指针有效（open）</option><option value="needs_evidence">定位不到原文（needs_evidence）</option></select></p>
    <p>指针：<select id="oPtr"><option value="quote">来源原文</option><option value="missing_source">论断没有来源</option><option value="location">只写位置</option></select>
      <select id="oSrc">${sources}</select> <input id="oText" placeholder="原文（逐字）或位置描述" size="40"></p>
    <p><textarea id="oReason" rows="2" placeholder="问题在哪里（不需要给出修改方法）"></textarea></p>
    <p><button data-object="${c.id}@${c.version}">提出</button></p>
  </details>`;
}

function objectionPanel(o) {
  const ptr = o.pointer.type === 'quote' ? `${o.pointer.source.id}@${o.pointer.source.version}：${o.pointer.quote}` : o.pointer.type === 'location' ? `位置：${o.pointer.locator}` : o.pointer.type === 'gone' ? `来源 ${o.pointer.source.id} 已确认不存在` : o.pointer.type === 'fetch_failure' ? `来源 ${o.pointer.source.id} 的失败抓取 ${o.pointer.attempt}` : '论断没有来源';
  const next = O_NEXT[o.state] ?? [];
  return `<div class="panel">
    <p>${badge(...O_STATE[o.state])} ${esc(O_CATEGORY[o.category])} · 针对 <a href="#" data-goto="${o.target.id}"><code>${o.target.id}</code></a> v${o.target.version}</p>
    <p>提出者：${esc(who(o.raised_by))}</p>
    <div class="quote">${esc(ptr)}</div>
    <p>${esc(o.reason)}</p>
    ${o.resolution ? `<p class="hint">处理说明：${esc(o.resolution)}</p>` : ''}
    ${next.length ? `<p><select id="oNext">${next.map((x) => `<option value="${x}">${esc(O_STATE[x][0])}</option>`).join('')}</select>
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
      .then(done((x) => `已派发：${x.dispatched.map((d) => `${d.task.id}（${d.task.assigned_to}）`).join('、')}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-myverify]')) b.onclick = () => {
    const verdict = $('#c1Verdict').value;
    const body = { target: ref(b.dataset.myverify), verdict, reason: $('#c1Reason').value };
    if (verdict === 'supported') body.support_quote = { ...ref($('#c1Src').value), quote: $('#c1Quote').value };
    api('POST', P('/verifications'), body).then(done((x) => `已写入核验 ${x.result.records[0].id}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-object]')) b.onclick = () => {
    const type = $('#oPtr').value;
    const text = $('#oText').value;
    const pointer = type === 'quote' ? { type, source: ref($('#oSrc').value), quote: text } : type === 'location' ? { type, locator: text } : { type };
    api('POST', P('/objections'), { target: ref(b.dataset.object), category: $('#oCat').value, state: $('#oState').value, pointer, reason: $('#oReason').value })
      .then(done((x) => `已提出异议 ${x.result.records[0].id}`)).catch(fail);
  };
  for (const b of box.querySelectorAll('[data-resolve]')) b.onclick = () => {
    const resolution = $('#oResolution').value.trim();
    api('POST', P(`/objections/${b.dataset.resolve}/resolve`), { state: $('#oNext').value, ...(resolution ? { resolution } : {}) })
      .then(done(() => `异议 ${b.dataset.resolve} 已更新`)).catch(fail);
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

const verTag = (n) => (n.current_version != null && n.current_version !== n.version ? badge(`引用 v${n.version}，当前 v${n.current_version}`, 'b-warn') : `<span class="hint">v${n.version}</span>`);

function sourceHtml(s) {
  let q = '';
  if (s.quote) {
    q = s.quote_found === true
      ? `<div class="quote">…${esc(s.context.before)}<mark>${esc(s.quote)}</mark>${esc(s.context.after)}…</div>`
      : s.quote_found === false
        ? `<div class="quote">${badge('引文不在正文快照里', 'b-bad')} ${esc(s.quote)}</div>`
        : `<div class="quote">${badge('没有正文快照，无法核对', 'b-muted')} ${esc(s.quote)}</div>`;
  }
  return `<div class="node"><div class="head"><code>${s.id}</code> ${verTag(s)} <b>${esc(s.title)}</b>
    ${s.availability === 'gone' ? badge('来源已不存在', 'b-bad') : s.availability === 'temporarily_unavailable' ? badge('暂不可获取（快照仍可用）', 'b-warn') : ''}</div>
    <div class="hint">${esc(s.citation ?? '')} ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.url)}</a>` : ''} ${s.locator ? `· 位置：${esc(s.locator)}` : ''}</div>${q}</div>`;
}

function claimHtml(c) {
  return `<div class="node"><div class="head"><code>${c.id}</code> ${verTag(c)} ${c.status ? `${fresh(c.status)} ${verif(c.status)} ${blocks(c.status)} ${ready(c.status)}` : badge('不存在', 'b-bad')}</div>
    <div>${esc(c.text)} <span class="hint">（${esc(c.type)}）</span></div>
    <ul class="tree">${c.sources.map((s) => `<li>${sourceHtml(s)}</li>`).join('') || '<li class="hint">没有关联来源</li>'}</ul></div>`;
}

async function showTrace(id) {
  if (!id) return;
  const t = await api('GET', P(`/trace/${id}`));
  const out = $('#traceOut');
  if (t.kind === 'claim') out.innerHTML = claimHtml(t.root) + (t.downstream.length ? `<p class="hint">被引用：${t.downstream.join('、')}</p>` : '');
  else if (t.kind === 'source') out.innerHTML = sourceHtml(t.root) + `<p>下游：${t.downstream.map((d) => `<code>${d.id}</code>${d.downstream.length ? ` → ${d.downstream.map((x) => `<code>${x}</code>`).join('、')}` : ''}`).join('；') || '无'}</p>`;
  else if (t.root.claims) {
    out.innerHTML = `<div class="node"><div class="head"><code>${t.root.id}</code> <span class="hint">v${t.root.version}</span> <b>${esc(t.root.title)}</b> ${fresh(t.root.status)} ${ready(t.root.status)}</div>
      <ul class="tree">${t.root.claims.map((c) => `<li>${claimHtml(c)}</li>`).join('') || '<li class="hint">这一页没有引用论断</li>'}</ul></div>`;
  } else out.innerHTML = `<pre>${esc(JSON.stringify(t, null, 2))}</pre>`;
}

// ---------- 候选稿 ----------

const EXAMPLES = {
  source: () => JSON.stringify([{ kind: 'source', expected_version: 0, data: { title: '来源标题', author: '作者', citation: '书名，出版社，年份，页码', text: '来源正文快照（引文必须能在这里找到）' } }], null, 2),
  chain: () => JSON.stringify([
    { kind: 'source', expected_version: 0, tmp: '$s1', data: { title: '来源标题', url: 'https://example.org', text: '……原文正文……' } },
    { kind: 'claim', expected_version: 0, tmp: '$c1', data: { type: 'fact', text: '论断正文', sources: [{ id: '$s1', locator: '第 2 段', quote: '原文正文' }] } },
    { kind: 'slide', expected_version: 0, data: { title: '第 1 页', body: '页面正文', notes: '讲者备注', claims: [{ id: '$c1' }] } },
  ], null, 2),
};
for (const b of document.querySelectorAll('[data-example]')) b.onclick = () => ($('#changes').value = EXAMPLES[b.dataset.example]());

$('#submit').onclick = async () => {
  let changes;
  try {
    changes = JSON.parse($('#changes').value);
  } catch (e) {
    return toast(`JSON 格式错误：${e.message}`, true);
  }
  try {
    const r = await api('POST', P('/submissions'), { request_id: `web-${crypto.randomUUID()}`, changes });
    $('#submitOut').textContent = `已存为候选稿 ${r.sid}`;
    await VIEWS.candidates();
  } catch (e) {
    fail(e);
  }
};

async function promote(sid) {
  try {
    const r = await api('POST', P(`/submissions/${encodeURIComponent(sid)}/promote`), {});
    toast(`已晋升：提交 ${r.cid}，${r.records.map((x) => `${x.id} v${x.version}`).join('、')}`);
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
  pending = setTimeout(render, 200); // 一次提交会连发好几个事件，合并成一次刷新
};

async function showPacket(id) {
  const r = await api('GET', P(`/tasks/${id}/packet`));
  const box = $('#taskDetail');
  box.hidden = false;
  box.innerHTML = `<h3>任务包 <code>${esc(r.packet.id)}</code> · ${esc(VIS[r.packet.visibility] ?? r.packet.visibility)}</h3>
    <p class="hint">${r.packets.length} 次尝试：${r.packets.map(esc).join('、')}。下面是这次实际发送的提示词；每项输入都按内容 hash 存档，可以完整还原。</p>
    <pre>${esc(r.prompt ?? '（外部会话认领，提示词即任务包）')}</pre>
    <details><summary>输入（${r.inputs.length} 项）</summary>${r.inputs.map((i) => `<p><b>${esc(i.name)}</b> <span class="hint">${esc(i.ref ?? '')} ${esc(i.note ?? '')} · ${i.chars} 字 · blob ${esc(i.blob.slice(0, 12))}…</span></p>`).join('')}</details>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#newTask').onsubmit = async (e) => {
  e.preventDefault();
  const inputs = $('#taskInputs').value.split(/[,，\s]+/).filter(Boolean).map((x) => {
    const [id, v] = x.split('@');
    return { id, version: Number(v) };
  });
  try {
    const t = await api('POST', P('/tasks'), { type: $('#taskType').value, title: $('#taskTitle').value, goal: $('#taskGoal').value, inputs });
    toast(`已新建任务 ${t.id}（${TASK_STATE[t.state]?.[0] ?? t.state}）`);
    $('#taskTitle').value = $('#taskGoal').value = $('#taskInputs').value = '';
  } catch (err) {
    fail(err);
  }
  VIEWS.tasks();
};

loadProjects();
