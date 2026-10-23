// Progress reporting for servers without a screen. The scraper keeps
// <out_dir>/status.json current (read it with `node status.mjs`), and can push
// milestone messages to a webhook such as ntfy.sh, Discord or Slack.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATUS_FILE = 'status.json';
const MAX_EVENTS = 30;
const MAX_DURATIONS = 25;

// Share of the current city that is done. With enrichment, searching counts
// as the first half and the detail phase as the second.
export function cityFraction(current, enrich) {
  if (!current) return 0;
  const searchShare = enrich ? 0.5 : 1;
  if (current.stage === 'enriching') {
    return searchShare + (1 - searchShare) * (current.detailsTotal ? current.details / current.detailsTotal : 0);
  }
  if (current.stage === 'complete') return 1;
  return searchShare * (current.jobs ? current.jobsDone / current.jobs : 0);
}

export function overallPercent(status) {
  if (!status.totalCities) return 0;
  const done = status.doneCities + cityFraction(status.current, status.enrich);
  return Math.min(100, (done / status.totalCities) * 100);
}

// Wall-clock time per finished city, pauses included, so the estimate already
// accounts for the daily budget.
export function etaMs(status) {
  const durations = status.cityDurationsMs || [];
  if (!durations.length) return null;
  const average = durations.reduce((a, b) => a + b, 0) / durations.length;
  const remaining = status.totalCities - status.doneCities - cityFraction(status.current, status.enrich);
  return Math.max(0, remaining * average);
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const STATE_LABELS = {
  running: 'RUNNING',
  paused: 'PAUSED (daily limit)',
  blocked: 'WAITING OUT A CAPTCHA',
  finished: 'FINISHED',
  stopped: 'STOPPED',
  error: 'CRASHED'
};

export function effectiveState(status, alive) {
  if (['finished', 'stopped', 'error'].includes(status.state)) return status.state;
  return alive ? status.state : 'dead';
}

export function formatStatus(status, { now = new Date(), alive = true } = {}) {
  const state = effectiveState(status, alive);
  const pct = overallPercent(status);
  const lines = [];
  const label = state === 'dead'
    ? 'NOT RUNNING — the process died without finishing (reboot, kill or crash). Start it again; it resumes where it left off.'
    : STATE_LABELS[state] || state.toUpperCase();
  const who = status.name ? `[${status.name}${status.shard ? ` · share ${status.shard.index}/${status.shard.count}` : ''}] ` : '';
  lines.push(`${who}${status.country} scrape: ${label}`);
  if (status.stateMessage) lines.push(`  ${status.stateMessage}`);
  if (status.resumeAt && ['paused', 'blocked'].includes(state)) {
    lines.push(`  Resumes at ${new Date(status.resumeAt).toLocaleString()} (in ${formatDuration(new Date(status.resumeAt) - now)})`);
  }
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
  lines.push('');
  lines.push(`Progress  ${bar} ${pct.toFixed(1)}%`);
  lines.push(`Cities    ${status.doneCities} done / ${status.totalCities} total · ${status.failedCities} failed (retried on restart)`);
  lines.push(`Rows      ${status.rowsTotal} saved to CSV`);
  const c = status.current;
  if (c && !['finished', 'stopped'].includes(state)) {
    const phase = c.stage === 'enriching'
      ? `details ${c.details}/${c.detailsTotal}`
      : `searches ${c.jobsDone}/${c.jobs || '?'}`;
    lines.push(`Current   ${c.city} · ${c.stage} · ${phase} · ${c.unique} places · started ${formatDuration(now - new Date(c.startedAt))} ago`);
  }
  if (status.usage) {
    const u = status.usage;
    lines.push(`Today     ${u.searches}/${u.searchLimit || '∞'} searches · ${u.details}/${u.detailLimit || '∞'} place pages (budget day ${u.day})`);
  }
  if (!['finished', 'stopped'].includes(state)) lines.push(`ETA       ${formatDuration(etaMs(status))} (average per city so far, pauses included)`);
  lines.push(`Started   ${new Date(status.startedAt).toLocaleString()} · last update ${formatDuration(now - new Date(status.updatedAt))} ago · pid ${status.pid}`);
  if (status.events?.length) {
    lines.push('');
    lines.push('Recent events');
    for (const e of status.events.slice(-8)) lines.push(`  ${new Date(e.at).toLocaleString()}  ${e.text}`);
  }
  return lines.join('\n');
}

function webhookRequest(notify, title, text) {
  const format = notify.format || 'ntfy';
  if (format === 'ntfy') {
    return { headers: { Title: title, Tags: 'world_map' }, body: text };
  }
  const message = `**${title}**\n${text}`;
  if (format === 'discord') return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) };
  if (format === 'slack') return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) };
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text }) };
}

export function createReporter({ outDir, name = '', shard = null, country, totalCities, enrich, notify, log = console.log }) {
  const file = path.join(outDir, STATUS_FILE);
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const status = {
    name,
    shard,
    country,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'running',
    stateMessage: '',
    resumeAt: null,
    enrich,
    totalCities,
    doneCities: 0,
    failedCities: 0,
    rowsTotal: 0,
    current: null,
    usage: null,
    // Carried over a restart so the estimate and history survive it.
    cityDurationsMs: previous?.cityDurationsMs || [],
    events: previous?.events || [],
    lastMilestone: previous?.lastMilestone || 0
  };
  let warned = false;

  const write = () => {
    status.updatedAt = new Date().toISOString();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    renameSync(tmp, file);
  };

  const push = async (title, text) => {
    if (!notify?.url) return;
    try {
      const { headers, body } = webhookRequest(notify, `${name ? `[${name}] ` : ''}${country}: ${title}`, text);
      const response = await fetch(notify.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (!warned) log(`Notification failed (${error.message}); progress is still in ${file}.`);
      warned = true;
    }
  };

  const summary = () => `${overallPercent(status).toFixed(1)}% · ${status.doneCities}/${status.totalCities} cities · ${status.rowsTotal} rows`;

  return {
    status,
    write,
    update(patch) {
      Object.assign(status, patch);
      write();
    },
    // Records an event in status.json and, when `push` is set, sends it.
    async event(title, text, { push: send = false } = {}) {
      status.events = [...status.events, { at: new Date().toISOString(), text: `${title}: ${text}` }].slice(-MAX_EVENTS);
      write();
      if (send) await push(title, `${text}\n${summary()}`);
    },
    cityFinished(durationMs) {
      status.cityDurationsMs = [...status.cityDurationsMs, durationMs].slice(-MAX_DURATIONS);
      status.current = null;
      write();
    },
    // Sends one message each time overall progress crosses the next step.
    async milestone() {
      const step = Math.max(1, Number(notify?.every_percent) || 10);
      const reached = Math.floor(overallPercent(status) / step) * step;
      if (reached < status.lastMilestone) status.lastMilestone = reached; // progress.json was reset
      if (reached <= status.lastMilestone || reached >= 100) return;
      status.lastMilestone = reached;
      await this.event(`${reached}% done`, `ETA ${formatDuration(etaMs(status))}`, { push: true });
    },
    summary
  };
}
