# Atlas headless runner

Runs the extension on a server with no GUI. One process = one city. Everything
the popup does (planning, pacing, cooldowns, deduplication, parsing) is done by
the extension itself; this runner only starts it and collects the CSV.

## Server setup (Ubuntu/Debian)

```bash
git clone <this repo> ~/map_extractor
cd ~/map_extractor/headless
sudo ./setup.sh          # first run: installs everything, creates config.json, stops
nano config.json         # set country, categories, limits, notify.url
sudo ./setup.sh          # second run: installs the service and starts scraping
```

The scraper then runs as the `atlas-scraper` systemd service: it starts on
boot, restarts a minute after a crash, and continues where it left off. It
stays stopped when it is done, or after repeated CAPTCHAs, since those need you.

```bash
node status.mjs config.json --watch     # progress
tail -f output/scrape.log               # log
sudo systemctl stop atlas-scraper       # stop (partial results are saved)
sudo systemctl start atlas-scraper      # start again
```

For several servers, use `fleet.mjs` from your PC instead (see Fleet below).

## Country-wide scraping (one config per VPS)

Set `country` and `categories` in `config.json` (see `config.example.json`).
The service runs it; by hand it is `./service.sh config.json`.

It loops over every place in the country from the bundled GeoNames list
(`places/places.json.gz`: 236k cities, towns and villages with 500+ people in
246 countries, with their state/province). Narrow it with `states`,
`min_population` and `max_places`, or give an explicit `cities` list. Explore
the list with `node places.mjs states "United States"` or
`node places.mjs list "United States" --state Texas --min 50000`. Rebuild the
file from fresh GeoNames data with `node places/build.mjs`.

It writes `output/<country>-<city>-<YYYYMMDD>-<HHMMSS>-<NNN>.csv` per city
(`…-partial.csv` when a city was interrupted) and records progress in
`output/progress.json`. Restarting skips finished cities.

### Daily budget and postponing

Google publishes no request limit for maps.google.com (the Places API quota is
a different, paid product). Its throttling is per IP and adaptive, so the
runner keeps its own daily caps instead:

- `daily_search_limit` (default 500) counts search pages, one per search job
  plus one per city lookup. `daily_detail_limit` (default 2000) counts place
  pages in the detail phase. `0` turns a cap off.
- Once `budget_margin` (95%) of a cap is used, the run pauses where it is, even
  in the middle of a city, and continues on its own after `reset_hour` (local
  time) plus a random 0–`reset_jitter_minutes` delay. Nothing is lost or redone.
- Counts are mirrored to `output/usage.json`, so a restart on the same day keeps
  counting from where it was.
- On a CAPTCHA the partial CSV is saved, today is marked as used up, and both
  caps drop to 80% of what was used when the block hit. The run waits for the
  next day and retries that city. Each clean day that uses the whole lowered cap
  raises it 10%, back up to your configured value. After `max_blocks` (2)
  CAPTCHAs in a row it stops for good, since that IP needs a human or a change.
- Pacing is randomized throughout: search cooldowns get up to 50% jitter with a
  long rest every 8 searches, place pages wait 0.6–1.5× `detail_delay_seconds`
  with a long break every 25, and cities are spaced by `sleep_seconds`.

### Checking progress on a server with no screen

The scraper keeps `output/status.json` up to date (every 10 s, and every
minute during long pauses). Over SSH:

```bash
node status.mjs config.json            # one snapshot
node status.mjs config.json --watch    # refreshes every 30 s
```

It shows whether the run is RUNNING, PAUSED (daily limit, with the resume time),
WAITING OUT A CAPTCHA, FINISHED, STOPPED or NOT RUNNING (the process died, so
start it again and it resumes). It also shows the overall % done, cities
done/failed, rows saved, the current city's phase, today's budget use, an ETA
and recent events. `--json` prints the raw status; the exit code is 0 when
finished, 1 while still going, 3 when not running, so cron can check it.

