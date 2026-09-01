# Google Maps Lightweight Place Extractor — Codex Implementation Spec

## Goal

Build a **lightweight Google Maps place extraction tool** that accepts:

- starting latitude
- starting longitude
- search term
- radius in meters

It should search Google Maps around the supplied location, collect places until the visible result feed reaches the end, extract a rich but lightweight set of business/place fields, filter results by the requested radius, deduplicate them, and export the final data to CSV.

The implementation must prioritize:

1. **Low request/load overhead**
2. **No image scraping**
3. **No review scraping**
4. **No opening secondary panels unless absolutely necessary**
5. **No deliberate bypassing of anti-bot protections, rate limits, CAPTCHAs, or access controls**
6. **Reuse data already loaded by Google Maps whenever possible**
7. **One pass over search results + at most one detail load per qualifying place**
8. **Graceful failure if Google changes internal selectors or payload structure**

> Important: Google Maps internal payload structures and DOM selectors are undocumented and can change at any time. Build the extractor with adapters/fallbacks and clear error logging rather than hard-coding the entire program around one fragile selector.

---

# Preferred Implementation

Build this as a **Chrome Extension using Manifest V3**.

The extension should work on:

```text
https://www.google.com/maps/*
```

Preferred structure:

```text
google-maps-light-extractor/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── background.js
├── content.js
├── injected.js
├── lib/
│   ├── parser.js
│   ├── normalizers.js
│   ├── distance.js
│   ├── taxonomy.js
│   ├── csv.js
│   ├── dedupe.js
│   └── logger.js
├── tests/
└── README.md
```

If Chrome MV3 makes reliable interception of the needed Google Maps background responses impractical, implement a **Node.js + Playwright CLI version** using the same parsing modules.

Do not duplicate parsing logic between the browser extension and Playwright implementation.

---

# User Inputs

The popup/interface should contain:

```text
Latitude
Longitude
Search term
Radius in meters
```

Example:

```json
{
  "lat": 31.5204,
  "lng": 74.3587,
  "term": "pharmacy",
  "radius_m": 5000
}
```

Optional settings:

```text
Include popular times       false by default
Include additional info     true by default
Exclude sponsored results   true by default
Detail concurrency          1 by default, maximum 2
```

Buttons:

```text
Start Search
Stop
Export CSV
Clear Results
```

Display live status:

```text
Search results discovered: 184
Unique Place IDs: 171
Inside radius: 129
Details enriched: 87 / 129
Errors: 2
```

---

# Search URL / Location

Navigate Google Maps to the requested search query centered around the supplied latitude/longitude.

Prefer generating a Maps search URL that includes coordinates/zoom/search term where practical.

Do **not** assume Google Maps will strictly enforce the requested radius.

Radius enforcement must happen locally after coordinates are extracted.

---

# Main Pipeline

Use this pipeline:

```text
LAT + LNG + TERM + RADIUS
        |
        v
Open Google Maps search
        |
        v
Attach lightweight data listeners
        |
        v
Scroll result feed
        |
        v
Observe/search payloads already loaded by Maps
        |
        v
Extract preliminary place records
        |
        v
Deduplicate by Google Place ID
        |
        v
Calculate Haversine distance
        |
        v
Discard places outside requested radius
        |
        v
Stop when end-of-list is reached
        |
        v
Open/enrich qualifying places only
        |
        v
Read embedded place data + visible DOM
        |
        v
NO reviews / NO images / NO secondary crawling
        |
        v
Normalize
        |
        v
CSV export
```

---

# Search Result Collection

The search result collector should:

1. Identify the Google Maps results feed.
2. Scroll the result feed gradually.
3. Observe data already returned by Google Maps.
4. Extract candidate place information.
5. Continue until the end of the result list.

Do not rely on a single generated CSS class.

Prefer stable selectors such as:

```text
role
aria-label
data-item-id
href
semantic text
```

End detection should use multiple signals.

Primary signal:

```text
You've reached the end of the list.
```

Fallback signals:

```text
No new Place IDs after 3 consecutive scroll cycles
AND
scrollHeight has stopped increasing
AND
results feed is near its maximum scroll position
```

Do not spin forever.

Maximum stalled cycles:

```text
3
```

