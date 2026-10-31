'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInput } = require('../lib/ingest.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');

test('CSV with separate debit and credit columns', () => {
  const csv = [
    'Transaction Date,Narration,Debit,Credit,Balance',
    '05/08/2026 14:22,"NFLX*STREAMBOX, LAGOS",4400.00,,120000.00',
    '28/08/2026 08:30,SALARY AUG,,450000.00,570000.00'
  ].join('\n');
  const { items } = parseInput(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].date, '2026-08-05');
  assert.equal(items[0].time, '14:22');
  assert.equal(items[0].description, 'NFLX*STREAMBOX, LAGOS');
  assert.equal(items[0].amount, 4400);
  assert.equal(items[0].direction, 'debit');
  assert.equal(items[0].source, 'csv');
  assert.equal(items[1].direction, 'credit');
  assert.equal(items[1].balance, 570000);
});

test('CSV with a single signed Amount column', () => {
  const csv = 'Date,Description,Amount\n2026-09-01,Rent,-50000\n2026-09-02,Refund,1200.50\n';
  const { items } = parseInput(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].direction, 'debit');
  assert.equal(items[0].amount, 50000);
  assert.equal(items[1].direction, 'credit');
  assert.equal(items[1].amount, 1200.5);
});

test('pasted multi-line alert', () => {
  const t = 'Sunrise Bank Debit Alert\nAcct: ***4821\nAmt: NGN 2,500.00\nDesc: POS/MAMA CASS BUKA\nDate: 05-Aug-2026 13:05\nBal: NGN 120,350.00';
  const { items } = parseInput(t);
  assert.equal(items.length, 1);
  assert.deepEqual(
    [items[0].date, items[0].time, items[0].amount, items[0].direction, items[0].balance, items[0].currency],
    ['2026-08-05', '13:05', 2500, 'debit', 120350, 'NGN']
  );
  assert.equal(items[0].description, 'POS/MAMA CASS BUKA');
});

test('single-line comma alert with thousands separators is not mistaken for CSV', () => {
  const t = 'Acct: ***4821, Debit Alert, NGN 1,300.00, Desc: TUNEBOX PREMIUM, Date: 12-Aug-2026 09:03, Bal: NGN 120,350.00';
  const { items } = parseInput(t);
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 1300);
  assert.equal(items[0].description, 'TUNEBOX PREMIUM');
  assert.equal(items[0].source, 'email');
});

test('SMS style, account first, no labels for amount', () => {
  const t = 'Acct:***4821 Debit Alert NGN6,500.00 Desc: POS/NITEBITES Date:15-Aug-26 01:12 Bal:NGN180,000.00';
  const { items } = parseInput(t);
  assert.equal(items.length, 1);
  assert.equal(items[0].date, '2026-08-15');
  assert.equal(items[0].time, '01:12');
  assert.equal(items[0].amount, 6500);
});

test('SMS style sentence: debited from A/c ... for X on date', () => {
  const t = 'Sunrise: N5,000.00 debited from A/c ***4821 for WINBIG BETTING NG on 2026-08-23 02:47. Avail Bal: N158,600.00';
  const { items } = parseInput(t);
  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'WINBIG BETTING NG');
  assert.equal(items[0].direction, 'debit');
  assert.equal(items[0].balance, 158600);
  const c = parseInput('Sunrise: N1,500.00 credited to A/c ***4821 for REVERSAL on 2026-08-20 10:05. Avail Bal: N9,000.00');
  assert.equal(c.items[0].direction, 'credit');
});

test('.eml style header block', () => {
  const t = [
    'From: Sunrise Bank Alerts <alerts@sunrisebank.example>',
    'To: demo.user@example.com',
    'Subject: Sunrise Bank Debit Alert',
    'Date: Wed, 05 Aug 2026 14:22:07 +0100',
    '',
    'Dear Customer,',
    'Acct: ***4821',
    'Amt: NGN 4,400.00',
    'Desc: NFLX*STREAMBOX LAGOS NG',
    'Date: 05-Aug-2026 14:22',
    'Bal: NGN 120,350.00'
  ].join('\n');
  const { items } = parseInput(t);
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 4400);
  assert.equal(items[0].date, '2026-08-05');
  assert.equal(items[0].time, '14:22');
  assert.equal(items[0].description, 'NFLX*STREAMBOX LAGOS NG');
});

