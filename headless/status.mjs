#!/usr/bin/env node
// Shows how far the country scrape has got, from the status file it keeps.
//   node status.mjs                 reads output/status.json
//   node status.mjs config.json     reads the out_dir named in that config
//   node status.mjs output --watch  refreshes every 30 seconds
//   node status.mjs --json          prints the raw status for scripts
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATUS_FILE, effectiveState, formatStatus, pidAlive } from './reporter.mjs';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const json = args.includes('--json');
const target = args.find((a) => !a.startsWith('--')) || 'output';

function statusFile() {
  if (existsSync(target) && statSync(target).isFile()) {
    const cfg = JSON.parse(readFileSync(target, 'utf8'));
    return path.resolve(cfg.out_dir || 'output', STATUS_FILE);
  }
  return path.resolve(target, STATUS_FILE);
}

function show() {
  const file = statusFile();
  if (!existsSync(file)) {
    console.log(`No status yet at ${file}. Has scrape.mjs been started with this out_dir?`);
    return 2;
  }
  const status = JSON.parse(readFileSync(file, 'utf8'));
  const alive = pidAlive(status.pid);
  if (json) console.log(JSON.stringify({ ...status, alive, effectiveState: effectiveState(status, alive) }, null, 2));
  else console.log(formatStatus(status, { alive }));
  // Exit code for scripts: 0 finished, 1 still going, 3 not running.
  const state = effectiveState(status, alive);
  return state === 'finished' ? 0 : ['dead', 'error', 'stopped'].includes(state) ? 3 : 1;
}

if (watch) {
  const loop = () => { console.clear(); show(); console.log('\n(refreshing every 30 s, Ctrl+C to quit)'); };
  loop();
  setInterval(loop, 30000);
} else {
  process.exitCode = show();
}
