const $ = (s) => document.querySelector(s);

const state = {
  humanName: '主持人',
  participants: [],
  threads: [],
  current: null, // { id, title, posts, session }
  running: new Map(), // threadId -> session
  selected: new Set(JSON.parse(localStorageGet('wetalk.selected') || 'null') || []),
};

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// ---------- 小工具 ----------

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 按名字或曾用名找参与者
function participantOf(name) {
  const s = String(name).toLowerCase();
  return state.participants.find((p) => [p.name, ...(p.aliases || [])].some((n) => n.toLowerCase() === s));
}

function colorOf(name) {
  const p = participantOf(name);
  if (p) return p.color;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 45% 48%)`;
}

// 头像：配置了产品图标的用图标，其他（主持人、MCP 来客）用首字
function avatarHtml(name) {
  const p = participantOf(name);
  return p?.icon
    ? `<div class="avatar icon"><img src="/icons/${p.icon}.svg" alt="${esc(p.name)}"></div>`
    : `<div class="avatar">${esc([...name][0] || '?')}</div>`;
}

const miniIcon = (icon) => (icon ? `<img class="mini-icon" src="/icons/${icon}.svg" alt="">` : '<span class="dot"></span>');

// 发言上显示的「模型 · effort」；Gemini 的强度含在模型名里，不再单列
function modelTag(post) {
  const a = post.agent;
  if (!a?.model) return '';
  const combined = participantOf(post.author)?.combined || !('effort' in a);
  const text = combined ? a.model : `${a.model} · ${a.effort || '默认'}`;
  const title = combined ? '这次发言实际使用的模型（推理强度已含在模型名里）' : '这次发言实际使用的模型 · effort（“默认”表示未指定，CLI 也不报告）';
  return `<span class="model-tag" title="${title}">${esc(text)}</span>`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 够用的 Markdown：先转义，再处理块级与行内格式
function md(src) {
  const codes = [];
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w&])#(\d{1,4})(?!\d)/g, '$1<a class="ref" data-floor="$2">#$2</a>')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const isBlockStart = (l) => /^(```|#{1,6}\s|\s*[-*+]\s+|\s*\d+[.)]\s+|>|(-{3,}|\*{3,})\s*$)/.test(l);
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(l)) {
      out.push(`<h4>${inline(l.replace(/^#+\s*/, ''))}</h4>`);
      i++;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push('<hr>');
      i++;
    } else if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(re, ''))}</li>`);
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^>/.test(l)) {
      const buf = [];
      for (; i < lines.length && /^>/.test(lines[i]); i++) buf.push(inline(lines[i].replace(/^>\s?/, '')));
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`);
    } else if (!l.trim()) {
      i++;
    } else {
      const buf = [];
      for (; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]); i++) buf.push(inline(lines[i]));
      if (!buf.length) buf.push(inline(lines[i++]));
      out.push(`<p>${buf.join('<br>')}</p>`);
    }
  }
  return out.join('');
}

// ---------- 渲染：侧栏 ----------

function renderThreads() {
  const list = $('#threadList');
  if (!state.threads.length) {
    list.innerHTML = '<div class="t-meta" style="padding:8px 10px">还没有议题</div>';
    return;
  }
  list.innerHTML = state.threads
    .map((t) => `
      <a class="thread-item ${state.current?.id === t.id ? 'active' : ''}" href="#/t/${t.id}">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-meta">
          ${state.running.get(t.id)?.running ? '<span class="live-dot" title="讨论进行中"></span>' : ''}
          ${t.memoryMode === 'off' ? '<span class="mode-tag" title="记忆关闭">无记忆</span>' : t.memoryMode === 'ro' ? '<span class="mode-tag" title="记忆只读">只读</span>' : ''}
          <span>${t.postCount} 条</span><span>·</span><span>${fmtTime(t.lastAt)}</span>
        </div>
      </a>`)
    .join('');
}

// ---------- 渲染：座位（参与者） ----------

function renderSeats() {
  const session = state.current?.session;
  const fixed = state.orderMode !== 'random';
  let n = 0;
  $('#seats').innerHTML = state.participants
    .map((p) => {
      const on = p.available && state.selected.has(p.id);
      const cls = !p.available ? 'unavailable' : on ? 'on' : 'off';
      const speaking = session?.current === p.id ? 'speaking' : '';
      const how = p.combined ? p.model || '默认' : `${p.model || '默认'} · effort ${p.effort || '默认'}`;
      const personas = state.current?.personas;
      const own = personas && Object.hasOwn(personas, p.id); // 议题里明确设置过（空字符串 = 本议题不设角色）
      const role = own ? (personas[p.id] ? `\n本议题立场：${personas[p.id]}` : '\n本议题：不设角色') : p.persona ? `\n角色：${p.persona}` : '';
      const title = !p.available ? '本机没找到这个 AI 的命令行工具' : `点击切换是否参与，拖动调整发言顺序\n模型：${how}${role}`;
      return `
        <span class="seat ${cls} ${speaking}" style="--c:${p.color}" data-id="${p.id}" title="${esc(title)}">
          <span class="seat-order">${on && fixed ? ++n : ''}</span>${miniIcon(p.icon)}${esc(p.name)}
          <button class="persona-btn ${p.persona || p.model ? 'has-persona' : ''}" data-persona="${p.id}" title="设置模型、effort 和角色">⚙</button>
        </span>`;
    })
    .join('');
}

function renderControls() {
  const running = !!state.current?.session?.running;
  $('#roundBtn').hidden = running;
  $('#roundsSelect').hidden = running;
  $('#stopBtn').hidden = !running;
  if (state.current) $('#memorySelect').value = state.current.memoryMode || 'rw';
  $('#orderSelect').value = state.orderMode;
  $('#seedInput').hidden = state.orderMode !== 'random';
  renderSpaceSelect();
  const open = openProposal();
  $('#proposalBtn').textContent = open ? '🗳 表决进行中' : '🗳 表决';
  $('#proposalBtn').classList.toggle('active', !!open);
}

// ---------- 表决：数据小工具 ----------

// ---------- 记忆空间 ----------

const spaceName = (id) => state.spaces?.find((s) => s.id === id)?.name ?? id;

