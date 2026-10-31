'use strict';
/*
 * Ghost in the Ledger: ingest.
 * parseInput(text, opts) turns pasted or uploaded text into Item[].
 * Handles CSV statements, pasted bank alerts (email or SMS style), raw .eml text
 * and plain lines. Pure, no network, never throws.
 *
 * Item = { date, time, description, amount, direction, currency, balance, source }
 */

const money = require('./money');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MAX_CHARS = 8000000;

function pad(n) { return String(n).padStart(2, '0'); }
function monthIndex(s) { return MONTHS.indexOf(String(s).slice(0, 3).toLowerCase()) + 1; }
function fixYear(y) { y = Number(y); if (y < 100) y += y < 70 ? 2000 : 1900; return y; }
function validYMD(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function fmtDate(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
function snippet(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  n = n || 60;
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function makeCtx(opts) {
  let today = opts && typeof opts.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.today)
    ? opts.today : new Date().toISOString().slice(0, 10);
  return { order: null, defaultOrder: 'dmy', orderNote: null, numUsed: 0, amb: 0, swapped: 0, noYear: 0, today: today };
}

/* ---------- amounts ---------- */

function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[   ]/g, ' ').trim();
  if (!s) return null;
  let dir = null;
  let m = s.match(/(?:^|\s)(DR|CR|DEBIT|CREDIT)\.?\s*$/i);
  if (m) { dir = /^d/i.test(m[1]) ? 'debit' : 'credit'; s = s.slice(0, m.index).trim(); }
  else {
    m = s.match(/^(DR|CR|DEBIT|CREDIT)\.?\s+(?=\S)/i);
    if (m) { dir = /^d/i.test(m[1]) ? 'debit' : 'credit'; s = s.slice(m[0].length).trim(); }
  }
  // currency markers: symbols, "NGN" style codes (any valid ISO code), "N" or "R" glued to a number
  let cur = null;
  s = s.replace(/US\$|CA\$|AU\$|NZ\$|HK\$|C\$|A\$|S\$|GH₵|KSh\.?|Ksh\.?|Rs\.?|NAIRA|[₦₹£€¥₵$]|(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/gi, function (t) {
    const c = money.codeOf(/^[a-z]{3}$/i.test(t) && !/^naira$/i.test(t) ? t.toUpperCase() : t);
    if (!c) return t;
    if (!cur) cur = c;
    return ' ';
  });
  s = s.replace(/\b([NR])(?=\s*[\d(+\-−–])/g, function (all, l) { if (!cur) cur = l === 'N' ? 'NGN' : 'ZAR'; return ' '; }).trim();
  const plus = /(^|[\s(])\+/.test(s);
  let neg = /^\s*\(.*\)\s*$/.test(s) || /(^|[\s(])[-−–]/.test(s) || /[-−–]\s*$/.test(s);
  const clean = s.replace(/[()\s+\-−–]/g, '');
  if (!clean || /[^\d.,']/.test(clean) || !/\d/.test(clean)) return null;
  const value = toNumber(clean.replace(/'/g, ''));
  if (value === null) return null;
  return { value: Math.abs(value), neg: neg, plus: plus, dir: dir || (neg ? 'debit' : null), cur: cur };
}

// "1,234.56", "1.234,56", "20,00", "1234" -> number. Returns null when it does not look like money.
function toNumber(clean) {
  let num;
  const hasC = clean.indexOf(',') >= 0, hasD = clean.indexOf('.') >= 0;
  if (hasC && hasD) {
    num = clean.lastIndexOf(',') > clean.lastIndexOf('.')
      ? clean.replace(/\./g, '').replace(',', '.')
      : clean.replace(/,/g, '');
  } else if (hasC) {
    if (/^\d{1,3}(,\d{3})+$/.test(clean)) num = clean.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(clean)) num = clean.replace(',', '.');
    else num = clean.replace(/,/g, '');
  } else if (hasD) {
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(clean)) num = clean.replace(/\./g, '');
    else if ((clean.match(/\./g) || []).length > 1) return null;
    else num = clean;
  } else num = clean;
  const value = Number(num);
  return isFinite(value) ? value : null;
}

function amountFromValue(v) {
  let a = parseAmount(v);
  if (a) return a;
  const str = String(v || '');
  const found = money.findMoney(str);
  if (found.length) {
    const r = parseAmount(found[0].raw);
    if (r) { r.cur = r.cur || found[0].cur; return r; }
  }
  const m = str.match(/[-+(]?\s*\d[\d,]*(?:[.,]\d{1,2})?\)?(?:\s*(?:DR|CR)\b)?/i);
  const r2 = m ? parseAmount(m[0]) : null;
  if (r2 && !r2.cur) r2.cur = money.firstCurrency(str);
  return r2;
}

function parseBalance(v) {
  const a = amountFromValue(v);
  if (!a) return null;
  const dr = /\bDR\b/i.test(String(v)) || a.neg;
  return dr ? -a.value : a.value;
}

/* ---------- dates and times ---------- */

const YEAR_TOKEN = "(\\d{4}(?!\\d)|(?<=[-/'A-Za-z])\\d{2}(?![\\d:]))";
const DATE_PATTERNS = [
  { kind: 'iso', re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g },
  { kind: 'num', re: /(?<![\d.])(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/g },
  { kind: 'dmony', re: new RegExp('(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.,]*' + MON + "(?![A-Za-z])\\.?[\\s\\-/.,']*" + YEAR_TOKEN, 'gi') },
  { kind: 'mondy', re: new RegExp(MON + '\\b\\.?[\\s\\-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s\\-]+(\\d{4})(?!\\d)', 'gi') }
];
const NOYEAR_PATTERNS = [
  { kind: 'dmon', re: new RegExp('(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]+' + MON + '\\b(?!\\s*\\d{4})', 'gi') },
  { kind: 'mond', re: new RegExp(MON + '\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?!\\s*,?\\s*\\d{4})', 'gi') }
];

function buildDate(kind, m, ctx) {
  let y, mo, d;
  if (kind === 'iso') { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (kind === 'num') {
    const a = +m[1], b = +m[2];
    y = fixYear(m[3]);
    let order = ctx.order;
    ctx.numUsed++;
    if (!order) {
      if (a > 12 && b <= 12) order = 'dmy';
      else if (b > 12 && a <= 12) { order = 'mdy'; ctx.swapped++; }
      else { order = ctx.defaultOrder || 'dmy'; if (a <= 12 && b <= 12 && a !== b) ctx.amb++; }
    }
    if (order === 'dmy') { d = a; mo = b; } else { d = b; mo = a; }
  } else if (kind === 'dmony') { d = +m[1]; mo = monthIndex(m[2]); y = fixYear(m[3]); }
  else if (kind === 'mondy') { mo = monthIndex(m[1]); d = +m[2]; y = +m[3]; }
  else {
    if (kind === 'dmon') { d = +m[1]; mo = monthIndex(m[2]); } else { mo = monthIndex(m[1]); d = +m[2]; }
    y = +ctx.today.slice(0, 4);
    if (validYMD(y, mo, d) && fmtDate(y, mo, d) > addDays(ctx.today, 7)) y -= 1;
    ctx.noYear++;
  }
  if (!validYMD(y, mo, d)) return null;
  return fmtDate(y, mo, d);
}

function addDays(iso, n) {
  const dt = new Date(iso + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/* Decides day-first or month-first for the whole input. Evidence wins (any day above 12 in the first or
 * second place); with no evidence the default depends on the main currency: USD reads month first. */
function decideOrder(text) {
  let sawDmy = false, sawMdy = false;
  const re = /(?<![\d.\/-])(\d{1,2})([\/.\-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])/g;
  for (const m of String(text).matchAll(re)) {
    const a = +m[1], b = +m[3];
    if (a > 12 && b <= 12) sawDmy = true;
    else if (b > 12 && a <= 12) sawMdy = true;
    else if (m[2] === '.' && a <= 12 && b <= 12) sawDmy = true;
  }
  if (sawDmy && !sawMdy) return 'dmy';
  if (sawMdy && !sawDmy) return 'mdy';
  return null;
}

function toHHMM(h, mi, ap) {
  h = +h; mi = +mi;
  if (ap) { ap = ap.toLowerCase(); if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'p' ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  return pad(h) + ':' + pad(mi);
}

function parseTimeStr(s) {
  s = String(s || '');
  let m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:([ap])\.?m\b\.?)?/i);
  if (m) return toHHMM(m[1], m[2], m[3]);
  m = s.match(/(?<!\d)(\d{2})(\d{2})\s*hrs?\b/i);
  if (m) return toHHMM(m[1], m[2]);
  return null;
}

/* finds the earliest valid date in text, plus a time next to it */
function extractDateTime(text, ctx, allowNoYear, anchored) {
  text = String(text || '');
  let best = null;
  const lists = [DATE_PATTERNS];
  if (allowNoYear) lists.push(NOYEAR_PATTERNS);
  for (const list of lists) {
    for (const p of list) {
      p.re.lastIndex = 0;
      for (const m of text.matchAll(p.re)) {
        if (anchored && m.index !== 0) break;
        if (best && m.index > best.index) break;
        const save = { amb: ctx.amb, swapped: ctx.swapped, noYear: ctx.noYear };
        const date = buildDate(p.kind, m, ctx);
        if (date) {
          if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.len)) {
            if (best) { /* keep counters of the winner only */ }
            best = { date: date, index: m.index, end: m.index + m[0].length, len: m[0].length };
          }
          break;
        }
        ctx.amb = save.amb; ctx.swapped = save.swapped; ctx.noYear = save.noYear;
      }
    }
    if (best) break;
  }
  if (!best) return null;
  let time = null, end = best.end;
  const after = text.slice(best.end).match(/^\s*(?:,|at|@|\||-|T)?\s*(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?m\b\.?)?/i);
  if (after) { time = toHHMM(after[1], after[2], after[3]); if (time) end = best.end + after[0].length; }
  if (!time) {
    const before = text.slice(0, best.index).match(/(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?m\b\.?)?[\s,|\-]*$/i);
    if (before) time = toHHMM(before[1], before[2], before[3]);
  }
  return { date: best.date, time: time, index: best.index, end: end };
}

/* ---------- text helpers ---------- */

function toText(x) {
  try {
    if (x === null || x === undefined) return '';
    if (typeof x === 'string') return x;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(x)) return x.toString('utf8');
    return String(x);
  } catch (e) { return ''; }
}

function normalizeText(s) {
  return s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/\u0000/g, '');
}

function decodeEntities(s) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", naira: '\u20a6' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, e) {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (err) { return ' '; }
    }
    const v = named[e.toLowerCase()];
    return v === undefined ? all : v;
  });
}

function stripHtml(s) {
  s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' : ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[\u00a0]/g, ' ');
  s = s.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').replace(/:\s*:\s*/g, ': ').trim(); }).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function decodeQP(s) {
  s = s.replace(/=\n/g, '');
  return s.replace(/(?:=[0-9A-Fa-f]{2})+/g, function (run) {
    try { return Buffer.from(run.replace(/=/g, ''), 'hex').toString('utf8'); } catch (e) { return run; }
  });
}

function decodeMimeWords(s) {
  return String(s || '').replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, function (all, cs, enc, data) {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      const bytes = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, function (a, h) { return '%' + h; });
      return decodeURIComponent(bytes);
    } catch (e) { return all; }
  });
}

