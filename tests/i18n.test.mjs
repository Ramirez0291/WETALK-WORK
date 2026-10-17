import test from 'node:test';
import assert from 'node:assert/strict';
import { t, localized, getLanguage, setLanguage, translateError } from '../public/i18n.js';
import messages from '../public/locales/en.js';

test('Chinese and English labels switch without recreating lookup tables', () => {
  const choices = localized({ yes: '赞成', no: '反对' });
  setLanguage('en');
  assert.equal(t('开始讨论'), 'Start discussion');
  assert.deepEqual(Object.entries(choices), [['yes', 'In favor'], ['no', 'Against']]);
  setLanguage('zh-CN');
  assert.equal(t('开始讨论'), '开始讨论');
  assert.equal(choices.yes, '赞成');
  setLanguage('invalid');
  assert.equal(getLanguage(), 'zh-CN');
});

test('interpolated record content never enters the translation dictionary', () => {
  setLanguage('en');
  const original = '赞成 — 默认 — 主持人 <b title="关闭">记忆本</b> {0}';
  assert.equal(t`<div title="查看这次调用的完整快照">${original}</div>`,
    `<div title="View the full invocation snapshot">${original}</div>`);
  assert.equal(t`角色：${original}`, `Role: ${original}`);
  assert.equal(t`<span>${original}</span><span>第 ${2} 版</span>`,
    `<span>${original}</span><span>Version 2</span>`);
  setLanguage('zh-CN');
  assert.equal(t`角色：${original}`, `角色：${original}`);
});

test('every English message preserves its interpolation placeholders', () => {
  const placeholders = value => [...value.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort();
  for (const [source, english] of Object.entries(messages)) {
    assert.deepEqual(placeholders(english), placeholders(source), source);
    assert(!/\p{Script=Han}/u.test(english), `Untranslated message: ${source}`);
  }
});

test('validation errors translate while preserving supplied field and space names', () => {
  setLanguage('en');
  assert.equal(translateError('提案不存在'), 'Proposal not found');
  assert.equal(translateError('记忆空间 我的实验 不存在'), 'Memory space 我的实验 not found');
  assert.equal(translateError('text 超过 2000 字'), 'text exceeds 2000 characters');
  assert.equal(translateError('记忆本已被更新：你读的是第 2 版，现在是第 3 版，请重新读取后再写'),
    'The notebook changed from version 2 to 3. Read the latest version before saving.');
  assert.equal(translateError('Unknown CLI output: 未知'), 'Unknown CLI output: 未知');
});

test('the stored locale wins over browser preferences; blocked storage is harmless', async () => {
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => 'zh-CN', setItem: (key, value) => { assert.equal(key, 'wetalk.language'); assert.equal(value, 'en'); },
    } });
    const saved = await import('../public/i18n.js?stored');
    assert.equal(saved.getLanguage(), 'zh-CN');
    saved.setLanguage('en');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Blocked'); } });
    const blocked = await import('../public/i18n.js?blocked');
    assert.equal(blocked.getLanguage(), 'en');
    assert.doesNotThrow(() => blocked.setLanguage('zh-CN'));
  } finally {
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage); else delete globalThis.localStorage;
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator); else delete globalThis.navigator;
  }
});
