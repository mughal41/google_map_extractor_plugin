import { attachCombobox } from './lib/combobox.js';
import { csvFilename, recordsToCsv } from './lib/csv.js';
import {
  ENRICH_VISITS_PER_JOB_MAX, ENRICH_VISITS_PER_JOB_MIN, estimateRemainingMs, formatClock, planEstimate
} from './lib/estimate.js';
import { COUNTRIES, citiesForCountry } from './lib/geo.js';
import { GLOSSARY } from './lib/glossary.js';
import { normalizeTerms } from './lib/location.js';
import { LONG_REST_MULTIPLIER } from './lib/pacing.js';
import { initPopovers } from './lib/popover.js';
import { MAX_TERMS, TERM_PRESETS } from './lib/presets.js';
import { quip, randomQuip } from './lib/quips.js';

const $ = (id) => document.getElementById(id);
const activeStages = new Set([
  'resolving_location', 'opening_search', 'searching', 'waiting_between_jobs', 'filtering', 'enriching'
]);
const STAGE_LABELS = {
  resolving_location: 'Resolving location',
  opening_search: 'Opening search',
  searching: 'Collecting cards',
  waiting_between_jobs: 'Cooling down',
  filtering: 'Merging results',
  enriching: 'Enriching details',
  complete: 'Complete',
  stopped: 'Stopped',
  error: 'Needs attention',
  idle: 'Idle'
};
const VIEWS = ['plan', 'review', 'run', 'results'];
const TABS = ['plan', 'run', 'results'];

let lastRun = null;
let uiState = { tab: 'plan', view: null };
let lastAnnouncedStage = null;
let clearArmedUntil = 0;
let lastCityCountry = null;
let etaCache = null;
const presetChips = new Map();

/* ---------- formatting ---------- */