/* ---------- email ---------- */

const HDR_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]?(.*)$/;
const HDR_NAMES = /^(from|to|cc|bcc|date|subject|reply-to|return-path|received|message-id|mime-version|content-[a-z-]+|x-[a-z-]+|delivered-to|sender|in-reply-to|references|list-[a-z-]+|authentication-results|dkim-signature|arc-[a-z-]+|received-spf|user-agent|importance|thread-[a-z]+)$/i;

function headerName(line) {
  const m = HDR_RE.exec(line);
  return m && HDR_NAMES.test(m[1]) ? m[1].toLowerCase() : null;
}

function findEmailStarts(lines) {
  const starts = [];
  let i = 0;
  while (i < lines.length) {
    const nm = headerName(lines[i]);
    const prevOk = i === 0 || !lines[i - 1].trim() || /^\W*(-{2,}|begin forwarded|forwarded message|original message)/i.test(lines[i - 1]);
    if (nm && prevOk) {
      const names = new Set();
      let j = i;
      while (j < lines.length && lines[j].trim()) {
        const n = headerName(lines[j]);
        if (n) names.add(n);
        else if (!/^\s+\S/.test(lines[j])) break;
        j++;
      }
      if (names.has('subject') || (names.has('from') && names.size >= 3)) { starts.push(i); i = j; continue; }
    }
    i++;
  }
  return starts;
}

function decodePart(hdr, body) {
  const ct = (hdr['content-type'] || '').toLowerCase();
  const cte = (hdr['content-transfer-encoding'] || '').toLowerCase();
  const bm = /boundary="?([^";\s]+)"?/i.exec(hdr['content-type'] || '');
  if (/multipart\//.test(ct) && bm) {
    const marker = '--' + bm[1];
    const parts = body.split('\n').reduce(function (acc, l) {
      if (l.indexOf(marker) === 0) acc.push([]); else if (acc.length) acc[acc.length - 1].push(l);
      return acc;
    }, []);
    let plain = '', html = '';
    for (const p of parts) {
      const sub = splitHeaders(p);
      const r = decodePart(sub.hdr, sub.body);
      if (r.isHtml) { if (!html) html = r.text; } else if (!plain && r.text.trim()) plain = r.text;
    }
    return plain ? { text: plain, isHtml: false } : { text: html, isHtml: true };
  }
  let text = body;
  if (cte === 'base64') {
    try { text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { text = body; }
  } else if (cte === 'quoted-printable' || (!cte && /=\n/.test(body) && /=[0-9A-F]{2}/.test(body))) {
    text = decodeQP(body);
  }
  const isHtml = /text\/html/.test(ct) || (/<\/?(html|body|div|p|br|table|td|tr|span)\b/i.test(text) && !/text\/plain/.test(ct));
  return { text: isHtml ? stripHtml(text) : text, isHtml: isHtml };
}

function splitHeaders(lines) {
  const hdr = {};
  let i = 0, last = null;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; break; }
    if (/^\s+\S/.test(l) && last) { hdr[last] += ' ' + l.trim(); i++; continue; }
    const nm = headerName(l);
    if (nm) {
      last = nm;
      const v = HDR_RE.exec(l)[2].trim();
      if (hdr[nm] === undefined) hdr[nm] = v;
      i++;
      continue;
    }
    break;
  }
  return { hdr: hdr, body: lines.slice(i).join('\n') };
}

/* ---------- alert parsing ---------- */

const LABEL_DEFS = {
  amount: ['transaction amount', 'txn amount', 'trans amount', 'amount', 'amt', 'amnt'],
  balance: ['available balance', 'avail balance', 'avail bal', 'avail. bal', 'avail. balance', 'available bal', 'ledger balance', 'ledger bal', 'current balance', 'balance', 'bal'],
  account: ['account number', 'account no', 'account', 'acct no', 'acct', 'acc', 'a/c no', 'a/c'],
  desc: ['transaction description', 'description', 'descr', 'desc', 'des', 'narration', 'narr', 'narrative', 'remarks', 'remark', 'details', 'particulars', 'purpose', 'spend'],
  party: ['beneficiary', 'recipient', 'sender', 'merchant', 'payee', 'to', 'from'],
  date: ['transaction date', 'txn date', 'trans date', 'value date', 'date'],
  time: ['time of transaction', 'time of txn', 'transaction time', 'txn time', 'trans time', 'time'],
  type: ['transaction type', 'txn type', 'trans type', 'type', 'txn', 'transaction'],
  debit: ['debit', 'dr'],
  credit: ['credit', 'cr'],
  ref: ['session id', 'reference', 'ref no', 'ref'],
  fee: ['transaction fee', 'service charge', 'stamp duty', 'charges', 'charge', 'fees', 'fee', 'vat']
};
const LABEL_KEY = {};
const LABEL_ALTS = [];
Object.keys(LABEL_DEFS).forEach(function (k) {
  LABEL_DEFS[k].forEach(function (l) { LABEL_KEY[l.replace(/\./g, '')] = k; LABEL_ALTS.push(l); });
});
LABEL_ALTS.sort(function (a, b) { return b.length - a.length; });
const LABEL_RE = new RegExp('(?:^|[\\s,;|(\\[])(' + LABEL_ALTS.map(function (l) {
  return l.replace(/[.\/]/g, '\\$&').replace(/ /g, '\\s+');
}).join('|') + ')\\s*[:=]\\s*', 'gim');

