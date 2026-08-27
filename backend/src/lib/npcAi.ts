import mongoose from 'mongoose';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field } from '@smogon/calc';
import { IBattle, StatStages } from '../models/Battle';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { User } from '../models/User';
import { Item } from '../models/Item';
import { Npc } from '../models/Npc';
import { BaseStats, ZERO_IVS, computeStats } from '../lib/statCalc';
import { ivsFromSpread } from '../lib/trainerIv';
import { NO_TARGET_MOVE_IDS, RECOVERY_MOVES, STAT_STAGE_MOVES } from '../lib/moveData';
import { BATTLE_ITEM_EFFECTS } from '../lib/itemData';
import {
  GEN9, type CachedAbility, slugToDisplayName, cap, toCalcEvs, toCalcIvs, toCalcItem,
  toCalcWeather, getEffectiveAbilitySlugs, getTypeEffectiveness,
} from '../lib/battleCalc';

// Milestone 6.5 — see Npc.ts's AiStrategy for the full tier rundown. 'smartest'
// gained kill-priority scoring in 6.7.1, recovery/stat-boost self-move awareness
// in 6.7.2, healing/status-cure item awareness in 6.7.3, and bad-matchup switch
// awareness in 6.7.4 (all below) — this closes out the full 6.7 milestone.
export type NpcAiStrategy = 'worst' | 'random' | 'highest-damage' | 'smartest';
export const AI_STRATEGIES: NpcAiStrategy[] = ['worst', 'random', 'highest-damage', 'smartest'];

// Only the fields these functions actually read — lets getBattleState's .lean()
// read (milestone 6.6) pass straight through without a HydratedDocument, same
// reasoning as getEffectiveAbilitySlugs's own narrowed param type. statStages
// added in 6.7.2 so scoreSelfTargetingMove can tell whether a stat-boost move
// still has room before capping at +6.
type BattleContext = Pick<IBattle, 'playerSide' | 'weather' | 'hiddenAbilitiesEnabled' | 'tracedAbility' | 'abilitySuppressed' | 'statStages'>;

type AttackerInfo = {
  _id: mongoose.Types.ObjectId;
  speciesId: number;
  nature: string;
  level: number;
  currentHp: number;
  evs: BaseStats;
  heldItem?: string | null;
  hasHiddenAbility?: boolean;
  // Added in 6.7.3 so chooseNpcAction can tell whether a status_cure item is
  // actually worth using right now.
  statusCondition?: string | null;
};

// Read-only @smogon/calc wrapper — average damage roll for one (move, target) pair.
// Returns 0 on any error (unrecognised move/species, etc.) rather than throwing,
// since a scoring heuristic should never be able to crash move/target selection.
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

// Milestone 6.7.1 — 'smartest' prefers any candidate that scores a KO over one
// that merely deals more raw damage, even when the KO's own damage number is
// lower (e.g. a weak move that finishes off a nearly-fainted target beats a
// strong move that leaves a healthier target standing). Ties within the same
// KO-ness bucket still fall back to highest raw damage. 'highest-damage' is
// deliberately left as pure damage-maximization with no KO awareness — the two
// tiers no longer share behavior now that 'smartest' has its own logic.
function isBetterForSmartest(a: { score: number; isKO: boolean }, b: { score: number; isKO: boolean }): boolean {
  if (a.isKO !== b.isKO) return a.isKO;
  return a.score > b.score;
}

// Each stage roughly increases damage output by 50% in the real stage-multiplier
// table (stage 2 = 2x neutral, i.e. +100% over 2 stages). Valuing a stage at a
// FRACTION of the current best attack's own score would mean a boost move could
// never mathematically outscore the very attack it's benchmarked against in the
// same comparison pool, which would make setup moves unpickable no matter how
// good they are — so instead this assumes the boost pays off over roughly two
// future attacking turns (deliberately simple, not a real turns-remaining
// simulation): 50%-per-stage × ~2 future turns ≈ 1.0x of the current best
// attack's score per net stage.
const STAT_BOOST_PER_STAGE_VALUE = 1.0;
// Rest heals to full HP but costs ~2 turns asleep — flat discount standing in for
// that tempo loss rather than a real multi-turn lookahead.
const REST_SLEEP_DISCOUNT = 0.5;

