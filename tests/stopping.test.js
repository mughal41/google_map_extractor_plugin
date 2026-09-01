import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStallState, shouldStopScrolling } from '../lib/stopping.js';

test('stops after three cycles without new unique results', () => {
  let state = { noNewCycles: 0, stableHeightCycles: 0, lastScrollHeight: 100, atBottom: false };
  state = nextStallState(state, { newUnique: 0, scrollHeight: 200, atBottom: false });
  state = nextStallState(state, { newUnique: 0, scrollHeight: 300, atBottom: false });
  assert.equal(shouldStopScrolling(state), false);
  state = nextStallState(state, { newUnique: 0, scrollHeight: 400, atBottom: false });
  assert.equal(shouldStopScrolling(state), true);
});

test('explicit end marker stops immediately', () => {
  assert.equal(shouldStopScrolling({ noNewCycles: 0, stableHeightCycles: 0 }, true), true);
});
