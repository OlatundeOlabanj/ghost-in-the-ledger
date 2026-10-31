'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInput, parseAmount } = require('../lib/ingest');

// All inputs are fake and only imitate the shape of real Nigerian bank alerts.
const one = (text, opts) => {
  const r = parseInput(text, opts);
  assert.equal(r.items.length, 1, JSON.stringify(r));
  return r.items[0];
};
const expect = (it, want) => {
  for (const k of Object.keys(want)) assert.equal(it[k], want[k], k + ' in ' + JSON.stringify(it));
};

const ALERTS = [
  ['GTBank email', 'Dear Customer, GTBank Transaction Alert\nAmount: NGN 12,500.00\nAccount Number: 0123****89\nTransaction Type: Debit\nDescription: POS TRF/SHOPRITE LEKKI\nDate: 28-Oct-2026 02:14\nAvailable Balance: NGN 88,000.50',
    { amount: 12500, direction: 'debit', date: '2026-10-28', time: '02:14', description: 'POS TRF/SHOPRITE LEKKI', balance: 88000.5 }],
  ['GTBank SMS', 'Acct:012***789 Debit Alert Amt:NGN1,234.56 Desc:NIP TRANSFER TO JOHN DOE Date:28-Oct-2026 02:14 Bal:NGN9,000.00',
    { amount: 1234.56, direction: 'debit', time: '02:14', balance: 9000 }],
  ['Access credit, 2:14 AM, no decimals', 'Access Bank Credit Alert\nAmt: NGN 50,000\nAcct: 0987***21\nNarration: NIP/ADA OKORO/RENT REFUND\nDate: 28/10/2026 2:14 AM\nBal: NGN 150,000.00',
    { amount: 50000, direction: 'credit', date: '2026-10-28', time: '02:14' }],
  ['Zenith with N prefix and value date', 'Zenith Bank\nTransaction Notification\nDebit Amt: N1,234.56\nNarration: WEB PURCHASE NETFLIX.COM\nValue Date: 2026-10-28\nTime: 02:14\nAvailable Balance: N5,000.00',
    { amount: 1234.56, direction: 'debit', date: '2026-10-28', time: '02:14', balance: 5000 }],
  ['UBA, Oct 28, 2026 and plain 1234', 'UBA Alert: Debit of NGN 1234 on your account 2012***345. Desc: MTN AIRTIME VTU. Date: Oct 28, 2026 14:05. Bal: NGN 20,000',
    { amount: 1234, direction: 'debit', date: '2026-10-28', time: '14:05', description: 'MTN AIRTIME VTU' }],
  ['First Bank sentence', 'FirstBank: Your a/c 301***4567 has been debited with NGN1,234.56 on 28-OCT-2026. Narration: ATM WDL LEKKI. Avail Bal: NGN 77,000.00',
    { amount: 1234.56, direction: 'debit', date: '2026-10-28', description: 'ATM WDL LEKKI', balance: 77000 }],
  ['Opay sent', 'Opay\nMoney sent!\nAmount: ₦5,000.00\nTo: Amaka Eze\nDate: Oct 28, 2026, 02:14 AM\nTransaction Type: Transfer',
    { amount: 5000, direction: 'debit', time: '02:14' }],
  ['Kuda sentence', 'Kuda: You sent ₦2,500.00 to Tunde Bakare on 28/10/2026 at 02:14. Your balance is ₦10,000.00',
    { amount: 2500, direction: 'debit', time: '02:14', balance: 10000 }],
  ['Moniepoint credit', 'Moniepoint Credit Alert\nYou received N15,000.00 from CHIOMA ADE\n28-10-2026 14:20\nBalance: N45,000.00',
    { amount: 15000, direction: 'credit', date: '2026-10-28', time: '14:20' }],
  ['Palmpay with seconds', 'PalmPay: Debit Alert\nAmount: NGN 3,000.00\nBeneficiary: Musa Ibrahim\nDate: 2026-10-28 02:14:33\nStatus: Successful',
    { amount: 3000, direction: 'debit', time: '02:14' }],
  ['SMS with at time and dot after', 'Debit: NGN 1,234.56 on 28-Oct-26 at 02:14 AM. POS Shoprite. Bal NGN 5,000.00',
    { amount: 1234.56, direction: 'debit', time: '02:14', balance: 5000 }],
  ['Zenith SMS DR suffix', 'Zenith: NGN1,234.56 DR to MTN VTU 28/10/2026 02:14. Bal: NGN 9,000.00.',
    { amount: 1234.56, direction: 'debit', description: 'MTN VTU' }],
  ['UBA received, PM time', "UBA: You've received NGN 20,000.00 from CHUKS NWOSU on Oct 28, 2026 2:14 PM. Balance: NGN 25,000.00",
    { amount: 20000, direction: 'credit', time: '14:14' }],
  ['Opay transfer of, no direction word', 'OPay: Transfer of ₦2,000.00 to Tolu successful. 28 Oct 2026 02:14:09',
    { amount: 2000, direction: 'debit', description: 'Tolu', time: '02:14' }],
  ['pipe separated', 'Moniepoint: Debit NGN 500.00 | Airtime | 28/10/2026 | 2:14 AM | Bal NGN 3,000.00',
    { amount: 500, direction: 'debit', description: 'Airtime', time: '02:14' }],
  ['12:05 AM is just after midnight', 'Debit Alert\nAmount: NGN 1,000.00\nDescription: POS\nDate: 28/10/2026 12:05 AM', { time: '00:05' }],
  ['12:05 PM is noon', 'Debit Alert\nAmount: NGN 1,000.00\nDescription: POS\nDate: 28/10/2026 12:05 PM', { time: '12:05' }],
];
for (const [name, text, want] of ALERTS) {
  test('alert: ' + name, () => expect(one(text), want));
}

