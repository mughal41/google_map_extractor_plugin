# UI v0.6.0 — "Atlas"

Full redesign of the popup, replacing the v0.5.0 single-page form (see
`UI_BASELINE_v0.5.0.md`, tag `ui-v0.5.0`). Synthesized from a three-direction
design exploration (Mission Control / Cartographer's Expedition / Atlas) plus a
platform-constraints audit.

## Concept

A calm, premium four-view flow at 680×584 with one deep-pine accent, tabular
numerals for all data, and hairline borders instead of decoration. The
emotional centerpiece is the **Review screen** — a receipt that itemizes the
run's cost in time before an explicit **Confirm & start**. The fun is carried
by **Pip**, a compass mascot with a face, who doubles as a real instrument:
the popup's brand mark mirrors the live run stage, and during cooldowns Pip's
ring becomes the countdown timer while Pip sleeps.

## Views & routing

| View | Route condition (on popup open) | Contents |
| --- | --- | --- |
| Plan | default | 2-column: numbered form sections (Coverage / Search terms / Options) + sticky summary rail with live estimate, risk pill, `Review plan →` |
| Review | `extractorUi.view === 'review'` and no active run | hero estimate + range + finish clock, itemized receipt, 3-segment risk meter with one-click remedy, itinerary disclosure, `Confirm & start · ~X` |
| Run | `extractorRun.active` (always wins) | Pip hero + stage, progress bar, run grid, 5 stat tiles, message, Stop |
| Results | records exist and stage complete/stopped | outcome receipt, per-term bars, `Export CSV · N rows`, two-step Clear |

Tabs (Plan / Run / Results) follow the APG pattern with roving tabindex and
arrow keys; Review is a step under the Plan tab (`aria-current="step"`), not a
tab. `START_RUN` fires **only** from the Review confirm button. UI state
persists to `extractorUi` (chrome.storage.local + localStorage mirror);
everything reconstructs from storage on reopen, including mid-cooldown
countdowns (derived from stored `nextRunAt` + `cooldownTotalMs`).

## Design tokens (popup.css `:root`)

- Light: bg `#FAFAF8`, surface `#FFF`, text `#1A1D1C`/`#5F6663`, accent
  `#0D7D5C`, warn `#B45309`, danger `#B3261E`.
- Dark (`prefers-color-scheme`): bg `#101413`, surface `#171C1A`, text
  `#ECEFED`/`#9BA5A0`, accent `#34C08F`.
- Type: system UI stack; `ui-monospace` + `tabular-nums` for every numeral.
  Body 13px, minimum 10.5px (caps micro-labels only).
- Motion: 120/160ms `cubic-bezier(.2,0,0,1)`, no bounce; everything gated by
  `prefers-reduced-motion`; all animation transform/opacity only.

## Pip states (`.pip[data-stage=…]` in popup.css)

idle: needle drift · resolving/opening: spin · searching: ±28° sweep ·
waiting: needle fades, eyes close, zzz float, ring depletes (JS sets
`stroke-dashoffset`, `pathLength=100`) · filtering: dash rotation · enriching:
dot pulse · complete: check + smile · stopped: needle at rest · error: wobble +
red ring. Pip is `aria-hidden`; text labels are always authoritative.

## Education layer

Every ⓘ is a real `<button class="info" data-info="key">`; copy lives in
`lib/glossary.js` (18 entries). One delegated controller (`lib/popover.js`),
one reusable panel, hover-intent open (250ms), click pins, Esc closes and is
**consumed** so it never dismisses the popup, flip-aware positioning clamped
inside the shell.

## Estimate engine

`lib/estimate.js`: mirrors the runner's grid sizing, prices 45s/search
(30–70s bounds) + jittered cooldowns + rest breaks from `lib/pacing.js`;
risk = low ≤60 / elevated ≤120 / high >120 worst-case jobs. The receipt shows
a range, never a single number; enrichment is presented as open-ended.
Estimates are recomputed at render time, never trusted from storage.

## Platform decisions (from the constraints audit)

- Shell pinned to 680×584; views scroll internally so the popup never resizes.
- CSV export goes through a background `DOWNLOAD_CSV` message with a data: URL
  (popup-owned blob: URLs die when the popup blurs).
- Live regions (`role=status`/`role=alert`) are pre-rendered; only stage
  transitions are announced — never the per-second countdown.
- Draft echo protection: form inputs are never re-rendered from storage
  changes (only `extractorRun` re-renders).

## Restore points

```bash
git checkout ui-v0.5.0 -- popup.html popup.css popup.js   # previous UI
git tag ui-v0.6.0                                          # this UI
```
