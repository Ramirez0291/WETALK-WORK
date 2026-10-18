// Review probes; only local mock HTTP and a fresh temporary project tree are used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createWorkbench, loadDefaults } from '../../lib/workbench/project.mjs';
import { createCommitGateway } from '../../lib/workbench/commit.mjs';
import { createDeepseekClient } from '../../lib/workbench/deepseek.mjs';
import { createUsage } from '../../lib/workbench/usage.mjs';
import { createWebTools } from '../../lib/workbench/web.mjs';
import { startMock, apiError } from '../../tests/workbench/mock-deepseek.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const parent = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(parent, 'astra-wp3-review-'));
const defaults = loadDefaults(path.join(root, 'workbench.defaults.json'));
defaults.git.autoCommit = false;
const gateways = [];
const results = [];
const P = '样本';
let responder;
let starts = [];
const mock = await startMock({ fallback: (url, body) => { starts.push(Date.now()); return responder(url, body); } });
const reset = (fn) => { mock.reset(); starts = []; responder = fn; };
const page = (content = 'original text') => ({ body: { title: 'fixture page', content } });
const searchOk = () => ({ body: { results: [{ title: 'fixture', url: 'https://example.org/a', snippet: 'a hint' }] } });
async function env(name, override = {}, retry = { max: 3, delaysSec: [0, 0, 0] }) {
  const workbench = createWorkbench({ projectsDir: path.join(temp, name), defaults, templateDir: path.join(root, 'templates/project') });
  const usage = createUsage({ workbench, pricing: defaults.pricing });
  const gateway = createCommitGateway({ workbench, defaults, availabilityOf: (p) => usage.availabilityOf(p) });
  gateways.push(gateway);
  await gateway.start();
  await gateway.createProject(P);
  fs.writeFileSync(path.join(workbench.get(P).dir, 'protocol.json'), JSON.stringify(override));
  const client = createDeepseekClient({ apiKey: 'review-dummy-key', baseUrl: mock.url, retry });
  const web = createWebTools({ client, usage, gateway, workbench, perSecond: 5, timeoutMs: 3000 });
  return { workbench, usage, gateway, web };
}

try {
  {
    const e = await env('concurrent-budget', { budget: { calls: 1 } });
    reset(() => ({ ...searchOk(), delayMs: 150 }));
    const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => e.web.search(P, { query: `q${i}` })));
    results.push({ probe: 'concurrent hard call budget', fulfilled: settled.filter((x) => x.status === 'fulfilled').length,
      upstreamRequests: mock.requests.length, totals: e.usage.totals(P) });
  }
  {
    const e = await env('retry-rate');
    let n = 0;
    reset(() => ++n <= 5 ? apiError(503) : searchOk());
    await Promise.all(Array.from({ length: 5 }, (_, i) => e.web.search(P, { query: `q${i}` })));
    results.push({ probe: 'retries bypass account rate limit', upstreamRequests: starts.length,
      spanMs: starts.at(-1) - starts[0], startsInFirstSecond: starts.filter((t) => t - starts[0] < 1000).length });
  }
  {
    const e = await env('source-url');
    reset(() => page('content from A'));
    await e.web.fetch(P, { url: 'https://example.org/A', create: true });
    reset(() => page('content from B'));
    const fetched = await e.web.fetch(P, { url: 'https://example.org/B', source_id: 'S001' });
    const src = e.gateway.getRecord(P, 'S001').record;
    results.push({ probe: 'source address and body mismatch', fetchedUrl: fetched.url, recordedUrl: src.url,
      version: src.version, sourceUsesFetchedBlob: src.text_blob === fetched.text_blob });
  }
  {
    const e = await env('project-retry', { retry: { max: 0 } });
    let n = 0;
    reset(() => ++n === 1 ? apiError(503) : searchOk());
    let outcome;
    try { await e.web.search(P, { query: 'retry disabled' }); outcome = 'success'; }
    catch (error) { outcome = error.message; }
    results.push({ probe: 'project retry override', effectiveRetryMax: e.workbench.get(P).config.retry.max,
      upstreamRequests: mock.requests.length, outcome });
  }
  {
    const e = await env('empty-fetch');
    reset(() => page());
    await e.web.fetch(P, { url: 'https://example.org/A', create: true });
    reset(() => apiError(404));
    try { await e.web.fetch(P, { url: 'https://example.org/A', source_id: 'S001' }); } catch {}
    const before = e.gateway.getRecord(P, 'S001').availability.state;
    reset(() => page(''));
    let status;
    try { await e.web.fetch(P, { url: 'https://example.org/A', source_id: 'S001' }); } catch (error) { status = error.status; }
    results.push({ probe: 'empty fetch availability', responseStatus: status, before,
      after: e.gateway.getRecord(P, 'S001').availability.state, lastUsage: e.usage.entries(P).at(-1) });
  }
  {
    // Real HTTP: a keepalive newline delivers 200 headers, then the connection breaks.
    let calls = 0;
    const brokenBody = http.createServer(async (req, res) => {
      for await (const chunk of req) { /* consume local fixture request */ }
      calls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (calls === 1) {
        res.write('\n');
        setTimeout(() => res.destroy(), 30);
      } else res.end(JSON.stringify(searchOk().body));
    });
    await new Promise((resolve) => brokenBody.listen(0, '127.0.0.1', resolve));
    const client = createDeepseekClient({ apiKey: 'review-dummy-key', retry: { max: 3, delaysSec: [0] }, baseUrl: `http://127.0.0.1:${brokenBody.address().port}` });
    let outcome;
    try { await client.search({ query: 'body failure' }); outcome = 'success'; }
    catch (error) { outcome = error.kind; }
    finally { brokenBody.closeAllConnections(); await new Promise((resolve) => brokenBody.close(resolve)); }
    results.push({ probe: 'network failure after successful headers', attempts: calls, outcome });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await mock.close();
  for (const gateway of gateways) { await gateway.queue.idle(); gateway.stop(); }
  const absolute = path.resolve(temp);
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith('astra-wp3-review-')) throw new Error('Unsafe cleanup path');
  fs.rmSync(absolute, { recursive: true, force: true });
}