test('forwarded email with quoted lines, &nbsp; and <br>', () => {
  const text = '---------- Forwarded message ---------\nFrom: GTBank <gens@gtbank.example>\nDate: Wed, 28 Oct 2026 02:20:00 +0100\nSubject: GTBank Transaction Alert\nTo: me@example.com\n\n'
    + '> Dear Customer,&nbsp;<br>\n> Amount:&nbsp;NGN&nbsp;1,234.56<br>\n> Description: POS/SHOPRITE<br>\n> Transaction Type: Debit<br>\n> Date: 28-Oct-2026 02:14<br>\n> Available Balance: NGN 10,000.00<br>';
  expect(one(text), { amount: 1234.56, direction: 'debit', description: 'POS/SHOPRITE', time: '02:14', balance: 10000 });
});

test('quoted lines without email headers', () => {
  expect(one('> GTBank Debit Alert\n> Amt: NGN 1234\n> Desc: POS/SPAR\n> Date: 28/10/2026 2:14 AM\n> Bal: NGN 9,000'),
    { amount: 1234, description: 'POS/SPAR', time: '02:14', balance: 9000 });
});

test('HTML-only email table', () => {
  const text = 'From: a@b.example\nSubject: Debit Alert\nDate: Wed, 28 Oct 2026 02:20:00 +0100\nContent-Type: text/html\n\n'
    + '<html><body><table><tr><td>Amount</td><td>NGN&nbsp;4,000.00</td></tr><tr><td>Description</td><td>POS/CHICKEN REPUBLIC</td></tr><tr><td>Date</td><td>28-Oct-2026 02:14 AM</td></tr><tr><td>Type</td><td>DR</td></tr></table></body></html>';
  expect(one(text), { amount: 4000, direction: 'debit', description: 'POS/CHICKEN REPUBLIC', time: '02:14' });
});

test('pasted text with raw &nbsp; and <br> but no email headers', () => {
  expect(one('Debit Alert\nAmt:&nbsp;NGN&nbsp;1,000.00<br>Desc:&nbsp;POS/X<br>Date:&nbsp;28-Oct-2026 02:14<br>'),
    { amount: 1000, description: 'POS/X', time: '02:14' });
});

test('two alerts with and without a blank line between them', () => {
  const a = 'GTBank Debit Alert\nAmt: NGN 100.00\nDesc: A\nDate: 28-Oct-2026 02:14';
  const b = 'GTBank Credit Alert\nAmt: NGN 200.00\nDesc: B\nDate: 29-Oct-2026 03:14';
  for (const text of [a + '\n\n' + b, a + '\n' + b]) {
    const r = parseInput(text);
    assert.deepEqual(r.items.map((i) => [i.amount, i.direction]), [[100, 'debit'], [200, 'credit']]);
  }
});

