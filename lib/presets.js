// Curated, overlap-trimmed search-term presets.
//
// Terms that mostly return each other's results on Google Maps ("doctors" vs
// "clinics" vs "hospitals", "hair salons" vs "beauty salons", "coffee shops"
// vs "cafes", "grocery stores" vs "supermarkets") are collapsed to one
// representative term, so every scheduled search contributes mostly new
// places instead of re-downloading the same cards. Google auto-localizes
// generic terms per country, so neutral wording works worldwide.
export const MAX_TERMS = 50;

export const TERM_PRESETS = [
  {
    id: 'core',
    label: 'Core',
    description: 'Highest-density commercial categories. This set alone captures most of the commercially useful places in a city.',
    terms: [
      'restaurants', 'cafes', 'bakeries', 'supermarkets', 'pharmacies',
      'hospitals', 'clinics', 'dentists', 'medical laboratories', 'banks',
      'schools', 'universities', 'hotels', 'beauty salons', 'gyms',
      'clothing stores', 'shoe stores', 'electronics stores', 'gas stations',
      'car repair', 'real estate agencies', 'insurance agencies'
    ]
  },
  {
    id: 'extended',
    label: 'Extended',
    description: 'High-value specialty retail and services beyond the core set. Core + Extended fits in one run.',
    terms: [
      'jewelry stores', 'furniture stores', 'hardware stores', 'bookstores',
      'opticians', 'travel agencies', 'courier services', 'lawyers',
      'car dealers', 'car wash', 'laundry services', 'photography studios',
      'printing services', 'veterinary clinics', 'spas', 'tire shops',
      'auto parts stores', 'convenience stores'
    ]
  },
  {
    id: 'longtail',
    label: 'Long tail',
    description: 'Useful niche categories with diminishing returns. Best run as a separate follow-up plan on another day.',
    terms: [
      'driving schools', 'training institutes', 'libraries', 'cinemas',
      'sports clubs', 'toy stores', 'pet stores', 'florists', 'gift shops',
      'event management', 'catering', 'plumbers', 'electricians',
      'locksmiths', 'bicycle shops'
    ]
  },
  {
    id: 'civic',
    label: 'Civic',
    description: 'Government, religious, and community places. Contact data is thin but coverage is complete.',
    terms: [
      'police stations', 'fire stations', 'post offices', 'government offices',
      'courts', 'places of worship', 'community centers', 'museums',
      'art galleries', 'town halls'
    ]
  }
];
