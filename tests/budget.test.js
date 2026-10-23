import test from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetDay, checkBudget, freshUsage, mergeUsage, nextResetAt, recordBlock, spendBudget
} from '../lib/budget.js';
import { detailPauseMs, DETAIL_REST_EVERY } from '../lib/pacing.js';

const config = { daily_search_limit: 100, daily_detail_limit: 0, budget_margin: 0.95, budget_reset_hour: 0 };
const at = (text) => new Date(text);

test('budget day rolls over at the reset hour', () => {
  assert.equal(budgetDay(at('2026-10-15T03:00:00'), 4), '2026-10-14');
  assert.equal(budgetDay(at('2026-10-15T05:00:00'), 4), '2026-10-15');
  assert.equal(nextResetAt(at('2026-10-15T05:00:00'), 4).getTime(), at('2026-10-16T04:00:00').getTime());
});

test('pauses once the margin of the cap is used, until the next reset', () => {
  const now = at('2026-10-15T12:00:00');
  let usage = { day: '2026-10-15', searches: 94, details: 0, learned: {} };
  let result = spendBudget(usage, config, 'searches', now, 0);
  assert.equal(result.verdict.ok, true);
  assert.equal(result.usage.searches, 95);
  result = spendBudget(result.usage, config, 'searches', now, 0);
  assert.equal(result.verdict.ok, false);
  assert.equal(result.verdict.resumeAt, at('2026-10-16T00:00:00').toISOString());
  // A spent search cap does not hold the detail phase (unlimited here).
  assert.equal(spendBudget(result.usage, config, 'details', now, 0).verdict.ok, true);
});

test('resume waits for the jitter after the day rolls over', () => {
  const usage = { day: '2026-10-15', searches: 95, details: 0, resumeAt: { searches: at('2026-10-16T00:40:00').toISOString() }, learned: {} };
  const early = spendBudget(usage, config, 'searches', at('2026-10-16T00:10:00'));
  assert.equal(early.verdict.ok, false);
  assert.equal(early.usage.searches, 0);
  const late = spendBudget(early.usage, config, 'searches', at('2026-10-16T00:41:00'));
  assert.equal(late.verdict.ok, true);
  assert.equal(late.usage.resumeAt.searches, undefined);
});

test('a block ends the day and lowers the caps, which grow back on clean days', () => {
  const now = at('2026-10-15T12:00:00');
  const blocked = recordBlock({ day: '2026-10-15', searches: 60, details: 200, learned: {} }, config, now, 0);
  assert.deepEqual(blocked.learned, { searches: 48, details: 160 });
  assert.equal(checkBudget(blocked, config, 'searches', now).ok, false);
  assert.equal(checkBudget(blocked, config, 'details', now).ok, false);

  const nextDay = freshUsage(blocked, at('2026-10-16T12:00:00'), config);
  assert.equal(nextDay.blockedAt, null);
  // Learned cap 48 at a 95% margin allows 45 searches.
  assert.equal(checkBudget({ ...nextDay, searches: 44 }, config, 'searches', at('2026-10-16T12:00:00')).ok, true);
  assert.equal(checkBudget({ ...nextDay, searches: 45 }, config, 'searches', at('2026-10-16T12:00:00')).ok, false);

  assert.equal(freshUsage({ ...nextDay, searches: 30 }, at('2026-10-17T12:00:00'), config).learned.searches, 48);
  const grown = freshUsage({ ...nextDay, searches: 45 }, at('2026-10-17T12:00:00'), config);
  assert.equal(grown.learned.searches, 53);
});

test('merging keeps the higher counts and the lower learned cap', () => {
  const merged = mergeUsage(
    { day: '2026-10-15', searches: 10, details: 3, learned: { searches: 80 } },
    { day: '2026-10-15', searches: 7, details: 9, learned: { searches: 60 } }
  );
  assert.equal(merged.searches, 10);
  assert.equal(merged.details, 9);
  assert.equal(merged.learned.searches, 60);
  assert.equal(mergeUsage({ day: '2026-10-14', searches: 99 }, { day: '2026-10-15', searches: 1 }).searches, 1);
});

test('detail pauses are jittered and take a long break periodically', () => {
  assert.equal(detailPauseMs(4000, 3, 0).pauseMs, 2400);
  assert.equal(detailPauseMs(4000, 3, 1).pauseMs, 6000);
  const rest = detailPauseMs(4000, DETAIL_REST_EVERY, 0);
  assert.equal(rest.longRest, true);
  assert.equal(rest.pauseMs, 2400 + 24000);
});
