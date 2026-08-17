import type { HydratedDocument } from 'mongoose';
import { Generations } from '@smogon/calc';
import { IBattle, StatStages } from '../models/Battle';
import { StatEffect, STAT_DISPLAY_NAMES } from './moveData';
import { BaseStats } from './statCalc';

export const GEN9 = Generations.get(9);

// The 18 canonical Pokémon types, lowercase PokeAPI-slug form (matches how types are
// stored everywhere in this project — PokedexCache.types, moveData.ts, etc.). Used by
// Conversion 2 (milestone 5.14 Wave 11) to find a type that resists a given move type.
export const ALL_TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison',
  'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark',
  'steel', 'fairy',
];

export type CachedAbility = { name: string; isHidden: boolean };

// Capitalize the first character of a string. Used to format names for @smogon/calc.
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Computes the real type-effectiveness multiplier (0, 0.25, 0.5, 1, 2, 4, ...) for a
// move type against a (possibly dual-type) defender. @smogon/calc's result.desc() text
// never actually contains the words "super effective" / "not very effective" — this is
// the only reliable way to know effectiveness for turn-log narration.
export function getTypeEffectiveness(moveType: string, defenderTypes: string[]): number {
  const type = GEN9.types.get(moveType.toLowerCase() as any);
  if (!type) return 1;
  return defenderTypes.reduce((mult, t) => mult * ((type.effectiveness as any)[cap(t)] ?? 1), 1);
}

// Soak/Conversion/Camouflage/Reflect Type/Conversion 2 (milestone 5.14 Wave 11) can
// override a Pokémon's real (PokedexCache-derived) types for the rest of its time on
// the field. This is the single place every type-dependent call site should read a
// Pokémon's types from instead of trusting cache.types directly — same pattern as
// getEffectiveAbilitySlugs for tracedAbility. Cleared on switch-out/faint (see
// battleController.ts's recallPokemon/resolveBatonPass/applyFaints). Accepts a plain
// { typeOverride } shape (not the full HydratedDocument) so read-only call sites like
// the state endpoint's .lean() battle also work without a mutation-capable document.
export function getEffectiveTypes(
  battle:        { typeOverride?: Record<string, string[]> },
  pokemonId:     string,
  fallbackTypes: string[],
): string[] {
  return battle.typeOverride?.[pokemonId] ?? fallbackTypes;
}

// Convert our stored EV spread (spatk/spdef/speed) to @smogon/calc's stat key
// format (spa/spd/spe) so a Pokémon's real EVs feed into the damage formula.
export function toCalcEvs(evs: BaseStats) {
  return { hp: evs.hp, atk: evs.atk, def: evs.def, spa: evs.spatk, spd: evs.spdef, spe: evs.speed };
}

// Same mapping for a Pokémon owner's Trainer IV spread (milestone 5.5) — the
// only IV source in this project (no per-Pokémon IVs exist).
export function toCalcIvs(ivs: BaseStats) {
  return { hp: ivs.hp, atk: ivs.atk, def: ivs.def, spa: ivs.spatk, spd: ivs.spdef, spe: ivs.speed };
}

// A handful of real item names don't survive the naive slug-to-title split
// (e.g. "never-melt-ice" needs to stay hyphenated as "Never-Melt Ice", not
// become "Never Melt Ice") — everything else converts cleanly the same way
// move/ability slugs do.
const ITEM_NAME_OVERRIDES: Record<string, string> = {
  'never-melt-ice': 'Never-Melt Ice',
};

// Milestone 5.17a — maps our stored heldItem slug to the exact display name
// @smogon/calc's own item table expects (checked directly against the
// library's data/items.ts, not guessed). Passing this into CalcPokemon is
// what actually activates type-boost items (Charcoal, the type Plates, etc.)
// and — once competitive held items land in 5.17b — everything else the
// library already knows how to apply (Choice items, Life Orb, Eviolite,
// Assault Vest, and so on) for free, with zero extra project code needed for
// any item @smogon/calc's damage formula already understands.
export function toCalcItem(itemId: string | null | undefined): string | undefined {
  // Mints (milestone 5.12) can be held as loot but have no passive effect while
  // merely held — they're not a real item @smogon/calc's table would recognise
  // anyway, but this keeps the intent explicit rather than relying on the
  // library silently ignoring an unmatched name.
  if (!itemId || itemId.startsWith('mint-')) return undefined;
  return ITEM_NAME_OVERRIDES[itemId] ?? slugToDisplayName(itemId);
}

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

// Homebrew departure from the real games: EVERY non-hidden ability a species has is
// active simultaneously on that Pokémon (not just one slot), plus the hidden ability
// when hasHiddenAbility is set AND the campaign hasn't disabled hidden abilities. The
// first entry is treated as "primary" by callers that can only apply one ability's
// effect at a time (mainly @smogon/calc's single ability field) — everything else
// (status immunity, entry/end-of-round/contact triggers, Contrary/Simple, etc.) checks
// the whole array, since this project controls that logic directly.
export function resolveActiveAbilitySlugs(
  abilities: CachedAbility[],
  hasHiddenAbility: boolean,
  hiddenAbilitiesEnabled: boolean,
): string[] {
  const nonHidden = abilities.filter(a => !a.isHidden).map(a => a.name);
  if (hasHiddenAbility && hiddenAbilitiesEnabled) {
    const hidden = abilities.find(a => a.isHidden);
    if (hidden) return [hidden.name, ...nonHidden];
  }
  return nonHidden;
}

// Same as resolveActiveAbilitySlugs, but also appends a Trace-copied ability (if any) —
// the single place every ability lookup should go through once Trace can add to the set.
// A traced ability ADDS to the Pokémon's active abilities rather than replacing them,
// matching this project's "abilities stack" model — real Trace fully replaces the
// user's ability, but that doesn't map cleanly onto a Pokémon that already has more
// than one ability active at once.
// Narrowed to just the fields actually read — lets read-only call sites (e.g.
// getBattleState's .lean() read, or the AI move/target scoring in lib/npcAi.ts)
// pass a plain lean object instead of a full HydratedDocument, which they don't
// have and don't need one just to read two fields.
export function getEffectiveAbilitySlugs(
  battle: Pick<IBattle, 'hiddenAbilitiesEnabled' | 'tracedAbility'>,
  pokemonId: string,
  abilities: CachedAbility[],
  hasHiddenAbility: boolean,
): string[] {
  const active = resolveActiveAbilitySlugs(abilities, hasHiddenAbility, battle.hiddenAbilitiesEnabled);
  const traced = (battle.tracedAbility as Record<string, string> | undefined)?.[pokemonId];
  return traced ? [...active, traced] : active;
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
  stageMap:      Record<string, StatStages>,
  pokemonId:     string,
  effects:       StatEffect[],
  name:          string,
  abilitySlugs?: string[] | null,
): string[] {
  if (!stageMap[pokemonId]) {
    stageMap[pokemonId] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
  }
  const stages = stageMap[pokemonId];
  const events: string[] = [];

  for (const effect of effects) {
    let stageChange = effect.stages;
    // Both can genuinely stack — Contrary flips the sign, then Simple doubles whatever
    // sign/magnitude results, same as if a single Pokémon really had both at once.
    if (abilitySlugs?.includes('contrary')) stageChange = -stageChange;
    if (abilitySlugs?.includes('simple'))   stageChange *= 2;

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