test('amount formats', () => {
  const cases = [['NGN1,234.56', 1234.56], ['N1,234.56', 1234.56], ['NGN 1234', 1234], ['₦1,234.56', 1234.56], ['1,234.56', 1234.56],
    ['NGN 1234.5', 1234.5], ['(50.00)', 50], ['1.234,56', 1234.56], ['₦-1,500.00', 1500], ['NGN 0.50', 0.5]];
  for (const [raw, want] of cases) assert.equal(parseAmount(raw).value, want, raw);
  assert.equal(parseAmount('₦-1,500.00').neg, true);
  assert.equal(parseAmount('abc'), null);
});

/* ---- CSV ---- */

test('CSV with semicolons and decimal commas', () => {
  const r = parseInput('Date;Description;Debit;Credit;Balance\n28/10/2026;"POS, SHOPRITE";"1.234,56";;"10.000,00"\n29/10/2026;SALARY;;450.000,00;460.000,00');
  assert.deepEqual(r.items.map((i) => [i.date, i.description, i.amount, i.direction, i.balance]),
    [['2026-10-28', 'POS, SHOPRITE', 1234.56, 'debit', 10000], ['2026-10-29', 'SALARY', 450000, 'credit', 460000]]);
});

test('CSV with semicolons and a signed amount column', () => {
  const r = parseInput('Date;Description;Amount\n28/10/2026;POS SHOP;-1234,56\n29/10/2026;SALARY;450000,00');
  assert.deepEqual(r.items.map((i) => [i.amount, i.direction]), [[1234.56, 'debit'], [450000, 'credit']]);
});

test('CSV with a BOM and quoted commas', () => {
  const r = parseInput('﻿Date,Narration,Debit,Credit\n2026-10-28,"POS, SHOP, LEKKI",1500.00,\n2026-10-29,SALARY,,300000');
  assert.deepEqual(r.items.map((i) => [i.description, i.amount, i.direction]), [['POS, SHOP, LEKKI', 1500, 'debit'], ['SALARY', 300000, 'credit']]);
});

test('CSV signed amounts: minus, brackets, plus and currency after the sign', () => {
  const r = parseInput('Date,Description,Amount,Balance\n2026-10-28,POS SHOP,-1500.00,10000\n2026-10-29,SALARY,300000.00,310000\n2026-10-30,Fee,(50.00),309950\n'
    + '2026-10-31,Sign after symbol,"₦-2,000.00",307950\n2026-11-01,Plus,"+5,000.00",312950');
  assert.deepEqual(r.items.map((i) => [i.amount, i.direction]),
    [[1500, 'debit'], [300000, 'credit'], [50, 'debit'], [2000, 'debit'], [5000, 'credit']]);
  assert.equal(r.warnings.some((w) => /every row was read as a credit/.test(w)), false);
});

test('CSV with a Type column and tab delimiter', () => {
  const r = parseInput('Date\tDescription\tAmount\tType\n28-Oct-2026\tPOS\t1,500.00\tDR\n29-Oct-2026\tSALARY\t9,000.00\tCR');
  assert.deepEqual(r.items.map((i) => i.direction), ['debit', 'credit']);
});

test('date formats all land on the same day', () => {
  for (const d of ['28-Oct-2026', '28/10/2026', '2026-10-28', 'Oct 28, 2026', '28 October 2026', '28-10-2026', '28.10.2026']) {
    expect(one('Debit Alert\nAmt: NGN 10.00\nDesc: X\nDate: ' + d), { date: '2026-10-28' });
  }
});

test('never throws on awkward input', () => {
  for (const x of ['&nbsp;<br>', '>>>>', 'Amt:', 'NGN', 'Date: 99/99/9999 Amt: NGN 5', '﻿', ';;;\n;;;', '"unterminated, quote\n', '\u0000\u0000']) {
    const r = parseInput(x);
    assert.ok(Array.isArray(r.items) && Array.isArray(r.warnings));
  }
});
