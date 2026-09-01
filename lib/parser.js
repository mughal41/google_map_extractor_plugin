import { createPlaceRecord } from './schema.js';
import {
  canonicalizeUrl, normalizePhone, normalizeWhitespace, parseNumber, stripLabel
} from './normalizers.js';
import { normalizeCategories } from './taxonomy.js';

const PLACE_ID_RE = /(?:query_place_id=|place:\/\/|!1s)(ChI[A-Za-z0-9_-]{10,})/;
const ANY_PLACE_ID_RE = /ChI[A-Za-z0-9_-]{10,}/g;
const HEX_CID_RE = /0x[0-9a-f]+:0x([0-9a-f]+)/i;
const DAY_KEYS = {
  monday: 'mon', mon: 'mon', tuesday: 'tue', tue: 'tue',
  wednesday: 'wed', wed: 'wed', thursday: 'thu', thu: 'thu',
  friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat',
  sunday: 'sun', sun: 'sun'
};

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function isDirectImageUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value).replace(/\\u0026/g, '&'));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (/^(?:lh\d+\.googleusercontent\.com|[^.]+\.ggpht\.com)$/i.test(url.hostname)) return true;
    return /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function imageUrlsInText(value) {
  const normalized = String(value || '').replace(/\\u002f/g, '/').replace(/\\\//g, '/');
  return [...normalized.matchAll(/https?:\/\/[^\s"'\\]+/gi)]
    .map((match) => ({ url: match[0].replace(/[\],;}]+$/, ''), index: match.index }))
    .filter(({ url }) => isDirectImageUrl(url));
}

export function extractMenuImageUrlsFromText(value) {
  const text = String(value || '');
  const results = [];
  for (const image of imageUrlsInText(text)) {
    const context = text.slice(Math.max(0, image.index - 240), image.index + image.url.length + 240);
    if (/\b(?:food\s+)?menu(?:s|\s+photo(?:s)?)?\b/i.test(context)) results.push(image.url);
  }
  return [...new Set(results)].slice(0, 12);
}

function extractMenuImageUrlsFromDOM(root) {
  const results = [];
  for (const image of root?.querySelectorAll?.('img[src]') || []) {
    const url = image.currentSrc || image.src;
    if (!isDirectImageUrl(url)) continue;
    const cues = [image.alt, image.title, image.getAttribute('aria-label')];
    let ancestor = image.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      cues.push(ancestor.getAttribute?.('aria-label'), ancestor.getAttribute?.('data-item-id'));
      const text = normalizeWhitespace(ancestor.textContent);
      if (text && text.length <= 300) cues.push(text);
    }
    if (cues.some((cue) => /\b(?:food\s+)?menu(?:s|\s+photo(?:s)?)?\b/i.test(cue || ''))) {
      results.push(canonicalizeUrl(url));
    }
  }
  return [...new Set(results.filter(Boolean))].slice(0, 12);
}

export function extractCoordinatesFromUrl(value) {
  if (!value) return {};
  const url = safeDecode(String(value).replace(/\\u003d/g, '=').replace(/\\u0026/g, '&'));
  const patterns = [
    /\/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    /!3d(-?\d{1,2}(?:\.\d+))!4d(-?\d{1,3}(?:\.\d+))/,
    /[?&](?:query|ll)=(-?\d{1,2}(?:\.\d+)?)(?:%2C|,)(-?\d{1,3}(?:\.\d+)?)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { g_lat: lat, g_lng: lng };
    }
  }
  return {};
}

export function extractIdentityFromUrl(value) {
  if (!value) return {};
  const url = safeDecode(String(value));
  const placeId = url.match(PLACE_ID_RE)?.[1] ?? null;
  const hexCid = url.match(HEX_CID_RE)?.[1];
  let cid = url.match(/[?&]cid=(\d{6,})/i)?.[1] ?? null;
  if (hexCid) {
    try { cid = BigInt(`0x${hexCid}`).toString(10); } catch { /* malformed CID */ }
  }
  return { g_place_id: placeId, g_cid: cid };
}

