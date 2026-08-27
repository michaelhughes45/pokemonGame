import { IBattle } from '../models/Battle';

export type TerrainMoveEffect = {
  terrain: NonNullable<IBattle['terrain']>;
  startMessage: string;
};

// Moves that set field terrain when used. Unlike WEATHER_MOVES, setting terrain always
// overwrites whatever terrain (if any) was already active — real terrain moves don't
// have weather's "clear first, reapply next time" quirk.
export const TERRAIN_MOVES: Record<string, TerrainMoveEffect> = {
  'electric-terrain': { terrain: 'electric', startMessage: 'An electric current runs across the battlefield!' },
  'grassy-terrain':   { terrain: 'grassy',   startMessage: 'Grass grew to cover the battlefield!' },
  'misty-terrain':    { terrain: 'misty',    startMessage: 'Mist swirled around the battlefield!' },
  'psychic-terrain':  { terrain: 'psychic',  startMessage: 'The battlefield got weird!' },
};

// Capitalized names for @smogon/calc's Field.terrain (which expects e.g. 'Electric',
// not 'electric') and for end-of-round "wore off" messages.
export const TERRAIN_DISPLAY_NAMES: Record<NonNullable<IBattle['terrain']>, string> = {
  electric: 'Electric',
  grassy:   'Grassy',
  misty:    'Misty',
  psychic:  'Psychic',
};

export const TERRAIN_END_MESSAGES: Record<NonNullable<IBattle['terrain']>, string> = {
  electric: 'The electricity disappeared from the battlefield!',
  grassy:   'The grass disappeared from the battlefield!',
  misty:    'The mist disappeared from the battlefield!',
  psychic:  'The weirdness disappeared from the battlefield!',
};
