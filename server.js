'use strict';
// Ghost in the Ledger: tiny local web server. Zero dependencies.
// Binds to 127.0.0.1 only, so nothing outside this computer can reach it.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseInput } = require('./lib/ingest');
const { haunt } = require('./lib/ghosts');
const backends = require('./lib/backends');
const moneyLib = require('./lib/money');
const pdfLib = require('./lib/pdf');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO_FILES = {
  us: 'demo-alerts-us.txt',
  uk: 'demo-statement-uk.csv',
  ng: 'demo-alerts-ng.txt',
};
const DEFAULT_DEMO = 'us';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, SECURITY_HEADERS));
  res.end(body);
}

function readBody(req, limit, asBuffer) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const e = new Error('too large'); e.code = 'TOO_LARGE'; reject(e); return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        const e = new Error('too large'); e.code = 'TOO_LARGE'; reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; { const b = Buffer.concat(chunks); resolve(asBuffer ? b : b.toString('utf8')); } } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

// The ghost meter. Every network request this server makes goes through meteredFetch, so the
// count lives in one place. Calls to this computer (Ollama on 127.0.0.1 or localhost) count as
// local. Everything else counts as outside. Bytes are what we hand to fetch: URL, header values
// and body. The meter only sees this server's own requests. It cannot watch other programs.
function isLocalUrl(u) {
  try {
    const host = new URL(typeof u === 'string' ? u : (u && (u.url || u.href)) || String(u)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch (_) { return false; }
}

function sizeOf(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return Buffer.byteLength(v);
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
  if (typeof v === 'object' && typeof v.size === 'number') return v.size;
  return Buffer.byteLength(String(v));
}

function requestBytes(input, init) {
  let n = typeof input === 'string' ? Buffer.byteLength(input) : Buffer.byteLength(String((input && input.url) || input));
  const init2 = init || {};
  const headers = init2.headers;
  if (headers) {
    const pairs = typeof headers.entries === 'function' && !Array.isArray(headers) ? Array.from(headers.entries()) : (Array.isArray(headers) ? headers : Object.entries(headers));
    for (const [k, v] of pairs) n += Buffer.byteLength(String(k)) + Buffer.byteLength(String(v));
  }
  return n + sizeOf(init2.body);
}

function createMeter(baseFetch) {
  const meter = { outsideCalls: 0, bytesSentOut: 0, localCalls: 0, documentsProcessed: 0 };
  const real = baseFetch || ((...a) => globalThis.fetch(...a));
  const meteredFetch = function (input, init) {
    if (isLocalUrl(input)) meter.localCalls++;
    else { meter.outsideCalls++; meter.bytesSentOut += requestBytes(input, init); }
    return real(input, init);
  };
  return { meter, meteredFetch, snapshot: () => Object.assign({}, meter) };
}

function distinctMerchants(items) {
  const set = new Set();
  for (const it of items) { const d = String(it.description || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (d) set.add(d); }
  return set.size;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Totals only add up items in the main currency. Other currencies are counted but never added in.
function summarize(items) {
  const currency = moneyLib.dominantCurrency(items, 'USD');
  let totalDebit = 0, totalCredit = 0, from = null, to = null, others = 0;
  for (const it of items) {
    if (it.date) {
      if (from === null || it.date < from) from = it.date;
      if (to === null || it.date > to) to = it.date;
    }
    if ((it.currency || currency) !== currency) { others++; continue; }
    if (it.direction === 'credit') totalCredit += it.amount; else totalDebit += it.amount;
  }
  const out = { count: items.length, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit), currency, from, to };
  if (others) out.otherCurrencyCount = others;
  return out;
}

async function handleStatus(res, ctx) {
  const detection = await backends.detect(ctx.env, { fetch: ctx.fetch });
  const choice = backends.choose(ctx.env, detection);
  const pdf = await pdfLib.pdftotextAvailable();
  sendJson(res, 200, {
    model: backends.modelFor(ctx.env, detection, choice),
    pdf,
    meter: ctx.snapshot(),
    backends: {
      ollama: { up: detection.ollama.up, models: detection.ollama.models },
      groq: { configured: detection.groq.configured },
    },
    active: choice.name,
  });
}

async function handleHaunt(req, res, ctx) {
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err && err.code === 'TOO_LARGE') {
      res.shouldKeepAlive = false;
      sendJson(res, 413, { ok: false, error: 'That is too much text (the limit is 1MB). Try a shorter statement.' });
    } else {
      sendJson(res, 400, { ok: false, error: 'Could not read the request.' });
    }
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch (_) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') {
    sendJson(res, 400, { ok: false, error: 'Please send JSON like {"text": "..."}.' });
    return;
  }
  if (!body.text.trim()) {
    sendJson(res, 400, { ok: false, error: 'There is no text to read yet. Paste some bank alerts first.' });
    return;
  }
  const filename = typeof body.filename === 'string' ? body.filename.slice(0, 200) : undefined;
  try {
    const parsed = parseInput(body.text, { filename });
    if (!parsed.items.length) {
      sendJson(res, 200, { ok: false, error: 'Could not find any transactions in that text. Try a CSV statement or pasted bank alert emails.' });
      return;
    }
    const before = ctx.snapshot();
    const result = await haunt(parsed.items, { env: ctx.env, fetch: ctx.fetch });
    ctx.meter.documentsProcessed++;
    const after = ctx.snapshot();
    sendJson(res, 200, {
      ok: true,
      meter: after,
      run: {
        inputBytes: Buffer.byteLength(body.text),
        transactions: parsed.items.length,
        distinctMerchants: distinctMerchants(parsed.items),
        datedTransactions: parsed.items.filter((it) => it.date).length,
        outsideCalls: after.outsideCalls - before.outsideCalls,
        bytesSentOut: after.bytesSentOut - before.bytesSentOut,
      },
      summary: summarize(parsed.items),
      ghosts: result.ghosts,
      backend: result.backend,
      model: result.model,
      warnings: Array.from(new Set((parsed.warnings || []).concat(result.warnings || []))),
    });
  } catch (_) {
    sendJson(res, 500, { ok: false, error: 'Something went wrong while haunting. Please try again.' });
  }
}

async function handleExtractPdf(req, res, ctx) {
  let buf;
  try {
    buf = await readBody(req, pdfLib.MAX_PDF_BYTES, true);
  } catch (err) {
    if (err && err.code === 'TOO_LARGE') {
      res.shouldKeepAlive = false;
      sendJson(res, 413, { ok: false, error: 'That PDF is too large (the limit is 15MB).' });
    } else {
      sendJson(res, 400, { ok: false, error: 'Could not read the request.' });
    }
    return;
  }
  try {
    const r = await pdfLib.extractPdf(buf, { forceBasic: ctx.env.GHOST_PDF === 'basic' });
    sendJson(res, 200, r);
  } catch (_) {
    sendJson(res, 200, { ok: false, error: 'That PDF could not be read.' });
  }
}

function handleDemo(res, query) {
  const wanted = String(query.get('set') || DEFAULT_DEMO).toLowerCase();
  const set = Object.prototype.hasOwnProperty.call(DEMO_FILES, wanted) ? wanted : null;
  if (!set) { sendJson(res, 400, { text: '', error: 'Unknown demo set. Use us, uk or ng.' }); return; }
  fs.readFile(path.join(__dirname, 'samples', DEMO_FILES[set]), 'utf8', (err, text) => {
    if (err) { sendJson(res, 404, { text: '', error: 'The demo file is missing (samples/' + DEMO_FILES[set] + ').' }); return; }
    sendJson(res, 200, { text, set, filename: DEMO_FILES[set].endsWith('.csv') ? DEMO_FILES[set] : undefined });
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { sendJson(res, 400, { ok: false, error: 'Bad path.' }); return; }
  if (rel.includes('\0')) { sendJson(res, 400, { ok: false, error: 'Bad path.' }); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(PUBLIC_DIR, '.' + path.sep + rel.replace(/^\/+/, ''));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'Not allowed.' });
    return;
  }
  fs.realpath(full, (err, real) => {
    if (err || !(real === PUBLIC_DIR || real.startsWith(PUBLIC_DIR + path.sep))) {
      sendJson(res, 404, { ok: false, error: 'Not found.' });
      return;
    }
    fs.stat(real, (err2, st) => {
      if (err2 || !st.isFile()) { sendJson(res, 404, { ok: false, error: 'Not found.' }); return; }
      res.writeHead(200, Object.assign({
        'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
      }, SECURITY_HEADERS));
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    });
  });
}

// Only answer requests addressed to this computer (blocks DNS rebinding tricks).
function hostIsLocal(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function createServer(options) {
  const m = createMeter(options && options.fetch);
  const ctx = { env: (options && options.env) || process.env, fetch: m.meteredFetch, meter: m.meter, snapshot: m.snapshot };
  return http.createServer((req, res) => {
    const handle = async () => {
      if (!hostIsLocal(req.headers.host)) { sendJson(res, 403, { ok: false, error: 'Not allowed.' }); return; }
      let pathname, query;
      try { const u = new URL(req.url, 'http://localhost'); pathname = u.pathname; query = u.searchParams; } catch (_) { sendJson(res, 400, { ok: false, error: 'Bad request.' }); return; }

      if (pathname === '/api/status') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { ok: false, error: 'Use GET.' }); return; }
        return handleStatus(res, ctx);
      }
      if (pathname === '/api/demo') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); sendJson(res, 405, { ok: false, error: 'Use GET.' }); return; }
        return handleDemo(res, query);
      }
      if (pathname === '/api/extract-pdf') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { ok: false, error: 'Use POST.' }); return; }
        return handleExtractPdf(req, res, ctx);
      }
      if (pathname === '/api/haunt') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); sendJson(res, 405, { ok: false, error: 'Use POST.' }); return; }
        return handleHaunt(req, res, ctx);
      }
      if (pathname === '/redact.js') {
        // One source of truth: the browser runs the same lib/redact.js the tests cover.
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); sendJson(res, 405, { ok: false, error: 'Use GET.' }); return; }
        const src = await fs.promises.readFile(path.join(__dirname, 'lib', 'redact.js'));
        res.writeHead(200, Object.assign({ 'Content-Type': TYPES['.js'], 'Content-Length': src.length }, SECURITY_HEADERS));
        res.end(req.method === 'HEAD' ? undefined : src);
        return;
      }
      if (pathname.startsWith('/api/')) { sendJson(res, 404, { ok: false, error: 'Not found.' }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); sendJson(res, 405, { ok: false, error: 'Use GET.' }); return; }
      serveStatic(req, res, pathname);
    };
    handle().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Something went wrong.' });
      else res.destroy();
    });
  });
}

function start(port, options) {
  const server = createServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

module.exports = { createServer, start, summarize, createMeter, MAX_BODY_BYTES, HOST };

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  start(port).then((server) => {
    console.log('Ghost in the Ledger is awake at http://' + HOST + ':' + server.address().port);
    console.log('Nothing leaves this computer unless you turn on the optional Groq backend.');
  }).catch((err) => {
    console.error('Could not start the server: ' + err.message);
    process.exit(1);
  });
}
