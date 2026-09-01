import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateRecords, mergePlaceRecord } from '../lib/dedupe.js';

test('duplicate Place IDs merge non-null data and preserve best rank', () => {
  const records = deduplicateRecords([
    { g_place_id: 'ChIJ-one', g_name: 'Example', g_phone: null, g_rank: 8, g_categories: ['Pharmacy'] },
    { g_place_id: 'ChIJ-one', g_name: null, g_phone: '+92420000000', g_rank: 3, g_categories: ['Health'] }
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].g_name, 'Example');
  assert.equal(records[0].g_phone, '+92420000000');
  assert.equal(records[0].g_rank, 3);
  assert.deepEqual(records[0].g_categories, ['Pharmacy', 'Health']);
});

test('fallback key deduplicates normalized name and rounded coordinates', () => {
  const records = deduplicateRecords([
    { g_place_id: null, g_name: 'Example, Ltd.', g_lat: 31.520401, g_lng: 74.358701 },
    { g_place_id: null, g_name: 'example', g_lat: 31.520402, g_lng: 74.358702 }
  ]);
  assert.equal(records.length, 1);
});

test('records with different non-empty Place IDs never merge', () => {
  assert.throws(() => mergePlaceRecord(
    { g_place_id: 'ChIJ-one' }, { g_place_id: 'ChIJ-two' }
  ), /DIFFERENT_PLACE_IDS/);
});