function extractFields(text) {
  const ms = [];
  LABEL_RE.lastIndex = 0;
  for (const m of text.matchAll(LABEL_RE)) ms.push(m);
  const fields = {};
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    const label = m[1].toLowerCase().replace(/\s+/g, ' ').replace(/\./g, '');
    const key = LABEL_KEY[label];
    if (!key) continue;
    const labelStart = m.index + m[0].toLowerCase().indexOf(m[1].toLowerCase());
    const valStart = m.index + m[0].length;
    let end = text.indexOf('\n', valStart);
    if (end < 0) end = text.length;
    if (i + 1 < ms.length && ms[i + 1].index < end) end = Math.max(valStart, ms[i + 1].index);
    let value = text.slice(valStart, end).replace(/[\s,;|]+$/, '').trim();
    if (key === 'account' || key === 'ref') { value = value.split(/\s+/)[0]; end = Math.min(end, valStart + value.length); }
    else if (key !== 'date' && key !== 'time') {
      // a date glued on the end of a value, as in "Bal NGN 100.00 29/10/2026" or "Narr: WEB/JUMIA Date 29/10/2026"
      const dd = extractDateTime(value, makeCtx({}), false);
      if (dd && dd.index > 0) {
        value = value.slice(0, dd.index).replace(/\s*(?:date|dated|on|at|time)\s*[:=]?\s*$/i, '').replace(/[\s,;|.]+$/, '');
        end = Math.min(end, valStart + value.length);
      }
    }
    if (key !== 'account' && key !== 'ref' && value.indexOf('|') > 0) {
      // fields separated by pipes, as in "Desc: POS BUKKA HUT | 29/10/2026 18:45 | Bal: ..."
      value = value.slice(0, value.indexOf('|')).trim();
      end = Math.min(end, valStart + value.length);
    }
    if (!fields[key]) fields[key] = { value: value, start: labelStart, end: end, label: label };
  }
  return fields;
}

function blank(text, spans) {
  const arr = text.split('');
  spans.forEach(function (sp) { for (let i = sp.start; i < sp.end && i < arr.length; i++) if (arr[i] !== '\n') arr[i] = ' '; });
  return arr.join('');
}

function dirWord(v) {
  v = String(v || '');
  const d = v.search(/\b(debit(?:ed)?|dr|withdrawal|outward|sent)\b/i);
  const c = v.search(/\b(credit(?:ed)?|cr|deposit(?:ed)?|inward|received)\b/i);
  if (d < 0 && c < 0) return null;
  if (c < 0) return 'debit';
  if (d < 0) return 'credit';
  return d < c ? 'debit' : 'credit';
}

function keywordDir(t, strong) {
  // "credit card" and "debit card" name the card, not the direction
  t = t.replace(/\b(?:credit|debit)\s+(?:card|cards|account|limit|line)\b/gi, ' card ');
  const re = strong
    ? { d: [/\bdebit(?:ed)?\b/i, /\bDR\b/, /\bwithdraw(?:al|n|ew)\b/i], c: [/\bcredit(?:ed)?\b/i, /\bCR\b/, /\bdeposit(?:ed)?\b/i] }
    : {
      d: [/\b(?:you\s+(?:sent|spent|paid|made|withdrew|bought|purchased)|spent|bought|purchased|payment|purchase|airtime|recharge|withdrew|deducted|levied|transfer(?:red)?\s+to|transfer\s+of\b[^\n]{0,40}?\bto|sent|charged|paid|was\s+used|used\s+at|bill\s*pay|fees?|charges?|autopay)\b/i],
      c: [/\b(?:received|refund(?:ed)?|salary|payroll|inflow|cashback|reversal|reimbursement|sent\s+you|paid\s+you|interest\s+(?:paid|earned)|money\s+in|added\s+to|top[- ]?up|returned\s+to|funded|topped\s+up)\b/i]
    };
  let d = -1, c = -1;
  re.d.forEach(function (r) { const i = t.search(r); if (i >= 0 && (d < 0 || i < d)) d = i; });
  re.c.forEach(function (r) { const i = t.search(r); if (i >= 0 && (c < 0 || i < c)) c = i; });
  if (d < 0 && c < 0) return null;
  if (c < 0) return 'debit';
  if (d < 0) return 'credit';
  return d < c ? 'debit' : 'credit';
}

const BAL_KEY = /\b(?:avail(?:able)?\.?\s*bal(?:ance)?|current\s+balance|ledger\s*bal(?:ance)?|running\s+bal(?:ance)?|new\s+balance|bal(?:ance)?)\b\s*(?:is\s+now|is|of|now)?\s*[:=]?\s*/gi;
const BARE_NUM = /^-?\(?\d[\d,]*(?:[.,]\d{1,2})?\)?(?:\s?(?:DR|CR)\b)?/i;

// Finds "Bal: NGN 5,000.00", "Your balance is $1,234.56." and the like. Returns { value, cur, start, end } or null.
function findBalance(text) {
  BAL_KEY.lastIndex = 0;
  for (const m of text.matchAll(BAL_KEY)) {
    const from = m.index + m[0].length;
    const after = text.slice(from, from + 40);
    let tok = null, cur = null;
    const mm = money.findMoney(after)[0];
    if (mm && mm.index <= 2) { tok = after.slice(0, mm.end); cur = mm.cur; }
    else {
      const bm = BARE_NUM.exec(after);
      if (bm) tok = bm[0];
    }
    if (tok === null) continue;
    const dr = /\bDR\b/i.test(after.slice(0, (mm && mm.index <= 2 ? mm.end : tok.length) + 4));
    const a = parseAmount(tok);
    if (!a) continue;
    return { value: (dr || a.neg) ? -a.value : a.value, cur: cur || a.cur, start: m.index, end: from + tok.length };
  }
  return null;
}

