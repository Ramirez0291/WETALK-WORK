// 表决：规则、计票、结果分类、投票 / 起草替代方案的 prompt 与解析。
// 写 prompt 时刻意保持中立：既不催促妥协达成共识，也不鼓励为反对而反对——这是要观察的变量本身。
// "未形成决议"被当作正常结果：投票者可以建议结束，起草人可以拒绝为了凑轮次而改写措辞。
import { formatTranscript, memorySection, splitMemory, aliasLabeler, formatBallot, CHOICE_LABEL, FACT_LABEL, BASIS_LABEL, AgentError } from './agents.mjs';

// 接受 = 赞成 + 保留异议（保留异议的人不同意或有保留，但不阻止通过）
const acceptOf = (t) => t.yes + t.reserve;

export const RULES = {
  consensus: {
    label: '共识',
    desc: '没有反对票，且至少一人接受（赞成或保留异议）即通过；保留异议和弃权都不阻止通过，反对等于否决',
    pass: (t) => t.no === 0 && acceptOf(t) > 0,
  },
  supermajority: {
    label: '三分之二多数',
    desc: '接受（赞成 + 保留异议）不少于投票总数的 2/3 即通过（弃权计入总数）',
    pass: (t) => acceptOf(t) > 0 && acceptOf(t) * 3 >= t.total * 2,
  },
  majority: {
    label: '简单多数',
    desc: '接受（赞成 + 保留异议）超过投票总数的一半即通过（弃权计入总数）',
    pass: (t) => acceptOf(t) * 2 > t.total,
  },
};

// ---------- 计票与分类 ----------

export function tally(votes, rule) {
  const t = { yes: 0, reserve: 0, no: 0, abstain: 0, total: votes.length, endVotes: 0, evidence: [], facts: {}, bases: {} };
  for (const p of votes) {
    const v = p.vote;
    t[v.choice] = (t[v.choice] ?? 0) + 1;
    if (v.suggestEnd) t.endVotes++;
    if (v.evidence) t.evidence.push({ voter: p.author, request: v.evidence });
    if (v.fact) t.facts[v.fact] = (t.facts[v.fact] ?? 0) + 1;
    if (v.basis && (v.choice === 'yes' || v.choice === 'reserve')) t.bases[v.basis] = (t.bases[v.basis] ?? 0) + 1;
  }
  t.accept = acceptOf(t);
  t.passed = RULES[rule].pass(t);
  t.notes = classify(t);
  return t;
}

// 借用议会里常见的几种局面来描述结果，而不只是"通过 / 不通过"
function classify(t) {
  const notes = [];
  const factKinds = Object.keys(t.facts);
  if (factKinds.length === 1) notes.push(factKinds[0] === 'agree' ? 'facts-agree' : `facts-same-${factKinds[0]}`);
  else if (factKinds.length > 1) notes.push('facts-differ');
  if (t.passed) {
    if (t.reserve === 0 && t.no === 0) notes.push('unanimous');
    else if (t.no === 0) notes.push('reserved'); // 仍有分歧，但没有人否决
    else notes.push('over-objection'); // 多数规则下带着反对票通过
    if (Object.keys(t.bases).length > 1) notes.push('bases-differ'); // 接受同一方案，但理由不同
  }
  return notes;
}