// Shared by recovery moves (below) and healing items (6.7.3) — a below-half-HP
// multiplier that corrects for healing near death being worth disproportionately
// more than the raw points restored (a fainted Pokémon deals zero damage on
// every future turn, not just this one). Uncapped-in-theory; the 5%-floor on the
// denominator just keeps it from blowing up as currentHp approaches 0.
function computeHpUrgency(currentHp: number, maxHp: number): number {
  const hpFraction = maxHp > 0 ? currentHp / maxHp : 1;
  return hpFraction < 0.5 ? 0.5 / Math.max(hpFraction, 0.05) : 1;
}

// Milestone 6.7.2 — 'smartest' only. Values the two self-targeting-move
// categories with the clearest real heuristic: recovery moves (RECOVERY_MOVES)
// and self stat-boost moves (the 'self'-target, positive-stage entries in
// STAT_STAGE_MOVES). Returns null for anything else in NO_TARGET_MOVE_IDS
// (weather-setting, Protect, Baton Pass, Focus Energy, Belly Drum, Ingrain/Aqua
// Ring, charge-move openers) — a deliberately deferred gap, same treatment this
// project already gives Illusion/Transform/Court Change — and also null when the
// move genuinely isn't worth using right now (already at full HP, or every
// boosted stat is already capped at +6).
//
// Recovery is valued in real HP points restored — the same unit a damaging
// move's own score is measured in (expected damage dealt), so the two compete
// on a genuinely comparable scale with no arbitrary constant needed — but a flat
// points-for-points comparison alone undervalues healing near death, since a
// fainted Pokémon deals zero damage on every future turn, not just this one. A
// below-half-HP urgency multiplier (uncapped-in-theory, but the 5%-floor on the
// denominator keeps it from blowing up near 0 HP) corrects for that without a
// real incoming-damage/threat estimate, which is out of scope here. Stat boosts
// have no natural HP-point value, so they're valued as a fraction of this
// Pokémon's own best currently-available attack score instead (see
// STAT_BOOST_PER_STAGE_VALUE), scaled by how much real stage room remains and
// discounted when this Pokémon's own HP is below half (setting up is a bad bet
// when it might not survive to cash the boost in).
function scoreSelfTargetingMove(
  moveId: string,
  currentHp: number,
  maxHp: number,
  weather: string | null,
  myStages: StatStages | undefined,
  bestAttackScore: number,
): number | null {
  const recoveryEffect = RECOVERY_MOVES[moveId];
  if (recoveryEffect) {
    const missingHp = maxHp - currentHp;
    if (missingHp <= 0) return null;
    const urgency = computeHpUrgency(currentHp, maxHp);
    if (recoveryEffect.type === 'rest') return missingHp * REST_SLEEP_DISCOUNT * urgency;
    const fraction = recoveryEffect.type === 'flat' ? recoveryEffect.fraction
      : weather === 'sun' ? 2 / 3 : !weather ? 0.5 : 0.25;
    return Math.min(missingHp, maxHp * fraction) * urgency;
  }

  const statEffects = STAT_STAGE_MOVES[moveId];
  if (statEffects) {
    let effectiveStages = 0;
    for (const e of statEffects) {
      if (e.target !== 'self' || e.stages <= 0) continue;
      const room = 6 - (myStages?.[e.stat] ?? 0);
      effectiveStages += Math.max(0, Math.min(e.stages, room));
    }
    if (effectiveStages <= 0) return null;
    const hpFraction = maxHp > 0 ? currentHp / maxHp : 1;
    const safety = hpFraction >= 0.5 ? 1 : hpFraction / 0.5;
    return bestAttackScore * STAT_BOOST_PER_STAGE_VALUE * effectiveStages * safety;
  }

  return null;
}

