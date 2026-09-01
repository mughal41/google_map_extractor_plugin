import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_MS_TYPICAL, formatClock, gridDimensionFor, planEstimate, plannedJobs, riskLevel
} from '../lib/estimate.js';

const cityConfig = (overrides = {}) => ({
  location_mode: 'city',
  coverage_mode: 'adaptive',
  max_search_jobs: 100,
  term_delay_ms: 30000,
  terms: Array.from({ length: 22 }, (_, i) => `term ${i}`),
  ...overrides
});

test('planned jobs mirror the runner grid sizing', () => {
  assert.equal(gridDimensionFor(22, 100), 2, '100 budget over 22 terms gives 2x2 cells');
  assert.equal(gridDimensionFor(10, 100), 3);
  assert.equal(gridDimensionFor(40, 100), 1);
  const adaptive = plannedJobs(cityConfig());
  assert.equal(adaptive.initial, 88, '22 terms x 2x2 cells');
  assert.equal(adaptive.ceiling, 100, 'adaptive can refine up to the budget');
  const single = plannedJobs(cityConfig({ coverage_mode: 'city' }));
  assert.deepEqual([single.initial, single.ceiling], [22, 22]);
  const radius = plannedJobs({ location_mode: 'coordinates', terms: ['a', 'b', 'c'] });
  assert.deepEqual([radius.initial, radius.ceiling], [3, 3]);
});

test('estimate combines search time with jittered cooldowns and bounds', () => {
  const estimate = planEstimate(cityConfig({ coverage_mode: 'city' }));
  assert.equal(estimate.jobs, 22);
  assert.equal(estimate.searchMs, 22 * SEARCH_MS_TYPICAL);
  assert.ok(estimate.cooldownMs > 21 * 30000, 'cooldown averages include jitter');
  assert.ok(estimate.minMs < estimate.typicalMs && estimate.typicalMs < estimate.maxMs);
  assert.equal(estimate.risk, 'low');
  assert.equal(planEstimate(cityConfig()).risk, 'elevated');
  assert.equal(planEstimate(cityConfig({ max_search_jobs: 200 })).risk, 'high');
  assert.equal(riskLevel(60), 'low');
});

test('clock formatting is human', () => {
  assert.equal(formatClock(20000), 'under a minute');
  assert.equal(formatClock(48 * 60000), '48 min');
  assert.equal(formatClock(90 * 60000), '1 hr 30 min');
  assert.equal(formatClock(120 * 60000), '2 hr');
});