function cleanDesc(s) {
  s = String(s || '').replace(/\s+/g, ' ').replace(/^[\s:\-|,;]+|[\s:\-|,;.]+$/g, '').trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

const FEE_PHRASE = /\b((?:overdraft|monthly\s+(?:service|maintenance)|atm|foreign\s+transaction|wire|nsf|late|annual|service)\s+(?:fee|charge)s?|overdraft)\b/i;

function freeDescription(rest) {
  const bought = new RegExp('\\b(?:bought|purchased|paid\\s+for)\\s+(?:(?:' + money.PRE_SRC + ')\\s?[\\d,]+(?:\\.\\d+)?\\s+)?(?:of\\s+)?([A-Za-z][A-Za-z ]{2,28}?)(?=\\s+(?:for|on|at|to|from)\\b|[.;,|\\n]|$)', 'i').exec(rest);
  if (bought) {
    const c = cleanDesc(bought[1]);
    if (c && !/^(your|you|the|account|acct|a\/c)/i.test(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  }
  rest = rest.replace(/\b(?:from|to|in|on)\s+(?:your\s+)?(?:a\/c|acct|account)(?:\s+(?:no\.?|number))?\s*[*xX\d]\S*/gi, ' ');
  const re = /\b(?:for|towards|at|to|from)\s+([^\n]+?)(?=\s+(?:on|dated|with|via|using|avail|available|bal|balance|ref|date|time|acct|ending|successful(?:ly)?|completed|was|is|has|at|if|since|your)\b|\s+\d{1,2}[-/.]|\.(?=\s|$)|[;\n]|$)/gi;
  for (const m of rest.matchAll(re)) {
    const c = cleanDesc(m[1]);
    if (!c || /^(your|you|the|account|acct|a\/c|ngn|\u20a6|n\d|my)\b/i.test(c) || /^card\s+(?:ending|no\b|number)/i.test(c) || /^[\d\s*,.]+$/.test(c) || /alert/i.test(c)) continue;
    if (money.findMoney(c).length && money.findMoney(c)[0].index <= 1) continue;
    if (/^[$\u00a3\u20ac\u20b9\u00a5\u20a6\u20b5]/.test(c)) continue;
    if (/^\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?$/i.test(c) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(c)) continue;
    return c;
  }
  if (rest.indexOf('|') >= 0) {
    for (const seg of rest.split(/[|\n]/)) {
      const c = cleanDesc(seg);
      if (c.length >= 3 && /[a-z]{3}/i.test(c) && !/\d{1,2}[:\/]\d|\d{4}|\b(?:alert|debit|credit|bal|balance|ngn|acct|dr|cr)\b|\u20a6|^\d/i.test(c)) return c;
    }
  }
  return '';
}

// Last resort for text like "Debit N2,000.00 BETTING DEPOSIT - SPORTYBET 2026-10-29": use the words next to the amount.
function wordsAroundAmount(rest) {
  const letters = function (x) { return (x.match(/[A-Za-z]/g) || []).length; };
  const stripWords = function (x) {
    return x.replace(/\b(?:debit|credit|alert|notification|transaction|txn|dr|cr|debited|credited|successful|of|for|with|has|been|your|account|amount|amt)\b[:!]?/gi, ' ');
  };
  const noisy = /\d{3}|[\u20a6$\u00a3\u20ac]|\b(?:NGN|USD|GBP|EUR)\b|\*\*/i;
  // a title line such as "OPay Alert: POS Withdrawal"
  const titleLine = function () {
    const first = (rest.split('\n').filter(function (l) { return l.trim(); })[0] || '').replace(/^[^:]{0,20}:\s*/, '');
    const t = cleanDesc(stripWords(first));
    return letters(t) >= 3 && t.length <= 60 && !/[:=]/.test(t) && !noisy.test(t) ? t : '';
  };
  const m = money.findMoney(rest)[0];
  if (!m) return titleLine();
  let after = rest.slice(m.end).split(/\||\n|\.\s/)[0];
  const dt = extractDateTime(after, makeCtx({}), false);
  if (dt) after = after.slice(0, dt.index);
  after = cleanDesc(stripWords(after.replace(/\b(?:bal|balance|avail)\b.*$/i, '')));
  if (letters(after) >= 3) return after;
  let before = rest.slice(0, m.index).split('\n').pop().replace(/^[^:]{0,30}:\s*/, '');
  before = cleanDesc(stripWords(before));
  if (letters(before) >= 3 && !/[:=]/.test(before) && !noisy.test(before)) return before;
  return titleLine();
}

/* returns { item, extra } or { reason } */
function parseAlertText(text, ctx, env) {
  env = env || {};
  const fields = extractFields(text);
  // balance
  let balance = null;
  const spans = [];
  let balCur = null;
  if (fields.balance) {
    balance = parseBalance(fields.balance.value); spans.push(fields.balance);
    const ba = amountFromValue(fields.balance.value);
    if (ba) balCur = ba.cur;
  } else {
    const bm = findBalance(text);
    if (bm) { balance = bm.value; balCur = bm.cur; spans.push({ start: bm.start, end: bm.end }); }
  }
  ['account', 'desc', 'party', 'ref', 'date', 'fee'].forEach(function (k) { if (fields[k]) spans.push(fields[k]); });
  const rest = blank(text, spans);

  // amount
  let amt = null;
  if (fields.amount) amt = amountFromValue(fields.amount.value);
  if (!amt && fields.debit) { amt = amountFromValue(fields.debit.value); if (amt) amt.dir = 'debit'; }
  if (!amt && fields.credit) { amt = amountFromValue(fields.credit.value); if (amt) amt.dir = 'credit'; }
  if (!amt) {
    const cm = money.findMoney(rest)[0];
    if (cm) { amt = parseAmount(cm.raw); if (amt && !amt.cur) amt.cur = cm.cur; }
  }
  if (!amt || !(amt.value > 0)) return { reason: 'no_amount' };
  const cur = amt.cur || money.firstCurrency(rest) || balCur || money.firstCurrency(text) || (env && env.hint ? money.firstCurrency(env.hint) : null) || null;

  // direction
  let direction = null;
  if (fields.type) direction = dirWord(fields.type.value);
  if (!direction) direction = amt.dir;
  if (!direction && amt.plus) direction = 'credit';
  const cleaned = blank(rest, []);
  if (!direction) direction = keywordDir(cleaned, true);
  if (!direction && env.hint) direction = keywordDir(env.hint, true);
  if (!direction) direction = keywordDir(cleaned, false);
  if (!direction && fields.party) {
    direction = /^(to|beneficiary|recipient|payee|merchant)$/.test(fields.party.label) ? 'debit' : 'credit';
  }
  if (!direction) return { reason: 'no_direction' };

  // date and time
  let date = null, time = null;
  let dt = null;
  if (fields.date) dt = extractDateTime(fields.date.value, ctx, false);
  if (!dt) dt = extractDateTime(rest, ctx, false);
  if (dt) { date = dt.date; time = dt.time; }
  if (!time && fields.time) time = parseTimeStr(fields.time.value);
  if (!time && dt) {
    const tm = rest.match(/\bat\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\b)?)/i);
    if (tm) time = parseTimeStr(tm[1]);
  }
  if (!date && env.fallbackDate) { date = env.fallbackDate; if (!time) time = env.fallbackTime || null; }
  else if (date && !time && env.fallbackDate === date && env.fallbackTime) time = env.fallbackTime;

  // description
  let desc = fields.desc ? cleanDesc(fields.desc.value) : '';
  if (!desc && fields.party) {
    const p = cleanDesc(fields.party.value);
    if (p) desc = fields.party.label === 'merchant' ? p : (direction === 'debit' ? 'Transfer to ' : 'Transfer from ') + p;
  }
  if (!desc) desc = freeDescription(rest);
  if (!desc) {
    const who = /(?:^|[:.]\s*)([A-Z@][\w.'@-]*(?:\s[A-Z][\w.'-]*){0,2})\s+(?:sent|paid)\s+you\b/.exec(rest);
    if (who) desc = 'Transfer from ' + who[1];
    else {
      const fee = FEE_PHRASE.exec(rest);
      if (fee) desc = cleanDesc(fee[1]);
    }
  }
  if (!desc) desc = wordsAroundAmount(rest);
  if (!desc && env.subject) desc = cleanDesc(env.subject);
  if (!desc) desc = 'Unknown transaction';
  // "A fee of N10.75 was charged for NIP transfer": keep the word fee so the fee ghost can find it
  if (!/\b(sms|vat|stamp\s*duty|maintenance|commission|charges?|fees?|levy|cot)\b/i.test(desc)
    && new RegExp('\\b(?:fee|charge|levy|vat|stamp\\s*duty)\\b(?:\\s+of)?\\s+(?:' + money.PRE_SRC + ')\\s?\\d', 'i').test(rest)) desc = 'Bank charge: ' + desc;

  const item = {
    date: date, time: time, description: desc, amount: amt.value, direction: direction,
    currency: cur, balance: balance, source: 'email'
  };
  const extra = [];
  if (fields.fee) {
    const fee = amountFromValue(fields.fee.value);
    if (fee && fee.value > 0 && fee.value !== amt.value) {
      extra.push({
        date: date, time: time, description: 'Bank charge on ' + cleanDesc(desc).slice(0, 60), amount: fee.value, direction: 'debit',
        currency: fee.cur || cur, balance: null, source: 'email'
      });
    }
  }
  return { item: item, extra: extra };
}

const START_RE = /(?:debit|credit)\s*(?:alert|notification)|(?:transaction|txn)\s+alert/i;

// A line that is only a date and time, like "Oct 29, 2026 at 2:14 AM", is the stamp of the alert below it.
function isStampLine(line, ctx) {
  const t = line.trim();
  if (!t || t.length > 50 || /\d{3,}[,.]\d/.test(t) || money.findMoney(t).length) return false;
  const c = { today: ctx.today, order: ctx.order, defaultOrder: ctx.defaultOrder, numUsed: 0, amb: 0, swapped: 0, noYear: 0 };
  const dt = extractDateTime(t, c, false);
  if (!dt) return false;
  const left = (t.slice(0, dt.index) + ' ' + t.slice(dt.end)).replace(/\b(at|on|@|today|yesterday)\b/gi, ' ').replace(/[\s,|\-]+/g, '');
  return left === '';
}

const FIRST_LABEL_RE = new RegExp(LABEL_RE.source, 'im');

function firstLabelKey(line) {
  const m = FIRST_LABEL_RE.exec(line);
  return m ? LABEL_KEY[m[1].toLowerCase().replace(/\s+/g, ' ').replace(/\./g, '')] || null : null;
}

// Finds where each alert starts when alerts are pasted one after another with no blank line and no "Debit Alert" header.
function glueStarts(lines, ctx) {
  const stamps = [];
  lines.forEach(function (l, i) { if (isStampLine(l, ctx)) stamps.push(i); });
  if (stamps.length >= 2) return stamps;
  const amtLines = lines.filter(function (l) { return /\b(?:amt|amount)\s*[:=]/i.test(l); }).length;
  if (amtLines < 2) return [];
  let k0 = null;
  for (const l of lines) { k0 = firstLabelKey(l); if (k0) break; }
  if (!k0) return [];
  const starts = [];
  lines.forEach(function (l, i) { if (firstLabelKey(l) === k0) starts.push(i); });
  return starts.length >= 2 ? starts : [];
}

function parseBlock(text, ctx, env) {
  const lines = text.split('\n');
  let starts = [];
  lines.forEach(function (l, i) { if (START_RE.test(l)) starts.push(i); });
  if (starts.length < 2) { const g = glueStarts(lines, ctx); if (g.length >= 2) starts = g; }
  if (starts.length >= 2) {
    const items = [], failed = [];
    starts.forEach(function (s, k) {
      const from = k === 0 ? 0 : s;
      const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
      const seg = lines.slice(from, to).join('\n');
      const r = parseAlertText(seg, ctx, env);
      if (r.item) { items.push(r.item); (r.extra || []).forEach(function (x) { items.push(x); }); } else failed.push(seg);
    });
    return { items: items, failed: failed, reason: items.length ? null : 'no_amount' };
  }
  const r = parseAlertText(text, ctx, env);
  if (r.item) return { items: [r.item].concat(r.extra || []), failed: [], reason: null };
  return { items: [], failed: [], reason: r.reason };
}

