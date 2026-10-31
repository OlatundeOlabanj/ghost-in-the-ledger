'use strict';
// Model backends for Ghost in the Ledger.
// Every backend has the same shape: { name, model, complete({system, user, signal}) -> Promise<string|null> }
// Everything accepts an injected fetch so tests never touch the network.

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OLLAMA_DETECT_TIMEOUT_MS = 800;
const TEMPERATURE = 0.7;
const MAX_TOKENS = 220;
const OLLAMA_NUM_PREDICT = Number(process.env.GHOST_NUM_PREDICT) > 0 ? Number(process.env.GHOST_NUM_PREDICT) : 120;
const OLLAMA_KEEP_ALIVE = '10m';

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

// Remove anything secret from a message before it can reach logs, warnings or the browser.
function redact(message, secrets) {
  let out = String(message == null ? '' : message);
  for (const s of secrets || []) {
    if (s && typeof s === 'string' && s.length >= 4) out = out.split(s).join('[hidden]');
  }
  return out;
}

function ollamaBackend({ url, model, fetch: fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const base = trimSlash(url || DEFAULT_OLLAMA_URL);
  const m = model || DEFAULT_OLLAMA_MODEL;
  return {
    name: 'ollama',
    model: m,
    // Tiny request that loads the model into memory and keeps it there for 10 minutes.
    async warm({ signal } = {}) {
      const res = await f(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: m,
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          messages: [{ role: 'user', content: 'Say hi.' }],
          options: { num_predict: 1, temperature: 0 },
        }),
      });
      if (!res.ok) throw new Error('ollama answered with HTTP ' + res.status);
      return true;
    },
    async complete({ system, user, signal }) {
      const res = await f(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: m,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: { temperature: TEMPERATURE, num_predict: OLLAMA_NUM_PREDICT },
        }),
      });
      if (!res.ok) throw new Error('ollama answered with HTTP ' + res.status);
      const data = await res.json();
      const text = data && data.message && data.message.content;
      if (typeof text !== 'string') throw new Error('ollama sent an unexpected reply');
      return text;
    },
  };
}

function groqBackend({ apiKey, model, fetch: fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const m = model || DEFAULT_GROQ_MODEL;
  return {
    name: 'groq',
    model: m,
    async complete({ system, user, signal }) {
      let res;
      try {
        res = await f(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          signal,
          body: JSON.stringify(Object.assign({
            model: m,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }, /gpt-oss/i.test(m) ? { reasoning_effort: 'low', max_tokens: 800 } : {})),
        });
      } catch (err) {
        const e = new Error(redact(err && err.message, [apiKey]));
        e.name = (err && err.name) || 'Error';
        throw e;
      }
      // The response body is never copied into errors, so nothing secret can leak from it.
      if (!res.ok) {
        const hint = res.status === 404 ? ' (the model "' + m + '" was not found. Set GHOST_MODEL to a model your Groq account lists)'
          : res.status === 401 ? ' (the key was refused)' : res.status === 429 ? ' (rate limit reached, try again in a minute)' : '';
        throw new Error('groq answered with HTTP ' + res.status + hint);
      }
      const data = await res.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof text !== 'string') throw new Error('groq sent an unexpected reply');
      return text;
    },
  };
}

function offlineBackend() {
  return { name: 'offline', model: 'template', async complete() { return null; } };
}

// Is Ollama running? GET /api/tags with a short timeout.
async function detectOllama(env, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const base = trimSlash((env && env.OLLAMA_URL) || DEFAULT_OLLAMA_URL);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_DETECT_TIMEOUT_MS);
  try {
    const res = await f(base + '/api/tags', { signal: ctrl.signal });
    if (!res.ok) return { up: false, models: [] };
    const data = await res.json();
    const models = Array.isArray(data && data.models)
      ? data.models.map((x) => x && (x.name || x.model)).filter((x) => typeof x === 'string')
      : [];
    return { up: true, models };
  } catch (_) {
    return { up: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

// detect() -> { ollama: { up, models }, groq: { configured } }. Never includes the key itself.
async function detect(env, opts) {
  const e = env || process.env;
  const o = opts || {};
  return {
    ollama: await detectOllama(e, o.fetch),
    groq: { configured: Boolean(e.GROQ_API_KEY && String(e.GROQ_API_KEY).trim()) },
  };
}

// Pure rule: which backend name wins, given GHOST_BACKEND and what was detected.
function choose(env, detection) {
  const e = env || {};
  const want = String(e.GHOST_BACKEND || 'auto').toLowerCase();
  if (want === 'offline') return { name: 'offline' };
  if (want === 'ollama') return { name: 'ollama' };
  if (want === 'groq') {
    return detection.groq.configured
      ? { name: 'groq' }
      : { name: 'offline', warning: 'GHOST_BACKEND=groq but GROQ_API_KEY is not set, so offline mode is used.' };
  }
  if (want !== 'auto') {
    // Unknown value: behave like auto but say so.
    const c = choose({ ...e, GHOST_BACKEND: 'auto' }, detection);
    return { ...c, warning: 'Unknown GHOST_BACKEND "' + want + '", using auto.' };
  }
  if (detection.ollama.up) return { name: 'ollama' };
  if (detection.groq.configured) return { name: 'groq' };
  return { name: 'offline' };
}

function ollamaModelFor(env, models) {
  if (env.GHOST_MODEL) return env.GHOST_MODEL;
  const list = (models || []).filter((n) => !/embed/i.test(n));
  if (!list.length || list.includes(DEFAULT_OLLAMA_MODEL)) return DEFAULT_OLLAMA_MODEL;
  const llama = list.find((n) => n.startsWith('llama3.2'));
  return llama || list[0];
}

// Which model name will be used for a choice ('template' when offline).
function modelFor(env, detection, choice) {
  const e = env || {};
  if (choice.name === 'ollama') return ollamaModelFor(e, detection.ollama.models);
  if (choice.name === 'groq') return e.GHOST_MODEL || DEFAULT_GROQ_MODEL;
  return 'template';
}

// pick(env, {fetch, detection}) -> backend object (with optional .warning)
async function pick(env, opts) {
  const e = env || process.env;
  const o = opts || {};
  const detection = o.detection || (await detect(e, { fetch: o.fetch }));
  const choice = choose(e, detection);
  let backend;
  if (choice.name === 'ollama') {
    backend = ollamaBackend({ url: e.OLLAMA_URL, model: ollamaModelFor(e, detection.ollama.models), fetch: o.fetch });
  } else if (choice.name === 'groq') {
    backend = groqBackend({ apiKey: e.GROQ_API_KEY, model: e.GHOST_MODEL || DEFAULT_GROQ_MODEL, fetch: o.fetch });
  } else {
    backend = offlineBackend();
  }
  if (choice.warning) backend.warning = choice.warning;
  return backend;
}

module.exports = {
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_GROQ_MODEL,
  OLLAMA_DETECT_TIMEOUT_MS,
  ollamaBackend,
  groqBackend,
  offlineBackend,
  detect,
  choose,
  pick,
  modelFor,
  redact,
};
