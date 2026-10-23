#!/usr/bin/env node
// Explore the bundled place list.
//   node places.mjs countries
//   node places.mjs states "United States"
//   node places.mjs list "United States" [--state Texas] [--min 50000] [--limit 20] [--shard 3/8]
import { countryNames, placesFor, shardOf, statesFor } from './places/index.mjs';

const [cmd, country, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === 'countries') console.log(countryNames().join('\n'));
else if (cmd === 'states' && country) console.log(statesFor(country).join('\n'));
else if (cmd === 'list' && country) {
  let places = placesFor(country, { states: opt('state') ? [opt('state')] : [], minPopulation: Number(opt('min')) || 0, limit: Number(opt('limit')) || Infinity });
  if (opt('shard')) {
    const [index, count] = opt('shard').split('/').map(Number);
    places = shardOf(places, index, count);
  }
  for (const p of places) console.log(`${p.label.padEnd(50)} ${String(p.population).padStart(10)}`);
  console.error(`${places.length} places`);
} else console.log('Usage: node places.mjs countries | states <country> | list <country> [--state S] [--min N] [--limit N] [--shard I/N]');