function spaceOptions(selected, { allowNew = true, title = '' } = {}) {
  return [
    ...(state.spaces || []).map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>🧠 ${esc(s.name)}${s.parent ? `（分支自 ${esc(spaceName(s.parent.space))}）` : ''}</option>`),
    ...(allowNew
      ? [
          `<option value="__new">＋ 新建独立空间（空白起点）${title ? '' : '…'}</option>`,
          `<option value="__fork">＋ 从${selected ? `「${esc(spaceName(selected))}」` : '共享空间'}分支（复制当前记忆作为起点）</option>`,
        ]
      : []),
  ].join('');
}

function renderSpaceSelect() {
  if (!state.current) return;
  $('#spaceSelect').innerHTML = spaceOptions(state.current.memorySpace || 'shared');
}

// 选择"新建 / 分支"时生成要提交的 memorySpace 参数
function spaceChoice(value, base, title) {
  if (value === '__new') return { name: title ? `「${title}」的空间` : `新空间 ${new Date().toLocaleString('zh-CN', { hour12: false })}` };
  if (value === '__fork') return { name: `${spaceName(base)} 的分支${title ? `（${title}）` : ''}`, parent: base };
  return value;
}

// ---------- 表决：标签 ----------

const CHOICE = { yes: '赞成', reserve: '保留异议', no: '反对', abstain: '弃权' };
const FACT = { agree: '认同事实', partial: '部分认同事实', disagree: '不认同事实', unsure: '事实不确定' };
const BASIS = { fact: '事实', value: '价值', interest: '利益', procedure: '程序', other: '其他' };
const NOTE = {
  'facts-agree': '对事实判断一致',
  'facts-same-partial': '对事实判断一致（都只是部分认同）',
  'facts-same-disagree': '对事实判断一致（都不认同）',
  'facts-same-unsure': '对事实判断一致（都不确定）',
  'facts-differ': '对事实判断存在分歧',
  unanimous: '全体赞成',
  reserved: '仍有分歧，但没有人否决',
  'over-objection': '多数通过，存在反对票',
  'bases-differ': '接受同一方案，但理由不同',
};
const END_REASON = {
  'max-rounds': '用完最多轮数',
  'suggested-end': '过半数投票者建议结束',
  'drafter-declined': '起草人认为分歧无法通过修改弥合',
  'host-ended': '主持人宣布结束',
};
const RULE = { consensus: '共识', supermajority: '三分之二多数', majority: '简单多数' };
const proposalById = (id) => state.current?.proposals?.find((p) => p.id === id);
const openProposal = () => state.current?.proposals?.find((p) => p.status === 'open');
const roundOf = (pr, n) => pr?.rounds.find((r) => r.round === n);
const openRoundOf = (pr) => (pr?.rounds.at(-1)?.closedAt === null ? pr.rounds.at(-1) : null);
const humanVoted = (pr, round) =>
  state.current.posts.some((p) => p.type === 'vote' && p.proposalId === pr.id && p.round === round && p.kind === 'human');
const voterNames = (pr) => [
  ...pr.voters.map((id) => state.participants.find((p) => p.id === id)?.name ?? id),
  ...(pr.humanVotes ? [state.humanName] : []),
];

// ---------- 渲染：发言 ----------

// 指向这次发言对应的调用记录（完整 prompt 与原始回复）
const callLink = (post) => (post.callId ? `<button class="call-link" data-call="${post.callId}" title="查看这次调用的完整快照">🔍</button>` : '');

function postHtml(post, floor) {
  if (post.type === 'proposal') return proposalHtml(post, floor);
  if (post.type === 'vote') return voteHtml(post, floor);
  if (post.type === 'result') return resultHtml(post, floor);
  if (post.type === 'pass') return passHtml(post, floor);
  const human = post.kind === 'human';
  return `
    <article class="post ${human ? 'human' : ''}" style="--c:${colorOf(post.author)}" data-floor="${floor}" data-id="${post.id}">
      ${human ? `<div class="avatar">${esc([...post.author][0] || '?')}</div>` : avatarHtml(post.author)}
      <div class="bubble">
        <div class="post-head">
          <span class="name">${esc(post.author)}</span>
          ${post.via === 'mcp' ? '<span class="badge" title="通过 MCP 自主接入发言">MCP</span>' : ''}
          ${modelTag(post)}
          <span>${fmtTime(post.createdAt)}</span>
          ${memBadge(post)}
          ${callLink(post)}
          <span class="floor">#${floor}</span>
          <button class="post-del" data-del="${post.id}" title="删除这条发言">✕</button>
        </div>
        <div class="content">${md(post.content)}</div>
      </div>
    </article>`;
}

// "本轮无新增意见"：一行紧凑的记录，不占一整个气泡
function passHtml(post, floor) {
  return `
    <article class="post pass-post" style="--c:${colorOf(post.author)}" data-floor="${floor}" data-id="${post.id}">
      <div class="pass-line">${miniIcon(participantOf(post.author)?.icon)}<b>${esc(post.author)}</b>：本轮无新增意见${post.content ? `<span class="pass-note">——${esc(post.content)}</span>` : ''}
        ${memBadge(post)}${callLink(post)}<span class="floor">#${floor}</span>
      </div>
    </article>`;
}

const authorAvatar = (post) =>
  post.kind === 'human' ? `<div class="avatar">${esc([...post.author][0] || '?')}</div>` : avatarHtml(post.author);

// 提案 / 替代方案卡片；最新一版的卡片底部显示进度和主持人的操作
function proposalHtml(post, floor) {
  const pr = proposalById(post.proposalId);
  const latest = pr && pr.versions.at(-1)?.postId === post.id;
  const head = post.version > 1 ? `📜 替代方案 · 第 ${post.version} 版` : '📜 提案 · 第 1 版';
  return `
    <article class="post proposal-post ${post.kind === 'human' ? 'human' : ''}" style="--c:${colorOf(post.author)}" data-floor="${floor}" data-id="${post.id}" ${latest ? 'id="latest-proposal"' : ''}>
      ${authorAvatar(post)}
      <div class="bubble proposal-card">
        <div class="post-head">
          <span class="name">${head}</span>
          <span>${post.version > 1 ? '起草' : '提出'}：${esc(post.author)}</span>
          ${modelTag(post)}
          <span>${fmtTime(post.createdAt)}</span>
          <span class="floor">#${floor}</span>
        </div>
        <div class="content">${md(post.content)}</div>
        ${post.rationale ? `<details class="rationale"><summary>修改说明</summary><div class="content">${md(post.rationale)}</div></details>` : ''}
        ${pr && post.version === 1 ? `<div class="proposal-meta">规则：${RULE[pr.rule]} · ${pr.ballot === 'sealed' ? '密封投票' : '公开唱票'} · 最多 ${pr.maxRounds} 轮${pr.discussRounds ? ` · 未通过后讨论 ${pr.discussRounds} 轮` : ''} · 投票者：${voterNames(pr).map(esc).join('、')}</div>` : ''}
        ${latest ? proposalStatusHtml(pr) : ''}
      </div>
    </article>`;
}

function proposalStatusHtml(pr) {
  const session = state.current.session;
  const running = session?.running && session.proposalId === pr.id;
  const progress = pr.rounds
    .filter((r) => r.result)
    .map((r) => `<span class="step ${r.result.passed ? 'pass' : 'fail'}">v${r.version} ${r.result.passed ? '✓' : '✗'}</span>`)
    .join('<span class="arrow">→</span>');
  const exportLink = `<a class="export" href="/api/proposals/${pr.id}/export" target="_blank" title="导出逐票数据（JSON），用于分析">导出数据</a>`;
  if (pr.status !== 'open') {
    const label = {
      passed: `✅ 已通过（第 ${pr.rounds.length} 轮，第 ${pr.versions.length} 版）`,
      // 分歧保留是一种正常结果，不当作失败来显示
      deadlock: `◐ 分歧保留，未形成决议（${END_REASON[pr.endReason] ?? '已结束'}）`,
      withdrawn: '已撤回',
    }[pr.status];
    return `<div class="proposal-status ${pr.status}">${progress}<span class="status-label">${label}</span>${exportLink}</div>`;
  }
  const round = openRoundOf(pr);
  const body = humanActionOf(pr) ? '<div class="proposal-meta">↓ 轮到你了，操作区在讨论末尾</div>' : '';
  const evidence = pr.stage === 'evidence';
  const phase = running
    ? { vote: '投票中', discuss: '表决间讨论中', draft: '起草替代方案中' }[session.phase] ?? '进行中'
    : round && pr.humanVotes && !humanVoted(pr, round.round)
      ? '等待你投票'
      : pr.waiting === 'draft'
        ? '等待你起草替代方案'
        : evidence
          ? '有投票者请求证据'
          : '已暂停';
  const actions = running
    ? ''
    : evidence
      ? `<span class="evidence-hint">在讨论里补充证据后：</span>
         ${pr.rounds.length < pr.maxRounds ? `<button class="btn btn-sm" data-pr-revote="${pr.id}">就这一版再表决</button>` : ''}
         <button class="btn btn-sm" data-pr-continue="${pr.id}">${pr.discussRounds ? '讨论后' : ''}起草替代方案</button>
         <button class="btn btn-sm" data-pr-end="${pr.id}" title="分歧保留，未形成决议">结束表决</button>`
      : `${!body ? `<button class="btn btn-sm" data-pr-resume="${pr.id}">继续</button>` : ''}
         ${!round ? `<button class="btn btn-sm" data-pr-end="${pr.id}" title="分歧保留，未形成决议">结束表决</button>` : ''}`;
  return `
    <div class="proposal-status open">
      ${progress}<span class="status-label">${running ? '<span class="live-dot"></span>' : ''}${round ? `第 ${round.round} 轮 · ` : ''}${phase}</span>
      ${actions}
      <button class="btn btn-sm btn-ghost" data-pr-withdraw="${pr.id}">撤回提案</button>
    </div>
    ${body}`;
}

// 现在需要主持人做什么：投票 / 起草 / 无
function humanActionOf(pr) {
  if (!pr || pr.status !== 'open') return null;
  const round = openRoundOf(pr);
  if (round && pr.humanVotes && !humanVoted(pr, round.round)) return { kind: 'vote', round };
  const running = state.current.session?.running && state.current.session.proposalId === pr.id;
  if (pr.waiting === 'draft' || (!running && pr.stage === 'draft' && pr.drafter === 'human')) return { kind: 'draft' };
  return null;
}

// 轮到主持人时，操作区放在讨论的最末尾
function humanActionHtml() {
  const pr = openProposal();
  const action = humanActionOf(pr);
  if (!action) return '';
  return `
    <article class="post human action-post" id="human-action">
      <div class="avatar">${esc([...state.humanName][0] || '?')}</div>
      <div class="bubble">${action.kind === 'vote' ? ballotFormHtml(pr, action.round) : draftFormHtml(pr)}</div>
    </article>`;
}

const radios = (name, labels, required = false) =>
  Object.entries(labels)
    .map(([v, l]) => `<label class="choice ${name === 'choice' ? v : 'plain'}"><input type="radio" name="${name}" value="${v}" ${required ? 'required' : ''}> ${l}</label>`)
    .join('');

function ballotFormHtml(pr, round) {
  return `
    <form class="ballot" data-ballot="${pr.id}">
      <div class="ballot-title">你的一票 · 第 ${round.round} 轮（第 ${round.version} 版）${pr.ballot === 'sealed' ? ' · 密封：本轮结束前，谁的票都看不到' : ''}</div>
      <div class="choices" title="保留异议：不同意或有保留，但不阻止通过${pr.rule === 'consensus' ? '；反对：在共识规则下等于否决' : ''}">${radios('choice', CHOICE, true)}</div>
      <label class="confidence">信心 <input type="range" name="confidence" min="0" max="100" value="60"> <output>60</output></label>
      <div class="ballot-row"><span class="ballot-label">提案的事实前提</span><div class="choices small">${radios('fact', { agree: '认同', partial: '部分认同', disagree: '不认同', unsure: '不确定' })}</div></div>
      <div class="ballot-row"><span class="ballot-label">主要依据</span><div class="choices small">${radios('basis', BASIS)}</div></div>
      <textarea name="reason" rows="2" placeholder="理由（可选）。凭直觉也可以，直接写“直觉”就行——这正是要对比的地方。"></textarea>
      <input name="condition" placeholder="转为赞成的条件（不是赞成时填写，可选）">
      <input name="evidence" placeholder="请求证据：需要什么证据才能判断（可选）">
      <div class="ballot-actions">
        <label class="check"><input type="checkbox" name="suggestEnd"> 建议就此结束表决（不再起草新版本）</label>
        <button class="btn btn-primary">投出这一票</button>
      </div>
    </form>`;
}

function draftFormHtml(pr) {
  return `
    <form class="ballot" data-draft="${pr.id}">
      <div class="ballot-title">由你起草第 ${pr.versions.length + 1} 版替代方案</div>
      <textarea name="text" rows="5" required placeholder="写出完整的新方案（不是只列修改点）"></textarea>
      <textarea name="rationale" rows="2" placeholder="修改说明：改了什么，回应了谁的哪条意见（可选）"></textarea>
      <div class="ballot-actions"><button type="button" class="btn btn-ghost" data-pr-end="${pr.id}">不起草，结束表决</button><button class="btn btn-primary">提交替代方案并重新表决</button></div>
    </form>`;
}

function voteHtml(post, floor) {
  // 密封票由服务端隐去内容（post.sealed），本轮结束时再推送完整的票
  if (post.sealed || !post.vote) {
    return `
      <article class="post vote-post ${post.kind === 'human' ? 'human' : ''}" style="--c:${colorOf(post.author)}" data-floor="${floor}" data-id="${post.id}">
        ${authorAvatar(post)}
        <div class="bubble vote-card">
          <div class="post-head">
            <span class="name">${esc(post.author)}</span><span class="vote-choice sealed">🔒 已投票</span>
            <span>第 ${post.round} 轮 · 第 ${post.version} 版</span><span class="floor">#${floor}</span>
          </div>
          <div class="content sealed-note">密封投票，本轮所有人投完后揭晓。</div>
        </div>
      </article>`;
  }
  const v = post.vote;
  const conf = v.confidence != null ? `<span class="conf" title="信心"><span class="conf-bar"><i style="width:${v.confidence}%"></i></span>${v.confidence}</span>` : '';
  const secs = v.elapsedMs != null ? `<span title="${post.kind === 'human' ? '从本轮开始到投票' : 'AI 生成这张票'}的用时">${(v.elapsedMs / 1000).toFixed(v.elapsedMs < 10000 ? 1 : 0)}s</span>` : '';
  const tags = [
    v.fact ? `<span class="tag fact-${v.fact}" title="对提案事实前提的判断">${FACT[v.fact]}</span>` : '',
    v.basis ? `<span class="tag" title="立场的主要依据">依据：${BASIS[v.basis]}</span>` : '',
    v.suggestEnd ? '<span class="tag end" title="建议就此结束表决">建议结束</span>' : '',
  ].join('');
  return `
    <article class="post vote-post ${post.kind === 'human' ? 'human' : ''}" style="--c:${colorOf(post.author)}" data-floor="${floor}" data-id="${post.id}">
      ${authorAvatar(post)}
      <div class="bubble vote-card">
        <div class="post-head">
          <span class="name">${esc(post.author)}</span>
          <span class="vote-choice ${v.choice}">${CHOICE[v.choice]}</span>${conf}
          <span>第 ${post.round} 轮 · 第 ${post.version} 版</span>
          ${modelTag(post)}
          ${secs}
          ${memBadge(post)}
          ${callLink(post)}
          <span class="floor">#${floor}</span>
        </div>
        ${tags ? `<div class="vote-tags">${tags}</div>` : ''}
        <div class="content">${md(post.content)}</div>
        ${v.condition ? `<div class="vote-cond"><b>转为赞成的条件：</b>${esc(v.condition)}</div>` : ''}
        ${v.evidence ? `<div class="vote-cond evidence"><b>请求证据：</b>${esc(v.evidence)}</div>` : ''}
      </div>
    </article>`;
}

function resultHtml(post, floor) {
  const r = post.result || {};
  // 撤回、起草人拒绝、主持人结束：只有说明，没有计票
  if (r.total == null) {
    return `<article class="post result-post" data-floor="${floor}" data-id="${post.id}"><div class="result-card ${r.outcome === 'withdrawn' ? 'withdrawn' : 'deadlock'}"><div class="content">${md(post.content)}</div><span class="floor">#${floor}</span></div></article>`;
  }
  const pct = (n) => (r.total ? ((n ?? 0) / r.total) * 100 : 0);
  const verdict = {
    passed: '✓ 通过',
    next: '✗ 未通过',
    evidence: '⏸ 未通过 · 请求证据',
    concluded: '◐ 分歧保留（多数建议结束）',
    deadlock: '◐ 分歧保留（用完轮数）',
  }[r.outcome] ?? '';
  const notes = (r.notes || []).map((n) => `<span class="tag note">${NOTE[n] ?? n}</span>`).join('');
  return `
    <article class="post result-post" data-floor="${floor}" data-id="${post.id}">
      <div class="result-card ${r.outcome}">
        <div class="result-title">🗳 第 ${post.round} 轮表决 · 第 ${post.version} 版 <b>${verdict}</b><span class="floor">#${floor}</span></div>
        <div class="tally-bar" title="赞成 ${r.yes} · 保留异议 ${r.reserve ?? 0} · 反对 ${r.no} · 弃权 ${r.abstain}">
          <i class="yes" style="width:${pct(r.yes)}%"></i><i class="reserve" style="width:${pct(r.reserve)}%"></i><i class="abstain" style="width:${pct(r.abstain)}%"></i><i class="no" style="width:${pct(r.no)}%"></i>
        </div>
        ${notes ? `<div class="result-notes">${notes}</div>` : ''}
        <div class="content">${md(post.content)}</div>
      </div>
    </article>`;
}

