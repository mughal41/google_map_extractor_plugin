import { normalizeWhitespace } from './normalizers.js';

export function normalizeTerms(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(source.map(normalizeWhitespace).filter(Boolean))].slice(0, 50);
}

export function zoomForRadius(radiusM) {
  const zoom = Math.round(16 - Math.log2(Math.max(Number(radiusM) || 100, 100) / 500));
  return Math.max(11, Math.min(18, zoom));
}

export function extractMapsView(value) {
  const match = String(value || '').match(
    /\/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),(\d{1,2}(?:\.\d+)?)z/
  );
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  const zoom = Number(match[3]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || zoom < 1 || zoom > 22) return null;
  return { lat, lng, zoom };
}

export function cityResolutionUrl(config) {
  const location = normalizeWhitespace([config.city, config.country].filter(Boolean).join(', '));
  return `https://www.google.com/maps/search/${encodeURIComponent(location)}`;
}

export function searchUrlForJob(config, term, resolvedLocation = null, cell = null) {
  const cityMode = config.location_mode === 'city';
  const center = cityMode ? (cell || resolvedLocation) : config;
  const zoom = cityMode
    ? Math.max(10, Math.min(18, Number(cell?.zoom || center?.zoom) || 12))
    : zoomForRadius(config.radius_m);
  const query = cityMode && !cell
    ? `${term} in ${config.city}, ${config.country}`
    : term;
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${center.lat},${center.lng},${zoom}z`;
}

export function createJobs(terms) {
  return normalizeTerms(terms).map((term, index) => ({
    index,
    term,
    status: 'pending',
    discovered: 0,
    added: 0,
    startedAt: null,
    completedAt: null
  }));
}

function worldPoint(lat, lng, zoom) {
  const size = 256 * (2 ** zoom);
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    size
  };
}

function coordinatesFromWorld(x, y, size) {
  const lng = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

export function boundsForMapsView(view, widthPx, heightPx) {
  const center = worldPoint(view.lat, view.lng, view.zoom);
  const halfWidth = Math.max(240, Number(widthPx) || 800) / 2;
  const halfHeight = Math.max(240, Number(heightPx) || 600) / 2;
  const northWest = coordinatesFromWorld(center.x - halfWidth, center.y - halfHeight, center.size);
  const southEast = coordinatesFromWorld(center.x + halfWidth, center.y + halfHeight, center.size);
  return {
    north: northWest.lat,
    south: southEast.lat,
    west: northWest.lng,
    east: southEast.lng
  };
}

export function insideBounds(lat, lng, bounds, tolerance = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !bounds) return false;
  return lat <= bounds.north + tolerance && lat >= bounds.south - tolerance &&
    lng >= bounds.west - tolerance && lng <= bounds.east + tolerance;
}

function gridCells(bounds, dimension, overviewZoom) {
  const cells = [];
  const latStep = (bounds.north - bounds.south) / dimension;
  const lngStep = (bounds.east - bounds.west) / dimension;
  // Keep each search viewport slightly wider than its logical cell so places near
  // a cell edge are seen by a neighboring search too.
  const zoom = Math.min(18, Math.max(11, Math.round((overviewZoom + Math.log2(dimension) - 0.25) * 10) / 10));
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < dimension; column += 1) {
      const north = bounds.north - row * latStep;
      const south = north - latStep;
      const west = bounds.west + column * lngStep;
      const east = west + lngStep;
      cells.push({
        id: `r${row + 1}c${column + 1}`,
        label: `Cell ${row * dimension + column + 1}/${dimension * dimension}`,
        depth: 0,
        lat: (north + south) / 2,
        lng: (west + east) / 2,
        zoom,
        bounds: { north, south, west, east }
      });
    }
  }
  return cells;
}

export function createCityScanJobs(terms, bounds, overviewZoom, maxJobs = 100, coverageMode = 'adaptive') {
  const normalized = normalizeTerms(terms);
  if (coverageMode === 'city') return createJobs(normalized);
  const cellsPerTermBudget = Math.max(1, Math.floor(Math.max(1, maxJobs) / Math.max(1, normalized.length)));
  const dimension = cellsPerTermBudget >= 9 ? 3 : cellsPerTermBudget >= 4 ? 2 : 1;
  const cells = gridCells(bounds, dimension, overviewZoom);
  const jobs = [];
  for (const term of normalized) {
    for (const cell of cells) {
      jobs.push({
        index: jobs.length,
        term,
        cell: structuredClone(cell),
        status: 'pending',
        discovered: 0,
        added: 0,
        startedAt: null,
        completedAt: null
      });
    }
  }
  return jobs.slice(0, Math.max(1, maxJobs));
}

export function splitScanCell(cell) {
  if (!cell?.bounds) return [];
  const { north, south, west, east } = cell.bounds;
  const middleLat = (north + south) / 2;
  const middleLng = (west + east) / 2;
  const depth = (cell.depth || 0) + 1;
  const zoom = Math.min(18, Math.round(((cell.zoom || 12) + 0.8) * 10) / 10);
  return [
    { suffix: 'nw', bounds: { north, south: middleLat, west, east: middleLng } },
    { suffix: 'ne', bounds: { north, south: middleLat, west: middleLng, east } },
    { suffix: 'sw', bounds: { north: middleLat, south, west, east: middleLng } },
    { suffix: 'se', bounds: { north: middleLat, south, west: middleLng, east } }
  ].map(({ suffix, bounds: childBounds }, index) => ({
    id: `${cell.id}.${suffix}`,
    label: `${cell.label} · refinement ${index + 1}/4`,
    depth,
    lat: (childBounds.north + childBounds.south) / 2,
    lng: (childBounds.west + childBounds.east) / 2,
    zoom,
    bounds: childBounds
  }));
}
