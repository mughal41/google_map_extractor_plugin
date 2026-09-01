import { csvFilename, recordsToCsv } from './lib/csv.js';
import { normalizeTerms } from './lib/location.js';
import { estimatedCooldownTotalMs } from './lib/pacing.js';
import { MAX_TERMS, TERM_PRESETS } from './lib/presets.js';

const $ = (id) => document.getElementById(id);
const activeStages = new Set([
  'resolving_location', 'opening_search', 'searching', 'waiting_between_jobs', 'filtering', 'enriching'
]);
const STAGE_LABELS = {
  resolving_location: 'Resolving location',
  opening_search: 'Opening search',
  searching: 'Collecting cards',
  waiting_between_jobs: 'Scheduled cooldown',
  filtering: 'Merging results',
  enriching: 'Enriching details',
  complete: 'Complete',
  stopped: 'Stopped',
  error: 'Needs attention',
  idle: 'Idle'
};
let lastState = null;

function numericValue(id) {
  const value = $(id).value.trim();
  return value === '' ? Number.NaN : Number(value);
}

function locationMode() {
  return document.querySelector('input[name="location-mode"]:checked')?.value || 'city';
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

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function updatePlanWarning(plannedJobs, ceiling) {
  const warning = $('plan-warning');
  const worst = Math.max(plannedJobs, ceiling || 0);
  if (worst > 120) {
    warning.textContent = `This plan can reach ${worst} searches in one sitting, which is the range where Google starts showing CAPTCHAs. Split it: run the Core preset today and the remaining terms as a separate plan tomorrow, or lower the job budget.`;
  } else if (worst > 60) {
    warning.textContent = `Heads up: up to ${worst} searches in one run. That is usually fine at the recommended cooldown, but if Maps shows a CAPTCHA, finish it manually and continue with smaller plans spread over the day.`;
  } else {
    warning.textContent = '';
  }
  warning.hidden = !warning.textContent;
}

function updatePlanSummary() {
  const terms = termsFromForm();
  const delay = Number($('term-delay').value) || 30000;
  $('term-count').textContent = `${terms.length} / ${MAX_TERMS} terms`;
  $('term-count').classList.toggle('at-limit', terms.length >= MAX_TERMS);
  if (!terms.length) {
    $('plan-summary').textContent = 'Add search terms to calculate the run plan.';
    updatePlanWarning(0, 0);
    return;
  }
  const cityMode = locationMode() === 'city';
  if (!cityMode) {
    const cooldown = estimatedCooldownTotalMs(terms.length, delay);
    const baseline = terms.length * 45000 + cooldown;
    $('plan-summary').textContent = `${terms.length} radius-filtered searches, one per term · about ${formatDuration(baseline)} total including randomized cooldowns, before optional detail visits.`;
    updatePlanWarning(terms.length, terms.length);
    return;
  }
  const coverage = $('coverage-mode').value;
  const budget = Number($('max-search-jobs').value) || 100;
  const cellsBudget = Math.max(1, Math.floor(budget / terms.length));
  const dimension = coverage === 'city' ? 1 : cellsBudget >= 9 ? 3 : cellsBudget >= 4 ? 2 : 1;
  const initialJobs = Math.min(budget, terms.length * dimension * dimension);
  const cooldown = estimatedCooldownTotalMs(initialJobs, delay);
  const baseline = initialJobs * 45000 + cooldown;
  const shape = dimension === 1 ? 'one search per term' : `${dimension}×${dimension} map cells per term`;
  const refinement = coverage === 'adaptive' ? ` Dense areas may add refinements up to the ${budget}-job ceiling.` : '';
  $('plan-summary').textContent = `${initialJobs} initial searches (${shape}) · about ${formatDuration(baseline)} including randomized cooldowns and rest breaks.${refinement}`;
  updatePlanWarning(initialJobs, coverage === 'adaptive' ? budget : initialJobs);
}

function syncForm() {
  const cityMode = locationMode() === 'city';
  $('city-fields').hidden = !cityMode;
  $('coordinate-fields').hidden = cityMode;
  for (const input of $('city-fields').querySelectorAll('input')) input.disabled = !cityMode;
  for (const input of $('coordinate-fields').querySelectorAll('input')) input.disabled = cityMode;
  updatePlanSummary();
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

function resolvedAreaText(state) {
  const location = state?.resolvedLocation;
  if (!location) return state?.config?.location_mode === 'city' ? 'Resolving in Maps…' : 'Waiting…';
  const coordinates = Number.isFinite(location.lat) && Number.isFinite(location.lng)
    ? ` · ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : '';
  const zoom = Number.isFinite(location.zoom) ? ` · ${location.zoom}z` : '';
  return `${location.label || 'Resolved'}${coordinates}${zoom}`;
}

function nextActionText(state) {
  if (state?.nextRunAt) {
    const remaining = new Date(state.nextRunAt).getTime() - Date.now();
    return remaining > 0 ? `Next search in ${formatDuration(remaining)}` : 'Opening next search…';
  }
  if (state?.stage === 'resolving_location') return 'Waiting for Maps center and zoom';
  if (state?.stage === 'enriching') return `Detail ${Math.min((state.detailIndex || 0) + 1, state.records?.length || 0)} of ${state.records?.length || 0}`;
  if (state?.stage === 'complete') return 'Merged CSV is ready';
  return state?.active ? 'Working in one Maps tab' : '—';
}

function render(state) {
  lastState = state || null;
  const stage = state?.stage || 'idle';
  const jobs = state?.jobs || [];
  const currentJob = jobs[state?.currentJobIndex] || null;
  const completeJobs = state?.jobsCompleted ?? jobs.filter((job) => job.status === 'complete').length;
  const active = activeStages.has(stage) && state?.active;
  $('stage').textContent = STAGE_LABELS[stage] || stage.replaceAll('_', ' ');
  $('message').textContent = state?.message || 'Ready to build a search plan.';
  $('discovered').textContent = state?.discovered ?? 0;
  $('unique').textContent = state?.unique ?? 0;
  $('inside').textContent = state?.insideRadius ?? 0;
  $('jobs').textContent = `${completeJobs} / ${jobs.length}`;
  $('errors').textContent = state?.errors?.length ?? 0;
  $('coverage-label').textContent = state?.config?.location_mode === 'coordinates' ? 'Inside radius' : 'Accepted';
  $('stage-dot').className = active ? 'active' : stage === 'error' ? 'error' : '';
  $('stop').disabled = !active;
  $('start').disabled = active;
  $('export').disabled = !state?.records?.length;
  $('run-plan').hidden = jobs.length === 0;
  $('job-badge').hidden = jobs.length === 0;
  $('job-badge').textContent = `${completeJobs} / ${jobs.length} jobs`;
  $('resolved-area').textContent = resolvedAreaText(state);
  $('current-term').textContent = currentJob
    ? `${state.currentJobIndex + 1}. ${currentJob.term}${currentJob.cell ? ` · ${currentJob.cell.label} · ${currentJob.cell.zoom}z` : ''}`
    : 'Preparing queue…';
  $('next-action').textContent = nextActionText(state);
  $('scan-info').textContent = state?.scan
    ? `${state.scan.mode} · +${state.scan.refinementsAdded || 0} refinements · max ${state.scan.maxJobs}`
    : state?.config?.coverage_mode || '—';
  $('progress-bar').style.width = jobs.length ? `${Math.round((completeJobs / jobs.length) * 100)}%` : '0%';
}

async function loadState() {
  const { extractorRun } = await chrome.storage.local.get('extractorRun');
  render(extractorRun);
}

$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const config = readConfig();
  const error = validate(config);
  $('form-error').textContent = error || '';
  if (error) return;
  persistDraft();
  const response = await chrome.runtime.sendMessage({ type: 'START_RUN', config });
  if (!response?.ok) $('form-error').textContent = response?.error || 'Could not start the run.';
  await loadState();
});

function addPresetTerms(preset) {
  const existing = $('terms').value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const merged = [...new Set([...existing, ...preset.terms])];
  $('terms').value = merged.slice(0, MAX_TERMS).join('\n');
  $('form-error').textContent = merged.length > MAX_TERMS
    ? `Kept the first ${MAX_TERMS} terms — one run is capped at ${MAX_TERMS} searches to stay under Google's rate limits. Save the rest for a second plan.`
    : '';
  syncForm();
  persistDraft();
}

for (const preset of TERM_PRESETS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mini-button';
  button.textContent = `+ ${preset.label} (${preset.terms.length})`;
  button.title = preset.description;
  button.addEventListener('click', () => addPresetTerms(preset));
  $('preset-row').appendChild(button);
}

$('search-form').addEventListener('input', () => { syncForm(); persistDraft(); });
$('search-form').addEventListener('change', () => { syncForm(); persistDraft(); });
window.addEventListener('pagehide', persistDraft);

$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
  await loadState();
});

$('export').addEventListener('click', async () => {
  if (!lastState?.records?.length) return;
  const blob = new Blob([recordsToCsv(lastState.records)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: csvFilename(lastState.config), saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
});

$('clear').addEventListener('click', async () => {
  if (lastState?.active) {
    $('form-error').textContent = 'Stop the active run before clearing its results.';
    return;
  }
  await chrome.storage.local.remove('extractorRun');
  $('form-error').textContent = '';
  render(null);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extractorRun) render(changes.extractorRun.newValue);
});

const immediateDraft = localDraft();
applyDraft(immediateDraft);
if (!$('terms').value.trim()) $('terms').value = 'restaurants\nbanks\nparks\nshops';
syncForm();

chrome.storage.local.get(['extractorDraft', 'extractorRun']).then((stored) => {
  const storedDraft = stored.extractorDraft;
  if (!immediateDraft || (storedDraft?.saved_at || 0) > (immediateDraft.saved_at || 0)) {
    applyDraft(storedDraft);
  }
  render(stored.extractorRun);
}).catch((error) => { $('form-error').textContent = error.message; });

setInterval(() => {
  if (lastState?.nextRunAt) render(lastState);
}, 1000);
