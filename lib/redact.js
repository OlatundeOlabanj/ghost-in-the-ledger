'use strict';
// Privacy scan and redaction. Runs in Node (tests) and in the browser (served as /redact.js).
// It only touches identifiers: card-like numbers, account numbers, phone numbers, emails and long
// IDs. Amounts, dates, times and balances are never matched: digit runs next to a decimal point or
// a thousands comma are skipped, and 10 digit runs that follow a currency sign or code are skipped.
(function (root) {
  var NB = '(?<![\\w.,*])';           // not glued to another word, decimal, comma or mask
  var NA = '(?![\\w*]|[.,]\\d)';      // not followed by more digits, decimals or commas with digits

  var RX = {
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    card: new RegExp(NB + '(?:\\d{4}(?:[ -]\\d{4}){2,3}(?:[ -]\\d{1,3})?|\\d{13,19})' + NA, 'g'),
    phone: new RegExp('(?<![\\w.,*])(?:\\+\\d{1,3}[ -]?\\(?\\d{1,4}\\)?(?:[ -]?\\d{2,4}){2,4}|\\(\\d{3}\\)[ -]?\\d{3}[ -]\\d{4}|\\d{3}[ -]\\d{3}[ -]\\d{4}|0[789]\\d[ -]?\\d{4}[ -]?\\d{4}|0\\d{2,4}[ -]\\d{3}[ -]?\\d{3,4})' + NA, 'g'),
    account: new RegExp(NB + '\\d{10}' + NA, 'g'),
    longId: new RegExp(NB + '(?:(?=(?:[A-Za-z]*\\d){6})(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}|\\d{11,12}|\\d{20,})' + NA, 'g')
  };
  var CURRENCY_BEFORE = /(?:[$£€₦¥₹]|\b(?:[A-Z]{3}|N|Rs|KSh|GH₵)\s?)\s*$/;

  function mask(m) {
    var seen = 0, out = '';
    for (var i = m.length - 1; i >= 0; i--) {
      var c = m.charAt(i);
      if (/[A-Za-z0-9]/.test(c)) { out = (seen < 4 ? c : '*') + out; seen++; } else out = c + out;
    }
    return out;
  }
  function maskEmail(m) {
    var at = m.indexOf('@');
    return m.charAt(0) + '***' + m.slice(at);
  }

  var ORDER = [['emails', 'email'], ['cards', 'card'], ['phones', 'phone'], ['accounts', 'account'], ['ids', 'longId']];

  // Walk the text once per kind, in priority order, so one number is counted once.
  function run(text, doReplace) {
    var counts = { cards: 0, accounts: 0, phones: 0, emails: 0, ids: 0 };
    var cur = String(text == null ? '' : text);
    ORDER.forEach(function (k) {
      var key = k[0], rx = RX[k[1]];
      cur = cur.replace(rx, function (m, offset, whole) {
        if (key === 'accounts' && CURRENCY_BEFORE.test(whole.slice(Math.max(0, offset - 4), offset))) return m;
        counts[key]++;
        return key === 'emails' ? maskEmail(m) : mask(m);
      });
    });
    counts.total = counts.cards + counts.accounts + counts.phones + counts.emails + counts.ids;
    return { counts: counts, text: doReplace ? cur : String(text == null ? '' : text) };
  }

  function scan(text) { return run(text, false).counts; }
  function redact(text) { var r = run(text, true); return { text: r.text, counts: r.counts }; }

  var api = { scan: scan, redact: redact, mask: mask };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GhostRedact = api;
})(typeof window !== 'undefined' ? window : this);
