'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ghosts = require('../lib/ghosts');
const backends = require('../lib/backends');

const item = (date, description, amount, extra) => Object.assign({
  date, time: null, description, amount, direction: 'debit', currency: 'NGN', balance: null, source: 'csv',
}, extra || {});

const netflix = [
  item('2025-01-05', 'Netflix', 4500),
  item('2025-02-05', 'Netflix', 4500),
  item('2025-03-05', 'Netflix', 4500),
  item('2025-04-05', 'Netflix', 4500),
];
const sample = netflix.concat([
  item('2025-02-10', 'SMS Alert Charge', 4),
  item('2025-03-10', 'SMS Alert Charge', 4),
  item('2025-03-12', 'POS Late Night Shawarma', 3500, { time: '02:15' }),
  item('2025-03-14', 'POS Midnight Taxi', 2800, { time: '01:40' }),
  item('2025-03-20', 'Transfer to Rent', 150000),
]);

test('analyze finds a monthly subscription', () => {
  const f = ghosts.analyze(netflix).find((x) => x.kind === 'subscription');
  assert.ok(f);
  assert.equal(f.facts.count, 4);
  assert.equal(f.facts.cadence, 'monthly');
  assert.equal(f.amount, 18000);
});

test('analyze finds fees, night spends and the biggest debit', () => {
  const kinds = ghosts.analyze(sample).map((x) => x.kind);
  for (const k of ['subscription', 'fees', 'night', 'biggest']) assert.ok(kinds.includes(k), 'missing ' + k);
});

test('analyze is deterministic and ignores junk input', () => {
  assert.deepEqual(ghosts.analyze(sample), ghosts.analyze(sample));
  assert.deepEqual(ghosts.analyze([]), []);
  assert.deepEqual(ghosts.analyze(null), []);
  assert.deepEqual(ghosts.analyze([{ amount: -5, direction: 'debit' }, null]), []);
});

test('analyze finds a payday that vanished', () => {
  const items = [
    item('2025-03-25', 'Salary', 200000, { direction: 'credit' }),
    item('2025-03-25', 'Transfer to Friend', 90000),
    item('2025-03-26', 'POS Mall', 70000),
    item('2025-03-27', 'Airtime', 5000),
  ];
  const f = ghosts.analyze(items).find((x) => x.kind === 'payday');
  assert.ok(f);
  assert.equal(f.facts.creditAmount, 200000);
  assert.equal(f.facts.spent, 165000);
});

test('verifyStory accepts numbers that come from the finding', () => {
  const f = ghosts.analyze(netflix).find((x) => x.kind === 'subscription');
  assert.equal(ghosts.verifyStory('Netflix came back 4 times for 4,500 each, 18,000 in all.', f), true);
  assert.equal(ghosts.verifyStory('A quiet ghost with no numbers at all.', f), true);
});

test('verifyStory rejects invented numbers', () => {
  const f = ghosts.analyze(netflix).find((x) => x.kind === 'subscription');
  assert.equal(ghosts.verifyStory('Netflix took 25,000 from you.', f), false);
  assert.equal(ghosts.verifyStory('It came back 7 times.', f), false);
  assert.equal(ghosts.verifyStory('It came back seven times.', f), false);
});

test('cleanStory removes dashes and markdown', () => {
  const s = ghosts.cleanStory('**Boo** \u2014 a ghost!');
  assert.ok(!/[\u2013\u2014*]/.test(s));
  assert.equal(ghosts.cleanStory('   '), null);
});

test('templateGhost builds text only from finding facts', () => {
  for (const f of ghosts.analyze(sample)) {
    const g = ghosts.templateGhost(f);
    assert.ok(g.title && g.story);
    assert.equal(ghosts.verifyStory(g.story, f), true, g.kind + ' template must pass its own guard');
    assert.ok(!/\u2014/.test(g.story + g.title));
  }
});

test('haunt with the offline backend returns templates', async () => {
  const r = await ghosts.haunt(sample, { env: { GHOST_BACKEND: 'offline' } });
  assert.equal(r.backend, 'offline');
  assert.equal(r.model, 'template');
  assert.ok(r.ghosts.length >= 3);
  for (const g of r.ghosts) assert.ok(g.story.length > 10);
});