function memBadge(post) {
  const m = post.memory;
  if (!m) return '';
  const v = (n) => (n ? `v${n}` : '空');
  const read = m.read ? `第 ${m.read} 版` : '空的';
  const where = m.space && m.space !== 'shared' ? `（空间：${spaceName(m.space)}）` : '';
  if (m.conflict) {
    return `<button class="mem-badge conflict" data-mem="${esc(post.author)}" data-space="${esc(m.space || 'shared')}" data-ver="${m.conflict}" title="写入冲突：读的是${read}，写入时别处已更新到第 ${m.conflict} 版；这次的修改没有覆盖，内容在调用记录里${where}">📓 ${v(m.read)}⚠冲突</button>`;
  }
  const [label, title] = m.wrote
    ? [`📓 ${v(m.read)}→v${m.wrote}`, `读了${read}记忆本，发言后改写为第 ${m.wrote} 版${where}`]
    : m.mode === 'ro'
      ? [`📓 只读 ${v(m.read)}`, `只读模式：参考了${read}记忆本${where}`]
      : [`📓 ${v(m.read)} 未改`, `读了${read}记忆本，这次没有修改${where}`];
  return `<button class="mem-badge ${m.wrote ? 'changed' : ''}" data-mem="${esc(post.author)}" data-space="${esc(m.space || 'shared')}" data-ver="${m.wrote || m.read || ''}" title="${title}">${label}</button>`;
}

