'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseInput } = require('../lib/ingest');
const ghosts = require('../lib/ghosts');
const fs = require('node:fs');
const path = require('node:path');

const demo = parseInput(fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo-alerts-us.txt'), 'utf8')).items;

function fakeBackend(calls) {
  return { name: 'ollama', model: 'fake', async warm() { return true; }, async complete({ system, user }) { calls.push({ system, user }); return null; } };
}

test('GHOST_MAX_STORIES limits how many stories the model is asked to write, with one note', async () => {
  const calls = [];
  const out = await ghosts.haunt(demo, { backend: fakeBackend(calls), env: { GHOST_MAX_STORIES: '2' } });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(out.ghosts.length, 5);
  assert.strictEqual(out.warnings.filter((w) => /save time/.test(w)).length, 1);
});

test('GHOST_COMPACT uses a much shorter prompt', async () => {
  const full = [], compact = [];
  await ghosts.haunt(demo, { backend: fakeBackend(full), env: {} });
  await ghosts.haunt(demo, { backend: fakeBackend(compact), env: { GHOST_COMPACT: '1' } });
  const len = (c) => c.reduce((n, x) => n + x.system.length + x.user.length, 0);
  assert.ok(len(compact) < len(full) * 0.6, 'compact ' + len(compact) + ' vs full ' + len(full));
});

test('a copied data row is not accepted as a story, even if its numbers are real', async () => {
  const echo = '2026-08-31 credit 2850 USD | A tiny spectral bill appeared on the screen |';
  assert.strictEqual(ghosts.looksLikeStory(echo, []), false);
  assert.strictEqual(ghosts.looksLikeStory('A credit of $2,850 arrived and most of it vanished in three days.', []), true);
  assert.strictEqual(ghosts.looksLikeStory('Too short', []), false);
  const backend = { name: 'ollama', model: 'fake', async warm() { return true; }, async complete() { return echo; } };
  const out = await ghosts.haunt(demo, { backend, env: {} });
  assert.ok(out.ghosts.every((g) => !g.story.includes('|')));
  assert.strictEqual(out.backend, 'offline');
});
