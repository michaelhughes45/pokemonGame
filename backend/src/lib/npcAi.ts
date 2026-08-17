import mongoose, { HydratedDocument } from 'mongoose';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field } from '@smogon/calc';
import { IBattle } from '../models/Battle';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { User } from '../models/User';
import { BaseStats, ZERO_IVS } from '../lib/statCalc';
import { ivsFromSpread } from '../lib/trainerIv';
import { NO_TARGET_MOVE_IDS } from '../lib/moveData';
import {
  GEN9, type CachedAbility, slugToDisplayName, cap, toCalcEvs, toCalcIvs, toCalcItem,
  toCalcWeather, getEffectiveAbilitySlugs,
} from '../lib/battleCalc';

// Milestone 6.5 — see Npc.ts's AiStrategy for the full tier rundown. 'smartest'
// is aliased to 'highest-damage' scoring here until milestone 6.7 gives it real
// tactics beyond raw damage-maximization.
export type NpcAiStrategy = 'worst' | 'random' | 'highest-damage' | 'smartest';
export const AI_STRATEGIES: NpcAiStrategy[] = ['worst', 'random', 'highest-damage', 'smartest'];

type AttackerInfo = {
  _id: mongoose.Types.ObjectId;
  speciesId: number;
  nature: string;
  level: number;
  currentHp: number;
  evs: BaseStats;
  heldItem?: string | null;
  hasHiddenAbility?: boolean;
};

// Read-only @smogon/calc wrapper — average damage roll for one (move, target) pair.
// Returns 0 on any error (unrecognised move/species, etc.) rather than throwing,
// since a scoring heuristic should never be able to crash move selection.
async function estimateDamage(
  attacker: { currentHp: number; nature: string; level: number; evs: BaseStats; heldItem?: string | null },
  attackerCache: { name: unknown },
  attackerAbilitySlug: string | null,
  moveId: string,
  target: { currentHp: number; nature: string; level: number; evs: BaseStats; heldItem?: string | null },
  targetCache: { name: unknown },
  targetAbilitySlug: string | null,
  weather: string | null,
  attackerIvs: BaseStats = ZERO_IVS,
  targetIvs: BaseStats = ZERO_IVS,
): Promise<number> {
  try {
    const calcAtk = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), {
      level: attacker.level, nature: cap(attacker.nature) as any, evs: toCalcEvs(attacker.evs), ivs: toCalcIvs(attackerIvs),
      curHP: attacker.currentHp, ability: attackerAbilitySlug ? slugToDisplayName(attackerAbilitySlug) as any : undefined,
      item: toCalcItem(attacker.heldItem) as any,
    });
    const calcTgt = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level: target.level, nature: cap(target.nature) as any, evs: toCalcEvs(target.evs), ivs: toCalcIvs(targetIvs),
      curHP: target.currentHp, ability: targetAbilitySlug ? slugToDisplayName(targetAbilitySlug) as any : undefined,
      item: toCalcItem(target.heldItem) as any,
    });
    const result = calculate(GEN9, calcAtk, calcTgt, new CalcMove(GEN9, slugToDisplayName(moveId)), new Field({ weather: toCalcWeather(weather as any) as any }));
    const rolls  = Array.isArray(result.damage) ? (result.damage as number[]) : [result.damage as number];
    return rolls.reduce((s, r) => s + r, 0) / rolls.length;
  } catch {
    return 0;
  }
}

// The single entry point for NPC/wild move choice (milestone 6.5) — 'random' picks
// uniformly from legal moves with no scoring pass at all; 'worst'/'highest-damage'/
// 'smartest' all score every (move, target) pair against the active player Pokémon
// and pick the lowest/highest/highest respectively. Ties keep whichever pair was
// scored first (iteration order: moves outer, targets inner), matching the
// pre-extraction behavior this was lifted from.
export async function chooseNpcMoveId(
  battle: HydratedDocument<IBattle>,
  poke: AttackerInfo,
  movesWithPP: { moveId: string }[],
  strategy: NpcAiStrategy,
): Promise<string> {
  if (strategy === 'random') {
    return movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
  }

  const activePlayerIds = battle.playerSide.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!);
  const atkCache  = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name abilities').lean();
  // estimateDamage only ever applies one ability — a reasonable simplification for
  // an approximate AI move-choice heuristic, not the real damage-calc path.
  const atkAbility = atkCache ? (getEffectiveAbilitySlugs(battle, poke._id.toString(), atkCache.abilities as CachedAbility[], poke.hasHiddenAbility ?? false)[0] ?? null) : null;

  const targetPokes = activePlayerIds.length > 0
    ? await Pokemon.find({ _id: { $in: activePlayerIds } }, 'currentHp nature level speciesId hasHiddenAbility evs heldItem').lean()
    : [];
  const tCaches = targetPokes.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: targetPokes.map(t => t.speciesId) } }, 'pokeApiId name abilities').lean()
    : [];
  const cacheBySpecies = new Map(tCaches.map(c => [c.pokeApiId as number, c]));

  // NPC/wild attacker never carries a Trainer IV bonus, but its player targets do —
  // batch the owners once per decision (keyed via playerSide, no extra Pokemon field needed).
  const pokeIdToUserId = new Map(battle.playerSide.filter(e => e.activePokemonId != null).map(e => [e.activePokemonId!.toString(), e.userId.toString()]));
  const targetUserIds  = [...new Set(targetPokes.map(t => pokeIdToUserId.get(t._id.toString())).filter((id): id is string => !!id))];
  const targetOwners   = targetUserIds.length > 0 ? await User.find({ _id: { $in: targetUserIds } }, 'trainerStats').lean() : [];
  const targetIvsMap   = new Map(targetOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));

  const scored: { moveId: string; score: number }[] = [];
  for (const mv of movesWithPP) {
    if (NO_TARGET_MOVE_IDS.has(mv.moveId)) continue;
    for (const tgt of targetPokes) {
      const tCache = cacheBySpecies.get(tgt.speciesId);
      if (!tCache) continue;
      const tAbility  = getEffectiveAbilitySlugs(battle, tgt._id.toString(), tCache.abilities as CachedAbility[], tgt.hasHiddenAbility ?? false)[0] ?? null;
      const targetIvs = targetIvsMap.get(pokeIdToUserId.get(tgt._id.toString()) ?? '') ?? ZERO_IVS;
      const score = await estimateDamage(poke, atkCache ?? { name: poke.speciesId }, atkAbility, mv.moveId, tgt, tCache, tAbility, battle.weather as string | null, ZERO_IVS, targetIvs);
      scored.push({ moveId: mv.moveId, score });
    }
  }

  if (scored.length === 0) {
    return movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
  }

  return strategy === 'worst'
    ? scored.reduce((worst, s) => s.score < worst.score ? s : worst).moveId
    : scored.reduce((best, s) => s.score > best.score ? s : best).moveId;
}
