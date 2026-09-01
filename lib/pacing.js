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
