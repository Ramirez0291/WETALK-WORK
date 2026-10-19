// 分工（WP5b）：把一组输入拆成互不重叠的几份，每份一个子任务、派给一个参与者；结果照常经提交入口汇总为来源卡和论断。
// “互不重叠”由程序保证，而不是靠提示词：
// - 拆分时每项输入（记录或条目）恰好分到一份；
// - 晋升时提交入口检查子任务只写自己那一份：改动的记录、引用的记录、核验与异议的目标都要在这一份的输入里
//   （论断输入连同它所引的来源），新建的来源卡不能与已有来源同一地址（commit.mjs 3c）。
// 分工的信息记在每个子任务上（division：编号、第几份、共几份、分到的条目），不另建文件。
// 分到的条目整份作为任务输入（正文存成 blob，进任务包、内联进提示词），不塞进 goal：goal 有长度上限，不能截掉分到的材料。
import { WorkbenchError } from './project.mjs';
import { blobStore } from './records.mjs';

const MAX_ITEMS = 500;
const MAX_ITEMS_CHARS = 200_000;
const MAX_GOAL = 3000;
const TASK_GOAL_LIMIT = 4000; // tasks.mjs 只收这么长的 goal

const bad = (status, msg) => new WorkbenchError(status, msg);
const keyOf = (u) => (u.input ? `${u.input.id}` : `item:${u.item.replace(/\s+/g, ' ').trim().toLowerCase()}`);

// 轮流分配：第 i 项分给第 i % n 份
export function partition(units, n) {
  const parts = Array.from({ length: Math.min(n, units.length) }, () => []);
  units.forEach((u, i) => parts[i % parts.length].push(u));
  return parts;
}

