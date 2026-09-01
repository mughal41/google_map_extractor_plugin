// Pre-run plan estimation shown on the confirm screen. Mirrors the job-count
// logic in lib/location.js createCityScanJobs without needing resolved map
// bounds, and prices time with the same pacing model the runner uses.
import {
  JITTER_FRACTION, LONG_REST_EVERY_JOBS, LONG_REST_MULTIPLIER, estimatedCooldownTotalMs
} from './pacing.js';

// Observed per-search wall time: open the search URL, wait for the feed,
// scroll to the end of the list. Varies with result density.
export const SEARCH_MS_TYPICAL = 45000;
export const SEARCH_MS_MIN = 30000;
export const SEARCH_MS_MAX = 70000;
// A detail visit is a page load plus parse; used only for the enrichment note.
export const DETAIL_VISIT_MS = 9000;

export function gridDimensionFor(termCount, maxJobs) {
  const cellsPerTerm = Math.max(1, Math.floor(Math.max(1, maxJobs) / Math.max(1, termCount)));
  return cellsPerTerm >= 9 ? 3 : cellsPerTerm >= 4 ? 2 : 1;
}

export function plannedJobs(config) {
  const termCount = (config.terms || []).length;
  if (!termCount) return { initial: 0, ceiling: 0, dimension: 1 };
  if (config.location_mode !== 'city' || config.coverage_mode === 'city') {
    return { initial: termCount, ceiling: termCount, dimension: 1 };
  }
  const budget = Math.max(1, Number(config.max_search_jobs) || 100);
  const dimension = gridDimensionFor(termCount, budget);
  const initial = Math.min(budget, termCount * dimension * dimension);
  return {
    initial,
    ceiling: config.coverage_mode === 'adaptive' ? budget : initial,
    dimension
  };
}

export function riskLevel(worstCaseJobs) {
  if (worstCaseJobs > 120) return 'high';
  if (worstCaseJobs > 60) return 'elevated';
  return 'low';
}

// The receipt on the confirm screen prints these components as rows, so the
// bounds are built from the exact same pieces: search range + cooldown range
// (zero to full jitter) + fixed rest breaks. Rows always sum to the total.
export function planEstimate(config) {
  const { initial, ceiling, dimension } = plannedJobs(config);
  const baseDelay = Math.max(5000, Number(config.term_delay_ms) || 30000);
  const gaps = Math.max(0, initial - 1);
  const restMs = Math.floor(gaps / LONG_REST_EVERY_JOBS) * baseDelay * LONG_REST_MULTIPLIER;
  const cooldownMinMs = gaps * baseDelay;
  const cooldownMaxMs = Math.round(gaps * baseDelay * (1 + JITTER_FRACTION));
  const cooldownMs = estimatedCooldownTotalMs(initial, baseDelay);
  return {
    jobs: initial,
    ceiling,
    dimension,
    termCount: (config.terms || []).length,
    searchMs: initial * SEARCH_MS_TYPICAL,
    searchMinMs: initial * SEARCH_MS_MIN,
    searchMaxMs: initial * SEARCH_MS_MAX,
    cooldownMs,
    cooldownMinMs,
    cooldownMaxMs,
    restMs,
    typicalMs: initial * SEARCH_MS_TYPICAL + cooldownMs,
    minMs: initial * SEARCH_MS_MIN + cooldownMinMs + restMs,
    maxMs: initial * SEARCH_MS_MAX + cooldownMaxMs + restMs,
    risk: riskLevel(ceiling),
    enrichment: config.enrich_details === true
  };
}

export function formatClock(milliseconds) {
  const totalMinutes = Math.round(Math.max(0, milliseconds) / 60000);
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
