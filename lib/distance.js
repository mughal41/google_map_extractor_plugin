export const EARTH_MEAN_RADIUS_M = 6371008.8;

const toRadians = (degrees) => degrees * Math.PI / 180;

export function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function distanceMeters(lat1, lng1, lat2, lng2) {
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) {
    return null;
  }
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return EARTH_MEAN_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isInsideRadius(record, search, toleranceM = 0) {
  const distance = distanceMeters(search.lat, search.lng, record.g_lat, record.g_lng);
  return {
    distance,
    inside: distance !== null && distance <= search.radius_m + toleranceM
  };
}