// This project's NPCs/wild Pokémon only ever live on enemySide facing playerSide
// opponents (pvp has no NPCs) — both chooseNpcMoveId and chooseNpcTargetId lean on
// that assumption to pull "the opponents" straight from battle.playerSide.
type ScoredTargetContext = {
  targetPokes: Awaited<ReturnType<typeof fetchTargetPokes>>;
  // types added in 6.7.4 for evaluateSwitchOption's defensive/offensive matchup checks.
  cacheBySpecies: Map<number, { pokeApiId: unknown; name: string; abilities: unknown; types: unknown }>;
  pokeIdToUserId: Map<string, string>;
  targetIvsMap: Map<string, BaseStats>;
};

async function fetchTargetPokes(activePlayerIds: mongoose.Types.ObjectId[]) {
  return activePlayerIds.length > 0
    ? Pokemon.find({ _id: { $in: activePlayerIds } }, 'currentHp nature level speciesId hasHiddenAbility evs heldItem').lean()
    : [];
}

// Gathers everything needed to score damage against every active player Pokémon —
// species caches, resolved abilities' inputs, and Trainer IVs — once per decision,
// shared by both chooseNpcMoveId (many moves × these targets) and chooseNpcTargetId
// (one move × these targets).
async function gatherTargetContext(battle: BattleContext): Promise<ScoredTargetContext> {
  const activePlayerIds = battle.playerSide.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!);
  const targetPokes = await fetchTargetPokes(activePlayerIds);
  const tCaches = targetPokes.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: targetPokes.map(t => t.speciesId) } }, 'pokeApiId name abilities types').lean()
    : [];
  const cacheBySpecies = new Map(tCaches.map(c => [c.pokeApiId as number, c]));

  // NPC/wild attacker never carries a Trainer IV bonus, but its player targets do —
  // batch the owners once per decision (keyed via playerSide, no extra Pokemon field needed).
  const pokeIdToUserId = new Map(battle.playerSide.filter(e => e.activePokemonId != null).map(e => [e.activePokemonId!.toString(), e.userId.toString()]));
  const targetUserIds  = [...new Set(targetPokes.map(t => pokeIdToUserId.get(t._id.toString())).filter((id): id is string => !!id))];
  const targetOwners   = targetUserIds.length > 0 ? await User.find({ _id: { $in: targetUserIds } }, 'trainerStats').lean() : [];
  const targetIvsMap   = new Map(targetOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));

  return { targetPokes, cacheBySpecies, pokeIdToUserId, targetIvsMap };
}

async function gatherAttackerContext(battle: BattleContext, poke: AttackerInfo) {
  // baseStats added in 6.7.2 — scoreSelfTargetingMove needs this Pokémon's own
  // maxHp to value recovery moves (in real HP points) and to gate stat-boost
  // moves by current HP%. types added in 6.7.4 for evaluateSwitchOption.
  const atkCache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name abilities baseStats types').lean();
  // estimateDamage only ever applies one ability — a reasonable simplification for
  // an approximate AI move/target heuristic, not the real damage-calc path.
  const atkAbility = atkCache ? (getEffectiveAbilitySlugs(battle, poke._id.toString(), atkCache.abilities as CachedAbility[], poke.hasHiddenAbility ?? false)[0] ?? null) : null;
  return { atkCache, atkAbility };
}