Recommended scroll pause:

```text
1500–3000 ms
```

Use jitter.

Example:

```js
const delay = 1500 + Math.random() * 1500;
```

Do not aggressively scroll multiple times per second.

---

# Network / Embedded Data Strategy

Prefer data that Google Maps has already loaded for its own frontend.

Possible sources:

1. Search-result background responses
2. Embedded page state
3. Structured data available in the page
4. Semantic DOM fallback
5. Current Maps URL

Do not directly hammer undocumented Google Maps endpoints with custom HTTP request loops.

Preferred model:

```text
Google Maps page performs request
        |
        v
extension/script observes the already-loaded result
        |
        v
parser extracts useful fields
```

If using page-context interception, ensure original fetch/XHR behavior is preserved exactly.

Never block or modify Maps requests unless required for instrumentation.

---

# Required Output Fields

Use this schema.

## Identity

```text
g_place_id
g_cid
g_name
g_subtitle
```

### `g_place_id`

Google Place ID if available.

Use as the primary dedupe key.

### `g_cid`

Google Maps CID if available.

Do not fail a record if CID is unavailable.

---

# Categories

```text
g_category
g_categories
```

### `g_category`

Primary Google Maps category.

Example:

```text
Pharmacy
Dentist
Restaurant
Supermarket
```

### `g_categories`

All available categories.

Store internally as an array.

For CSV serialize as:

```text
Pharmacy | Medical supply store | Health consultant
```

---

# Address Fields

Extract when available:

```text
g_address
g_street
g_neighborhood
g_city
g_state
g_postal_code
g_country_code
g_plus_code
g_located_in
```

### `g_address`

Full formatted address.

### `g_located_in`

Containing shopping mall, building, hospital, complex, etc.

Example:

```text
Located in: Packages Mall
```

---

# Contact Fields

```text
g_phone
g_website
```

### `g_phone`

Normalize to E.164 where possible.

Use a proper phone normalization library.

Recommended:

```text
libphonenumber-js
```

Store null if safe normalization is impossible.

Do not invent country calling codes without enough context.

### `g_website`

Canonicalize locally.

Normalization:

```text
lowercase hostname
strip trailing slash where safe
remove obvious tracking parameters
preserve meaningful path
```

Do not visit the business website.

---

# Coordinates

```text
g_lat
g_lng
distance_m
```

Coordinates may come from:

```text
search payload
embedded place state
Maps URL
```

Calculate `distance_m` locally using Haversine distance.

---

# Haversine Radius Filter

Implement:

```js
distanceMeters(searchLat, searchLng, placeLat, placeLng)
```

Use Earth's mean radius:

```text
6371008.8 meters
```

Only retain records where:

```text
distance_m <= search_radius_m
```

Allow a configurable tolerance if desired:

```text
radius_tolerance_m = 10
```

Default:

```text
0
```

Do not rely solely on the visible Maps viewport.

---

# Rating / Price

Extract:

```text
g_rating
g_price_level
```

### `g_rating`

Floating point.

Example:

```text
4.6
```

Do not crawl individual reviews.

### `g_price_level`

Examples:

```text
$
$$
$$$
$$$$
```

or null.

---

# Opening Hours

Extract:

```text
g_hours
```

Preferred internal representation:

```json
{
  "mon": [["09:00", "18:00"]],
  "tue": [["09:00", "18:00"]],
  "wed": [["09:00", "18:00"]],
  "thu": [["09:00", "18:00"]],
  "fri": [["09:00", "18:00"]],
  "sat": [["10:00", "15:00"]],
  "sun": []
}
```

Support split hours:

```json
{
  "mon": [
    ["09:00", "13:00"],
    ["14:00", "18:00"]
  ]
}
```

Support 24-hour businesses.

Support closed days.

For CSV serialize to one field:

```text
Mon 09:00-18:00 | Tue 09:00-18:00 | Wed 09:00-18:00 | Thu 09:00-18:00 | Fri 09:00-18:00 | Sat 10:00-15:00 | Sun Closed
```

Extraction priority:

```text
embedded structured data
visible already-loaded DOM
otherwise null
```

Do not open/click a separate hours panel merely to obtain hours.

---

# Operational Status

Extract:

```text
g_temporarily_closed
g_permanently_closed
```

Use booleans.

Unknown should remain:

```text
null
```

Do not convert unknown to false.

---

# Search Metadata

Add:

```text
g_is_ad
g_rank
g_maps_url
search_term
search_lat
search_lng
search_radius_m
verified_at
```

### `g_is_ad`

Whether result appears sponsored/advertised.

Default behavior:

```text
exclude sponsored results = true
```

But preserve the field when included.

### `g_rank`

Search position as discovered.

If the same place appears multiple times, keep the lowest/best rank.

### `verified_at`

UTC ISO 8601 timestamp.

Example:

```text
2026-08-31T09:43:00.000Z
```

---

# Additional Information

Extract lightweight business attributes if they already exist in embedded place data.

Field:

```text
g_additional_info
```

Possible contents:

```json
{
  "Accessibility": {
    "Wheelchair accessible entrance": true
  },
  "Payments": {
    "Credit cards": true
  },
  "Service options": {
    "Delivery": true,
    "Takeout": true
  },
  "Amenities": {
    "Wi-Fi": true
  }
}
```

Important:

```text
If already present in page data -> extract.
If extraction requires clicking/opening another panel -> skip.
```

CSV serialization:

```text
JSON.stringify(g_additional_info)
```

---

# Popular Times

Optional.

Disabled by default.

Fields:

```text
g_popular_times
g_live_busyness_percent
g_live_busyness_text
```

Only extract if already present in the loaded place payload.

Do not trigger extra requests or clicks to obtain it.

Example:

```json
{
  "monday": {
    "09": 20,
    "10": 35,
    "11": 57,
    "12": 74
  }
}
```

---

# Deliberately Excluded Data

Do NOT extract:

```text
photos
photo URLs
photo counts
review bodies
reviewer names
reviewer profiles
review dates
owner replies
review pagination
review histograms requiring extra requests
people-also-search
similar places
image galleries
reservation inventory
ordering flows
third-party delivery pages
deep menu content
```

Do not click:

```text
Reviews
Photos
More
About
Amenities
Menu
Reservations
Orders
```

unless a field is already present without the click.

---

# Lightweight Enrichment Strategy

Use two passes.

## Pass 1 — Discovery

While scrolling search results, collect as much as available cheaply.

Possible preliminary fields:

```text
g_place_id
g_name
g_category
g_categories
g_address
g_street
g_neighborhood
g_city
g_state
g_postal_code
g_country_code
g_website
g_lat
g_lng
g_is_ad
g_rank
g_maps_url
```

Immediately calculate distance when coordinates are available.

Immediately reject records outside the requested radius.

Deduplicate before detail enrichment.

---

# Pass 2 — Detail Enrichment

Only enrich unique places that survive radius filtering.

Target:

```text
at most one detail page load per qualifying place
```

Enrich:

```text
g_cid
g_subtitle
g_phone
g_rating
g_price_level
g_hours
g_plus_code
g_located_in
g_temporarily_closed
g_permanently_closed
g_additional_info
optional popular times
```

Prefer reading structured embedded data.

Fallback to already-visible semantic DOM.

Do not perform additional navigation.

---

# Concurrency / Load Control

Default:

```text
search scrolling concurrency: 1
detail concurrency: 1
```

Allow:

```text
detail concurrency: maximum 2
```

Do not allow values above 2 in the UI.

Add jitter between detail loads.

Recommended:

```text
1500–3000 ms
```

Do not implement rapid parallel scraping.

Do not attempt to evade rate limits.

If Maps responds with:

```text
CAPTCHA
unusual traffic
temporary block
consent/interstitial preventing operation
```

stop the run and show a clear message.

Do not automate CAPTCHA solving.

---

# Retry Policy

Maximum retries:

```text
1 retry per place
```

Only retry transient failures such as:

```text
navigation timeout
temporary page load failure
missing page state after first load
```

Do not retry endlessly.

Store failed Place IDs in:

```text
errors[]
```

Example:

```json
{
  "place_id": "ChIJ...",
  "stage": "detail",
  "error": "DETAIL_TIMEOUT"
}
```

---

# Deduplication

Primary key:

```text
g_place_id
```

Fallback if unavailable:

```text
normalized name
+
rounded coordinates
```

