#!/usr/bin/env node
// Atlas country scraper: one JSON config per VPS, loops over every city of a
// country, and writes one CSV per city into out_dir named
//   <country>-<city>-<YYYYMMDD>-<HHMMSS>-<NNN>.csv  (…-partial.csv when interrupted)
//
//   xvfb-run -a node scrape.mjs config.json
//
// Config keys (see config.example.json)
//   country            Country name as spelled in lib/geo.js (e.g. "United States").
//   categories         Search terms, e.g. ["restaurants", "barber shops"]. Max 50 per city.
//   sleep_seconds      [min, max] cooldown between search jobs AND between cities. Keep it 60+.
//   cities             Optional explicit list of places. Empty = every place in
//                      places/places.json.gz for the country (GeoNames, 500+ people),
//                      largest first, narrowed by the filters below.
//   states             Optional list of states/provinces to include, e.g. ["Texas", "Ohio"].
//   min_population     Skip places smaller than this (default 0 = include villages).
//   max_places         Stop after this many places (default unlimited).
//   max_jobs_per_city  Search-job budget per city (default 100).
//   coverage           "adaptive" or "grid" (default adaptive).
//   max_results_per_search  Stop each search after this many cards (e.g. 50). 0 = everything
//                      Google will show, which it caps at about 120 per search.
//   enrich             true = open every place's page for phone, website, photo, hours,
//                      full address, plus code. Roughly 5 s per place on top of the search.
//   detail_delay_seconds  Pause between place pages in the detail phase (default 4).
//   additional_info    true = with enrich, also keep the amenities block (wheelchair
//                      access, payments, service options…) in g_additional_info.
//   out_dir            Where CSVs go (default "output").
//   proxy              Optional "host:port" Chrome proxy.
//   profile            Optional Chrome profile dir, kept between cities and restarts.
//   daily_search_limit Self-imposed cap on search page loads per day (default 500, 0 = off).
//   daily_detail_limit Self-imposed cap on place-page loads per day (default 2000, 0 = off).
//   budget_margin      Pause once this share of a cap is used (default 0.95).
//   reset_hour         Local hour the daily budget resets (default 0 = midnight).
//   reset_jitter_minutes  Resume at a random time up to this long after the reset (default 90).
//   max_blocks         Give up after this many CAPTCHAs in a row (default 2). Each one
//                      postpones the run to the next day and lowers the learned cap.
//   name               Optional label for this server (e.g. "vps3"), shown in status and messages.
//   shard_index, shard_count  Take only share `shard_index` (1..shard_count) of the place
//                      list, round-robin, so several servers split one country with no
//                      overlap. Set by `fleet.mjs setup`.
//   notify             Optional push messages: { "url": "https://ntfy.sh/<topic>",
//                      "format": "ntfy" | "discord" | "slack" | "json", "every_percent": 10 }.
//                      Sent on start, every N%, daily-limit pauses, resumes, CAPTCHAs, finish.
//
// Status: <out_dir>/status.json is updated every 10 s. Read it with
//   node status.mjs config.json [--watch]
//
// Google publishes no request limit for maps.google.com; these caps are guesses
// to tune per IP. When a cap is almost used up the run pauses in place (even
// mid-city) and continues after the reset. Usage is mirrored to
// <out_dir>/usage.json, so restarts keep counting the same day.
//
// Exit codes (the systemd service restarts only on 1):
//   0  went through every pending city (failed ones are retried on the next start)
//   1  crashed
//   5  stopped by a signal (systemctl stop, Ctrl+C, reboot) after saving
//   3  stopped on purpose: repeated CAPTCHAs or Google's consent page; needs a human
//   4  another scraper already uses this profile
//
// Progress is written to <out_dir>/progress.json. Restarting the script skips
// cities already finished, so a crash or reboot just continues where it left off.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkBudget, freshUsage, mergeUsage, recordBlock, spendBudget } from '../lib/budget.js';
import { recordsToCsv } from '../lib/csv.js';
import { placesFor, shardOf } from './places/index.mjs';
import { normalizeTerms } from '../lib/location.js';
import { MAX_TERMS } from '../lib/presets.js';
import { baseConfig, launchBrowser, releaseStaleProfile, sleep, startRun, waitForRun } from './core.mjs';
import { createReporter, formatDuration } from './reporter.mjs';

