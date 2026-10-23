import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cityFraction, createReporter, effectiveState, etaMs, formatStatus, overallPercent
} from '../headless/reporter.mjs';

const base = {
  country: 'United States', pid: 1, state: 'running', enrich: true,
  totalCities: 10, doneCities: 2, failedCities: 0, rowsTotal: 500,
  startedAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T01:00:00Z',
  cityDurationsMs: [3600000, 3600000], events: []
};

test('progress counts the current city, with enrichment as its second half', () => {
  assert.equal(cityFraction({ stage: 'searching', jobsDone: 5, jobs: 10 }, true), 0.25);
  assert.equal(cityFraction({ stage: 'enriching', details: 50, detailsTotal: 100 }, true), 0.75);
  assert.equal(cityFraction({ stage: 'searching', jobsDone: 5, jobs: 10 }, false), 0.5);
  const status = { ...base, current: { stage: 'enriching', details: 0, detailsTotal: 100 } };
  assert.equal(overallPercent(status), 25);
  assert.equal(etaMs(status), 7.5 * 3600000);
});

test('a paused run shows when it resumes; a dead process is called out', () => {
  const paused = { ...base, state: 'paused', stateMessage: 'Daily search budget almost used (475/500).', resumeAt: '2026-10-16T00:30:00Z' };
  const text = formatStatus(paused, { now: new Date('2026-10-15T12:30:00Z'), alive: true });
  assert.match(text, /PAUSED \(daily limit\)/);
  assert.match(text, /in 12\.0 h/);
  assert.match(text, /20\.0%/);
  assert.equal(effectiveState(paused, false), 'dead');
  assert.match(formatStatus(paused, { alive: false }), /NOT RUNNING/);
  assert.equal(effectiveState({ ...paused, state: 'finished' }, false), 'finished');
});

test('reporter writes status.json and pushes milestones once', async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ title: req.headers.title, body }); res.end('ok'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outDir = mkdtempSync(path.join(tmpdir(), 'atlas-status-'));
  const reporter = createReporter({
    outDir, country: 'United States', totalCities: 10, enrich: false,
    notify: { url: `http://127.0.0.1:${server.address().port}/topic`, every_percent: 10 }, log: () => undefined
  });
  reporter.update({ doneCities: 1 });
  await reporter.milestone();
  await reporter.milestone();
  reporter.update({ doneCities: 3 });
  await reporter.milestone();
  server.close();
  assert.deepEqual(received.map((r) => r.title), ['United States: 10% done', 'United States: 30% done']);
  const saved = JSON.parse(readFileSync(path.join(outDir, 'status.json'), 'utf8'));
  assert.equal(saved.doneCities, 3);
  assert.equal(saved.lastMilestone, 30);
});
