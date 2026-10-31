'use strict';
/*
 * Ghost in the Ledger: money helpers shared by ingest, ghosts and the server.
 * Currency detection (symbols and ISO codes), formatting with Intl.NumberFormat,
 * the dominant currency of a list of items, and the mixed currency warning.
 * Pure, no network, never throws.
 */

const FALLBACK_CODES = ['USD', 'GBP', 'EUR', 'NGN', 'KES', 'GHS', 'ZAR', 'INR', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'AED', 'SAR', 'QAR', 'EGP', 'MAD', 'TZS', 'UGX', 'RWF', 'XOF', 'XAF', 'BRL', 'MXN', 'ARS',
  'CLP', 'COP', 'PEN', 'SGD', 'HKD', 'MYR', 'THB', 'IDR', 'PHP', 'VND', 'KRW', 'PKR', 'BDT', 'LKR', 'ILS', 'UAH', 'ISK'];

let CODES;
try { CODES = new Set(Intl.supportedValuesOf('currency')); } catch (e) { CODES = new Set(FALLBACK_CODES); }
FALLBACK_CODES.forEach(function (c) { CODES.add(c); });

// Three letter ISO codes that are also everyday English words (or names). They only count when written
// right next to an amount AND they are not in this list.
const CODE_STOPLIST = new Set(['ALL', 'TOP', 'TRY', 'PEN', 'CUP', 'BOB', 'GEL', 'SOS', 'MAD', 'KIP', 'LAK', 'MOP', 'BAM', 'ANG', 'COP', 'LEK', 'DOP', 'PAB', 'LYD']);

function isCurrencyCode(c) {
  c = String(c || '');
  return /^[A-Z]{3}$/.test(c) && CODES.has(c) && !CODE_STOPLIST.has(c);
}

// Written symbols, longest first. Each maps to an ISO code.
const SYMBOLS = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['AU$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['C$', 'CAD'], ['A$', 'AUD'], ['S$', 'SGD'],
  ['GH₵', 'GHS'], ['KSh', 'KES'], ['Ksh', 'KES'], ['Rs.', 'INR'], ['Rs', 'INR'],
  ['₦', 'NGN'], ['₹', 'INR'], ['£', 'GBP'], ['€', 'EUR'], ['¥', 'JPY'], ['₵', 'GHS'], ['$', 'USD']
];
const SYMBOL_CODE = {};
SYMBOLS.forEach(function (p) { SYMBOL_CODE[p[0]] = p[1]; });

// Regex source that matches a currency marker written before an amount. Three letter groups are validated by the caller.
const PRE_SRC = '(?:US\\$|CA\\$|AU\\$|NZ\\$|HK\\$|C\\$|A\\$|S\\$|GH\\u20b5|KSh\\.?|Ksh\\.?|Rs\\.?|[\\u20a6\\u20b9\\u00a3\\u20ac\\u00a5\\u20b5$]|(?<![A-Za-z])R(?=\\d)|(?<![A-Za-z])N(?=\\s?\\d)|(?<![A-Za-z])[A-Z]{3}(?![A-Za-z]))';
const NUM_SRC = '(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+,\\d{1,2}|\\d+(?:[.,]\\d{1,2})?)(?!\\d)';
const SIGN = '[-+\\u2212\\u2013]';
const MONEY_SRC = '(?<sg1>(?<![\\w$\\u00a3\\u20ac])' + SIGN + ')?(?<op>\\(?)\\s{0,2}(?:(?<pre>' + PRE_SRC + ')\\s{0,2}(?<sg2>' + SIGN + ')?\\s{0,2}(?<n1>' + NUM_SRC + ')'
  + '|(?<![\\d/:.\\-,])(?<n2>' + NUM_SRC + ')\\s{0,2}(?<post>[\\u20a6\\u20b9\\u00a3\\u20ac\\u00a5\\u20b5$]|[A-Z]{3})(?![A-Za-z\\d])(?!\\s?\\d))\\)?';

// Code for a marker string such as "$", "NGN", "KSh" or "N". Returns null for things that are not currencies.
function codeOf(marker) {
  if (!marker) return null;
  let m = String(marker).trim();
  if (SYMBOL_CODE[m]) return SYMBOL_CODE[m];
  if (/^KSh\.?$/i.test(m)) return 'KES';
  if (/^Rs\.?$/i.test(m)) return 'INR';
  if (m === 'N') return 'NGN';
  if (m === 'R') return 'ZAR';
  if (/^naira$/i.test(m)) return 'NGN';
  m = m.toUpperCase();
  return isCurrencyCode(m) ? m : null;
}