function identityFromElement(element) {
  if (!element) return {};
  const values = [];
  for (const node of [element, ...element.querySelectorAll(
    '[data-item-id], [data-place-id], [data-pid], [data-cid], a[href]'
  )]) {
    for (const attribute of ['data-item-id', 'data-place-id', 'data-pid', 'data-cid', 'href']) {
      const value = node.getAttribute?.(attribute);
      if (value) values.push(value);
    }
  }
  const combined = values.join(' ');
  const placeId = combined.match(ANY_PLACE_ID_RE)?.[0] ?? null;
  const urlIdentity = extractIdentityFromUrl(combined);
  const decimalCid = combined.match(/(?:data-cid[=:"'\s]+|\bcid=)(\d{6,})/i)?.[1] ?? null;
  return {
    g_place_id: placeId || urlIdentity.g_place_id || null,
    g_cid: decimalCid || urlIdentity.g_cid || null
  };
}

function nameFromMapsUrl(value) {
  const match = String(value).match(/\/maps\/place\/([^/@?]+)/);
  return match ? normalizeWhitespace(safeDecode(match[1].replace(/\+/g, ' '))) : null;
}

export function extractRecordFromMapsUrl(value, search = {}) {
  return {
    ...createPlaceRecord(search),
    ...extractIdentityFromUrl(value),
    ...extractCoordinatesFromUrl(value),
    g_name: nameFromMapsUrl(value),
    g_maps_url: value ? String(value).replace(/\\u0026/g, '&') : null
  };
}

export function extractSearchPayload(raw, search = {}, logger = null) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const normalized = raw.replace(/\\u002f/g, '/').replace(/\\\//g, '/');
  const matches = [...normalized.matchAll(/https?:\/\/www\.google\.[^\s"']+\/maps\/place\/[^\s"']+/g)];
  const clean = [...new Map(matches.map((match) => [
    match[0].replace(/[\\\],;}]+$/, ''), match.index
  ])).entries()];
  if (clean.length === 0) logger?.warn('PARSER_SCHEMA_MISMATCH', { adapter: 'search_payload' });
  return clean.map(([url, index]) => {
    const record = extractRecordFromMapsUrl(url, search);
    const windowText = normalized.slice(Math.max(0, index - 3000), index + url.length + 3000);
    if (!record.g_place_id) record.g_place_id = windowText.match(ANY_PLACE_ID_RE)?.[0] ?? null;
    const image = windowText.match(/https?:\/\/lh\d+\.googleusercontent\.com\/[^\s"'\\]+/i)?.[0];
    if (image) record.g_image_url = image;
    record.g_menu_image_urls = extractMenuImageUrlsFromText(windowText);
    return record;
  });
}

function firstElement(root, selectors) {
  for (const selector of selectors) {
    try {
      const element = root.querySelector(selector);
      if (element) return element;
    } catch { /* selector unsupported */ }
  }
  return null;
}

function labelOrText(element) {
  return normalizeWhitespace(element?.getAttribute?.('aria-label') || element?.textContent);
}

export function parseSearchRatingLabel(value, fallbackValue = null) {
  const label = normalizeWhitespace(value) || '';
  const ratingMatch = label.match(/(\d(?:[.,]\d+)?)\s+stars?\b/i);
  const fallbackMatch = normalizeWhitespace(fallbackValue)?.match(/\d(?:[.,]\d+)?/);
  const rating = parseNumber(ratingMatch?.[1] || fallbackMatch?.[0]);
  const reviewsMatch = label.match(/stars?\s+([\d\s,.]+)\s+(?:reviews?|ratings?)\b/i);
  const reviewDigits = reviewsMatch?.[1]?.replace(/\D/g, '') || '';
  return {
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    reviewCount: reviewDigits ? Number(reviewDigits) : null
  };
}

function leafSpanValues(root) {
  return [...(root?.querySelectorAll?.('span') || [])]
    .filter((span) => span.children.length === 0)
    .filter((span) => span.getAttribute('aria-hidden') !== 'true')
    .filter((span) => !span.closest('[role="img"]'))
    .map((span) => normalizeWhitespace(span.textContent))
    .filter(Boolean);
}

function cardMetadataRows(card) {
  const rows = [...(card?.querySelectorAll?.('.W4Efsd') || [])]
    .filter((row) => !row.querySelector('.W4Efsd'))
    .map(leafSpanValues)
    .filter((values) => values.length > 0);
  return rows.length ? rows : [leafSpanValues(card)].filter((values) => values.length > 0);
}

function statusText(values) {
  const text = normalizeWhitespace(values.join(' '))?.replace(/\s*·\s*/g, ' · ');
  return /^(?:open|closed|temporarily closed|permanently closed)\b/i.test(text || '') ? text : null;
}

export function extractSearchCardMetadata(card) {
  const ratingEl = firstElement(card, [
    '[role="img"][aria-label*="stars"]', '[role="img"][aria-label*="Stars"]'
  ]);
  const ratingText = firstElement(ratingEl || card, ['.MW4etd'])?.textContent;
  const { rating, reviewCount } = parseSearchRatingLabel(
    ratingEl?.getAttribute?.('aria-label'), ratingText
  );
  const rows = cardMetadataRows(card);
  const status = rows.map(statusText).find(Boolean) || null;
  const details = rows.find((values) => !statusText(values) &&
    !values.some((value) => /\b(?:reviews?|ratings?|stars?)\b/i.test(value))) || [];
  const priceLevel = details.find((value) => /^(?:\$|£|€|₹){1,4}$/.test(value)) || null;
  const descriptive = details.filter((value) => value !== priceLevel);
  const category = descriptive[0] || null;
  const neighborhood = descriptive.length > 1 ? descriptive.at(-1) : null;
  const subtitle = descriptive.length > 1 ? descriptive.join(' · ') : null;
  const accessibility = [...new Set([...(card?.querySelectorAll?.('[role="img"][aria-label]') || [])]
    .map((element) => normalizeWhitespace(element.getAttribute('aria-label')))
    .filter((label) => label && !/\bstars?\b/i.test(label)))];
  const additionalInfo = {};
  if (status) {
    additionalInfo.current_status = status;
    if (/^open\b/i.test(status)) additionalInfo.open_now = true;
    else if (/^closed\b/i.test(status)) additionalInfo.open_now = false;
  }
  if (reviewCount !== null) additionalInfo.review_count = reviewCount;
  if (accessibility.length) additionalInfo.accessibility = accessibility;
  return {
    ...normalizeCategories(category, []),
    g_subtitle: subtitle,
    g_neighborhood: neighborhood,
    g_rating: rating,
    g_price_level: priceLevel,
    g_temporarily_closed: /^temporarily closed\b/i.test(status || '') ? true : null,
    g_permanently_closed: /^permanently closed\b/i.test(status || '') ? true : null,
    g_additional_info: Object.keys(additionalInfo).length ? additionalInfo : null
  };
}

function parseAddressObject(address) {
  if (!address || typeof address !== 'object') return {};
  return {
    g_address: normalizeWhitespace([
      address.streetAddress, address.addressLocality, address.addressRegion,
      address.postalCode, address.addressCountry
    ].filter(Boolean).join(', ')),
    g_street: normalizeWhitespace(address.streetAddress),
    g_city: normalizeWhitespace(address.addressLocality),
    g_state: normalizeWhitespace(address.addressRegion),
    g_postal_code: normalizeWhitespace(address.postalCode),
    g_country_code: normalizeWhitespace(
      typeof address.addressCountry === 'object'
        ? (address.addressCountry.addressCountry || address.addressCountry.name)
        : address.addressCountry
    )
  };
}

function parseOpeningHoursSpecification(specifications) {
  if (!Array.isArray(specifications)) return null;
  const result = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  for (const item of specifications) {
    const days = Array.isArray(item.dayOfWeek) ? item.dayOfWeek : [item.dayOfWeek];
    for (const dayValue of days) {
      const dayName = String(dayValue || '').split('/').pop().toLowerCase();
      const key = DAY_KEYS[dayName];
      if (key && item.opens && item.closes) result[key].push([item.opens, item.closes]);
    }
  }
  return result;
}

function structuredMenuImages(data) {
  const candidates = Array.isArray(data?.image) ? data.image : [data?.image];
  const results = [];
  for (const image of candidates) {
    if (!image || typeof image !== 'object') continue;
    const cue = [image.name, image.caption, image.description, image.alternateName].filter(Boolean).join(' ');
    const url = image.url || image.contentUrl;
    if (/\b(?:food\s+)?menu\b/i.test(cue) && isDirectImageUrl(url)) {
      results.push(canonicalizeUrl(url));
    }
  }
  return [...new Set(results.filter(Boolean))].slice(0, 12);
}

function to24Hour(value) {
  const match = normalizeWhitespace(value)?.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] || '00';
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (hour > 23 || Number(minute) > 59) return null;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

export function parseHoursLabel(value) {
  if (!value) return null;
  const result = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  let matchedDay = false;
  for (const segment of String(value).split(/[;\n]/)) {
    const dayMatch = segment.trim().match(/^(Monday|Mon|Tuesday|Tue|Wednesday|Wed|Thursday|Thu|Friday|Fri|Saturday|Sat|Sunday|Sun)\s*[:,]?\s*(.*)$/i);
    if (!dayMatch) continue;
    matchedDay = true;
    const key = DAY_KEYS[dayMatch[1].toLowerCase()];
    const hours = dayMatch[2].trim();
    if (/closed/i.test(hours)) continue;
    if (/open 24 hours/i.test(hours)) {
      result[key].push(['00:00', '24:00']);
      continue;
    }
    for (const period of hours.split(/,\s*(?=\d)/)) {
      const range = period.split(/\s*(?:-|–|—|to)\s*/i);
      if (range.length !== 2) continue;
      const open = to24Hour(range[0]);
      const close = to24Hour(range[1]);
      if (open && close) result[key].push([open, close]);
    }
  }
  return matchedDay ? result : null;
}

export function extractPlaceEmbeddedState(document, search = {}, logger = null) {
  const parts = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const data of entries) {
        if (!data || typeof data !== 'object' || (!data.name && !data.geo)) continue;
        const categories = normalizeCategories(
          typeof data['@type'] === 'string' && data['@type'] !== 'LocalBusiness' ? data['@type'] : null,
          []
        );
        parts.push({
          ...createPlaceRecord(search),
          g_name: normalizeWhitespace(data.name),
          ...categories,
          ...parseAddressObject(data.address),
          g_phone: normalizePhone(data.telephone, data.address?.addressCountry),
          g_website: canonicalizeUrl(data.url),
          g_menu_image_urls: structuredMenuImages(data),
          g_image_url: canonicalizeUrl(
            Array.isArray(data.image) ? data.image[0] :
              typeof data.image === 'object' ? data.image?.url : data.image
          ),
          g_lat: parseNumber(data.geo?.latitude),
          g_lng: parseNumber(data.geo?.longitude),
          g_rating: parseNumber(data.aggregateRating?.ratingValue),
          g_hours: parseOpeningHoursSpecification(data.openingHoursSpecification)
        });
      }
    } catch (error) {
      logger?.warn('PARSER_SCHEMA_MISMATCH', { adapter: 'ld_json', message: error.message });
    }
  }
  return parts;
}

export function extractSearchDOM(document, search = {}) {
  const anchors = [...document.querySelectorAll(
    '[role="feed"] a[href*="/maps/place/"], a[data-value][href*="/maps/place/"]'
  )];
  const seen = new Set();
  const records = [];
  for (const anchor of anchors) {
    const href = anchor.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const card = anchor.closest('[role="article"]') || anchor.closest('[data-result-index]') ||
      anchor.closest('[jsaction*="mouseover"]') || anchor.parentElement?.parentElement?.parentElement ||
      anchor.parentElement;
    const ariaName = anchor.getAttribute('aria-label');
    const heading = firstElement(card || anchor, ['[role="heading"]', 'h2', 'h3']);
    const text = normalizeWhitespace(card?.textContent) || '';
    const identity = identityFromElement(card || anchor);
    const urlRecord = extractRecordFromMapsUrl(href, search);
    const image = firstElement(card || anchor, [
      'img[src*="googleusercontent.com"]', 'img[src*="ggpht.com"]', 'img[src]'
    ]);
    const metadata = extractSearchCardMetadata(card || anchor);
    if (search.include_additional_info === false) metadata.g_additional_info = null;
    records.push({
      ...urlRecord,
      ...metadata,
      g_place_id: identity.g_place_id || urlRecord.g_place_id,
      g_cid: identity.g_cid || urlRecord.g_cid,
      g_name: normalizeWhitespace(ariaName) || labelOrText(heading) || nameFromMapsUrl(href),
      g_image_url: canonicalizeUrl(image?.currentSrc || image?.src),
      g_is_ad: /(?:^|\s)(?:sponsored|ad)(?:\s|$)/i.test(text),
      g_rank: records.length + 1
    });
  }
  return records;
}

export function extractPlaceDOM(document, search = {}) {
  const name = labelOrText(firstElement(document, ['h1', '[role="main"] [role="heading"][aria-level="1"]']));
  const addressEl = firstElement(document, [
    'button[data-item-id="address"]', 'button[data-item-id*="address"]',
    'button[aria-label^="Address"]'
  ]);
  const phoneEl = firstElement(document, [
    'button[data-item-id^="phone"]', 'button[data-item-id*="phone"]',
    'button[aria-label^="Phone"]'
  ]);
  const websiteEl = firstElement(document, [
    'a[data-item-id="authority"]', 'a[aria-label^="Website"]'
  ]);
  const imageEl = firstElement(document, [
    '[role="main"] img[src*="googleusercontent.com"]',
    'img[src*="googleusercontent.com"]', 'img[src*="ggpht.com"]'
  ]);
  const categoryEl = firstElement(document, [
    'button[jsaction*="category"]', '[role="main"] button[aria-label*="Category"]'
  ]);
  const ratingEl = firstElement(document, [
    '[role="img"][aria-label*="stars"]', '[role="img"][aria-label*="Stars"]'
  ]);
  const plusCodeEl = firstElement(document, [
    'button[data-item-id="oloc"]', 'button[data-item-id*="plus_code"]'
  ]);
  const locatedInEl = firstElement(document, [
    'button[data-item-id*="locatedin"]', 'a[aria-label^="Located in"]'
  ]);
  const hoursEl = firstElement(document, [
    'button[data-item-id*="oh"]', '[aria-label*="Monday"][aria-label*="Tuesday"]'
  ]);
  const priceEl = firstElement(document, ['[aria-label^="Price"]']);
  const bodyText = document.body?.innerText || '';
  const ratingMatch = labelOrText(ratingEl)?.match(/(\d+(?:[.,]\d+)?)/);
  const category = stripLabel(labelOrText(categoryEl), ['Category']);
  const urlIdentity = extractIdentityFromUrl(document.location?.href);
  const domIdentity = identityFromElement(document.querySelector('[role="main"]') || document.body);
  const identity = {
    g_place_id: domIdentity.g_place_id || urlIdentity.g_place_id,
    g_cid: domIdentity.g_cid || urlIdentity.g_cid
  };
  const coordinates = extractCoordinatesFromUrl(document.location?.href);
  return {
    ...createPlaceRecord(search),
    ...identity,
    ...coordinates,
    g_name: name,
    ...normalizeCategories(category, []),
    g_address: stripLabel(labelOrText(addressEl), ['Address']),
    g_phone: normalizePhone(stripLabel(labelOrText(phoneEl), ['Phone'])),
    g_website: canonicalizeUrl(websiteEl?.href),
    g_menu_image_urls: extractMenuImageUrlsFromDOM(document.querySelector('[role="main"]') || document),
    g_image_url: canonicalizeUrl(imageEl?.currentSrc || imageEl?.src),
    g_rating: ratingMatch ? parseNumber(ratingMatch[1]) : null,
    g_price_level: labelOrText(priceEl)?.match(/\${1,4}/)?.[0] ?? null,
    g_hours: parseHoursLabel(labelOrText(hoursEl)),
    g_plus_code: stripLabel(labelOrText(plusCodeEl), ['Plus code']),
    g_located_in: stripLabel(labelOrText(locatedInEl), ['Located in']),
    g_temporarily_closed: /temporarily closed/i.test(bodyText) ? true : null,
    g_permanently_closed: /permanently closed/i.test(bodyText) ? true : null,
    g_maps_url: document.location?.href || null
  };
}

export function isBlockingPage(document) {
  const text = `${document.title || ''} ${document.body?.innerText || ''}`.slice(0, 15000);
  if (/unusual traffic|automated queries|captcha/i.test(text)) return 'ACCESS_BLOCKED';
  if (/before you continue to google|consent\.google/i.test(text)) return 'CONSENT_REQUIRED';
  return null;
}
