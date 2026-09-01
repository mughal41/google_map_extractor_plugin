# Google Maps Light Extractor

A local-only Chrome extension that runs an ordered Google Maps search plan by city/country or coordinate/radius, merges duplicate places, and exports UTF-8 CSV. By default it uses only result cards and data Maps has already loaded; detail navigation is optional.

This is an early implementation against an undocumented and changeable Google Maps interface. It can retain already-loaded card/hero images and menu-photo image URLs, but it does not crawl galleries, menu pages, reviews, or business websites, automate CAPTCHAs, or bypass access controls.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository directory (the directory containing `manifest.json`).
5. Pin **Google Maps Light Extractor** if desired.

No build step or dependency installation is required for the extension. Node.js 20 or later is only needed to run its tests.

## Use

The popup ("Atlas") has three tabs — **Plan**, **Run**, **Results** — and a mandatory estimate review between planning and starting. Every technical concept has an ⓘ info icon; hover or click it for a plain-English explanation. The UI follows your system light/dark theme.

1. **Plan** — choose **City & country** or **Coordinates & radius** coverage. Add one search term per line, or click the curated presets (**Core**, **Extended**, **Long tail**, **Civic**). Presets are trimmed so overlapping categories ("doctors"/"clinics", "hair salons"/"beauty salons") are represented by a single term, and each click only adds terms not already listed. Terms run serially in the displayed order, up to 50 per run.
2. In city mode choose a coverage strategy. **Adaptive scan** creates an overlapping initial grid and subdivides cells returning at least 40 cards, up to the selected 50/100/200-job budget.
3. Choose a base cooldown. The default is 30 seconds; each actual cooldown is randomized up to +50%, and after every 8 searches the queue rests roughly six times longer so the request pattern does not look machine-timed. The sticky plan-summary rail shows a live duration estimate and a risk pill as you type.
4. Select **Review plan →**. The review screen prints an itemized receipt — searches, cooldowns, rest breaks, adaptive-refinement ceiling, open-ended enrichment — with a total time range, an expected finish clock, a three-segment risk meter (with a one-click "slow the pace" fix), and the full ordered itinerary.
5. Select **Confirm & start** (the button shows the estimate it commits you to). City mode first asks the normal Maps website to resolve the city center and overview zoom, then derives an approximate rectangular viewport boundary.
6. **Run** — watch the live stage, job progress, countdown to the next search, and stats. The compass mascot doubles as the cooldown timer: its ring depletes second by second. Stop at any time; collected data is kept.
7. **Results** — an outcome receipt (cards → duplicates merged → outside coverage → unique kept), a per-term breakdown, and **Export CSV**. Clearing results asks for a second click before deleting.

The popup may be closed without losing anything: drafts, the staged review, and run state live in `chrome.storage.local`, and the popup reconstructs the right view on reopen — mid-cooldown countdowns included. **Clear results** removes persisted run data after the run has stopped but leaves the form draft intact.

Card status and amenity extraction never causes extra page visits. Popular times is explicitly marked unsupported and disabled.

## How filtering works

Google Maps may return results outside the requested area. The extension extracts coordinates from result links or structured page data and calculates the great-circle distance locally with the Haversine formula and an Earth mean radius of 6,371,008.8 meters. Records without usable coordinates cannot be safely radius-checked and are omitted with a `MISSING_COORDINATES` error. Filtering and deduplication happen before any optional detail navigation. Distance and search metadata remain internal and are not exported.

The primary dedupe key is Google Place ID, then CID. If neither is present, the fallback is normalized name plus coordinates rounded to five decimal places. Distinct non-empty Place IDs are never merged.

## Permissions

- `storage`: preserve progress and results if the popup closes or Maps navigates.
- `tabs`: open the requested Maps search in the active tab and signal a running Maps tab to stop.
- `downloads`: save the generated CSV.
- `https://www.google.com/maps/*`: run the collector only on Google Maps pages.

The extension does not read or store cookies, authorization headers, or session tokens, and does not transmit extracted data to a server.

## CSV

Exports are UTF-8 with a BOM for Excel compatibility, one place per row, quoted according to CSV rules, and use empty cells for unavailable values. Arrays such as categories use ` | ` separators; structured fields use JSON. Large numeric CIDs are emitted as Excel text formulas so every digit survives instead of becoming scientific notation. The complete stable column order is defined in `lib/schema.js`.

`confidence` is an extraction-confidence score from 0 to 1. It rewards a verified Place ID/CID, name, coordinates, and useful loaded fields. It describes record completeness/identity reliability; it is not a Google rating or a match against an external reference record.

Example filename:

```text
google_maps_pharmacy_31.5204_74.3587_5000m_20260831T094300Z.csv
```

City plans use names such as `google_maps_lahore_pakistan_batch_20260831T094300Z.csv`.

A schema-compatible example is in `samples/google_maps_sample.csv`.

## Stop and recovery

**Stop** cancels future scrolling and detail loads. Results already persisted remain exportable. A transient missing detail page is retried once. A CAPTCHA, unusual-traffic page, or blocking consent interstitial stops the run and reports a clear error; complete any required interaction manually and start a new run.

## Debugging and troubleshooting

Enable **Debug logging** in Options, then inspect the Google Maps tab's DevTools console. Logs use stable codes such as `CANDIDATE_DISCOVERED`, `PARSER_SCHEMA_MISMATCH`, `MISSING_COORDINATES`, and `DETAIL_TIMEOUT`. Sensitive request headers are never logged.

If the extension reports `SEARCH_FEED_NOT_FOUND`, confirm that:

- the current Google domain is `www.google.com` and the URL begins with `/maps/`;
- a normal Maps result list is visible rather than a consent, sign-in, or CAPTCHA page;
- Chrome has reloaded the unpacked extension after source changes.

Google Maps DOM selectors and internal response formats are not stable APIs. The extractor uses semantic roles, ARIA attributes, Maps URLs, JSON-LD, and a guarded response adapter. When one source changes, unavailable fields remain null and partial valid data can still be exported. Selector/parser maintenance may be needed after a Maps UI update.

## Development

Run the unit tests:

```bash
npm test
```

The code is split into pure modules under `lib/`, a page-world response observer in `injected.js`, the resumable workflow in `content.js`, and popup/background extension entry points. The observer clones only already-loaded Maps responses, caps inspected response text, and leaves the original `fetch` and XHR behavior intact.

## Current limitations

- Google Maps coverage and result ordering are controlled by Google. A city plan combines explicit term searches; it is not a guarantee that Maps will expose every place in the administrative boundary.
- City mode uses the center and overview zoom resolved by the normal Maps website. Grid and adaptive modes scan that approximate rectangular viewport and filter coordinate-bearing results against it; they do not download an administrative boundary polygon.
- Phone numbers without an international prefix are normalized only when an explicit supported country code is present in structured address data; otherwise they remain null rather than guessing.
- Google does not put every field in the search response. A card-only run cannot guarantee phone, weekly hours, website, or menu images for every result. Enable **Open place pages for missing details** when those fields matter.
- Optional enrichment navigates one qualifying detail page at a time and skips records that already have the important fields.
- `g_menu_image_urls` contains only direct image resources found in an already-loaded Menu context. Website pages, social posts, PDFs, ordering links, and ordinary `/menu` pages are rejected. Multiple image URLs use ` | ` in CSV.
- Fields absent from loaded result/detail data remain blank. The extension will not open galleries, menu pages, reviews, hours, About, amenities, reservations, or ordering panels to fill them.
- Changing the active Maps tab or manually navigating it during a run can interrupt the state machine.