// Extracted from chooseNpcMoveId in 6.7.3 so chooseNpcAction can reuse the exact
// same move-scoring pass (damaging moves +, for 'smartest', self-targeting moves)
// when deciding whether an item beats the best available move — without either
// duplicating this logic or making chooseNpcMoveId itself return more than a
// moveId to every OTHER caller that doesn't need the extra detail. Caller must
// have already excluded strategy === 'random'.
async function buildMoveScoredCandidates(
  battle: BattleContext,
  poke: AttackerInfo,
  movesWithPP: { moveId: string }[],
  strategy: NpcAiStrategy,
): Promise<{
  scored: { moveId: string; score: number; isKO: boolean }[];
  maxHp: number | null;
  // Added in 6.7.4 for evaluateSwitchOption — reuses the species caches already
  // fetched here instead of a second round trip.
  myTypes: string[];
  opponentTypes: string[][];
}> {
  const { atkCache, atkAbility } = await gatherAttackerContext(battle, poke);
  const { targetPokes, cacheBySpecies, pokeIdToUserId, targetIvsMap } = await gatherTargetContext(battle);

  const scored: { moveId: string; score: number; isKO: boolean }[] = [];
  for (const mv of movesWithPP) {
    if (NO_TARGET_MOVE_IDS.has(mv.moveId)) continue;
    for (const tgt of targetPokes) {
      const tCache = cacheBySpecies.get(tgt.speciesId);
      if (!tCache) continue;
      const tAbility  = getEffectiveAbilitySlugs(battle, tgt._id.toString(), tCache.abilities as CachedAbility[], tgt.hasHiddenAbility ?? false)[0] ?? null;
      const targetIvs = targetIvsMap.get(pokeIdToUserId.get(tgt._id.toString()) ?? '') ?? ZERO_IVS;
      const score = await estimateDamage(poke, atkCache ?? { name: poke.speciesId }, atkAbility, mv.moveId, tgt, tCache, tAbility, battle.weather as string | null, ZERO_IVS, targetIvs);
      scored.push({ moveId: mv.moveId, score, isKO: score >= tgt.currentHp });
    }
  }

  const maxHp = atkCache?.baseStats
    ? computeStats(atkCache.baseStats as BaseStats, poke.level, poke.nature, poke.evs, ZERO_IVS).hp
    : null;

  // Milestone 6.7.2 — only 'smartest' brings self-targeting moves into the pool;
  // 'worst'/'highest-damage' stay pure damage-scoring and never consider them.
  // bestAttackScore is computed from the damaging candidates already scored
  // above, so a Pokémon with no legal attack at all (edge case) just falls
  // through to recovery-only or the random fallback in chooseNpcMoveId/Action.
  if (strategy === 'smartest' && maxHp !== null) {
    const bestAttackScore = scored.reduce((max, s) => Math.max(max, s.score), 0);
    const myStages = battle.statStages?.[poke._id.toString()];
    for (const mv of movesWithPP) {
      if (!NO_TARGET_MOVE_IDS.has(mv.moveId)) continue;
      const selfScore = scoreSelfTargetingMove(mv.moveId, poke.currentHp, maxHp, battle.weather as string | null, myStages, bestAttackScore);
      if (selfScore !== null) scored.push({ moveId: mv.moveId, score: selfScore, isKO: false });
    }
  }

  const myTypes = (atkCache?.types as string[] | undefined) ?? [];
  const opponentTypes = targetPokes
    .map(t => (cacheBySpecies.get(t.speciesId)?.types as string[] | undefined) ?? [])
    .filter(types => types.length > 0);

  return { scored, maxHp, myTypes, opponentTypes };
}

// The single entry point for NPC/wild move choice (milestone 6.5) — 'random' picks
// uniformly from legal moves with no scoring pass at all; 'worst'/'highest-damage'/
// 'smartest' all score every (move, target) pair against the active player Pokémon.
// 'worst' picks the lowest score, 'highest-damage' the highest score, and 'smartest'
// (6.7.1) the highest-scoring candidate after preferring any KO over a non-KO — see
// isBetterForSmartest. Ties within a strategy's own comparator keep whichever pair
// was scored first (iteration order: moves outer, targets inner), matching the
// pre-extraction behavior this was lifted from.
export async function chooseNpcMoveId(
  battle: BattleContext,
  poke: AttackerInfo,
  movesWithPP: { moveId: string }[],
  strategy: NpcAiStrategy,
): Promise<string> {
  if (strategy === 'random') {
    return movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
  }

  const { scored } = await buildMoveScoredCandidates(battle, poke, movesWithPP, strategy);

  if (scored.length === 0) {
    return movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
  }

  if (strategy === 'worst') {
    return scored.reduce((worst, s) => s.score < worst.score ? s : worst).moveId;
  }
  if (strategy === 'smartest') {
    return scored.reduce((best, s) => isBetterForSmartest(s, best) ? s : best).moveId;
  }
  return scored.reduce((best, s) => s.score > best.score ? s : best).moveId;
}