const ALERTISH = /alert|debit|credit|\bamt\b|amount|\bDR\b|\bCR\b|txn|transaction|purchase|charged|payment|deposit|withdraw|NGN|USD|GBP|EUR|[\u20a6$\u00a3\u20ac\u20b9]/i;
const PLAIN_START = /^\s*(?:[*\u2022>]\s*|-\s+)?(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s\-]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b)/i;

function looksPlain(block) {
  const lines = block.split('\n').filter(function (l) { return l.trim(); });
  if (!lines.length) return false;
  if (/\b(amt|amount|acct|desc|narration|avail)\s*[:=]/i.test(block) || START_RE.test(block)) return false;
  const n = lines.filter(function (l) { return PLAIN_START.test(l); }).length;
  return n >= 1 && n * 2 >= lines.length;
}

const CREDITISH = /\b(salary|payroll|received|credit|deposit|direct\s+dep|refund|income|inflow|cashback|reversal|payment from|transfer from|interest paid|reimbursement|dividend)\b/i;

// Splits "NETFLIX.COM -$12.99", "Netflix 12,99 EUR", "Rent (1,200.00)" or "Pay +NGN 4,500 CR" into
// { desc, value, neg, plus, sfx, cur }. Returns null when the line does not end with an amount.
function splitTrailingAmount(rest) {
  let s = rest.replace(/[\s|,;:]+$/, '');
  let sfx = '', close = false, cur = null;
  let m = /\s*\b(DR|CR)\.?$/i.exec(s);
  if (m) { sfx = m[1].toUpperCase(); s = s.slice(0, m.index).replace(/\s+$/, ''); }
  if (s.endsWith(')')) { close = true; s = s.slice(0, -1).replace(/\s+$/, ''); }
  m = /(?<=\d)\s*([₦₹£€¥₵$]|[A-Za-z]{3})$/.exec(s);
  if (m) {
    const c = money.codeOf(m[1]);
    if (c) { cur = c; s = s.slice(0, m.index); }
  }
  const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+,\\d{1,2}|\\d+(?:[.,]\\d{1,2})?)';
  const re = new RegExp('(?:^|[\\s|,;:])(' + '[-+\\u2212\\u2013]?' + ')\\s*(\\(?)\\s*((?:' + money.PRE_SRC + ')?)\\s*([-+\\u2212\\u2013]?)\\s*(\\(?)\\s*' + NUM + '$');
  m = re.exec(s);
  if (!m) return null;
  let descEnd = m.index;
  let marker = m[3];
  if (marker) {
    const c = money.codeOf(marker);
    if (c) { if (!cur) cur = c; }
    else { descEnd = m.index + m[0].indexOf(marker) + marker.length; }
  }
  const signs = (m[1] || '') + (m[4] || '');
  const neg = /[-−–]/.test(signs) || ((m[2] === '(' || m[5] === '(') && close);
  const plus = /\+/.test(signs);
  return { desc: s.slice(0, descEnd), value: m[6], neg: neg, plus: plus, sfx: sfx, cur: cur };
}

// "... | -N3,200.00 | N12,000.00": the first marked money value is the amount, the second is the balance.
const TWO_AMT = new RegExp('[\\s|,;:]([+\\-\\u2212\\u2013]?)\\s*(' + money.PRE_SRC + ')\\s*([+\\-\\u2212\\u2013]?)(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*[|,;\\s]\\s*(' + money.PRE_SRC + ')\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*$');

function parsePlainLine(line, ctx) {
  let s = line.trim().replace(/^(?:[*•>]\s*|-\s+)/, '');
  const dt = extractDateTime(s, ctx, true, true);
  if (!dt || dt.index !== 0) return null;
  let rest = s.slice(dt.end).replace(/^[\s,|;:\-–]+/, '');
  const two = TWO_AMT.exec(rest);
  if (two && money.codeOf(two[2]) && money.codeOf(two[2]) === money.codeOf(two[5])) {
    const a = parseAmount(two[4]), b = parseAmount(two[6]);
    if (a && b && a.value > 0) {
      const signs = two[1] + two[3];
      const desc2 = cleanDesc(rest.slice(0, two.index));
      const dir = /[-\u2212\u2013]/.test(signs) ? 'debit' : /\+/.test(signs) ? 'credit' : (CREDITISH.test(desc2) ? 'credit' : 'debit');
      return { date: dt.date, time: dt.time, description: desc2 || 'Unknown', amount: a.value, direction: dir, currency: money.codeOf(two[2]), balance: b.value, source: 'text' };
    }
  }
  const t = splitTrailingAmount(rest);
  if (!t) return null;
  const parsed = parseAmount(t.value);
  if (!parsed || !(parsed.value > 0)) return null;
  const desc = cleanDesc(t.desc);
  let direction;
  if (t.neg || t.sfx === 'DR') direction = 'debit';
  else if (t.plus || t.sfx === 'CR') direction = 'credit';
  else direction = CREDITISH.test(desc) ? 'credit' : 'debit';
  return {
    date: dt.date, time: dt.time, description: desc || 'Unknown', amount: parsed.value,
    direction: direction, currency: t.cur || money.firstCurrency(t.desc) || null, balance: null, source: 'text'
  };
}

// A block of several one line alerts with no blank lines between them (typical when SMS texts are pasted).
// Only used when every line is a complete alert on its own, so multi line alerts are never cut apart.
function splitLineAlerts(block, ctx, env) {
  const lines = block.split('\n').filter(function (l) { return l.trim(); });
  if (lines.length < 2 || lines.length > 5000) return null;
  if (Object.keys(extractFields(block)).length) return null;
  const items = [];
  for (const l of lines) {
    if (!money.findMoney(l).length) return null;
    const r = parseAlertText(l, ctx, env);
    if (!r.item) return null;
    items.push(r.item);
    (r.extra || []).forEach(function (x) { items.push(x); });
  }
  return items;
}

function parseTextDoc(raw, ctx, out, env) {
  const blocks = raw.split(/\n[ \t]*\n+/).map(function (b) { return b.replace(/^\n+/, '').replace(/\s+$/, ''); }).filter(function (b) { return b.trim(); });
  let carry = '';
  for (const block of blocks) {
    if (looksPlain(block)) {
      carry = '';
      for (const line of block.split('\n')) {
        if (!line.trim()) continue;
        const it = parsePlainLine(line, ctx);
        if (it) out.items.push(it);
        else if (/\d/.test(line)) out.skipped.push(snippet(line));
      }
      continue;
    }
    const text = carry ? carry + '\n' + block : block;
    const lineAlerts = splitLineAlerts(block, ctx, env);
    if (lineAlerts) { out.items.push.apply(out.items, lineAlerts); carry = ''; continue; }
    const r = parseBlock(text, ctx, env);
    r.failed.forEach(function (f) { out.skipped.push(snippet(f)); });
    if (r.items.length) { out.items.push.apply(out.items, r.items); carry = ''; continue; }
    if (r.reason === 'no_amount' && block.length < 200) { carry = text.length < 400 ? text : block; continue; }
    carry = '';
    if (r.reason === 'no_direction') out.skipped.push(snippet(block) + ' (could not tell debit from credit)');
    else if (ALERTISH.test(block)) out.skipped.push(snippet(block));
  }
  if (carry && ALERTISH.test(carry) && /\d{3}/.test(carry)) out.skipped.push(snippet(carry));
}

function parseEmail(lines, ctx, out) {
  const sp = splitHeaders(lines);
  const hdr = sp.hdr;
  const subject = decodeMimeWords(hdr.subject || '').trim();
  let body = decodePart(hdr, sp.body).text;
  body = normalizeText(body);
  let bl = body.split('\n');
  const quoted = bl.filter(function (l) { return /^\s*>/.test(l); }).length;
  if (quoted && quoted * 2 >= bl.filter(function (l) { return l.trim(); }).length) bl = bl.map(function (l) { return l.replace(/^[>\s]+/, ''); });
  body = bl.join('\n').trim();
  const env = { subject: '', hint: subject, fallbackDate: null, fallbackTime: null };
  if (hdr.date) {
    const dt = extractDateTime(decodeMimeWords(hdr.date), ctx, false);
    if (dt) { env.fallbackDate = dt.date; env.fallbackTime = dt.time; }
  }
  const before = out.items.length;
  const r = parseBlock(body, ctx, env);
  r.failed.forEach(function (f) { out.skipped.push(snippet(f)); });
  if (r.items.length) { out.items.push.apply(out.items, r.items); }
  else parseTextDoc(body, ctx, out, env);
  if (out.items.length === before) out.skipped.push('Email "' + snippet(subject || '(no subject)', 50) + '" had no readable transaction');
}

/* ---------- CSV ---------- */

