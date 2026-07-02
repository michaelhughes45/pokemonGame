import type { HydratedDocument } from 'mongoose';
import { Generations } from '@smogon/calc';
import { IBattle, StatStages } from '../models/Battle';
import { StatEffect, STAT_DISPLAY_NAMES } from './moveData';

export const GEN9 = Generations.get(9);

export type CachedAbility = { name: string; isHidden: boolean };

// Capitalize the first character of a string. Used to format names for @smogon/calc.
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Zero-valued stat block in @smogon/calc's stat key format. Used as a fallback
// when a Pokémon's base stats are unavailable.
export const ZERO_STATS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } as const;

// Convert a PokeAPI slug to a display name. "ice-beam" → "Ice Beam"
export function slugToDisplayName(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Returns the display name for a Pokémon: nickname if set, otherwise species name from cache.
export function pokeDisplayName(
  poke:     { nickname?: unknown } | null | undefined,
  cache:    { name?: unknown }    | null | undefined,
  fallback = 'Pokémon',
): string {
  return (poke?.nickname as string | null | undefined) ?? (cache ? slugToDisplayName(cache.name as string) : fallback);
}

// Map our battle weather strings to the values @smogon/calc expects.
export function toCalcWeather(weather: IBattle['weather']): string | undefined {
  if (!weather) return undefined;
  const map: Record<string, string> = {
    rain: 'Rain', sun: 'Sun', sandstorm: 'Sand', hail: 'Hail', snow: 'Snow',
  };
  return map[weather];
}

// Map our statusCondition strings to the StatusName values @smogon/calc expects.
export function toCalcStatus(status: string | null | undefined): string | undefined {
  if (!status) return undefined;
  const map: Record<string, string> = {
    burn: 'brn', paralysis: 'par', poison: 'psn', toxic: 'tox', sleep: 'slp', freeze: 'frz',
  };
  return map[status];
}

// Resolves which ability slug is active given a species' ability list and the
// hidden-ability toggle. Returns null if no abilities are cached.
export function resolveAbilitySlug(
  abilities: CachedAbility[],
  hasHiddenAbility: boolean,
): string | null {
  const ability = hasHiddenAbility
    ? (abilities.find(a => a.isHidden) ?? abilities.find(a => !a.isHidden))
    : abilities.find(a => !a.isHidden);
  return ability?.name ?? null;
}

// Combines an attacker's accuracy stage and a target's evasion stage into a single
// hit-chance multiplier, using the standard stage formula on their net stage (clamped -6..6).
export function accuracyStageMultiplier(attackerAccStage: number, targetEvaStage: number): number {
  const stage = Math.max(-6, Math.min(6, attackerAccStage - targetEvaStage));
  return stage >= 0 ? (3 + stage) / 3 : 3 / (3 - stage);
}

// Applies stat stage effects to a Pokémon in the battle's stage map and returns
// turn-log narration strings. Call battle.markModified('statStages') after.
export function applyStatStageEffects(
  stageMap:     Record<string, StatStages>,
  pokemonId:    string,
  effects:      StatEffect[],
  name:         string,
  abilitySlug?: string | null,
): string[] {
  if (!stageMap[pokemonId]) {
    stageMap[pokemonId] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
  }
  const stages = stageMap[pokemonId];
  const events: string[] = [];

  for (const effect of effects) {
    let stageChange = effect.stages;
    if (abilitySlug === 'contrary') stageChange = -stageChange;
    if (abilitySlug === 'simple')   stageChange *= 2;

    const current = stages[effect.stat];
    const clamped = Math.max(-6, Math.min(6, current + stageChange));
    const delta   = clamped - current;
    stages[effect.stat] = clamped;

    const label = STAT_DISPLAY_NAMES[effect.stat];
    if (delta === 0) {
      events.push(`${name}'s ${label} won't go ${stageChange > 0 ? 'any higher' : 'any lower'}!`);
    } else {
      const mag = Math.abs(delta) >= 3 ? 'drastically ' : Math.abs(delta) >= 2 ? 'sharply ' : '';
      events.push(`${name}'s ${label} ${mag}${delta > 0 ? 'rose' : 'fell'}!`);
    }
  }

  return events;
}

// Finds or creates the log entry for the current turn and appends events to it.
export function appendToLog(battle: HydratedDocument<IBattle>, ...events: string[]): void {
  if (events.length === 0) return;
  let entry = battle.turnLog.find(t => t.turn === battle.turnNumber);
  if (!entry) {
    battle.turnLog.push({ turn: battle.turnNumber, events: [] });
    entry = battle.turnLog[battle.turnLog.length - 1];
  }
  for (const ev of events) entry.events.push(ev);
  battle.markModified('turnLog');
}