Example fallback key:

```text
normalize(name) + "|" + lat.toFixed(5) + "|" + lng.toFixed(5)
```

Never merge two different non-empty Place IDs.

When duplicate observations occur:

```text
keep best available non-null data
keep lowest g_rank
preserve first discovery timestamp
```

---

# Confidence Score

Field:

```text
confidence
```

This is for reconciling the Google result with an existing internal record.

If no internal reference record was supplied:

```text
confidence = null
```

If reference data exists:

```text
reference_name
reference_lat
reference_lng
```

calculate:

```text
confidence =
    0.70 * name_similarity
  + 0.30 * distance_score
```

Recommended distance score:

```js
Math.exp(-distanceMeters / 150)
```

Name normalization:

```text
lowercase
unicode normalize
strip punctuation
collapse whitespace
remove obvious legal suffixes when appropriate
```

Possible legal suffixes:

```text
Ltd
LLC
Inc
Pvt Ltd
Limited
Company
Co
```

Do not over-normalize meaningful business names.

Preferred similarity:

```text
Jaro-Winkler
or
token-set similarity
```

Confidence must be in:

```text
0.0–1.0
```

Suggested interpretation:

```text
>= 0.90        strong match
0.75–0.899     likely match
0.50–0.749     manual review
< 0.50         likely different
```

---

# CSV Columns

Default CSV order:

```text
g_place_id
g_cid
g_name
g_subtitle
g_category
g_categories
g_address
g_street
g_neighborhood
g_city
g_state
g_postal_code
g_country_code
g_plus_code
g_located_in
g_phone
g_website
g_lat
g_lng
distance_m
g_rating
g_price_level
g_hours
g_temporarily_closed
g_permanently_closed
g_is_ad
g_rank
g_maps_url
g_additional_info
g_popular_times
g_live_busyness_percent
g_live_busyness_text
search_term
search_lat
search_lng
search_radius_m
verified_at
confidence
```

Optional popular-time columns should still exist but be blank/null when the feature is disabled.

CSV requirements:

```text
UTF-8
proper quote escaping
Excel-compatible
one place per row
do not write literal "undefined"
use empty cell for null
```

Suggested filename:

```text
google_maps_<sanitized_term>_<lat>_<lng>_<radius>m_<timestamp>.csv
```

Example:

```text
google_maps_pharmacy_31.5204_74.3587_5000m_20260831T094300Z.csv
```

---

# Parser Architecture

Do not place all extraction logic in one file.

Use adapters.

Example:

```js
extractSearchPayload(raw)
extractPlaceEmbeddedState(raw)
extractPlaceDOM(document)
extractCoordinatesFromUrl(url)
```

Return partial records.

Example:

```js
{
  g_place_id: "...",
  g_name: "...",
  g_lat: 31.52,
  g_lng: 74.35
}
```

Then merge partial records through:

```js
mergePlaceRecord(existing, candidate)
```

Use a clear source priority.

Recommended:

```text
structured embedded place state
search response structured data
semantic visible DOM
URL parsing
```

But prefer whichever source is demonstrably more accurate for a particular field.

---

# Fragile Internal Array Payloads

Google Maps may expose data in deeply nested arrays.

Do not scatter magic indexes throughout the code.

Bad:

```js
const placeId = data[78];
const categories = data[13];
const location = data[9];
```

Preferred:

```js
const IDX = {
  PLACE_ID: 78,
  CATEGORIES: 13,
  LOCATION: 9
};
```

Better:

```text
src/parsers/googlePayloadVersionA.js
```

Create a parser adapter with validation.

Example:

```js
function looksLikePlaceRecord(value) {
  return (
    Array.isArray(value) &&
    containsCoordinatePair(value) &&
    containsPlausiblePlaceId(value)
  );
}
```

Validate before trusting positions.

If payload format changes:

```text
log PARSER_SCHEMA_MISMATCH
continue with DOM fallback
```

Do not crash the whole run.

---

# DOM Selectors

Avoid generated class names as the only selector.

Prefer:

```text
[role="feed"]
aria-label
data-item-id
button[data-item-id*="address"]
button[data-item-id*="phone"]
a[href]
semantic text
```

Create selector arrays.

Example:

