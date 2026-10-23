#!/usr/bin/env node
// Remote control for a fleet of scraper servers, run from your own PC.
// Every server works on its own (systemd service, own budget and progress);
// this only installs, starts, stops, inspects and collects over SSH.
//
//   node fleet.mjs setup   [names…]   copy code + config, install deps and the service
//   node fleet.mjs start   [names…]   start the scraper service
//   node fleet.mjs stop    [names…]   stop it (partial results are saved)
//   node fleet.mjs restart [names…]
//   node fleet.mjs status  [names…]   one table for the whole fleet
//   node fleet.mjs logs    <name> [lines]
//   node fleet.mjs config set <key> <value>   change a setting in the base config,
//                                             push it to every server, restart them
//   node fleet.mjs update  [names…]   push new code, reinstall deps if needed, restart
//   node fleet.mjs collect [names…]   pull CSVs and progress into results/<name>/
//   node fleet.mjs merge              one deduplicated CSV from everything in results/
//
// Servers come from fleet.json (see fleet.example.json). A server's share of
// the place list is its position in that list, so keep the order fixed; to
// replace a dead server, change its host in place and run `setup <name>`.
// Use --fleet FILE to pick another fleet file.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveState, etaMs, formatDuration, overallPercent } from './reporter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXCLUDES = ['.git', 'node_modules', 'headless/node_modules', 'headless/output', 'headless/profile',
  'headless/results', 'headless/config.json', 'headless/fleet.json', 'headless/test-config.json'];

function loadFleet(file) {
  if (!existsSync(file)) throw new Error(`No ${file}. Copy fleet.example.json to fleet.json and fill in your servers.`);
  const fleet = JSON.parse(readFileSync(file, 'utf8'));
  if (!fleet.servers?.length) throw new Error(`${file} lists no servers.`);
  const names = new Set();
  for (const s of fleet.servers) {
    if (!s.name || !s.host) throw new Error('Every server needs a "name" and a "host" (user@address).');
    if (names.has(s.name)) throw new Error(`Server name "${s.name}" is used twice.`);
    names.add(s.name);
  }
  const base = path.resolve(path.dirname(file), fleet.base_config || 'config.json');
  return {
    file,
    baseFile: base,
    remoteDir: fleet.remote_dir || 'map_extractor',
    ssh: fleet.ssh_options || [],
    results: path.resolve(path.dirname(file), fleet.results_dir || 'results'),
    servers: fleet.servers.map((s, i) => ({ ...s, shard: i + 1 }))
  };
}

function pick(fleet, names) {
  if (!names.length) return fleet.servers;
  return names.map((name) => {
    const server = fleet.servers.find((s) => s.name === name);
    if (!server) throw new Error(`Unknown server "${name}". Known: ${fleet.servers.map((s) => s.name).join(', ')}`);
    return server;
  });
}

// Runs a command, optionally feeding stdin from another process or a string.
function run(cmd, args, { input, pipeFrom, quiet = false, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; if (!quiet) process.stderr.write(d); });
    if (pipeFrom) pipeFrom.stdout.pipe(child.stdin);
    else if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
  });
}

const sshArgs = (fleet, server) => [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
  ...fleet.ssh, ...(server.ssh_options || []), server.host
];
// Remote commands run as root, or through sudo for a non-root login.
const SUDO = 'S=""; [ "$(id -u)" -ne 0 ] && S="sudo -n";';
const remote = (fleet, server, command, opts) => run('ssh', [...sshArgs(fleet, server), command], opts);
const headless = (fleet) => `cd ~/${fleet.remoteDir}/headless`;

function serverConfig(fleet, server) {
  if (!existsSync(fleet.baseFile)) throw new Error(`Base config ${fleet.baseFile} not found (fleet.json "base_config").`);
  const base = JSON.parse(readFileSync(fleet.baseFile, 'utf8'));
  return {
    ...base,
    ...(server.overrides || {}),
    name: server.name,
    shard_index: server.shard,
    shard_count: fleet.servers.length
  };
}

async function pushCode(fleet, server) {
  const tar = spawn('tar', ['-czf', '-', ...EXCLUDES.map((e) => `--exclude=./${e}`), '.'], { cwd: REPO });
  const result = await remote(fleet, server, `mkdir -p ~/${fleet.remoteDir} && tar -xzf - -C ~/${fleet.remoteDir}`, { pipeFrom: tar, quiet: true });
  if (result.code !== 0) throw new Error(`copying code failed: ${result.stderr.trim()}`);
}

async function pushConfig(fleet, server) {
  const json = `${JSON.stringify(serverConfig(fleet, server), null, 2)}\n`;
  const result = await remote(fleet, server, `${headless(fleet)} && cat > config.json`, { input: json, quiet: true });
  if (result.code !== 0) throw new Error(`writing config failed: ${result.stderr.trim()}`);
}