function fmtMMSS(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function fmtCountdown(milliseconds) {
  return fmtMMSS(milliseconds);
}

/* ---------- form <-> config ---------- */

function locationMode() {
  return document.querySelector('input[name="location-mode"]:checked')?.value || 'city';
}

function numericValue(id) {
  const value = $(id).value.trim();
  return value === '' ? Number.NaN : Number(value);
}

function termsFromForm() {
  return normalizeTerms($('terms').value);
}

function readConfig() {
  const mode = locationMode();
  const terms = termsFromForm();
  return {
    location_mode: mode,
    country: mode === 'city' ? $('country').value.trim() : '',
    city: mode === 'city' ? $('city').value.trim() : '',
    coverage_mode: mode === 'city' ? $('coverage-mode').value : 'radius',
    max_search_jobs: mode === 'city' ? Number($('max-search-jobs').value) : terms.length,
    saturation_threshold: 40,
    lat: mode === 'coordinates' ? numericValue('latitude') : null,
    lng: mode === 'coordinates' ? numericValue('longitude') : null,
    radius_m: mode === 'coordinates' ? numericValue('radius') : null,
    terms,
    term: terms[0] || '',
    term_delay_ms: Number($('term-delay').value),
    include_popular_times: false,
    include_additional_info: $('additional-info').checked,
    exclude_sponsored: $('exclude-ads').checked,
    enrich_details: $('enrich-details').checked,
    detail_concurrency: 1,
    debug: $('debug').checked,
    radius_tolerance_m: 0
  };
}

function validate(config) {
  if (config.location_mode === 'city') {
    if (!config.country) return 'Enter or select a country.';
    if (!config.city) return 'Enter a city.';
  } else {
    if (!Number.isFinite(config.lat) || config.lat < -90 || config.lat > 90) return 'Enter a valid latitude.';
    if (!Number.isFinite(config.lng) || config.lng < -180 || config.lng > 180) return 'Enter a valid longitude.';
    if (!Number.isFinite(config.radius_m) || config.radius_m < 1 || config.radius_m > 100000) {
      return 'Radius must be between 1 and 100,000 meters.';
    }
  }
  if (!config.terms.length) return 'Add at least one search term.';
  if (config.terms.length > MAX_TERMS) return `Use no more than ${MAX_TERMS} search terms in one run.`;
  if (config.location_mode === 'city' && (!Number.isInteger(config.max_search_jobs) || config.max_search_jobs < 1)) {
    return 'Choose a valid maximum search-job budget.';
  }
  return null;
}

/* ---------- draft persistence ---------- */

function readDraft() {
  return {
    location_mode: locationMode(),
    country: $('country').value,
    city: $('city').value,
    coverage_mode: $('coverage-mode').value,
    max_search_jobs: $('max-search-jobs').value,
    lat: $('latitude').value,
    lng: $('longitude').value,
    radius_m: $('radius').value,
    terms_text: $('terms').value,
    term_delay_ms: $('term-delay').value,
    include_popular_times: false,
    include_additional_info: $('additional-info').checked,
    exclude_sponsored: $('exclude-ads').checked,
    enrich_details: $('enrich-details').checked,
    debug: $('debug').checked,
    saved_at: Date.now()
  };
}

function applyDraft(draft) {
  if (!draft) return;
  const mode = draft.location_mode === 'coordinates' ? 'coordinates' : 'city';
  const radio = document.querySelector(`input[name="location-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  if (draft.country !== undefined) $('country').value = draft.country;
  if (draft.city !== undefined) $('city').value = draft.city;
  if (draft.coverage_mode !== undefined) $('coverage-mode').value = draft.coverage_mode;
  if (draft.max_search_jobs !== undefined) $('max-search-jobs').value = String(draft.max_search_jobs);
  if (draft.lat !== undefined) $('latitude').value = draft.lat;
  if (draft.lng !== undefined) $('longitude').value = draft.lng;
  if (draft.radius_m !== undefined) $('radius').value = draft.radius_m;
  const previousTerms = draft.terms_text || (Array.isArray(draft.terms) ? draft.terms.join('\n') : draft.term);
  if (previousTerms !== undefined) $('terms').value = previousTerms;
  if (draft.term_delay_ms !== undefined) $('term-delay').value = String(draft.term_delay_ms);
  $('popular-times').checked = false;
  $('additional-info').checked = draft.include_additional_info !== false;
  $('exclude-ads').checked = draft.exclude_sponsored !== false;
  $('enrich-details').checked = draft.enrich_details === true;
  $('debug').checked = draft.debug === true;
  syncForm();
}

function persistDraft() {
  const draft = readDraft();
  localStorage.setItem('extractorDraft', JSON.stringify(draft));
  chrome.storage.local.set({ extractorDraft: draft }).catch(() => undefined);
}

function localDraft() {
  try { return JSON.parse(localStorage.getItem('extractorDraft')); } catch { return null; }
}

function persistUi() {
  localStorage.setItem('extractorUi', JSON.stringify(uiState));
  chrome.storage.local.set({ extractorUi: uiState }).catch(() => undefined);
}

function localUi() {
  try { return JSON.parse(localStorage.getItem('extractorUi')) || {}; } catch { return {}; }
}

/* ---------- Pip the compass ---------- */

function mountPips() {
  const template = $('pip-template');
  for (const slot of document.querySelectorAll('.pip')) {
    slot.append(template.content.cloneNode(true));
  }
}

function setPipStage(stage) {
  $('pip-topbar').dataset.stage = stage;
  const runPip = $('pip-run');
  if (runPip) runPip.dataset.stage = stage;
}

function updateCountdownRing(pip, remainingMs, totalMs) {
  const ring = pip.querySelector('.p-ring');
  if (!ring) return;
  if (remainingMs === null || !totalMs) {
    pip.dataset.countdown = '0';
    ring.style.strokeDashoffset = '0';
    return;
  }
  pip.dataset.countdown = '1';
  const fraction = Math.min(1, Math.max(0, remainingMs / totalMs));
  ring.style.strokeDashoffset = String(Math.round((1 - fraction) * 100));
}

/* ---------- view routing ---------- */

function showView(name, { focus = false, persist = true } = {}) {
  if (!VIEWS.includes(name)) name = 'plan';
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  const tab = name === 'review' ? 'plan' : name;
  for (const t of TABS) {
    const button = $(`tab-${t}`);
    const selected = t === tab;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
  uiState = { ...uiState, tab, view: name === 'review' ? 'review' : null };
  if (persist) persistUi();
  if (name === 'review') renderReview();
  if (focus) $(`view-${name}`).focus({ preventScroll: true });
}

function routeOnLoad(run) {
  if (run?.active) return 'run';
  if (uiState.view === 'review') return 'review';
  if (run?.records?.length && (run.stage === 'complete' || run.stage === 'stopped' || run.stage === 'error')) return 'results';
  if (uiState.tab && TABS.includes(uiState.tab)) return uiState.tab;
  return 'plan';
}

/* ---------- plan rail ---------- */

function areaText() {
  if (locationMode() === 'city') {
    const city = $('city').value.trim();
    const country = $('country').value.trim();
    return city || country ? [city, country].filter(Boolean).join(', ') : '—';
  }
  const lat = $('latitude').value.trim();
  const lng = $('longitude').value.trim();
  return lat && lng ? `${lat}, ${lng} · ${$('radius').value || 0} m` : '—';
}

function setupGeoSuggestions() {
  attachCombobox($('country'), () => COUNTRIES);
  attachCombobox($('city'), () => citiesForCountry($('country').value));
}

function syncCityHint() {
  const country = $('country').value.trim();
  if (country === lastCityCountry) return;
  lastCityCountry = country;
  const cities = citiesForCountry(country);
  $('city-hint').textContent = cities.length
    ? `Suggesting ${cities.length} major cities for ${country} — any other city name works too.`
    : 'All countries are suggested as you type. Pick one and major cities are suggested too — any city name works.';
}

function updatePresetChips() {
  const existing = new Set($('terms').value.split(/\n+/).map((line) => line.trim()).filter(Boolean));
  for (const [preset, button] of presetChips) {
    const active = preset.terms.every((term) => existing.has(term));
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.textContent = `${active ? '✓' : '+'} ${preset.label} (${preset.terms.length})`;
  }
}

const RISK_COPY = {
  low: { label: 'Low risk', text: 'A comfortable pace, well inside what Maps tolerates.' },
  elevated: { label: 'Elevated risk', text: 'Over 60 searches raises the odds Maps slows you down. Lower the job budget or switch to City search.' },
  high: { label: 'High risk', text: 'Beyond ~120 searches is CAPTCHA territory. Lower the job budget, or split this plan across sessions or days.' }
};

function updateRail() {
  const config = readConfig();
  const estimate = planEstimate(config);
  $('rail-area').textContent = areaText();
  $('rail-area').title = $('rail-area').textContent;
  $('rail-jobs').textContent = estimate.jobs
    ? `${estimate.jobs}${estimate.ceiling > estimate.jobs ? ` (≤ ${estimate.ceiling})` : ''}`
    : '—';
  $('rail-cooldown').textContent = `${Math.round((config.term_delay_ms || 30000) / 1000)} s + jitter`;
  $('rail-duration').textContent = estimate.jobs ? `~${formatClock(estimate.typicalMs)}` : '—';
  $('rail-range').textContent = estimate.jobs
    ? `${formatClock(estimate.minMs)} – ${formatClock(estimate.maxMs)} with jitter`
    : 'Add search terms to see the estimate.';
  const pill = $('rail-risk');
  if (estimate.jobs && estimate.risk !== 'low') {
    pill.hidden = false;
    pill.dataset.risk = estimate.risk;
    pill.textContent = `${RISK_COPY[estimate.risk].label}: up to ${estimate.ceiling} searches. ${RISK_COPY[estimate.risk].text}`;
  } else {
    pill.hidden = true;
  }
  $('term-count').childNodes[0].textContent = `${config.terms.length} / ${MAX_TERMS} terms `;
  $('term-count').classList.toggle('at-limit', config.terms.length >= MAX_TERMS);
  updatePresetChips();
  const area = areaText();
  $('plan-quip').textContent = estimate.jobs && estimate.risk === 'high'
    ? quip('risk_high', {}, String(estimate.ceiling))
    : config.terms.length
      ? quip('plan_ready', { terms: config.terms.length, area: area === '—' ? 'the map' : area }, `${config.terms.length}:${area}`)
      : quip('plan_empty', {}, String(new Date().getHours()));
}

function speak(id, text) {
  const bubble = $(id);
  if (!bubble || !text) return;
  bubble.textContent = text;
  bubble.classList.remove('pop');
  void bubble.offsetWidth;
  bubble.classList.add('pop');
}

function syncForm() {
  const cityMode = locationMode() === 'city';
  $('city-fields').hidden = !cityMode;
  $('coordinate-fields').hidden = cityMode;
  for (const input of $('city-fields').querySelectorAll('input, select')) input.disabled = !cityMode;
  for (const input of $('coordinate-fields').querySelectorAll('input')) input.disabled = cityMode;
  const strategyInfo = $('strategy-info');
  const strategyKey = `coverage-${$('coverage-mode').value}`;
  if (strategyInfo.dataset.info !== strategyKey && GLOSSARY[strategyKey]) {
    strategyInfo.dataset.info = strategyKey;
    strategyInfo.setAttribute('aria-label', `About: ${GLOSSARY[strategyKey].title}`);
  }
  syncCityHint();
  updateRail();
}

/* ---------- review (estimate & confirm) ---------- */

function receiptRow({ label, note, value, cls }) {
  const row = document.createElement('p');
  row.className = `receipt-row${cls ? ` ${cls}` : ''}`;
  const left = document.createElement('span');
  left.textContent = label;
  if (note) {
    const small = document.createElement('span');
    small.className = 'row-note';
    small.textContent = ` ${note}`;
    left.append(small);
  }
  const leader = document.createElement('i');
  const right = document.createElement('span');
  right.className = 'mono';
  right.textContent = value;
  row.append(left, leader, right);
  return row;
}

function renderReview() {
  const config = readConfig();
  const estimate = planEstimate(config);
  const base = Math.max(5000, Number(config.term_delay_ms) || 30000);
  const gaps = Math.max(0, estimate.jobs - 1);
  const rests = Math.floor(gaps / 8);

  $('review-title').textContent = config.location_mode === 'city'
    ? [config.city, config.country].filter(Boolean).join(', ') || 'City plan'
    : `${config.lat}, ${config.lng} · ${config.radius_m} m radius`;
  const strategy = { city: 'City search', grid: 'Grid scan', adaptive: 'Adaptive scan', radius: 'Radius search' }[config.coverage_mode] || config.coverage_mode;
  $('review-sub').textContent = config.location_mode === 'city'
    ? `${strategy} · ${estimate.termCount} terms · ${estimate.dimension > 1 ? `${estimate.dimension}×${estimate.dimension} cells per term` : 'one search per term'}`
    : `${strategy} · ${estimate.termCount} terms · one search per term`;

  $('est-hero').textContent = `~${formatClock(estimate.typicalMs)}`;
  $('est-range').textContent = `${formatClock(estimate.minMs)} – ${formatClock(estimate.maxMs)} with jitter`;
  const finish = new Date(Date.now() + estimate.typicalMs);
  $('est-finish').textContent = `Done around ${finish.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · cooldowns are deliberately randomized, so the total is a range, not a promise.`;

  const rows = $('receipt-rows');
  rows.innerHTML = '';
  rows.append(receiptRow({
    label: 'Searches', note: `${estimate.jobs} × 30–70 s`,
    value: `${fmtMMSS(estimate.searchMinMs)}–${fmtMMSS(estimate.searchMaxMs)}`
  }));
  rows.append(receiptRow({
    label: 'Cooldowns', note: `${gaps} × ${Math.round(base / 1000)} s + jitter`,
    value: `${fmtMMSS(estimate.cooldownMinMs)}–${fmtMMSS(estimate.cooldownMaxMs)}`
  }));
  if (rests > 0) {
    rows.append(receiptRow({
      label: 'Rest breaks', note: `every 8 searches, ${rests} × ${fmtMMSS(base * LONG_REST_MULTIPLIER)}`,
      value: fmtMMSS(estimate.restMs)
    }));
  }
  if (estimate.ceiling > estimate.jobs) {
    rows.append(receiptRow({
      label: 'Adaptive refinements', note: 'dense areas only · can extend the total', value: `≤ ${estimate.ceiling} jobs`, cls: 'open-ended'
    }));
  }
  if (estimate.enrichment) {
    rows.append(receiptRow({
      label: 'Enrichment',
      note: `after collection · assumes ${ENRICH_VISITS_PER_JOB_MIN}–${ENRICH_VISITS_PER_JOB_MAX} visits per search`,
      value: `${fmtMMSS(estimate.enrichMinMs)}–${fmtMMSS(estimate.enrichMaxMs)}`,
      cls: 'open-ended'
    }));
  }
  rows.append(receiptRow({
    label: 'Estimated total', value: `${formatClock(estimate.minMs)} – ${formatClock(estimate.maxMs)}`, cls: 'total'
  }));

  $('risk-meter').dataset.risk = estimate.risk;
  $('risk-label').textContent = RISK_COPY[estimate.risk].label;
  $('risk-text').textContent = ` ${RISK_COPY[estimate.risk].text}`;
  const action = $('risk-action');
  action.hidden = !(estimate.risk !== 'low' && config.location_mode === 'city' && Number($('max-search-jobs').value) > 50);

  $('itinerary-summary').textContent = `Itinerary · ${estimate.termCount} terms in order`;
  const list = $('itinerary-list');
  list.innerHTML = '';
  for (const term of config.terms) {
    const item = document.createElement('li');
    item.textContent = term;
    list.append(item);
  }

  $('review-quip').textContent = quip('review', {
    time: formatClock(estimate.typicalMs), jobs: estimate.jobs
  }, `${estimate.jobs}:${estimate.typicalMs}`);

  $('confirm-start').textContent = `Confirm & start · ~${formatClock(estimate.typicalMs)}`;
  $('confirm-start').disabled = Boolean(lastRun?.active);
  $('confirm-error').textContent = '';
}

/* ---------- run view ---------- */

function nextActionText(state) {
  if (state?.nextRunAt) {
    const remaining = new Date(state.nextRunAt).getTime() - Date.now();
    return remaining > 0 ? `Next search in ${fmtCountdown(remaining)}` : 'Opening next search…';
  }
  if (state?.stage === 'resolving_location') return 'Waiting for Maps center and zoom';
  if (state?.stage === 'enriching') return `Detail ${Math.min((state.detailIndex || 0) + 1, state.records?.length || 0)} of ${state.records?.length || 0}`;
  if (state?.stage === 'complete') return 'Merged CSV is ready';
  return state?.active ? 'Working in one Maps tab' : '—';
}

function resolvedAreaText(state) {
  const location = state?.resolvedLocation;
  if (!location) return state?.config?.location_mode === 'city' ? 'Resolving in Maps…' : 'Waiting…';
  const coordinates = Number.isFinite(location.lat) && Number.isFinite(location.lng)
    ? ` · ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : '';
  return `${location.label || 'Resolved'}${coordinates}`;
}

function renderRun(state) {
  const hasRun = Boolean(state);
  $('run-empty').hidden = hasRun;
  $('run-live').hidden = !hasRun;
  if (!hasRun) return;

  const stage = state.stage || 'idle';
  const jobs = state.jobs || [];
  const currentJob = jobs[state.currentJobIndex] || null;
  const completeJobs = state.jobsCompleted ?? jobs.filter((job) => job.status === 'complete').length;
  const active = activeStages.has(stage) && state.active;

  $('stage').textContent = STAGE_LABELS[stage] || stage.replaceAll('_', ' ');
  $('job-badge').hidden = jobs.length === 0;
  $('job-badge').textContent = `${completeJobs} / ${jobs.length}`;
  $('next-action-line').textContent = nextActionText(state);
  $('message').textContent = state.message || '';

  const percent = jobs.length ? Math.round((completeJobs / jobs.length) * 100) : 0;
  $('progress-bar').style.width = `${percent}%`;
  const progress = $('progress');
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', `Job ${Math.min(completeJobs + 1, jobs.length)} of ${jobs.length}`);

  $('resolved-area').textContent = resolvedAreaText(state);
  $('resolved-area').title = $('resolved-area').textContent;
  $('current-term').textContent = currentJob
    ? `${state.currentJobIndex + 1}. ${currentJob.term}${currentJob.cell ? ` · ${currentJob.cell.label}` : ''}`
    : 'Preparing queue…';
  $('current-term').title = $('current-term').textContent;
  $('next-action').textContent = nextActionText(state);
  $('scan-info').textContent = state.scan
    ? `${state.scan.mode} · +${state.scan.refinementsAdded || 0} refinements · max ${state.scan.maxJobs}`
    : state.config?.coverage_mode || '—';

  $('discovered').textContent = state.discovered ?? 0;
  $('unique').textContent = state.unique ?? 0;
  $('inside').textContent = state.insideRadius ?? 0;
  $('jobs').textContent = `${completeJobs} / ${jobs.length}`;
  const errorCount = state.errors?.length ?? 0;
  $('errors').textContent = errorCount;
  $('errors').classList.toggle('has-errors', errorCount > 0);
  $('coverage-label').textContent = state.config?.location_mode === 'coordinates' ? 'In radius' : 'Accepted';
  $('stop').disabled = !active;
  const gotoResults = $('run-goto-results');
  gotoResults.hidden = !(stage === 'error' && state.records?.length);
  if (!gotoResults.hidden) gotoResults.textContent = `View ${state.records.length} collected places →`;

  etaCache = { value: estimateRemainingMs(state), at: Date.now() };
  renderEtaLine();
  const QUIP_STAGES = {
    searching: 'searching', waiting_between_jobs: 'waiting', resolving_location: 'resolving',
    opening_search: 'resolving', filtering: 'filtering', enriching: 'enriching', error: 'error'
  };
  const quipContext = QUIP_STAGES[stage];
  $('run-quip').hidden = !quipContext;
  if (quipContext) {
    $('run-quip').textContent = quip(quipContext, { term: currentJob?.term || 'places' }, `${stage}:${completeJobs}`);
  }
}

/* ---------- results view ---------- */

function aggregateTerms(state) {
  const byTerm = new Map();
  for (const job of state.jobs || []) {
    byTerm.set(job.term, (byTerm.get(job.term) || 0) + (job.added || 0));
  }
  return [...byTerm.entries()].filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function renderResults(state) {
  const hasRecords = Boolean(state?.records?.length);
  $('results-empty').hidden = hasRecords;
  $('results-live').hidden = !hasRecords;
  $('results-badge').hidden = !hasRecords;
  if (hasRecords) $('results-badge').textContent = String(state.records.length);
  if (!hasRecords) return;

  const stage = state.stage || 'idle';
  const finished = stage === 'complete' || stage === 'stopped' || stage === 'error';
  $('pip-results').dataset.stage = stage === 'complete' ? 'complete' : stage === 'error' ? 'error' : finished ? 'stopped' : 'searching';
  $('results-headline').textContent = stage === 'complete' ? 'Run complete'
    : stage === 'stopped' ? 'Run stopped'
    : stage === 'error' ? 'Run interrupted'
    : 'Run in progress';

  const jobsDone = state.jobsCompleted ?? 0;
  const errorCount = state.errors?.length ?? 0;
  $('results-sub').textContent = `${state.records.length} unique places from ${jobsDone} searches · ${errorCount} error${errorCount === 1 ? '' : 's'}${finished ? '' : ' · still collecting'}`;
  $('results-quip').textContent = stage === 'complete'
    ? quip('complete', { count: state.records.length }, String(state.records.length))
    : stage === 'stopped' ? quip('stopped', {}, String(jobsDone))
    : stage === 'error' ? quip('error', {}, String(jobsDone))
    : '';

  const discovered = state.discovered ?? 0;
  const uniqueMerged = state.unique ?? state.records.length;
  const sponsored = state.sponsoredExcluded ?? 0;
  const noCoords = state.missingCoordinates ?? 0;
  $('oc-cards').textContent = String(discovered);
  $('oc-dupes').textContent = String(Math.max(0, discovered - uniqueMerged));
  $('oc-sponsored-row').hidden = sponsored === 0;
  $('oc-sponsored').textContent = String(sponsored);
  $('oc-nocoords-row').hidden = noCoords === 0;
  $('oc-nocoords').textContent = String(noCoords);
  $('oc-outside').textContent = String(Math.max(0, uniqueMerged - state.records.length - sponsored - noCoords));
  $('oc-unique').textContent = String(state.records.length);

  const bars = $('term-bars');
  bars.innerHTML = '';
  const top = aggregateTerms(state);
  const max = top[0]?.[1] || 1;
  for (const [term, count] of top) {
    const row = document.createElement('div');
    row.className = 'term-bar';
    const label = document.createElement('span');
    label.className = 'tb-label';
    label.textContent = term;
    label.title = term;
    const track = document.createElement('span');
    track.className = 'tb-track';
    const fill = document.createElement('span');
    fill.className = 'tb-fill';
    fill.style.width = `${Math.max(4, Math.round((count / max) * 100))}%`;
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'tb-count';
    value.textContent = String(count);
    row.append(label, track, value);
    bars.append(row);
  }
  $('term-bars-block').hidden = top.length === 0;

  $('export-label').textContent = `Export CSV · ${state.records.length} rows`;
  $('export').disabled = !state.records.length;
}

/* ---------- global render ---------- */

function announce(state) {
  const stage = state?.stage || 'idle';
  if (stage === lastAnnouncedStage) return;
  lastAnnouncedStage = stage;
  if (stage === 'error') {
    $('live-alert').textContent = state?.message || 'The run hit an error.';
  } else if (stage !== 'idle') {
    $('live-status').textContent = `${STAGE_LABELS[stage] || stage}. ${state?.message || ''}`;
  }
}

function renderAll(state) {
  const wasActive = lastRun?.active;
  lastRun = state || null;
  const stage = state?.active ? state.stage : (state?.stage === 'complete' || state?.stage === 'stopped' || state?.stage === 'error') ? state.stage : 'idle';
  setPipStage(stage || 'idle');
  $('run-dot').hidden = !state?.active;
  $('review-btn').disabled = Boolean(state?.active);
  renderRun(state);
  renderResults(state);
  announce(state);
  tickCountdown();
  if (wasActive && !state?.active && state?.stage === 'complete' && !$('view-run').hidden) {
    showView('results', { focus: true });
  }
}

/* ---------- countdown ---------- */

function renderEtaLine() {
  const line = $('eta-line');
  if (!lastRun?.active || !etaCache || !Number.isFinite(etaCache.value)) {
    line.hidden = true;
    return;
  }
  const left = Math.max(0, etaCache.value - (Date.now() - etaCache.at));
  line.hidden = false;
  line.textContent = left > 45000 ? `~${formatClock(left)} left` : 'Wrapping up soon…';
}

function tickCountdown() {
  renderEtaLine();
  const pips = [$('pip-topbar'), $('pip-run')].filter(Boolean);
  if (lastRun?.nextRunAt && lastRun.stage === 'waiting_between_jobs') {
    const remaining = new Date(lastRun.nextRunAt).getTime() - Date.now();
    if (remaining > 0) {
      const total = Number(lastRun.cooldownTotalMs) || null;
      $('next-action-line').textContent = `Next search in ${fmtCountdown(remaining)} · pace randomized on purpose`;
      $('next-action').textContent = `Next search in ${fmtCountdown(remaining)}`;
      for (const pip of pips) updateCountdownRing(pip, remaining, total);
      return;
    }
    $('next-action-line').textContent = 'Opening next search…';
    $('next-action').textContent = 'Opening next search…';
  }
  for (const pip of pips) updateCountdownRing(pip, null, null);
}

/* ---------- events ---------- */

function togglePresetTerms(preset) {
  const existing = $('terms').value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const existingSet = new Set(existing);
  const isActive = preset.terms.every((term) => existingSet.has(term));
  if (isActive) {
    const drop = new Set(preset.terms);
    $('terms').value = existing.filter((term) => !drop.has(term)).join('\n');
    $('form-error').textContent = '';
    $('live-status').textContent = `${preset.label} preset removed. ${normalizeTerms($('terms').value).length} of ${MAX_TERMS} terms.`;
    syncForm();
    persistDraft();
    speak('plan-quip', randomQuip('preset_remove', { label: preset.label }));
    return;
  }
  {
    const merged = [...new Set([...existing, ...preset.terms])];
    $('terms').value = merged.slice(0, MAX_TERMS).join('\n');
    $('form-error').textContent = merged.length > MAX_TERMS
      ? `Kept the first ${MAX_TERMS} terms — one run is capped at ${MAX_TERMS} searches to stay under Google's rate limits. Save the rest for a second plan.`
      : '';
    $('live-status').textContent = `${preset.label} preset added. ${normalizeTerms($('terms').value).length} of ${MAX_TERMS} terms.`;
  }
  syncForm();
  persistDraft();
  speak('plan-quip', randomQuip('preset_add', { label: preset.label }));
}

/* ---------- Pip's theater ---------- */

const PIP_MOODS = ['mood-bounce', 'mood-twitch', 'mood-peek', 'mood-spin'];
const CALM_STAGES = new Set(['idle', 'complete', 'stopped']);

function visiblePips() {
  return [...document.querySelectorAll('.pip')].filter((pip) =>
    !pip.closest('[hidden]') && CALM_STAGES.has(pip.dataset.stage || 'idle'));
}

function playMood(pip, mood) {
  pip.classList.remove(...PIP_MOODS);
  void pip.offsetWidth;
  pip.classList.add(mood);
  setTimeout(() => pip.classList.remove(mood), 1500);
}

function rotateQuips() {
  if (!$('view-plan').hidden) {
    const terms = termsFromForm();
    if (terms.length) {
      const area = areaText();
      speak('plan-quip', randomQuip('plan_ready', { terms: terms.length, area: area === '—' ? 'the map' : area }));
    } else {
      speak('plan-quip', randomQuip('plan_empty'));
    }
  }
  if (!$('view-run').hidden && lastRun?.active) {
    const contexts = {
      searching: 'searching', waiting_between_jobs: 'waiting', resolving_location: 'resolving',
      opening_search: 'resolving', filtering: 'filtering', enriching: 'enriching'
    };
    const context = contexts[lastRun.stage];
    if (context) {
      const term = lastRun.jobs?.[lastRun.currentJobIndex]?.term || 'places';
      speak('run-quip', randomQuip(context, { term }));
    }
  }
}

function startPipTheater() {
  document.addEventListener('click', (event) => {
    const pip = event.target.closest?.('.pip');
    if (!pip) return;
    playMood(pip, 'mood-spin');
    const bubbleId = ['plan-quip', 'run-quip', 'review-quip', 'results-quip']
      .find((id) => { const el = $(id); return el && !el.closest('[hidden]'); });
    if (bubbleId) speak(bubbleId, randomQuip('pip_poke'));
  });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(() => {
    if (document.hidden || Math.random() < 0.4) return;
    const pips = visiblePips();
    if (!pips.length) return;
    const pip = pips[Math.floor(Math.random() * pips.length)];
    playMood(pip, PIP_MOODS[Math.floor(Math.random() * PIP_MOODS.length)]);
  }, 7000);
  setInterval(rotateQuips, 15000);
}

function setupPlanEvents() {
  for (const preset of TERM_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = `+ ${preset.label} (${preset.terms.length})`;
    button.title = `${preset.description} Click again to remove these terms.`;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => togglePresetTerms(preset));
    presetChips.set(preset, button);
    $('preset-row').append(button);
  }

  $('search-form').addEventListener('input', () => { syncForm(); persistDraft(); });
  $('search-form').addEventListener('change', () => { syncForm(); persistDraft(); });
  window.addEventListener('pagehide', persistDraft);

  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const config = readConfig();
    const error = validate(config);
    $('form-error').textContent = error || '';
    if (error) return;
    persistDraft();
    showView('review', { focus: true });
  });
}

function setupReviewEvents() {
  $('review-back').addEventListener('click', () => showView('plan', { focus: true }));
  $('risk-action').addEventListener('click', () => {
    $('max-search-jobs').value = '50';
    persistDraft();
    updateRail();
    renderReview();
  });
  $('confirm-start').addEventListener('click', async () => {
    const config = readConfig();
    const error = validate(config);
    if (error) { $('confirm-error').textContent = error; return; }
    $('confirm-start').disabled = true;
    const response = await chrome.runtime.sendMessage({ type: 'START_RUN', config }).catch((err) => ({ ok: false, error: err.message }));
    if (!response?.ok) {
      $('confirm-error').textContent = response?.error || 'Could not start the run.';
      $('confirm-start').disabled = Boolean(lastRun?.active);
      return;
    }
    showView('run', { focus: true });
  });
}

function setupRunEvents() {
  $('run-goto-plan').addEventListener('click', () => showView('plan', { focus: true }));
  $('run-goto-results').addEventListener('click', () => showView('results', { focus: true }));
  $('stop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_RUN' }).catch(() => undefined);
  });
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function setupResultsEvents() {
  $('results-goto-plan').addEventListener('click', () => showView('plan', { focus: true }));
  $('plan-again').addEventListener('click', () => showView('plan', { focus: true }));

  $('export').addEventListener('click', async () => {
    if (!lastRun?.records?.length) return;
    $('results-error').textContent = '';
    const csv = recordsToCsv(lastRun.records);
    const dataUrl = `data:text/csv;charset=utf-8;base64,${toBase64(csv)}`;
    const response = await chrome.runtime.sendMessage({
      type: 'DOWNLOAD_CSV', dataUrl, filename: csvFilename(lastRun.config)
    }).catch((error) => ({ ok: false, error: error.message }));
    if (response?.ok) {
      const count = lastRun.records.length;
      $('export').classList.add('saved');
      $('export-label').textContent = `Saved ${count} places ✓`;
      setTimeout(() => {
        $('export').classList.remove('saved');
        $('export-label').textContent = `Export CSV · ${lastRun?.records?.length || count} rows`;
      }, 1800);
    } else {
      const message = response?.error || 'Export failed.';
      $('results-error').textContent = message;
      $('live-alert').textContent = message;
    }
  });

  $('clear').addEventListener('click', async () => {
    if (lastRun?.active) {
      $('results-error').textContent = 'Stop the active run before clearing its results.';
      $('live-alert').textContent = 'Stop the active run before clearing its results.';
      return;
    }
    $('results-error').textContent = '';
    const count = lastRun?.records?.length || 0;
    if (Date.now() > clearArmedUntil) {
      clearArmedUntil = Date.now() + 5000;
      $('clear').classList.add('confirming');
      $('clear').textContent = `Delete ${count} places? Click again`;
      setTimeout(() => {
        if (Date.now() >= clearArmedUntil) {
          $('clear').classList.remove('confirming');
          $('clear').textContent = 'Clear results';
        }
      }, 5200);
      return;
    }
    clearArmedUntil = 0;
    $('clear').classList.remove('confirming');
    $('clear').textContent = 'Clear results';
    await chrome.storage.local.remove('extractorRun');
    renderAll(null);
    showView('plan');
  });
}