```js
const PHONE_SELECTORS = [
  'button[data-item-id*="phone"]',
  'button[aria-label*="Phone"]'
];
```

Try each safely.

---

# Stopping Conditions

Search collection finishes if any of these occurs:

### Condition A

Text found:

```text
You've reached the end of the list.
```

### Condition B

No new Place IDs for 3 cycles.

### Condition C

Feed:

```text
scrollTop + clientHeight >= scrollHeight - tolerance
```

and scroll height has not changed for 3 cycles.

### Condition D

User presses Stop.

Do not rely on only one condition.

---

# Progress Events

Emit progress messages:

```js
{
  stage: "searching",
  discovered: 145,
  unique: 137,
  insideRadius: 102
}
```

```js
{
  stage: "enriching",
  completed: 48,
  total: 102,
  errors: 1
}
```

Stages:

```text
idle
opening_search
searching
filtering
enriching
complete
stopped
error
```

---

# Local Persistence

During a run, store results in:

```text
IndexedDB
```

or extension storage if data volume is small.

Prefer IndexedDB for hundreds/thousands of records.

Persist enough state so accidental popup closure does not destroy the active run.

---

# Logging

Add a debug mode.

Log:

```text
search response detected
candidate Place ID discovered
duplicate skipped
outside radius skipped
detail page loaded
field parser failure
payload schema mismatch
DOM fallback used
record completed
```

Never log:

```text
authentication cookies
session tokens
sensitive headers
```

---

# Security

Do not collect:

```text
Google account cookies
authorization headers
session identifiers
personal user data
```

Do not transmit extracted data to an external server unless explicitly configured.

Default:

```text
all processing local
```

---

# Graceful Failure

If Maps changes and a parser breaks:

1. Continue extracting other fields.
2. Leave unavailable field null.
3. Log parser failure.
4. Export partial valid results.
5. Do not terminate the entire run because one field failed.

---

# Example Final Record

```json
{
  "g_place_id": "ChIJxxxxxxxxxxxx",
  "g_cid": "1234567890123456789",
  "g_name": "Example Pharmacy",
  "g_subtitle": null,
  "g_category": "Pharmacy",
  "g_categories": [
    "Pharmacy",
    "Medical supply store"
  ],
  "g_address": "123 Example Road, Lahore, Punjab 54000, Pakistan",
  "g_street": "123 Example Road",
  "g_neighborhood": "Gulberg",
  "g_city": "Lahore",
  "g_state": "Punjab",
  "g_postal_code": "54000",
  "g_country_code": "PK",
  "g_plus_code": "H8XX+XX Lahore",
  "g_located_in": null,
  "g_phone": "+924212345678",
  "g_website": "https://example.com",
  "g_lat": 31.5208,
  "g_lng": 74.3591,
  "distance_m": 62.4,
  "g_rating": 4.5,
  "g_price_level": null,
  "g_hours": {
    "mon": [["09:00", "18:00"]],
    "tue": [["09:00", "18:00"]],
    "wed": [["09:00", "18:00"]],
    "thu": [["09:00", "18:00"]],
    "fri": [["09:00", "18:00"]],
    "sat": [["10:00", "15:00"]],
    "sun": []
  },
  "g_temporarily_closed": false,
  "g_permanently_closed": false,
  "g_is_ad": false,
  "g_rank": 7,
  "g_maps_url": "https://www.google.com/maps/place/...",
  "g_additional_info": {
    "Accessibility": {
      "Wheelchair accessible entrance": true
    }
  },
  "g_popular_times": null,
  "g_live_busyness_percent": null,
  "g_live_busyness_text": null,
  "search_term": "pharmacy",
  "search_lat": 31.5204,
  "search_lng": 74.3587,
  "search_radius_m": 5000,
  "verified_at": "2026-08-31T09:43:00.000Z",
  "confidence": null
}
```

---

# Performance Target

The program should optimize for low overhead rather than maximum scraping speed.

Desired behavior:

```text
one active search feed
one detail page at a time by default
maximum detail concurrency = 2
no review crawling
no photo crawling
no deep secondary panels
no business website requests
radius filter before enrichment
dedupe before enrichment
```

Avoid loading the same Place ID twice.

---

# Acceptance Tests

