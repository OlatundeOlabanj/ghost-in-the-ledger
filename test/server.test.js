'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start } = require('../server');

let server, base, port;

test.before(async () => {
  // Offline mode and a fetch that always fails: the tests never touch the network.
  const failFetch = async () => { throw new Error('no network in tests'); };
  server = await start(0, { env: { GHOST_BACKEND: 'offline' }, fetch: failFetch });
  port = server.address().port;
  base = 'http://127.0.0.1:' + port;
});
test.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

const CSV = [
  'Date,Description,Debit (NGN),Credit (NGN)',
  '2025-01-05,Netflix,4500,',
  '2025-02-05,Netflix,4500,',
  '2025-03-05,Netflix,4500,',
  '2025-03-20,Transfer to Rent,150000,',
].join('\n');

const post = (body) => fetch(base + '/api/haunt', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

// Raw request so we control the path and Host header exactly.
function raw(pathStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathStr, method: 'GET', headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('listens on 127.0.0.1 only', () => {
  assert.equal(server.address().address, '127.0.0.1');
});

test('GET /api/status reports backends and the active one', async () => {
  const res = await fetch(base + '/api/status');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.active, 'offline');
  assert.equal(typeof j.backends.ollama.up, 'boolean');
  assert.ok(Array.isArray(j.backends.ollama.models));
  assert.equal(j.backends.groq.configured, false);
});

test('POST /api/haunt returns ghosts and a summary', async () => {
  const res = await post({ text: CSV, filename: 'statement.csv' });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.backend, 'offline');
  assert.equal(j.summary.count, 4);
  assert.equal(j.summary.totalDebit, 163500);
  assert.equal(j.summary.totalCredit, 0);
  assert.equal(j.summary.currency, 'NGN');
  assert.equal(j.summary.from, '2025-01-05');
  assert.equal(j.summary.to, '2025-03-20');
  assert.ok(j.ghosts.length >= 2);
  assert.ok(Array.isArray(j.warnings));
  assert.ok(j.ghosts.some((g) => g.kind === 'subscription'));
});

