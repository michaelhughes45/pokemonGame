import mongoose from 'mongoose';
import { PokedexCache } from '../models/PokedexCache';
import { User } from '../models/User';
import { Campaign } from '../models/Campaign';
import { Pokemon } from '../models/Pokemon';
import { computeStats, expForLevel, BaseStats } from './statCalc';
import { pokeDisplayName } from './battleCalc';
import { canEvolve } from './evolution';
import { resolveEvolvedSpecies } from './evolutionResolve';
import { getIvsForOwner } from './trainerIv';

export const BASE_LEVEL_CAP = 6;
export const BADGE_LEVEL_BONUS = 3;

// Per-player effective level cap: 6 + 3 per badge, uncapped (100) when the
// campaign's DM has disabled the cap. Player Pokémon only — NPCs/wild are
// never bound by this.
export function getEffectiveLevelCap(badgeCount: number, levelCapEnabled: boolean): number {
  if (!levelCapEnabled) return 100;
  return Math.min(100, BASE_LEVEL_CAP + BADGE_LEVEL_BONUS * badgeCount);
}

// Convenience wrapper for single-player call sites (DM award-exp/level-up, Rare Candy)
// that don't already have the campaign + badge count batched in hand the way the
// battle-EXP path does. Returns 100 (uncapped) if the player has no current campaign —
// the cap only applies within one.
export async function getPlayerEffectiveLevelCap(userId: string | mongoose.Types.ObjectId): Promise<number> {
  const user = await User.findById(userId, 'badges currentCampaignId').lean();
  if (!user?.currentCampaignId) return 100;
  const campaign = await Campaign.findById(user.currentCampaignId, 'levelCapEnabled').lean();
  return getEffectiveLevelCap(user.badges?.length ?? 0, campaign?.levelCapEnabled ?? true);
}

type EvolutionOverride = { condition: string; value: string };

export type LevelUpLoopResult = {
  level: number;
  currentHp: number;
  speciesId: number;
  events: string[];
  // True when banked exp already covers the next level but `cap` stopped the loop.
  cappedOut: boolean;
};

// Replays the level-up + evolution while-loop against already-banked `exp`,
// bounded by `cap` instead of the hard 100 ceiling. Pure with respect to the
// passed-in state — callers are responsible for persisting the result.
// Shared by every level-raising path (battle EXP, DM award-exp/level-up,
// Rare Candy) so the cap is enforced identically everywhere, and by the
// cap-rise "unlock" pass that replays pending levels once a player's cap goes up.
export async function applyLevelUpLoop(params: {
  displayName: string;
  level: number;
  exp: number;
  currentHp: number;
  speciesId: number;
  nature: string;
  evolutionOverrides: EvolutionOverride[];
  expGroup: string;
  baseStats: BaseStats | undefined;
  evs: BaseStats;
  ivs: BaseStats;
  cap: number;
}): Promise<LevelUpLoopResult> {
  const { displayName, exp, nature, expGroup, baseStats, evs, ivs, cap } = params;
  let level = params.level;
  let currentHp = params.currentHp;
  let speciesId = params.speciesId;
  const events: string[] = [];

  while (level < cap && exp >= expForLevel(level + 1, expGroup)) {
    if (baseStats && currentHp > 0) {
      const oldMaxHp = computeStats(baseStats, level, nature, evs, ivs).hp;
      level += 1;
      currentHp += computeStats(baseStats, level, nature, evs, ivs).hp - oldMaxHp;
    } else {
      level += 1;
    }
    events.push(`${displayName} grew to level ${level}!`);

    const evolveIntoId = await canEvolve({ speciesId, level, evolutionOverrides: params.evolutionOverrides });
    if (evolveIntoId !== null) {
      const { displayName: evolvedName, fullHp } = await resolveEvolvedSpecies(evolveIntoId, level, nature, evs, ivs);
      if (fullHp !== null) currentHp = fullHp;
      events.push(`${displayName} evolved into ${evolvedName}!`);
      speciesId = evolveIntoId;
    }
  }

  const cappedOut = level < 100 && level >= cap && exp >= expForLevel(level + 1, expGroup);

  return { level, currentHp, speciesId, events, cappedOut };
}

// Replays every one of a player's Pokémon against a newly effective `cap`, persisting
// any level-ups/evolutions unlocked by already-banked exp. Called whenever a player's
// cap might have just risen (DM disables the campaign-wide toggle now; a badge award
// in 5.3 will call this too) — banked exp converts immediately instead of waiting for
// the next battle or DM action to touch that Pokémon. Existing levels are never
// lowered — `applyLevelUpLoop` only ever grows from the Pokémon's current level.
// Returns the number of Pokémon whose level actually changed.
export async function unlockPendingLevelUpsForPlayer(
  ownerId: string | mongoose.Types.ObjectId,
  cap: number,
): Promise<number> {
  const pokemonList = await Pokemon.find(
    { ownerId, ownerType: 'player' },
    '_id nickname speciesId level exp nature currentHp evolutionOverrides evs',
  ).lean();
  const growable = pokemonList.filter(p => (p.level as number) < cap);
  if (growable.length === 0) return 0;

  const speciesIds = [...new Set(growable.map(p => p.speciesId))];
  const caches = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name expGroup baseStats').lean();
  const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const ivs = await getIvsForOwner(ownerId, 'player');

  let changedCount = 0;
  for (const poke of growable) {
    const cache = cacheMap.get(poke.speciesId);
    const overrides = (poke.evolutionOverrides ?? []) as EvolutionOverride[];

    const { level: newLevel, currentHp: newHp, speciesId: newSpeciesId } = await applyLevelUpLoop({
      displayName: pokeDisplayName(poke, cache),
      level: poke.level as number,
      exp: poke.exp as number,
      currentHp: poke.currentHp as number,
      speciesId: poke.speciesId as number,
      nature: poke.nature as string,
      evolutionOverrides: overrides,
      expGroup: (cache?.expGroup as string | undefined) ?? 'medium-fast',
      baseStats: cache?.baseStats as BaseStats | undefined,
      evs: poke.evs as BaseStats,
      ivs,
      cap,
    });

    if (newLevel !== poke.level) {
      await Pokemon.updateOne({ _id: poke._id }, { $set: { level: newLevel, currentHp: newHp, speciesId: newSpeciesId } });
      changedCount += 1;
    }
  }

  return changedCount;
}
