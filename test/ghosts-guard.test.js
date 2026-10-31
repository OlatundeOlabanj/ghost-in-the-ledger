'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ghosts = require('../lib/ghosts');
const { parseInput } = require('../lib/ingest');

const finding = {
  id: 'subscription-1', kind: 'subscription', amount: 3900,
  evidence: [{ date: '2026-08-12', time: '02:14', description: 'TUNEBOX PREMIUM 7ELEVEN', amount: 1300, balance: 171800, direction: 'debit', currency: 'NGN' }],
  facts: { name: 'Tunebox', count: 3, cadence: 'monthly', each: 1300, total: 3900, firstDate: '2026-08-12', lastDate: '2026-10-12', currency: 'NGN' },
};

test('verifyStory accepts honest stories in many number styles', () => {
  for (const t of [
    'Tunebox took ₦1,300 three times, ₦3,900 in all.',
    'It took NGN1300 and N3900 and $1,300.',
    'On 12 August 2026 and 2026-10-12 it hit; the 12th, again October 12.',
    'At 2:14 AM and 02:14 it struck.',
    '7ELEVEN again, 3 times.',
    '1.3k each, 3.9k total.',
    '1,300.',
  ]) assert.equal(ghosts.verifyStory(t, finding), true, t);
});

test('verifyStory rejects invented numbers in many disguises', () => {
  for (const t of [
    'Tunebox took 1.3 times', 'took 2 times', 'took 1k', '1,2,3 times', '13 times', '1 300 000', 'NGN 13,000',
    '70% of your pay', 'a dozen times', 'twenty times', 'half of it is gone', 'It struck at 3:14 AM', 'on 9 August',
    '171,800 left', '4 times', 'twice a day', '1.4k each', 'took 1,300,000', 'on 2025-08-12', '3 100 naira',
    'nine times', 'about 1.3 million', '١٣٠٠ naira',
  ]) assert.equal(ghosts.verifyStory(t, finding), false, t);
});

test('number words that appear inside a real name are not flagged', () => {
  assert.equal(ghosts.verifyStory('The 7ELEVEN ghost struck.', finding), true);
});

test('balances were never shown to a model, so they are not allowed in a story', () => {
  assert.equal(ghosts.verifyStory('You still had 171,800 left.', finding), false);
});

test('every real template passes its own check, for all kinds', () => {
  const dir = path.join(__dirname, '..', 'samples');
  for (const f of ['demo-alerts-ng.txt', 'demo-statement-ng.csv']) {
    const items = parseInput(fs.readFileSync(path.join(dir, f), 'utf8')).items;
    for (const fnd of ghosts.analyze(items)) {
      const g = ghosts.templateGhost(fnd);
      assert.equal(ghosts.verifyStory(g.story, fnd, fnd.evidence.slice(0, 6)), true, f + ' ' + fnd.kind + ': ' + g.story);
    }
  }
});

test('digits in a merchant name are fine when the name is in the facts', () => {
  const f = { id: 'leak-1', kind: 'leak', amount: 4000, evidence: [], facts: { name: 'Shop 24', count: 4, total: 4000, average: 1000, currency: 'NGN' } };
  assert.equal(ghosts.verifyStory('Shop 24 took 4 small payments, 4,000 in all.', f), true);
  assert.equal(ghosts.verifyStory('Shop 25 took 4 small payments.', f), false);
});

test('demo alerts give a varied haunt of at most 5 ghosts', () => {
  const items = parseInput(fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo-alerts-ng.txt'), 'utf8')).items;
  const kinds = ghosts.analyze(items).map((f) => f.kind);
  assert.ok(kinds.length <= 5);
  for (const k of ['subscription', 'fees', 'night', 'payday']) assert.ok(kinds.includes(k), k + ' missing from ' + kinds);
  assert.ok(kinds.includes('leak') || kinds.includes('biggest'));
  assert.equal(new Set(kinds).size, kinds.length, 'distinct kinds preferred: ' + kinds);
});

test('distinct kinds win over a second finding of the same kind', () => {
  const day = (n) => '2026-08-' + String(n).padStart(2, '0');
  const items = [];
  // two subscriptions that are big, plus a small night pattern
  for (const [name, amt] of [['ALPHA TV', 90000], ['BETA GYM', 80000]]) {
    for (const m of ['06', '07', '08']) items.push({ date: '2026-' + m + '-05', time: '10:00', description: name, amount: amt, direction: 'debit', currency: 'NGN', balance: null, source: 'csv' });
  }
  items.push({ date: day(3), time: '01:10', description: 'POS NIGHT A', amount: 500, direction: 'debit', currency: 'NGN', balance: null, source: 'csv' });
  items.push({ date: day(4), time: '02:10', description: 'POS NIGHT B', amount: 700, direction: 'debit', currency: 'NGN', balance: null, source: 'csv' });
  const kinds = ghosts.analyze(items).map((f) => f.kind);
  assert.ok(kinds.includes('night'), kinds.join());
});