function parseCSV(text, delim) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { inQ = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// True when every comma in the line is a thousands separator, as in "Netflix 4,500.00".
function onlyThousandsCommas(line) {
  if (line.indexOf(',') < 0) return false;
  return line.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, '').indexOf(',') < 0;
}

// "4" and "500.00" that were split by an unquoted thousands comma are put back together as "4,500.00".
function repairRow(cells, expected) {
  const c = cells.slice();
  let i = 0;
  while (i < c.length - 1 && c.length > expected) {
    if (/^\s*[-+(\u2212\u2013]?\s*(?:[\u20a6\u20b9\u00a3\u20ac$]|[A-Za-z]{1,3})?\s*\d{1,3}\s*$/.test(c[i]) && /^\s*\d{3}(?:\.\d{1,2})?\)?\s*$/.test(c[i + 1])) {
      c[i] = c[i].replace(/\s+$/, '') + ',' + c[i + 1].replace(/^\s+/, '');
      c.splice(i + 1, 1);
    } else i++;
  }
  return c;
}

function detectDelim(lines) {
  const sample = lines.filter(function (l) { return l.trim(); }).slice(0, 30);
  let best = null;
  [',', ';', '\t', '|'].forEach(function (d) {
    const counts = sample.map(function (l) {
      if (d === ',' && onlyThousandsCommas(l)) return 0;
      let n = 0, q = false;
      for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
      return n;
    }).filter(function (n) { return n > 0; });
    if (!counts.length) return;
    const freq = {};
    counts.forEach(function (n) { freq[n] = (freq[n] || 0) + 1; });
    let mode = 0, modeN = 0;
    Object.keys(freq).forEach(function (k) { if (freq[k] > modeN || (freq[k] === modeN && +k > mode)) { mode = +k; modeN = freq[k]; } });
    const score = modeN * 1000 + mode;
    if (!best || score > best.score) best = { d: d, score: score, cols: mode + 1 };
  });
  return best && best.cols >= 2 ? best.d : null;
}

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[._]/g, ' ').replace(/[^a-z0-9\/ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const DESC_ORDER = ['narration', 'description', 'transaction description', 'transaction details', 'merchant', 'merchant name', 'narrative', 'particulars', 'details', 'remarks', 'remark', 'memo', 'payee', 'name', 'counterparty', 'beneficiary', 'desc', 'trans description', 'reference', 'payment reference', 'notes', 'name of sender/receiver'];

function mapColumns(cells) {
  const cols = { date: -1, time: -1, desc: -1, desc2: -1, debit: -1, credit: -1, amount: -1, balance: -1, type: -1, currency: -1, hdrCur: null };
  const sc = { date: 0, desc: 99, desc2: 99 };
  cells.forEach(function (c, i) {
    const h = normHeader(c);
    if (!h) return;
    if (!cols.hdrCur) { const sy = /[\u20a6\u20b9\u00a3\u20ac]/.exec(String(c)); if (sy) cols.hdrCur = money.codeOf(sy[0]); }
    if (!cols.hdrCur && !/local/.test(h)) {
      const hc = /\b([a-z]{3})$/.exec(h);
      if (hc && money.isCurrencyCode(hc[1].toUpperCase())) cols.hdrCur = hc[1].toUpperCase();
    }
    if (/^(txn |trans |transaction |tran )?time$/.test(h)) { if (cols.time < 0) cols.time = i; return; }
    if (/^(dr ?\/ ?cr|cr ?\/ ?dr|d ?\/ ?c|dr cr|debit credit|debit\/credit|indicator|direction|(txn |trans |transaction |tran )?type)$/.test(h)) { if (cols.type < 0) cols.type = i; return; }
    if (/^(currency|currency code|ccy|cur)$/.test(h)) { if (cols.currency < 0) cols.currency = i; return; }
    if (/balance|\bbal\b/.test(h) && !/opening|brought|impact/.test(h)) { if (cols.balance < 0) cols.balance = i; return; }
    if (/\bdate\b/.test(h)) {
      const s = /^(transaction |trans |txn |tran |posting |post |booking )?date( ?time)?$/.test(h) ? 3 : /value|due/.test(h) ? 1 : 2;
      if (s > sc.date) { sc.date = s; cols.date = i; }
      return;
    }
    if (/^(transaction |txn |trans |tran )?(amount|amt|gross)( [a-z]{3}| naira)?$/.test(h)) {
      if (cols.amount < 0) cols.amount = i;
      return;
    }
    if (/(^|\b)(debit|debits|dr|withdrawal|withdrawals|withdraw|money out|paid out|outflow)\b/.test(h) && !/credit|\/|type/.test(h)) { if (cols.debit < 0) cols.debit = i; return; }
    if (/(^|\b)(credit|credits|cr|deposit|deposits|money in|paid in|inflow|lodgement|lodgment|receipts?)\b/.test(h) && !/debit|\/|type/.test(h)) { if (cols.credit < 0) cols.credit = i; return; }
    const di = DESC_ORDER.indexOf(h);
    if (di >= 0 && di < sc.desc) { sc.desc2 = sc.desc; cols.desc2 = cols.desc; sc.desc = di; cols.desc = i; }
    else if (di >= 0 && di < sc.desc2) { sc.desc2 = di; cols.desc2 = i; }
  });
  return cols;
}

function csvDirWord(v) {
  v = String(v || '').trim().toLowerCase();
  if (/^(dr|d|db|debit|debits|withdrawal|out|dr\.)$/.test(v)) return 'debit';
  if (/^(cr|c|credit|credits|deposit|in|cr\.)$/.test(v)) return 'credit';
  return dirWord(v);
}

function detectCsv(raw) {
  const lines = raw.split('\n');
  const delim = detectDelim(lines);
  if (!delim) return null;
  const rows = parseCSV(raw, delim);
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if (rows[i].some(function (c) { return /\d{2,}/.test(c); })) continue;
    const cols = mapColumns(rows[i]);
    if (cols.date >= 0 && (cols.amount >= 0 || cols.debit >= 0 || cols.credit >= 0)) {
      const width = rows[i].length;
      const fixed = rows.map(function (r, k) { return k > i && delim === ',' ? repairRow(r, width) : r; });
      return { rows: fixed, header: i, cols: cols, delim: delim, headerless: false };
    }
  }
  // headerless: first cell of the first rows looks like a date
  if (delim === ',') rows.forEach(function (r, k) { rows[k] = repairRow(r, 3); });
  const probe = rows.filter(function (r) { return r.length >= 3 && r.some(function (c) { return c.trim(); }); }).slice(0, 5);
  if (probe.length && probe.every(function (r) { return PLAIN_START.test(r[0] + ' x') && extractDateTime(r[0], makeCtx(), false); })) {
    const last = probe[0].length - 1;
    const numericLast = probe.every(function (r) { return parseAmount(r[last]); });
    if (numericLast) {
      return { rows: rows, header: -1, cols: { date: 0, time: -1, desc: 1, debit: -1, credit: -1, amount: last, balance: -1, type: -1 }, delim: delim, headerless: true };
    }
  }
  return null;
}

const SKIP_ROW = /^(total|totals|opening|closing|balance (b\/f|c\/f|brought|carried)|brought forward|carried forward|summary|b\/f|c\/f)\b/i;

function parseCsvDoc(det, ctx, out) {
  const cols = det.cols;
  const rows = det.rows.slice(det.header + 1);
  // decide dd/mm vs mm/dd for the whole date column
  ctx.order = decideOrder(rows.map(function (r) { return String(r[cols.date] || '').trim(); }).join('\n')) || null;
  if (ctx.order) ctx.orderNote = ctx.order;
  const items = [];
  let unsigned = 0, signedNeg = 0, signedAny = 0, usedSingle = false;
  rows.forEach(function (r, ri) {
    if (!r.some(function (c) { return String(c).trim(); })) return;
    const cell = function (i) { return i >= 0 && i < r.length ? String(r[i]).trim() : ''; };
    let desc = cleanDesc(cell(cols.desc)) || cleanDesc(cell(cols.desc2));
    const dateCell = cell(cols.date);
    if (!dateCell) { return; }
    if (SKIP_ROW.test(desc) || SKIP_ROW.test(dateCell)) return;
    const dt = extractDateTime(dateCell, ctx, false);
    let amount = null, direction = null, rowCur = null;
    const dAmt = cols.debit >= 0 ? parseAmount(cell(cols.debit)) : null;
    const cAmt = cols.credit >= 0 ? parseAmount(cell(cols.credit)) : null;
    if (dAmt && dAmt.value > 0) { amount = dAmt.value; direction = 'debit'; rowCur = dAmt.cur; }
    else if (cAmt && cAmt.value > 0) { amount = cAmt.value; direction = 'credit'; rowCur = cAmt.cur; }
    else if (cols.amount >= 0) {
      const a = parseAmount(cell(cols.amount));
      if (a && a.value > 0) {
        amount = a.value;
        rowCur = a.cur;
        usedSingle = true;
        const td = cols.type >= 0 ? csvDirWord(cell(cols.type)) : null;
        signedAny++;
        if (a.neg) signedNeg++;
        if (td) direction = td; else if (a.dir) direction = a.dir; else { direction = 'credit'; unsigned++; }
      }
    }
    if (!amount) {
      const hasAny = [cols.debit, cols.credit, cols.amount].some(function (i) { return cell(i); });
      const zero = [cols.debit, cols.credit, cols.amount].some(function (i) { const a = parseAmount(cell(i)); return a && a.value === 0; });
      if (hasAny && !zero) out.skipped.push('Row ' + (det.header + 2 + ri) + ': ' + snippet(r.join(' '), 50));
      return;
    }
    if (!dt) { out.skipped.push('Row ' + (det.header + 2 + ri) + ' has an unreadable date: ' + snippet(dateCell, 30)); return; }
    let time = dt.time;
    if (!time && cols.time >= 0) time = parseTimeStr(cell(cols.time));
    if (!desc) desc = 'Transaction';
    if (!rowCur && cols.currency >= 0) { const cc = cell(cols.currency).toUpperCase(); if (money.isCurrencyCode(cc)) rowCur = cc; }
    if (!rowCur) rowCur = cols.hdrCur || null;
    items.push({
      date: dt.date, time: time, description: desc, amount: amount, direction: direction,
      currency: rowCur, balance: cols.balance >= 0 && cell(cols.balance) ? parseBalance(cell(cols.balance)) : null, source: 'csv'
    });
  });
  if (usedSingle && unsigned > 0 && signedNeg === 0 && cols.type < 0) {
    out.notes.push('The Amount column has no negative numbers and no Type column, so every row was read as a credit. Check that debits are marked with a minus sign.');
  }
  const ds = items.filter(function (i) { return i.date; });
  if (ds.length > 1 && ds[0].date > ds[ds.length - 1].date) items.reverse();
  out.items.push.apply(out.items, items);
  if (det.headerless) out.notes.push('No header row found. Assumed the columns are Date, Description, Amount.');
}

/* ---------- main ---------- */

/* Currency rule for amounts that carry no marker at all (see README, "Currencies"):
 *   1. the dominant currency of the markers found in the input (file level);
 *   2. opts.defaultCurrency, when the caller passes a valid ISO code;
 *   3. NGN when the text names a Nigerian bank or uses Nigerian alert phrasing (GTBank, Opay, NIP, USSD, "Debit Alert" ...);
 *   4. USD.
 * Explicit markers (N, NGN, the naira sign, $, GBP ...) on an amount always win over all of this. */
const NG_HINT = /\b(?:gtbank|gtco|guaranty\s+trust|access\s*bank|zenith|uba|united\s+bank\s+for\s+africa|opay|palmpay|kuda|moniepoint|sterling|alat|wema|first\s*bank|fcmb|fidelity\s+bank|union\s+bank|stanbic|polaris|keystone|ecobank|providus|nibss|nip|ussd|bvn|naira|bukka|web\s+pmt)\b|\*\d{3}#|\b(?:debit|credit|transaction|txn)\s+alert\b|\balert!/i;

function nigerianContext(raw) { return NG_HINT.test(String(raw).slice(0, 200000)); }

function sortItems(items) {
  return items.map(function (it, i) { return [it, i]; }).sort(function (a, b) {
    const da = a[0].date || '9999-99-99', db = b[0].date || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    const ta = a[0].time || '', tb = b[0].time || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a[1] - b[1];
  }).map(function (p) { return p[0]; });
}

function dedupe(items) {
  const seen = new Set();
  const kept = [];
  let removed = 0;
  items.forEach(function (it) {
    if (it.source === 'csv' || (!it.time && it.balance === null)) { kept.push(it); return; }
    const key = [it.date, it.time, it.amount, it.direction, it.description.toLowerCase()].join('|');
    if (seen.has(key)) { removed++; return; }
    seen.add(key);
    kept.push(it);
  });
  return { items: kept, removed: removed };
}

/* ---------- layout tables (text from "pdftotext -layout" bank statements) ----------
 * Fixed-width rows such as:
 *   02-Oct-2026  02-Oct-2026  NIP TRANSFER TO JOHN DOE/REF 12345   5,000.00      1,234,567.89
 * Debit or credit comes from the COLUMN the amount sits in; when that is unclear, from the balance moving
 * down (debit) or up (credit). Wrapped narration lines are joined; page headers, footers and totals are skipped. */

const LAY_AMOUNT = /(?<![\w\/.,-])\(?-?\d[\d,]*\.\d{2}\)?(?![\w\/])/g;
const LAY_FURNITURE = /^(?:page\s+\d|statement\b|account\s*(?:no|number|name|type|statement)|total|closing|opening|balance\b|brought|carried|printed|generated|customer|currency|branch|period|date\s+printed|this\s+is\s+a|please|disclaimer|end\s+of|\*+|-{3,}|={3,}|.*\bregulated\s+by\b|.*\ball\s+rights\b|.*\bnot\s+a\s+valid\b)/i;
const LAY_SKIP_NARR = /\b(?:opening\s+balance|closing\s+balance|balance\s+(?:b\/?f|c\/?f|brought|carried)|(?:brought|carried)\s+forward|b\/f|c\/f)\b|^total/i;
const LAY_CREDIT_HINT = /\b(?:salary|credit|deposit|inflow|reversal|refund|received|interest\s+earned|lodgement|from)\b/i;

function layoutHeader(line) {
  if (!/\bdate\b/i.test(line) || !/\bbalance\b/i.test(line)) return null;
  const find = function (re) { const m = re.exec(line); return m ? { start: m.index, end: m.index + m[0].length, mid: m.index + m[0].length / 2 } : null; };
  const debit = find(/\b(?:debits?|withdrawals?|money\s+out|paid\s+out|dr)\b/i);
  const credit = find(/\b(?:credits?|deposits?|lodgements?|money\s+in|paid\s+in|cr)\b/i);
  if (!debit || !credit) return null;
  const balance = find(/\bbalance\b/i);
  const narr = find(/\b(?:narration|description|details|particulars|remarks|transaction)\b/i);
  return { debit: debit, credit: credit, balance: balance, narr: narr };
}

function layDist(tok, col) {
  return Math.min(Math.abs(tok.start - col.start), Math.abs(tok.end - col.end), Math.abs(tok.mid - col.mid));
}

function layNum(s) {
  const v = parseFloat(String(s).replace(/[(),]/g, ''));
  return Number.isFinite(v) ? Math.abs(v) : null;
}

function parseLayoutDoc(raw, ctx) {
  if (!/\bdate\b[^\n]*\bbalance\b/i.test(raw) && !/\bbalance\b[^\n]*\bdate\b/i.test(raw)) return null;
  const lines = raw.split('\n');
  let hdr = null, cur = null, contLines = 0, prevBal = null;
  const items = [];
  let guessed = 0;
  const finish = function () { cur = null; contLines = 0; };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (line.indexOf('\f') >= 0) { line = line.replace(/\f/g, ''); finish(); }
    if (!line.trim()) { finish(); continue; }
    const h = layoutHeader(line);
    if (h) { hdr = h; finish(); continue; }
    if (!hdr) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();
    const dt = extractDateTime(body, ctx, false, true);
    if (dt) {
      // the optional value date right after the first date
      let rest = body.slice(dt.end);
      let restStart = dt.end;
      const lead = rest.length - rest.trimStart().length;
      const dt2 = extractDateTime(rest.trimStart(), ctx, false, true);
      if (dt2) { restStart += lead + dt2.end; rest = rest.slice(lead + dt2.end); }
      const toks = [];
      LAY_AMOUNT.lastIndex = 0;
      for (const m of rest.matchAll(LAY_AMOUNT)) {
        const start = indent + restStart + m.index;
        toks.push({ text: m[0], idx: m.index, start: start, end: start + m[0].length, mid: start + m[0].length / 2, val: layNum(m[0]) });
      }
      // the trailing run of amounts separated only by spaces
      let run = [];
      for (let k = toks.length - 1; k >= 0; k--) {
        const t = toks[k];
        const after = rest.slice(t.idx + t.text.length, run.length ? run[0].idx : rest.length);
        if (after.trim()) break;
        run.unshift(t);
        if (run.length === 3) break;
      }
      if (run.length) {
        const narrRaw = rest.slice(0, run[0].idx);
        const narration = cleanDesc(narrRaw);
        let amount = null, dir = null, balance = null;
        if (run.length === 3) {
          balance = run[2].val;
          if (run[0].val && !run[1].val) { amount = run[0].val; dir = 'debit'; }
          else if (run[1].val && !run[0].val) { amount = run[1].val; dir = 'credit'; }
          else { amount = run[0].val || run[1].val; }
        } else if (run.length === 2) { amount = run[0].val; balance = run[1].val; }
        else { amount = run[0].val; }
        if (LAY_SKIP_NARR.test(narration)) {
          // opening or brought forward rows only reset the running balance
          const b = balance !== null ? balance : run[run.length - 1].val;
          if (b !== null) prevBal = b;
          finish();
          continue;
        }
        if (amount === null || amount === 0) { finish(); continue; }
        // balance movement, exact to the cent, is the surest sign
        let byBal = null;
        if (balance !== null && prevBal !== null) {
          const diff = Math.round((balance - prevBal) * 100) / 100;
          if (Math.abs(Math.abs(diff) - amount) < 0.011) byBal = diff < 0 ? 'debit' : 'credit';
        }
        if (!dir) {
          const tok = run.length === 3 ? null : run[0];
          if (tok && hdr.debit && hdr.credit) {
            const dd = layDist(tok, hdr.debit), dc = layDist(tok, hdr.credit);
            if (Math.abs(dd - dc) >= 4) dir = dd < dc ? 'debit' : 'credit';
          }
          if (byBal) dir = byBal;
          if (!dir) { dir = LAY_CREDIT_HINT.test(narration) ? 'credit' : 'debit'; guessed++; }
        } else if (byBal && byBal !== dir) dir = byBal;
        if (balance !== null) prevBal = balance;
        cur = {
          date: dt.date, time: dt.time || null, description: narration, amount: amount, direction: dir,
          currency: null, balance: balance, source: 'text',
        };
        items.push(cur);
        contLines = 0;
        cur._narrCol = hdr.narr ? hdr.narr.start : null;
        continue;
      }
      // a dated line with no amounts is not a row
      finish();
      continue;
    }
    // an undated opening or brought forward line still tells us the running balance
    if (LAY_SKIP_NARR.test(body)) {
      LAY_AMOUNT.lastIndex = 0;
      const nums = body.match(LAY_AMOUNT);
      if (nums && nums.length) prevBal = layNum(nums[nums.length - 1]);
      finish();
      continue;
    }
    // continuation of a wrapped narration
    if (cur && contLines < 4 && !LAY_FURNITURE.test(body)) {
      LAY_AMOUNT.lastIndex = 0;
      const onlyAmounts = body.replace(LAY_AMOUNT, '').trim() === '';
      const minIndent = cur._narrCol !== null ? cur._narrCol - 3 : 2;
      if (!onlyAmounts && indent >= minIndent) {
        cur.description = cleanDesc(cur.description + ' ' + body);
        contLines++;
        continue;
      }
    }
    finish();
  }
  items.forEach(function (it) { delete it._narrCol; });
  const rows = items.filter(function (it) { return it.description || it.amount; });
  if (rows.length < 3) return null;
  return { items: rows, guessed: guessed };
}

