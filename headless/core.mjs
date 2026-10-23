// Shared browser-driving code for the headless runners. Launches Chrome for
// Testing with the extension loaded, starts a run with a popup-shaped config,
// and polls the extension's stored run state until it finishes.
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { BUDGET_KEY } from '../lib/budget.js';

export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINISHED = new Set(['complete', 'stopped', 'error']);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findChrome(explicit) {
  // Branded Google Chrome (137+) silently ignores --load-extension, so the
  // runner uses the Chrome for Testing build that puppeteer downloads on
  // install. A user-supplied path must be Chromium or Chrome for Testing.
  if (explicit) return path.resolve(explicit);
  const bundled = await puppeteer.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  throw new Error('Chrome for Testing not found. Run setup.sh (or `npx puppeteer browsers install chrome`).');
}

// When the runner is killed hard (kill -9, OOM), its Chrome keeps running,
// keeps the profile locked, and still has a run open. Close that browser
// before reusing the profile. Chrome's SingletonLock is a symlink to
// "<host>-<pid>".
export async function releaseStaleProfile(profileDir, log = console.log) {
  const lock = path.join(profileDir, 'SingletonLock');
  let pid = null;
  try { pid = Number(/-(\d+)$/.exec(readlinkSync(lock))?.[1]) || null; } catch { return; }
  const ours = (() => {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return cmdline.includes(`--user-data-dir=${profileDir}`);
    } catch { return false; }
  })();
  if (pid && ours) {
    // A Chrome whose parent is still a node runner belongs to a live run.
    const parent = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]) || 0;
    let parentCmd = '';
    try { parentCmd = readFileSync(`/proc/${parent}/cmdline`, 'utf8'); } catch { /* parent gone */ }
    if (/(^|\/)node\0/.test(parentCmd)) {
      throw Object.assign(
        new Error(`Profile ${profileDir} is in use by another running scraper (node pid ${parent}). Stop it first or use a different "profile".`),
        { code: 'PROFILE_IN_USE' });
    }
    log(`Closing a leftover Chrome (pid ${pid}) from an earlier run that still holds ${profileDir}.`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 20 && existsSync(`/proc/${pid}`); i += 1) await sleep(500);
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    await sleep(500);
  }
  if (!pid || !existsSync(`/proc/${pid}`)) {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(path.join(profileDir, name), { force: true });
  }
}

export async function launchBrowser({ chrome, headless, profile, proxy } = {}) {
  const profileDir = profile ? path.resolve(profile) : mkdtempSync(path.join(tmpdir(), 'atlas-profile-'));
  if (profile) await releaseStaleProfile(profileDir);
  const args = [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--window-size=1400,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--lang=en-US'
  ];
  if (proxy) args.push(`--proxy-server=${proxy}`);
  if (process.getuid?.() === 0) args.push('--no-sandbox');

  const browser = await puppeteer.launch({
    executablePath: await findChrome(chrome),
    headless: headless ? 'new' : false,
    userDataDir: profileDir,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    // Puppeteer would close Chrome on these signals before the runner's own
    // handler reads the collected records; the runner closes it after saving.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    defaultViewport: null
  });
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 30000 });
  const extensionId = new URL(workerTarget.url()).host;
  // MV3 service workers idle out after ~30 s, so storage is read through a
  // dedicated extension tab that stays alive for the whole session. The Maps
  // run happens in the browser's first tab.
  const control = await browser.newPage();
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
  const readRun = () => control.evaluate(async () => (await chrome.storage.local.get('extractorRun')).extractorRun || null);
  const clearRun = () => control.evaluate(() => chrome.storage.local.remove('extractorRun'));
  const sendMessage = (message) => control.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const readUsage = () => control.evaluate(async (key) => (await chrome.storage.local.get(key))[key] || null, BUDGET_KEY);
  const writeUsage = (usage) => control.evaluate((key, value) => chrome.storage.local.set({ [key]: value }), BUDGET_KEY, usage);
  const mapsPage = (await browser.pages()).find((p) => p !== control) || await browser.newPage();
  await mapsPage.bringToFront();
  return { browser, control, mapsPage, extensionId, readRun, clearRun, sendMessage, readUsage, writeUsage };
}

export async function startRun(session, config) {
  await session.clearRun();
  // The worker opens Maps in the active tab, so make sure that is the Maps
  // tab and not the control page.
  await session.mapsPage.bringToFront();
  const started = await session.sendMessage({ type: 'START_RUN', config });
  if (started && started.ok === false) throw new Error(`Could not start run: ${started.error}`);
}

export function progressLine(run) {
  const jobs = run.jobs?.length || 0;
  const done = run.jobsCompleted ?? 0;
  const unique = run.records?.length || 0;
  const next = run.pausedUntil
    ? ` · paused until ${new Date(run.pausedUntil).toLocaleString()} (daily budget)`
    : run.nextRunAt ? ` · next in ${Math.max(0, Math.round((new Date(run.nextRunAt) - Date.now()) / 1000))}s` : '';
  const details = run.stage === 'enriching' ? ` · details ${run.detailsCompleted ?? 0}/${unique}` : '';
  return `[${new Date().toISOString().slice(11, 19)}] ${run.stage.padEnd(20)} jobs ${done}/${jobs} · unique ${unique}${details} · errors ${run.errors?.length || 0}${next}`;
}

export async function waitForRun(session, { onProgress = () => undefined, onPoll = () => undefined, intervalMs = 10000 } = {}) {
  let lastLine = '';
  for (;;) {
    await sleep(intervalMs);
    const run = await session.readRun();
    if (!run) continue;
    const line = progressLine(run);
    onPoll(run);
    // Compare without the leading [HH:MM:SS] so an idle run (a long cooldown or
    // a daily-budget pause) does not print the same line every poll.
    const key = line.replace(/^\[[^\]]*\] /, '').replace(/ · next in \d+s$/, '');
    if (key !== lastLine) { onProgress(line, run); lastLine = key; }
    if (FINISHED.has(run.stage) && !run.active) return run;
  }
}

export function baseConfig(overrides) {
  return {
    coverage_mode: 'adaptive',
    max_search_jobs: 100,
    saturation_threshold: 40,
    lat: null, lng: null, radius_m: null,
    term_delay_ms: 45000,
    max_results_per_search: 0,
    detail_delay_ms: 4000,
    include_popular_times: false,
    include_additional_info: false,
    exclude_sponsored: true,
    enrich_details: false,
    detail_concurrency: 1,
    debug: false,
    radius_tolerance_m: 0,
    ...overrides
  };
}
