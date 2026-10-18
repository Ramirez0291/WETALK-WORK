// 派生状态（deps.mjs）：纯函数，直接喂记录集合
import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, statusOf } from '../../lib/workbench/deps.mjs';
import { validateData } from '../../lib/workbench/records.mjs';

const recs = (...list) => new Map(list.map((r) => [r.id, r]));
const S = (id, version, extra = {}) => ({ id, version, title: id, url: 'https://example.org', availability: 'available', ...extra });
const C = (id, version, sources, extra = {}) => ({ id, version, type: 'fact', text: id, sources, ...extra });
const SL = (id, version, claims) => ({ id, version, title: id, claims });
const V = (id, target, sourceVersions, verdict) => ({ id, version: 1, target, source_versions: sourceVersions, verdict });
const O = (id, target, category, state) => ({ id, version: 1, target, category, state });

test('stale propagates through several levels: source update → claim → slide', () => {
  const d = derive(recs(S('S001', 2), C('C001', 1, [{ id: 'S001', version: 1 }]), SL('SL001', 1, [{ id: 'C001', version: 1 }])));
  assert.equal(d.freshness.get('S001').state, 'current');
  assert.equal(d.freshness.get('C001').state, 'stale');
  assert.deepEqual(d.freshness.get('C001').reasons, [{ type: 'version', id: 'S001', based: 1, current: 2 }]);
  // 页面引用的 C001 版本没变，但上游已经 stale，页面也要待更新
  assert.equal(d.freshness.get('SL001').state, 'stale');
  assert.deepEqual(d.freshness.get('SL001').reasons, [{ type: 'upstream', id: 'C001' }]);
  assert.deepEqual([...d.downstream.get('S001')], ['C001']);
  assert.deepEqual(statusOf(d, 'C001').based_on, [{ id: 'S001', version: 1 }]);
});

test('a source update never restores trust: verification bound to the old source version stops counting', () => {
  const before = derive(recs(S('S001', 1), C('C001', 1, [{ id: 'S001', version: 1 }]), V('V001', { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'supported')));
  assert.equal(before.verification.get('C001').state, 'supported');
  assert.equal(before.ready.get('C001'), true);
  const after = derive(recs(S('S001', 2), C('C001', 1, [{ id: 'S001', version: 1 }]), V('V001', { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'supported')));
  assert.equal(after.verification.get('C001').state, 'unreviewed');
  assert.equal(after.freshness.get('C001').state, 'stale');
  assert.equal(after.ready.get('C001'), false);
});

test('changing a claim discards its old verifications: status returns to unreviewed', () => {
  const d = derive(recs(S('S001', 1), C('C001', 2, [{ id: 'S001', version: 1 }]), V('V001', { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'supported')));
  assert.equal(d.verification.get('C001').state, 'unreviewed');
  assert.deepEqual(d.verification.get('C001').counted, []);
});

test('verdicts: all supported, all unsupported, or mixed → disputed', () => {
  const base = [S('S001', 1), C('C001', 1, [{ id: 'S001', version: 1 }])];
  const v = (id, verdict) => V(id, { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], verdict);
  assert.equal(derive(recs(...base, v('V001', 'unsupported'), v('V002', 'unsupported'))).verification.get('C001').state, 'unsupported');
  assert.equal(derive(recs(...base, v('V001', 'supported'), v('V002', 'unsupported'))).verification.get('C001').state, 'disputed');
  assert.equal(derive(recs(...base, v('V001', 'supported'), v('V002', 'supported'))).verification.get('C001').state, 'supported');
});

test('two blocking objections: resolving one still blocks; non-blocking categories and closed states never block', () => {
  const base = [S('S001', 1), C('C001', 1, [{ id: 'S001', version: 1 }]), V('V001', { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'supported')];
  const both = derive(recs(...base, O('O001', { id: 'C001', version: 1 }, 'number_error', 'open'), O('O002', { id: 'C001', version: 1 }, 'source_missing', 'needs_evidence')));
  assert.deepEqual(both.blockers.get('C001'), ['O001', 'O002']);
  assert.equal(both.ready.get('C001'), false);
  const one = derive(recs(...base, O('O001', { id: 'C001', version: 1 }, 'number_error', 'rejected'), O('O002', { id: 'C001', version: 1 }, 'source_missing', 'needs_evidence')));
  assert.deepEqual(one.blockers.get('C001'), ['O002']);
  assert.equal(one.ready.get('C001'), false);
  const none = derive(recs(...base,
    O('O001', { id: 'C001', version: 1 }, 'number_error', 'withdrawn'),
    O('O002', { id: 'C001', version: 1 }, 'interpretation', 'open'),
    O('O003', { id: 'C001', version: 1 }, 'narrative', 'needs_user')));
  assert.deepEqual(none.blockers.get('C001'), []);
  assert.equal(none.ready.get('C001'), true);
  // 每一种阻塞状态都阻塞
  for (const state of ['open', 'needs_evidence', 'upheld', 'needs_user']) {
    assert.equal(derive(recs(...base, O('O001', { id: 'C001', version: 1 }, 'quote_unsupported', state))).ready.get('C001'), false, state);
  }
});

test('a slide is ready only when it is current and every claim it cites is ready', () => {
  const base = [S('S001', 1), C('C001', 1, [{ id: 'S001', version: 1 }]), C('C002', 1, [{ id: 'S001', version: 1 }]), V('V001', { id: 'C001', version: 1 }, [{ id: 'S001', version: 1 }], 'supported')];
  assert.equal(derive(recs(...base, SL('SL001', 1, [{ id: 'C001', version: 1 }]))).ready.get('SL001'), true);
  assert.equal(derive(recs(...base, SL('SL001', 1, [{ id: 'C001', version: 1 }, { id: 'C002', version: 1 }]))).ready.get('SL001'), false);
});

test('missing upstream records make the dependent stale instead of crashing', () => {
  const d = derive(recs(C('C001', 1, [{ id: 'S009', version: 1 }])));
  assert.equal(d.freshness.get('C001').state, 'stale');
  assert.deepEqual(d.freshness.get('C001').reasons, [{ type: 'missing', id: 'S009' }]);
});

test('reference cycles are rejected: impossible through the schema, detected if records are forged', () => {
  // 字段校验只允许论断引用来源、作品引用论断，引用关系在结构上分层，写不出环
  assert.throws(() => validateData('claim', { type: 'fact', text: 'x', sources: [{ id: 'C002', version: 1 }] }), /必须是source编号/);
  assert.throws(() => validateData('slide', { title: 'x', claims: [{ id: 'SL002', version: 1 }] }), /必须是claim编号/);
  // 绕过校验伪造出来的环也会被派生计算发现，整圈标为 stale
  const d = derive(recs(C('C001', 1, [{ id: 'C002', version: 1 }]), C('C002', 1, [{ id: 'C001', version: 1 }])));
  assert.equal(d.cycles.length, 1);
  assert.equal(d.freshness.get('C001').state, 'stale');
  assert.equal(d.freshness.get('C002').state, 'stale');
});
