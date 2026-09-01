import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsForMapsView, cityResolutionUrl, createCityScanJobs, createJobs, extractMapsView,
  insideBounds, normalizeTerms, searchUrlForJob, splitScanCell
} from '../lib/location.js';

test('normalizes an ordered term plan without duplicates', () => {
  assert.deepEqual(normalizeTerms('restaurants\nbanks, parks\nrestaurants'), [
    'restaurants', 'banks', 'parks'
  ]);
  assert.deepEqual(createJobs(['banks', 'ATMs']).map(({ term, status }) => ({ term, status })), [
    { term: 'banks', status: 'pending' }, { term: 'ATMs', status: 'pending' }
  ]);
});

test('extracts the center and overview zoom selected by Maps', () => {
  assert.deepEqual(
    extractMapsView('https://www.google.com/maps/place/Lahore/@31.5204,74.3587,11.5z/data=x'),
    { lat: 31.5204, lng: 74.3587, zoom: 11.5 }
  );
  assert.equal(extractMapsView('https://www.google.com/maps'), null);
});

test('builds browser-only city resolution and queued search URLs', () => {
  assert.equal(
    cityResolutionUrl({ city: 'Lahore', country: 'Pakistan' }),
    'https://www.google.com/maps/search/Lahore%2C%20Pakistan'
  );
  assert.equal(
    searchUrlForJob(
      { location_mode: 'city', city: 'Lahore', country: 'Pakistan' },
      'restaurants',
      { lat: 31.5204, lng: 74.3587, zoom: 11 }
    ),
    'https://www.google.com/maps/search/restaurants%20in%20Lahore%2C%20Pakistan/@31.5204,74.3587,11z'
  );
});

test('turns a resolved Maps viewport into bounded grid jobs', () => {
  const bounds = boundsForMapsView({ lat: 31.52, lng: 74.35, zoom: 11 }, 900, 700);
  assert.ok(bounds.north > 31.52 && bounds.south < 31.52);
  assert.ok(bounds.east > 74.35 && bounds.west < 74.35);
  assert.equal(insideBounds(31.52, 74.35, bounds), true);
  assert.equal(insideBounds(40, 74.35, bounds), false);
  const jobs = createCityScanJobs(['restaurants', 'banks'], bounds, 11, 100, 'adaptive');
  assert.equal(jobs.length, 18);
  assert.equal(jobs[0].cell.zoom, 12.3);
  assert.equal(jobs[9].term, 'banks');
});

test('city scan respects the total job budget', () => {
  const jobs = createCityScanJobs(
    Array.from({ length: 25 }, (_, index) => `term ${index + 1}`),
    { north: 32, south: 31, west: 74, east: 75 },
    11,
    100,
    'adaptive'
  );
  assert.equal(jobs.length, 100);
  assert.equal(jobs.filter(({ term }) => term === 'term 1').length, 4);
});

test('adaptive cells subdivide into four higher-zoom children', () => {
  const [job] = createCityScanJobs(
    ['restaurants'], { north: 32, south: 31, west: 74, east: 75 }, 11, 9, 'adaptive'
  );
  const children = splitScanCell(job.cell);
  assert.equal(children.length, 4);
  assert.equal(children[0].depth, 1);
  assert.ok(Math.abs(children[0].zoom - (job.cell.zoom + 0.8)) < Number.EPSILON * 10);
  assert.equal(children[3].bounds.south, job.cell.bounds.south);
});
