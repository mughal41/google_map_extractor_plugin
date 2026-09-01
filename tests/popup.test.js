import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('popup drafts are synchronously persisted on every form edit', async () => {
  const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
  assert.match(source, /localStorage\.setItem\('extractorDraft'/);
  assert.match(source, /addEventListener\('input',[\s\S]*persistDraft\(\)/);
  assert.match(source, /addEventListener\('change',[\s\S]*persistDraft\(\)/);
  assert.match(source, /addEventListener\('pagehide', persistDraft\)/);
});

test('popup clearly distinguishes card-only data from detail-page visits', async () => {
  const source = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.match(source, /Off uses result cards only/);
  assert.match(source, /Open place pages for missing details/);
  assert.match(source, /Popular times[\s\S]*Not supported by the current feed parser/);
  assert.match(source, /id="popular-times"[^>]*disabled/);
  const script = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
  assert.match(script, /include_popular_times: false/);
});

test('redesign keeps the estimate-and-confirm gate between plan and run', async () => {
  const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="view-review"/);
  assert.match(html, /id="est-hero"/);
  assert.match(html, /id="confirm-start"/);
  assert.match(html, /id="receipt-rows"/);
  assert.match(html, /id="risk-meter"/);
  const script = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
  assert.match(script, /showView\('review'/, 'form submit stages the review view');
  assert.doesNotMatch(
    script.replace(/setupReviewEvents[\s\S]*?\n}/, ''),
    /START_RUN/,
    'START_RUN must only fire from the review confirm handler'
  );
});

test('redesign ships tabs, popovers, and a data-url export path', async () => {
  const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="popover"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-info="cooldown"/);
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(background, /DOWNLOAD_CSV/);
  const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.match(content, /cooldownTotalMs/, 'popup countdown ring needs the stored cooldown total');
});

test('popup exposes city resolution, ordered jobs, cooldown, and live run details', async () => {
  const source = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  assert.match(source, /City &amp; country/);
  assert.match(source, /Coordinates &amp; radius/);
  assert.match(source, /One term per line/);
  assert.match(source, /Cooldown between term searches/);
  assert.match(source, /Resolved area/);
  assert.match(source, /Current job/);
  assert.match(source, /Next action/);
  assert.match(source, /Adaptive scan · Refine dense cells/);
  assert.match(source, /Maximum search jobs/);
  assert.match(source, /splits cells returning 40 or more cards/);
});
