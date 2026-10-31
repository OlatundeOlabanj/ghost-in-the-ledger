'use strict';
// Ghost finding and storytelling.
// analyze(items) is pure and deterministic. haunt(items, opts) asks a model to rewrite each story,
// then checks every number in the story against the finding. Bad or missing answers fall back to templates.

const backendsLib = require('./backends');
const moneyLib = require('./money');

// ---- Thresholds (all money in major units, e.g. dollars or naira) ----
const MAX_FINDINGS = 5;              // never return more than this many findings
const MAX_EVIDENCE = 10;             // evidence lines stored per finding
const PROMPT_EVIDENCE = 6;           // evidence lines shown to a model, at most
const MODEL_TIMEOUT_MS = 60000;      // per model call, local models (small models on a CPU are slow)
const GROQ_TIMEOUT_MS = 15000;       // per model call, hosted Groq
const MODEL_BUDGET_MS = 150000;      // total time for all stories, then templates take over

const SUB_MIN_OCCURRENCES = 3;       // a subscription repeats at least this many times
const SUB_AMOUNT_TOLERANCE = 0.1;    // amounts within 10% of the median count as "similar"
const SUB_MONTHLY_DAYS = [25, 35];   // gap range (days) for a monthly pattern
const SUB_WEEKLY_DAYS = [6, 8];      // gap range (days) for a weekly pattern
const SUB_GAP_SHARE = 0.75;          // share of gaps that must fit the cadence

// Bank fee words from many countries: Nigerian (SMS charge, VAT, stamp duty, COT) and global
// (overdraft, monthly maintenance, ATM fee, foreign transaction, wire fee, NSF).
const FEE_PATTERN = new RegExp('\\b(?:sms|vat|stamp\\s*duty|maintenance|commission|charges?|fees?|levy|cot|overdraft|nsf|'
  + 'non[-\\s]?sufficient|insufficient\\s+funds?|returned\\s+(?:item|payment|cheque|check)|surcharge|'
  + 'foreign\\s+(?:transaction|exchange|currency|usage)|international\\s+(?:transaction|usage)|currency\\s+conversion|fx\\s+(?:fee|charge|markup)|'
  + 'wire\\s+(?:fee|charge|transfer\\s+fee)|atm\\s+(?:fee|charge|surcharge)|interest\\s+charge[sd]?|finance\\s+charge|'
  + 'late\\s+(?:fee|payment\\s+fee)|annual\\s+fee|account\\s+fee|service\\s+(?:fee|charge))\\b', 'i');
const FEE_MIN_COUNT = 2;             // at least two fee lines before we call it a haunting

const NIGHT_FIRST_HOUR = 0;          // 00:00 ...
const NIGHT_LAST_HOUR = 4;           // ... through 04:59
const NIGHT_MIN_COUNT = 2;

const PAYDAY_MIN_CREDIT = 10000;     // smallest credit that can be a "payday" (naira scale, see thresholdsFor)
const PAYDAY_WINDOW_DAYS = 3;        // days after the credit (same day counts)
const PAYDAY_SPENT_RATIO = 0.7;      // this much of the credit must be gone

const LEAK_MIN_COUNT = 4;            // many small debits to one place
const LEAK_SMALL_MAX = 5000;         // each one at most this size (naira scale)

const ROUND_MULTIPLE = 10000;        // "round" means a multiple of this (naira scale)
const ROUND_MIN_AMOUNT = 20000;      // (naira scale)
const ROUND_MIN_COUNT = 2;

// Money limits depend on the currency. Naira keeps the constants above; other currencies are scaled
// from rough units per US dollar so that, for example, 25 dollars is a small purchase and 150 is a payday.
const PER_USD = { USD: 1, GBP: 0.8, EUR: 0.92, CAD: 1.35, AUD: 1.5, NZD: 1.65, CHF: 0.9, SGD: 1.35, KES: 130, GHS: 15, ZAR: 18, INR: 85, JPY: 150, NGN: 1500 };
const USD_LIMITS = { payday: 150, leak: 25, roundMult: 100, roundMin: 200 };

