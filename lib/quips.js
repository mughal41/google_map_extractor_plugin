// Pip's voice. One-liners per context, picked deterministically from a seed so
// the line is stable within a state but varies across states and runs.
// Rule: the quip is charm only — facts always live in the labels next to it.
const QUIPS = {
  plan_empty: [
    'Pip here. You plan the route, I do the walking.',
    'Add search terms and I’ll go fetch my boots.',
    'A blank map. My favorite kind of trouble.'
  ],
  plan_ready: [
    '{terms} terms? My compass needle just perked up.',
    'Solid plan. I’ve surveyed worse with fewer snacks.',
    '{terms} terms across {area}. Say the word.',
    'Ready when you are. The boots are already on.'
  ],
  review: [
    'About {time} of walking. I’ll bill you zero.',
    '{jobs} searches. For you? I’ll allow it.',
    'I checked the math twice. My needle doesn’t lie.',
    '{time}, give or take a nap. Shall we?'
  ],
  searching: [
    'On the scent of “{term}”…',
    'Sniffing out “{term}”. Stand by.',
    'Scanning the horizon for “{term}”…'
  ],
  waiting: [
    'Mandatory nap. Union rules.',
    'Resting so Google thinks I’m human. I’m mostly brass.',
    'Five winks, then back on the trail.'
  ],
  resolving: [
    'Getting my bearings… literally.',
    'Asking the map where the map is.'
  ],
  filtering: [
    'Sorting my souvenirs, tossing the doubles…',
    'Counting the haul. No double-dipping.'
  ],
  enriching: [
    'Knocking on doors for phone numbers…',
    'Going back for the details I missed.'
  ],
  complete: [
    '{count} places. My legs are 100% cartography.',
    'Route complete. {count} places, zero blisters.',
    'All done. {count} places — stamp the log!'
  ],
  stopped: [
    'Camp broken early. Everything we found is safe.',
    'You called it. The haul is packed and saved.'
  ],
  error: [
    'We hit a fence. I saved everything before climbing back.',
    'Google raised an eyebrow. Your data is safe with me.'
  ]
};

function hashSeed(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

export function quip(context, fills = {}, seed = '') {
  const pool = QUIPS[context] || [];
  if (!pool.length) return '';
  const line = pool[hashSeed(`${context}:${seed}`) % pool.length];
  return line.replace(/\{(\w+)\}/g, (_, key) => String(fills[key] ?? ''));
}
