import { normalizeWhitespace } from './normalizers.js';

export function normalizeCategories(primary, categories = []) {
  const values = [primary, ...categories].map(normalizeWhitespace).filter(Boolean);
  const unique = [...new Set(values)];
  return { g_category: unique[0] ?? null, g_categories: unique };
}
