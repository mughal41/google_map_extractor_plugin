const COUNTRY_CALLING_CODES = {
  PK: '92', US: '1', CA: '1', GB: '44', AU: '61', AE: '971',
  SA: '966', IN: '91', DE: '49', FR: '33', ES: '34', IT: '39'
};

export function normalizeWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
}

export function normalizeName(value) {
  const text = normalizeWhitespace(value)?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(?:ltd|limited|llc|inc|pvt\s+ltd|company|co)\b\.?/g, '');
  return normalizeWhitespace(text) ?? '';
}

export function canonicalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|dclid$|msclkid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    if (url.pathname === '/') url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function normalizePhone(value, countryCode = null) {
  if (!value) return null;
  const raw = String(value).replace(/(?:ext\.?|x)\s*\d+$/i, '').trim();
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) {
    digits = digits.slice(2);
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }
  if (hasPlus) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  const callingCode = COUNTRY_CALLING_CODES[String(countryCode || '').toUpperCase()];
  if (!callingCode) return null;
  digits = digits.replace(/^0+/, '');
  const international = `${callingCode}${digits}`;
  return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
}

export function parseNumber(value) {
  const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

export function sanitizeTerm(value) {
  return normalizeWhitespace(value)?.replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '').toLowerCase().slice(0, 60) || 'search';
}

export function stripLabel(value, labels) {
  let result = normalizeWhitespace(value);
  for (const label of labels) {
    result = result?.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '');
  }
  return normalizeWhitespace(result);
}
