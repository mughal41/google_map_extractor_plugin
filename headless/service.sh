#!/usr/bin/env bash
# Entry point for the atlas-scraper systemd service (installed by setup.sh).
# Starts a virtual display, then replaces itself with the scraper, so the
# service's stop signal reaches node directly and node can save before it
# closes Chrome. Run by hand, it behaves like `xvfb-run -a node scrape.mjs`.
set -euo pipefail
cd "$(dirname "$0")"
CONFIG="${1:-config.json}"

for n in $(seq 99 120); do
  if [ ! -e "/tmp/.X${n}-lock" ]; then DISPLAY_NUM=$n; break; fi
done
mkdir -p output
Xvfb ":${DISPLAY_NUM}" -screen 0 1400x900x24 -nolisten tcp >>output/xvfb.log 2>&1 &
export DISPLAY=":${DISPLAY_NUM}"
for _ in $(seq 1 100); do [ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break; sleep 0.1; done
if [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "Virtual display :${DISPLAY_NUM} did not start; see output/xvfb.log" >&2
  exit 1
fi
exec node scrape.mjs "$CONFIG"
