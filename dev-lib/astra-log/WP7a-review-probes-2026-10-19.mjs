// Independent review probes for db1db30/e6e6fec. Exit 0 confirms the observations,
// including bugs, were reproduced; it does not mean product acceptance passed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createTaskBoard } from '../../lib/workbench/tasks.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createExports } from '../../lib/workbench/exports.mjs';
import { checkStructure, sentencesOf } from '../../lib/workbench/export/deck.mjs';
import { analyze, renderWith } from '../../lib/workbench/export/render.mjs';
import { run, pyExport } from '../../lib/workbench/export/proc.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp7a-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const workbench = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
const usage = createUsage({ workbench, pricing: defaults.pricing });
const board = createTaskBoard({ workbench, usage });
const gateway = createCommitGateway({ workbench, defaults, fence: board.fence });
const host = { kind: 'human', participant: 'review-host', verified: true };
const service = createExports({ workbench, gateway, board, runner: {}, participants: () => null, root });
const observe = (probe, data) => console.log(JSON.stringify({ probe, ...data }));
async function submit(project, changes, identity = null) {
  let extra = {};
  if (identity) {
    const task = board.create(project, { type: 'extract_claims' }, { created_by: host });
    const cred = board.claim(project, task.id, identity);
    extra = { task_id: task.id, attempt: cred.attempt, lease_token: cred.lease_token };
  }
  const receipt = gateway.receive(project, { request_id: `review-${crypto.randomUUID()}`, changes, ...extra }, { actor: host });
  return gateway.promote(project, receipt.sid);
}
try {
  await gateway.start();
  const project = 'export-review';
  await gateway.createProject(project);
  await submit(project, [
    { kind: 'source', expected_version: 0, tmp: '$s', data: { title: 'Fixture', citation: 'Fixture book', text: 'Population is 1200.' } },
    { kind: 'claim', expected_version: 0, tmp: '$c', data: { type: 'fact', text: 'OLD-CLAIM Population is 1200.', sources: [{ id: '$s', quote: '1200' }] } },
    { kind: 'slide', expected_version: 0, data: { title: 'Population', body: 'Population is 1200 C001.', notes: 'Original notes', claims: [{ id: '$c' }] } },
  ]);
  await submit(project, [{ kind: 'verification', expected_version: 0, data: {
    target: { id: 'C001', version: 1 }, source_versions: [{ id: 'S001', version: 1 }], verdict: 'supported', reason: 'Matches fixture', support_quote: { id: 'S001', version: 1, quote: '1200' },
  } }], { kind: 'server', participant: 'reviewer', adapter: 'claude', verified: true, basis: 'server-invoked' });
  assert.equal(gateway.getRecord(project, 'SL001').status.ready, true);

  const slide = gateway.getRecord(project, 'SL001').record;
  const grammar = [
    'An unsupported factual sentence. Population is 1200 C001.',
    'An unsupported factual sentence. 〔非事实〕Welcome.',
    '人口是1200。 （C001）〔非事实〕谢谢。',
  ].map(body => {
    const checked = checkStructure({ gateway, project, slides: [{ ...slide, body, claims: body.includes('C001') ? slide.claims : [] }], maxChars: 1000 });
    return { body, sentences: sentencesOf(body), ok: checked.ok, issues: checked.slides[0].issues };
  });
  assert.equal(grammar[0].ok, true);
  assert.equal(grammar[1].ok, true);
  assert.equal(grammar[2].ok, false);
  observe('sentence-validation', { cases: grammar });

  const before = (await service.create(project, { formats: ['md'], via: 'script' }, host.participant)).export;
  assert.equal(before.deliverable, true);
  await submit(project, [{ kind: 'objection', expected_version: 0, data: {
    target: { id: 'C001', version: 1 }, category: 'number_error', pointer: { type: 'quote', source: { id: 'S001', version: 1 }, quote: '1200' }, reason: 'Review this number', state: 'open',
  } }]);
  const after = service.view(project, before.id);
  assert.equal(gateway.getRecord(project, 'SL001').status.ready, false);
  assert.equal(after.deliverable, true);
  const freshExport = (await service.create(project, { formats: ['md'], via: 'script' }, host.participant)).export;
  assert.equal(freshExport.deliverable, false);
  observe('deliverable-after-new-objection', { export: before.id, before: before.deliverable, after: after.deliverable, freshness: after.freshness, slideReady: gateway.getRecord(project, 'SL001').status.ready, claimBlockers: gateway.getRecord(project, 'C001').status.blockers, newlyBuiltDeliverable: freshExport.deliverable });

  await submit(project, [{ id: 'C001', expected_version: 1, data: { type: 'fact', text: 'NEW-CLAIM Population must be corrected.', sources: [{ id: 'S001', version: 1, quote: '1200' }] } }]);
  const stale = (await service.create(project, { formats: ['md'], via: 'script' }, host.participant)).export;
  const md = fs.readFileSync(service.file(project, stale.id, 'deck.md').path, 'utf8');
  assert.ok(md.includes('C001@1 NEW-CLAIM'));
  observe('old-reference-new-content', { export: stale.id, structureOK: stale.structure.ok, citedVersion: slide.claims[0].version, currentVersion: gateway.getRecord(project, 'C001').record.version, footnote: md.split('\n').find(line => line.startsWith('[^C001]:')) });

  // Left/top overflow entirely within slide: no off_slide fallback can catch it.
  const rendered = analyze({ raw: { engine: 'powerpoint', installed: [], slideWidth: 960, slideHeight: 540, slides: [{ png: 'p01.png', shapes: [{ name: 'Centered text', text: 'Overflow', left: 200, top: 200, width: 100, height: 100, boundLeft: 160, boundTop: 160, boundWidth: 140, boundHeight: 140 }] }] }, readback: { theme_fonts: [], slides: [{ fonts: [], shapes: [] }] }, spec: { slides: [{ id: 'SL001', version: 1 }] } });
  assert.equal(rendered.ok, true);
  observe('left-top-overflow', { ok: rendered.ok, issues: rendered.pages[0].issues, box: [200, 200, 100, 100], actualText: [160, 160, 140, 140] });
  // Opt-in real PowerPoint check; never invokes an AI model.
  if (process.env.WB_REVIEW_REAL === '1') {
    const pptx = path.join(temp, 'left-overflow.pptx');
    const py = path.resolve(root, defaults.export.python);
    const script = [
      'import sys', 'from pptx import Presentation', 'from pptx.util import Pt',
      'from pptx.enum.text import PP_ALIGN, MSO_AUTO_SIZE',
      'prs = Presentation(sys.argv[1])',
      's = prs.slides.add_slide(prs.slide_layouts[6])',
      'sh = s.shapes.add_textbox(Pt(300), Pt(200), Pt(100), Pt(100))',
      'tf = sh.text_frame; tf.word_wrap = False; tf.auto_size = MSO_AUTO_SIZE.NONE',
      'tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0',
      'tf.margin_right = Pt(12)',
      'p = tf.paragraphs[0]; p.alignment = PP_ALIGN.RIGHT; p.text = "AAAAAAAAAAAAAAAA"',
      'p.runs[0].font.size = Pt(20); p.runs[0].font.name = "Segoe UI"',
      'prs.save(sys.argv[2])',
    ].join('\n');
    await run(py, ['-I', '-c', script, path.join(root, 'templates/pptx/default.pptx'), pptx]);
    const raw = await renderWith('powerpoint', { pptx, outDir: path.join(temp, 'real-render'), resultFile: path.join(temp, 'raw.json') });
    const rb = await pyExport(py, 'readback', [pptx], path.join(temp, 'rb.json'));
    const actual = analyze({ raw, readback: rb, spec: { slides: [{ id: 'SL001', version: 1 }] } });
    const textShape = raw.slides[0].shapes.find(s => s.text === 'AAAAAAAAAAAAAAAA');
    assert.ok(textShape.boundLeft < textShape.left - 2, 'Fixture must actually overflow left');
    assert.equal(actual.ok, true, 'Current analyzer misses the actual left overflow');
    observe('real-left-overflow', { ok: actual.ok, issues: actual.pages[0].issues, shapes: raw.slides[0].shapes });
  }
} finally {
  await gateway.queue.idle(); gateway.stop();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp7a-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