test('plain lines', () => {
  const { items } = parseInput('2026-08-07 Bolt ride Lekki 3,200.00 DR\n2026-08-08 Salary 100,000.00 CR\n');
  assert.equal(items.length, 2);
  assert.equal(items[0].direction, 'debit');
  assert.equal(items[0].amount, 3200);
  assert.equal(items[1].direction, 'credit');
  assert.equal(items[0].source, 'text');
});

test('junk, empty and odd input never throws', () => {
  for (const input of ['', '   \n\n', 'hello world, nothing here', '<<<>>>', '{"a":1}', null, undefined, 42, '\u0000\u0001']) {
    const r = parseInput(input);
    assert.ok(Array.isArray(r.items));
    assert.ok(Array.isArray(r.warnings));
    assert.equal(r.items.length, 0);
  }
  assert.ok(parseInput('').warnings.length >= 1);
  assert.ok(parseInput('hello world').warnings.length >= 1);
});

test('every item has the documented shape', () => {
  for (const f of ['demo-alerts-ng.txt', 'demo-statement-ng.csv']) {
    for (const it of parseInput(read(f)).items) {
      assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(it.time === null || /^\d{2}:\d{2}$/.test(it.time));
      assert.equal(typeof it.description, 'string');
      assert.ok(it.amount > 0);
      assert.ok(['debit', 'credit'].includes(it.direction));
      assert.equal(it.currency, 'NGN');
      assert.ok(it.balance === null || typeof it.balance === 'number');
      assert.ok(['csv', 'email', 'text'].includes(it.source));
    }
  }
});

test('demo-alerts-ng.txt parses to about 60 items with the planted patterns', () => {
  const { items, warnings } = parseInput(read('demo-alerts-ng.txt'));
  assert.ok(items.length >= 55 && items.length <= 65, 'got ' + items.length);
  assert.equal(warnings.length, 0, warnings.join(' | '));
  assert.ok(!items.some((i) => i.description === 'Unknown transaction'));
  assert.equal(items.filter((i) => /STREAMBOX/.test(i.description)).length, 3);
  assert.equal(items.filter((i) => /TUNEBOX/.test(i.description)).length, 3);
  assert.ok(items.filter((i) => /SMS ALERT|MAINTENANCE|VAT|STAMP DUTY/.test(i.description)).length >= 12);
  const night = items.filter((i) => i.direction === 'debit' && i.time && i.time >= '01:00' && i.time <= '03:00');
  assert.equal(night.length, 5);
  const salary = items.filter((i) => i.direction === 'credit' && /SALARY/.test(i.description));
  assert.equal(salary.length, 3);
  assert.equal(items.filter((i) => /MAMA CASS/.test(i.description)).length, 10);
  const round = items.filter((i) => i.direction === 'debit' && /^TRF TO/.test(i.description) && i.amount % 10000 === 0);
  assert.ok(round.length >= 4);
  const sources = new Set(items.map((i) => i.source));
  assert.ok(sources.has('email') && sources.has('text'));
  const dates = items.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort());
  assert.ok(dates[0] >= '2026-08-01' && dates[dates.length - 1] <= '2026-10-31');
});

test('payday money is mostly gone within 3 days in the demo alerts', () => {
  const { items } = parseInput(read('demo-alerts-ng.txt'));
  const pay = items.find((i) => i.direction === 'credit' && /SALARY AUG/.test(i.description));
  const end = new Date(pay.date + 'T00:00:00Z').getTime() + 3 * 86400000;
  const spent = items
    .filter((i) => i.direction === 'debit' && i.date >= pay.date && new Date(i.date + 'T00:00:00Z').getTime() <= end)
    .reduce((s, i) => s + i.amount, 0);
  assert.ok(spent > pay.amount * 0.8, 'spent ' + spent);
});

test('demo-statement-ng.csv parses to about 30 csv rows', () => {
  const { items } = parseInput(read('demo-statement-ng.csv'), { filename: 'demo-statement-ng.csv' });
  assert.ok(items.length >= 28 && items.length <= 34, 'got ' + items.length);
  assert.ok(items.every((i) => i.source === 'csv'));
  assert.ok(items.every((i) => i.balance !== null));
  assert.equal(items.filter((i) => i.direction === 'credit').length, 3);
  assert.ok(items.some((i) => /SALARY/.test(i.description) && i.amount === 450000));
});

test('sample files contain no em dashes', () => {
  for (const f of ['demo-alerts-ng.txt', 'demo-statement-ng.csv']) assert.ok(!read(f).includes(String.fromCharCode(0x2014)));
});