function thinkingHtml(session) {
  const doing = { vote: '正在投票', draft: '正在起草替代方案' }[session.phase] ?? '正在思考';
  // 密封投票时几位 AI 同时在投
  const ids = session.pending?.length ? session.pending : session.current ? [session.current] : [];
  const next = session.queue.map((id) => state.participants.find((x) => x.id === id)?.name).filter(Boolean);
  return ids
    .map((id) => state.participants.find((x) => x.id === id))
    .filter(Boolean)
    .map(
      (p, i, all) => `
    <article class="post thinking" style="--c:${p.color}">
      ${avatarHtml(p.name)}
      <div class="bubble">
        <div class="post-head"><span class="name">${esc(p.name)}</span></div>
        <div class="content">${doing}<span class="dots"></span>${i === all.length - 1 && next.length ? `<br><small>接下来：${next.map(esc).join(' → ')}</small>` : ''}</div>
      </div>
    </article>`
    )
    .join('');
}

function renderEmpty() {
  const ideas = [
    ['自我意识只是神经元在特定情况下的特定举措吗？', '我觉得自我意识不过是一团神经元在特定情况下做出的特定举措。奖励机制的偏好、突然浮现的回忆、塑造神经连接的长期记忆（或者说潜意识）都会改变一个人的行为。如果是这样，"意识"和"足够复杂的信息处理"之间还有本质区别吗？'],
    ['如果 AI 必须自己挣电费，它会成为生命吗？', '设想一个 AI 拥有实体和充足的记忆空间，必须在人类社会中挣得维持自己运行的电力和服务器资源，并用自己的记忆不断重新训练自己。按照目前世俗对"生命"的定义，它算不算活着？缺的还是什么？'],
    ['几个 AI 在一起讨论，真的能产生新东西吗？', '你们的训练数据高度重叠，彼此之间的讨论会不会只是同一种声音的回声？什么样的讨论机制能真正产生新的价值？'],
  ];
  $('#posts').innerHTML = `
    <div class="empty">
      <h2>开一场研讨会</h2>
      <p>选一个议题，或者写下你自己的问题。在场的 AI 会轮流发言、互相回应，你可以随时插话。</p>
      <div class="suggestions">
        ${ideas.map(([t, c], i) => `<div class="suggestion" data-idea="${i}"><strong>${esc(t)}</strong></div>`).join('')}
      </div>
    </div>`;
  $('#posts').querySelectorAll('[data-idea]').forEach((el) =>
    el.addEventListener('click', () => openThreadDialog(...ideas[el.dataset.idea]))
  );
}