// Relative "how bad is it to keep acting under this status" weights, used to
// value a status_cure item as a multiple of this Pokémon's own best available
// attack score (no natural HP-point value the way healing has). Values a
// FRACTION below 1.0 could never mathematically outscore the very attack
// they're benchmarked against in the same comparison (the identical bug found
// and fixed for stat-boost moves in 6.7.2) — so, same fix, these are valued
// across multiple future turns of the status persisting, not this one turn's
// opportunity cost alone. Sleep/freeze sit clearly above the 1.0 break-even
// point (both risk losing several ENTIRE turns, not just a fraction of one);
// paralysis/toxic sit just above it (worth curing, but not dramatically);
// flat-damage poison/burn are deliberately left below break-even — curing
// minor chip damage is genuinely not worth interrupting a good attack, so
// they'll rarely if ever be chosen over attacking, same as a 1-stage stat
// boost rarely wins in 6.7.2. Hand-authored severity ranking, not a real
// expected-turns-lost simulation.
const STATUS_CURE_VALUE: Record<string, number> = {
  sleep: 2.0, freeze: 2.0, paralysis: 1.2, toxic: 1.3, poison: 0.4, burn: 0.4,
};

// Milestone 6.7.3 — values one NPC bag item against this Pokémon's own current
// HP/status, in the same score units as a move's damage score (real HP points
// for healing, a multiple of bestAttackScore for status_cure — mirroring
// scoreSelfTargetingMove's split for the exact same reason). Deliberately
// narrow scope, matching the milestone's own framing ("beyond the old
// 'defensive' tier's healing-only check"): only the 'healing' and 'status_cure'
// pockets are considered, and only the hp_flat/hp_full/hp_full_cure healing
// kinds — 'revive' targets a benched (fainted) party member, a genuinely
// different targeting shape than "act on my own active Pokémon" every other
// case here uses, and stays out of scope. hp_full_cure (Full Restore) also
// cures status for free in the real item logic, but that side benefit isn't
// added to its score here — a minor undervaluation, not a correctness issue.
function scoreItemCandidate(
  itemId: string,
  pocket: string,
  currentHp: number,
  maxHp: number,
  statusCondition: string | null,
  bestAttackScore: number,
): number | null {
  const effect = BATTLE_ITEM_EFFECTS[itemId];
  if (!effect) return null;

  if (pocket === 'healing') {
    const missingHp = maxHp - currentHp;
    if (missingHp <= 0) return null;
    let healAmount: number;
    if (effect.kind === 'hp_flat') healAmount = effect.amount;
    else if (effect.kind === 'hp_full' || effect.kind === 'hp_full_cure') healAmount = missingHp;
    else return null;
    return Math.min(missingHp, healAmount) * computeHpUrgency(currentHp, maxHp);
  }

  if (pocket === 'status_cure') {
    if (!statusCondition || effect.kind !== 'status_cure') return null;
    const cures = effect.cures === 'all' || effect.cures.includes(statusCondition);
    if (!cures) return null;
    return bestAttackScore * (STATUS_CURE_VALUE[statusCondition] ?? 0.3);
  }

  return null;
}

