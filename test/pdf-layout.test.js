'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseInput } = require('../lib/ingest');
const { analyze, haunt } = require('../lib/ghosts');
const pdf = require('../lib/pdf');
const { start } = require('../server');

const sample = (n) => fs.readFileSync(path.join(__dirname, '..', 'samples', n), 'utf8');

for (const [file, rows, source] of [['pdf-layout-ecobank.txt', 30, 'ecobank'], ['pdf-layout-generic.txt', 31, 'generic']]) {
  test('layout parser reads ' + source + ' statement correctly', () => {
    const r = parseInput(sample(file));
    assert.equal(r.items.length, rows, r.warnings.join('; '));
    const money = r.items.filter((i) => i.balance !== null);
    // every row agrees with its own balance movement
    let prev = null, checked = 0;
    for (const i of r.items) {
      if (prev !== null) {
        const diff = Math.round((i.balance - prev) * 100) / 100;
        assert.equal(diff, i.direction === 'credit' ? i.amount : -i.amount, i.description);
        checked++;
      }
      prev = i.balance;
    }
    assert.ok(checked >= 25 && money.length === rows);
    const salary = r.items.filter((i) => /SALARY/.test(i.description));
    assert.ok(salary.length >= 3 && salary.every((i) => i.direction === 'credit' && i.amount >= 380000));
    const rent = r.items.find((i) => /JOHN DOE\/REF 12345|CHIDI NWOSU FOR SCHOOL/.test(i.description));
    assert.ok(rent && rent.direction === 'debit');
    assert.match(rent.description, /(RENT SHARE JULY AND UTILITY CONTRIBUTION AGREED|SCHOOL FEES PART PAYMENT TERM ONE)$/, 'wrapped narration is joined');
    assert.ok(!r.items.some((i) => /Opening|Closing|Brought|Total|Page \d|regulated/i.test(i.description)));
    assert.ok(r.items.some((i) => i.time && i.time < '04:00' && i.direction === 'debit'));
    assert.ok(r.items.every((i) => i.currency === 'NGN' && /^2026-/.test(i.date)));
    const kinds = new Set(analyze(r.items).map((f) => f.kind));
    assert.ok(kinds.size >= 3, 'kinds: ' + [...kinds].join(','));
    assert.ok(kinds.has('subscription') && kinds.has('night'));
  });

  test('haunt on ' + source + ' statement finds at least 3 ghost kinds', async () => {
    const r = parseInput(sample(file));
    const h = await haunt(r.items, { backend: { name: 'offline', model: 'template', complete: async () => null } });
    assert.ok(new Set(h.ghosts.map((g) => g.kind)).size >= 3);
  });
}

test('layout parser: direction by column position when no balance column is usable', () => {
  const t = [
    'Date         Narration                          Debit        Credit       Balance',
    '02-Oct-2026  NIP TRANSFER TO A/REF 1             5,000.00',
    '03-Oct-2026  SALARY OCT                                      90,000.00',
    '04-Oct-2026  POS PURCHASE SHOP                   1,250.50',
    '05-Oct-2026  AIRTIME                              200.00',
  ].join('\n');
  const r = parseInput(t);
  assert.deepEqual(r.items.map((i) => i.direction), ['debit', 'credit', 'debit', 'debit']);
  assert.deepEqual(r.items.map((i) => i.amount), [5000, 90000, 1250.5, 200]);
});

test('layout parser: balance movement decides when columns are ambiguous, dd/mm/yy dates', () => {
  const t = [
    'Date       Details                 Debit  Credit  Balance',
    '01/10/26   Opening Balance                         1,000.00',
    '02/10/26   TRANSFER IN             500.00          1,500.00',
    '03/10/26   TRANSFER OUT            300.00          1,200.00',
    '04/10/26   REFUND                  100.00          1,300.00',
  ].join('\n');
  const r = parseInput(t);
  assert.deepEqual(r.items.map((i) => i.direction), ['credit', 'debit', 'credit']);
  assert.equal(r.items[0].date, '2026-10-02');
});

// ---- PDF ----

function makePdf(compress) {
  const content = 'BT /F1 10 Tf 50 750 Td (Date  Narration  Debit  Credit  Balance) Tj 0 -14 Td (02-Oct-2026  NETFLIX  4,500.00  120,000.00) Tj 0 -14 Td [(03-Oct-2026 ) -20 (SALARY  50,000.00)] TJ ET';
  const stream = compress ? zlib.deflateSync(Buffer.from(content)) : Buffer.from(content);
  const parts = [
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ' + stream.length + (compress ? ' /Filter /FlateDecode' : '') + ' >>\nstream\n'),
    stream, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  ];
  return Buffer.concat(parts);
}

for (const compress of [false, true]) {
  test('basic PDF extractor reads a ' + (compress ? 'Flate' : 'plain') + ' PDF', async () => {
    const r = await pdf.extractPdf(makePdf(compress), { forceBasic: true });
    assert.equal(r.ok, true);
    assert.equal(r.method, 'basic');
    assert.equal(r.pages, 1);
    assert.match(r.text, /02-Oct-2026\s+NETFLIX\s+4,500\.00/);
    assert.match(r.text, /03-Oct-2026 SALARY/);
  });
}

test('PDF extractor rejects non PDFs and encrypted files', async () => {
  assert.equal((await pdf.extractPdf(Buffer.from('hello world, not a pdf'))).ok, false);
  const enc = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF');
  const r = await pdf.extractPdf(enc, { forceBasic: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /password/i);
});

test('POST /api/extract-pdf and GET /api/status', async () => {
  const server = await start(0, { env: { GHOST_BACKEND: 'offline' }, fetch: async () => { throw new Error('no network'); } });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const st = await (await fetch(base + '/api/status')).json();
    assert.equal(typeof st.pdf, 'boolean');
    assert.equal(st.model, 'template');
    const ok = await (await fetch(base + '/api/extract-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: makePdf(true) })).json();
    assert.equal(ok.ok, true);
    assert.match(ok.text, /NETFLIX/);
    assert.ok(['pdftotext', 'basic'].includes(ok.method));
    const bad = await (await fetch(base + '/api/extract-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('nope nope nope') })).json();
    assert.equal(bad.ok, false);
    const big = await fetch(base + '/api/extract-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.alloc(16 * 1024 * 1024, 1) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    const get = await fetch(base + '/api/extract-pdf');
    assert.equal(get.status, 405);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
