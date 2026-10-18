// 由实际模型或适配器推断厂商。核验者必须与论断作者分属不同厂商（契约一），所以这里宁可给 unknown，也不猜。
// 模型 id 优先（CLI 报告的实际模型）；没有模型时才看适配器。agy 能调用别家模型，只有模型 id 是 gemini* 才算 google。
const BY_MODEL = [
  [/^claude/i, 'anthropic'],
  [/^(gpt|o\d|codex|chatgpt)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^deepseek/i, 'deepseek'],
];
const BY_ADAPTER = { claude: 'anthropic', codex: 'openai', deepseek: 'deepseek' };

export function vendorOfModel(model) {
  if (typeof model !== 'string' || !model) return null;
  for (const [re, v] of BY_MODEL) if (re.test(model)) return v;
  return null;
}

// holder：{ kind, model?, adapter?, vendor? }。人类没有厂商（human），其余推断不出时为 unknown
export function vendorOf(holder) {
  if (!holder) return 'unknown';
  if (holder.kind === 'human') return 'human';
  return vendorOfModel(holder.model) ?? (holder.adapter && holder.adapter !== 'agy' ? BY_ADAPTER[holder.adapter] : null) ?? 'unknown';
}
