import { deduplicateRecords, mergePlaceRecord, placeKey } from './lib/dedupe.js';
import { extractionConfidence } from './lib/confidence.js';
import { isInsideRadius } from './lib/distance.js';
import {
  boundsForMapsView, createCityScanJobs, extractMapsView, insideBounds, searchUrlForJob,
  splitScanCell
} from './lib/location.js';
import { Logger } from './lib/logger.js';
import { baseCooldownMs, cooldownAfterJob } from './lib/pacing.js';
import {
  extractPlaceDOM, extractPlaceEmbeddedState, extractSearchDOM, extractSearchPayload,
  isBlockingPage
} from './lib/parser.js';
import { endOfListTextFound, nextStallState, shouldStopScrolling } from './lib/stopping.js';

if (!globalThis.__mapsLightExtractorContentLoaded) {
  globalThis.__mapsLightExtractorContentLoaded = true;
  startContentController().catch((error) => {
    console.error('[MapsExtractor] CONTENT_CONTROLLER_FAILED', error);
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function getRun() {
  return (await chrome.storage.local.get('extractorRun')).extractorRun || null;
}

async function saveRun(state) {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ extractorRun: state });
}

function injectPageObserver() {
  if (document.getElementById('maps-light-extractor-injected')) return;
  const script = document.createElement('script');
  script.id = 'maps-light-extractor-injected';
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  const parent = document.documentElement || document.head;
  if (parent) parent.appendChild(script);
  else document.addEventListener('readystatechange', () => {
    (document.documentElement || document.head)?.appendChild(script);
  }, { once: true });
}

async function waitForPage(signal) {
  if (document.readyState !== 'loading') return;
  await new Promise((resolve, reject) => {
    document.addEventListener('DOMContentLoaded', resolve, { once: true });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

async function currentRunActive(signal) {
  if (signal.aborted) return false;
  return Boolean((await getRun())?.active);
}

async function failRun(state, code, message, logger, extra = {}) {
  state.active = false;
  state.stage = 'error';
  state.nextRunAt = null;
  state.message = message;
  const job = state.jobs?.[state.currentJobIndex];
  if (job && job.status === 'running') job.status = 'error';
  state.errors = [...(state.errors || []), { stage: state.stage, error: code, ...extra }];
  logger.error(code, extra);
  await saveRun(state);
}

async function startContentController() {
  const abortController = new AbortController();
  const payloadQueue = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'maps-light-extractor' ||
        event.data?.type !== 'MAPS_PAYLOAD') return;
    if (typeof event.data.body === 'string') payloadQueue.push(event.data.body);
    if (payloadQueue.length > 20) payloadQueue.shift();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'STOP_RUN') abortController.abort();
  });

  injectPageObserver();
  await waitForPage(abortController.signal);
  const state = await getRun();
  if (!state?.active) return;
  const logger = new Logger(state.config?.debug);
  const block = isBlockingPage(document);
  if (block) {
    await failRun(
      state, block,
      'Google Maps is showing a block or consent page. The queue stopped without retrying.',
      logger
    );
    return;
  }

  try {
    if (state.stage === 'resolving_location') {
      await resolveCityLocation(state, logger, abortController.signal);
    } else if (state.stage === 'waiting_between_jobs') {
      await resumeScheduledJob(state, abortController.signal);
    } else if (state.stage === 'opening_search' || state.stage === 'searching') {
      await collectSearchResults(state, logger, abortController.signal, payloadQueue);
    } else if (state.stage === 'filtering' || state.stage === 'enriching') {
      await enrichCurrentPlace(state, logger, abortController.signal);
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      const latest = await getRun() || state;
      await failRun(latest, 'UNEXPECTED_ERROR', error.message, logger);
    }
  }
}