function setupTabs() {
  for (const t of TABS) {
    $(`tab-${t}`).addEventListener('click', () => showView(t, { focus: true }));
  }
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = TABS.indexOf(uiState.tab || 'plan');
    let next = current;
    if (event.key === 'ArrowLeft') next = (current + TABS.length - 1) % TABS.length;
    if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = TABS.length - 1;
    $(`tab-${TABS[next]}`).focus();
    showView(TABS[next]);
  });
}

/* ---------- boot ---------- */

mountPips();
initPopovers();
setupGeoSuggestions();
setupPlanEvents();
setupReviewEvents();
setupRunEvents();
setupResultsEvents();
setupTabs();
startPipTheater();

const hadLocalUi = Boolean(localStorage.getItem('extractorUi'));
uiState = { tab: 'plan', view: null, ...localUi() };
applyDraft(localDraft());
if (!$('terms').value.trim()) $('terms').value = 'restaurants\npharmacies\nbanks\nhotels';
syncForm();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extractorRun) renderAll(changes.extractorRun.newValue);
});

chrome.storage.local.get(['extractorDraft', 'extractorRun', 'extractorUi']).then((stored) => {
  const immediate = localDraft();
  if (!immediate || (stored.extractorDraft?.saved_at || 0) > (immediate.saved_at || 0)) {
    applyDraft(stored.extractorDraft);
  }
  if (stored.extractorUi && !hadLocalUi) {
    uiState = { tab: 'plan', view: null, ...stored.extractorUi };
  }
  renderAll(stored.extractorRun);
  showView(routeOnLoad(stored.extractorRun), { persist: false });
}).catch((error) => { $('form-error').textContent = error.message; });

renderAll(null);
showView(routeOnLoad(null), { persist: false });

setInterval(tickCountdown, 1000);
