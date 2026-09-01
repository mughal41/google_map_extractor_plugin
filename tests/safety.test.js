import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('collector contains no click, review pagination, or gallery navigation logic', async () => {
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /review(?:s)?\s*(?:panel|pagination)/i);
  assert.doesNotMatch(source, /(?:photo|image)\s*(?:gallery|panel)|gallery\s*(?:navigation|pagination)/i);
});
