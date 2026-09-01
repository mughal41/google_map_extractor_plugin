import test from 'node:test';
import assert from 'node:assert/strict';
import { csvFilename, recordsToCsv, serializeHours } from '../lib/csv.js';

test('CSV is Excel-compatible, quoted, and never writes undefined', () => {
  const csv = recordsToCsv([{
    g_cid: '13185174264843400000',
    g_name: 'Clinic, "North"',
    g_categories: ['Clinic', 'Doctor'],
    g_hours: null,
    g_address: undefined
  }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"Clinic, ""North"""/);
  assert.match(csv, /Clinic \| Doctor/);
  assert.doesNotMatch(csv, /undefined/);
  assert.match(csv, /=""13185174264843400000"""/);
  assert.ok(csv.endsWith('\r\n'));
});

test('export omits internal filtering and search metadata columns', () => {
  const header = recordsToCsv([]).slice(1).split('\r\n')[0];
  for (const omitted of ['distance_m', 'g_rank', 'g_maps_url', 'search_term', 'search_lat', 'search_lng', 'search_radius_m']) {
    assert.equal(header.split(',').includes(omitted), false);
  }
  assert.ok(header.includes('g_menu_image_urls'));
  assert.equal(header.split(',').includes('g_menu_url'), false);
  assert.ok(header.includes('g_image_url'));
});

test('hours and filename serialization follow the export contract', () => {
  assert.match(serializeHours({ mon: [['09:00', '18:00']], tue: [] }), /Mon 09:00-18:00 \| Tue Closed/);
  assert.equal(
    csvFilename(
      { term: 'Medical Clinic', lat: 31.52, lng: 74.35, radius_m: 5000 },
      new Date('2026-08-31T09:43:00.000Z')
    ),
    'google_maps_medical_clinic_31.52_74.35_5000m_20260831T094300Z.csv'
  );
});

test('city batches use the selected area in the filename', () => {
  assert.equal(
    csvFilename(
      { location_mode: 'city', city: 'Lahore', country: 'Pakistan', terms: ['restaurants', 'banks'] },
      new Date('2026-08-31T09:43:00.000Z')
    ),
    'google_maps_lahore_pakistan_batch_20260831T094300Z.csv'
  );
});
