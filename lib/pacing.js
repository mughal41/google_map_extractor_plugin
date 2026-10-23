// Human-like pacing between search jobs. A fixed interval is a bot signature;
// every cooldown gets random jitter and the queue takes a longer rest at a
// steady cadence so long plans do not look like a metronome to Google.
export const JITTER_FRACTION = 0.5;
export const LONG_REST_EVERY_JOBS = 8;
export const LONG_REST_MULTIPLIER = 5;

export function baseCooldownMs(config) {
  return Math.max(5000, Number(config?.term_delay_ms) || 30000);
}

export function cooldownAfterJob(baseMs, jobsCompleted, random = Math.random()) {
  const bounded = Math.min(Math.max(Number(random) || 0, 0), 1);
  const jitterMs = Math.round(baseMs * JITTER_FRACTION * bounded);
  const longRest = jobsCompleted > 0 && jobsCompleted % LONG_REST_EVERY_JOBS === 0;
  return {
    cooldownMs: baseMs + jitterMs + (longRest ? baseMs * LONG_REST_MULTIPLIER : 0),
    longRest
  };
}

export function estimatedCooldownTotalMs(jobCount, baseMs) {
  const gaps = Math.max(0, Number(jobCount) - 1);
  const averageGapMs = baseMs * (1 + JITTER_FRACTION / 2);
  const longRestMs = Math.floor(gaps / LONG_REST_EVERY_JOBS) * baseMs * LONG_REST_MULTIPLIER;
  return Math.round(gaps * averageGapMs + longRestMs);
}

// Place pages get the same treatment: a random pause between 0.6x and 1.5x
// of the configured delay, plus a longer break every so often.
export const DETAIL_REST_EVERY = 25;
export const DETAIL_REST_MULTIPLIER = 6;

export function detailPauseMs(baseMs, detailsDone, random = Math.random()) {
  const base = Math.max(1000, Number(baseMs) || 2000);
  const bounded = Math.min(Math.max(Number(random) || 0, 0), 1);
  const longRest = detailsDone > 0 && detailsDone % DETAIL_REST_EVERY === 0;
  return {
    pauseMs: Math.round(base * (0.6 + 0.9 * bounded) + (longRest ? base * DETAIL_REST_MULTIPLIER : 0)),
    longRest
  };
}
