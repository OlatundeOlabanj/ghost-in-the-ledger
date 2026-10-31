'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ghosts = require('../lib/ghosts');
const backends = require('../lib/backends');

function it(date, description, amount, extra) {
  return Object.assign({ date, time: null, description, amount, direction: 'debit', currency: 'USD', balance: null, source: 'csv' }, extra || {});
}
const data = [
  it('2026-01-05', 'Netflix', 15.5), it('2026-02-05', 'Netflix', 15.5), it('2026-03-05', 'Netflix', 15.5),
  it('2026-01-09', 'SMS alert charge', 0.5, {}), it('2026-02-09', 'SMS alert charge', 0.5), it('2026-03-09', 'SMS alert charge', 0.5),
];

function ollamaFetch(delayMs, text) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, status: 200, json: async () => ({ message: { content: text(body) } }) };
  };
  f.calls = calls;
  return f;
}

test('a slow local model within the timeout still tells its stories', async () => {
  const f = ollamaFetch(150, () => 'Netflix keeps haunting you for 15.5 each month.');
  const backend = backends.ollamaBackend({ model: 'gemma3:1b', fetch: f });
  const r = await ghosts.haunt(data, { backend, timeoutMs: 2000, budgetMs: 20000 });
  assert.equal(r.backend, 'ollama');
  assert.equal(r.model, 'gemma3:1b');
  assert.ok(r.ghosts.some((g) => /haunting you/.test(g.story)));
  assert.equal(r.warnings.filter((w) => /did not answer|time budget/.test(w)).length, 0);
});

test('ollama is warmed first with keep_alive and small options', async () => {
  const f = ollamaFetch(1, () => 'Netflix keeps haunting you for 15.5 each month.');
  const backend = backends.ollamaBackend({ model: 'gemma3:1b', fetch: f });
  await ghosts.haunt(data, { backend, timeoutMs: 2000 });
  assert.equal(f.calls[0].body.keep_alive, '10m');
  assert.equal(f.calls[0].body.options.num_predict, 1);
  const story = f.calls[1].body;
  assert.equal(story.options.num_predict, 120);
  assert.equal(story.options.temperature, 0.7);
  assert.equal(story.stream, false);
});

test('a timeout falls back to templates with ONE warning', async () => {
  let n = 0;
  const backend = { name: 'ollama', model: 'gemma3:1b', warm: async () => {}, complete: () => { n++; return new Promise(() => {}); } };
  const r = await ghosts.haunt(data, { backend, timeoutMs: 40, budgetMs: 5000 });
  assert.equal(r.backend, 'offline');
  assert.equal(r.model, 'template');
  assert.equal(r.warnings.filter((w) => /timed out/.test(w)).length, 1);
  assert.equal(n, 1, 'later stories do not wait again');
  assert.ok(r.ghosts.length >= 2);
  assert.ok(r.ghosts.every((g) => g.story));
});

test('the total budget stops the model and keeps stories made so far', async () => {
  let n = 0;
  const backend = {
    name: 'ollama', model: 'gemma3:1b', warm: async () => {},
    complete: async () => { n++; await new Promise((r) => setTimeout(r, 60)); return 'Netflix keeps haunting you for 15.5 each month.'; },
  };
  const r = await ghosts.haunt(data, { backend, timeoutMs: 1000, budgetMs: 90 });
  assert.equal(r.warnings.filter((w) => /time budget/.test(w)).length, 1);
  assert.ok(r.ghosts.length >= 2);
  assert.ok(r.ghosts.some((g) => /haunting you/.test(g.story)) || r.backend === 'offline');
  assert.ok(n >= 1 && n < r.ghosts.length + 1);
});

test('GHOST_TIMEOUT_MS and defaults', async () => {
  assert.equal(ghosts.constants.MODEL_TIMEOUT_MS, 60000);
  assert.equal(ghosts.constants.GROQ_TIMEOUT_MS, 15000);
  assert.equal(ghosts.constants.MODEL_BUDGET_MS, 150000);
  const backend = { name: 'ollama', model: 'm', warm: async () => {}, complete: () => new Promise(() => {}) };
  const r = await ghosts.haunt(data, { backend, env: { GHOST_TIMEOUT_MS: '30', GHOST_BUDGET_MS: '5000' } });
  assert.ok(r.warnings.some((w) => /timed out after 0 s|timed out/.test(w)));
});
