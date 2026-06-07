import { IBattle } from '../models/Battle';

export type WeatherMoveEffect = {
  weather: NonNullable<IBattle['weather']>;
  startMessage: string;
};

// Moves that set field weather when used.
export const WEATHER_MOVES: Record<string, WeatherMoveEffect> = {
  'sunny-day':        { weather: 'sun',       startMessage: 'The sunlight turned harsh!' },
  'rain-dance':       { weather: 'rain',       startMessage: 'It started to rain!' },
  'sandstorm':        { weather: 'sandstorm',  startMessage: 'A sandstorm kicked up!' },
  'hail':             { weather: 'hail',       startMessage: 'It started to hail!' },
  'snowscape':        { weather: 'snow',       startMessage: 'It started to snow!' },
  'chilly-reception': { weather: 'snow',       startMessage: 'It started to snow!' },
};

// Abilities that set field weather when the Pokémon enters.
// Ability-set weather is indefinite (weatherTurnsRemaining = null).
export const ENTRY_ABILITY_WEATHER: Partial<Record<string, NonNullable<IBattle['weather']>>> = {
  'drought':      'sun',
  'drizzle':      'rain',
  'sand-stream':  'sandstorm',
  'snow-warning': 'snow',
};

export const ENTRY_WEATHER_MESSAGES: Record<NonNullable<IBattle['weather']>, string> = {
  sun:       'The sunlight turned harsh!',
  rain:      'It started to rain!',
  sandstorm: 'A sandstorm kicked up!',
  hail:      'It started to hail!',
  snow:      'It started to snow!',
};