// Milestone 6.7.4 — 'smartest' + trainer NPCs only (wild has no bench to switch
// into, matching the item-awareness scope from 6.7.3). Deliberately requires a
// mismatch that runs BOTH ways before it's worth giving up a turn to flee — the
// milestone's own framing explicitly rules out a naive "any resistance exists"
// check: some active opponent's typing must hit this Pokémon for 2x+ (a real
// defensive disadvantage) AND this Pokémon's own typing must be resisted, 0.5x
// or worse, against that opponent (a real offensive disadvantage too). A
// one-sided mismatch (I resist them but can't hit back well either, or I hit
// them fine but they also hit me hard) isn't enough on its own to flee. Only
// suggested when a genuinely BETTER bench replacement exists — never switches
// away without switching to something that actually improves the matchup.
// Type-only heuristic throughout (candidate offense is approximated from the
// bench Pokémon's own typing as a STAB proxy, not a real per-move damage
// estimate for every bench member) — consistent with treating "type matchup"
// as the tractable proxy for a real threat assessment this file already uses
// elsewhere (e.g. no typeOverride/Soak-Conversion awareness here either).
async function evaluateSwitchOption(
  npcId: mongoose.Types.ObjectId,
  poke: AttackerInfo,
  myTypes: string[],
  opponentTypes: string[][],
): Promise<string | null> {
  if (myTypes.length === 0 || opponentTypes.length === 0) return null;

  const worstIncoming = Math.max(...opponentTypes.flatMap(oppTypes => oppTypes.map(t => getTypeEffectiveness(t, myTypes))));
  if (worstIncoming < 2) return null;

  const myBestOffense = Math.max(...opponentTypes.map(oppTypes => Math.max(...myTypes.map(t => getTypeEffectiveness(t, oppTypes)))));
  if (myBestOffense > 0.5) return null;
  const myOwnScore = myBestOffense - worstIncoming;

  const npc = await Npc.findById(npcId, 'party').lean();
  if (!npc) return null;
  const benchIds = npc.party.filter((id: mongoose.Types.ObjectId) => id.toString() !== poke._id.toString());
  if (benchIds.length === 0) return null;

  const bench = await Pokemon.find({ _id: { $in: benchIds }, currentHp: { $gt: 0 } }, 'speciesId').lean();
  if (bench.length === 0) return null;
  const benchCaches = await PokedexCache.find({ pokeApiId: { $in: bench.map(b => b.speciesId) } }, 'pokeApiId types').lean();
  const typesBySpecies = new Map(benchCaches.map(c => [c.pokeApiId as number, c.types as string[]]));

  let bestCandidate: { id: string; score: number } | null = null;
  for (const b of bench) {
    const bTypes = typesBySpecies.get(b.speciesId);
    if (!bTypes || bTypes.length === 0) continue;
    const candidateOffense = Math.max(...opponentTypes.map(oppTypes => Math.max(...bTypes.map(t => getTypeEffectiveness(t, oppTypes)))));
    const candidateDefense = Math.max(...opponentTypes.flatMap(oppTypes => oppTypes.map(t => getTypeEffectiveness(t, bTypes))));
    const score = candidateOffense - candidateDefense;
    if (!bestCandidate || score > bestCandidate.score) bestCandidate = { id: b._id.toString(), score };
  }

  if (!bestCandidate || bestCandidate.score <= myOwnScore) return null;
  return bestCandidate.id;
}

export type NpcAction =
  | { type: 'move'; moveId: string }
  | { type: 'item'; itemId: string; targetPokemonId: string }
  | { type: 'switch'; switchToPokemonId: string };

