import { StatStages } from '../models/Battle';

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

// Plain type-keyed immunity/interaction abilities — checked against the DEFENDER's full
// active-ability array before a move ever reaches @smogon/calc, so multiple such
// abilities on one Pokémon (its two non-hidden slots, say) all genuinely apply, unlike
// @smogon/calc's single "primary" ability field. Deliberately excludes abilities whose
// immunity depends on a move FLAG rather than a type (Soundproof/sound, Bulletproof/
// ballistic — no such flag table exists in this project yet), abilities with a
// move-redirect component (Storm Drain, Lightning Rod — redirect is skipped, same
// "no auto-redirect" simplification already accepted for Counter), and Dry Skin (heal +
// fire-vulnerability + weather ticks is genuinely multi-part, left as a future gap).
// Wonder Guard is handled separately in resolveMove (it checks type EFFECTIVENESS, not
// a fixed type, so it can't live in this simple type-keyed table).
export type TypeImmunityEffect = {
  abilitySlug: string;
  type: string; // lowercase move type this blocks
  action: 'immune' | 'heal' | 'boost-stat' | 'flash-fire-boost';
  stat?: keyof StatStages; // only for action: 'boost-stat'
};

export const TYPE_IMMUNITY_ABILITIES: TypeImmunityEffect[] = [
  { abilitySlug: 'levitate',     type: 'ground',   action: 'immune' },
  { abilitySlug: 'water-absorb', type: 'water',    action: 'heal' },
  { abilitySlug: 'volt-absorb',  type: 'electric', action: 'heal' },
  { abilitySlug: 'sap-sipper',   type: 'grass',    action: 'boost-stat', stat: 'atk' },
  { abilitySlug: 'motor-drive',  type: 'electric', action: 'boost-stat', stat: 'spe' },
  { abilitySlug: 'flash-fire',   type: 'fire',     action: 'flash-fire-boost' },
];

// Abilities Trace cannot copy — cross-checked against Bulbapedia (two independent fetches
// agreed on the core list; the newest gen9 additions carry slightly more uncertainty, so
// this errs toward inclusion rather than guessing an ability is copyable).
export const TRACE_BLOCKED_ABILITIES = new Set([
  'as-one', 'battle-bond', 'comatose', 'commander', 'disguise', 'embody-aspect',
  'flower-gift', 'forecast', 'gulp-missile', 'hunger-switch', 'ice-face', 'illusion',
  'imposter', 'multitype', 'neutralizing-gas', 'poison-puppeteer', 'power-construct',
  'power-of-alchemy', 'protosynthesis', 'quark-drive', 'receiver', 'rks-system',
  'schooling', 'shields-down', 'stance-change', 'teraform-zero', 'tera-shell',
  'tera-shift', 'trace', 'zen-mode', 'zero-to-hero',
]);
