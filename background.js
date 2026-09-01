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

  if (message?.type === 'STOP_RUN') {
    (async () => {
      const { extractorRun } = await chrome.storage.local.get('extractorRun');
      if (extractorRun) {
        extractorRun.active = false;
        extractorRun.stage = 'stopped';
        extractorRun.nextRunAt = null;
        extractorRun.updatedAt = new Date().toISOString();
        extractorRun.message = 'Stopped by user. Collected results remain exportable.';
        await chrome.storage.local.set({ extractorRun });
      }
      const tabs = await chrome.tabs.query({ url: 'https://www.google.com/maps/*' });
      await Promise.all(tabs.map((tab) => tab.id
        ? chrome.tabs.sendMessage(tab.id, { type: 'STOP_RUN' }).catch(() => undefined)
        : undefined));
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
