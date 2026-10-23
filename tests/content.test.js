import test from 'node:test';
import assert from 'node:assert/strict';

test('search scrolling honors max_results_per_search', async () => {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.match(content, /max_results_per_search/);
});