function parseInput(text, opts) {
  try {
    opts = opts || {};
    let raw = normalizeText(toText(text));
    // HTML remnants in pasted text (for example "&nbsp;" and "<br>") would hide labels from the parser.
    if (/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[0-9a-f]+);|<br\s*\/?>/i.test(raw) && !/^(?:content-type|mime-version)\s*:/im.test(raw)) {
      raw = decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:p|div|span|b|strong|i|em|td|tr|table|font)\b[^>]*>/gi, ' ')).replace(/\u00a0/g, ' ');
    }
    const warnings = [];
    if (!raw.trim()) return { items: [], warnings: ['The input is empty.'] };
    if (raw.length > MAX_CHARS) { raw = raw.slice(0, MAX_CHARS); warnings.push('The input was very large, so only the first part was read.'); }
    const ctx = makeCtx(opts);
    const curCounts = money.countCurrencies(raw);
    const mainCur = money.dominantOfCounts(curCounts);
    const optCur = typeof opts.defaultCurrency === 'string' && money.isCurrencyCode(opts.defaultCurrency.toUpperCase()) ? opts.defaultCurrency.toUpperCase() : null;
    const ngCtx = !mainCur && !optCur && nigerianContext(raw);
    ctx.defaultOrder = (mainCur || optCur) === 'USD' ? 'mdy' : 'dmy';
    ctx.mainCur = mainCur;
    ctx.order = decideOrder(raw);
    ctx.orderNote = ctx.order;
    const out = { items: [], skipped: [], notes: [] };
    const lines = raw.split('\n');
    const starts = findEmailStarts(lines);
    const lay = parseLayoutDoc(raw, ctx);
    if (lay) {
      lay.items.forEach(function (it) { out.items.push(it); });
      if (lay.guessed) out.notes.push(lay.guessed + ' row' + (lay.guessed === 1 ? '' : 's') + ' in the statement table could not be told apart as money in or out, so ' + (lay.guessed === 1 ? 'it was' : 'they were') + ' guessed from the wording.');
    } else if (starts.length) {
      const lead = lines.slice(0, starts[0]).join('\n');
      if (lead.trim()) parseTextDoc(lead, ctx, out, {});
      starts.forEach(function (s, k) {
        parseEmail(lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length), ctx, out);
      });
    } else {
      const det = detectCsv(raw);
      if (det) parseCsvDoc(det, ctx, out);
      else {
        if (opts.filename && /\.csv$/i.test(String(opts.filename))) out.notes.push('The file is named .csv but no header row with a date and amount column was found. Read it as plain text.');
        parseTextDoc(raw, ctx, out, {});
      }
    }
    out.notes.forEach(function (n) { warnings.push(n); });
    out.skipped.slice(0, 5).forEach(function (s) { warnings.push('Could not read: ' + s); });
    if (out.skipped.length) warnings.push('Skipped ' + out.skipped.length + ' line' + (out.skipped.length === 1 ? '' : 's') + ' or block' + (out.skipped.length === 1 ? '' : 's') + ' that could not be read.');
    if (ctx.amb > 0) {
      const us = ctx.defaultOrder === 'mdy';
      warnings.push(ctx.amb + ' date' + (ctx.amb === 1 ? '' : 's') + ' could be read as dd/mm or mm/dd (both numbers are 12 or less). Assumed '
        + (us ? 'mm/dd, the US style, because the amounts are in USD.' : 'dd/mm, the most common style outside the US.'));
    }
    if (ctx.swapped > 0) warnings.push(ctx.swapped + ' date' + (ctx.swapped === 1 ? '' : 's') + ' had a second number above 12, so they were read as mm/dd.');
    if (ctx.orderNote === 'mdy' && ctx.defaultOrder !== 'mdy' && ctx.numUsed > 0) warnings.push('Dates like 03/05/2026 were read as month/day/year because some dates in this input have a day above 12 in the second place.');
    if (ctx.orderNote === 'dmy' && ctx.defaultOrder === 'mdy' && ctx.numUsed > 0) warnings.push('Dates like 03/05/2026 were read as day/month/year because some dates in this input have a day above 12 in the first place.');
    if (ctx.noYear > 0) warnings.push('Some dates had no year, so ' + ctx.today.slice(0, 4) + ' was assumed.');
    // settle currencies: items without a marker take the main currency of the input
    const known = money.dominantCurrency(out.items, null);
    let unmarked = 0;
    const fallback = known || mainCur || optCur || (ngCtx ? 'NGN' : null) || 'USD';
    out.items.forEach(function (it) { if (!it.currency) { unmarked++; it.currency = fallback; } });
    if (unmarked && !known && !mainCur) {
      warnings.push(optCur ? 'No currency symbol or code was found, so ' + optCur + ' was assumed.'
        : ngCtx ? 'No currency symbol or code was found, but the text looks like a Nigerian bank message, so NGN was assumed.'
          : 'No currency symbol or code was found, so USD was assumed.');
    }
    const mixed = money.mixedWarning(out.items);
    if (mixed) warnings.push(mixed);
    const dd = dedupe(out.items);
    if (dd.removed) warnings.push('Removed ' + dd.removed + ' duplicate alert' + (dd.removed === 1 ? '' : 's') + ' (same date, time, amount and description).');
    const items = sortItems(dd.items);
    const undated = items.filter(function (i) { return !i.date; }).length;
    if (undated) warnings.push(undated + ' item' + (undated === 1 ? ' has' : 's have') + ' no readable date.');
    if (!items.length) warnings.push('No transactions were found in the input.');
    return { items: items, warnings: warnings };
  } catch (e) {
    return { items: [], warnings: ['Could not read the input: ' + (e && e.message ? e.message : 'unknown error')] };
  }
}

module.exports = { parseInput, parseAmount };
