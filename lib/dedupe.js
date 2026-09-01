import { normalizeName } from './normalizers.js';

function hasValue(value) {
  return value !== null && value !== undefined && value !== '' &&
    (!Array.isArray(value) || value.length > 0);
}

export function fallbackPlaceKey(record) {
  if (!record?.g_name || !Number.isFinite(record.g_lat) || !Number.isFinite(record.g_lng)) {
    return null;
  }
  return `${normalizeName(record.g_name)}|${record.g_lat.toFixed(5)}|${record.g_lng.toFixed(5)}`;
}

export function placeKey(record) {
  return record?.g_place_id ? `pid:${record.g_place_id}` :
    record?.g_cid ? `cid:${record.g_cid}` : fallbackPlaceKey(record);
}

export function mergePlaceRecord(existing, candidate) {
  if (!existing) return structuredClone(candidate);
  if (!candidate) return structuredClone(existing);
  if (existing.g_place_id && candidate.g_place_id &&
      existing.g_place_id !== candidate.g_place_id) {
    throw new Error('DIFFERENT_PLACE_IDS');
  }
  const merged = { ...existing };
  for (const [field, value] of Object.entries(candidate)) {
    if (!hasValue(value)) continue;
    if (Array.isArray(value)) {
      merged[field] = [...new Set([...(existing[field] || []), ...value])];
    } else if (field === 'g_rank') {
      merged[field] = Math.min(existing[field] ?? Infinity, value);
    } else if (!hasValue(existing[field])) {
      merged[field] = value;
    }
  }
  return merged;
}

export function deduplicateRecords(records) {
  const byKey = new Map();
  const fallbackToKey = new Map();
  for (const record of records) {
    const fallback = fallbackPlaceKey(record);
    let key = placeKey(record) || `anonymous:${byKey.size}`;
    if (!record.g_place_id && fallbackToKey.has(fallback)) key = fallbackToKey.get(fallback);
    if (record.g_place_id && fallback && fallbackToKey.has(fallback)) {
      const oldKey = fallbackToKey.get(fallback);
      const old = byKey.get(oldKey);
      if (!old?.g_place_id || old.g_place_id === record.g_place_id) {
        byKey.delete(oldKey);
        byKey.set(key, mergePlaceRecord(old, record));
        fallbackToKey.set(fallback, key);
        continue;
      }
    }
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergePlaceRecord(existing, record) : structuredClone(record));
    if (fallback) fallbackToKey.set(fallback, key);
  }
  return [...byKey.values()];
}