test('haunt keeps a model story when its numbers are real', async () => {
  const backend = {
    name: 'ollama', model: 'fake',
    complete: async () => 'Netflix haunts you 4 times, 4,500 each time. Spooky.',
  };
  const r = await ghosts.haunt(netflix, { backend });
  const sub = r.ghosts.find((g) => g.kind === 'subscription');
  assert.match(sub.story, /Spooky/);
  assert.equal(r.backend, 'ollama');
  assert.equal(r.model, 'fake');
});

test('haunt discards a story with invented numbers and uses the template', async () => {
  const backend = {
    name: 'ollama', model: 'fake',
    complete: async () => 'Netflix quietly took 99,999 from you across 12 months.',
  };
  const r = await ghosts.haunt(netflix, { backend });
  const sub = r.ghosts.find((g) => g.kind === 'subscription');
  assert.ok(!sub.story.includes('99,999'));
  assert.ok(!/12 months/.test(sub.story));
  assert.match(sub.story, /Netflix/);
  assert.ok(r.warnings.some((w) => /failed a check/.test(w)));
  assert.equal(r.backend, 'offline', 'nothing from the model survived');
});

test('haunt falls back to templates when the model throws', async () => {
  const backend = { name: 'groq', model: 'fake', complete: async () => { throw new Error('boom'); } };
  const r = await ghosts.haunt(sample, { backend });
  assert.equal(r.backend, 'offline');
  assert.equal(r.ghosts.length, ghosts.analyze(sample).length);
  assert.ok(r.warnings.some((w) => /did not answer/.test(w)));
});

test('haunt falls back when the model hangs past the timeout', async () => {
  const backend = { name: 'ollama', model: 'fake', complete: () => new Promise(() => {}) };
  const r = await ghosts.haunt(netflix, { backend, timeoutMs: 50 });
  assert.equal(r.backend, 'offline');
  assert.ok(r.warnings.some((w) => /timed out/.test(w)));
});

test('haunt never sends more than 6 evidence lines or the raw statement to a model', async () => {
  const many = [];
  for (let i = 1; i <= 12; i++) many.push(item('2025-01-' + String(i).padStart(2, '0'), 'Corner Shop', 500));
  const prompts = [];
  const backend = { name: 'ollama', model: 'fake', complete: async ({ user }) => { prompts.push(user); return null; } };
  await ghosts.haunt(many, { backend });
  assert.ok(prompts.length > 0);
  for (const prompt of prompts) {
    assert.ok((prompt.match(/\| Corner Shop/g) || []).length <= 6);
  }
});

test('haunt reports an empty ledger', async () => {
  const r = await ghosts.haunt([], { env: { GHOST_BACKEND: 'offline' } });
  assert.deepEqual(r.ghosts, []);
  assert.ok(r.warnings.length > 0);
});

test('backends: choose follows the documented rules', () => {
  const none = { ollama: { up: false, models: [] }, groq: { configured: false } };
  const up = { ollama: { up: true, models: [] }, groq: { configured: true } };
  assert.equal(backends.choose({}, none).name, 'offline');
  assert.equal(backends.choose({}, up).name, 'ollama');
  assert.equal(backends.choose({}, { ollama: { up: false, models: [] }, groq: { configured: true } }).name, 'groq');
  assert.equal(backends.choose({ GHOST_BACKEND: 'offline' }, up).name, 'offline');
  assert.equal(backends.choose({ GHOST_BACKEND: 'groq' }, none).name, 'offline');
});

test('backends: redact hides secrets', () => {
  assert.equal(backends.redact('bad key gsk_secret123 here', ['gsk_secret123']), 'bad key [hidden] here');
});

test('a small subscription survives the findings cap', () => {
  const big = [];
  for (let m = 1; m <= 3; m++) big.push(item('2025-0' + m + '-05', 'Streambox', 4400));
  const noise = [
    item('2025-01-02', 'SMS Alert Charge', 4), item('2025-02-02', 'SMS Alert Charge', 4),
    item('2025-01-03', 'POS Shawarma', 3500, { time: '02:15' }), item('2025-01-04', 'POS Taxi', 2800, { time: '01:40' }),
    item('2025-01-10', 'Transfer A', 50000), item('2025-01-11', 'Transfer B', 60000),
    item('2025-01-12', 'Transfer C', 70000), item('2025-01-13', 'Transfer D', 150000),
  ];
  const kinds = ghosts.analyze(big.concat(noise)).map((x) => x.kind);
  assert.ok(kinds.includes('subscription'), kinds.join(','));
  assert.ok(kinds.includes('biggest'));
  assert.ok(kinds.length <= ghosts.constants.MAX_FINDINGS);
});

