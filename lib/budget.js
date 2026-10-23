// Daily request budget. Google publishes no request limit for browsing
// maps.google.com (the paid Places API quota is a separate product); its
// throttling is adaptive and per IP. These caps are self-imposed: a run pauses
// just before it reaches them and resumes after the next daily reset, instead
// of pushing on until Google answers with a CAPTCHA.
//
// Usage is one small object kept in chrome.storage.local under BUDGET_KEY so
// it survives across cities and runs:
//   { day, searches, details, resumeAt: { searches, details }, blockedAt, learned: { searches, details } }
// resumeAt holds each kind separately, so a spent search cap does not stall
// the detail phase.
// A limit of 0 means unlimited.
export const BUDGET_KEY = 'extractorUsage';
export const BUDGET_KINDS = ['searches', 'details'];
export const DEFAULT_MARGIN = 0.95;
// After a block, the learned cap is this share of what was used that day.
export const BLOCK_BACKOFF = 0.8;
// Each clean day that used its whole learned cap raises it by this share.
export const LEARNED_GROWTH = 0.1;

const HOUR_MS = 3600000;

export function budgetDay(now, resetHour = 0) {
  const shifted = new Date(new Date(now).getTime() - (Number(resetHour) || 0) * HOUR_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
}

export function nextResetAt(now, resetHour = 0) {
  const at = new Date(now);
  at.setHours(Number(resetHour) || 0, 0, 0, 0);
  if (at.getTime() <= new Date(now).getTime()) at.setDate(at.getDate() + 1);
  return at;
}

// Resume a little after the reset, never on the stroke of it, so the restart
// time is not a fixed daily signature either.
export function scheduleResume(now, config = {}, random = Math.random()) {
  const jitterMs = Math.round((Number(config.budget_reset_jitter_minutes) || 0) * 60000 * random);
  return new Date(nextResetAt(now, config.budget_reset_hour).getTime() + jitterMs);
}

export function limitsFor(config = {}, usage = {}) {
  const pick = (configured, learned) => {
    const cap = Math.max(0, Number(configured) || 0);
    const soft = Math.max(0, Number(learned) || 0);
    if (!soft) return cap;
    return cap ? Math.min(cap, soft) : soft;
  };
  return {
    searches: pick(config.daily_search_limit, usage.learned?.searches),
    details: pick(config.daily_detail_limit, usage.learned?.details)
  };
}

// Rolls usage over to a new day when the reset has passed. Pending resume
// times carry over so the reset jitter is honored.
export function freshUsage(usage, now, config = {}) {
  const day = budgetDay(now, config.budget_reset_hour);
  const learned = { ...(usage?.learned || {}) };
  if (usage?.day === day) return { ...usage, resumeAt: { ...(usage.resumeAt || {}) }, learned };
  if (usage && !usage.blockedAt) {
    for (const kind of BUDGET_KINDS) {
      const cap = Math.max(0, Number(config[kind === 'searches' ? 'daily_search_limit' : 'daily_detail_limit']) || 0);
      if (learned[kind] && (usage[kind] || 0) >= allowedFor(learned[kind], config)) {
        const grown = Math.ceil(learned[kind] * (1 + LEARNED_GROWTH));
        if (cap && grown >= cap) delete learned[kind];
        else learned[kind] = grown;
      }
    }
  }
  return { day, searches: 0, details: 0, resumeAt: { ...(usage?.resumeAt || {}) }, blockedAt: null, learned };
}

// How many requests a cap actually permits once the safety margin is taken.
function allowedFor(limit, config) {
  const margin = Math.min(1, Math.max(0.5, Number(config.budget_margin) || DEFAULT_MARGIN));
  return Math.max(1, Math.floor(limit * margin));
}

export function checkBudget(usage, config = {}, kind, now = new Date()) {
  const limits = limitsFor(config, usage);
  const limit = limits[kind] || 0;
  const used = usage?.[kind] || 0;
  const resumeAt = usage?.resumeAt?.[kind];
  if (resumeAt && new Date(now) < new Date(resumeAt)) {
    return { ok: false, kind, used, limit, resumeAt, reason: usage.blockedAt ? 'blocked' : 'limit' };
  }
  if (usage?.blockedAt) return { ok: false, kind, used, limit, reason: 'blocked' };
  if (!limit) return { ok: true, kind, used, limit };
  const allowed = allowedFor(limit, config);
  return used + 1 <= allowed
    ? { ok: true, kind, used, limit, allowed }
    : { ok: false, kind, used, limit, allowed, reason: 'limit' };
}

// Charges one request when allowed. Returns the verdict and the new usage;
// when refused, verdict.resumeAt is when the caller may try again.
export function spendBudget(usage, config, kind, now = new Date(), random = Math.random()) {
  const current = freshUsage(usage, now, config);
  if (current.resumeAt[kind] && new Date(now) >= new Date(current.resumeAt[kind])) delete current.resumeAt[kind];
  const verdict = checkBudget(current, config, kind, now);
  if (verdict.ok) return { verdict, usage: { ...current, [kind]: (current[kind] || 0) + 1 } };
  current.resumeAt[kind] ||= scheduleResume(now, config, random).toISOString();
  return { verdict: { ...verdict, resumeAt: current.resumeAt[kind] }, usage: current };
}

// Google showed a CAPTCHA: today is over, and tomorrow's cap drops to a share
// of what triggered it, since that is the best evidence of the real limit.
export function recordBlock(usage, config, now = new Date(), random = Math.random()) {
  const current = freshUsage(usage, now, config);
  const learned = { ...current.learned };
  for (const kind of BUDGET_KINDS) {
    if ((current[kind] || 0) > 0) learned[kind] = Math.max(10, Math.floor(current[kind] * BLOCK_BACKOFF));
  }
  const resumeAt = scheduleResume(now, config, random).toISOString();
  return {
    ...current,
    learned,
    blockedAt: new Date(now).toISOString(),
    resumeAt: Object.fromEntries(BUDGET_KINDS.map((kind) => [kind, resumeAt]))
  };
}

// Combines two copies of the same budget (the browser's and a file mirror)
// without losing requests counted by either.
export function mergeUsage(a, b) {
  // Older copies stored one resume time for every kind.
  const perKind = (u) => (u && typeof u.resumeAt === 'string'
    ? { ...u, resumeAt: Object.fromEntries(BUDGET_KINDS.map((kind) => [kind, u.resumeAt])) } : u);
  a = perKind(a);
  b = perKind(b);
  if (!a) return b || null;
  if (!b) return a;
  if (a.day !== b.day) return a.day > b.day ? a : b;
  const later = (x, y) => (!x ? y : !y ? x : (x > y ? x : y));
  const learned = { ...(a.learned || {}) };
  for (const kind of BUDGET_KINDS) {
    const values = [a.learned?.[kind], b.learned?.[kind]].filter(Boolean);
    if (values.length) learned[kind] = Math.min(...values);
  }
  const resumeAt = {};
  for (const kind of BUDGET_KINDS) {
    const value = later(a.resumeAt?.[kind], b.resumeAt?.[kind]);
    if (value) resumeAt[kind] = value;
  }
  return {
    day: a.day,
    searches: Math.max(a.searches || 0, b.searches || 0),
    details: Math.max(a.details || 0, b.details || 0),
    resumeAt,
    blockedAt: later(a.blockedAt, b.blockedAt),
    learned
  };
}
