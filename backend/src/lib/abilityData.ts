export type StatusCondition = 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic' | 'confusion';

// Abilities that grant immunity to one or more status conditions.
export const STATUS_IMMUNITY_ABILITIES: Record<string, StatusCondition[]> = {
  'immunity':     ['poison', 'toxic'],
  'insomnia':     ['sleep'],
  'vital-spirit': ['sleep'],
  'magma-armor':  ['freeze'],
  'water-veil':   ['burn'],
  'limber':       ['paralysis'],
  'own-tempo':    ['confusion'],
  'oblivious':    ['confusion'],
};

// Abilities that convert Normal-type moves to another type with a 1.2× power boost.
export const ILATE_MAP: Record<string, string> = {
  'pixilate':    'Fairy',
  'aerilate':    'Flying',
  'refrigerate': 'Ice',
  'galvanize':   'Electric',
};

// Pokémon whose pinch ability fires a message when HP drops to or below 1/3.
// Values are lowercase move types to match PokeAPI's casing.
export const PINCH_ABILITIES: Record<string, string> = {
  'torrent':  'water',
  'blaze':    'fire',
  'overgrow': 'grass',
  'swarm':    'bug',
};

// Abilities that double Speed in a specific weather condition.
export const WEATHER_SPEED_DOUBLERS: Record<string, string[]> = {
  'swift-swim':  ['rain'],
  'chlorophyll': ['sun'],
  'sand-rush':   ['sandstorm'],
  'slush-rush':  ['hail', 'snow'],
};