async function resolveCityLocation(state, logger, signal) {
  state.message = `Resolving ${state.config.city}, ${state.config.country}…`;
  await saveRun(state);
  let view = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    view = extractMapsView(location.href);
    if (view && (document.querySelector('h1') || attempt >= 6)) break;
    await delay(500, signal);
  }
  if (!view) {
    await failRun(
      state, 'LOCATION_RESOLUTION_FAILED',
      `Google Maps did not resolve ${state.config.city}, ${state.config.country} to a map center.`,
      logger
    );
    return;
  }
  const heading = document.querySelector('h1')?.textContent?.trim();
  const requestedCountry = state.config.country.trim();
  const resolvedLabel = heading
    ? new RegExp(`\\b${requestedCountry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(heading)
      ? heading
      : `${heading}, ${requestedCountry}`
    : `${state.config.city}, ${requestedCountry}`;
  state.resolvedLocation = {
    label: resolvedLabel,
    lat: view.lat,
    lng: view.lng,
    zoom: view.zoom,
    resolvedAt: new Date().toISOString()
  };
  const mapElement = document.querySelector('[aria-label="Map"]');
  const mapRect = mapElement?.getBoundingClientRect?.();
  const viewportWidth = mapRect?.width > 300 ? mapRect.width : Math.max(480, window.innerWidth - 420);
  const viewportHeight = mapRect?.height > 240 ? mapRect.height : Math.max(360, window.innerHeight);
  state.coverageBounds = boundsForMapsView(view, viewportWidth, viewportHeight);
  state.jobs = createCityScanJobs(
    state.config.terms,
    state.coverageBounds,
    view.zoom,
    state.config.max_search_jobs,
    state.config.coverage_mode
  );
  state.scan = {
    mode: state.config.coverage_mode,
    initialJobs: state.jobs.length,
    maxJobs: state.config.max_search_jobs,
    refinementsAdded: 0,
    saturationThreshold: state.config.saturation_threshold,
    viewportWidth: Math.round(viewportWidth),
    viewportHeight: Math.round(viewportHeight)
  };
  state.currentJobIndex = 0;
  const job = state.jobs[0];
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.baseUnique = state.records.length;
  state.stage = 'opening_search';
  state.message = `Resolved to ${state.resolvedLocation.label}. Planned ${state.jobs.length} initial cell searches; opening ${job.term}.`;
  await saveRun(state);
  await delay(1200, signal);
  location.assign(searchUrlForJob(state.config, job.term, state.resolvedLocation, job.cell));
}

async function findFeed(signal) {
  const selectors = ['[role="feed"]', '[aria-label*="Results"][role="feed"]'];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    for (const selector of selectors) {
      const feed = document.querySelector(selector);
      if (feed) return feed;
    }
    await delay(500, signal);
  }
  return null;
}

function discoveryKey(record) {
  return record.g_maps_url || placeKey(record) || `${record.g_name || 'unknown'}:${record.g_rank || 0}`;
}

function currentSearchConfig(state) {
  const job = state.jobs[state.currentJobIndex];
  const center = job?.cell || state.resolvedLocation || state.config;
  return {
    ...state.config,
    term: job?.term || state.config.term,
    lat: center.lat,
    lng: center.lng,
    radius_m: state.config.location_mode === 'city' ? null : state.config.radius_m
  };
}

function totalDiscovered(state) {
  return (state.jobs || []).reduce((sum, job) => sum + (job.discovered || 0), 0);
}

function describeJob(job) {
  return `${job.term}${job.cell ? ` · ${job.cell.label} · ${job.cell.zoom}z` : ''}`;
}

async function collectSinglePlaceResult(state, logger, signal) {
  const config = currentSearchConfig(state);
  let record = extractPlaceDOM(document, config);
  for (const part of extractPlaceEmbeddedState(document, config, logger)) {
    try { record = mergePlaceRecord(record, part); } catch { /* unrelated structured data */ }
  }
  if (!record.g_name) return false;
  state.records = deduplicateRecords([...(state.records || []), record]);
  const job = state.jobs[state.currentJobIndex];
  job.discovered = 1;
  state.discovered = totalDiscovered(state);
  state.unique = state.records.length;
  await saveRun(state);
  await finishSearchJob(state, logger, signal);
  return true;
}

async function collectSearchResults(state, logger, signal, payloadQueue) {
  const job = state.jobs[state.currentJobIndex];
  if (!job) {
    await finishBatchDiscovery(state, logger, signal);
    return;
  }
  job.status = 'running';
  job.startedAt ||= new Date().toISOString();
  job.baseUnique ??= (state.records || []).length;
  state.stage = 'searching';
  state.message = `Job ${state.currentJobIndex + 1} of ${state.jobs.length}: collecting ${describeJob(job)}…`;
  await saveRun(state);

  const feed = await findFeed(signal);
  if (!feed) {
    if (await collectSinglePlaceResult(state, logger, signal)) return;
    await failRun(state, 'SEARCH_FEED_NOT_FOUND', 'Could not find a Maps result feed or place page.', logger);
    return;
  }

  let records = deduplicateRecords(state.records || []);
  const observed = new Set();
  let stall = { noNewCycles: 0, stableHeightCycles: 0, lastScrollHeight: feed.scrollHeight, atBottom: false };
  const config = currentSearchConfig(state);

  while (await currentRunActive(signal)) {
    const candidates = extractSearchDOM(document, config);
    while (payloadQueue.length) {
      candidates.push(...extractSearchPayload(payloadQueue.shift(), config, logger));
    }
    let newObservations = 0;
    for (const candidate of candidates) {
      const key = discoveryKey(candidate);
      if (!observed.has(key)) {
        observed.add(key);
        newObservations += 1;
        logger.debug('CANDIDATE_DISCOVERED', { placeId: candidate.g_place_id, term: job.term });
      }
    }
    records = deduplicateRecords([...records, ...candidates]);
    state.records = records;
    job.discovered = observed.size;
    job.added = Math.max(0, records.length - job.baseUnique);
    state.discovered = totalDiscovered(state);
    state.unique = records.length;
    state.message = `Job ${state.currentJobIndex + 1}/${state.jobs.length} · ${describeJob(job)} · ${observed.size} cards · ${records.length} unique total.`;
    await saveRun(state);

    const explicitEnd = endOfListTextFound(feed, document);
    const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 12;
    stall = nextStallState(stall, {
      newUnique: newObservations,
      scrollHeight: feed.scrollHeight,
      atBottom
    });
    if (shouldStopScrolling(stall, explicitEnd)) break;
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    await delay(1600, signal);
  }
  if (!(await currentRunActive(signal))) return;
  state.records = records;
  await finishSearchJob(state, logger, signal);
}

async function finishSearchJob(state, logger, signal) {
  const job = state.jobs[state.currentJobIndex];
  job.status = 'complete';
  job.completedAt = new Date().toISOString();
  job.added = Math.max(0, (state.records || []).length - (job.baseUnique || 0));
  state.jobsCompleted = state.jobs.filter((item) => item.status === 'complete').length;
  addAdaptiveRefinements(state, job);
  const nextIndex = state.currentJobIndex + 1;
  if (nextIndex >= state.jobs.length) {
    state.nextRunAt = null;
    await finishBatchDiscovery(state, logger, signal);
    return;
  }

  state.currentJobIndex = nextIndex;
  const nextJob = state.jobs[nextIndex];
  const { cooldownMs, longRest } = cooldownAfterJob(baseCooldownMs(state.config), state.jobsCompleted);
  const cooldownSeconds = Math.round(cooldownMs / 1000);
  state.stage = 'waiting_between_jobs';
  state.nextRunAt = new Date(Date.now() + cooldownMs).toISOString();
  state.message = longRest
    ? `${state.jobsCompleted} searches done — taking a longer ${cooldownSeconds}-second rest to keep a natural pace, then ${describeJob(nextJob)}.`
    : `Job ${nextIndex} of ${state.jobs.length} complete. Next: ${describeJob(nextJob)} in about ${cooldownSeconds} seconds.`;
  await saveRun(state);
  await resumeScheduledJob(state, signal);
}

async function resumeScheduledJob(state, signal) {
  const remaining = Math.max(0, new Date(state.nextRunAt || 0).getTime() - Date.now());
  if (remaining) await delay(remaining, signal);
  if (!(await currentRunActive(signal))) return;
  const latest = await getRun() || state;
  const job = latest.jobs[latest.currentJobIndex];
  if (!job) return;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.baseUnique = (latest.records || []).length;
  latest.stage = 'opening_search';
  latest.nextRunAt = null;
  latest.message = `Opening job ${latest.currentJobIndex + 1} of ${latest.jobs.length}: ${describeJob(job)}…`;
  await saveRun(latest);
  location.assign(searchUrlForJob(latest.config, job.term, latest.resolvedLocation, job.cell));
}

function addAdaptiveRefinements(state, job) {
  if (state.config.location_mode !== 'city' || state.config.coverage_mode !== 'adaptive' || !job.cell) return;
  const threshold = Math.max(10, Number(state.config.saturation_threshold) || 40);
  const maxJobs = Math.max(1, Number(state.config.max_search_jobs) || 100);
  if ((job.discovered || 0) < threshold || (job.cell.depth || 0) >= 2 || state.jobs.length >= maxJobs) return;
  const available = maxJobs - state.jobs.length;
  const children = splitScanCell(job.cell).slice(0, available).map((cell) => ({
    index: 0,
    term: job.term,
    cell,
    status: 'pending',
    discovered: 0,
    added: 0,
    startedAt: null,
    completedAt: null
  }));
  if (!children.length) return;
  state.jobs.splice(state.currentJobIndex + 1, 0, ...children);
  state.jobs.forEach((item, index) => { item.index = index; });
  if (state.scan) state.scan.refinementsAdded = (state.scan.refinementsAdded || 0) + children.length;
}

async function finishBatchDiscovery(state, logger, signal) {
  state.stage = 'filtering';
  state.message = state.config.location_mode === 'city'
    ? 'Merging the city search plan and removing duplicates…'
    : 'Merging all terms and applying the exact radius filter…';
  await saveRun(state);

  const unique = deduplicateRecords(state.records || []);
  const accepted = [];
  for (const record of unique) {
    if (state.config.exclude_sponsored && record.g_is_ad === true) continue;
    if (state.config.location_mode === 'city') {
      if (Number.isFinite(record.g_lat) && Number.isFinite(record.g_lng) &&
          !insideBounds(record.g_lat, record.g_lng, state.coverageBounds, 0.005)) {
        logger.debug('OUTSIDE_CITY_VIEWPORT_SKIPPED', { placeId: record.g_place_id });
        continue;
      }
      record.confidence = extractionConfidence(record);
      accepted.push(record);
      continue;
    }
    const result = isInsideRadius(record, state.config, state.config.radius_tolerance_m || 0);
    if (result.distance === null) {
      state.errors.push({ place_id: record.g_place_id, stage: 'filtering', error: 'MISSING_COORDINATES' });
      logger.warn('MISSING_COORDINATES', { placeId: record.g_place_id });
      continue;
    }
    record.distance_m = Math.round(result.distance * 10) / 10;
    if (result.inside) {
      record.confidence = extractionConfidence(record);
      accepted.push(record);
    } else {
      logger.debug('OUTSIDE_RADIUS_SKIPPED', { placeId: record.g_place_id, distance: result.distance });
    }
  }

  state.records = accepted;
  state.unique = unique.length;
  state.insideRadius = accepted.length;
  state.detailIndex = 0;
  state.detailsCompleted = 0;
  const enrichDetails = state.config.enrich_details === true;
  state.stage = accepted.length && enrichDetails ? 'enriching' : 'complete';
  state.active = accepted.length > 0 && enrichDetails;
  state.detailsCompleted = enrichDetails ? 0 : accepted.length;
  state.message = accepted.length
    ? enrichDetails
      ? `All ${state.jobs.length} jobs complete. Enriching ${accepted.length} unique places once each…`
      : `Complete. ${accepted.length} unique places collected from ${state.jobs.length} scheduled jobs.`
    : 'Complete. The scheduled searches produced no qualifying places.';
  await saveRun(state);
  if (!accepted.length || !enrichDetails || signal.aborted) return;
  await navigateToCurrentDetail(state, signal);
}

function recordNeedsDetail(record) {
  return !record.g_phone || !record.g_address || !record.g_category ||
    !record.g_website || !record.g_image_url;
}

async function navigateToCurrentDetail(state, signal) {
  while (state.detailIndex < state.records.length && !recordNeedsDetail(state.records[state.detailIndex])) {
    state.records[state.detailIndex].confidence = extractionConfidence(state.records[state.detailIndex]);
    state.detailIndex += 1;
    state.detailsCompleted = state.detailIndex;
  }
  if (state.detailIndex >= state.records.length) {
    await completeRun(state);
    return;
  }
  const record = state.records[state.detailIndex];
  if (!record?.g_maps_url) {
    state.errors.push({ place_id: record?.g_place_id, stage: 'detail', error: 'MISSING_MAPS_URL' });
    state.detailIndex += 1;
    state.detailsCompleted = state.detailIndex;
    await saveRun(state);
    await advanceOrComplete(state, signal);
    return;
  }
  await delay(2000, signal);
  location.assign(record.g_maps_url);
}

async function waitForDetailContent(signal) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (document.querySelector('h1') || document.querySelector('script[type="application/ld+json"]')) return true;
    await delay(500, signal);
  }
  return false;
}

async function enrichCurrentPlace(state, logger, signal) {
  state.stage = 'enriching';
  const index = state.detailIndex || 0;
  const record = state.records[index];
  if (!record) {
    await completeRun(state);
    return;
  }

  const hasContent = await waitForDetailContent(signal);
  const key = placeKey(record) || `index:${index}`;
  const attempts = state.detailAttempts?.[key] || 0;
  if (!hasContent && attempts < 1) {
    state.detailAttempts = { ...(state.detailAttempts || {}), [key]: attempts + 1 };
    state.message = `Retrying detail ${index + 1} of ${state.records.length} once…`;
    await saveRun(state);
    location.reload();
    return;
  }

  if (!hasContent) {
    state.errors.push({ place_id: record.g_place_id, stage: 'detail', error: 'DETAIL_TIMEOUT' });
    logger.warn('DETAIL_TIMEOUT', { placeId: record.g_place_id });
  } else {
    let enriched = mergePlaceRecord(record, extractPlaceDOM(document, currentSearchConfig(state)));
    for (const part of extractPlaceEmbeddedState(document, currentSearchConfig(state), logger)) {
      try { enriched = mergePlaceRecord(enriched, part); } catch { /* unrelated LD+JSON */ }
    }
    enriched.verified_at = new Date().toISOString();
    enriched.confidence = extractionConfidence(enriched);
    if (!state.config.include_additional_info) enriched.g_additional_info = null;
    enriched.g_popular_times = null;
    enriched.g_live_busyness_percent = null;
    enriched.g_live_busyness_text = null;
    state.records[index] = enriched;
    logger.debug('RECORD_COMPLETED', { placeId: enriched.g_place_id });
  }

  state.detailIndex = index + 1;
  state.detailsCompleted = state.detailIndex;
  state.message = `Enriched ${state.detailsCompleted} of ${state.records.length} unique places…`;
  await saveRun(state);
  await advanceOrComplete(state, signal);
}

async function advanceOrComplete(state, signal) {
  if (state.detailIndex >= state.records.length) await completeRun(state);
  else await navigateToCurrentDetail(state, signal);
}

async function completeRun(state) {
  state.active = false;
  state.stage = 'complete';
  state.nextRunAt = null;
  state.detailsCompleted = state.records.length;
  state.message = `Complete. ${state.records.length} unique places from ${state.jobs.length} jobs are ready to export.`;
  await saveRun(state);
}