const slug = (text) => String(text).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const randomBetween = (min, max) => Math.round(min + Math.random() * Math.max(0, max - min));
const log = (message) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${message}`);

function loadConfig(file) {
  if (!file) throw new Error('Usage: node scrape.mjs config.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!raw.country) throw new Error('config.country is required');
  const terms = normalizeTerms((raw.categories || []).join('\n'));
  if (!terms.length) throw new Error('config.categories must list at least one search term');
  if (terms.length > MAX_TERMS) throw new Error(`At most ${MAX_TERMS} categories per run (got ${terms.length})`);
  const [minSleep, maxSleep] = Array.isArray(raw.sleep_seconds) ? raw.sleep_seconds : [raw.sleep_seconds || 60, raw.sleep_seconds || 75];
  const cities = raw.cities?.length
    ? raw.cities
    : placesFor(raw.country, {
      states: raw.states || [],
      minPopulation: Number(raw.min_population) || 0,
      limit: Number(raw.max_places) || Infinity
    }).map((p) => p.label);
  if (!cities.length) throw new Error(`No places matched for "${raw.country}" with the given states/min_population.`);
  const shardCount = Number(raw.shard_count) || 1;
  const mine = shardCount > 1 ? shardOf(cities, raw.shard_index, shardCount) : cities;
  return {
    name: raw.name || '',
    shard: shardCount > 1 ? { index: Number(raw.shard_index), count: shardCount, ofTotal: cities.length } : null,
    country: raw.country, terms, cities: mine,
    sleep: [Number(minSleep), Math.max(Number(minSleep), Number(maxSleep))],
    maxJobs: Number(raw.max_jobs_per_city) || 100,
    coverage: raw.coverage || 'adaptive',
    enrich: Boolean(raw.enrich),
    additionalInfo: Boolean(raw.additional_info),
    maxResults: Number(raw.max_results_per_search) || 0,
    detailDelay: (Number(raw.detail_delay_seconds) || 4) * 1000,
    outDir: path.resolve(raw.out_dir || 'output'),
    proxy: raw.proxy || null,
    profile: raw.profile ? path.resolve(raw.profile) : null,
    chrome: raw.chrome || null,
    headless: Boolean(raw.headless),
    budget: {
      daily_search_limit: raw.daily_search_limit ?? 500,
      daily_detail_limit: raw.daily_detail_limit ?? 2000,
      budget_margin: raw.budget_margin ?? 0.95,
      budget_reset_hour: raw.reset_hour ?? 0,
      budget_reset_jitter_minutes: raw.reset_jitter_minutes ?? 90
    },
    maxBlocks: Math.max(1, Number(raw.max_blocks) || 2),
    notify: raw.notify?.url ? raw.notify : null
  };
}

function nextFileNumber(outDir) {
  const used = readdirSync(outDir).map((name) => /-(\d{3})(?:-partial)?\.csv$/.exec(name)?.[1]).filter(Boolean).map(Number);
  return (used.length ? Math.max(...used) : 0) + 1;
}

// A partial file is saved when a city is interrupted. It holds the raw search
// results (before the city-boundary filter), so merge.mjs drops it once the
// city has a complete file.
function csvPath(cfg, city, partial = false) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const number = String(nextFileNumber(cfg.outDir)).padStart(3, '0');
  return path.join(cfg.outDir, `${slug(cfg.country)}-${slug(city)}-${date}-${time}-${number}${partial ? '-partial' : ''}.csv`);
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

let reporter = null;

// Sleeps until `until`, keeping status.json fresh so `status.mjs` can tell a
// long pause from a dead process.
async function sleepUntil(until, why, state = 'paused') {
  const text = `${why} Postponing until ${until.toLocaleString()} (${formatDuration(until - Date.now())}).`;
  log(text);
  reporter?.update({ state, stateMessage: text, resumeAt: until.toISOString() });
  await reporter?.event(state === 'blocked' ? 'CAPTCHA, waiting' : 'Paused for today', text, { push: true });
  while (Date.now() < until.getTime()) {
    await sleep(Math.min(60000, until.getTime() - Date.now()));
    reporter?.write();
  }
  log('Resuming.');
  reporter?.update({ state: 'running', stateMessage: '', resumeAt: null });
  await reporter?.event('Resumed', 'New budget day started.', { push: true });
}

function loadProgress(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { done: {}, failed: {} };
}

async function main() {
  const cfg = loadConfig(process.argv[2]);
  mkdirSync(cfg.outDir, { recursive: true });
  const progressFile = path.join(cfg.outDir, 'progress.json');
  const progress = loadProgress(progressFile);
  const saveProgress = () => writeFileSync(progressFile, JSON.stringify(progress, null, 2));

  const pending = cfg.cities.filter((city) => !progress.done[city]);
  // Check the profile before touching status.json: if another scraper holds
  // it, that scraper owns the status file.
  if (cfg.profile) await releaseStaleProfile(cfg.profile, log);
  reporter = createReporter({ outDir: cfg.outDir, name: cfg.name, shard: cfg.shard, country: cfg.country, totalCities: cfg.cities.length, enrich: cfg.enrich, notify: cfg.notify, log });
  const tally = () => {
    const done = cfg.cities.filter((city) => progress.done[city]);
    reporter.update({
      doneCities: done.length,
      failedCities: cfg.cities.filter((city) => progress.failed[city] && !progress.done[city]).length,
      rowsTotal: done.reduce((sum, city) => sum + (progress.done[city].rows || 0), 0)
    });
  };
  tally();
  if (cfg.shard) log(`${cfg.name || 'This server'}: share ${cfg.shard.index} of ${cfg.shard.count} → ${cfg.cities.length} of ${cfg.shard.ofTotal} places`);
  log(`${cfg.country}: ${cfg.cities.length} cities, ${pending.length} pending · ${cfg.terms.length} categories · sleep ${cfg.sleep[0]}-${cfg.sleep[1]}s · per search ${cfg.maxResults || 'max'} · enrich ${cfg.enrich}`);
  log(`Categories: ${cfg.terms.join(', ')}`);
  if (!pending.length) {
    reporter.update({ state: 'finished', stateMessage: 'Every city is done.' });
    log('Everything is done. Delete progress.json to start over.');
    return;
  }

  const session = await launchBrowser({ chrome: cfg.chrome, headless: cfg.headless, profile: cfg.profile, proxy: cfg.proxy });
  const usageFile = path.join(cfg.outDir, 'usage.json');
  let usage = mergeUsage(await session.readUsage(), readJson(usageFile));
  const syncUsage = async () => {
    usage = mergeUsage(await session.readUsage().catch(() => null), usage);
    writeFileSync(usageFile, JSON.stringify(usage, null, 2));
  };
  const setUsage = async (next) => {
    usage = next;
    await session.writeUsage(usage);
    writeFileSync(usageFile, JSON.stringify(usage, null, 2));
  };
  if (usage) await setUsage(freshUsage(usage, new Date(), cfg.budget));
  const describeUsage = () => {
    const u = freshUsage(usage, new Date(), cfg.budget);
    const s = checkBudget(u, cfg.budget, 'searches');
    const d = checkBudget(u, cfg.budget, 'details');
    reporter.update({ usage: { day: u.day, searches: u.searches, searchLimit: s.limit, details: u.details, detailLimit: d.limit } });
    return `today ${u.searches}/${s.limit || '∞'} searches, ${u.details}/${d.limit || '∞'} place pages`;
  };
  log(`Daily budget: ${describeUsage()}`);
  await reporter.event('Started', `${pending.length} of ${cfg.cities.length} cities to go · ${describeUsage()}`, { push: true });

  let current = null;
  const savePartial = async () => {
    const run = await session.readRun().catch(() => null);
    if (current && run?.records?.length) {
      const file = csvPath(cfg, current, true);
      writeFileSync(file, recordsToCsv(run.records));
      log(`Saved partial ${current}: ${file} (${run.records.length} rows)`);
    }
  };
  const shutdown = async (reason) => {
    log(reason);
    reporter.update({ state: 'stopped', stateMessage: `${reason} Start it again to continue.`, resumeAt: null });
    await reporter.event('Stopped', reason, { push: true });
    await savePartial();
    await syncUsage().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
    process.exit(5);
  };
  process.on('SIGINT', () => shutdown('Interrupted.'));
  process.on('SIGTERM', () => shutdown('Terminated.'));
  process.on('SIGHUP', () => shutdown('Terminal closed (SIGHUP).'));

  let blocksInARow = 0;
  let exitCode = 0;
  for (let i = 0; i < pending.length; i += 1) {
    const city = pending[i];
    // Do not open a city on an exhausted budget; the city lookup itself is a
    // search, so charge it here.
    for (;;) {
      const { verdict, usage: next } = spendBudget(usage, cfg.budget, 'searches');
      await setUsage(next);
      if (verdict.ok) break;
      await session.mapsPage.goto('about:blank').catch(() => undefined);
      await sleepUntil(new Date(verdict.resumeAt), verdict.reason === 'blocked'
        ? 'Google blocked this IP today.'
        : `Daily search budget almost used (${verdict.used}/${verdict.limit}).`);
    }

    current = city;
    const termDelay = randomBetween(cfg.sleep[0], cfg.sleep[1]) * 1000;
    const config = baseConfig({
      location_mode: 'city', country: cfg.country, city,
      coverage_mode: cfg.coverage, max_search_jobs: cfg.maxJobs,
      terms: cfg.terms, term: cfg.terms[0],
      term_delay_ms: termDelay, enrich_details: cfg.enrich,
      include_additional_info: cfg.additionalInfo, max_results_per_search: cfg.maxResults,
      detail_delay_ms: cfg.detailDelay,
      ...cfg.budget
    });
    log(`▶ ${city}, ${cfg.country} · cooldown ${termDelay / 1000}s between jobs · ${describeUsage()}`);
    const cityStarted = new Date();
    reporter.update({
      state: 'running', stateMessage: '', resumeAt: null,
      current: { city, stage: 'starting', jobsDone: 0, jobs: 0, details: 0, detailsTotal: 0, unique: 0, startedAt: cityStarted.toISOString() }
    });
    await startRun(session, config);
    let pausedLogged = null;
    const run = await waitForRun(session, {
      onProgress: (line) => console.log(`   ${line}`),
      onPoll: (r) => {
        syncUsage().then(describeUsage).catch(() => undefined);
        reporter.update({
          current: {
            city, stage: r.stage, startedAt: cityStarted.toISOString(),
            jobsDone: r.jobsCompleted ?? 0, jobs: r.jobs?.length || 0,
            details: r.detailsCompleted ?? 0, detailsTotal: r.records?.length || 0, unique: r.records?.length || 0
          }
        });
        if (r.pausedUntil && r.pausedUntil !== pausedLogged) {
          pausedLogged = r.pausedUntil;
          log(`⏸ ${r.message}`);
          reporter.update({ state: 'paused', stateMessage: r.message, resumeAt: r.pausedUntil });
          reporter.event('Paused for today', `${city}: ${r.message}`, { push: true }).catch(() => undefined);
        } else if (!r.pausedUntil && pausedLogged) {
          pausedLogged = null;
          reporter.update({ state: 'running', stateMessage: '', resumeAt: null });
          reporter.event('Resumed', `${city} continues.`, { push: true }).catch(() => undefined);
        }
      }
    });
    await syncUsage();

    const rows = run.records?.length || 0;
    if (rows) {
      const file = csvPath(cfg, city);
      writeFileSync(file, recordsToCsv(run.records));
      log(`✔ ${city}: ${run.stage} · ${rows} rows → ${path.basename(file)}`);
    } else {
      log(`✖ ${city}: ${run.stage} · no rows · ${run.message || ''}`);
    }
    for (const e of (run.errors || []).slice(-5)) log(`   error ${e.stage}: ${e.error}${e.place_id ? ` (${e.place_id})` : ''}`);
    if (run.stage === 'complete') { progress.done[city] = { rows, at: new Date().toISOString() }; delete progress.failed[city]; }
    else progress.failed[city] = { stage: run.stage, rows, message: run.message, at: new Date().toISOString() };
    saveProgress();
    current = null;
    tally();
    // Only clean cities feed the ETA; a blocked attempt is retried anyway.
    if (run.stage === 'complete') reporter.cityFinished(Date.now() - cityStarted.getTime());
    else reporter.update({ current: null });
    await reporter.event(run.stage === 'complete' ? 'City done' : 'City failed', `${city} · ${rows} rows`);
    await reporter.milestone();

    const errorCodes = new Set((run.errors || []).map((e) => e.error));
    if (errorCodes.has('CONSENT_REQUIRED')) {
      log('Google is showing its consent page. Accept it once in this profile, then rerun.');
      reporter.update({ state: 'stopped', stateMessage: 'Google consent page: accept it once in this profile, then rerun.' });
      await reporter.event('Stopped', 'Google consent page needs accepting.', { push: true });
      exitCode = 3;
      break;
    }
    if (errorCodes.has('ACCESS_BLOCKED')) {
      blocksInARow += 1;
      await setUsage(recordBlock(usage, cfg.budget));
      if (blocksInARow >= cfg.maxBlocks) {
        const text = `Google showed a CAPTCHA ${blocksInARow} times in a row. Stopping; use a different IP or lower the daily limits, then rerun.`;
        log(text);
        reporter.update({ state: 'stopped', stateMessage: text, resumeAt: null });
        await reporter.event('Stopped', text, { push: true });
        exitCode = 3;
        break;
      }
      const learned = usage.learned || {};
      log(`Google showed a CAPTCHA. Caps lowered to ${learned.searches ?? '–'} searches / ${learned.details ?? '–'} place pages per day (they grow back 10% per clean day); ${city} will be retried.`);
      await session.mapsPage.goto('about:blank').catch(() => undefined);
      await sleepUntil(new Date(usage.resumeAt.searches), `Google showed a CAPTCHA on ${city}; it will be retried.`, 'blocked');
      i -= 1; // retry the same city
      continue;
    }
    blocksInARow = 0;

    if (i < pending.length - 1) {
      const pause = randomBetween(cfg.sleep[0], cfg.sleep[1]) * 1000;
      log(`Sleeping ${pause / 1000}s before the next city…`);
      reporter.update({ stateMessage: `Short break before the next city (${pause / 1000}s).` });
      await sleep(pause);
    }
  }
  await session.browser.close();
  const done = cfg.cities.filter((city) => progress.done[city]).length;
  log(`Finished: ${done}/${cfg.cities.length} cities complete. CSVs are in ${cfg.outDir}`);
  if (reporter.status.state !== 'stopped') {
    const complete = done === cfg.cities.length;
    reporter.update({ state: complete ? 'finished' : 'stopped', stateMessage: complete ? `All ${done} cities done. CSVs are in ${cfg.outDir}.` : `${done}/${cfg.cities.length} cities done; failed ones are retried on the next start.`, resumeAt: null, current: null });
    await reporter.event(complete ? 'Finished' : 'Run ended', reporter.status.stateMessage, { push: true });
  }
  process.exit(exitCode);
}

main().catch(async (error) => {
  console.error(`Error: ${error.message}`);
  // The status file belongs to the scraper that holds the profile.
  if (error.code === 'PROFILE_IN_USE') process.exit(4);
  try {
    reporter?.update({ state: 'error', stateMessage: error.message });
    await reporter?.event('Crashed', error.message, { push: true });
  } catch { /* nothing left to report to */ }
  process.exit(1);
});