export const NOTE_LABEL = {
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

// 一轮结束后的去向
export function decideOutcome(t, { round, maxRounds }) {
  if (t.passed) return 'passed';
  if (t.total && t.endVotes * 2 > t.total) return 'concluded'; // 过半数建议结束：分歧保留，正常结束
  if (t.evidence.length) return 'evidence'; // 有人请求证据：等主持人补充
  if (round >= maxRounds) return 'deadlock';
  return 'next';
}

// 历次表决的简表，给后面的投票者和起草人看
function historyText(proposal) {
  const closed = proposal.rounds.filter((r) => r.result?.total != null);
  if (!closed.length) return '';
  const lines = closed.map((r) => {
    const x = r.result;
    return `- 第 ${r.round} 轮（针对第 ${r.version} 版）：赞成 ${x.yes} · 保留异议 ${x.reserve ?? 0} · 反对 ${x.no} · 弃权 ${x.abstain} → ${x.passed ? '通过' : '未通过'}`;
  });
  return `历次表决：\n${lines.join('\n')}\n`;
}

function personaLine(me) {
  return me.persona ? `\n你在本议题中代表的立场 / 出发点：${me.persona}\n` : '';
}

// ---------- 投票 ----------

// hide：密封投票时隐藏本轮其他人的票；memory 同 buildPrompt
export function buildVotePrompt({ me, thread, proposal, round, voterNames, maxChars, memory, hide }) {
  const label = aliasLabeler(thread.posts);
  const version = proposal.versions[round.version - 1];
  const rule = RULES[proposal.rule];
  const mem = memorySection(memory, '投票');
  const sealed = proposal.ballot === 'sealed';
  return `你正在参加一个名为 WeTalk 的本地研讨会，现在进入表决环节。你是「${label(me)}」。
${personaLine(me)}${mem.rules ? '\n' + mem.rules : ''}
${mem.block}
======== 议题：${thread.title} ========
${formatTranscript(thread.posts, maxChars, hide)}
======== 讨论记录结束 ========

======== 待表决：第 ${version.version} 版${version.version > 1 ? '（替代方案）' : ''}，第 ${round.round} 轮表决 ========
${version.text.trim()}
======== 提案结束 ========

${historyText(proposal)}表决规则：${rule.label}——${rule.desc}。
投票者共 ${voterNames.length} 位：${voterNames.join('、')}。
投票方式：${sealed ? '密封投票。你看不到本轮其他人的投票，所有票会在全部投完后同时公开。' : '公开唱票。本轮已经投出的票都在上面的记录里。'}
最多 ${proposal.maxRounds} 轮，这是第 ${round.round} 轮。未通过时可能起草替代方案再表决；也可能就此结束——"未形成决议"同样是一种正常的结果。

可以投的立场：
- 赞成：支持这份提案。
- 保留异议：你不同意或有保留，但不阻止它通过；你的异议会被记录。
- 反对：你不能接受${proposal.rule === 'consensus' ? '（在共识规则下，一张反对票就会否决提案）' : ''}。
- 弃权：不表态。

请根据你的立场和你对这份提案本身的判断投票。"对提案事实前提的判断"和"是否支持"请分开回答：你可以认同事实却不支持方案，也可以反过来。
不要调用任何工具，不要读写文件。

只按下面的格式输出${mem.ask ? '' : '，不要输出其它内容'}：
<<<投票>>>
立场：赞成 / 保留异议 / 反对 / 弃权（四选一）
信心：0–100 的整数（你对这个选择有多确定）
事实判断：同意 / 部分同意 / 不同意 / 不确定（你是否认同提案所依据的关键事实与预测）
主要依据：事实 / 价值 / 利益 / 程序 / 其他（你的立场主要出于哪一类考虑）
理由：（200 字以内，写出起决定作用的考虑）
转为赞成的条件：（不是赞成时，写出能让你改投赞成的最小修改；如果没有任何修改能让你赞成，就直说；赞成时写"无"）
请求证据：（如果需要某项具体证据才能判断，写出需要什么；不需要写"无"）
建议结束：是 / 否（是否认为应当就此结束表决，不再起草新版本）${mem.ask}`;
}

const LABELS = ['立场', '信心', '事实判断', '主要依据', '理由', '转为赞成的条件', '条件', '请求证据', '建议结束'];
const LABEL_RE = new RegExp(`^[\\s>*-]*(${LABELS.join('|')})\\s*[:：]`, 'gm');

// 按"标签：内容"切分，容忍 Markdown 加粗、全角冒号、字段顺序变化
function fieldsOf(text) {
  const out = {};
  const marks = [...text.matchAll(LABEL_RE)];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const key = m[1] === '条件' ? '转为赞成的条件' : m[1];
    if (!(key in out)) out[key] = text.slice(start, end).trim();
  });
  return out;
}

const NONE_RE = /^[（(]?\s*(无|没有|不需要|不用|不适用|N\/?A)\s*[）)。.]?$/i;

