// Educational copy behind every info icon in the popup. Facts only — the
// rendering layer decides presentation. Keys are referenced from popup.html
// via data-info attributes.
export const GLOSSARY = {
  'coverage-city': {
    title: 'City search',
    body: 'One Maps search per term, centered on the resolved city. Fastest plan and fine for small or mid-sized cities, but dense megacities can exhaust a single result list before covering every district.'
  },
  'coverage-grid': {
    title: 'Grid scan',
    body: 'Splits the city viewport into equal map cells and repeats every term in each cell. Thorough and predictable; the job count is terms × cells, so watch the total.'
  },
  'coverage-adaptive': {
    title: 'Adaptive scan',
    body: 'Starts like a grid scan, then subdivides only the cells that return 40+ result cards — dense downtown cells get refined, empty suburbs do not. Best coverage per search; stays within your job budget.'
  },
  'job-budget': {
    title: 'Job budget',
    body: 'A hard ceiling on total searches in this run. Adaptive refinements stop once the ceiling is reached. Higher budgets find more places but take longer and increase rate-limit exposure.'
  },
  'cooldown': {
    title: 'Cooldown & jitter',
    body: 'The pause between searches. Each pause is randomized up to +50% of your base setting, and after every 8 searches the queue rests about 6× longer. Evenly spaced requests are the classic bot fingerprint — the randomness keeps your pattern human.'
  },
  'terms': {
    title: 'Search terms',
    body: 'One term per line, run in order, up to 50 per plan. Google auto-localizes generic terms ("places of worship" returns mosques in Istanbul, temples in Bangkok), so neutral wording works in any country.'
  },
  'presets': {
    title: 'Curated presets',
    body: 'Hand-trimmed category lists with overlaps removed — "doctors", "clinics" and "hospitals" pull overlapping results, so the presets keep only the strongest representative of each cluster. Core + Extended captures ~80% of a city’s commercially useful places.'
  },
  'enrichment': {
    title: 'Detail enrichment',
    body: 'After all searches finish, visits each unique place page at most once to fill a missing phone, website, address, category, or image. Adds roughly 9 seconds per incomplete place, so the pre-run estimate can’t include it precisely.'
  },
  'amenities': {
    title: 'Card status & amenities',
    body: 'Exports the open/closed wording, review counts, and accessibility hints already visible on result cards. Free — it never triggers extra page loads.'
  },
  'sponsored': {
    title: 'Sponsored results',
    body: 'Ads injected into the result list. They often sit outside your area and skew data, so they’re excluded by default: sponsored cards are flagged during collection and removed after duplicates merge, before export.'
  },
  'coverage-filter': {
    title: 'Coverage filter',
    body: 'Counts unique places whose coordinates fall inside your planned area — within the radius in coordinates mode, or within the resolved city viewport in city mode. Places outside the area are dropped before export.'
  },
  'dedupe': {
    title: 'Deduplication',
    body: 'The same pharmacy found by three searches becomes one row. Matching uses Google’s Place ID first, then CID, then normalized name + coordinates rounded to 5 decimals (~1 meter).'
  },
  'confidence': {
    title: 'Confidence score',
    body: 'A 0–1 score per exported row rewarding a verified Place ID, name, coordinates, and filled fields. It measures extraction completeness — it is not Google’s star rating.'
  },
  'risk': {
    title: 'Rate-limit risk',
    body: 'Google tolerates human-paced browsing but throttles bursts. Under ~60 searches per sitting is comfortable; 60–120 is usually fine at the recommended cooldown; beyond ~120 CAPTCHAs become likely. The job budget is the lever that caps this. If a CAPTCHA appears, the run stops safely — solve it manually and start a smaller plan.'
  },
  'estimate': {
    title: 'How the estimate works',
    body: 'Each search averages ~45 seconds of loading and scrolling (30–70s depending on result density), plus your randomized cooldowns and rest breaks. Adaptive refinements can extend a run up to its job ceiling, so the estimate shows a typical value and a worst case.'
  },
  'local-only': {
    title: 'Browser-only',
    body: 'Everything runs inside your Chrome — collection, dedupe, CSV export. No data leaves your machine, no accounts, no server, no cookies read.'
  },
  'coordinates': {
    title: 'Coordinates & radius',
    body: 'Searches around an exact point and keeps only places within your radius, measured by great-circle distance. Results without extractable coordinates are dropped rather than guessed.'
  },
  'csv': {
    title: 'CSV export',
    body: 'UTF-8 with BOM so Excel opens it cleanly. One place per row with a stable column order; lists use " | " separators. Huge numeric IDs are protected from Excel’s scientific notation.'
  }
};