test('POST /api/haunt answers friendly errors', async () => {
  let res = await post('not json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);

  res = await post({ nope: 1 });
  assert.equal(res.status, 400);

  res = await post({ text: '   ' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);

  res = await post({ text: 'hello there, this is not a statement' });
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.ok(j.error.length > 5);
});

test('POST /api/haunt rejects bodies over 1MB', async () => {
  const res = await post({ text: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).ok, false);
});

test('wrong methods get 405', async () => {
  assert.equal((await fetch(base + '/api/haunt')).status, 405);
  assert.equal((await fetch(base + '/api/status', { method: 'POST' })).status, 405);
});

test('GET /api/demo returns text or a clean error', async () => {
  const res = await fetch(base + '/api/demo');
  const j = await res.json();
  if (res.status === 200) {
    assert.equal(typeof j.text, 'string');
    assert.ok(j.text.length > 20);
  } else {
    assert.equal(res.status, 404);
    assert.equal(typeof j.error, 'string');
  }
});

test('serves the home page and assets with the right types', async () => {
  let res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<html/i);
  res = await fetch(base + '/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  res = await fetch(base + '/style.css');
  assert.match(res.headers.get('content-type'), /text\/css/);
});

test('unknown files are 404', async () => {
  assert.equal((await fetch(base + '/nope.html')).status, 404);
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
});

test('path traversal is blocked', async () => {
  const attempts = [
    '/../server.js',
    '/..%2fserver.js',
    '/%2e%2e/server.js',
    '/%2e%2e%2fpackage.json',
    '/public/../../package.json',
    '/..\\server.js',
    '/%00',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
  ];
  for (const p of attempts) {
    const r = await raw(p);
    assert.ok([400, 403, 404].includes(r.status), p + ' gave ' + r.status);
    assert.ok(!/require\('node:http'\)|"ghost-in-the-ledger"|root:/.test(r.body), p + ' leaked a file');
  }
});

test('requests with a foreign Host header are refused', async () => {
  const r = await raw('/api/status', { Host: 'evil.example.com' });
  assert.equal(r.status, 403);
});

test('GET /api/demo serves us (default), uk and ng sets and rejects unknown sets', async () => {
  for (const [q, re] of [['', /\$/], ['?set=us', /\$/], ['?set=uk', /GBP/], ['?set=ng', /NGN/]]) {
    const res = await fetch(base + '/api/demo' + q);
    assert.equal(res.status, 200, q);
    assert.match((await res.json()).text, re, q);
  }
  assert.equal((await fetch(base + '/api/demo?set=zz')).status, 400);
});

test('POST /api/haunt keeps mixed currencies apart and warns', async () => {
  const text = '2026-03-01 Coffee -\u00a34.50\n2026-03-02 Coffee -\u00a34.50\n2026-03-03 Coffee -\u00a34.50\n2026-03-04 Coffee -\u00a34.50\n2026-03-05 Hotel -\u20ac90,00';
  const j = await (await post({ text })).json();
  assert.equal(j.summary.currency, 'GBP');
  assert.equal(j.summary.totalDebit, 18);
  assert.equal(j.summary.otherCurrencyCount, 1);
  assert.ok(j.warnings.some((w) => /mixes currencies/.test(w)));
});

// ---- ghost meter ----
const { start: startServer } = require('../server');
const groqEnv = { GHOST_BACKEND: 'groq', GROQ_API_KEY: 'gsk_test_key_123456' };
function meterServer(env, fakeFetch) {
  return startServer(0, { env, fetch: fakeFetch }).then((s) => ({ s, url: 'http://127.0.0.1:' + s.address().port }));
}
const stop = (s) => new Promise((r) => { s.closeAllConnections(); s.close(r); });

test('offline mode keeps outsideCalls at 0 over a haunt', async () => {
  const calls = [];
  const f = async (u) => { calls.push(String(u)); throw new Error('down'); };
  const { s, url } = await meterServer({ GHOST_BACKEND: 'offline' }, f);
  try {
    const r = await fetch(url + '/api/haunt', { method: 'POST', body: JSON.stringify({ text: CSV, filename: 's.csv' }) });
    const j = await r.json();
    assert.equal(j.meter.outsideCalls, 0);
    assert.equal(j.meter.bytesSentOut, 0);
    assert.equal(j.meter.documentsProcessed, 1);
    assert.equal(j.run.outsideCalls, 0);
    const st = await (await fetch(url + '/api/status')).json();
    assert.equal(st.meter.outsideCalls, 0);
    assert.equal(st.meter.documentsProcessed, 1);
    assert.ok(calls.every((c) => /127\.0\.0\.1|localhost/.test(c)));
  } finally { await stop(s); }
});

test('groq through a fake fetch increments outsideCalls and bytes', async () => {
  const f = async (u) => {
    if (String(u).includes('groq.com')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A short ghost story.' } }] }), text: async () => '' };
    throw new Error('down');
  };
  const { s, url } = await meterServer(groqEnv, f);
  try {
    const j = await (await fetch(url + '/api/haunt', { method: 'POST', body: JSON.stringify({ text: CSV, filename: 's.csv' }) })).json();
    assert.equal(j.ok, true);
    assert.equal(j.backend, 'groq');
    assert.ok(j.meter.outsideCalls >= 1);
    assert.ok(j.meter.bytesSentOut > 100);
    assert.equal(j.run.outsideCalls, j.meter.outsideCalls);
    // the statement itself never goes out: its distinctive text is not in the byte count's reach
    assert.ok(j.meter.bytesSentOut < 20000);
  } finally { await stop(s); }
});

test('ollama on localhost increments localCalls only', async () => {
  const f = async (u) => {
    const x = String(u);
    if (x.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:3b' }] }) };
    return { ok: true, status: 200, json: async () => ({ message: { content: 'A calm story.' } }), text: async () => '' };
  };
  const { s, url } = await meterServer({ GHOST_BACKEND: 'ollama' }, f);
  try {
    const j = await (await fetch(url + '/api/haunt', { method: 'POST', body: JSON.stringify({ text: CSV, filename: 's.csv' }) })).json();
    assert.equal(j.ok, true);
    assert.ok(j.meter.localCalls >= 1);
    assert.equal(j.meter.outsideCalls, 0);
    assert.equal(j.meter.bytesSentOut, 0);
  } finally { await stop(s); }
});

test('the meter wrapper cannot be skipped: a remote Ollama URL counts as outside', async () => {
  const f = async (u) => ({ ok: true, json: async () => ({ models: [] }) });
  const { s, url } = await meterServer({ GHOST_BACKEND: 'offline', OLLAMA_URL: 'http://example.test:11434' }, f);
  try {
    const st = await (await fetch(url + '/api/status')).json();
    assert.ok(st.meter.outsideCalls >= 1);
    assert.equal(st.meter.localCalls, 0);
  } finally { await stop(s); }
});

test('/redact.js is served for the browser', async () => {
  const r = await fetch(base + '/redact.js');
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('GhostRedact'));
});
