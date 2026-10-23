#!/usr/bin/env node
// Builds places/places.json.gz from GeoNames (CC BY 4.0, https://www.geonames.org).
// Every populated place with 500+ people worldwide, grouped by country and
// tagged with its state/province. Run: node places/build.mjs [download dir]
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(process.argv[2] || path.join(here, 'download'));
mkdirSync(dir, { recursive: true });
for (const file of ['cities500.zip', 'admin1CodesASCII.txt', 'countryInfo.txt']) {
  if (!existsSync(path.join(dir, file))) {
    console.log(`Downloading ${file}…`);
    execSync(`curl -sfLo "${path.join(dir, file)}" https://download.geonames.org/export/dump/${file}`);
  }
}
if (!existsSync(path.join(dir, 'cities500.txt'))) execSync(`unzip -oq "${path.join(dir, 'cities500.zip')}" -d "${dir}"`);

const countries = {};
for (const line of readFileSync(path.join(dir, 'countryInfo.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split('\t');
  countries[cols[0]] = cols[4];
}
const admin1 = {};
for (const line of readFileSync(path.join(dir, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
  const [code, , asciiName] = line.split('\t');
  if (code) admin1[code] = asciiName;
}
const out = {};
let total = 0;
for (const line of readFileSync(path.join(dir, 'cities500.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = line.split('\t');
  const country = countries[c[8]];
  if (!country) continue;
  const state = admin1[`${c[8]}.${c[10]}`] || '';
  (out[country] ||= []).push({ name: c[2] || c[1], state, population: Number(c[14]) || 0, lat: Number(c[4]), lng: Number(c[5]) });
  total += 1;
}
for (const list of Object.values(out)) list.sort((a, b) => b.population - a.population);
const target = path.join(here, 'places.json.gz');
createWriteStream(target).end(gzipSync(JSON.stringify(out)));
console.log(`${total} places in ${Object.keys(out).length} countries → ${target}`);
