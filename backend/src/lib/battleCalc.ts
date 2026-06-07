import { Generations } from '@smogon/calc';
import { IBattle, StatStages } from '../models/Battle';
import { StatEffect, STAT_DISPLAY_NAMES } from './moveData';

export const GEN9 = Generations.get(9);

// Convert a PokeAPI slug to a display name. "ice-beam" → "Ice Beam"
export function slugToDisplayName(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
  abilities: Array<{ name: string; isHidden: boolean }>,
  hasHiddenAbility: boolean,
): string | null {
  const ability = hasHiddenAbility
    ? (abilities.find(a => a.isHidden) ?? abilities.find(a => !a.isHidden))
    : abilities.find(a => !a.isHidden);
  return ability?.name ?? null;
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
