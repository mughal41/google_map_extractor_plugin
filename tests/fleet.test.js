import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, recordsToCsv, rowsToCsv } from '../lib/csv.js';
import { placesFor, shardOf } from '../headless/places/index.mjs';
import { cityOf, dropSupersededPartials, mergeRows } from '../headless/merge.mjs';
import { statusTable } from '../headless/fleet.mjs';

test('8 shares cover every US place over 20k exactly once, with a fair size mix', () => {
  const all = placesFor('United States', { minPopulation: 20000 }).map((p) => p.label);
  assert.equal(new Set(all).size, all.length, 'labels are unique');
  const shares = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => shardOf(all, i, 8));
  const flat = shares.flat();
  assert.equal(flat.length, all.length);
  assert.equal(new Set(flat).size, all.length);
  for (const share of shares) assert.ok(Math.abs(share.length - all.length / 8) <= 1);
  // Each share starts with one of the 8 biggest places.
  assert.deepEqual(shares.map((s) => s[0]), all.slice(0, 8));
  assert.throws(() => shardOf(all, 9, 8), /shard_index must be 1\.\.8/);
});

test('CSV survives a parse and write round trip, quotes and line breaks included', () => {
  const csv = recordsToCsv([{ g_place_id: 'a', g_name: 'Joe\'s "Diner", Inc', g_plus_code: '9MF7+6P Claremont,\nNH', g_cid: '11381232298472883159' }]);
  const { header, rows } = parseCsv(csv);
  assert.equal(rows[0].g_name, 'Joe\'s "Diner", Inc');
  assert.equal(rows[0].g_plus_code, '9MF7+6P Claremont,\nNH');
  assert.equal(rows[0].g_cid, '="11381232298472883159"');
  assert.equal(rowsToCsv(header, rows), csv);
});

test('merge keeps one row per place and fills gaps from the other copies', () => {
  const rows = mergeRows([
    { g_place_id: 'p1', g_name: 'CVS', g_phone: '', g_website: 'cvs.com', g_lat: '1', g_lng: '2' },
    { g_place_id: 'p1', g_name: 'CVS', g_phone: '+1555', g_website: '', g_lat: '1', g_lng: '2' },
    { g_place_id: '', g_cid: '="42"', g_name: 'A', g_lat: '', g_lng: '' },
    { g_place_id: '', g_cid: '="42"', g_name: 'A', g_lat: '', g_lng: '' },
    { g_place_id: '', g_cid: '', g_name: 'B', g_lat: '1.000001', g_lng: '2' },
    { g_place_id: '', g_cid: '', g_name: 'b', g_lat: '1.000002', g_lng: '2' }
  ]);
  assert.equal(rows.length, 3);
  const cvs = rows.find((r) => r.g_place_id === 'p1');
  assert.equal(cvs.g_phone, '+1555');
  assert.equal(cvs.g_website, 'cvs.com');
});

test('partial files are dropped once their city has a complete file', () => {
  const files = [
    'r/vps1/united_states-windsor_vermont-20261015-070618-002-partial.csv',
    'r/vps1/united_states-windsor_vermont-20261016-070015-003.csv',
    'r/vps2/united_states-bristol_vermont-20261015-070618-001-partial.csv'
  ];
  assert.equal(cityOf(files[0]), 'united_states-windsor_vermont');
  assert.deepEqual(dropSupersededPartials(files), [files[1], files[2]]);
});

test('fleet table shows each server and a fleet total', () => {
  const base = { country: 'United States', enrich: false, failedCities: 0, startedAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', events: [] };
  const table = statusTable([
    { server: { name: 'vps1' }, status: { ...base, state: 'running', alive: true, totalCities: 10, doneCities: 5, rowsTotal: 1200, cityDurationsMs: [3600000], usage: { searches: 100, searchLimit: 300, details: 0, detailLimit: 1200 } } },
    { server: { name: 'vps2' }, status: { ...base, state: 'paused', alive: true, totalCities: 10, doneCities: 2, rowsTotal: 300, resumeAt: '2026-10-16T05:00:00Z', cityDurationsMs: [] } },
    { server: { name: 'vps3' }, status: { ...base, state: 'running', alive: false, totalCities: 10, doneCities: 1, rowsTotal: 10 } },
    { server: { name: 'vps4' }, status: { unreachable: true, error: 'ssh: connect to host 192.0.2.4 port 22: Connection timed out' } },
    { server: { name: 'vps5' }, status: { starting: true } }
  ]);
  assert.match(table, /vps1\s+RUNNING\s+50\.0%\s+5\/10\s+1,200\s+100\/300/);
  assert.match(table, /vps2\s+PAUSED \(limit\)/);
  assert.match(table, /vps3\s+NOT RUNNING/);
  assert.match(table, /vps4\s+UNREACHABLE/);
  assert.match(table, /vps5\s+STARTING/);
  assert.match(table, /FLEET\s+26\.7% · 8\/30 cities · 1,510 rows · ETA 5\.0 h/);
});