## Test 1 — Basic Search

Input:

```text
lat: valid coordinate
lng: valid coordinate
term: pharmacy
radius: 3000
```

Expected:

```text
search opens
multiple results discovered
results deduplicated
all exported coordinates are inside 3000 m
CSV downloads successfully
```

---

## Test 2 — Duplicate Place

If the same Place ID appears multiple times:

```text
only one CSV row is produced
best rank is preserved
non-null fields are merged
```

---

## Test 3 — Outside Radius

If Maps returns a place outside radius:

```text
it is discarded before detail enrichment
```

---

## Test 4 — Missing Phone

Place with no phone:

```text
g_phone = null
no crash
```

---

## Test 5 — Missing Hours

Place with no hours:

```text
g_hours = null
no click is performed
```

---

## Test 6 — End Detection

Search should stop when:

```text
You've reached the end of the list.
```

or fallback stall conditions are met.

---

## Test 7 — Google Payload Changes

Simulate a malformed payload.

Expected:

```text
parser reports schema mismatch
DOM fallback runs
run continues
```

---

## Test 8 — User Stop

User presses Stop.

Expected:

```text
scrolling stops
new detail loads stop
existing collected results remain exportable
```

---

## Test 9 — Popular Times Disabled

Default run:

```text
no extra action performed for popular times
fields remain null when unavailable
```

---

## Test 10 — No Reviews or Images

Automated tests or instrumentation must verify:

```text
no review panel navigation
no photo gallery navigation
no review pagination logic
no image extraction logic
```

---

# README Requirements

README should explain:

```text
installation
Chrome extension loading
permissions
input fields
how radius filtering works
CSV fields
known Google Maps fragility
troubleshooting
debug mode
limitations
```

Also clearly state that Google Maps page structure and internal payloads are not stable APIs and may change.

---

# Implementation Quality

Use:

```text
modern JavaScript / TypeScript preferred
ES modules where possible
small testable functions
no giant scraper function
no global mutable state where avoidable
AbortController for cancellation where practical
clear JSDoc/types
structured error codes
```

TypeScript is preferred.

Recommended types:

```ts
type PlaceRecord = {
  g_place_id: string | null;
  g_cid: string | null;
  g_name: string | null;
  g_subtitle: string | null;
  g_category: string | null;
  g_categories: string[];
  g_address: string | null;
  g_street: string | null;
  g_neighborhood: string | null;
  g_city: string | null;
  g_state: string | null;
  g_postal_code: string | null;
  g_country_code: string | null;
  g_plus_code: string | null;
  g_located_in: string | null;
  g_phone: string | null;
  g_website: string | null;
  g_lat: number | null;
  g_lng: number | null;
  distance_m: number | null;
  g_rating: number | null;
  g_price_level: string | null;
  g_hours: Record<string, [string, string][]> | null;
  g_temporarily_closed: boolean | null;
  g_permanently_closed: boolean | null;
  g_is_ad: boolean | null;
  g_rank: number | null;
  g_maps_url: string | null;
  g_additional_info: Record<string, unknown> | null;
  g_popular_times: Record<string, unknown> | null;
  g_live_busyness_percent: number | null;
  g_live_busyness_text: string | null;
  search_term: string;
  search_lat: number;
  search_lng: number;
  search_radius_m: number;
  verified_at: string;
  confidence: number | null;
};
```

---

# Important Design Rule

The project should be designed around this principle:

```text
EXTRACT EVERYTHING USEFUL FROM DATA GOOGLE MAPS ALREADY LOADED,
BUT DO NOT CAUSE EXTRA DEEP CRAWLING JUST TO FILL OPTIONAL FIELDS.
```

Priority:

```text
identity
coordinates
category
address
contact info
rating
hours
status
lightweight attributes
```

Skip expensive fields rather than slowing or destabilizing the whole run.

---

# Final Deliverables

Codex should produce:

```text
1. Complete source code
2. manifest.json
3. popup UI
4. content/injected scripts
5. parsing modules
6. radius filtering
7. dedupe logic
8. phone/URL normalization
9. CSV exporter
10. stop/cancel functionality
11. debug logging
12. tests
13. README.md
14. sample CSV
```

The result should be runnable without manually editing source files after installation.

