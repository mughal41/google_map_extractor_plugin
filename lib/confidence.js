export function extractionConfidence(record) {
  let score = record?.g_place_id ? 0.45 : record?.g_cid ? 0.30 :
    (record?.g_name && Number.isFinite(record?.g_lat) && Number.isFinite(record?.g_lng) ? 0.20 : 0);
  if (record?.g_name) score += 0.10;
  if (Number.isFinite(record?.g_lat) && Number.isFinite(record?.g_lng)) score += 0.15;
  if (record?.g_category || record?.g_categories?.length) score += 0.05;
  if (record?.g_address) score += 0.05;
  if (record?.g_phone || record?.g_website) score += 0.05;
  if (Number.isFinite(record?.g_rating)) score += 0.05;
  if (record?.g_image_url) score += 0.05;
  if (record?.g_menu_image_urls?.length) score += 0.05;
  return Math.round(Math.min(1, score) * 1000) / 1000;
}
