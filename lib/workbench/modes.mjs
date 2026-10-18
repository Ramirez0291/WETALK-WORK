// 工作方式（WP5）：各任务类型的提示词模板（输出要求）与结果解析。提示词模板随这里维护。
// 5a：对抗核验（verify_claim）、补证（find_evidence）。分工、竞争在 5b 加入。
import { WorkbenchError } from './project.mjs';

// 任务类型 → 输出要求（替换 visibility.mjs 里按可见性给的通用要求）
export const TASK_OUTPUT = {
  verify_claim: `你的角色：对抗核验者。你和论断的作者来自不同厂商，任务是找反例和证据缺口，而不是替论断辩护。
核验规则：
- 只根据上面给出的来源正文判断，不要用你自己的知识补充证据；正文里找不到支持的原文，就判 unsupported（证据不足也算）。
- 引文出现在来源里不等于支持结论。例如来源写“没有证据表明 A 导致 B”，论断写“A 导致 B”，应判 unsupported。
- 文献记载类论断（textual）还要核对“最早出处”是否被来源支持，警惕把晚出的记载说成更早的传说。
- 判为 supported 时，support_quote 必须是来源正文里逐字出现的一段，并写明来源编号和版本。
- 发现三类事实性问题时另提异议：来源不存在（source_missing）、数字错误（number_error）、引文不支持结论（quote_unsupported）。
  能在来源正文里定位到原文的，state 写 open，pointer 写 {"type":"quote","source":{"id":"S001","version":1},"quote":"原文"}；
  发现了问题但定位不到原文的，state 写 needs_evidence，pointer 写 {"type":"location","locator":"问题所在的位置描述"}。
  解释争议（interpretation）、叙事选择（narrative）、可选扩展（extension）也可以提，不阻塞。
输出格式：只输出一个 \`\`\`json 代码块，内容是一个对象：
{"verdict":"supported 或 unsupported","reason":"理由","support_quote":{"id":"S001","version":1,"quote":"逐字原文","locator":"可选的位置"},"objections":[{"category":"number_error","pointer":{…},"reason":"问题在哪里","state":"open"}]}
判 unsupported 时不写 support_quote；没有异议时 objections 写空数组。`,

  find_evidence: `输出要求：
- 只在上面给出的来源正文里找，不要用你自己的知识，也不要编造引文。
- 找到了能定位的原文：输出一个 \`\`\`json 代码块，内容是提交入口的 changes 数组，只含一项：把异议改为 open 并补上有效指针，例如
  [{"id":"O001","expected_version":1,"data":{"target":{…原样…},"category":"…原样…","pointer":{"type":"quote","source":{"id":"S001","version":1},"quote":"逐字原文"},"reason":"…原样或补充…","state":"open"}}]
  expected_version 写异议的当前版本；target、category 不能改。
- 找不到：不要输出 json 代码块，直接说明你查了哪些来源、为什么定位不到。`,
};

export const outputFor = (task) => TASK_OUTPUT[task.type] ?? null;

// 从回复里取第一个 ```json 代码块并解析
function firstJson(raw) {
  const m = raw.match(/```json\s*\n([\s\S]*?)```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`json 代码块解析失败：${e.message}`);
  }
}

// 对抗核验的结果 → 提交入口的 changes。目标版本与来源版本取任务输入里的论断版本（不采信回复里自填的版本）。
// claim：任务输入指定版本的论断记录
export function verifyResultToChanges(raw, claim) {
  const v = firstJson(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('回复里没有核验结果对象（```json 代码块）');
  const target = { id: claim.id, version: claim.version };
  const data = {
    target,
    source_versions: (claim.sources || []).map((s) => ({ id: s.id, version: s.version })),
    verdict: v.verdict,
    reason: v.reason,
  };
  if (v.verdict === 'supported') data.support_quote = v.support_quote;
  const changes = [{ kind: 'verification', expected_version: 0, data }];
  for (const o of Array.isArray(v.objections) ? v.objections : []) {
    changes.push({ kind: 'objection', expected_version: 0, data: { target, category: o?.category, pointer: o?.pointer, reason: o?.reason, state: o?.state } });
  }
  return changes;
}

// 补证：找不到时回复里没有 json 代码块，这一次补证就此结束。只能更新任务针对的那条异议
export function evidenceResultToChanges(raw, objectionId) {
  const v = firstJson(raw);
  if (v == null) throw new Error('没有找到可定位的原文');
  if (!Array.isArray(v) || v.length !== 1) throw new Error('json 代码块必须是只含一项的 changes 数组');
  if (v[0]?.id !== objectionId) throw new WorkbenchError(400, `补证任务只能更新异议 ${objectionId}`);
  return v;
}
