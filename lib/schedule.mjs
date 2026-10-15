// 发言 / 唱票顺序。随机顺序使用带种子的伪随机数：同一个种子能重现同样的顺序
// （只保证顺序可重现，模型的回答本身并不能逐字重现）。

// mulberry32：小而快的 32 位 PRNG，足够用来洗牌
export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

// 种子可以是数字或任意文本（文本会被哈希成数字）
export function normalizeSeed(input) {
  if (input === undefined || input === null || input === '') return newSeed();
  if (/^\d+$/.test(String(input))) return Number(input) % 2 ** 31;
  let h = 2166136261;
  for (const ch of String(input)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h % 2 ** 31;
}

export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 多轮队列：固定顺序按座位；随机则每轮重新洗牌，并避免同一位在两轮交界处连续发言
export function buildQueue(ids, rounds, order, rng) {
  const queue = [];
  for (let r = 0; r < rounds; r++) {
    const turn = order === 'random' ? shuffle(ids, rng) : [...ids];
    if (order === 'random' && turn.length > 1 && turn[0] === queue[queue.length - 1]) turn.push(turn.shift());
    queue.push(...turn);
  }
  return queue;
}
