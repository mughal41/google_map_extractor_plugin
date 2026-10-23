// Reads places/places.json.gz and answers "which places should the scraper visit".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

let cache = null;
export function loadPlaces() {
  if (!cache) {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'places.json.gz');
    cache = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  }
  return cache;
}

export function countryNames() { return Object.keys(loadPlaces()).sort(); }

export function findCountry(name) {
  const wanted = String(name || '').trim().toLowerCase();
  const key = Object.keys(loadPlaces()).find((k) => k.toLowerCase() === wanted);
  if (!key) throw new Error(`Unknown country "${name}". Known: ${countryNames().join(', ')}`);
  return key;
}

// Returns places sorted by population, filtered by optional states and
// minimum population. Each entry has name, state, population, lat, lng and a
// `label` of the form "Name, State" (or just "Name") for Maps searches.
export function placesFor(country, { states = [], minPopulation = 0, limit = Infinity } = {}) {
  const key = findCountry(country);
  const wantedStates = new Set(states.map((s) => s.toLowerCase()));
  // Two places can share a label (two Brentwoods in California). A Maps
  // search by label reaches only one of them, so keep the larger one.
  const seen = new Set();
  return loadPlaces()[key]
    .filter((p) => p.population >= minPopulation && (!wantedStates.size || wantedStates.has(p.state.toLowerCase())))
    .map((p) => ({ ...p, country: key, label: p.state && p.state !== p.name ? `${p.name}, ${p.state}` : p.name }))
    .filter((p) => !seen.has(p.label) && seen.add(p.label))
    .slice(0, limit);
}

export function statesFor(country) {
  return [...new Set(loadPlaces()[findCountry(country)].map((p) => p.state).filter(Boolean))].sort();
}

// Splits a largest-first list round-robin: share `index` (1-based) of
// `count` gets items index, index+count, index+2*count… so every share holds a
// fair mix of big and small places and no two shares overlap.
export function shardOf(list, index, count) {
  const n = Math.floor(Number(count) || 1);
  const i = Math.floor(Number(index) || 1);
  if (n < 1 || i < 1 || i > n) throw new Error(`shard_index must be 1..${n} (got ${index})`);
  return list.filter((_, position) => position % n === i - 1);
}
