'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan, redact } = require('../lib/redact');
const { parseInput } = require('../lib/ingest');

test('finds card-like numbers, with or without spaces', () => {
  assert.equal(scan('card 4111 1111 1111 1111 and 5500000000000004').cards, 2);
  assert.equal(redact('card 4111 1111 1111 1111').text, 'card **** **** **** 1111');
});
test('finds 10 digit account numbers and keeps the last 4', () => {
  const r = redact('Acct 0123456789 debited');
  assert.equal(r.counts.accounts, 1);
  assert.equal(r.text, 'Acct ******6789 debited');
});
test('finds phone numbers in common shapes', () => {
  const t = 'call 08031234567, +234 803 123 4567, (555) 123-4567 or 555-123-4567';
  assert.equal(scan(t).phones, 4);
  assert.ok(redact(t).text.includes('4567'));
  assert.ok(!redact(t).text.includes('0803123'));
});
test('finds emails and masks the name', () => {
  const r = redact('mail jane.doe@example.com now');
  assert.equal(r.counts.emails, 1);
  assert.equal(r.text, 'mail j***@example.com now');
});
test('finds long IDs', () => {
  assert.equal(scan('ref FT26215ABCD1234X ok').ids, 1);
  assert.equal(scan('id 123456789012345678901234').ids, 1);
});
test('never touches amounts, dates, times or balances', () => {
  const safe = [
    'NGN1234567890.00 paid', 'Bal:NGN 1,234,567,890.00', '$1234567890', 'GBP 1234567890',
    'on 20260803 13:05', '2026-08-03 12:05:22', 'Amt 10000000000.50', '-3.85,GBP,1316.70', 'Acct:***4821',
  ];
  for (const t of safe) {
    const r = redact(t);
    assert.equal(r.text, t, t);
    assert.equal(r.counts.total, 0, t);
  }
});
test('redaction is idempotent', () => {
  const once = redact('0123456789 a@b.co 4111 1111 1111 1111').text;
  assert.equal(redact(once).text, once);
  assert.equal(scan(once).total, 0);
});
test('demo files parse to identical amounts, dates and balances after redaction', () => {
  const dir = path.join(__dirname, '..', 'samples');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const red = redact(text);
    const key = (it) => [it.date, it.time, it.amount, it.direction, it.currency, it.balance].join('|');
    const a = parseInput(text, { filename: f }).items.map(key);
    const b = parseInput(red.text, { filename: f }).items.map(key);
    assert.deepEqual(b, a, f);
  }
});
test('demo files with sensitive data added still keep every number', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo-alerts-ng.txt'), 'utf8')
    + '\nContact 08031234567 or help@bank.example. Card 4111 1111 1111 1111. A/c 0123456789.\n';
  const red = redact(text);
  assert.ok(red.counts.total >= 4);
  const key = (it) => [it.date, it.amount, it.direction, it.balance].join('|');
  assert.deepEqual(parseInput(red.text).items.map(key), parseInput(text).items.map(key));
});