// Milestone 6.7.3/6.7.4 — the entry point dmAutoSubmit calls instead of
// chooseNpcMoveId directly, so item use and switching can each be weighed
// against the best available move rather than tacked on as separate rules.
// Only trainer NPCs have a bag or a bench to switch into at all (wild Pokémon
// have neither, matching the pre-existing NPC/wild item-tab distinction) —
// pass npcId: null for wild slots and this degrades to exactly
// chooseNpcMoveId's move-only choice. Both item use and switching are
// 'smartest'-only tactics (folding in the old 'defensive' tier's role, same as
// 6.7.2) — every other strategy also degrades straight to chooseNpcMoveId.
// Switching is checked first and, when triggered, wins outright over both move
// and item — fleeing a confirmed bad matchup is a stronger play than healing
// into a matchup that's still bad afterward — but ONLY when no move already
// scores a KO (6.7.1 kill-priority always wins: never flee a Pokémon you can
// just finish off this turn).
export async function chooseNpcAction(
  battle: BattleContext,
  npcId: mongoose.Types.ObjectId | null,
  poke: AttackerInfo,
  movesWithPP: { moveId: string }[],
  strategy: NpcAiStrategy,
): Promise<NpcAction> {
  if (strategy !== 'smartest' || !npcId) {
    return { type: 'move', moveId: await chooseNpcMoveId(battle, poke, movesWithPP, strategy) };
  }

  const { scored, maxHp, myTypes, opponentTypes } = await buildMoveScoredCandidates(battle, poke, movesWithPP, strategy);
  const bestMove = scored.length > 0 ? scored.reduce((best, s) => isBetterForSmartest(s, best) ? s : best) : null;

  if (!bestMove?.isKO) {
    const switchToPokemonId = await evaluateSwitchOption(npcId, poke, myTypes, opponentTypes);
    if (switchToPokemonId) {
      return { type: 'switch', switchToPokemonId };
    }
  }

  let bestItem: { itemId: string; score: number; isKO: boolean } | null = null;
  if (maxHp !== null) {
    const bagItems = await Item.find({ ownerId: npcId, ownerType: 'npc' }, 'itemId quantity pocket').lean();
    const bestAttackScore = scored.reduce((max, s) => Math.max(max, s.score), 0);
    for (const item of bagItems) {
      if (item.quantity < 1) continue;
      const itemScore = scoreItemCandidate(item.itemId, item.pocket, poke.currentHp, maxHp, poke.statusCondition ?? null, bestAttackScore);
      if (itemScore !== null && (!bestItem || itemScore > bestItem.score)) {
        bestItem = { itemId: item.itemId, score: itemScore, isKO: false };
      }
    }
  }

  if (bestItem && (!bestMove || isBetterForSmartest(bestItem, bestMove))) {
    return { type: 'item', itemId: bestItem.itemId, targetPokemonId: poke._id.toString() };
  }
  if (bestMove) {
    return { type: 'move', moveId: bestMove.moveId };
  }
  return { type: 'move', moveId: movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId };
}

// Milestone 6.6 — the targeting-phase counterpart to chooseNpcMoveId: the move is
// already fixed (committed during move_submission), so this scores that ONE move
// against every active player Pokémon and picks per-strategy using the same
// worst/highest-damage/smartest comparators as chooseNpcMoveId (see there for the
// 6.7.1 KO-priority rule), or a uniform-random one for 'random' (no scoring pass
// at all, same as chooseNpcMoveId's random branch). Returns null only if there are
// no active player Pokémon to target at all.
export async function chooseNpcTargetId(
  battle: BattleContext,
  poke: AttackerInfo,
  moveId: string,
  strategy: NpcAiStrategy,
): Promise<string | null> {
  const activePlayerIds = battle.playerSide.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!);
  if (activePlayerIds.length === 0) return null;

  if (strategy === 'random') {
    return activePlayerIds[Math.floor(Math.random() * activePlayerIds.length)].toString();
  }

  const { atkCache, atkAbility } = await gatherAttackerContext(battle, poke);
  const { targetPokes, cacheBySpecies, pokeIdToUserId, targetIvsMap } = await gatherTargetContext(battle);

  const scored: { id: string; score: number; isKO: boolean }[] = [];
  for (const tgt of targetPokes) {
    const tCache = cacheBySpecies.get(tgt.speciesId);
    if (!tCache) continue;
    const tAbility  = getEffectiveAbilitySlugs(battle, tgt._id.toString(), tCache.abilities as CachedAbility[], tgt.hasHiddenAbility ?? false)[0] ?? null;
    const targetIvs = targetIvsMap.get(pokeIdToUserId.get(tgt._id.toString()) ?? '') ?? ZERO_IVS;
    const score = await estimateDamage(poke, atkCache ?? { name: poke.speciesId }, atkAbility, moveId, tgt, tCache, tAbility, battle.weather as string | null, ZERO_IVS, targetIvs);
    scored.push({ id: tgt._id.toString(), score, isKO: score >= tgt.currentHp });
  }

  if (scored.length === 0) {
    return activePlayerIds[Math.floor(Math.random() * activePlayerIds.length)].toString();
  }

  if (strategy === 'worst') {
    return scored.reduce((worst, s) => s.score < worst.score ? s : worst).id;
  }
  if (strategy === 'smartest') {
    return scored.reduce((best, s) => isBetterForSmartest(s, best) ? s : best).id;
  }
  return scored.reduce((best, s) => s.score > best.score ? s : best).id;
}
