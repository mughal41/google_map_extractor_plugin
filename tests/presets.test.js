import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TERMS, TERM_PRESETS } from '../lib/presets.js';
import { normalizeTerms } from '../lib/location.js';
import {
  JITTER_FRACTION, LONG_REST_EVERY_JOBS, baseCooldownMs, cooldownAfterJob,
  estimatedCooldownTotalMs
} from '../lib/pacing.js';

test('every preset is normalized, unique, and within the per-run cap', () => {
  for (const preset of TERM_PRESETS) {
    assert.ok(preset.id && preset.label && preset.description);
    assert.deepEqual(normalizeTerms(preset.terms), preset.terms, `${preset.id} terms should already be normalized`);
    assert.ok(preset.terms.length <= MAX_TERMS);
  }
});

test('no term repeats across presets and core plus extended fits one run', () => {
  const all = TERM_PRESETS.flatMap((preset) => preset.terms);
  assert.equal(new Set(all).size, all.length, 'presets must not overlap each other');
  const core = TERM_PRESETS.find((preset) => preset.id === 'core');
  const extended = TERM_PRESETS.find((preset) => preset.id === 'extended');
  assert.ok(core.terms.length + extended.terms.length <= MAX_TERMS);
});

test('cooldowns are jittered and periodically extended', () => {
  assert.equal(baseCooldownMs({ term_delay_ms: 30000 }), 30000);
  assert.equal(baseCooldownMs({ term_delay_ms: 1 }), 5000);
  const plain = cooldownAfterJob(30000, 3, 0);
  assert.equal(plain.cooldownMs, 30000);
  assert.equal(plain.longRest, false);
  const jittered = cooldownAfterJob(30000, 3, 1);
  assert.equal(jittered.cooldownMs, 30000 * (1 + JITTER_FRACTION));
  const rest = cooldownAfterJob(30000, LONG_REST_EVERY_JOBS, 0);
  assert.equal(rest.longRest, true);
  assert.ok(rest.cooldownMs > 30000 * 4);
});

test('cooldown estimates account for jitter averages and rest breaks', () => {
  assert.equal(estimatedCooldownTotalMs(1, 30000), 0);
  const eight = estimatedCooldownTotalMs(8, 30000);
  assert.ok(eight > 7 * 30000, 'average includes jitter');
  const nine = estimatedCooldownTotalMs(9, 30000);
  assert.ok(nine - eight > 30000 * 4, 'crossing the rest cadence adds a long break');
});
