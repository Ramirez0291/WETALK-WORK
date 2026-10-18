// Observational review probes: dummy key, local fixtures, fresh temporary projects only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createDeepseekClient, createRateLimiter } from '../../lib/workbench/deepseek.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createWebTools } from '../../lib/workbench/web.mjs';
import { startMock, apiError } from '../../tests/workbench/mock-deepseek.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp3-rereview-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const results = [];
let gateway;
let mock;
try {
  // A queued request must observe its own deadline even while another waiter owns the head.
  const limiter = createRateLimiter(5);
  await Promise.all(Array.from({ length: 5 }, () => limiter.take()));
  const head = limiter.take();
  let sent = 0;
  const queued = createDeepseekClient({ apiKey: 'review-dummy', rateLimits: { search: limiter },
    fetchImpl: async () => { sent++; throw new Error('should not send'); } });
  const began = Date.now();
  let kind;
  try { await queued.search({ query: 'queued' }, { timeoutMs: 50 }); } catch (e) { kind = e.kind; }
  results.push({ probe: 'R1 queued deadline', configuredMs: 50, elapsedMs: Date.now() - began, kind, sent });
  await head;

  // Real HTTP: headers and a keepalive arrive, then body transmission breaks.
  const starts = [];
  const srv = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    starts.push(Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (starts.length === 1) {
      res.write('\n');
      setTimeout(() => res.destroy(), 20);
    } else res.end(JSON.stringify({ results: [] }));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const client = createDeepseekClient({ apiKey: 'review-dummy', baseUrl: `http://127.0.0.1:${srv.address().port}`,
      retry: { max: 1, delaysSec: [0.3] } });
    const r = await client.search({ query: 'broken body' });
    results.push({ probe: 'R2 body disconnect backoff', expectedWaitMs: 300,
      actualWaitMs: r.attempts[0].waitMs, requestGapMs: starts[1] - starts[0], attempts: r.attempts });
  } finally {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }

  // Old persisted rows are exactly the shape written by the first WP3 implementation.
  const legacyDir = path.join(temp, 'legacy');
  fs.mkdirSync(legacyDir);
  const legacy = [
    { at: '2026-10-18T00:00:00.000Z', api: 'fetch', source_id: 'S001', url: 'https://example.org/A', ok: true, status: 200, usd: 0.001 },
    { at: '2026-10-18T00:00:01.000Z', api: 'fetch', source_id: 'S001', url: 'https://example.org/A', ok: false, status: 404, usd: 0 },
  ];
  fs.writeFileSync(path.join(legacyDir, 'usage.jsonl'), legacy.map(JSON.stringify).join('\n') + '\n');
  const legacyUsage = createUsage({ workbench: { get: () => ({ dir: legacyDir, config: { budget: { calls: 2, apiUsd: 1 } } }) }, pricing: defaults.pricing });
  const loaded = legacyUsage.totals('legacy');
  const historicalEntries = legacyUsage.entries('legacy').length;
  const availability = legacyUsage.availabilityOf('legacy').get('S001') ?? null;
  let extraAllowed = false;
  try { legacyUsage.reserve('legacy', { api: 'search', attempt: 1 }); extraAllowed = true; } catch {}
  results.push({ probe: 'R4 legacy usage loading', expectedCalls: 2, expectedUsd: 0.001,
    loaded, historicalEntries, availability, extraAllowed });

  // Real gateway: failed relocation must not change availability of the unchanged old address.
  mock = await startMock();
  const workbench = createWorkbench({ projectsDir: path.join(temp, 'projects'), defaults, templateDir: path.join(root, 'templates/project') });
  const usage = createUsage({ workbench, pricing: defaults.pricing });
  gateway = createCommitGateway({ workbench, defaults, availabilityOf: (p) => usage.availabilityOf(p) });
  await gateway.start();
  await gateway.createProject('sample');
  const client = createDeepseekClient({ apiKey: 'review-dummy', baseUrl: mock.url });
  const web = createWebTools({ client, usage, gateway, workbench });
  mock.script('/v1/tools/fetch', { body: { title: 'A', content: 'A content' } }, { body: { title: 'A', content: 'A content' } }, apiError(404));
  await web.fetch('sample', { url: 'https://example.org/A', create: true });
  await web.fetch('sample', { source_id: 'S001' });
  const before = gateway.getRecord('sample', 'S001');
  let status;
  try {
    await web.fetch('sample', { source_id: 'S001', url: 'https://example.org/B', relocate: true },
      { actor: { kind: 'human', participant: '主持人', verified: true, basis: 'host-session' } });
  } catch (e) { status = e.status; }
  const after = gateway.getRecord('sample', 'S001');
  results.push({ probe: 'R3 failed relocation', status, before: before.availability.state,
    after: after.availability.state, unchangedUrl: after.record.url, unchangedVersion: after.record.version,
    failedFetchUrl: usage.entries('sample').at(-1).url });
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (gateway) { await gateway.queue.idle(); gateway.stop(); }
  if (mock) await mock.close();
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('astra-wp3-rereview-')) throw new Error('Unsafe cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
