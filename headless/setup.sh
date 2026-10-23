#!/usr/bin/env bash
# One-command VPS setup for the Atlas headless runner (Ubuntu/Debian, as root or a sudo user).
# Installs Chrome for Testing (via npm), Node 22, xvfb (virtual display), the runner's npm
# deps, and the atlas-scraper systemd service, which runs `scrape.mjs config.json`, starts
# on boot and restarts after a crash. Safe to re-run: finished steps are skipped.
#
#   ./setup.sh              install everything, then (re)start the scraper
#   ./setup.sh --no-start   install everything, do not start (fleet.mjs uses this)
set -euo pipefail
cd "$(dirname "$0")"
START=1; [ "${1:-}" = "--no-start" ] && START=0

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Branded Google Chrome 137+ ignores --load-extension, so the runner uses the
# Chrome for Testing build that npm downloads. These are its system libraries.
echo "==> Installing Chrome for Testing system libraries"
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends ca-certificates curl unzip rsync fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 \
  libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils 2>/dev/null \
  || $SUDO apt-get install -y --no-install-recommends ca-certificates curl unzip rsync fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "==> Installing xvfb (virtual display so Chrome can run without a GUI)"
  $SUDO apt-get install -y --no-install-recommends xvfb
else
  echo "==> xvfb present"
fi

# Puppeteer 25 needs Node 22.12 or newer.
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  echo "==> Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y --no-install-recommends nodejs
else
  echo "==> Node present: $(node -v)"
fi

if [ ! -d node_modules/puppeteer ] || [ ! -x "$(node -e 'import("puppeteer").then(async (m) => console.log(await m.default.executablePath()))' 2>/dev/null)" ]; then
  echo "==> Installing runner dependencies (downloads Chrome for Testing, ~150 MB)"
  npm install --no-audit --no-fund
  # npm skips puppeteer's download when node_modules already exists, and a
  # failed unpack leaves an empty build folder that blocks a retry. Remove that
  # folder, then make sure the browser is really there.
  chrome_bin="$(node -e 'import("puppeteer").then(async (m) => console.log(await m.default.executablePath()))')"
  if [ ! -x "$chrome_bin" ]; then
    rm -rf "$(dirname "$(dirname "$chrome_bin")")"
    npx puppeteer browsers install chrome
  fi
else
  echo "==> Runner dependencies present"
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo
  echo "Created config.json from config.example.json."
  echo "Edit it (country, categories, daily limits, notify.url), then run ./setup.sh again to start."
  exit 0
fi
node -e 'JSON.parse(require("fs").readFileSync("config.json", "utf8"))' \
  || { echo "config.json is not valid JSON; fix it and run ./setup.sh again."; exit 1; }

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo
  echo "No systemd here, so no service was installed. Start the scraper by hand:"
  echo "  nohup ./service.sh config.json >> output/scrape.log 2>&1 &"
  exit 0
fi

# Resource caps for the service (config.json "resources"), so the scraper never
# starves other apps on the same server. Low CPU weight means it only gets CPU
# the other services are not using; memory_high throttles Chrome, memory_max is
# the hard ceiling (over it the service is killed and restarts a minute later).
read -r CPU_QUOTA CPU_WEIGHT MEM_HIGH MEM_MAX <<<"$(node -e '
  const r = JSON.parse(require("fs").readFileSync("config.json", "utf8")).resources || {};
  console.log([r.cpu_quota ?? "100%", r.cpu_weight ?? 10, r.memory_high ?? "35%", r.memory_max ?? "45%"].join(" "));
')"
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "${TOTAL_MB:-0}" -lt 2000 ]; then
  echo "WARNING: this server has only ${TOTAL_MB} MB RAM. Chrome needs ~700 MB; with memory_max ${MEM_MAX} it may be killed often."
fi
echo "==> Resource caps: CPU ${CPU_QUOTA} (weight ${CPU_WEIGHT}), memory soft ${MEM_HIGH} / hard ${MEM_MAX} of ${TOTAL_MB} MB"

echo "==> Installing the atlas-scraper service"
HERE="$(pwd)"
$SUDO tee /etc/systemd/system/atlas-scraper.service >/dev/null <<UNIT
[Unit]
Description=Atlas Google Maps scraper (${HERE})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${HERE}
ExecStart=${HERE}/service.sh config.json
Environment=HOME=${HOME}
Environment=PATH=$(dirname "$(command -v node)"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
StandardOutput=append:${HERE}/output/scrape.log
StandardError=append:${HERE}/output/scrape.log
# A crash or kill restarts after a minute. Exit 0 (all done), 3 (CAPTCHA or
# consent: needs a human), 4 (profile in use) and 5 (stopped by a signal)
# stay stopped.
Restart=on-failure
RestartSec=60
SuccessExitStatus=5
RestartPreventExitStatus=3 4 5
# Stop sends SIGTERM to node only; it saves partial results and closes Chrome.
# Whatever is left after 90 s (Xvfb, a stuck Chrome) is killed.
KillMode=mixed
TimeoutStopSec=90
PrivateTmp=true
# Stay out of the way of other services on this server (see "resources").
CPUQuota=${CPU_QUOTA}
CPUWeight=${CPU_WEIGHT}
MemoryHigh=${MEM_HIGH}
MemoryMax=${MEM_MAX}
MemorySwapMax=0
TasksMax=512
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p output
$SUDO systemctl daemon-reload
$SUDO systemctl enable atlas-scraper >/dev/null 2>&1

echo
if [ "$START" = 1 ]; then
  $SUDO systemctl restart atlas-scraper
  echo "Scraper started. It also starts on boot and restarts after a crash."
else
  echo "Service installed (not started)."
fi
echo "  progress:   node status.mjs config.json [--watch]"
echo "  log:        tail -f output/scrape.log"
echo "  stop/start: sudo systemctl stop atlas-scraper / sudo systemctl start atlas-scraper"
