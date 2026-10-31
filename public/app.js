(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_TEXT = 2 * 1024 * 1024, MAX_PDF = 15 * 1024 * 1024;
  var G = window.GHOSTS || { for: function () { return ''; } };
  var last = null, ctrl = null, filename = '', busy = false;

  var el = {
    text: $('text'), file: $('file'), drop: $('drop'), chosen: $('file-chosen'), go: $('go'), clear: $('clear'),
    error: $('error'), found: $('found'), foundMeta: $('found-meta'),
    results: $('results'), loading: $('loading'), loadTitle: $('loading-title'), loadSub: $('loading-sub'), stop: $('stop'),
    out: $('out'), sum: $('sum'), stats: $('stats'), warn: $('warn'), warnSum: $('warn-sum'), warnList: $('warn-list'),
    ledger: $('ledger'), empty: $('empty'), who: $('who'), copy: $('copy'), print: $('print'), again: $('again'), copied: $('copied'),
    cloudList: $('cloud-list'), cloudEnd: $('cloud-end'), badge: $('badge'), badgeText: $('badge-text'), badgeDot: $('badge-dot'), privacy: $('privacy')
  };
  var demos = document.querySelectorAll('[data-demo]');

  /* art */
  $('hero-art').innerHTML = G.hero || '';
  $('brand-mark').innerHTML = G.mark || '';
  $('loading-art').innerHTML = G.hero || '';

  /* helpers */
  var LOCALES = { NGN: 'en-NG', GBP: 'en-GB', EUR: 'en-IE', KES: 'en-KE', GHS: 'en-GH', CAD: 'en-CA', AUD: 'en-AU', ZAR: 'en-ZA', INR: 'en-IN' };
  function money(n, cur) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    var code = /^[A-Z]{3}$/.test(cur || '') ? cur : 'USD';
    var whole = Math.abs(v) % 1 === 0;
    try { return new Intl.NumberFormat(LOCALES[code] || 'en-US', { style: 'currency', currency: code, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(v); }
    catch (e) { return code + ' ' + v.toFixed(2); }
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] : (d || '');
  }
  function range(s) {
    if (s.from && s.to) return s.from === s.to ? fmtDate(s.from) : fmtDate(s.from) + ' to ' + fmtDate(s.to);
    return s.from || s.to ? fmtDate(s.from || s.to) : 'no dates found';
  }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function reduced() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  var KINDS = { subscription: 'Subscription', fees: 'Bank fees', night: 'After midnight', payday: 'Payday', leak: 'Small leaks', round: 'Round numbers', biggest: 'Largest spend' };

  function showMsg(msg, hint, info) {
    el.error.textContent = '';
    el.error.appendChild(document.createTextNode(msg));
    if (hint) el.error.appendChild(h('span', 'hint', hint));
    el.error.className = 'message' + (info ? ' info' : '');
    el.error.hidden = false;
    try { el.error.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {}
  }
  function clearMsg() { el.error.hidden = true; el.error.textContent = ''; }

  function setBusy(on, title, sub) {
    busy = on;
    el.go.disabled = on;
    Array.prototype.forEach.call(demos, function (b) { b.disabled = on; });
    el.results.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) {
      el.results.hidden = false; el.out.hidden = true; el.loading.hidden = false;
      el.loadTitle.textContent = title || 'Looking through your ledger';
      el.loadSub.textContent = sub || 'Writing the stories can take a minute on a laptop. You can wait here.';
      try { el.results.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); } catch (e) {}
    } else el.loading.hidden = true;
  }

  /* api */
  function getJson(r) { return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'The server sent a reply we could not read.' }; } }); }

  /* render */
  function renderResult(res) {
    last = res;
    var s = res.summary || {}, cur = s.currency || 'USD', gs = res.ghosts || [];
    el.sum.textContent = (s.count || 0) + ' transactions read, ' + range(s) + '. ' + (gs.length ? 'We found ' + gs.length + (gs.length === 1 ? ' ghost.' : ' ghosts.') : 'No ghosts turned up.');
    el.stats.textContent = '';
    [['Money out', money(s.totalDebit, cur)], ['Money in', money(s.totalCredit, cur)], ['Transactions', String(s.count || 0)]].forEach(function (r) {
      var d = h('div'); d.appendChild(h('dt', null, r[0])); d.appendChild(h('dd', null, r[1])); el.stats.appendChild(d);
    });
    var w = res.warnings || [];
    el.warnList.textContent = '';
    if (w.length) {
      w.forEach(function (x) { el.warnList.appendChild(h('li', null, x)); });
      el.warnSum.textContent = w.length + (w.length === 1 ? ' note about your data' : ' notes about your data');
      el.warn.hidden = false; el.warn.open = false;
    } else el.warn.hidden = true;

    el.ledger.textContent = '';
    el.empty.hidden = gs.length > 0;
    gs.forEach(function (g, i) {
      var li = h('li', 'row'); li.style.setProperty('--i', i);
      var art = h('div', 'row-art'); art.innerHTML = G.for(g.kind); li.appendChild(art);
      var tx = h('div', 'row-text');
      tx.appendChild(h('p', 'kind', KINDS[g.kind] || 'Ghost'));
      tx.appendChild(h('h3', null, g.title));
      tx.appendChild(h('p', 'story', g.story));
      li.appendChild(tx);
      var am = h('div', 'amt'); am.appendChild(h('b', null, money(g.amount, cur))); li.appendChild(am);
      var ev = g.evidence || [];
      if (ev.length) {
        var d = h('details', 'ev');
        d.appendChild(h('summary', 'ev-toggle', 'Evidence, ' + ev.length + (ev.length === 1 ? ' line' : ' lines')));
        var t = h('table'), cap = h('caption', 'sr-only', 'Evidence for ' + g.title); t.appendChild(cap);
        var thd = h('thead'), tr = h('tr');
        ['Date', 'Description', 'Amount'].forEach(function (x) { var th = h('th', null, x); th.scope = 'col'; tr.appendChild(th); });
        thd.appendChild(tr); t.appendChild(thd);
        var tb = h('tbody');
        ev.forEach(function (it) {
          var r = h('tr');
          r.appendChild(h('td', null, it.date ? fmtDate(it.date) + (it.time ? ' ' + it.time : '') : 'No date'));
          r.appendChild(h('td', null, it.description));
          r.appendChild(h('td', it.direction === 'credit' ? 'cr' : '', (it.direction === 'credit' ? '+' : '') + money(it.amount, it.currency || cur)));
          tb.appendChild(r);
        });
        t.appendChild(tb); d.appendChild(t); li.appendChild(d);
      }
      el.ledger.appendChild(li);
    });
    el.who.textContent = who(res);
    if (res.backend === 'groq') groqOn = true;
    if (res.meter) setMeter(res.meter);
    renderCloud(res);
    el.copied.textContent = '';
    el.out.hidden = false;
  }

  function family(m) { var f = /[A-Za-z]+/.exec(m || ''); return f ? f[0].charAt(0).toUpperCase() + f[0].slice(1) : 'A model'; }
  function who(r) {
    if (r.backend === 'ollama') return family(r.model) + ' wrote these stories on this computer.';
    if (r.backend === 'groq') return family(r.model) + ' wrote these stories online. Only short facts, never your statement, were sent.';
    return 'Offline mode: these stories use simple templates.';
  }
  function plainText(r) {
    var s = r.summary || {}, cur = s.currency || 'USD', L = [];
    L.push('Ghost in the Ledger');
    L.push(s.count + ' transactions, ' + range(s) + '. Out ' + money(s.totalDebit, cur) + ', in ' + money(s.totalCredit, cur) + '.', '');
    (r.ghosts || []).forEach(function (g, i) {
      L.push((i + 1) + '. ' + g.title + ' - ' + money(g.amount, cur), '   ' + g.story);
      (g.evidence || []).forEach(function (it) { L.push('   ' + (it.date || 'no date') + '  ' + it.description + '  ' + (it.direction === 'credit' ? '+' : '') + money(it.amount, it.currency || cur)); });
      L.push('');
    });
    L.push(who(r));
    return L.join('\n');
  }

  /* ghost meter: numbers come from the server's own count of its outbound requests */
  var meterNow = null, groqOn = false;
  function nf(n) { return Number(n || 0).toLocaleString('en-US'); }
  function setMeter(m) {
    if (!m) return;
    meterNow = m;
    $('m-calls').textContent = nf(m.outsideCalls);
    $('m-bytes').textContent = nf(m.bytesSentOut);
    $('m-docs').textContent = nf(m.documentsProcessed);
    $('m-local').textContent = nf(m.localCalls);
    $('m-local-wrap').hidden = !m.localCalls;
    var live = m.outsideCalls > 0;
    $('meter').classList.toggle('live', live);
    var note = $('meter-note');
    note.hidden = !live;
    if (live) note.textContent = groqOn ? 'Groq is on, so only short facts about each pattern were sent. Your statement stayed here.' : 'This app made calls to a server outside this computer. The numbers above are the true totals.';
  }

  /* what a cloud app would have uploaded, built from the real run */
  function renderCloud(res) {
    var s = res.summary || {}, r = res.run || {}, cur = s.currency || 'USD', m = res.meter || meterNow || {};
    var kb = (r.inputBytes || 0) / 1024;
    var kbText = (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
    var n = s.count || 0, merchants = r.distinctMerchants || 0;
    var rows = [
      'Your full statement (' + n + (n === 1 ? ' transaction, ' : ' transactions, ') + kbText + ')',
      'Every merchant name (' + merchants + ' distinct ' + (merchants === 1 ? 'merchant' : 'merchants') + ')',
      'Every amount (' + money(s.totalDebit, cur) + ' out and ' + money(s.totalCredit, cur) + ' in)',
      'Dates and times of each transaction (' + (r.datedTransactions || 0) + ' dated)',
      'Your device and IP address'
    ];
    el.cloudList.textContent = '';
    rows.forEach(function (t) { el.cloudList.appendChild(h('li', null, t)); });
    var out = r.outsideCalls || 0;
    if (out > 0) {
      var to = res.backend === 'groq' ? 'Groq' : 'a server outside this computer';
      el.cloudEnd.textContent = 'Sent from here: ' + out + ' short fact ' + (out === 1 ? 'summary' : 'summaries') + ' to ' + to + ', never the statement (' + nf(r.bytesSentOut) + ' bytes).';
      el.cloudEnd.className = 'cloud-end live';
    } else if ((m.outsideCalls || 0) > 0) {
      el.cloudEnd.textContent = 'Sent from here during this run: nothing. (Earlier in this session the app made ' + nf(m.outsideCalls) + ' outside ' + (m.outsideCalls === 1 ? 'call' : 'calls') + ', see the meter.)';
      el.cloudEnd.className = 'cloud-end live';
    } else {
      el.cloudEnd.textContent = 'Sent from here instead: nothing.';
      el.cloudEnd.className = 'cloud-end';
    }
  }

  /* privacy scan: runs in this page with the same lib/redact.js the tests cover */
  var R = window.GhostRedact;
  var scanTimer = null;
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function runScan(keepDone) {
    if (!R) return;
    var c = R.scan(el.text.value);
    var parts = [];
    if (c.cards + c.accounts) parts.push(plural(c.cards + c.accounts, 'account number', 'account numbers'));
    if (c.phones) parts.push(plural(c.phones, 'phone number', 'phone numbers'));
    if (c.emails) parts.push(plural(c.emails, 'email', 'emails'));
    if (c.ids) parts.push(plural(c.ids, 'long ID', 'long IDs'));
    if (!parts.length) { if (!(keepDone && $('scan').classList.contains('done'))) $('scan').hidden = true; return; }
    $('scan-text').textContent = 'We noticed ' + parts.join(', ') + '.';
    $('scan').className = 'scan'; $('redact').hidden = false; $('scan-sub').hidden = false;
    $('scan').hidden = false;
  }
  function scanSoon() { clearTimeout(scanTimer); scanTimer = setTimeout(runScan, 250); }
  $('redact').addEventListener('click', function () {
    if (!R) return;
    var r = R.redact(el.text.value);
    el.text.value = r.text;
    $('scan-text').textContent = 'Done. We masked ' + plural(r.counts.total, 'identifier', 'identifiers') + ' in your text, keeping the last 4 digits.';
    $('scan').className = 'scan done'; $('redact').hidden = true;
    $('scan-sub').textContent = 'Amounts, dates and balances were not touched, so your totals stay exactly the same.';
    $('scan-sub').hidden = false;
    if (last && !busy) haunt();
  });

  /* save report: built in the browser and downloaded as a Blob. No network request is made. */
  function mdCell(x) { return String(x == null ? '' : x).replace(/\|/g, '/').replace(/\s+/g, ' ').trim(); }
  function reportMd(r) {
    var s = r.summary || {}, cur = s.currency || 'USD', m = r.meter || meterNow || {}, run = r.run || {}, L = [];
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    var be = r.backend === 'ollama' ? 'Ollama (on this computer)' : r.backend === 'groq' ? 'Groq (hosted)' : 'Offline templates (no model)';
    L.push('# Ghost in the Ledger report', '');
    L.push('## Provenance', '');
    L.push('- Date: ' + day);
    L.push('- Backend and model: ' + be + (r.backend === 'offline' || !r.model ? '' : ', ' + r.model));
    if ((m.outsideCalls || 0) === 0) L.push('- Processed locally: yes. This app made 0 outside network calls and sent 0 bytes out. Documents read on this computer: ' + nf(m.documentsProcessed) + '.');
    else L.push('- Processed locally: not entirely. This server session made ' + nf(m.outsideCalls) + ' outside ' + (m.outsideCalls === 1 ? 'call' : 'calls') + ' (' + nf(m.bytesSentOut) + ' bytes), during this run ' + nf(run.outsideCalls || 0) + '. Only short facts about each pattern were sent, never the statement.');
    L.push('- Meter counts the requests this server made. It does not watch other programs.', '');
    L.push('## Summary', '');
    L.push(nf(s.count) + ' transactions, ' + range(s) + '. Money out ' + money(s.totalDebit, cur) + ', money in ' + money(s.totalCredit, cur) + '. ' + ((r.ghosts || []).length ? plural((r.ghosts || []).length, 'ghost', 'ghosts') + ' found.' : 'No ghosts found.'), '');
    (r.ghosts || []).forEach(function (g, i) {
      L.push('## ' + (i + 1) + '. ' + g.title + ' (' + money(g.amount, cur) + ')', '', g.story, '');
      var ev = g.evidence || [];
      if (ev.length) {
        L.push('| Date | Description | Amount |', '| --- | --- | ---: |');
        ev.forEach(function (it) { L.push('| ' + mdCell(it.date ? it.date + (it.time ? ' ' + it.time : '') : 'No date') + ' | ' + mdCell(it.description) + ' | ' + (it.direction === 'credit' ? '+' : '') + mdCell(money(it.amount, it.currency || cur)) + ' |'); });
        L.push('');
      }
    });
    return L.join('\n');
  }
  function saveReport() {
    if (!last) return;
    var blob = new Blob([reportMd(last)], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a'), u = URL.createObjectURL(blob);
    var d = new Date();
    a.href = u; a.download = 'ghost-ledger-report-' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + '.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
    el.copied.textContent = 'Report saved to your downloads. It was made in this page, with no network request.';
  }
  $('save').addEventListener('click', saveReport);

  /* run */
  function haunt() {
    clearMsg(); runScan(true);
    var text = el.text.value.trim();
    if (!text) { showMsg('Add a statement first.', 'Drop a file into the box, paste some text, or try one of the demos below.'); return; }
    ctrl = new AbortController();
    setBusy(true);
    var body = { text: text }; if (filename) body.filename = filename;
    return fetch('/api/haunt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      .then(getJson).then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || 'Something went wrong while reading your text.');
        setBusy(false); renderResult(res);
        el.results.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
      }).catch(function (e) {
        setBusy(false); el.results.hidden = true;
        if (e && e.name === 'AbortError') { showMsg('Stopped. Nothing was lost, your text is still here.', '', true); return; }
        var m = (e && e.message) || '';
        showMsg(/Failed to fetch|NetworkError|Load failed/i.test(m) || !m ? 'Could not reach the server.' : m,
          /Failed to fetch|NetworkError|Load failed/i.test(m) || !m ? 'Check that it is still running, then try again.' : 'Check that the text has dates, descriptions and amounts, or try a different file.');
      });
  }

  function extractPdf(f) {
    clearMsg();
    ctrl = new AbortController();
    setBusy(true, 'Reading your PDF', 'This happens on your computer. Long statements can take a little while.');
    var pdfHint = 'Open the PDF in your browser, press Ctrl+A, Ctrl+C and paste it here instead';
    return f.arrayBuffer().then(function (buf) {
      return fetch('/api/extract-pdf', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: buf, signal: ctrl.signal });
    }).then(getJson).then(function (r) {
      if (!r || r.ok !== true || !r.text) throw Object.assign(new Error((r && r.error) || 'Could not read text from that PDF.'), { pdf: true });
      el.text.value = r.text; filename = f.name;
      var bits = []; if (r.pages) bits.push(r.pages + (r.pages === 1 ? ' page' : ' pages')); if (r.method) bits.push('read by ' + r.method);
      el.foundMeta.textContent = bits.join(', ');
      el.found.hidden = false; el.found.open = false;
      $('found-body').appendChild($('paste'));
      setBusy(false);
      return haunt();
    }).catch(function (e) {
      setBusy(false); el.results.hidden = true;
      if (e && e.name === 'AbortError') { showMsg('Stopped. You can add the file again whenever you like.', '', true); return; }
      showMsg((e && e.pdf ? e.message : 'Could not read that PDF.'), pdfHint);
    });
  }

  function readFile(f) {
    clearMsg();
    if (!f) return;
    if (!/\.(pdf|csv|txt|eml)$/i.test(f.name)) { showMsg('That file type is not supported.', 'Use a PDF, CSV, TXT or EML file, or paste the text instead.'); return; }
    el.chosen.textContent = 'Added: ' + f.name; el.chosen.hidden = false;
    if (/\.pdf$/i.test(f.name)) {
      if (f.size > MAX_PDF) { showMsg('That PDF is larger than 15 MB.', 'Open it in your browser, press Ctrl+A, Ctrl+C and paste it here instead'); return; }
      return extractPdf(f);
    }
    if (f.size > MAX_TEXT) { showMsg('That file is larger than 2 MB.', 'Try one statement month at a time.'); return; }
    var fr = new FileReader();
    fr.onload = function () { el.text.value = String(fr.result || ''); filename = f.name; unfound(); haunt(); };
    fr.onerror = function () { showMsg('Could not read that file.', 'Try pasting its text instead.'); };
    fr.readAsText(f);
  }

  function runDemo(set) {
    clearMsg();
    return fetch('/api/demo?set=' + encodeURIComponent(set)).then(getJson).then(function (r) {
      if (!r || typeof r.text !== 'string' || !r.text) throw new Error('empty');
      el.text.value = r.text; filename = ''; el.chosen.hidden = true; unfound();
      return haunt();
    }).catch(function (e) { if (e && e.message === 'empty' || /fetch/i.test(String(e && e.message))) showMsg('Could not load the demo.', 'Check that the server is running, or paste your own text.'); });
  }

  /* events */
  el.go.addEventListener('click', haunt);
  el.stop.addEventListener('click', function () { if (ctrl) ctrl.abort(); });
  el.clear.addEventListener('click', reset);
  el.again.addEventListener('click', function () { reset(); $('add').focus(); $('add').scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth' }); });
  function unfound() { $('paste-slot').appendChild($('paste')); el.found.hidden = true; el.found.open = false; }
  function reset() { unfound(); $('scan').hidden = true; el.text.value = ''; filename = ''; el.file.value = ''; el.chosen.hidden = true; clearMsg(); last = null; el.results.hidden = true; }
  Array.prototype.forEach.call(demos, function (b) { b.addEventListener('click', function () { runDemo(b.getAttribute('data-demo')); }); });
  el.file.addEventListener('change', function () { var f = el.file.files[0]; el.file.value = ''; readFile(f); });
  ['dragenter', 'dragover'].forEach(function (t) { el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.remove('over'); }); });
  el.drop.addEventListener('drop', function (e) { readFile(e.dataTransfer && e.dataTransfer.files[0]); });
  el.text.addEventListener('input', function () { filename = ''; scanSoon(); });

  el.copy.addEventListener('click', function () {
    if (!last) return;
    var t = plainText(last);
    var done = function (ok) { el.copied.textContent = ok ? 'Copied to your clipboard.' : 'Could not copy. Select the text and copy it by hand.'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { done(true); }, function () { fb(t, done); }); else fb(t, done);
  });
  function fb(t, done) {
    var ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); done(ok);
  }
  var wasOpen = [];
  window.addEventListener('beforeprint', function () { wasOpen = []; Array.prototype.forEach.call(document.querySelectorAll('.ev'), function (d) { wasOpen.push(d.open); d.open = true; }); });
  window.addEventListener('afterprint', function () { Array.prototype.forEach.call(document.querySelectorAll('.ev'), function (d, i) { d.open = !!wasOpen[i]; }); });
  el.print.addEventListener('click', function () { window.print(); });

  /* model badge */
  function badge(text, dot, priv) { el.badgeText.textContent = text; el.badgeDot.className = 'dot ' + dot; if (priv) el.privacy.textContent = priv; }
  fetch('/api/status').then(getJson).then(function (s) {
    groqOn = !!(s && s.active === 'groq'); if (s && s.meter) setMeter(s.meter);
    var models = s && s.backends && s.backends.ollama && s.backends.ollama.models || [];
    var m = (s && s.model) || models[0] || '';
    if (s && s.active === 'ollama') badge(family(m || 'Gemma') + ' is writing your stories on this computer', 'on', 'Everything stays on this computer. Your statement is never uploaded anywhere.');
    else if (s && s.active === 'groq') badge(family(m) + ' is writing your stories online. Only short facts are sent', 'mid', 'Your full statement stays here. Only short facts about each pattern are sent to the hosted model.');
    else if (s && s.active === 'offline') badge('Offline mode: stories use simple templates', 'on', 'Everything stays on this computer. No model and no internet are used.');
    else throw new Error('x');
  }).catch(function () { badge('Server not reachable. Start it and reload the page', '', ''); });
})();
