#!/usr/bin/env node
// Atlas headless runner: drives the browser extension on a server with no GUI.
//
// It launches Chrome (under xvfb) with the extension loaded, hands it the same
// run config the popup would build, polls the run state through the
// extension's background worker, and writes the CSV when the run finishes.
// All pacing, cooldowns, deduplication, and parsing are the extension's own.
//
//   xvfb-run -a node run.mjs --country "United States" --city "Chicago" \
//     --terms "restaurants,pharmacies,dentists" --out chicago.csv
//
// Options
//   --country, --city        City mode (default). Country as spelled in lib/geo.js.
//   --lat, --lng, --radius   Coordinates mode instead of city mode (radius in meters).
//   --terms a,b,c            Search terms (comma separated). Repeatable.
//   --preset core[,health]   Add a preset from lib/presets.js. Repeatable. `--preset list` prints them.
//   --coverage adaptive|grid Coverage mode for city runs (default adaptive).
//   --max-jobs N             Search-job budget for city runs (default 100).
//   --term-delay MS          Cooldown between jobs in ms (default 45000). Do not go low.
//   --max-results N          Stop each search after N cards (default 0 = everything, ~120).
//   --detail-delay MS        Pause between place pages when enriching (default 4000).
//   --enrich                 Open every place for details (much slower).
//   --additional-info        Include the "additional info" section when enriching.
//   --keep-ads               Keep sponsored results (excluded by default).
//   --out FILE               CSV path (default: extension's own naming in ./output).
//   --proxy host:port        Chrome proxy server, e.g. a residential proxy.
//   --profile DIR            Persistent Chrome profile dir (default: fresh temp dir).
//   --chrome PATH            Chromium / Chrome for Testing binary (default: puppeteer's own download).
//   --headless               Use Chrome's headless mode instead of xvfb (more detectable).
//   --debug                  Turn on the extension's debug logging.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvFilename, recordsToCsv } from '../lib/csv.js';
import { MAX_TERMS, TERM_PRESETS } from '../lib/presets.js';
import { normalizeTerms } from '../lib/location.js';
import { EXTENSION_DIR, launchBrowser, startRun, waitForRun } from './core.mjs';

function parseArgs(argv) {
  const args = { terms: [], preset: [] };
  const flags = new Set(['enrich', 'additional-info', 'keep-ads', 'headless', 'debug', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (flags.has(key)) { args[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    i += 1;
    if (key === 'terms' || key === 'preset') args[key].push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    else args[key] = value;
  }
  return args;
}

function buildConfig(args) {
  if (args.preset.includes('list')) {
    for (const preset of TERM_PRESETS) console.log(`${preset.id.padEnd(12)} ${preset.terms.length} terms · ${preset.description}`);
    process.exit(0);
  }
  const presetTerms = args.preset.flatMap((id) => {
    const preset = TERM_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`Unknown preset "${id}". Use --preset list.`);
    return preset.terms;
  });
  const terms = normalizeTerms([...presetTerms, ...args.terms].join('\n'));
  if (!terms.length) throw new Error('Give at least one --terms or --preset.');
  if (terms.length > MAX_TERMS) throw new Error(`At most ${MAX_TERMS} terms per run (got ${terms.length}). Split into two runs.`);

  const cityMode = !(args.lat && args.lng);
  if (cityMode && !(args.country && args.city)) throw new Error('Give --country and --city, or --lat, --lng and --radius.');
  const config = {
    location_mode: cityMode ? 'city' : 'coordinates',
    country: cityMode ? args.country : '',
    city: cityMode ? args.city : '',
    coverage_mode: cityMode ? (args.coverage || 'adaptive') : 'radius',
    max_search_jobs: cityMode ? Number(args['max-jobs'] || 100) : terms.length,
    saturation_threshold: 40,
    lat: cityMode ? null : Number(args.lat),
    lng: cityMode ? null : Number(args.lng),
    radius_m: cityMode ? null : Number(args.radius || 2000),
    terms,
    term: terms[0],
    term_delay_ms: Number(args['term-delay'] || 45000),
    max_results_per_search: Number(args['max-results'] || 0),
    detail_delay_ms: Number(args['detail-delay'] || 4000),
    include_popular_times: false,
    include_additional_info: Boolean(args['additional-info']),
    exclude_sponsored: !args['keep-ads'],
    enrich_details: Boolean(args.enrich),
    detail_concurrency: 1,
    debug: Boolean(args.debug),
    radius_tolerance_m: 0
  };
  if (!cityMode && !(Number.isFinite(config.lat) && Number.isFinite(config.lng) && config.radius_m > 0)) {
    throw new Error('Invalid --lat/--lng/--radius.');
  }
  return config;
}

function writeCsv(run, outArg) {
  const outPath = outArg
    ? path.resolve(outArg)
    : path.resolve('output', csvFilename(run.config));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, recordsToCsv(run.records || []));
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fileURLToPath(import.meta.url).split('\n')[0]);
    console.log('See the header comment of run.mjs for options.');
    return;
  }
  const config = buildConfig(args);
  console.log(`Extension: ${EXTENSION_DIR}`);
  console.log(`Target: ${config.location_mode === 'city' ? `${config.city}, ${config.country}` : `${config.lat},${config.lng} r=${config.radius_m}m`}`);
  console.log(`Terms (${config.terms.length}): ${config.terms.join(', ')}`);
  console.log(`Cooldown between jobs: ${config.term_delay_ms} ms · enrich: ${config.enrich_details}`);

  const session = await launchBrowser({ chrome: args.chrome, headless: args.headless, profile: args.profile, proxy: args.proxy });
  const { browser, readRun } = session;

  let finalRun = null;
  const shutdown = async (reason) => {
    console.log(`\n${reason}`);
    try {
      const run = finalRun || await readRun();
      if (run?.records?.length) console.log(`Saved partial results: ${writeCsv(run, args.out)} (${run.records.length} rows)`);
    } catch { /* browser already gone */ }
    await browser.close().catch(() => undefined);
    process.exit(finalRun?.stage === 'complete' ? 0 : 1);
  };
  process.on('SIGINT', () => shutdown('Interrupted.'));
  process.on('SIGTERM', () => shutdown('Terminated.'));
  process.on('SIGHUP', () => shutdown('Terminal closed (SIGHUP).'));

  await startRun(session, config);
  console.log('Run started. Progress is polled every 10 seconds; Ctrl+C saves whatever has been collected.\n');
  finalRun = await waitForRun(session, { onProgress: (line) => console.log(line) });

  console.log(`\nRun ${finalRun.stage}: ${finalRun.message || ''}`);
  if (finalRun.errors?.length) {
    console.log('Errors:');
    for (const error of finalRun.errors.slice(-10)) console.log(`  ${error.stage}: ${error.error}`);
  }
  const outPath = writeCsv(finalRun, args.out);
  console.log(`CSV: ${outPath} (${finalRun.records?.length || 0} rows)`);
  await browser.close();
  process.exit(finalRun.stage === 'complete' ? 0 : 1);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