For messages on your phone, set `notify.url` in the config. The easiest is
[ntfy](https://ntfy.sh): pick an unguessable topic, set
`"url": "https://ntfy.sh/<your-topic>"`, and subscribe to the same topic in the
ntfy app. Discord or Slack webhooks work too (`"format": "discord"` or
`"slack"`). You get a message when the run starts, at every `every_percent`
step, when it pauses for the day, when it resumes, on a CAPTCHA, when it stops
and when it finishes or crashes.

The default caps are starting guesses. If you never hit a CAPTCHA, raise them
slowly; the learned caps in `usage.json` show where Google pushed back.

Without systemd (some containers), run it in the background by hand:

```bash
nohup ./service.sh config.json >> output/scrape.log 2>&1 &
```

## Single city run

```bash
xvfb-run -a node run.mjs --country "United States" --city "Chicago" --preset core --out output/chicago.csv
```

Leave it running in `tmux`/`nohup`. Progress prints every 10 seconds. Ctrl+C
saves whatever was collected so far. `node run.mjs --preset list` shows presets;
`--terms "a,b,c"` adds your own. See the header of `run.mjs` for every option.

## Fleet: many servers controlled from your PC

Each server scrapes its own share of the country on its own; your PC is the
remote control over SSH. Nothing has to run on your PC between commands.

1. Get the servers (Ubuntu 22.04/24.04), ideally from 2–3 providers so their
   IPs are not all in one range. Make sure `ssh root@<ip>` works with your key,
   without a password.
2. On your PC, in this folder: write `config.json` (the settings every server
   shares) and copy `fleet.example.json` to `fleet.json` with your servers.
   A server's share is its position in the list, so keep the order fixed.
3. Install and start:

```bash
node fleet.mjs setup        # copy code + config, install everything (≈4 min, all in parallel)
node fleet.mjs start
node fleet.mjs status       # whole-fleet table
```

| Command | Does |
|---|---|
| `status [names]` | State, progress, cities, rows, today's budget, resume time and ETA per server, plus a fleet total |
| `start` / `stop` / `restart [names]` | Controls the service on every server, or only the named ones |
| `logs <name> [lines]` | The end of one server's log |
| `config set <key> <value>` | Changes `config.json` here and on every server, then restarts the running ones (`notify.url` works for nested keys) |
| `update [names]` | Pushes new code after a fix, reinstalls if needed, restarts |
| `collect [names]` | Copies new CSVs and progress into `results/<name>/` (only what changed) |
| `merge` | One CSV from everything in `results/`, duplicates removed |

Shares are round-robin over the largest-first list, so each server gets a fair
mix of big and small places; `node places.mjs list "United States" --min 20000 --shard 3/8`
shows server 3's share. Neighbouring cities' map areas overlap, so the same
place can come from two servers; `merge` keeps one copy (matched by place ID).

To replace a dead server: put the new address in its slot in `fleet.json`, then
`node fleet.mjs setup <name>` and `start <name>`. If you ran `collect` before,
setup gives the new server the old one's progress and budget, so it continues
that share instead of starting over.

Point every server's `notify.url` at one ntfy topic; messages are tagged with
the server name, e.g. `[vps3] United States: Paused for today`.

### Running the fleet from a VPS instead of your PC

Any always-on server can be the controller. `fleet.mjs` only runs short SSH,
tar and rsync commands, so it needs no Chrome and almost no CPU or memory; it
is safe next to other apps.

```bash
# on the controller VPS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -   # distro Node is too old
sudo apt-get install -y git rsync nodejs
git clone -b <branch> <this repo> ~/atlas-controller
cd ~/atlas-controller/headless
ssh-keygen -t ed25519                         # once, if it has no key yet
ssh-copy-id root@<worker-ip>                  # for every worker
cp config.example.json config.json && nano config.json
cp fleet.example.json fleet.json && nano fleet.json
node fleet.mjs setup && node fleet.mjs start
```

Clone into a folder other than `remote_dir` (default `map_extractor`), and
keep the controller out of `fleet.json` unless it should scrape too; if it
should, list it as `root@127.0.0.1` with its own key in `authorized_keys`.
`config.json` and `fleet.json` are git-ignored, so `git pull` on the controller
never overwrites them; run `node fleet.mjs update` afterwards to ship new code.

### Resource caps (sharing a server with other apps)

The service runs inside systemd limits so Chrome can never starve the server's
other apps. Set them in `config.json` under `resources`:

| Key | Default | Meaning |
|---|---|---|
| `cpu_weight` | `10` | Share under contention (normal services have 100). The scraper only gets CPU the others are not using. |
| `cpu_quota` | `100%` | Hard ceiling; `100%` = one core, `50%` = half a core. |
| `memory_high` | `35%` | Above this, Chrome's memory is reclaimed and it slows down. |
| `memory_max` | `45%` | Hard ceiling. Over it the service is killed and restarts a minute later, continuing where it was. |

Percentages are of the server's RAM; absolute values like `"1500M"` work too.
It also runs at `nice 10`, lowest I/O priority, and never swaps. Chrome needs
about 700 MB, so on a 2 GB server raise `memory_max` to `"900M"` or so; if
`scrape.log` shows frequent restarts, memory is too tight. Change a cap on all
servers with `node fleet.mjs config set resources.memory_max 1200M`. Check
actual use on a server with `systemctl status atlas-scraper` (Memory and CPU
lines).

## Depth and details

- `max_results_per_search`: how many cards each search collects. `50` stops
  after 50; `0` takes everything Google shows, which it caps at about 120 per
  search. Breadth beyond that comes from `max_jobs_per_city` (the extension
  splits a city into grid cells and runs each category per cell).
- Phases: every category search for a city runs first. Only then does the
  detail phase open each unique place's page.
- `enrich: true` turns that detail phase on. It fills phone, website, photo,
  opening hours, full address, plus code and categories. `additional_info: true`
  also keeps the amenities block (wheelchair access, payment options, service
  options). Email is not available: Google Maps does not publish business
  emails, so no Maps scraper can return one.
- `detail_delay_seconds` paces the detail phase (default 4). Google throttles
  rapid place-page views; when a page loads without rendering, the extension
  now backs off 15 s then 45 s before retrying.

## Notes

- Pacing: `--term-delay` (default 45 s) is the cooldown between search jobs.
  Lower values get datacenter IPs blocked quickly. Keep one run per server.
- Blocks: if Google shows a CAPTCHA, the run stops with `ACCESS_BLOCKED` and the
  partial CSV is written. Use `--proxy host:port` with a residential proxy, or
  wait and rerun with fewer terms.
- Consent page: EU servers may get Google's consent screen on a fresh profile;
  the run stops with `CONSENT_REQUIRED`. A `--profile DIR` that has already
  accepted it once avoids this.
- Google Chrome 137+ ignores `--load-extension`, so the runner uses the Chrome
  for Testing build npm downloads. `--chrome` must point at Chromium or Chrome
  for Testing, not branded Chrome.
- Keep that browser current. Google scores an old browser build as a bot and
  serves place pages without the detail panel, which shows up as
  `DETAIL_TIMEOUT` errors in the detail phase. If those appear in bulk, run
  `npm update puppeteer` in this folder to pull the newest Chrome for Testing.