// All amounts that carry a currency marker, in order. Each: { index, end, raw, cur }.
// raw is the matched text including a sign or brackets, ready for parseAmount.
function findMoney(text) {
  const out = [];
  const s = String(text || '');
  const re = new RegExp(MONEY_SRC, 'g');
  for (const m of s.matchAll(re)) {
    const g = m.groups;
    const marker = g.pre !== undefined ? g.pre : g.post;
    const cur = codeOf(marker);
    if (!cur) continue;
    out.push({ index: m.index, end: m.index + m[0].length, raw: m[0], cur: cur });
  }
  return out;
}

// First currency marker found in text, or null.
function firstCurrency(text) {
  const f = findMoney(text);
  return f.length ? f[0].cur : null;
}

// Counts currency evidence in a whole document: markers next to amounts plus stand alone ISO codes
// (a "Currency" column, a header such as "Amount (GBP)").
function countCurrencies(text) {
  const counts = {};
  const s = String(text || '').slice(0, 3000000);
  const bump = function (c, n) { counts[c] = (counts[c] || 0) + (n || 1); };
  findMoney(s).forEach(function (f) { bump(f.cur); });
  for (const m of s.matchAll(/(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/g)) {
    if (isCurrencyCode(m[0])) bump(m[0]);
  }
  return counts;
}

function topOf(counts) {
  let best = null, bestN = 0;
  Object.keys(counts).sort().forEach(function (c) { if (counts[c] > bestN) { best = c; bestN = counts[c]; } });
  return best;
}

function dominantOfCounts(counts) { return topOf(counts); }

// Dominant currency of items (by number of items). Items without a currency are ignored. Ties go to the earlier code.
function dominantCurrency(items, fallback) {
  const counts = {};
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (it && it.currency) counts[it.currency] = (counts[it.currency] || 0) + 1;
  });
  return topOf(counts) || fallback || null;
}

function currencyCounts(items) {
  const counts = {};
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (it && it.currency) counts[it.currency] = (counts[it.currency] || 0) + 1;
  });
  return counts;
}

// Warning text when items use more than one currency, or null.
function mixedWarning(items) {
  const counts = currencyCounts(items);
  const codes = Object.keys(counts);
  if (codes.length < 2) return null;
  const main = topOf(counts);
  const parts = codes.sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })
    .map(function (c) { return counts[c] + ' in ' + c; });
  return 'This input mixes currencies (' + parts.join(', ') + '). They are never added together, so only the main one, ' + main
    + ', is counted and the rest is left out.';
}

// Locale used only to pick the local symbol. Digits always use "1,234.56" so stories are easy to verify.
const LOCALE = { NGN: 'en-NG', GBP: 'en-GB', EUR: 'en-IE', KES: 'en-KE', GHS: 'en-GH', CAD: 'en-CA', AUD: 'en-AU' };
const fmtCache = {};

function formatter(cur, whole) {
  const key = cur + (whole ? ':0' : ':2');
  if (!fmtCache[key]) {
    const opts = { style: 'currency', currency: cur };
    if (whole) { opts.minimumFractionDigits = 0; opts.maximumFractionDigits = 0; }
    else { opts.minimumFractionDigits = 2; opts.maximumFractionDigits = 2; }
    try { fmtCache[key] = new Intl.NumberFormat(LOCALE[cur] || 'en-US', opts); }
    catch (e) { fmtCache[key] = null; }
  }
  return fmtCache[key];
}

// formatMoney(1300, 'GBP') -> "£1,300", formatMoney(4.5, 'GBP') -> "£4.50"
function formatMoney(n, cur) {
  const x = Number(n);
  const v = Number.isFinite(x) ? x : 0;
  const c = /^[A-Z]{3}$/.test(String(cur)) && CODES.has(cur) ? cur : 'USD';
  const f = formatter(c, Number.isInteger(v));
  if (f) return f.format(v);
  return c + ' ' + v.toFixed(Number.isInteger(v) ? 0 : 2);
}

module.exports = {
  isCurrencyCode, codeOf, findMoney, firstCurrency, countCurrencies, dominantCurrency, dominantOfCounts,
  currencyCounts, mixedWarning, formatMoney, MONEY_SRC, NUM_SRC, PRE_SRC
};
