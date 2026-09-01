import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, CITIES, citiesForCountry } from '../lib/geo.js';
import { estimateRemainingMs, planEstimate } from '../lib/estimate.js';

test('country list is comprehensive and city suggestions resolve case-insensitively', () => {
  assert.ok(COUNTRIES.length >= 190, `expected a full country list, got ${COUNTRIES.length}`);
  assert.equal(new Set(COUNTRIES).size, COUNTRIES.length, 'no duplicate countries');
  assert.ok(Object.keys(CITIES).length >= 60, 'city suggestions cover the major markets');
  for (const [country, cities] of Object.entries(CITIES)) {
    assert.ok(cities.length >= 1, `${country} has cities`);
    assert.equal(new Set(cities).size, cities.length, `${country} has no duplicate cities`);
  }
  assert.ok(citiesForCountry('Pakistan').includes('Lahore'));
  assert.ok(citiesForCountry('  pakistan ').includes('Karachi'), 'trims and lowercases');
  assert.deepEqual(citiesForCountry('Atlantis'), []);
});

test('enrichment toggle visibly moves the estimate', () => {
  const base = {
    location_mode: 'city', coverage_mode: 'city', max_search_jobs: 100,
    term_delay_ms: 30000, terms: Array.from({ length: 20 }, (_, i) => `t${i}`)
  };
  const off = planEstimate(base);
  const on = planEstimate({ ...base, enrich_details: true });
  assert.ok(on.typicalMs > off.typicalMs, 'typical estimate grows with enrichment on');
  assert.ok(on.minMs > off.minMs && on.maxMs > off.maxMs);
  assert.ok(on.enrichMaxMs > on.enrichMinMs);
});

test('remaining-time model shrinks as jobs complete and ends at zero', () => {
  const run = (overrides) => estimateRemainingMs({
    active: true, stage: 'searching',
    config: { term_delay_ms: 30000 },
    jobs: Array.from({ length: 40 }, () => ({})),
    jobsCompleted: 0,
    records: [], unique: 0,
    ...overrides
  });
  const atStart = run({});
  const midway = run({ jobsCompleted: 20 });
  assert.ok(atStart > midway && midway > 0);
  assert.equal(run({ active: false, stage: 'complete' }), 0);
  const enriching = estimateRemainingMs({
    active: true, stage: 'enriching', config: {},
    records: Array.from({ length: 100 }, () => ({})), detailIndex: 60
  });
  assert.equal(enriching, 40 * 9000);
});
