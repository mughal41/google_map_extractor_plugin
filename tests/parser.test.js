import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCoordinatesFromUrl, extractIdentityFromUrl, extractMenuImageUrlsFromText,
  extractSearchPayload, isDirectImageUrl, parseHoursLabel, parseSearchRatingLabel
} from '../lib/parser.js';

const mapsUrl = 'https://www.google.com/maps/place/Example/@31.5208,74.3591,17z/data=!4m2!3m1!1sChIJabcdefghijklmno';

test('extracts coordinates and Place ID from a Maps URL', () => {
  assert.deepEqual(extractCoordinatesFromUrl(mapsUrl), { g_lat: 31.5208, g_lng: 74.3591 });
  assert.equal(extractIdentityFromUrl(mapsUrl).g_place_id, 'ChIJabcdefghijklmno');
});

test('converts a hexadecimal Maps CID to decimal', () => {
  assert.equal(extractIdentityFromUrl('https://maps.google.com/?cid=0x1:0xff').g_cid, '255');
  assert.equal(extractIdentityFromUrl('https://maps.google.com/?cid=13185174264843400000').g_cid, '13185174264843400000');
});

test('search payload adapter extracts Maps URLs and reports schema mismatch safely', () => {
  const search = { term: 'pharmacy', lat: 31.52, lng: 74.35, radius_m: 3000 };
  const records = extractSearchPayload(`prefix ${mapsUrl} suffix`, search);
  assert.equal(records.length, 1);
  assert.equal(records[0].g_name, 'Example');
  let warning = null;
  assert.deepEqual(extractSearchPayload('malformed payload', search, {
    warn(code) { warning = code; }
  }), []);
  assert.equal(warning, 'PARSER_SCHEMA_MISMATCH');
});

test('search payload recovers a nearby Place ID and already-loaded image URL', () => {
  const raw = `ChIJpayloadidentifier123 ${mapsUrl.replace('ChIJabcdefghijklmno', '0x1:0xff')} ` +
    'https://lh3.googleusercontent.com/example=w163-h92-k-no';
  const [record] = extractSearchPayload(raw, { term: 'pharmacy' });
  assert.equal(record.g_place_id, 'ChIJpayloadidentifier123');
  assert.equal(record.g_image_url, 'https://lh3.googleusercontent.com/example=w163-h92-k-no');
});

test('search-card rating label yields rating and review count', () => {
  assert.deepEqual(parseSearchRatingLabel('4.8 stars 9,230 Reviews'), {
    rating: 4.8,
    reviewCount: 9230
  });
  assert.deepEqual(parseSearchRatingLabel(null, '4.6'), {
    rating: 4.6,
    reviewCount: null
  });
});

test('hours parser supports split periods, closed days, and 24 hours', () => {
  const hours = parseHoursLabel(
    'Monday: 9 AM–1 PM, 2 PM–6 PM; Tuesday: Closed; Wednesday: Open 24 hours'
  );
  assert.deepEqual(hours.mon, [['09:00', '13:00'], ['14:00', '18:00']]);
  assert.deepEqual(hours.tue, []);
  assert.deepEqual(hours.wed, [['00:00', '24:00']]);
});

test('menu images accept direct image resources and reject menu/web/social links', () => {
  const menuImage = 'https://lh3.googleusercontent.com/menu-photo=w1200-h900-k-no';
  assert.equal(isDirectImageUrl(menuImage), true);
  for (const link of [
    'https://rancherscafe.com/menu',
    'https://www.facebook.com/restaurant/menu',
    'https://www.instagram.com/p/example/',
    'https://example.com/menu.pdf',
    'https://orders.example.com'
  ]) assert.equal(isDirectImageUrl(link), false);
  assert.deepEqual(
    extractMenuImageUrlsFromText(`Menu photos ${menuImage} Website https://example.com/menu`),
    [menuImage]
  );
});
