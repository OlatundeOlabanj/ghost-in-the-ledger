'use strict';
// PDF text extraction. Zero dependencies.
// 1) pdftotext (poppler) with -layout, fed through stdin, so the PDF never touches the disk.
// 2) A small best-effort pure-Node fallback ("basic") for simple text PDFs when pdftotext is not installed.
// The PDF bytes and the extracted text are never logged.

const { spawn } = require('node:child_process');
const zlib = require('node:zlib');

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const PDFTOTEXT_TIMEOUT_MS = 20000;

const INSTALL_HELP = 'Install poppler to read PDF statements. Fedora: sudo dnf install poppler-utils. Ubuntu or Debian: sudo apt install poppler-utils. macOS: brew install poppler.';
const PASSWORD_ERROR = 'This PDF is password protected. Open it, remove the password (or print it to a new PDF), and try again.';

function isPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  return buf.subarray(0, 1024).includes('%PDF');
}

let cachedAvailable = null;
function pdftotextAvailable(force) {
  if (cachedAvailable !== null && !force) return Promise.resolve(cachedAvailable);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; cachedAvailable = v; resolve(v); } };
    try {
      const p = spawn('pdftotext', ['-v'], { stdio: ['ignore', 'ignore', 'ignore'] });
      p.on('error', () => finish(false));
      p.on('exit', () => finish(true));
      setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } finish(false); }, 3000).unref();
    } catch (_) { finish(false); }
  });
}

function runPdftotext(buf, timeoutMs) {
  return new Promise((resolve) => {
    let out = [];
    let err = '';
    let done = false;
    let child;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    try {
      child = spawn('pdftotext', ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_) { resolve({ missing: true }); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } finish({ timeout: true }); }, timeoutMs);
    child.on('error', (e) => finish(e && e.code === 'ENOENT' ? { missing: true } : { failed: true }));
    child.stdout.on('data', (c) => { out.push(c); });
    child.stderr.on('data', (c) => { if (err.length < 2000) err += c.toString('utf8'); });
    child.stdin.on('error', () => { /* pdftotext may exit early */ });
    child.on('close', (code) => {
      if (code === 0) finish({ text: Buffer.concat(out).toString('utf8') });
      else finish({ failed: true, code, stderr: err });
    });
    child.stdin.end(buf);
  });
}

function countPages(text) {
  const pages = text.split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return Math.max(1, pages.length);
}

// ---------- basic fallback ----------

function inflateSafe(data) {
  try { return zlib.inflateSync(data); } catch (_) { /* try lenient */ }
  try { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (_) { return null; }
}

function getStreams(buf) {
  const latin = buf.toString('latin1');
  const streams = [];
  const re = /(<<(?:[^]*?)>>)\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    let data = buf.subarray(start, end);
    const dict = m[1];
    if (/\/FlateDecode|\/Fl\b/.test(dict)) {
      const inf = inflateSafe(data);
      if (!inf) { re.lastIndex = end; continue; }
      data = inf;
    } else if (/\/Filter/.test(dict)) { re.lastIndex = end; continue; }
    streams.push({ dict, data });
    re.lastIndex = end;
  }
  return streams;
}

function parseCMap(text) {
  const map = new Map();
  for (const blk of text.matchAll(/beginbfchar([^]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hexToStr(m[2]));
  }
  for (const blk of text.matchAll(/beginbfrange([^]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else {
        const list = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      }
    }
  }
  return map;
}

function hexToStr(h) {
  let s = '';
  for (let i = 0; i + 3 < h.length + 1; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return s;
}

function unescapeLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (all, c) => {
    if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t';
    if (c === 'b' || c === 'f') return '';
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8));
    if (/^\r?\n$/.test(c)) return '';
    return c;
  });
}

function decodeHexString(h, cmap) {
  h = h.replace(/\s+/g, '');
  if (cmap && cmap.size) {
    // two byte codes when the map has any code above 255, else single bytes
    let wide = false;
    for (const k of cmap.keys()) if (k > 255) { wide = true; break; }
    const step = wide ? 4 : 2;
    let out = '';
    for (let i = 0; i < h.length; i += step) {
      const code = parseInt(h.slice(i, i + step).padEnd(step, '0'), 16);
      out += cmap.has(code) ? cmap.get(code) : String.fromCharCode(code);
    }
    return out;
  }
  let out = '';
  for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2).padEnd(2, '0'), 16));
  return out;
}

