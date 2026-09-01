// Pip's voice. Deterministic quip() keeps a line stable within a state;
// randomQuip() rotates freely for Pip's idle chatter and reactions.
// Rule: the quip is charm only — facts always live in the labels next to it.
const QUIPS = {
  plan_empty: [
    'Pip here. You plan the route, I do the walking.',
    'Add search terms and I’ll go fetch my boots.',
    'A blank map. My favorite kind of trouble.',
    'No terms yet? Even my needle is bored.',
    'Psst — the Core preset is right there. Just saying.'
  ],
  plan_ready: [
    '{terms} terms? My compass needle just perked up.',
    'Solid plan. I’ve surveyed worse with fewer snacks.',
    '{terms} terms across {area}. Say the word.',
    'Ready when you are. The boots are already on.',
    'I rate this plan 4.8 stars. Would extract again.',
    '{area}, huh? I know a shortcut. It’s the same route, but with confidence.'
  ],
  review: [
    'About {time} of walking. I’ll bill you zero.',
    '{jobs} searches. For you? I’ll allow it.',
    'I checked the math twice. My needle doesn’t lie.',
    '{time}, give or take a nap. Shall we?',
    'Sign here and I’ll start stretching.'
  ],
  searching: [
    'On the scent of “{term}”…',
    'Sniffing out “{term}”. Stand by.',
    'Scanning the horizon for “{term}”…',
    '“{term}”? Say less. Already on it.',
    'Cataloguing every “{term}” in sight…'
  ],
  waiting: [
    'Mandatory nap. Union rules.',
    'Resting so Google thinks I’m human. I’m mostly brass.',
    'Five winks, then back on the trail.',
    'Shhh. Strategic snoozing in progress.',
    'Even compasses need to touch grass.'
  ],
  resolving: [
    'Getting my bearings… literally.',
    'Asking the map where the map is.',
    'Calibrating. Do not shake the compass.'
  ],
  filtering: [
    'Sorting my souvenirs, tossing the doubles…',
    'Counting the haul. No double-dipping.',
    'Two of the same pharmacy? Not on my watch.'
  ],
  enriching: [
    'Knocking on doors for phone numbers…',
    'Going back for the details I missed.',
    'Detail duty. The glamorous part of cartography.'
  ],
  complete: [
    '{count} places. My legs are 100% cartography.',
    'Route complete. {count} places, zero blisters.',
    'All done. {count} places — stamp the log!',
    '{count} places bagged. I accept payment in map pins.'
  ],
  stopped: [
    'Camp broken early. Everything we found is safe.',
    'You called it. The haul is packed and saved.'
  ],
  error: [
    'We hit a fence. I saved everything before climbing back.',
    'Google raised an eyebrow. Your data is safe with me.'
  ],
  preset_add: [
    '{label} pack loaded. Excellent taste in trails.',
    '{label}? Ooh, the good stuff. Pack’s heavier now.',
    'Strapping the {label} pack on. Let’s move.'
  ],
  preset_remove: [
    'Dropping the {label} pack. Lighter already.',
    '{label} pack unloaded. My back thanks you.'
  ],
  risk_high: [
    'That’s… a LOT of ground. I’ll pace us, but pack water.',
    'Big plan. Bold. Slightly sweaty. Consider a smaller budget?'
  ],
  pip_poke: [
    'You rang? The needle’s always on.',
    'Careful — I’m freshly calibrated.',
    'North is that way. Probably.',
    'Wheee. Okay, back to work.',
    'That tickles the magnetism.',
    'I’m a compass, not a fidget spinner. …Do it again.'
  ]
};

function hashSeed(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

function fill(line, fills) {
  return line.replace(/\{(\w+)\}/g, (_, key) => String(fills[key] ?? ''));
}

export function quip(context, fills = {}, seed = '') {
  const pool = QUIPS[context] || [];
  if (!pool.length) return '';
  return fill(pool[hashSeed(`${context}:${seed}`) % pool.length], fills);
}

export function randomQuip(context, fills = {}) {
  const pool = QUIPS[context] || [];
  if (!pool.length) return '';
  return fill(pool[Math.floor(Math.random() * pool.length)], fills);
}
