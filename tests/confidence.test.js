import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionConfidence } from '../lib/confidence.js';

test('extraction confidence rewards verified identity and useful fields', () => {
  const partial = extractionConfidence({ g_name: 'Example', g_lat: 31.5, g_lng: 74.3 });
  const rich = extractionConfidence({
    g_place_id: 'ChIJ-example', g_name: 'Example', g_lat: 31.5, g_lng: 74.3,
    g_category: 'Pharmacy', g_address: 'Road', g_phone: '+92420000000',
    g_rating: 4.5, g_image_url: 'https://example.test/image',
    g_menu_image_urls: ['https://example.test/menu.jpg']
  });
  assert.equal(partial, 0.45);
  assert.equal(rich, 1);
});
