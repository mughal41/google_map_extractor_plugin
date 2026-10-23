import {
  cityResolutionUrl, createJobs, normalizeTerms, searchUrlForJob
} from './lib/location.js';

function initialState(rawConfig) {
  const now = new Date().toISOString();
  const terms = normalizeTerms(rawConfig.terms || rawConfig.term);
  const config = {
    ...rawConfig,
    terms,
    term: terms[0] || '',
    coverage_mode: rawConfig.location_mode === 'city' ? (rawConfig.coverage_mode || 'adaptive') : 'radius',
    max_search_jobs: Math.max(1, Number(rawConfig.max_search_jobs) || 100),
    saturation_threshold: Math.max(10, Number(rawConfig.saturation_threshold) || 40)
  };
  const cityMode = config.location_mode === 'city';
  const jobs = createJobs(terms);
  if (!cityMode && jobs[0]) {
    jobs[0].status = 'running';
    jobs[0].startedAt = now;
  }
  return {
    version: 2,
    active: true,
    stage: cityMode ? 'resolving_location' : 'opening_search',
    config,
    resolvedLocation: cityMode ? null : {
      label: `${config.lat}, ${config.lng}`,
      lat: config.lat,
      lng: config.lng,
      zoom: null
    },
    jobs,
    currentJobIndex: cityMode ? -1 : 0,
    jobsCompleted: 0,
    nextRunAt: null,
    records: [],
    errors: [],
    discovered: 0,
    unique: 0,
    insideRadius: 0,
    detailsCompleted: 0,
    detailIndex: 0,
    detailAttempts: {},
    startedAt: now,
    updatedAt: now,
    message: cityMode
      ? `Resolving ${config.city}, ${config.country} in Google Maps…`
      : `Opening job 1 of ${jobs.length}: ${jobs[0]?.term || ''}…`
  };
}

function firstUrl(state) {
  return state.config.location_mode === 'city'
    ? cityResolutionUrl(state.config)
    : searchUrlForJob(state.config, state.jobs[0].term, state.resolvedLocation);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'START_RUN') {
    (async () => {
      const { extractorRun: existing } = await chrome.storage.local.get('extractorRun');
      if (existing?.active) {
        sendResponse({ ok: false, error: 'A run is already active. Stop it before starting a new one.' });
        return;
      }
      const state = initialState(message.config);
      await chrome.storage.local.set({ extractorRun: state });
      const tab = await activeTab();
      const url = firstUrl(state);
      if (tab?.id) await chrome.tabs.update(tab.id, { url });
      else await chrome.tabs.create({ url });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'RESUME_RUN') {
    // Reactivate a run that failed mid-job (for example when storage filled
    // up). The interrupted job restarts from its first result; deduplication
    // absorbs anything it had already collected.
    (async () => {
      const { extractorRun } = await chrome.storage.local.get('extractorRun');
      if (!extractorRun || extractorRun.active) {
        sendResponse({ ok: false, error: extractorRun ? 'The run is already active.' : 'There is no run to resume.' });
        return;
      }
      const job = extractorRun.jobs?.[extractorRun.currentJobIndex];
      if (!job || !extractorRun.resolvedLocation) {
        sendResponse({ ok: false, error: 'This run cannot be resumed. Plan a new run for the remaining terms.' });
        return;
      }
      job.status = 'pending';
      extractorRun.active = true;
      extractorRun.stage = 'waiting_between_jobs';
      extractorRun.nextRunAt = new Date().toISOString();
      extractorRun.updatedAt = extractorRun.nextRunAt;
      extractorRun.message = `Resuming at job ${extractorRun.currentJobIndex + 1} of ${extractorRun.jobs.length}: ${job.term}…`;
      await chrome.storage.local.set({ extractorRun });
      const url = searchUrlForJob(extractorRun.config, job.term, extractorRun.resolvedLocation, job.cell);
      const tab = await activeTab();
      if (tab?.id) await chrome.tabs.update(tab.id, { url });
      else await chrome.tabs.create({ url });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'STOP_RUN') {
    (async () => {
      // Abort the content controller first so no in-flight saveRun can land
      // after the stopped state is written and resurrect a dead run.
      const tabs = await chrome.tabs.query({ url: 'https://www.google.com/maps/*' });
      await Promise.all(tabs.map((tab) => tab.id
        ? chrome.tabs.sendMessage(tab.id, { type: 'STOP_RUN' }).catch(() => undefined)
        : undefined));
      const { extractorRun } = await chrome.storage.local.get('extractorRun');
      if (extractorRun) {
        extractorRun.active = false;
        extractorRun.stage = 'stopped';
        extractorRun.nextRunAt = null;
        extractorRun.updatedAt = new Date().toISOString();
        extractorRun.message = 'Stopped by user. Collected results remain exportable.';
        await chrome.storage.local.set({ extractorRun });
      }
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