test('cleanName strips * and everything after it', () => {
  assert.equal(ghosts.cleanName('NFLX*STREAMBOX LAGOS NG'), 'NFLX');
  const subs = ghosts.analyze([
    item('2026-08-05', 'NFLX*STREAMBOX LAGOS NG', 4400),
    item('2026-09-05', 'NFLX*STREAMBOX LAGOS NG', 4400),
    item('2026-10-05', 'NFLX*STREAMBOX LAGOS NG', 4400),
  ]).find((x) => x.kind === 'subscription');
  assert.equal(ghosts.templateGhost(subs).title, 'The NFLX Phantom');
});

test('theme ghosts are not pushed out by big round or heaviest transfers', () => {
  const rows = [
    item('2026-08-28', 'SALARY ACME', 450000, { direction: 'credit' }),
    item('2026-08-28', 'TRF TO LANDLORD RENT', 150000),
    item('2026-08-29', 'TRF TO OKAFOR FAMILY', 200000),
    item('2026-08-29', 'TRF TO CHIDI', 100000),
    item('2026-09-01', 'POS NITEBITES SHAWARMA', 6500, { time: '01:12' }),
    item('2026-09-02', 'WINBIG BETTING', 5000, { time: '02:47' }),
    item('2026-09-03', 'SMS ALERT FEE', 53.75), item('2026-09-10', 'SMS ALERT FEE', 53.75),
    item('2026-09-04', 'POS MAMA CASS', 1800), item('2026-09-06', 'POS MAMA CASS', 2100),
    item('2026-09-08', 'POS MAMA CASS', 1900), item('2026-09-12', 'POS MAMA CASS', 2300),
    item('2026-08-12', 'TUNEBOX', 1300), item('2026-09-12', 'TUNEBOX', 1300), item('2026-10-12', 'TUNEBOX', 1300),
  ];
  const kinds = ghosts.analyze(rows).map((f) => f.kind);
  for (const k of ['subscription', 'fees', 'payday', 'night', 'leak']) assert.ok(kinds.includes(k), k + ' must be kept, got ' + kinds.join(','));
  assert.ok(kinds.length <= ghosts.constants.MAX_FINDINGS);
});

test('with few theme ghosts, the heaviest debit still fills a slot', () => {
  const kinds = ghosts.analyze([item('2026-03-20', 'Transfer to Rent', 150000), item('2026-03-21', 'Corner Shop', 900)]).map((f) => f.kind);
  assert.deepEqual(kinds, ['biggest']);
});

test('haunt reports how many model stories were replaced in one warning', async () => {
  const backend = { name: 'ollama', model: 'fake', complete: async () => 'Netflix took 99,999 from you.' };
  const r = await ghosts.haunt(netflix.concat([item('2025-02-10', 'SMS Alert Charge', 4), item('2025-03-10', 'SMS Alert Charge', 4)]), { backend });
  const w = r.warnings.filter((x) => /stor(?:y|ies) from ollama (?:was|were) replaced/.test(x));
  assert.equal(w.length, 1);
  assert.match(w[0], /^\d+ stories from ollama were replaced/);
});

test('every demo set shows at least four kinds of ghost offline', async () => {
  const { parseInput } = require('../lib/ingest');
  const fs = require('node:fs'), path = require('node:path');
  for (const [f, cur] of [['demo-alerts-us.txt', 'USD'], ['demo-statement-uk.csv', 'GBP'], ['demo-alerts-ng.txt', 'NGN']]) {
    const p = parseInput(fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8'), { filename: f });
    const kinds = new Set(ghosts.analyze(p.items).map((x) => x.kind));
    assert.ok(kinds.size >= 4, f + ' gave ' + [...kinds].join(','));
    assert.ok(p.items.every((i) => i.currency === cur), f + ' currency');
  }
});