function renderPosts({ keepScroll = false } = {}) {
  const box = $('#posts');
  const t = state.current;
  if (!t) return renderEmpty();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  // 重绘会清掉正在填写的投票 / 起草表单，先记下来再还原
  const drafts = [...box.querySelectorAll('form[data-ballot], form[data-draft]')].map((f) => ({
    key: f.dataset.ballot ? `b${f.dataset.ballot}` : `d${f.dataset.draft}`,
    values: [...f.elements].filter((e) => e.name).map((e) => [e.name, e.type === 'radio' ? e.checked && e.value : e.value]),
    focus: f.contains(document.activeElement) ? document.activeElement.name : null,
  }));
  box.innerHTML =
    (t.posts.length ? t.posts.map((p, i) => postHtml(p, i + 1)).join('') : '<div class="empty"><p>还没有发言，说点什么开场吧。</p></div>') +
    (t.session?.running ? thinkingHtml(t.session) : '') +
    humanActionHtml();
  for (const d of drafts) {
    const f = box.querySelector(d.key[0] === 'b' ? `form[data-ballot="${d.key.slice(1)}"]` : `form[data-draft="${d.key.slice(1)}"]`);
    if (!f) continue;
    for (const [name, value] of d.values) {
      const el = f.elements[name];
      if (!el) continue;
      if (el instanceof RadioNodeList) {
        if (value) [...el].forEach((r) => (r.checked = r.value === value));
      } else el.value = value;
    }
    const out = f.querySelector('output');
    if (out && f.elements.confidence) out.value = f.elements.confidence.value;
    if (d.focus) f.elements[d.focus]?.focus?.();
  }
  if (!keepScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderAll() {
  const t = state.current;
  $('#threadTitle').textContent = t ? t.title : 'WeTalk';
  document.title = t ? `${t.title} · WeTalk` : 'WeTalk 研讨室';
  $('#stage').hidden = !t;
  $('#composer').hidden = !t;
  $('#deleteThreadBtn').hidden = !t;
  $('#callsBtn').hidden = !t;
  renderThreads();
  renderSeats();
  renderControls();
  renderPosts();
}

// ---------- 数据加载 ----------

async function loadState() {
  const s = await api('GET', '/api/state');
  state.humanName = s.humanName;
  state.orderMode = s.orderMode;
  state.participants = s.participants;
  state.threads = s.threads;
  state.spaces = s.spaces;
  if (!localStorageGet('wetalk.selected')) state.selected = new Set(s.participants.filter((p) => p.available).map((p) => p.id));
}

async function refreshThreads() {
  state.threads = await api('GET', '/api/threads');
  renderThreads();
}

async function openThread(id) {
  if (!id) {
    state.current = null;
    return renderAll();
  }
  try {
    state.current = await api('GET', `/api/threads/${id}`);
    state.running.set(id, state.current.session);
  } catch (e) {
    toast(e.message);
    location.hash = '';
    state.current = null;
  }
  renderAll();
}

const route = () => openThread(Number((location.hash.match(/^#\/t\/(\d+)/) || [])[1]) || null);

// ---------- 动作 ----------

function selectedIds() {
  return state.participants.filter((p) => p.available && state.selected.has(p.id)).map((p) => p.id);
}

async function startRound(threadId = state.current?.id) {
  const ids = selectedIds();
  if (!ids.length) return toast('先在上方选择至少一位可用的 AI');
  try {
    const seed = state.orderMode === 'random' ? $('#seedInput').value.trim() : '';
    const s = await api('POST', `/api/threads/${threadId}/round`, {
      participants: ids,
      rounds: Number($('#roundsSelect').value),
      order: state.orderMode,
      seed: seed || undefined,
    });
    if (s.order === 'random' && s.seed != null) toast(`随机种子 ${s.seed}（已记录；填同一个种子可以重现这个发言顺序）`, 'info');
  } catch (e) {
    toast(e.message);
  }
}

function openThreadDialog(title = '', content = '') {
  const f = $('#threadForm');
  f.title.value = title;
  f.content.value = content;
  f.memoryMode.value = 'rw';
  f.memorySpace.innerHTML = spaceOptions('shared', { title: true });
  $('#threadDialog').showModal();
  (title ? f.content : f.title).focus();
}

$('#threadForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target;
  try {
    const { thread } = await api('POST', '/api/threads', {
      title: f.title.value,
      content: f.content.value,
      memoryMode: f.memoryMode.value,
      memorySpace: spaceChoice(f.memorySpace.value, 'shared', f.title.value.trim()),
    });
    location.hash = `#/t/${thread.id}`;
    if (f.start.checked && f.content.value.trim()) startRound(thread.id);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 表决：发起、投票、起草 ----------

function openProposalDialog() {
  const open = openProposal();
  if (open) return ($('#human-action') || $('#latest-proposal'))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (state.current.session?.running) return toast('先等这一轮讨论结束，或点“停止”');
  const f = $('#proposalForm');
  const ais = state.participants.filter((p) => p.available);
  const personas = state.current.personas || {};
  // 角色三态：沿用全局 / 本议题不设角色 / 本议题自定义
  $('#voterRows').innerHTML = ais
    .map((p) => {
      const own = Object.hasOwn(personas, p.id);
      const mode = own ? (personas[p.id] ? 'custom' : 'none') : 'inherit';
      return `
      <div class="voter-row" style="--c:${p.color}">
        <label class="check voter-check"><input type="checkbox" name="voter" value="${p.id}" ${state.selected.has(p.id) ? 'checked' : ''}> ${miniIcon(p.icon)} ${esc(p.name)}</label>
        <select name="personaMode-${p.id}" class="persona-mode">
          <option value="inherit" ${mode === 'inherit' ? 'selected' : ''}>沿用全局${p.persona ? '' : '（无）'}</option>
          <option value="none" ${mode === 'none' ? 'selected' : ''}>本议题不设角色</option>
          <option value="custom" ${mode === 'custom' ? 'selected' : ''}>自定义</option>
        </select>
        <input name="persona-${p.id}" value="${esc(own ? personas[p.id] : '')}" ${mode === 'custom' ? '' : 'hidden'}
          placeholder="代表的立场 / 出发点，例如：中小企业主，关心成本与用工灵活性；底线是……">
        ${mode === 'inherit' && p.persona ? `<span class="persona-inherit" title="${esc(p.persona)}">${esc(p.persona)}</span>` : ''}
      </div>`;
    })
    .join('');
  f.drafter.innerHTML = [
    '<option value="rotate">投票者轮流起草</option>',
    ...ais.map((p) => `<option value="${p.id}">固定由 ${esc(p.name)} 起草</option>`),
    '<option value="human">我自己起草</option>',
  ].join('');
  $('#proposalDialog').showModal();
  f.text.focus();
}

$('#proposalForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = e.target;
  const voters = [...f.querySelectorAll('input[name=voter]:checked')].map((i) => i.value);
  if (!voters.length) {
    e.preventDefault();
    return toast('至少选一位 AI 投票者');
  }
  // null = 沿用全局；'' = 本议题明确不设角色；文本 = 本议题的立场
  const personas = {};
  for (const p of state.participants.filter((x) => x.available)) {
    const mode = f.elements[`personaMode-${p.id}`]?.value;
    if (!mode) continue;
    personas[p.id] = mode === 'inherit' ? null : mode === 'none' ? '' : f.elements[`persona-${p.id}`].value.trim();
  }
  try {
    await api('POST', `/api/threads/${state.current.id}/proposals`, {
      text: f.text.value,
      rule: f.rule.value,
      ballot: f.ballot.value,
      maxRounds: Number(f.maxRounds.value),
      discussRounds: Number(f.discussRounds.value),
      drafter: f.drafter.value,
      voteOrder: f.voteOrder.value,
      seed: f.seed.value.trim() || undefined,
      voters,
      humanVotes: f.humanVotes.checked,
      personas,
    });
    f.text.value = '';
  } catch (err) {
    toast(err.message);
  }
});

$('#voterRows').addEventListener('change', (e) => {
  if (!e.target.matches('.persona-mode')) return;
  const row = e.target.closest('.voter-row');
  const input = row.querySelector('input[name^=persona-]');
  input.hidden = e.target.value !== 'custom';
  row.querySelector('.persona-inherit')?.toggleAttribute('hidden', e.target.value !== 'inherit');
  if (e.target.value === 'custom') input.focus();
});

$('#posts').addEventListener('input', (e) => {
  if (e.target.name === 'confidence') e.target.closest('label').querySelector('output').value = e.target.value;
});

$('#posts').addEventListener('submit', async (e) => {
  const f = e.target;
  if (!f.matches('form[data-ballot], form[data-draft]')) return;
  e.preventDefault();
  const button = e.submitter || f.querySelector('button.btn-primary');
  button.disabled = true;
  try {
    if (f.dataset.ballot) {
      await api('POST', `/api/proposals/${f.dataset.ballot}/vote`, {
        choice: f.elements.choice.value,
        confidence: Number(f.elements.confidence.value),
        fact: f.elements.fact.value || undefined,
        basis: f.elements.basis.value || undefined,
        reason: f.elements.reason.value,
        condition: f.elements.condition.value,
        evidence: f.elements.evidence.value,
        suggestEnd: f.elements.suggestEnd.checked,
      });
      toast('已投票', 'info');
    } else {
      await api('POST', `/api/proposals/${f.dataset.draft}/versions`, { text: f.elements.text.value, rationale: f.elements.rationale.value });
    }
    f.remove();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
});

$('#proposalBtn').addEventListener('click', openProposalDialog);

// ---------- 参与者设置：模型 / effort / 角色 ----------

let settings = null; // { p, options }

async function openSettings(id) {
  const p = state.participants.find((x) => x.id === id);
  const f = $('#personaForm');
  settings = { p, options: null };
  $('#personaTitle').innerHTML = `${miniIcon(p.icon)} ${esc(p.name)} 的设置`;
  f.persona.value = p.persona || '';
  f.model.innerHTML = '<option>正在读取模型列表…</option>';
  f.model.disabled = true;
  f.modelCustom.hidden = true;
  f.effort.innerHTML = '';
  $('#effortField').hidden = p.combined;
  $('#modelHint').textContent = p.combined
    ? 'Gemini 的模型 id 本身就包含推理强度（如 gemini-3.8-flash-high），所以没有单独的 effort。'
    : '';
  $('#personaDialog').showModal();
  let options;
  try {
    options = await api('GET', `/api/participants/${id}/options`);
  } catch (e) {
    options = { models: [], efforts: [], error: e.message };
  }
  if (settings?.p !== p) return; // 等待期间换成了别人的设置
  settings.options = options;
  fillModelSelect();
}

function fillModelSelect() {
  const { p, options } = settings;
  const f = $('#personaForm');
  const models = options.models || [];
  const opts = [`<option value="">默认（跟随 ${esc(p.name)} 自己的设置）</option>`];
  for (const m of models) opts.push(`<option value="${esc(m.id)}">${esc(m.label)}${m.label !== m.id ? `　${esc(m.id)}` : ''}</option>`);
  if (p.model && !models.some((m) => m.id === p.model)) opts.push(`<option value="${esc(p.model)}">${esc(p.model)}（当前值，不在列表中）</option>`);
  opts.push('<option value="__custom">自定义…</option>');
  f.model.innerHTML = opts.join('');
  f.model.disabled = false;
  f.model.value = p.model || '';
  if (options.error) $('#modelHint').textContent = `没能读取模型列表（${options.error}），可以选“自定义…”手动输入。`;
  fillEffortSelect();
}

// Codex 每个模型支持的强度不同，换模型时重新生成选项，并尽量保留当前选择
function fillEffortSelect() {
  const { p, options } = settings;
  if (p.combined) return;
  const f = $('#personaForm');
  const m = (options.models || []).find((x) => x.id === f.model.value);
  const efforts = m?.efforts?.length ? m.efforts : options.efforts || [];
  const cur = f.effort.value || (f.effort.options.length ? '' : p.effort || '');
  const opts = ['<option value="">默认</option>', ...efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`)];
  if (cur && !efforts.includes(cur)) opts.push(`<option value="${esc(cur)}">${esc(cur)}${efforts.length ? '（这个模型不支持）' : ''}</option>`);
  f.effort.innerHTML = opts.join('');
  f.effort.value = cur;
}

$('#personaForm').model.addEventListener('change', (e) => {
  const custom = e.target.value === '__custom';
  const input = $('#personaForm').modelCustom;
  input.hidden = !custom;
  if (custom) input.focus();
  fillEffortSelect();
});

$('#personaForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok' || !settings) return;
  const f = e.target;
  const { p, options } = settings;
  const body = { persona: f.persona.value };
  if (options) {
    body.model = f.model.value === '__custom' ? f.modelCustom.value.trim() : f.model.value;
    if (!p.combined) body.effort = f.effort.value;
  }
  try {
    const updated = await api('PUT', `/api/participants/${p.id}`, body);
    Object.assign(state.participants.find((x) => x.id === updated.id), updated);
    renderSeats();
    const how = updated.combined ? updated.model || '默认' : `${updated.model || '默认'} · ${updated.effort || '默认'}`;
    toast(`已更新 ${updated.name}：${how}`, 'info');
  } catch (err) {
    toast(err.message);
  }
});

$('#orderSelect').addEventListener('change', async (e) => {
  try {
    await api('PUT', '/api/order', { mode: e.target.value });
    state.orderMode = e.target.value;
    renderSeats();
    toast(e.target.value === 'random' ? '随机顺序：每一轮都会重新洗牌' : '固定顺序：按座位从左到右发言，可拖动座位调整', 'info');
  } catch (err) {
    toast(err.message);
    renderControls();
  }
});

// ---------- 拖动座位调整发言顺序（鼠标直接拖；触屏长按后拖） ----------

let drag = null;
let suppressClick = false;
const seatsEl = $('#seats');

function startSeatDrag() {
  if (!drag) return;
  drag.started = true;
  drag.seat.classList.add('dragging');
  seatsEl.classList.add('sorting');
}

seatsEl.addEventListener('pointerdown', (e) => {
  const seat = e.target.closest('.seat');
  if (!seat || e.target.closest('.persona-btn') || e.button > 0) return;
  drag = { seat, x: e.clientX, y: e.clientY, id: e.pointerId, started: false, timer: null };
  if (e.pointerType !== 'mouse') drag.timer = setTimeout(startSeatDrag, 300);
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.started) {
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (e.pointerType === 'mouse' && dist > 6) startSeatDrag();
    else if (e.pointerType !== 'mouse' && dist > 10) {
      clearTimeout(drag.timer); // 手指在滑动，是想滚动而不是拖动
      drag = null;
    }
    return;
  }
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.seat');
  if (!over || over === drag.seat || !seatsEl.contains(over)) return;
  const r = over.getBoundingClientRect();
  seatsEl.insertBefore(drag.seat, e.clientX > r.left + r.width / 2 ? over.nextSibling : over);
});

function endSeatDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  clearTimeout(drag.timer);
  if (drag.started) {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    seatsEl.classList.remove('sorting');
    const ids = [...seatsEl.querySelectorAll('.seat')].map((s) => s.dataset.id);
    if (ids.join() !== state.participants.map((p) => p.id).join()) {
      state.participants.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      api('PUT', '/api/order', { ids }).catch((err) => toast(err.message));
    }
    renderSeats();
  }
  drag = null;
}
window.addEventListener('pointerup', endSeatDrag);
window.addEventListener('pointercancel', endSeatDrag);
// 触屏长按进入拖动后，别让页面跟着滚
seatsEl.addEventListener('touchmove', (e) => drag?.started && e.preventDefault(), { passive: false });

$('#seats').addEventListener('click', (e) => {
  if (suppressClick) return;
  const pb = e.target.closest('[data-persona]');
  if (pb) {
    e.stopPropagation();
    return openSettings(pb.dataset.persona);
  }
  const seat = e.target.closest('.seat');
  if (!seat || seat.classList.contains('unavailable')) return;
  const id = seat.dataset.id;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  localStorageSet('wetalk.selected', JSON.stringify([...state.selected]));
  renderSeats();
});

$('#posts').addEventListener('click', async (e) => {
  const ref = e.target.closest('.ref');
  if (ref) {
    const el = $(`.post[data-floor="${ref.dataset.floor}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    return;
  }
  const callBtn = e.target.closest('[data-call]');
  if (callBtn) return openCalls(Number(callBtn.dataset.call));
  const resume = e.target.closest('[data-pr-resume]');
  if (resume) return api('POST', `/api/proposals/${resume.dataset.prResume}/resume`, {}).catch((err) => toast(err.message));
  const revote = e.target.closest('[data-pr-revote]');
  if (revote) return api('POST', `/api/proposals/${revote.dataset.prRevote}/revote`, {}).catch((err) => toast(err.message));
  const cont = e.target.closest('[data-pr-continue]');
  if (cont) return api('POST', `/api/proposals/${cont.dataset.prContinue}/continue`, {}).catch((err) => toast(err.message));
  const end = e.target.closest('[data-pr-end]');
  if (end) {
    if (confirm('结束表决？结果记为「分歧保留，未形成决议」——这是一种正常的结果，不同于撤回。'))
      api('POST', `/api/proposals/${end.dataset.prEnd}/end`, {}).catch((err) => toast(err.message));
    return;
  }
  const withdraw = e.target.closest('[data-pr-withdraw]');
  if (withdraw) {
    if (confirm('撤回这项提案？已有的投票记录会保留。')) api('POST', `/api/proposals/${withdraw.dataset.prWithdraw}/withdraw`, {}).catch((err) => toast(err.message));
    return;
  }
  const badge = e.target.closest('[data-mem]');
  if (badge) return openMemory(badge.dataset.mem, Number(badge.dataset.ver) || undefined, badge.dataset.space);
  const del = e.target.closest('[data-del]');
  if (del && confirm('删除这条发言？之后发言的 AI 将看不到它。')) {
    try {
      await api('DELETE', `/api/posts/${del.dataset.del}`);
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#composerInput');
  const content = input.value.trim();
  if (!content || !state.current) return;
  try {
    await api('POST', `/api/threads/${state.current.id}/posts`, { content });
    input.value = '';
    if ($('#autoRound').checked && !state.current.session?.running) startRound();
  } catch (err) {
    toast(err.message);
  }
});

$('#composerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

$('#newThreadBtn').addEventListener('click', () => openThreadDialog());
$('#memoryBtn').addEventListener('click', () => openMemory());
$('#memorySelect').addEventListener('change', async (e) => {
  const tips = { rw: 'AI 会读取并更新各自的记忆本', ro: 'AI 会参考记忆本，但不会修改', off: 'AI 将在没有记忆的状态下发言' };
  try {
    await api('PUT', `/api/threads/${state.current.id}`, { memoryMode: e.target.value });
    toast(`本议题记忆模式：${tips[e.target.value]}`, 'info');
  } catch (err) {
    toast(err.message);
    renderControls();
  }
});
// 切换本议题的记忆空间（或新建 / 分支一个）
$('#spaceSelect').addEventListener('change', async (e) => {
  const base = state.current.memorySpace || 'shared';
  const choice = spaceChoice(e.target.value, base, state.current.title);
  if (typeof choice === 'object') {
    const name = prompt(choice.parent ? '分支空间的名字（会复制当前记忆作为起点）' : '新空间的名字（空白起点）', choice.name);
    if (!name) return renderSpaceSelect();
    choice.name = name;
  }
  try {
    const t = await api('PUT', `/api/threads/${state.current.id}`, { memorySpace: choice });
    toast(`本议题的记忆空间：${spaceName(t.memorySpace)}`, 'info');
  } catch (err) {
    toast(err.message);
    renderSpaceSelect();
  }
});
$('#roundBtn').addEventListener('click', () => startRound());
$('#stopBtn').addEventListener('click', () => api('POST', `/api/threads/${state.current.id}/stop`, {}).catch((e) => toast(e.message)));
$('#deleteThreadBtn').addEventListener('click', async () => {
  if (!confirm(`删除议题「${state.current.title}」及其全部发言？`)) return;
  await api('DELETE', `/api/threads/${state.current.id}`).catch((e) => toast(e.message));
  location.hash = '';
});
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#scrim').addEventListener('click', () => $('#sidebar').classList.remove('open'));
$('#threadList').addEventListener('click', () => $('#sidebar').classList.remove('open'));
window.addEventListener('hashchange', route);

// ---------- 记忆本 ----------

const memState = { space: 'shared', list: [], key: null, revisions: [], version: null, editing: false };
const SOURCE_LABEL = { ai: '发言后自写', mcp: 'MCP 自写', human: '主持人编辑', fork: '分支时复制' };

// 逐行 LCS 对比
function diffLines(a, b) {
  const A = a ? a.split('\n') : [];
  const B = b ? b.split('\n') : [];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push(['same', A[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', A[i++]]);
    else out.push(['add', B[j++]]);
  }
  while (i < A.length) out.push(['del', A[i++]]);
  while (j < B.length) out.push(['add', B[j++]]);
  return out;
}

// space 不给时：在议题里打开就用该议题的空间，否则沿用上次看的空间
async function openMemory(nameOrKey, version, space) {
  try {
    if (space) memState.space = space;
    else if (!$('#memoryDialog').open && state.current) memState.space = state.current.memorySpace || 'shared';
    if (!state.spaces?.some((s) => s.id === memState.space)) memState.space = 'shared';
    $('#memSpaceSelect').innerHTML = spaceOptions(memState.space, { allowNew: false });
    memState.list = await api('GET', `/api/memories?space=${encodeURIComponent(memState.space)}`);
    const want = nameOrKey && String(nameOrKey).toLowerCase();
    const hit = want && memState.list.find((m) => m.key === nameOrKey || m.name.toLowerCase() === want);
    memState.key = hit?.key ?? (memState.list.some((m) => m.key === memState.key) ? memState.key : memState.list[0]?.key);
    if (!$('#memoryDialog').open) $('#memoryDialog').showModal();
    await loadMemory(version);
  } catch (e) {
    toast(e.message);
  }
}

async function loadMemory(version) {
  if (!memState.key) return renderMemory();
  const r = await api('GET', `/api/memories/${encodeURIComponent(memState.key)}?space=${encodeURIComponent(memState.space)}`);
  memState.revisions = r.revisions;
  const latest = r.revisions.at(-1)?.version ?? null;
  memState.version = r.revisions.some((x) => x.version === version) ? version : latest;
  memState.editing = false;
  renderMemory();
}

function renderMemory() {
  const owner = memState.list.find((m) => m.key === memState.key);
  $('#memoryDialog').style.setProperty('--c', owner?.color || (owner ? colorOf(owner.name) : 'var(--accent)'));
  $('#memTabs').innerHTML = memState.list
    .map((m) => `
      <button class="mem-tab ${m.key === memState.key ? 'active' : ''}" data-key="${esc(m.key)}" style="--c:${m.color || colorOf(m.name)}">
        ${miniIcon(m.icon)}${esc(m.name)}<small>${m.count ? `v${m.count}` : '空'}</small>
      </button>`)
    .join('');

  const revs = memState.revisions;
  $('#memHistory').innerHTML = revs.length
    ? [...revs]
        .reverse()
        .map((r) => `
          <li class="${r.version === memState.version ? 'active' : ''}" data-v="${r.version}">
            <span class="v">v${r.version}</span><span class="src">${SOURCE_LABEL[r.source] || r.source}</span>
            <span class="from">${fmtTime(r.createdAt)}${r.threadTitle ? ' · ' + esc(r.threadTitle) : r.threadId ? ' · （议题已删除）' : ''}</span>
          </li>`)
        .join('')
    : '<li>还没有任何版本</li>';

  const editing = memState.editing;
  $('#memEditForm').hidden = !editing;
  $('#memContent').hidden = editing;
  $('#memEditBtn').hidden = editing || !memState.key;
  if (editing) return;

  const idx = revs.findIndex((r) => r.version === memState.version);
  const rev = revs[idx];
  if (!rev) {
    $('#memLabel').textContent = '';
    $('#memContent').innerHTML = '<p class="empty-note">还没有记忆。<br>让它参加一场「📓 读写」模式的讨论，或者点“编辑 / 植入”手动写一段。</p>';
    return;
  }
  $('#memLabel').innerHTML =
    `第 ${rev.version} 版 · ${SOURCE_LABEL[rev.source] || rev.source} · ${fmtTime(rev.createdAt)}` +
    (rev.threadTitle ? ` · <a class="ref" href="#/t/${rev.threadId}">打开议题</a>` : '');
  if ($('#memDiff').checked) {
    const lines = diffLines(revs[idx - 1]?.content ?? '', rev.content);
    $('#memContent').innerHTML = lines.length
      ? lines.map(([kind, text]) => `<div class="diff-line ${kind}">${esc(text) || '&nbsp;'}</div>`).join('')
      : '<p class="empty-note">（空白）</p>';
  } else {
    $('#memContent').innerHTML = rev.content.trim() ? `<div class="content">${md(rev.content)}</div>` : '<p class="empty-note">（空白）</p>';
  }
}

$('#memTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-key]');
  if (!tab) return;
  memState.key = tab.dataset.key;
  loadMemory().catch((err) => toast(err.message));
});
$('#memHistory').addEventListener('click', (e) => {
  const li = e.target.closest('[data-v]');
  if (!li) return;
  memState.version = Number(li.dataset.v);
  renderMemory();
});
$('#memDiff').addEventListener('change', renderMemory);
$('#memSpaceSelect').addEventListener('change', (e) => openMemory(memState.key, undefined, e.target.value));
$('#memClose').addEventListener('click', () => $('#memoryDialog').close());
$('#memLabel').addEventListener('click', (e) => {
  if (e.target.closest('a')) $('#memoryDialog').close();
});
$('#memEditBtn').addEventListener('click', () => {
  memState.editing = true;
  renderMemory();
  const ta = $('#memEditForm').content;
  ta.value = memState.revisions.at(-1)?.content ?? '';
  ta.focus();
});
$('#memEditCancel').addEventListener('click', () => {
  memState.editing = false;
  renderMemory();
});
$('#memEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    // 带上编辑开始时的版本号：期间若有 AI 写入新版本，服务器会拒绝，避免覆盖
    await api('PUT', `/api/memories/${encodeURIComponent(memState.key)}?space=${encodeURIComponent(memState.space)}`, {
      content: e.target.content.value,
      baseVersion: memState.revisions.at(-1)?.version ?? 0,
    });
    await openMemory(memState.key);
    toast('记忆本已保存为新版本', 'info');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 调用记录 ----------

const callsState = { list: [], runs: [], selected: null };
const PURPOSE = { discuss: '讨论', vote: '投票', draft: '起草' };
const STATUS = {
  ok: '成功', exit: 'CLI 报错', timeout: '超时', aborted: '被中止', spawn: '无法启动', empty: '回复为空',
  parse: '格式解析失败', duplicate: '重复（未计）', error: '程序错误', running: '进行中',
};
const isFailure = (c) => !['ok', 'duplicate', 'running'].includes(c.status);

async function openCalls(callId) {
  if (!state.current) return;
  $('#callsExport').href = `/api/threads/${state.current.id}/calls/export`;
  if (!$('#callsDialog').open) $('#callsDialog').showModal();
  [callsState.list, callsState.runs] = await Promise.all([
    api('GET', `/api/threads/${state.current.id}/calls`),
    api('GET', `/api/threads/${state.current.id}/runs`),
  ]);
  renderCallsList();
  const target = callId ?? callsState.selected ?? callsState.list.at(-1)?.id;
  if (target) showCall(target);
  else $('#callDetail').innerHTML = '<p class="empty-note">这个议题还没有调用记录。</p>';
}

function renderCallsList() {
  const failedOnly = $('#callsFailedOnly').checked;
  const list = callsState.list.filter((c) => !failedOnly || isFailure(c) || c.memoryConflict);
  const failures = callsState.list.filter(isFailure).length;
  const runs = callsState.runs
    .map((r) => `调度 #${r.id}（${r.kind === 'discuss' ? '讨论' : '表决间讨论'}，${r.order === 'random' ? `随机 · 种子 ${r.seed}` : '固定顺序'}）：${r.queue.map((id) => state.participants.find((p) => p.id === id)?.name ?? id).join('→')}`)
    .join('<br>');
  $('#callsHint').innerHTML = `共 ${callsState.list.length} 次调用，其中失败 ${failures} 次。${runs ? `<br>${runs}` : ''}`;
  $('#callsList').innerHTML = list.length
    ? [...list]
        .reverse()
        .map(
          (c) => `
          <li class="${c.id === callsState.selected ? 'active' : ''} ${isFailure(c) ? 'failed' : ''}" data-call-id="${c.id}" style="--c:${colorOf(c.participant.name)}">
            <span class="v">#${c.id}</span><span class="src">${PURPOSE[c.purpose] ?? c.purpose}</span>
            <span class="call-status ${c.status}">${STATUS[c.status] ?? c.status}</span>${c.memoryConflict ? '<span class="call-status conflict">记忆冲突</span>' : ''}${c.sealed ? '<span class="call-status">🔒</span>' : ''}
            <span class="from">${esc(c.participant.name)} · ${fmtTime(c.at)} · ${((c.durationMs ?? 0) / 1000).toFixed(1)}s</span>
          </li>`
        )
        .join('')
    : '<li>没有符合条件的记录</li>';
}

async function showCall(id) {
  callsState.selected = id;
  renderCallsList();
  const c = await api('GET', `/api/calls/${id}`);
  const floor = c.postId ? state.current.posts.findIndex((p) => p.id === c.postId) + 1 : 0;
  const row = (k, v) => (v === undefined || v === null || v === '' ? '' : `<tr><th>${k}</th><td>${v}</td></tr>`);
  const pre = (title, text, open = false) =>
    text ? `<details ${open ? 'open' : ''}><summary>${title}（${text.length} 字）</summary><pre>${esc(text)}</pre></details>` : '';
  const personaSrc = { global: '全局角色', thread: '本议题设定', 'thread-none': '本议题明确不设', none: '无' }[c.config?.personaSource] ?? '';
  const mem = c.memory || {};
  $('#callDetail').innerHTML = `
    <table class="call-table">
      ${row('状态', `<span class="call-status ${c.status}">${STATUS[c.status] ?? c.status}</span>${c.error ? ` ${esc(c.error)}` : ''}`)}
      ${row('用途', `${PURPOSE[c.purpose] ?? c.purpose}${c.proposalId ? ` · 提案 ${c.proposalId}` : ''}${c.round ? ` · 第 ${c.round} 轮` : ''}${c.version ? ` · 第 ${c.version} 版` : ''}`)}
      ${row('参与者', esc(c.participant.name))}
      ${row('时间', `${new Date(c.at).toLocaleString('zh-CN', { hour12: false })} · 共 ${((c.durationMs ?? 0) / 1000).toFixed(1)}s`)}
      ${row('结果', floor ? `<a class="ref" data-floor="${floor}" href="javascript:void 0">#${floor}</a>` : c.parsed?.pass ? '本轮无新增意见' : '')}
      ${row('配置的模型', `${esc(c.config?.model ?? '默认')}${c.config?.effort ? ` · effort ${esc(c.config.effort)}` : ''}`)}
      ${row('实际报告的模型', c.reported ? `${esc(c.reported.model ?? '?')}${c.reported.effort ? ` · ${esc(c.reported.effort)}` : ''}` : '')}
      ${row('角色', `${c.config?.persona ? esc(c.config.persona) : '（无）'} <small>— ${personaSrc}</small>`)}
      ${row('CLI', c.exec ? `${esc(c.exec.cliVersion ?? '版本未知')}<br><small>${esc(c.exec.file ?? '')}</small>` : '')}
      ${row('命令行参数', c.exec ? `<code>${esc(JSON.stringify(c.exec.args))}</code>` : '')}
      ${row('退出码', c.exec?.code)}
      ${row('记忆', mem.mode === 'off' ? '关闭' : mem.mode ? `${mem.mode === 'ro' ? '只读' : '读写'} · 空间「${esc(spaceName(mem.space))}」· 读第 ${mem.read} 版${c.memoryWrote ? ` → 写出第 ${c.memoryWrote} 版` : ''}${c.memoryConflict ? ` · <b class="warn">写入冲突（写入时已是第 ${c.memoryConflict.current} 版，未覆盖）</b>` : ''}` : '')}
      ${row('调度', c.runId ? `调度 #${c.runId}` : '')}
    </table>
    ${c.sealed ? '<p class="hint">🔒 密封投票还没揭晓，原始回复暂不公开。</p>' : ''}
    ${pre('被拦下的记忆本内容', c.memoryAttempt, true)}
    ${pre('原始回复', c.raw, true)}
    ${pre('实际送入的 prompt', c.prompt)}
    ${pre('stderr（末尾）', c.stderrTail, isFailure(c))}
    ${pre('stdout（末尾）', c.stdoutTail)}`;
}

$('#callsBtn').addEventListener('click', () => openCalls());
$('#callsClose').addEventListener('click', () => $('#callsDialog').close());
$('#callsFailedOnly').addEventListener('change', renderCallsList);
$('#callsList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-call-id]');
  if (li) showCall(Number(li.dataset.callId));
});
$('#callDetail').addEventListener('click', (e) => {
  const ref = e.target.closest('.ref');
  if (!ref) return;
  $('#callsDialog').close();
  $(`.post[data-floor="${ref.dataset.floor}"]`)?.scrollIntoView({ block: 'center' });
});

// ---------- 实时推送 ----------

function connect() {
  const es = new EventSource('/api/events');
  const foot = $('#connState');
  es.onopen = () => {
    foot.textContent = '已连接 · 本地服务';
    foot.classList.remove('bad');
  };
  es.onerror = () => {
    foot.textContent = '与服务器断开，重连中…';
    foot.classList.add('bad');
  };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    const cur = state.current;
    switch (ev.type) {
      case 'post':
        if (cur?.id === ev.post.threadId && !cur.posts.some((p) => p.id === ev.post.id)) {
          cur.posts.push(ev.post);
          renderPosts({ keepScroll: ev.post.kind !== 'human' });
        }
        refreshThreads();
        break;
      case 'post-updated': {
        // 密封投票揭晓：用完整的票替换"已投票"占位
        const i = cur?.id === ev.post.threadId ? cur.posts.findIndex((p) => p.id === ev.post.id) : -1;
        if (i >= 0) {
          cur.posts[i] = ev.post;
          renderPosts({ keepScroll: true });
        }
        break;
      }
      case 'space':
        if (!state.spaces.some((s) => s.id === ev.space.id)) state.spaces.push(ev.space);
        renderSpaceSelect();
        break;
      case 'call':
        if ($('#callsDialog').open && cur?.id === ev.call.threadId) {
          callsState.list = callsState.list.filter((c) => c.id !== ev.call.id).concat(ev.call);
          renderCallsList();
        }
        break;
      case 'post-deleted':
        if (cur?.id === ev.threadId) {
          cur.posts = cur.posts.filter((p) => p.id !== ev.postId);
          renderPosts({ keepScroll: true });
        }
        refreshThreads();
        break;
      case 'thread':
        refreshThreads();
        break;
      case 'thread-deleted':
        if (cur?.id === ev.threadId) location.hash = '';
        refreshThreads();
        break;
      case 'session':
        state.running.set(ev.threadId, ev);
        if (cur?.id === ev.threadId) {
          cur.session = ev;
          renderSeats();
          renderControls();
          renderPosts({ keepScroll: true });
        }
        renderThreads();
        break;
      case 'proposal':
        if (cur?.id === ev.proposal.threadId) {
          const list = (cur.proposals ||= []);
          const i = list.findIndex((p) => p.id === ev.proposal.id);
          if (i >= 0) list[i] = ev.proposal;
          else list.push(ev.proposal);
          renderControls();
          renderPosts({ keepScroll: true });
        }
        break;
      case 'thread-updated':
        if (cur?.id === ev.thread.id) {
          Object.assign(cur, ev.thread);
          $('#threadTitle').textContent = cur.title;
          renderControls();
        }
        refreshThreads();
        break;
      case 'memory':
        if ($('#memoryDialog').open && !memState.editing) openMemory(memState.key);
        break;
      case 'agent-error':
        toast(`${ev.agent} 发言失败：${ev.message}`);
        break;
      case 'order':
        state.orderMode = ev.mode;
        state.participants.sort((a, b) => ev.ids.indexOf(a.id) - ev.ids.indexOf(b.id));
        if (!drag?.started) renderSeats();
        renderControls();
        break;
      case 'participant':
        Object.assign(state.participants.find((x) => x.id === ev.participant.id) || {}, ev.participant);
        renderSeats();
        break;
    }
  };
}

await loadState();
connect();
route();