function nice(x) {
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / mag;
  return mag * (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10);
}

function thresholdsFor(cur) {
  if (cur === 'NGN') return { payday: PAYDAY_MIN_CREDIT, leak: LEAK_SMALL_MAX, roundMult: ROUND_MULTIPLE, roundMin: ROUND_MIN_AMOUNT };
  const r = PER_USD[cur] || 1;
  return { payday: nice(USD_LIMITS.payday * r), leak: nice(USD_LIMITS.leak * r), roundMult: nice(USD_LIMITS.roundMult * r), roundMin: nice(USD_LIMITS.roundMin * r) };
}

// How many findings of each kind can reach the final list (keeps the list varied).
const PER_KIND_LIMIT = { subscription: 2, fees: 1, night: 1, payday: 1, leak: 1, biggest: 1, round: 1 };
// The five story themes. They come first; round and biggest only fill slots the themes leave empty.
const THEME_KINDS = ['subscription', 'fees', 'payday', 'night', 'leak'];
const KIND_ORDER = ['subscription', 'fees', 'payday', 'night', 'leak', 'round', 'biggest'];

// ---- small helpers ----
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (arr) => round2(arr.reduce((a, b) => a + b, 0));

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dayNumber(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

function hourOf(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
  return m ? +m[1] : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(date) {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(date || '');
  return m && MONTHS[+m[1] - 1] ? MONTHS[+m[1] - 1] : null;
}

// Short readable name for a transaction description.
function cleanName(desc) {
  const words = String(desc || '').split('*')[0].replace(/\s+/g, ' ').trim().split(' ')
    .filter((w) => !/\d{3,}/.test(w));
  const out = words.join(' ').trim() || String(desc || '').trim() || 'Unknown';
  return out.length > 40 ? out.slice(0, 40).trim() : out;
}

// Grouping key: same place even if reference numbers differ.
function nameKey(desc) {
  const base = String(desc || '').toLowerCase().replace(/[^a-z\s]/g, ' ')
    .replace(/\b(pos|web|atm|nip|trf|transfer|to|from|purchase|payment|debit|alert|ref|txn|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const key = base.split(' ').filter(Boolean).slice(0, 3).join(' ');
  return key || String(desc || '').toLowerCase().trim();
}

function topCurrency(items) {
  const counts = new Map();
  for (const it of items) {
    const c = it.currency || 'USD';
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let best = 'USD', bestN = 0;
  for (const [c, n] of counts) if (n > bestN || (n === bestN && c < best)) { best = c; bestN = n; }
  return best;
}

// Keeps valid items in date order. Items in another currency than the main one are dropped, because
// amounts in different currencies are never added together.
function normalizeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const main = moneyLib.dominantCurrency(list.filter((it) => it && typeof it === 'object' && Number.isFinite(it.amount) && it.amount > 0
    && (it.direction === 'debit' || it.direction === 'credit')), 'USD');
  return list
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it && typeof it === 'object' && Number.isFinite(it.amount) && it.amount > 0
      && (it.direction === 'debit' || it.direction === 'credit') && (!it.currency || it.currency === main))
    .sort((a, b) => {
      const x = a.it, y = b.it;
      return String(x.date || '9999').localeCompare(String(y.date || '9999'))
        || String(x.time || '99:99').localeCompare(String(y.time || '99:99'))
        || a.idx - b.idx;
    })
    .map(({ it }) => it);
}

const isFee = (it) => FEE_PATTERN.test(it.description || '');
const byAmountDesc = (a, b) => b.amount - a.amount;

// ---- detectors: each returns an array of { kind, amount, evidence, facts } ----

function detectSubscriptions(debits) {
  const groups = new Map();
  for (const it of debits) {
    if (!it.date || isFee(it)) continue;
    const k = nameKey(it.description);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const found = [];
  const names = new Set();
  for (const [key, list] of groups) {
    if (list.length < SUB_MIN_OCCURRENCES) continue;
    const med = median(list.map((x) => x.amount));
    const similar = list.filter((x) => Math.abs(x.amount - med) <= med * SUB_AMOUNT_TOLERANCE);
    if (similar.length < SUB_MIN_OCCURRENCES) continue;
    const gaps = [];
    for (let i = 1; i < similar.length; i++) gaps.push(dayNumber(similar[i].date) - dayNumber(similar[i - 1].date));
    const fits = (range) => gaps.filter((g) => g >= range[0] && g <= range[1]).length / gaps.length;
    let cadence = null;
    if (fits(SUB_MONTHLY_DAYS) >= SUB_GAP_SHARE) cadence = 'monthly';
    else if (fits(SUB_WEEKLY_DAYS) >= SUB_GAP_SHARE) cadence = 'weekly';
    if (!cadence) continue;
    names.add(key);
    found.push({
      kind: 'subscription',
      amount: sum(similar.map((x) => x.amount)),
      evidence: similar.slice(0, MAX_EVIDENCE),
      facts: {
        name: cleanName(similar[0].description),
        count: similar.length,
        cadence,
        each: round2(med),
        total: sum(similar.map((x) => x.amount)),
        firstDate: similar[0].date,
        lastDate: similar[similar.length - 1].date,
        currency: topCurrency(similar),
      },
    });
  }
  return { found, names };
}

function detectFees(debits) {
  const fees = debits.filter(isFee);
  if (fees.length < FEE_MIN_COUNT) return [];
  const total = sum(fees.map((x) => x.amount));
  return [{
    kind: 'fees',
    amount: total,
    evidence: fees.slice().sort(byAmountDesc).slice(0, MAX_EVIDENCE),
    facts: { count: fees.length, total, largest: Math.max(...fees.map((x) => x.amount)), currency: topCurrency(fees) },
  }];
}

function detectNight(debits) {
  const night = debits.filter((x) => {
    const h = hourOf(x.time);
    return h !== null && h >= NIGHT_FIRST_HOUR && h <= NIGHT_LAST_HOUR && !isFee(x);
  });
  if (night.length < NIGHT_MIN_COUNT) return [];
  const total = sum(night.map((x) => x.amount));
  const biggest = night.slice().sort(byAmountDesc)[0];
  return [{
    kind: 'night',
    amount: total,
    evidence: night.slice().sort(byAmountDesc).slice(0, MAX_EVIDENCE),
    facts: { count: night.length, total, largest: biggest.amount, largestName: cleanName(biggest.description), currency: topCurrency(night) },
  }];
}

function detectPayday(items, th) {
  const credits = items.filter((x) => x.direction === 'credit' && x.date && x.amount >= th.payday);
  const debits = items.filter((x) => x.direction === 'debit' && x.date);
  const used = new Set();
  const found = [];
  for (const credit of credits) {
    const start = dayNumber(credit.date);
    const mine = debits.filter((d) => {
      if (used.has(d)) return false;
      const gap = dayNumber(d.date) - start;
      return gap >= 0 && gap <= PAYDAY_WINDOW_DAYS;
    });
    const spent = sum(mine.map((d) => d.amount));
    if (spent < credit.amount * PAYDAY_SPENT_RATIO) continue;
    mine.forEach((d) => used.add(d));
    const shown = Math.min(spent, credit.amount);
    found.push({
      kind: 'payday',
      amount: round2(shown),
      evidence: [credit].concat(mine.slice().sort(byAmountDesc)).slice(0, MAX_EVIDENCE),
      facts: {
        creditAmount: credit.amount,
        creditDate: credit.date,
        spent: round2(shown),
        percent: Math.round((shown / credit.amount) * 100),
        days: PAYDAY_WINDOW_DAYS,
        currency: credit.currency || 'USD',
      },
    });
  }
  return found;
}

function detectLeaks(debits, subNames, th) {
  const groups = new Map();
  for (const it of debits) {
    if (isFee(it) || it.amount > th.leak) continue;
    const k = nameKey(it.description);
    if (subNames.has(k)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const found = [];
  for (const list of groups.values()) {
    if (list.length < LEAK_MIN_COUNT) continue;
    const total = sum(list.map((x) => x.amount));
    found.push({
      kind: 'leak',
      amount: total,
      evidence: list.slice(0, MAX_EVIDENCE),
      facts: { name: cleanName(list[0].description), count: list.length, total, average: round2(total / list.length), currency: topCurrency(list) },
    });
  }
  return found;
}

function detectRound(debits, subNames, th) {
  const round = debits.filter((x) => !isFee(x) && !subNames.has(nameKey(x.description))
    && x.amount >= th.roundMin && x.amount % th.roundMult === 0);
  if (round.length < ROUND_MIN_COUNT) return [];
  const total = sum(round.map((x) => x.amount));
  return [{
    kind: 'round',
    amount: total,
    evidence: round.slice().sort(byAmountDesc).slice(0, MAX_EVIDENCE),
    facts: { count: round.length, total, largest: Math.max(...round.map((x) => x.amount)), currency: topCurrency(round) },
  }];
}

function detectBiggest(debits) {
  if (!debits.length) return [];
  let top = debits[0];
  for (const d of debits) if (d.amount > top.amount) top = d;
  return [{
    kind: 'biggest',
    amount: top.amount,
    evidence: [top],
    facts: { name: cleanName(top.description), amount: top.amount, date: top.date, currency: top.currency || 'USD' },
  }];
}

// analyze(items) -> Finding[] sorted by amount descending, at most MAX_FINDINGS.
function analyze(items) {
  const all = normalizeItems(items);
  const debits = all.filter((x) => x.direction === 'debit');
  if (!debits.length) return [];

  const th = thresholdsFor(moneyLib.dominantCurrency(all, 'USD'));
  const subs = detectSubscriptions(debits);
  let candidates = [].concat(
    subs.found,
    detectFees(debits),
    detectPayday(all, th),
    detectNight(debits),
    detectLeaks(debits, subs.names, th),
    detectRound(debits, subs.names, th),
    detectBiggest(debits)
  );

  // Order, then limit per kind, then number the ids inside each kind.
  const rank = (f) => KIND_ORDER.indexOf(f.kind);
  const cmp = (a, b) => b.amount - a.amount || rank(a) - rank(b);
  candidates.sort(cmp);
  const seen = {};
  candidates = candidates.filter((f) => {
    seen[f.kind] = (seen[f.kind] || 0) + 1;
    f.id = f.kind + '-' + seen[f.kind];
    return seen[f.kind] <= PER_KIND_LIMIT[f.kind];
  });

  // The five story themes come first. Round and heaviest transfers only fill slots the themes leave empty,
  // so a big rent payment cannot push out the night spender or the leaky ghost.
  const themes = candidates.filter((f) => THEME_KINDS.includes(f.kind));
  const fillers = candidates.filter((f) => !THEME_KINDS.includes(f.kind));
  const top = themes.slice(0, MAX_FINDINGS);
  // The best subscription is always kept: it is small next to rent, but it is the ghost people forget.
  const sub = themes.find((f) => f.kind === 'subscription');
  if (sub && !top.includes(sub)) top[top.length - 1] = sub;
  for (const f of fillers) {
    if (top.length >= MAX_FINDINGS) break;
    top.push(f);
  }
  top.sort(cmp);
  return top.map((f) => ({ id: f.id, kind: f.kind, amount: f.amount, evidence: f.evidence, facts: f.facts }));
}

// ---- templates ----

function money(n, currency) { return moneyLib.formatMoney(n, currency); }

function plural(n, one, many) { return n === 1 ? one : many; }

// Deterministic title and story, built only from computed facts.
function templateGhost(finding) {
  const f = finding.facts || {};
  const cur = f.currency;
  let title, story;
  switch (finding.kind) {
    case 'subscription':
      title = 'The ' + f.name + ' Phantom';
      story = f.name + ' has slipped out of your account ' + f.count + ' times, ' + money(f.each, cur) + ' each, ' + money(f.total, cur)
        + ' in all. It returns ' + (f.cadence === 'weekly' ? 'every week' : 'every month') + ' like a ghost with a key. If you still love it, wave hello; if not, banish it.';
      break;
    case 'fees':
      title = 'The Fee Poltergeist';
      story = f.count + ' small bank charges drifted through your account, ' + money(f.total, cur) + ' together. Nobody invited them, yet they keep rattling the chains. Ask your bank which ones you can switch off.';
      break;
    case 'night':
      title = 'The Midnight Spender';
      story = f.count + ' debits left your account in the small hours, ' + money(f.total, cur) + ' in all. The biggest was ' + money(f.largest, cur) + ' to ' + f.largestName + '. Sleep is cheaper than a night shopping spree.';
      break;
    case 'payday':
      title = 'The Payday Vanishing Act';
      story = 'A credit of ' + money(f.creditAmount, cur) + ' arrived' + (monthName(f.creditDate) ? ' in ' + monthName(f.creditDate) : '')
        + ', and within ' + f.days + ' days ' + money(f.spent, cur) + ' of it (' + f.percent + '%) was gone. Payday ghosts work fast and leave no footprints.';
      break;
    case 'leak':
      title = 'The Leaky Ghost of ' + f.name;
      story = f.count + ' small payments to ' + f.name + ' added up to ' + money(f.total, cur) + ', about ' + money(f.average, cur) + ' each time. Tiny drips fill a very large haunted bucket.';
      break;
    case 'round':
      title = 'The Round Number Wraith';
      story = f.count + ' payments were suspiciously round, ' + money(f.total, cur) + ' in total, the largest ' + money(f.largest, cur)
        + '. Round numbers are often guesses, not counts, so check they were meant.';
      break;
    default: // biggest
      title = 'The Heaviest Ghost';
      story = 'Your largest single debit was ' + money(f.amount, cur) + ' to ' + f.name + '. It casts the longest shadow over your ledger, so give it a second look.';
  }
  return { id: finding.id, kind: finding.kind, title, story, amount: finding.amount, evidence: finding.evidence };
}

// ---- number verification ----

// A number is a comma-grouped amount (1,300.50), a plain number, or digit groups split by spaces (1 300).
// Also reads European style numbers: 1.234,56 and 20,00.
const NUM_RE = /\d{1,3}(?:[.    ]\d{3})+,\d{1,2}(?!\d)|\d{1,3}(?:[,    ']\d{3})+(?:\.\d+)?(?!\d)|\d+,\d{1,2}(?!\d)|\d+(?:\.\d+)?/g;
const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1000000, dozen: 12, twice: 2, thrice: 3, double: 2, triple: 3, half: 0.5,
};
const SUFFIX = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function parseNum(token) {
  let t = token;
  if (/^\d{1,3}(?:[.    ]\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/[.    ]/g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  const n = Number(t.replace(/[,    ']/g, ''));
  return Number.isFinite(n) ? n : null;
}

function addAllowed(set, n) {
  if (!Number.isFinite(n)) return;
  const a = Math.abs(n);
  [a, Math.round(a), Math.floor(a), round2(a)].forEach((v) => set.add(v));
}

const ISO_RE = /(\d{4})-(\d{2})-(\d{2})/g;
const TIME_RE = /(?<!\d)(\d{1,2}):(\d{2})(?::\d{2})?(?!\d)/g;
const timeKey = (h, m) => (Number(h) % 12) + ':' + String(m).padStart(2, '0');

// allowed = { main: numbers, dates: date parts, times: "h:mm" keys, words: words seen in names }
function collect(value, allowed) {
  if (typeof value === 'number') addAllowed(allowed.main, value);
  else if (typeof value === 'string') {
    (value.toLowerCase().match(/[a-z]+/g) || []).forEach((w) => allowed.words.add(w));
    let rest = value.replace(ISO_RE, (all, y, m, d) => {
      [y, m, d].forEach((x) => addAllowed(allowed.dates, Number(x)));
      return ' ';
    });
    rest = rest.replace(TIME_RE, (all, h, m) => { allowed.times.add(timeKey(h, m)); return ' '; });
    for (const tok of rest.match(NUM_RE) || []) {
      const n = parseNum(tok);
      if (n !== null) addAllowed(allowed.main, n);
    }
  } else if (Array.isArray(value)) value.forEach((v) => collect(v, allowed));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collect(v, allowed));
}

// Only what a model was shown counts as evidence: amount, date, time and description (never the balance).
function evidenceFacts(list) {
  return (list || []).map((it) => ({ amount: it.amount, date: it.date, time: it.time, description: it.description }));
}

// Every number in the story must appear in the finding (facts, amount or the evidence shown).
// Handles currency symbols, "1.3k" style suffixes, number words, spaced digit groups, times and dates.
// A story must read like a story, not like a copied data line. Small models sometimes echo the example lines.
function looksLikeStory(story, evidenceShown) {
  const t = String(story).trim();
  if (t.includes('|')) return false;                               // copied "date | description" rows
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false;                  // starts like a data row
  if ((t.match(/[A-Za-z']+/g) || []).length < 4) return false;     // too short to be a sentence
  if (!/[.!?]["')\]]*$/.test(t)) return false;                     // does not end like a sentence
  const lower = t.toLowerCase();
  for (const it of evidenceShown || []) {                          // long verbatim copy of a data line
    const d = String(it.description || '').toLowerCase().trim();
    if (d.length >= 18 && lower.includes(d) && /\d{4}-\d{2}-\d{2}/.test(t)) return false;
  }
  return true;
}

function verifyStory(story, finding, evidenceShown) {
  const allowed = { main: new Set(), dates: new Set(), times: new Set(), words: new Set() };
  collect(finding.facts, allowed);
  collect(finding.amount, allowed);
  collect(evidenceFacts(evidenceShown || finding.evidence), allowed);

  let text = String(story).normalize('NFKC');
  if (/[^\x00-\x7f]/.test(text) && /\p{Nd}/u.test(text.replace(/[0-9]/g, ''))) return false; // non-ASCII digits

  // Dates written as 2026-08-09 and times such as 2:14 AM.
  let ok = true;
  text = text.replace(ISO_RE, (all, y, m, d) => {
    [y, m, d].forEach((x) => { if (!allowed.dates.has(Number(x)) && !allowed.main.has(Number(x))) ok = false; });
    return ' ';
  });
  text = text.replace(TIME_RE, (all, h, m) => { if (!allowed.times.has(timeKey(h, m))) ok = false; return ' '; });
  if (!ok) return false;

  const monthBefore = new RegExp('\\b' + MONTH_RE + '\\.?[\\s,]*$', 'i');
  const monthAfter = new RegExp('^[\\s,]*(?:of\\s+)?' + MONTH_RE + '\\b', 'i');
  const re = new RegExp(NUM_RE.source + '(?:\\s?(k|mn|bn|m|b|thousand|million|billion)\\b)?', 'gi');
  for (const m of text.matchAll(re)) {
    let n = parseNum(m[0].replace(/\s?(?:k|mn|bn|m|b|thousand|million|billion)$/i, ''));
    if (n === null) return false;
    if (m[1]) n *= SUFFIX[m[1].toLowerCase()];
    if (allowed.main.has(n) || allowed.main.has(round2(n))) continue;
    const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
    const dateContext = /^(?:st|nd|rd|th)\b/i.test(after) || monthBefore.test(before) || monthAfter.test(after)
      || (n >= 1900 && n <= 2100 && Number.isInteger(n));
    if (dateContext && !m[1] && allowed.dates.has(n)) continue;
    return false;
  }
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) && !allowed.main.has(NUMBER_WORDS[w]) && !allowed.words.has(w)) return false;
  }
  return true;
}

// ---- model prompt ----

const SYSTEM_PROMPT = [
  'You write tiny spooky but friendly ghost stories about personal spending.',
  'Write exactly 2 short sentences. Use the facts below.',
  'Copy every number exactly as given. Never add other numbers, names or dates.',
  'Plain text only. No lists, no markdown, no emoji. Reply with the story only.',
].join(' ');

const SYSTEM_PROMPT_COMPACT = 'Write 2 short spooky friendly sentences about this spending. Copy the numbers exactly. No other numbers. Story only.';

function evidenceLine(it) {
  return [it.date || 'no date', it.time || '', it.direction, it.amount, it.currency || '', '|', it.description].filter((x) => x !== '').join(' ');
}

// Short "key: value" list, easier for a small model than a JSON blob.
function factLines(facts) {
  return Object.keys(facts || {}).map((k) => {
    const v = facts[k];
    return (v === null || typeof v === 'object') ? null : '- ' + k + ': ' + v;
  }).filter(Boolean).join('\n');
}

// compact: a shorter prompt for slow computers (a small model reads a long prompt very slowly on a CPU).
function buildPrompt(finding, opts) {
  const compact = !!(opts && opts.compact);
  const shown = (finding.evidence || []).slice(0, compact ? 2 : PROMPT_EVIDENCE);
  const user = 'Ghost type: ' + finding.kind + '\nFacts:\n' + factLines(finding.facts)
    + (compact ? '' : '\nExample lines:\n' + shown.map(evidenceLine).join('\n'))
    + '\nWrite 2 spooky, friendly sentences now. Reuse the numbers exactly.';
  return { system: compact ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT, user, shown };
}

function cleanStory(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u2013\u2014]/g, ', ').replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  s = s.replace(/,\s*,/g, ',').replace(/\s+,/g, ',');
  if (!s || s.length > 600) return null;
  return s;
}

class TimeoutError extends Error {
  constructor(ms) { super('timed out after ' + ms + ' ms'); this.name = 'TimeoutError'; }
}

// Runs fn(signal) but gives up after ms, even if fn ignores the signal.
function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new TimeoutError(ms)); }, ms);
  });
  let p;
  try { p = Promise.resolve(fn(ctrl.signal)); } catch (e) { p = Promise.reject(e); }
  p.catch(() => {}); // avoid unhandled rejection if the timeout wins
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function positiveNum(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// haunt(items, opts) -> { ghosts, backend, model, warnings }
// opts: { env, fetch, backend (a ready backend object), timeoutMs, budgetMs }
// Stories are made one after another. Each model call has its own timeout (GHOST_TIMEOUT_MS) and all calls
// together share a budget (GHOST_BUDGET_MS). Past either limit the rest use templates, with ONE warning.
async function haunt(items, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const warnings = [];
  const findings = analyze(items);
  const backend = o.backend || (await backendsLib.pick(env, { fetch: o.fetch }));
  const defaultTimeout = backend.name === 'groq' ? GROQ_TIMEOUT_MS : MODEL_TIMEOUT_MS;
  const timeoutMs = positiveNum(o.timeoutMs) || positiveNum(env.GHOST_TIMEOUT_MS) || defaultTimeout;
  const budgetMs = positiveNum(o.budgetMs) || positiveNum(env.GHOST_BUDGET_MS) || MODEL_BUDGET_MS;
  if (backend.warning) warnings.push(backend.warning);
  if (!findings.length) warnings.push('No debits found, so there is nothing to haunt.');
  const mixed = moneyLib.mixedWarning(items);
  if (mixed) warnings.push(mixed);

  const secrets = [env.GROQ_API_KEY];
  const ghosts = [];
  let answered = 0;
  let broken = false;
  let replaced = 0;
  const rejectedNotes = [];
  const fail = (msg) => { broken = true; warnings.push(msg); };

  // Warm up a local model first (loading it can take a while on a slow computer), so that time is not charged to story one.
  if (findings.length && backend.name !== 'offline' && typeof backend.warm === 'function') {
    try {
      await withTimeout((signal) => backend.warm({ signal }), Math.max(timeoutMs, 60000));
    } catch (err) {
      const why = err && err.name === 'TimeoutError' ? 'timed out while loading the model' : backendsLib.redact(err && err.message, secrets).slice(0, 120);
      fail(backend.name + ' did not answer (' + why + '), so offline templates were used.');
    }
  }
  const startedAt = Date.now();
  // Slow computers: GHOST_COMPACT=1 uses a shorter prompt, GHOST_MAX_STORIES=N lets the model write only the first N stories.
  const compact = String(env.GHOST_COMPACT || '') === '1';
  const maxStories = positiveNum(env.GHOST_MAX_STORIES) || Infinity;
  let attempted = 0;
  let skippedForSpeed = 0;

  for (const finding of findings) {
    const template = templateGhost(finding);
    if (backend.name === 'offline' || broken) { ghosts.push(template); continue; }
    if (attempted >= maxStories) { skippedForSpeed++; ghosts.push(template); continue; }
    attempted++;
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      fail('The ' + backend.name + ' model used up its time budget (' + Math.round(budgetMs / 1000) + ' s), so the remaining stories use offline templates.');
      ghosts.push(template);
      continue;
    }
    const limit = Math.min(timeoutMs, remaining);
    const { system, user, shown } = buildPrompt(finding, { compact });
    let raw;
    try {
      raw = await withTimeout((signal) => backend.complete({ system, user, signal }), limit);
    } catch (err) {
      if (err && err.name === 'TimeoutError') {
        if (limit < timeoutMs) fail('The ' + backend.name + ' model used up its time budget (' + Math.round(budgetMs / 1000) + ' s), so the remaining stories use offline templates.');
        else fail(backend.name + ' did not answer (timed out after ' + Math.round(timeoutMs / 1000) + ' s), so offline templates were used. On a slow computer, raise GHOST_TIMEOUT_MS or use a smaller model.');
      } else {
        fail(backend.name + ' did not answer (' + backendsLib.redact(err && err.message, secrets).slice(0, 120) + '), so offline templates were used.');
      }
      ghosts.push(template);
      continue;
    }
    const story = raw == null ? null : cleanStory(raw);
    const readable = story ? looksLikeStory(story, shown) : false;
    if (story && readable && verifyStory(story, finding, shown)) {
      ghosts.push(Object.assign({}, template, { story }));
      answered++;
    } else {
      if (raw != null) {
        replaced++;
        if (story && rejectedNotes.length < 2) {
          const quote = story.length > 160 ? story.slice(0, 157) + '...' : story;
          rejectedNotes.push(backend.model + ' wrote: "' + quote + '" and it was replaced because ' + (readable ? 'it used a number that is not in your data.' : 'it did not read like a real story.'));
        }
      }
      ghosts.push(template);
    }
  }
  if (skippedForSpeed) {
    warnings.push('To save time on this computer, the model wrote the first ' + attempted + (attempted === 1 ? ' story' : ' stories') + ' and the other ' + skippedForSpeed + ' use plain templates.');
  }
  if (replaced) {
    warnings.push(replaced + (replaced === 1 ? ' story from ' : ' stories from ') + backend.name + (replaced === 1 ? ' was' : ' were')
      + ' replaced by a template because ' + (replaced === 1 ? 'it' : 'they') + ' failed a check (an invented number, or text that was not a real story).');
  }

  for (const n of rejectedNotes) warnings.push(n);

  return {
    ghosts,
    backend: answered > 0 ? backend.name : 'offline',
    model: answered > 0 ? backend.model : 'template',
    warnings,
  };
}

module.exports = {
  analyze, cleanName, haunt, looksLikeStory, templateGhost, verifyStory, buildPrompt, cleanStory, withTimeout, TimeoutError,
  constants: {
    MAX_FINDINGS, MAX_EVIDENCE, PROMPT_EVIDENCE, MODEL_TIMEOUT_MS, GROQ_TIMEOUT_MS, MODEL_BUDGET_MS,
    SUB_MIN_OCCURRENCES, SUB_AMOUNT_TOLERANCE, SUB_MONTHLY_DAYS, SUB_WEEKLY_DAYS, SUB_GAP_SHARE,
    FEE_MIN_COUNT, NIGHT_FIRST_HOUR, NIGHT_LAST_HOUR, NIGHT_MIN_COUNT,
    PAYDAY_MIN_CREDIT, PAYDAY_WINDOW_DAYS, PAYDAY_SPENT_RATIO,
    LEAK_MIN_COUNT, LEAK_SMALL_MAX, ROUND_MULTIPLE, ROUND_MIN_AMOUNT, ROUND_MIN_COUNT, PER_KIND_LIMIT,
  },
};