export function createDivisions({ workbench, gateway, board, runner, participants }) {
  function nextId(project) {
    let max = 0;
    for (const t of board.list(project)) if (t.division) max = Math.max(max, Number(t.division.id.slice(2)));
    return `DV${String(max + 1).padStart(3, '0')}`;
  }

  // spec：{ type, title, goal, inputs: [{id, version}], items: [文本], participants: [id…],
  //         assignments?: [{ participant, inputs?, items? }] }（不给 assignments 就轮流分配）
  function create(project, spec, host) {
    const config = workbench.get(project).config;
    if (!spec || typeof spec !== 'object') throw bad(400, '请求体必须是对象');
    const types = Object.entries(config.modes).filter(([, m]) => m === 'divide').map(([t]) => t);
    if (!types.includes(spec.type)) throw bad(400, `${spec.type ?? '（没写类型）'} 不是分工方式的任务类型（modes 里是 divide 的：${types.join('、')}）`);
    const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 150) : spec.type;
    if (spec.goal != null && typeof spec.goal !== 'string') throw bad(400, 'goal 必须是字符串');
    const goal = spec.goal ?? '';
    if (goal.length > MAX_GOAL) throw bad(400, `goal 超过 ${MAX_GOAL} 字`);

    // 全部输入：正式记录固定为当前版本；条目（例如待找资料的子题、网址）去掉首尾空白
    const inputOf = (x, where) => {
      if (!x || typeof x.id !== 'string' || !Number.isInteger(x.version)) throw bad(400, `${where} 必须是 {id, version}`);
      const cur = gateway.getRecord(project, x.id).record.version;
      if (cur !== x.version) throw bad(409, `${x.id} 当前是第 ${cur} 版，不是第 ${x.version} 版`);
      return { id: x.id, version: x.version };
    };
    const itemOf = (s, where) => {
      if (typeof s !== 'string' || !s.trim()) throw bad(400, `${where} 必须是非空文字`);
      if (s.length > 500) throw bad(400, `${where} 超过 500 字`);
      return s.trim();
    };
    const units = [
      ...(Array.isArray(spec.inputs) ? spec.inputs : []).map((x, i) => ({ input: inputOf(x, `inputs[${i}]`) })),
      ...(Array.isArray(spec.items) ? spec.items : []).map((s, i) => ({ item: itemOf(s, `items[${i}]`) })),
    ];
    if (!units.length) throw bad(400, '没有要分的输入：给 inputs（记录）或 items（条目）');
    const itemUnits = units.filter((u) => u.item);
    if (itemUnits.length > MAX_ITEMS) throw bad(400, `条目最多 ${MAX_ITEMS} 项，现在是 ${itemUnits.length} 项`);
    if (itemUnits.reduce((n, u) => n + u.item.length, 0) > MAX_ITEMS_CHARS) throw bad(400, `条目合计超过 ${MAX_ITEMS_CHARS} 字`);
    const seen = new Set();
    for (const u of units) {
      if (seen.has(keyOf(u))) throw bad(400, `${u.input ? u.input.id : `条目“${u.item}”`} 出现了两次：分工的各份不能重叠`);
      seen.add(keyOf(u));
    }

    let parts;
    if (Array.isArray(spec.assignments) && spec.assignments.length) {
      // 指定的分配：每项输入恰好出现在一份里，不多不少
      parts = spec.assignments.map((a, i) => ({
        participant: String(a?.participant ?? ''),
        units: [
          ...(Array.isArray(a?.inputs) ? a.inputs : []).map((x, j) => ({ input: inputOf(x, `assignments[${i}].inputs[${j}]`) })),
          ...(Array.isArray(a?.items) ? a.items : []).map((s, j) => ({ item: itemOf(s, `assignments[${i}].items[${j}]`) })),
        ],
      }));
      const count = new Map();
      for (const p of parts) for (const u of p.units) count.set(keyOf(u), (count.get(keyOf(u)) ?? 0) + 1);
      for (const u of units) {
        const c = count.get(keyOf(u)) ?? 0;
        if (c !== 1) throw bad(400, `${u.input ? u.input.id : `条目“${u.item}”`} ${c ? `分到了 ${c} 份` : '没有分到任何一份'}：每项输入要恰好分到一份`);
      }
      for (const k of count.keys()) if (!seen.has(k)) throw bad(400, `分配里有不在输入清单里的项：${k.replace(/^item:/, '')}`);
      if (parts.some((p) => !p.units.length)) throw bad(400, '每一份至少分到一项');
    } else {
      const ids = (Array.isArray(spec.participants) ? spec.participants : []).map(String);
      if (!ids.length) throw bad(400, 'participants 至少一位');
      parts = partition(units, ids.length).map((u, i) => ({ participant: ids[i], units: u }));
    }
    const who = parts.map((p) => p.participant);
    if (new Set(who).size !== who.length) throw bad(400, '同一位参与者只能分到一份');
    for (const id of who) {
      const p = participants(id);
      if (!p) throw bad(404, `参与者 ${id} 不存在`);
      if (!p.resolved) throw bad(409, `参与者 ${p.name ?? id} 不可用（找不到命令或没有密钥）`);
    }

    const dv = nextId(project);
    const n = parts.length;
    // 先把每份的任务内容全部算好、检查长度，再建任何一个任务：不会建了一半才发现超限
    const blobs = blobStore(workbench.get(project).dir);
    const specs = parts.map((p, i) => {
      const inputs = p.units.filter((u) => u.input).map((u) => u.input);
      const items = p.units.filter((u) => u.item).map((u) => u.item);
      // 条目整份作为输入：任务包按内容 hash 存档，提示词里原样内联
      const itemsInput = items.length
        ? [{ blob: blobs.put(`# 分工 ${dv} 第 ${i + 1}/${n} 份：分给你的条目（共 ${items.length} 项）\n\n${items.map((x) => `- ${x}`).join('\n')}\n`), name: `分工${dv}-第${i + 1}份-条目.md` }]
        : [];
      const taskGoal = [
        goal,
        `这是分工 ${dv} 的第 ${i + 1}/${n} 份：只处理分给你的这一部分，其他部分由别人负责。`,
        inputs.length ? `分给你的记录：共 ${inputs.length} 条，见输入。` : '',
        items.length ? `分给你的条目：共 ${items.length} 项，见输入里的条目清单。` : '',
        '提交入口会拒绝越出这一份的写入：改动或引用别的部分的记录、针对别的部分的核验或异议，以及与已有来源同一地址的新来源卡。',
      ].filter(Boolean).join('\n');
      if (taskGoal.length > TASK_GOAL_LIMIT) throw bad(400, `第 ${i + 1} 份的任务说明有 ${taskGoal.length} 字，超过 ${TASK_GOAL_LIMIT} 字：缩短 goal`);
      return { spec: { type: spec.type, title: `${title}（分工 ${dv}，第 ${i + 1}/${n} 份）`, goal: taskGoal, inputs: [...inputs, ...itemsInput], assigned_to: p.participant }, division: { id: dv, part: i + 1, of: n, title, items } };
    });
    const tasks = specs.map((x) => board.create(project, x.spec, { created_by: host, internal: { division: x.division } }));
    const dispatched = tasks.map((t) => {
      try {
        runner.dispatch(project, t.id, t.assigned_to);
        return { task: t.id, dispatched: true };
      } catch (e) {
        return { task: t.id, dispatched: false, error: e.message };
      }
    });
    return { ...list(project).find((d) => d.id === dv), dispatched };
  }

  // 各次分工的进度与汇总结果（每份写进了哪些记录）
  function list(project) {
    const groups = new Map();
    for (const t of board.list(project)) {
      if (!t.division) continue;
      if (!groups.has(t.division.id)) groups.set(t.division.id, { id: t.division.id, type: t.type, title: t.division.title, of: t.division.of, parts: [] });
      groups.get(t.division.id).parts.push({
        part: t.division.part, task: t.id, participant: t.assigned_to, state: t.state,
        inputs: t.inputs.filter((x) => x.id), items: t.division.items ?? [], records: t.result?.records ?? [], reason: t.history.at(-1)?.reason ?? null,
      });
    }
    return [...groups.values()].map((g) => ({ ...g, parts: g.parts.sort((a, b) => a.part - b.part), done: g.parts.filter((p) => p.state === 'done').length }));
  }

  return { create, list };
}
