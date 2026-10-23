import { CSV_COLUMNS } from './schema.js';
import { sanitizeTerm } from './normalizers.js';

const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
  ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];

export function serializeHours(hours) {
  if (!hours || typeof hours !== 'object') return '';
  return DAYS.map(([key, label]) => {
    const periods = Array.isArray(hours[key]) ? hours[key] : [];
    return periods.length
      ? `${label} ${periods.map(([open, close]) => `${open}-${close}`).join(', ')}`
      : `${label} Closed`;
  }).join(' | ');
}

function cellValue(field, value) {
  if (value === null || value === undefined) return '';
  // Excel converts 64-bit Google CIDs to imprecise scientific notation even
  // when an ordinary CSV field is quoted. A string formula preserves every digit.
  if (field === 'g_cid' && /^\d+$/.test(String(value))) return `="${value}"`;
  if (field === 'g_categories' || field === 'g_menu_image_urls') {
    return Array.isArray(value) ? value.join(' | ') : String(value);
  }
  if (field === 'g_hours') return serializeHours(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeCsv(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function recordsToCsv(records, columns = CSV_COLUMNS) {
  const rows = [columns.map(escapeCsv).join(',')];
  for (const record of records) {
    rows.push(columns.map((field) => escapeCsv(cellValue(field, record[field]))).join(','));
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function csvFilename(config, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  if (config.location_mode === 'city') {
    return `google_maps_${sanitizeTerm(config.city)}_${sanitizeTerm(config.country)}_batch_${stamp}.csv`;
  }
  const plan = Array.isArray(config.terms) && config.terms.length > 1 ? 'batch' : sanitizeTerm(config.term);
  return `google_maps_${plan}_${config.lat}_${config.lng}_${config.radius_m}m_${stamp}.csv`;
}

// Reads CSV written by recordsToCsv (or Excel): quoted fields may hold commas,
// quotes and line breaks. Returns { header, rows } with rows as objects of
// strings keyed by header.
export function parseCsv(text) {
  const input = String(text).replace(/^﻿/, '');
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      table.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); table.push(row); }
  const [header = [], ...body] = table.filter((r) => r.length > 1 || r[0] !== '');
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

// Writes rows that are already strings (from parseCsv) back out unchanged.
export function rowsToCsv(header, rows) {
  const lines = [header.map(escapeCsv).join(',')];
  for (const row of rows) lines.push(header.map((h) => escapeCsv(row[h] ?? '')).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
