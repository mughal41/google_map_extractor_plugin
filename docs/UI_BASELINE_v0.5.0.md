# UI Baseline — v0.5.0

Snapshot of the popup UI as of version 0.5.0 (tagged `ui-v0.5.0`). This is the
reference point for UI experiments; to compare or restore, diff against or check
out the tag.

```bash
git diff ui-v0.5.0 -- popup.html popup.css popup.js
git checkout ui-v0.5.0 -- popup.html popup.css popup.js   # full restore
```

## Files that define the UI

| File | Role |
| --- | --- |
| `popup.html` | Structure and all user-facing copy |
| `popup.css` | Visual design (single stylesheet, no build step) |
| `popup.js` | Form state, draft persistence, presets, plan summary, live run rendering |
| `lib/presets.js` | Curated term presets rendered as chips |
| `lib/pacing.js` | Cooldown jitter/rest math reused by the plan-summary estimate |

## Design language

- **Layout**: single 420px-wide column; two numbered card sections (coverage,
  search terms), a collapsible "Data and request options" `<details>`, primary
  action row, live status card, footer actions (export / clear).
- **Palette**: green-on-paper. Background `#f7f9f7` with a soft radial tint;
  brand/action green `#276c45`–`#39714e`; card surfaces translucent white with
  `#dbe4dd`-family borders; amber warning `#7a5c1d` on `#fdf6e2`; error red
  `#a33c37`.
- **Type**: Inter (system fallback) for UI; Georgia serif only for the `h1` and
  brand mark. Hierarchy: h1 26px · section titles 12px · labels 10.5px · body
  notes 9.5–10.5px · uppercase micro-labels 7.5–8px · stat values 13px.
- **Shape**: 9–13px border radii, subtle shadows, pill badges, 4px progress bar
  with green gradient.

## Key components

- **Mode switch** — segmented radio pair (City & country / Coordinates &
  radius), white "raised" chip for the active mode. Switching toggles
  `#city-fields` / `#coordinate-fields` visibility and disables hidden inputs.
- **Preset chips** (`#preset-row`) — one `.mini-button` per entry in
  `TERM_PRESETS` labeled `+ Core (22)` etc.; tooltip = preset description.
  Clicking merges terms into the textarea (deduped, capped at `MAX_TERMS` 50
  with an explanatory message when trimmed).
- **Term counter** (`#term-count`) — `N / 50 terms`, amber `.at-limit` class at
  the cap.
- **Plan summary** (`#plan-summary`) — green tinted box; recomputed on every
  input: initial job count, cell shape, total-time estimate including jitter
  averages and rest breaks (`estimatedCooldownTotalMs`).
- **Plan warning** (`#plan-warning`) — amber box, hidden by default; appears
  above ~60 planned searches, stronger wording above ~120.
- **Status card** — stage dot (grey idle / pulsing green active / red error),
  stage label, job badge pill, live message, 2-column run-plan grid (resolved
  area, current job, next action, scan info), progress bar, and a 5-stat strip
  (Cards / Unique / In coverage / Jobs / Errors).

## Behavior contracts worth keeping in any redesign

- Draft inputs persist on every `input`/`change` and `pagehide` to both
  `localStorage` and `chrome.storage.local`; reopening the popup restores them.
- Live state renders from `chrome.storage.onChanged` on `extractorRun`; a 1s
  interval re-renders only while a cooldown countdown (`nextRunAt`) is active.
- `tests/popup.test.js` asserts specific copy strings exist in `popup.html`
  (mode labels, cooldown label, run-detail labels, card-only vs detail-visit
  wording, disabled popular-times). Change those strings and the tests together.
- Start is disabled while a run is active; Stop only enabled during one; Export
  only enabled when records exist; Clear refuses while active.
- All copy explains *why*, not just *what* (e.g. cooldown randomization note,
  preset overlap note, rate-limit warnings).