function contentToText(content, cmap) {
  const lines = [];
  let cur = '';
  let lastY = null;
  const flush = () => { if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); cur = ''; };
  const tokRe = /\((?:\\[^]|[^\\()])*(?:\((?:\\[^]|[^\\()])*\)(?:\\[^]|[^\\()])*)*\)|<([0-9a-fA-F\s]*)>|\[|\]|-?\d*\.?\d+|[A-Za-z'"*]+/g;
  {
    let stack = [];
    let m;
    tokRe.lastIndex = 0;
    const body = content;
    while ((m = tokRe.exec(body))) {
      const t = m[0];
      if (t[0] === '(') { stack.push({ s: unescapeLiteral(t.slice(1, -1)) }); continue; }
      if (t[0] === '<') { stack.push({ s: decodeHexString(m[1] || '', cmap) }); continue; }
      if (t === '[' || t === ']') { stack.push({ b: t }); continue; }
      if (/^-?\d*\.?\d+$/.test(t)) { stack.push({ n: parseFloat(t) }); continue; }
      if (t === 'Tj' || t === "'" || t === '"') {
        if (t !== 'Tj') flush();
        const last = stack[stack.length - 1];
        if (last && last.s !== undefined) cur += last.s;
      } else if (t === 'TJ') {
        for (const e of stack) {
          if (e.s !== undefined) cur += e.s;
          else if (e.n !== undefined && e.n < -250) cur += ' ';
        }
      } else if (t === 'Td' || t === 'TD') {
        const ns = stack.filter((e) => e.n !== undefined);
        const ty = ns.length >= 2 ? ns[ns.length - 1].n : 0;
        const tx = ns.length >= 2 ? ns[ns.length - 2].n : 0;
        if (ty !== 0) flush(); else if (tx > 0) cur += ' ';
      } else if (t === 'Tm') {
        const ns = stack.filter((e) => e.n !== undefined);
        const y = ns.length >= 6 ? ns[ns.length - 1].n : null;
        if (y !== null && lastY !== null && Math.abs(y - lastY) > 1) flush(); else if (cur) cur += ' ';
        if (y !== null) lastY = y;
      } else if (t === 'T*') flush();
      else if (t === 'ET') flush();
      stack = [];
    }
    flush();
  }
  return lines.join('\n');
}

// Best effort text from simple PDFs. Throws an Error with .code 'ENCRYPTED' for protected files.
function basicExtract(buf) {
  const latin = buf.toString('latin1');
  if (/\/Encrypt\s/.test(latin)) { const e = new Error('encrypted'); e.code = 'ENCRYPTED'; throw e; }
  const streams = getStreams(buf);
  const cmap = new Map();
  for (const s of streams) {
    if (/beginbfchar|beginbfrange/.test(s.data.toString('latin1', 0, Math.min(s.data.length, 200000)))) {
      for (const [k, v] of parseCMap(s.data.toString('latin1'))) cmap.set(k, v);
    }
  }
  const pages = [];
  for (const s of streams) {
    const txt = s.data.toString('latin1');
    if (!/\bBT\b/.test(txt)) continue;
    const out = contentToText(txt, cmap);
    if (out.trim()) pages.push(out);
  }
  const count = (latin.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  return { text: pages.join('\n\f'), pages: Math.max(count, pages.length, 1) };
}

// extractPdf(buf, opts?) -> { ok:true, text, pages, method } | { ok:false, error }
async function extractPdf(buf, opts) {
  const o = opts || {};
  if (!isPdf(buf)) return { ok: false, error: 'That does not look like a PDF file.' };
  if (buf.length > MAX_PDF_BYTES) return { ok: false, error: 'That PDF is too large (the limit is 15MB).' };
  const have = o.forceBasic ? false : await pdftotextAvailable();
  if (have) {
    const r = await runPdftotext(buf, o.timeoutMs || PDFTOTEXT_TIMEOUT_MS);
    if (r.text !== undefined) {
      if (r.text.trim()) return { ok: true, text: r.text, pages: countPages(r.text), method: 'pdftotext' };
    }
    if (r.timeout) return { ok: false, error: 'Reading the PDF took too long (over 20 seconds). Try a smaller file or paste the text.' };
    if (r.failed && /password/i.test(r.stderr || '')) return { ok: false, error: PASSWORD_ERROR };
    // any other failure (damaged file, odd structure): try the built-in reader before giving up
  }
  try {
    const b = basicExtract(buf);
    if (!b.text.trim()) {
      return { ok: false, error: have ? 'No text was found in that PDF. It may be a scanned image. Export the statement as CSV, or paste the text instead.' : 'No text could be read with the built-in reader. ' + INSTALL_HELP };
    }
    return { ok: true, text: b.text, pages: b.pages, method: 'basic' };
  } catch (e) {
    if (e && e.code === 'ENCRYPTED') return { ok: false, error: PASSWORD_ERROR };
    return { ok: false, error: 'That PDF could not be read. ' + (have ? '' : INSTALL_HELP) };
  }
}

module.exports = { extractPdf, basicExtract, pdftotextAvailable, isPdf, MAX_PDF_BYTES, INSTALL_HELP };