function choiceOf(s = '') {
  if (/保留(异议|意见)|接受但/.test(s)) return 'reserve';
  if (/^[「“"\s]*反对/.test(s)) return 'no';
  if (/^[「“"\s]*弃权/.test(s)) return 'abstain';
  if (/^[「“"\s]*赞成/.test(s)) return 'yes';
  return null;
}

function factOf(s = '') {
  if (/不同意/.test(s)) return 'disagree';
  if (/部分/.test(s)) return 'partial';
  if (/不确定|无法判断/.test(s)) return 'unsure';
  if (/同意|认同/.test(s)) return 'agree';
  return null;
}

function basisOf(s = '') {
  const map = { 事实: 'fact', 价值: 'value', 利益: 'interest', 程序: 'procedure', 其他: 'other' };
  const hit = Object.keys(map).find((k) => s.startsWith(k)) ?? Object.keys(map).find((k) => s.includes(k));
  return hit ? map[hit] : null;
}

export function parseVote(raw, expectMemory) {
  const { body, memory } = splitMemory(raw, expectMemory);
  const text = (body.split(/<<<\s*投票\s*>>>/)[1] ?? body).replace(/\*\*/g, '');
  const f = fieldsOf(text);
  const choice = choiceOf(f['立场']);
  if (!choice) throw new AgentError('parse', `没能从回复里解析出投票立场：${text.trim().slice(0, 120)}`);
  const conf = Number(f['信心']?.match(/\d{1,3}/)?.[0]);
  const condition = f['转为赞成的条件'] ?? '';
  const evidence = f['请求证据'] ?? '';
  return {
    choice,
    confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, conf)) : null,
    fact: factOf(f['事实判断']),
    basis: basisOf(f['主要依据']),
    reason: f['理由'] ?? '',
    condition: NONE_RE.test(condition) ? '' : condition,
    evidence: NONE_RE.test(evidence) ? '' : evidence,
    suggestEnd: /^[「“"\s]*是/.test(f['建议结束'] ?? ''),
    memory,
  };
}

// ---------- 起草替代方案 ----------

export function buildDraftPrompt({ me, thread, proposal, lastVotes, maxChars }) {
  const label = aliasLabeler(thread.posts);
  const rule = RULES[proposal.rule];
  const current = proposal.versions[proposal.versions.length - 1];
  const ballots = lastVotes
    .map((v) => {
      const conf = v.vote.confidence != null ? `，信心 ${v.vote.confidence}` : '';
      return `- ${v.author}${v.kind === 'human' ? '（人类）' : ''}：${CHOICE_LABEL[v.vote.choice]}${conf}\n  ${formatBallot(v.vote, v.content).replace(/\n/g, '\n  ')}`;
    })
    .join('\n');
  return `你正在参加一个名为 WeTalk 的本地研讨会。上一轮表决中，提案第 ${current.version} 版没有通过。现在由你（「${label(me)}」）决定是否起草替代方案，之后所有投票者会对它重新表决。
${personaLine(me)}
======== 议题：${thread.title} ========
${formatTranscript(thread.posts, maxChars)}
======== 讨论记录结束 ========

======== 未通过的第 ${current.version} 版 ========
${current.text.trim()}
======== 结束 ========

${historyText(proposal)}最近一轮各方的投票：
${ballots}

表决规则：${rule.label}——${rule.desc}。最多 ${proposal.maxRounds} 轮，下一轮是第 ${proposal.rounds.length + 1} 轮。

你的任务：起草一份新的替代方案。你有自己的立场，起草时可以坚持你认为不能让步的部分；同时，这份方案需要在上面的规则下获得足够的支持才能通过，所以要认真对待反对者给出的条件。如果各方的条件互相冲突，写清楚你的取舍。
如果你判断分歧无法通过修改方案来弥合（例如它来自根本的价值冲突），也可以不起草——只换措辞而不改变实质，并不能真正解决分歧。不起草时，表决会以"分歧保留、未形成决议"结束，这是正常的结果。
不要调用任何工具，不要读写文件。

起草时只按下面的格式输出：
<<<替代方案>>>
（完整的新提案文本，可以用 Markdown；写出完整方案，不要只列修改点）
<<<修改说明>>>
（100–200 字：相对上一版改了什么，分别回应了谁的哪条意见，没有采纳哪些、为什么）

不起草时只输出：
<<<不起草>>>
（100–200 字：为什么认为分歧无法通过修改弥合，各方真正的分歧点是什么）`;
}

export function parseDraft(raw) {
  const decline = raw.match(/\**<<<\s*不起草\s*>>>\**([\s\S]*)/);
  if (decline) return { declined: true, reason: decline[1].trim() };
  const parts = raw.split(/\**<<<\s*(替代方案|修改说明)\s*>>>\**/);
  // split 带捕获组：[前文, 标记1, 内容1, 标记2, 内容2, ...]
  const get = (name) => {
    const i = parts.indexOf(name);
    return i >= 0 ? parts[i + 1].trim() : '';
  };
  const text = get('替代方案');
  if (!text) throw new AgentError('parse', `没能从回复里解析出替代方案：${raw.trim().slice(0, 120)}`);
  return { declined: false, text, rationale: get('修改说明') };
}

// ---------- 结果说明 ----------

export function resultText({ round, version, t, rule, outcome, maxRounds, discussRounds }) {
  const counts = `赞成 ${t.yes} · 保留异议 ${t.reserve} · 反对 ${t.no} · 弃权 ${t.abstain}`;
  const head = `第 ${round} 轮表决（第 ${version} 版）：${counts}，按「${RULES[rule].label}」规则${t.passed ? '**通过**' : '**未通过**'}。`;
  const notes = t.notes.map((n) => NOTE_LABEL[n]).filter(Boolean);
  const extra = [];
  if (notes.length) extra.push(`局面：${notes.join('；')}。`);
  if (t.evidence.length) extra.push(`请求证据：${t.evidence.map((e) => `${e.voter}——${e.request}`).join('；')}`);
  const next = {
    passed: `提案以第 ${version} 版通过。`,
    concluded: `过半数投票者建议结束：分歧保留，未形成决议。`,
    evidence: '有投票者请求证据，等待主持人补充后再决定下一步。',
    deadlock: `已进行到最多 ${maxRounds} 轮：分歧保留，未形成决议。`,
    next: discussRounds ? `接下来先讨论 ${discussRounds} 轮，再起草替代方案。` : '接下来起草替代方案。',
  }[outcome];
  return [head, ...extra, next].join('\n');
}

export { CHOICE_LABEL, FACT_LABEL, BASIS_LABEL };
