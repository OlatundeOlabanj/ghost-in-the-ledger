'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInput } = require('../lib/ingest.js');
const ghosts = require('../lib/ghosts');
const money = require('../lib/money');

const sample = (f) => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');
const one = (t) => { const r = parseInput(t); assert.equal(r.items.length, 1, t + ' -> ' + JSON.stringify(r)); return r.items[0]; };

test('USD alerts: purchase, charged card, Zelle in', () => {
  let it = one('Bank: You made a $12.99 purchase at NETFLIX.COM on 03/05/2026 at 2:14 AM.');
  assert.deepEqual([it.amount, it.currency, it.direction, it.description, it.date, it.time], [12.99, 'USD', 'debit', 'NETFLIX.COM', '2026-03-05', '02:14']);
  it = one('Zelle: Jordan sent you $1,060.00 on 03/07/2026.');
  assert.deepEqual([it.amount, it.currency, it.direction], [1060, 'USD', 'credit']);
  it = one('Your credit card ending 1234 was charged $8.00 at SHELL on 03/09/2026.');
  assert.deepEqual([it.direction, it.description], ['debit', 'SHELL']);
});

test('GBP and EUR alerts, including a decimal comma', () => {
  let it = one('Card ending 1234 was charged £4.50 at PRET A MANGER on 12/03/2026.');
  assert.deepEqual([it.amount, it.currency, it.direction, it.description], [4.5, 'GBP', 'debit', 'PRET A MANGER']);
  it = one('Your account was debited €20,00 for SPOTIFY on 12/03/2026.');
  assert.deepEqual([it.amount, it.currency, it.direction], [20, 'EUR', 'debit']);
  it = one('Paid 1.234,56 EUR to ACME GMBH on 12.03.2026');
  assert.deepEqual([it.amount, it.currency], [1234.56, 'EUR']);
});

test('other currency symbols and ISO codes', () => {
  const cases = [['KES 1,200.00 debited for UBER on 05/06/2026', 'KES'], ['GHS 50.00 debited for MTN on 05/06/2026', 'GHS'],
    ['ZAR 99.00 debited for WOOLWORTHS on 05/06/2026', 'ZAR'], ['₹ 499.00 debited for HOTSTAR on 05/06/2026', 'INR'],
    ['CAD 12.00 debited for TIMS on 05/06/2026', 'CAD'], ['AUD 7.00 debited for COLES on 05/06/2026', 'AUD'],
    ['¥ 980 debited for LAWSON on 05/06/2026', 'JPY'], ['CHF 40.00 debited for COOP on 05/06/2026', 'CHF'], ['₦2,500.00 debited for DSTV on 05/06/2026', 'NGN']];
  for (const [t, c] of cases) assert.equal(one(t).currency, c, t);
});

test('US dates are month first for USD, day first otherwise, and a day above 12 decides', () => {
  assert.equal(one('Purchase of $5.00 at A on 03/05/2026').date, '2026-03-05');
  assert.equal(one('Purchase of £5.00 at A on 03/05/2026').date, '2026-05-03');
  assert.equal(one('Purchase of $5.00 at A on 25/05/2026').date, '2026-05-25');
  const r = parseInput('Purchase of £5.00 at A on 03/25/2026\n\nPurchase of £6.00 at B on 04/01/2026');
  assert.deepEqual(r.items.map((i) => i.date), ['2026-03-25', '2026-04-01']);
});

test('parentheses negatives and Debit/Credit or Amount CSV columns', () => {
  const r = parseInput('Date,Description,Amount,Balance\n03/15/2026,COFFEE,($4.50),$100.00\n03/16/2026,PAYROLL,"$2,000.00",$2,100.00');
  assert.deepEqual(r.items.map((i) => [i.direction, i.amount, i.currency]), [['debit', 4.5, 'USD'], ['credit', 2000, 'USD']]);
  const r2 = parseInput('Date;Description;Debit;Credit;Currency\n15/03/2026;CAFE;4,50;;EUR\n16/03/2026;LOHN;;2000,00;EUR');
  assert.deepEqual(r2.items.map((i) => [i.direction, i.amount, i.currency]), [['debit', 4.5, 'EUR'], ['credit', 2000, 'EUR']]);
});

test('mixed currencies are not added together', () => {
  const t = ['2026-03-01 A -£3.00', '2026-03-02 A -£3.00', '2026-03-03 A -£3.00', '2026-03-04 A -£3.00', '2026-03-05 B -$900.00'].join('\n');
  const r = parseInput(t);
  assert.ok(r.warnings.some((w) => /mixes currencies/.test(w)));
  const f = ghosts.analyze(r.items);
  assert.ok(f.every((x) => x.facts.currency === 'GBP'));
  assert.ok(f.every((x) => x.amount < 900));
});

test('global fee words are caught', () => {
  const words = ['Overdraft fee', 'Monthly maintenance fee', 'ATM fee', 'Foreign transaction fee', 'Wire fee', 'NSF fee', 'SMS charge', 'VAT', 'Stamp duty'];
  const items = words.map((w, i) => ({ date: '2026-03-0' + (i + 1), time: null, description: w, amount: 3, direction: 'debit', currency: 'USD', balance: null, source: 'csv' }));
  const f = ghosts.analyze(items).find((x) => x.kind === 'fees');
  assert.equal(f.facts.count, words.length);
});

test('money formatting uses the right symbol and the guard accepts any format', () => {
  assert.equal(money.formatMoney(1300, 'GBP'), '£1,300');
  assert.equal(money.formatMoney(4.5, 'EUR'), '€4.50');
  assert.equal(money.formatMoney(4.5, 'NGN'), '₦4.50');
  const t = ghosts.templateGhost({ id: 'x', kind: 'fees', amount: 1234.56, evidence: [], facts: { count: 3, total: 1234.56, largest: 20, currency: 'EUR' } });
  assert.match(t.story, /€1,234\.56/);
  const finding = { kind: 'fees', amount: 1234.56, evidence: [], facts: { count: 3, total: 1234.56, largest: 20, currency: 'EUR' } };
  for (const ok of ['3 fees, €1,234.56 in all', '3 fees, €1.234,56 in all', '3 fees, 1 234,56 EUR', 'largest €20,00', '$1,234.56 and £1234.56'])
    assert.equal(ghosts.verifyStory(ok, finding, []), true, ok);
  for (const bad of ['€1.235,56', '€20,50', '£9,999'])
    assert.equal(ghosts.verifyStory(bad, finding, []), false, bad);
});

test('demo sets: US gives at least 4 ghost kinds, UK is GBP, NG is NGN', () => {
  const us = parseInput(sample('demo-alerts-us.txt'));
  assert.equal(us.warnings.length, 0, us.warnings.join('|'));
  assert.ok(us.items.length >= 45 && us.items.every((i) => i.currency === 'USD'));
  assert.ok(new Set(ghosts.analyze(us.items).map((f) => f.kind)).size >= 4);
  const uk = parseInput(sample('demo-statement-uk.csv'));
  assert.ok(uk.items.length >= 40 && uk.items.every((i) => i.currency === 'GBP'));
  assert.ok(new Set(ghosts.analyze(uk.items).map((f) => f.kind)).size >= 4);
  assert.ok(parseInput(sample('demo-alerts-ng.txt')).items.every((i) => i.currency === 'NGN'));
  for (const f of ['demo-alerts-us.txt', 'demo-statement-uk.csv']) assert.ok(!sample(f).includes('—'));
});
