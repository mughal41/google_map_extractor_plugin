import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions } from '../lib/combobox.js';
import { COUNTRIES } from '../lib/geo.js';

test('combobox filtering ranks prefix matches first and is case-insensitive', () => {
  assert.deepEqual(filterOptions(['Spain', 'Pakistan', 'Palau', 'Nepal'], 'pa'), ['Pakistan', 'Palau', 'Spain', 'Nepal']);
  const t = filterOptions(COUNTRIES, 'T');
  assert.ok(t.length > 5, 'typing one letter surfaces many countries');
  assert.ok(t[0].startsWith('T'));
  assert.deepEqual(filterOptions(COUNTRIES, 'zzzz'), []);
  assert.equal(filterOptions(COUNTRIES, '').length, 60, 'empty query lists options up to the cap');
  assert.equal(filterOptions(COUNTRIES, '', 200).length, COUNTRIES.length);
});

test('popup no longer relies on native datalists', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<datalist/);
  assert.doesNotMatch(html, /list="/);
});
