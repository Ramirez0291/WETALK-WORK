// 手动派发：把任务交给指定的参与者执行（WP4 不做自动调度）。
// 认领（服务身份）→ 收集输入 → 按可见性组装提示词 → 保存任务包 → 调用 → 结果：
//   读资料的任务：解析 changes，经栅栏收稿并晋升；
//   密封类任务（密封起草、匿名评审、观众型读者）：结果只放进内存里的密封轮次，揭晓后才写盘。
// 每次调用（命令行 Agent 也算）都占项目的调用名额；调用记录写进 <项目>/calls.jsonl，密封期间只写占位。
import fs from 'node:fs';
import path from 'node:path';
import { WorkbenchError } from './project.mjs';
import { blobStore } from './records.mjs';
import { createCallLog } from '../calllog.mjs';
import { collectInputs, cleanConventions, savePacket, packetIdOf } from './packets.mjs';
import { VISIBILITY, visibilityOf, isSealed, renderPrompt, prepareWorkdir, anonymize, anonymityTerms, findNames, scrubNames } from './visibility.mjs';
import { vendorOf, vendorOfModel } from './vendors.mjs';

// 读资料的任务里，命令行 Agent（Codex）执行过的命令是否越出工作目录：找命令里的绝对路径和“..”。
// 这是启发式检查——相对路径加 cd 之类的写法查不出来，所以没查出越界只记为“未证实隔离”，不算证明
export function outsideWorkdir(toolEvents, workdir) {
  const root = path.resolve(workdir).toLowerCase();
  const hits = [];
  for (const t of toolEvents ?? []) {
    // 命令行里的路径可能是双反斜杠转义过的，先压成单个
    const text = [t.command, t.arguments ? JSON.stringify(t.arguments) : ''].filter(Boolean).join(' ').replace(/\\\\/g, '\\');
    if (t.type === 'mcp_tool_call') hits.push(`MCP 工具 ${t.server}/${t.tool}`);
    for (const m of text.matchAll(/[A-Za-z]:[\\/][^'"\s|;,)]*/g)) {
      const p = path.resolve(m[0]).toLowerCase();
      if (p !== root && !p.startsWith(root + path.sep)) hits.push(m[0]);
    }
    if (/(^|[\\/\s'"])\.\.([\\/\s'"]|$)/.test(text)) hits.push('..');
  }
  return [...new Set(hits)];
}

// 从回复里取第一个 ```json 代码块，内容必须是 changes 数组
export function parseChanges(raw) {
  const m = raw.match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) throw new Error('回复里没有 ```json 代码块');
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
  if (!Array.isArray(v) || !v.length) throw new Error('json 代码块必须是非空的 changes 数组');
  return v;
}

export function createRunner({
  workbench, gateway, board, usage, sealed,
  participants, // (id) => 参与者配置（含 resolved）
  runAgent, deepseek = null,
  workRoot, sandboxDir, templateText = '',
  timeoutMs = 300_000, now = () => new Date(), onEvent = () => {},
}) {
  const logs = new Map();
  const callLogOf = (project) => {
    if (!logs.has(project)) logs.set(project, createCallLog(path.join(workbench.get(project).dir, 'calls.jsonl')));
    return logs.get(project);
  };
  const running = new Map(); // `${project}/${task}` -> promise

  const terms = () => anonymityTerms([...(participants.all?.() ?? [])]);

  // 组装一次尝试的任务包。inline：输入直接写进提示词（API 参与者、MCP 外部会话、密封类任务）
  function buildParts(project, task, attempt, visibility, { inline }) {
    const p = workbench.get(project);
    const conventions = cleanConventions(p.conventions, templateText);
    let inputs = collectInputs({ gateway, project, task, visibility });
    let mapping = null;
    let convText = conventions;
    if (visibility === 'review') {
      // 匿名评审：方案换成随机标签，正文与元数据里的作者、模型、厂商一律隐去
      const t = terms();
      const anon = anonymize(inputs.map((i) => ({ ref: i.ref ?? i.name, text: i.text })), t);
      mapping = anon.mapping;
      inputs = anon.items.map((x) => ({ role: 'draft', ref: null, name: x.label, label: x.label, text: x.text }));
      convText = scrubNames(conventions, t);
    }
    const prompt = renderPrompt({ task, attempt, visibility, conventions: convText, inputs, inline });
    if (visibility === 'review') {
      const leaked = findNames(prompt, terms());
      if (leaked.length) throw new WorkbenchError(500, `匿名评审的提示词里仍有署名：${leaked.join('、')}，已拒绝发出`);
    }
    return { conventions: convText, inputs, prompt, mapping };
  }

  // MCP 外部会话认领：返回凭证和任务包（输入全部内联）。密封类任务只接受服务端收集，外部会话不能认领
  function claimExternal(project, taskId, holder) {
    const task = board.get(project, taskId);
    const visibility = visibilityOf(task);
    if (isSealed(visibility)) throw new WorkbenchError(409, `任务 ${taskId} 是${VISIBILITY[visibility].label}，只能由服务端派发、密封收集，外部会话不能认领`);
    const cred = board.claim(project, taskId, holder);
    try {
      const parts = buildParts(project, cred.task, cred.attempt, visibility, { inline: true });
      const packet = savePacket({ projectDir: workbench.get(project).dir, task: cred.task, attempt: cred.attempt, parts: { ...parts, visibility, config: workbench.get(project).config, participant: holder }, now });
      board.attachPacket(project, taskId, cred.attempt, packet.id);
      return { task: board.get(project, taskId), attempt: cred.attempt, lease_token: cred.lease_token, lease_until: cred.lease_until, packet: { id: packet.id, prompt: parts.prompt } };
    } catch (e) {
      board.failAttempt(project, taskId, cred, `组装任务包失败：${e.message}`);
      throw e;
    }
  }

  // 派发：立即返回，调用在后台进行
  function dispatch(project, taskId, participantId, { roundId = null } = {}) {
    const p = participants(participantId);
    if (!p) throw new WorkbenchError(404, `参与者 ${participantId} 不存在`);
    if (!p.resolved) throw new WorkbenchError(409, `参与者 ${p.name} 不可用（找不到命令或没有密钥）`);
    const task = board.get(project, taskId);
    const visibility = visibilityOf(task);
    if (visibility === 'export') throw new WorkbenchError(409, '导出任务在 WP7 实现');
    if (isSealed(visibility)) {
      roundId ??= sealed.roundOf(project, taskId) ?? `R-${taskId}`;
      if (!sealed.status(project, roundId)) sealed.open(project, roundId, [taskId]);
      else if (!sealed.accepts(project, roundId, taskId)) throw new WorkbenchError(409, `任务 ${taskId} 不在密封轮次 ${roundId} 里`);
    }
    const holder = { kind: 'server', participant: p.id, adapter: p.adapter, model: p.model ?? null, verified: true, basis: 'server-invoked' };
    const cred = board.claim(project, taskId, holder);
    const key = `${project}/${taskId}`;
    const job = execute(project, cred, p, visibility, roundId).finally(() => running.delete(key));
    running.set(key, job);
    return { task: board.get(project, taskId), attempt: cred.attempt, round: roundId, started: true };
  }

  async function execute(project, cred, p, visibility, roundId) {
    const task = cred.task;
    const attempt = cred.attempt;
    const packetId = packetIdOf(task.id, attempt);
    const api = p.adapter === 'deepseek';
    // 输入内联、不给任何工具：API 参与者，以及 Claude、Codex 这些命令行 Agent。
    // WP4 实测：给 Claude 开读类工具、或给 Codex 开 shell 时，它们都能读到工作目录以外的文件，工作目录不构成隔离。
    // 只有通用适配器（generic，自带的脚本）还用专用工作目录
    const inline = api || ['claude', 'codex'].includes(p.adapter) || VISIBILITY[visibility].input === 'stdin';
    const callLog = callLogOf(project);
    const call = {
      id: callLog.newId(), at: now().toISOString(), status: 'running', purpose: 'task', project, task: task.id, attempt, packet: packetId,
      visibility, sealed: isSealed(visibility), participant: { id: p.id, name: p.name },
      config: { adapter: p.adapter, model: p.model ?? null, effort: p.effort ?? null },
    };
    const controller = new AbortController();
    const untrack = board.track(project, task.id, controller);
    let workdir = null;
    let reservation = null;
    try {
      const parts = buildParts(project, task, attempt, visibility, { inline });
      let files = [];
      if (!inline) {
        const prepared = prepareWorkdir(workRoot, packetId, parts.inputs);
        workdir = prepared.dir;
        files = prepared.files;
      }
      savePacket({ projectDir: workbench.get(project).dir, task, attempt, parts: { ...parts, visibility, files, config: workbench.get(project).config, participant: call.config }, now });
      board.attachPacket(project, task.id, attempt, packetId);

      // 命令行 Agent 的调用同样占项目调用名额（API 调用由客户端按每次请求占用）
      if (!api) reservation = usage.reserve(project, { api: 'cli', attempt: 1, task: task.id, participant: p.id, purpose: 'task' });
      // retry：项目的生效配置（API 参与者的每次请求按它重试），和 Search、Fetch 一致
      const r = await runAgent(p, parts.prompt, {
        cwd: workdir ?? sandboxDir, timeoutMs, signal: controller.signal, mode: visibility, deepseek,
        retry: workbench.get(project).config.retry,
        hooks: api ? usage.hooks(project, { task: task.id, participant: p.id, purpose: 'task', model: p.model }) : undefined,
      });
      if (reservation) usage.settle(project, reservation, { ok: true, status: 0, usd: 0, usage: r.usage ?? null });
      reservation = null;
      call.status = 'ok';
      call.reported = { model: r.model ?? null, effort: r.effort ?? null, vendor: vendorOfModel(r.model) ?? vendorOf({ adapter: p.adapter }) };
      call.usage = r.usage ?? null;
      call.exec = stripTails(r.exec);

      if (isSealed(visibility)) {
        // 密封：结果只进内存；调用记录只写占位——没有回复正文、没有 stdout，审计也只记结论和数量
        // （工具参数、权限拒绝里的输入都可能带着草稿内容，揭晓时随正文补写）
        call.audit = sealedAudit(r.audit);
        // 先过栅栏：租约已过期、任务已被接手或取消的旧尝试迟到时，结果丢弃，不覆盖当前尝试
        if (!sealed.accepts(project, roundId, task.id) || !board.markSealed(project, task.id, cred, roundId, r.audit?.independence === 'unproven')) {
          call.status = 'stale';
          call.error = '凭证已不是当前值（租约过期、任务被接手或取消），迟到的密封结果已丢弃';
          finish(call, project);
          return;
        }
        sealed.put(project, roundId, task.id, { attempt, raw: r.raw, audit: r.audit ?? null, callId: call.id, reported: call.reported, mapping: parts.mapping, stdoutTail: r.exec?.stdoutTail ?? null });
        finish(call, project);
        return;
      }
      call.audit = r.audit ?? null;
      call.raw = r.raw;
      call.exec = r.exec;
      if (r.audit && workdir) {
        const outside = outsideWorkdir(r.audit.toolEvents, workdir);
        call.audit = { ...r.audit, isolation: outside.length ? 'violated' : r.audit.toolEvents.length ? 'unverified' : 'no-tools', outside };
      }
      finish(call, project);
      if (call.audit?.isolation === 'violated') {
        board.failAttempt(project, task.id, cred, `越出工作目录读取（${call.audit.outside.slice(0, 3).join('、')}），结果不予收稿`);
        return;
      }
      let changes;
      try {
        changes = parseChanges(r.raw);
      } catch (e) {
        board.failAttempt(project, task.id, cred, `结果无法解析：${e.message}`);
        return;
      }
      let receipt;
      try {
        receipt = gateway.receive(project, { request_id: `task:${packetId}`, task_id: task.id, attempt, lease_token: cred.lease_token, changes });
      } catch (e) {
        board.failAttempt(project, task.id, cred, `收稿被拒：${e.message}`);
        return;
      }
      if (receipt.state !== 'received') return; // 栅栏没通过（任务已取消或租约已过期）：存为历史草稿
      await gateway.promote(project, receipt.sid).catch(() => {}); // 成败都由提交入口回调任务状态
    } catch (e) {
      if (reservation) usage.settle(project, reservation, { ok: false, status: null, usd: 0, error: e.message });
      call.status = e.kind ?? 'error';
      // 密封类任务的失败信息可能带着部分输出（退出码报错里附的 stdout 尾部）：只留不含输出的说明
      call.error = isSealed(visibility) ? sealedError(e) : e.message;
      call.exec = isSealed(visibility) ? stripTails(e.details?.exec) : e.details?.exec ?? null;
      finish(call, project);
      board.failAttempt(project, task.id, cred, `调用失败（${call.status}）：${call.error}`);
    } finally {
      untrack();
      if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
    }
  }

  // 密封期间调用记录里的审计：独立性结论和工具事件的数量，不含任何参数
  function sealedAudit(audit) {
    if (!audit) return null;
    return { independence: audit.independence ?? null, toolEvents: audit.toolEvents?.length ?? 0, permissionDenials: audit.permission_denials?.length ?? 0, detail: 'sealed' };
  }

  // 工坊自己的报错（组装任务包等）和这几类调用错误的说明不含 Agent 输出；其余只给退出码
  function sealedError(e) {
    if (e instanceof WorkbenchError || ['timeout', 'aborted', 'spawn'].includes(e.kind)) return e.message;
    const code = e.details?.exec?.code ?? e.details?.code;
    return `${code != null ? `退出码 ${code}；` : ''}密封期间不记录报错原文（可能含部分输出）`;
  }

  function stripTails(exec) {
    if (!exec) return null;
    const { stdoutTail, stderrTail, ...rest } = exec;
    return rest;
  }

  function finish(call, project) {
    call.endedAt = now().toISOString();
    call.durationMs = Date.parse(call.endedAt) - Date.parse(call.at);
    callLogOf(project).append(call);
    onEvent({ type: 'call', project, id: call.id, task: call.task, status: call.status }); // 事件里不带任何正文
  }

  // 揭晓：把密封轮次的结果写盘（正文 blob、调用记录补写、任务完成），并公开匿名标签的对应关系
  function reveal(project, roundId) {
    const results = sealed.reveal(project, roundId);
    const blobs = blobStore(workbench.get(project).dir);
    const out = [];
    for (const [taskId, r] of results) {
      const text_blob = blobs.put(r.raw);
      callLogOf(project).append({ fill_of: r.callId, at: now().toISOString(), purpose: 'reveal', project, task: taskId, raw: r.raw, audit: r.audit, stdoutTail: r.stdoutTail });
      board.completeSealed(project, taskId, { text_blob, independence: r.audit?.independence ?? 'clean', mapping: r.mapping ?? null });
      out.push({ task: taskId, text_blob, independence: r.audit?.independence ?? 'clean', mapping: r.mapping ?? null });
    }
    onEvent({ type: 'reveal', project, round: roundId });
    return { round: roundId, results: out };
  }

  const idle = () => Promise.allSettled([...running.values()]);
  return { dispatch, claimExternal, reveal, idle, callLogOf, buildParts };
}
