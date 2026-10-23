#!/usr/bin/env node
// Joins many scrape CSVs (several cities, several servers) into one file and
// removes places that appear more than once. Neighbouring cities' map areas
// overlap, so a place on a city border is often in two CSVs.
//
//   node merge.mjs results                  every *.csv under results/, recursively
//   node merge.mjs results --out all.csv    choose the output file
//
// Duplicates are matched by Google place ID, then by CID, then by name plus
// coordinates. For a duplicate, each column keeps the first non-empty value,
// taking the most complete copy first, so an enriched row beats a bare one.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCsv, rowsToCsv } from '../lib/csv.js';
import { normalizeName } from '../lib/normalizers.js';

export function rowKey(row) {
  if (row.g_place_id) return `pid:${row.g_place_id}`;
  const cid = String(row.g_cid || '').replace(/[^0-9]/g, '');
  if (cid) return `cid:${cid}`;
  const lat = Number(row.g_lat);
  const lng = Number(row.g_lng);
  if (row.g_name && Number.isFinite(lat) && Number.isFinite(lng) && row.g_lat !== '' && row.g_lng !== '') {
    return `geo:${normalizeName(row.g_name)}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
  }
  return null;
}

const filled = (row) => Object.values(row).filter((v) => v !== '').length;

export function mergeRows(rows) {
  const groups = new Map();
  const loose = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (!key) { loose.push(row); continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const merged = [...groups.values()].map((copies) => {
    const ordered = [...copies].sort((a, b) => filled(b) - filled(a));
    const out = { ...ordered[0] };
    for (const copy of ordered.slice(1)) {
      for (const [field, value] of Object.entries(copy)) if (out[field] === '' && value !== '') out[field] = value;
    }
    return out;
  });
  return [...merged, ...loose];
}

// "<country>-<city>-<date>-<time>-<NNN>[-partial].csv" → "<country>-<city>"
export function cityOf(file) {
  return path.basename(file).replace(/-\d{8}-\d{6}-\d{3}(?:-partial)?\.csv$/, '');
}

// Partial files (raw results of an interrupted city) are only used for cities
// that never got a complete file.
export function dropSupersededPartials(files) {
  const complete = new Set(files.filter((f) => !f.endsWith('-partial.csv')).map(cityOf));
  return files.filter((f) => !f.endsWith('-partial.csv') || !complete.has(cityOf(f)));
}

function csvFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return csvFiles(full);
    return name.endsWith('.csv') && !name.startsWith('merged-') ? [full] : [];
  });
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  const dir = args.find((a, i) => !a.startsWith('--') && (outIndex < 0 || i !== outIndex + 1)) || 'results';
  if (!existsSync(dir)) { console.log(`No folder ${dir}. Run \`node fleet.mjs collect\` first, or name the folder.`); process.exit(2); }
  const found = csvFiles(dir).sort();
  const files = dropSupersededPartials(found);
  if (!files.length) { console.log(`No CSV files under ${dir}.`); process.exit(2); }
  let header = null;
  const rows = [];
  for (const file of files) {
    const parsed = parseCsv(readFileSync(file, 'utf8'));
    header ||= parsed.header;
    for (const h of parsed.header) if (!header.includes(h)) header.push(h);
    rows.push(...parsed.rows);
  }
  const merged = mergeRows(rows);
  const target = path.resolve(out || path.join(dir, `merged-${new Date().toISOString().slice(0, 10)}.csv`));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rowsToCsv(header, merged));
  const skipped = found.length - files.length;
  console.log(`${files.length} files${skipped ? ` (${skipped} partial file(s) skipped: their city finished later)` : ''} · ${rows.length} rows · ${rows.length - merged.length} duplicates removed · ${merged.length} unique places`);
  console.log(`→ ${target}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