// A replacement server continues the share where the old one stopped: push
// the last collected progress and budget if the server has none yet.
async function pushProgress(fleet, server) {
  const dir = path.join(fleet.results, server.name);
  for (const name of ['progress.json', 'usage.json']) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    await remote(fleet, server, `${headless(fleet)} && mkdir -p output && [ ! -f output/${name} ] && cat > output/${name} || true`,
      { input: readFileSync(file), quiet: true });
  }
}

// Runs `task` on every server at once and prints one result line each.
async function eachServer(servers, label, task) {
  const results = await Promise.all(servers.map(async (server) => {
    try {
      const note = await task(server);
      return { server, ok: true, note: note || 'ok' };
    } catch (error) {
      return { server, ok: false, note: error.message };
    }
  }));
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.server.name.padEnd(10)} ${label}: ${r.note}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  return results;
}

async function systemctl(fleet, servers, action) {
  await eachServer(servers, action, async (server) => {
    const r = await remote(fleet, server, `${SUDO} $S systemctl ${action} atlas-scraper && systemctl is-active atlas-scraper || true`, { quiet: true, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return r.stdout.trim().split('\n').pop();
  });
}

async function readStatus(fleet, server) {
  const r = await remote(fleet, server, `${headless(fleet)} && node status.mjs config.json --json`, { quiet: true, timeoutMs: 30000 });
  if (/No status yet/.test(r.stdout)) return { starting: true };
  if (r.code === -1 || r.code === 255 || (!r.stdout.trim().startsWith('{'))) {
    return { unreachable: true, error: (r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}` };
  }
  return JSON.parse(r.stdout);
}

const LABELS = {
  running: 'RUNNING', paused: 'PAUSED (limit)', blocked: 'WAITING (CAPTCHA)', finished: 'FINISHED',
  stopped: 'STOPPED', error: 'CRASHED ⚠', dead: 'NOT RUNNING ⚠'
};

function shortTime(iso) {
  if (!iso) return '–';
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = at.toTimeString().slice(0, 5);
  return sameDay ? time : `${time} ${at.toLocaleDateString(undefined, { weekday: 'short' })}`;
}

export function statusTable(rows) {
  const lines = [];
  const header = ['NAME', 'STATE', 'PROGRESS', 'CITIES', 'ROWS', 'TODAY search/detail', 'RESUMES', 'ETA'];
  const table = [header];
  let done = 0; let total = 0; let rowsTotal = 0; let maxEta = 0; let anyEta = false;
  for (const { server, status } of rows) {
    if (status.starting) {
      table.push([server.name, 'STARTING', '–', '–', '–', '–', '–', 'no status yet (just started, or never started)']);
      continue;
    }
    if (status.unreachable) {
      table.push([server.name, 'UNREACHABLE ⚠', '–', '–', '–', '–', '–', status.error.slice(0, 40)]);
      continue;
    }
    const state = effectiveState(status, status.alive);
    const pct = overallPercent(status);
    const eta = ['finished', 'stopped', 'dead', 'error'].includes(state) ? null : etaMs(status);
    if (eta !== null) { anyEta = true; maxEta = Math.max(maxEta, eta); }
    done += status.doneCities; total += status.totalCities; rowsTotal += status.rowsTotal;
    const u = status.usage;
    table.push([
      server.name,
      LABELS[state] || state,
      `${pct.toFixed(1)}%`,
      `${status.doneCities}/${status.totalCities}`,
      status.rowsTotal.toLocaleString('en-US'),
      u ? `${u.searches}/${u.searchLimit || '∞'}  ${u.details}/${u.detailLimit || '∞'}` : '–',
      ['paused', 'blocked'].includes(state) ? shortTime(status.resumeAt) : '–',
      state === 'finished' ? 'done' : eta === null ? '–' : formatDuration(eta)
    ]);
  }
  const widths = header.map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  for (const r of table) lines.push(r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
  if (total) {
    lines.push('');
    lines.push(`FLEET  ${((done / total) * 100).toFixed(1)}% · ${done}/${total} cities · ${rowsTotal.toLocaleString('en-US')} rows · ETA ${anyEta ? formatDuration(maxEta) : '–'} (slowest server)`);
  }
  return lines.join('\n');
}

function parseValue(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function setPath(object, dotted, value) {
  const keys = dotted.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) target = (target[key] ??= {});
  target[keys[keys.length - 1]] = value;
}

async function main() {
  const argv = process.argv.slice(2);
  const fleetIndex = argv.indexOf('--fleet');
  const fleetFile = path.resolve(fleetIndex >= 0 ? argv[fleetIndex + 1] : path.join(HERE, 'fleet.json'));
  const args = fleetIndex >= 0 ? argv.filter((_, i) => i !== fleetIndex && i !== fleetIndex + 1) : argv;
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const fleet = loadFleet(fleetFile);

  if (command === 'setup') {
    await eachServer(pick(fleet, rest), 'setup', async (server) => {
      await pushCode(fleet, server);
      await pushConfig(fleet, server);
      await pushProgress(fleet, server);
      const r = await remote(fleet, server, `${headless(fleet)} && mkdir -p output && ${SUDO} $S ./setup.sh --no-start > output/setup.log 2>&1; code=$?; tail -1 output/setup.log; exit $code`,
        { quiet: true, timeoutMs: 1200000 });
      if (r.code !== 0) throw new Error(`setup.sh failed (see ~/${fleet.remoteDir}/headless/output/setup.log): ${r.stdout.trim()}`);
      return `installed, share ${server.shard}/${fleet.servers.length} (not started; run start)`;
    });
  } else if (['start', 'stop', 'restart'].includes(command)) {
    await systemctl(fleet, pick(fleet, rest), command);
  } else if (command === 'status') {
    const servers = pick(fleet, rest);
    const rows = await Promise.all(servers.map(async (server) => ({ server, status: await readStatus(fleet, server) })));
    console.log(statusTable(rows));
  } else if (command === 'logs') {
    const [name, lines = '40'] = rest;
    if (!name) throw new Error('Usage: node fleet.mjs logs <name> [lines]');
    await remote(fleet, pick(fleet, [name])[0], `${headless(fleet)} && tail -n ${Number(lines) || 40} output/scrape.log`);
  } else if (command === 'config') {
    const [action, key, value] = rest;
    if (action !== 'set' || !key || value === undefined) throw new Error('Usage: node fleet.mjs config set <key> <value>   (e.g. daily_search_limit 400, notify.url https://ntfy.sh/x)');
    const base = JSON.parse(readFileSync(fleet.baseFile, 'utf8'));
    setPath(base, key, parseValue(value));
    writeFileSync(fleet.baseFile, `${JSON.stringify(base, null, 2)}\n`);
    console.log(`${path.basename(fleet.baseFile)}: ${key} = ${JSON.stringify(parseValue(value))}`);
    // Resource caps live in the systemd unit, so rewrite it before restarting.
    const reinstall = key.split('.')[0] === 'resources'
      ? `${headless(fleet)} && $S ./setup.sh --no-start > output/setup.log 2>&1 || { tail -3 output/setup.log; exit 1; };` : '';
    await eachServer(fleet.servers, 'config', async (server) => {
      await pushConfig(fleet, server);
      const r = await remote(fleet, server, `${SUDO} ${reinstall} if systemctl is-active -q atlas-scraper; then $S systemctl restart atlas-scraper && echo restarted; else echo "saved (not running)"; fi`, { quiet: true, timeoutMs: 600000 });
      if (r.code !== 0) throw new Error(r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`);
      return r.stdout.trim();
    });
  } else if (command === 'update') {
    await eachServer(pick(fleet, rest), 'update', async (server) => {
      await pushCode(fleet, server);
      await pushConfig(fleet, server);
      const r = await remote(fleet, server, `${headless(fleet)} && mkdir -p output && ${SUDO} $S ./setup.sh --no-start > output/setup.log 2>&1 || { tail -3 output/setup.log; exit 1; }; if systemctl is-active -q atlas-scraper; then $S systemctl restart atlas-scraper && echo "updated, restarted"; else echo "updated (not running)"; fi`,
        { quiet: true, timeoutMs: 1200000 });
      if (r.code !== 0) throw new Error(r.stdout.trim() || r.stderr.trim());
      return r.stdout.trim();
    });
  } else if (command === 'collect') {
    await eachServer(pick(fleet, rest), 'collect', async (server) => {
      const dir = path.join(fleet.results, server.name);
      mkdirSync(dir, { recursive: true });
      const shell = ['ssh', ...sshArgs(fleet, server).slice(0, -1)].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ');
      const r = await run('rsync', ['-az', '--itemize-changes', '-e', shell,
        '--include=*.csv', '--include=progress.json', '--include=usage.json', '--include=status.json', '--exclude=*',
        `${server.host}:${fleet.remoteDir}/headless/output/`, `${dir}/`], { quiet: true, timeoutMs: 1800000 });
      if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop());
      const changed = r.stdout.split('\n').filter((l) => l.startsWith('>f') && l.endsWith('.csv')).length;
      const shown = path.relative(process.cwd(), dir);
      return `${changed} new or updated CSV file(s) → ${shown.startsWith('..') ? dir : shown}`;
    });
  } else if (command === 'merge') {
    const r = await run(process.execPath, [path.join(HERE, 'merge.mjs'), fleet.results, ...rest]);
    process.exitCode = r.code;
  } else {
    throw new Error(`Unknown command "${command}". Run: node fleet.mjs help`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`Error: ${error.message}`); process.exit(1); });
}
