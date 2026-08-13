import { Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { Battle, IBattle, StatStages, TurnQueueEntry, PlayerSideEntry, EnemySideEntry } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Npc } from '../models/Npc';
import { Item } from '../models/Item';
import { computeStats, expForLevel, BaseStats, NATURES, ZERO_EVS, ZERO_IVS } from '../lib/statCalc';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field } from '@smogon/calc';
import { BATTLE_ITEM_EFFECTS, BALL_MODIFIERS, statusCatchModifier, rollHeldItem, getPocket, getFlingPower, CHOICE_ITEMS } from '../lib/itemData';
import { applyEvGain } from '../lib/evData';
import { applyLevelUpLoop, getEffectiveLevelCap } from '../lib/levelCap';
import { ivsFromSpread, getIvsForOwner } from '../lib/trainerIv';
import {
  NO_TARGET_MOVE_IDS,
  getMoveTargetCategory,
  StatusMoveEffect,
  STATUS_MOVES,
  MOVE_PRIORITY,
  FLINCH_MOVES,
  SELF_TARGETING_MOVES,
  CHARGE_MOVES,
  CHARGE_MESSAGES,
  SEMI_INVULNERABLE_MOVES,
  STAT_STAGE_MOVES,
  RECOVERY_MOVES,
  CONTACT_MOVES,
  PROTECT_VOLATILE,
  RECOIL_MOVES,
  getHitCount,
  DRAIN_MOVES,
  PRANKSTER_MOVES,
  ESCALATING_POWER_MOVES,
  LOCK_MOVES,
  BINDING_MOVES,
  ROOM_MOVES,
  ROOM_MESSAGES,
  FORCE_SWITCH_STATUS_MOVES,
  FORCE_SWITCH_DAMAGE_MOVES,
  COUNTER_MOVES,
  ALLY_ONLY_MOVES,
  ALLY_OR_FOE_MOVES,
  REDIRECT_MOVES,
  METRONOME_POOL,
  FIXED_DAMAGE_MOVES,
  CUSTOM_FIXED_DAMAGE_MOVES,
  HIGH_CRIT_MOVES,
  ALWAYS_CRIT_MOVES,
  CRIT_STAGE_RATES,
  OHKO_MOVES,
  RECHARGE_MOVES,
  SCREEN_MOVES,
  SCREEN_MESSAGES,
  MIST_MESSAGE,
  SAFEGUARD_MESSAGE,
  ENTRY_HAZARD_MOVES,
  STACKABLE_HAZARDS,
  SPIKES_DAMAGE_FRACTION,
  RAPID_SPIN_HAZARD_CLEAR,
  BOTH_SIDES_HAZARD_CLEAR,
  NO_DAMAGE_TRAP_MOVES,
  PERISH_SONG_TURNS,
  DELAYED_DAMAGE_MOVES,
  DELAYED_DAMAGE_TURNS,
  SELF_KO_MOVES,
  HEALING_WISH_MOVES,
} from '../lib/moveData';
import { PendingAttack, PendingWish, MimicState } from '../models/Battle';
import {
  GEN9,
  type CachedAbility,
  slugToDisplayName,
  pokeDisplayName,
  toCalcWeather,
  toCalcStatus,
  resolveActiveAbilitySlugs,
  getEffectiveAbilitySlugs,
  applyStatStageEffects,
  accuracyStageMultiplier,
  cap,
  toCalcEvs,
  toCalcIvs,
  toCalcItem,
  appendToLog,
  getTypeEffectiveness,
  getEffectiveTypes,
  ALL_TYPES,
} from '../lib/battleCalc';
import {
  StatusCondition,
  STATUS_IMMUNITY_ABILITIES,
  ILATE_MAP,
  PINCH_ABILITIES,
  WEATHER_SPEED_DOUBLERS,
  TRACE_BLOCKED_ABILITIES,
  TYPE_IMMUNITY_ABILITIES,
} from '../lib/abilityData';
import {
  WEATHER_MOVES,
  ENTRY_ABILITY_WEATHER,
  ENTRY_WEATHER_MESSAGES,
} from '../lib/weatherData';
import { fetchSpecies } from '../lib/pokeapi';

async function assertDmOwnsBattle(
  userId: string,
  battle: { campaignId: mongoose.Types.ObjectId },
  res:    Response,
): Promise<boolean> {
  const campaign = await Campaign.findOne({ dmId: userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return false;
  }
  return true;
}

// A player's own battle entry — normally on playerSide, but in a pvp battle the
// opposing trainer's entry lives on enemySide instead. This is the single place
// that resolves "which side, if any, does this user act on" so send-out, move
// submission, and switch resolution don't need to special-case pvp individually.
type OwnSideEntry = {
  activePokemonId:     mongoose.Types.ObjectId | null;
  activeSentOutOnTurn: number | null;
  usedPokemonIds:      mongoose.Types.ObjectId[];
  fainted:             mongoose.Types.ObjectId[];
};
function findOwnSideEntry(
  battle: HydratedDocument<IBattle>,
  userId: string,
): { side: 'playerSide' | 'enemySide'; entry: OwnSideEntry } | null {
  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId);
  if (playerEntry) return { side: 'playerSide', entry: playerEntry };
  const enemyEntry = battle.enemySide.find(e => e.userId?.toString() === userId);
  if (enemyEntry) return { side: 'enemySide', entry: enemyEntry };
  return null;
}

// Which side a given active Pokémon belongs to — works for player, NPC, and wild
// actors alike (unlike findOwnSideEntry, which needs a userId and can't resolve
// NPC/wild actors). Used by side-wide effects (Wide Guard/Quick Guard) that need
// to know which side to protect regardless of who's using the move.
function resolveActingSide(
  battle: HydratedDocument<IBattle>,
  activePokemonId: mongoose.Types.ObjectId,
): 'playerSide' | 'enemySide' | null {
  const idStr = activePokemonId.toString();
  if (battle.playerSide.some(e => e.activePokemonId?.toString() === idStr)) return 'playerSide';
  if (battle.enemySide.some(e => e.activePokemonId?.toString() === idStr)) return 'enemySide';
  return null;
}

// True if a Battle.fieldConditions condition string is one of the four entry hazards
// (milestone 5.14 Wave 7), scoped to the given side. Stackable hazards (spikes,
// toxic-spikes) carry a third colon-separated segment for layer count.
function isHazardCondition(condition: string, side: 'playerSide' | 'enemySide'): boolean {
  const [moveId, condSide] = condition.split(':');
  return condSide === side && ENTRY_HAZARD_MOVES.has(moveId);
}

// Fetches a Pokémon (lean, projected to pokeFields) plus its species cache entry
// (projected to cacheFields) and builds its display name in one call — collapses the
// "fetch doc, fetch its cache, build the name" three-liner repeated throughout the
// move-resolution code below.
async function fetchDisplay(
  id: mongoose.Types.ObjectId | string,
  pokeFields: string,
  cacheFields: string = 'name',
): Promise<{ poke: any; cache: any; name: string }> {
  const poke  = await Pokemon.findById(id, pokeFields).lean();
  const cache = poke ? await PokedexCache.findOne({ pokeApiId: poke.speciesId }, cacheFields).lean() : null;
  return { poke, cache, name: pokeDisplayName(poke, cache) };
}

// Shared tail of every submitMove/dmSubmitMove action branch: queue the action, let
// checkAndAdvance move the battle along, persist, and report back to the caller.
async function queueActionAndRespond(
  battle: HydratedDocument<IBattle>,
  entry: TurnQueueEntry,
  res: Response,
  extra: Record<string, unknown> = {},
): Promise<void> {
  battle.turnQueue.push(entry);
  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();
  res.json({ data: { submitted: true, phase: battle.phase, ...extra }, error: null });
}

// True when switching in `pokemonId` would exceed the side's Pokémon limit for this
// battle — a null limit means unlimited, and a Pokémon already counted as "used" never
// re-consumes a limit slot.
function pokemonLimitReached(
  usedPokemonIds: mongoose.Types.ObjectId[], pokemonId: string, limit: number | null,
): boolean {
  if (limit === null) return false;
  const alreadyUsed = usedPokemonIds.some(id => id.toString() === pokemonId);
  return !alreadyUsed && usedPokemonIds.length >= limit;
}

// Validates a switchToPokemonId is a well-formed id distinct from the currently active
// Pokémon. Shared by submitMove's switch/baton-pass branches and their dmSubmitMove
// counterparts, which diverge only in how they check the target is a legal switch-in.
function parseSwitchToId(
  switchToPokemonId: string | undefined,
  activePokemonId: mongoose.Types.ObjectId | null | undefined,
  res: Response,
  requiredMsg: string,
): mongoose.Types.ObjectId | null {
  if (!switchToPokemonId || !mongoose.Types.ObjectId.isValid(switchToPokemonId)) {
    res.status(400).json({ data: null, error: requiredMsg }); return null;
  }
  if (activePokemonId?.toString() === switchToPokemonId) {
    res.status(400).json({ data: null, error: 'That Pokémon is already active' }); return null;
  }
  return new mongoose.Types.ObjectId(switchToPokemonId);
}

// Player-side switch-in eligibility: owned, in-party, not fainted. Shared by
// submitMove's switch and baton-pass branches.
async function validatePlayerSwitchTarget(
  userId: mongoose.Types.ObjectId, switchToId: mongoose.Types.ObjectId, res: Response,
): Promise<boolean> {
  const switchTarget = await Pokemon.findOne({ _id: switchToId, ownerId: userId, ownerType: 'player', isInParty: true }).lean();
  if (!switchTarget)               { res.status(404).json({ data: null, error: 'Pokémon not found in your party' }); return false; }
  if (switchTarget.currentHp <= 0) { res.status(400).json({ data: null, error: 'That Pokémon has fainted' }); return false; }
  return true;
}

// NPC-side switch-in eligibility: in the NPC's party, not fainted. Shared by
// dmSubmitMove's switch and baton-pass branches.
async function validateNpcSwitchTarget(
  npcId: string, switchToPokemonId: string, res: Response,
): Promise<boolean> {
  const npc = await Npc.findById(npcId, 'party').lean();
  if (!npc || !npc.party.some((id: mongoose.Types.ObjectId) => id.toString() === switchToPokemonId)) {
    res.status(400).json({ data: null, error: "That Pokémon is not in this NPC's party" }); return false;
  }
  const switchTarget = await Pokemon.findById(switchToPokemonId, 'currentHp').lean();
  if (!switchTarget)               { res.status(404).json({ data: null, error: 'Switch target Pokémon not found' }); return false; }
  if (switchTarget.currentHp <= 0) { res.status(400).json({ data: null, error: 'Cannot switch to a fainted Pokémon' }); return false; }
  return true;
}

// Shared tail of sendOut/dmSendOut once the active Pokémon has been assigned: run
// entry abilities/hazards/pending-wish, resolve any resulting faints/battle-end,
// persist, and stamp activeSentOutOnTurn (a direct update since Mongoose subdocument
// tracking doesn't reliably pick this field up).
async function finishSendOut(
  battle: HydratedDocument<IBattle>,
  pokeId: mongoose.Types.ObjectId,
  actorType: 'player' | 'enemy',
  side: 'playerSide' | 'enemySide',
  matchField: 'userId' | 'npcId',
  matchValue: mongoose.Types.ObjectId,
): Promise<void> {
  const entryEvents  = await applyEntryAbilities(battle, pokeId, actorType);
  const hazardEvents = await applyEntryHazards(battle, pokeId, actorType);
  const wishEvents   = await applyPendingWish(battle, pokeId, actorType);
  const faintEvents  = await applyFaints(battle);
  const endEvents    = await checkBattleEnd(battle);
  appendToLog(battle, ...entryEvents, ...hazardEvents, ...wishEvents, ...faintEvents, ...endEvents);
  battle.lastUpdatedAt = new Date();
  await battle.save();
  await Battle.updateOne(
    { _id: battle._id, [`${side}.${matchField}`]: matchValue },
    { $set: { [`${side}.$.activeSentOutOnTurn`]: battle.turnNumber } },
  );
}

export async function createBattle(req: Request, res: Response): Promise<void> {
  const {
    type, playerIds, npcIds = [], enemyPlayerIds = [], playerPokemonLimit = null, npcPokemonLimit = null,
    wildPokemon, wildCatchable = true, moneyReward = 0,
  } = req.body as {
    type: string;
    playerIds: string[];
    npcIds?: string[];
    enemyPlayerIds?: string[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    wildPokemon?: { speciesId: number; level: number };
    wildCatchable?: boolean;
    moneyReward?: number;
  };

  if (!['pve', 'wild', 'pvp'].includes(type)) {
    res.status(400).json({ data: null, error: "type must be 'pve', 'wild', or 'pvp'" });
    return;
  }
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    res.status(400).json({ data: null, error: 'playerIds must be a non-empty array' });
    return;
  }
  if (!Array.isArray(npcIds)) {
    res.status(400).json({ data: null, error: 'npcIds must be an array' });
    return;
  }
  if (!npcIds.every(id => mongoose.Types.ObjectId.isValid(id))) {
    res.status(400).json({ data: null, error: 'All npcIds must be valid' });
    return;
  }
  if (
    playerPokemonLimit !== null &&
    (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'playerPokemonLimit must be a positive integer or null' });
    return;
  }
  if (!Number.isInteger(moneyReward) || moneyReward < 0) {
    res.status(400).json({ data: null, error: 'moneyReward must be a non-negative integer' });
    return;
  }
  if (moneyReward > 0 && type !== 'pve') {
    res.status(400).json({ data: null, error: 'moneyReward is only supported for pve battles' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const campaignPlayerStrings = campaign.playerIds.map(id => id.toString());
  const invalidIds = playerIds.filter(id => !campaignPlayerStrings.includes(id));
  if (invalidIds.length > 0) {
    res.status(400).json({
      data:  null,
      error: `These player IDs are not in your campaign: ${invalidIds.join(', ')}`,
    });
    return;
  }

  if (type === 'pvp') {
    if (!Array.isArray(enemyPlayerIds) || enemyPlayerIds.length === 0) {
      res.status(400).json({ data: null, error: 'enemyPlayerIds must be a non-empty array for pvp battles' });
      return;
    }
    const invalidEnemyIds = enemyPlayerIds.filter(id => !campaignPlayerStrings.includes(id));
    if (invalidEnemyIds.length > 0) {
      res.status(400).json({
        data:  null,
        error: `These enemy player IDs are not in your campaign: ${invalidEnemyIds.join(', ')}`,
      });
      return;
    }
    const overlap = playerIds.filter(id => enemyPlayerIds.includes(id));
    if (overlap.length > 0) {
      res.status(400).json({
        data:  null,
        error: `A player cannot be on both sides of a pvp battle: ${overlap.join(', ')}`,
      });
      return;
    }
  }

  if (type !== 'pvp' && npcIds.length > 0) {
    const foundNpcs = await Npc.find({ _id: { $in: npcIds }, campaignId: campaign._id }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(400).json({ data: null, error: 'One or more NPCs were not found in your campaign' });
      return;
    }
  }

  type EnemySlot = {
    npcId?: mongoose.Types.ObjectId;
    userId?: mongoose.Types.ObjectId;
    activePokemonId: mongoose.Types.ObjectId | null;
    usedPokemonIds?: mongoose.Types.ObjectId[];
    fainted: mongoose.Types.ObjectId[];
  };
  let enemySide: EnemySlot[];

  if (type === 'wild') {
    if (!wildPokemon?.speciesId || !wildPokemon?.level) {
      res.status(400).json({ data: null, error: 'wildPokemon { speciesId, level } is required for wild battles' });
      return;
    }
    const level = Number(wildPokemon.level);
    if (!Number.isInteger(level) || level < 1 || level > 100) {
      res.status(400).json({ data: null, error: 'level must be an integer between 1 and 100' });
      return;
    }

    let species = await PokedexCache.findOne({ pokeApiId: wildPokemon.speciesId }).lean();
    if (!species) {
      try {
        const fetched = await fetchSpecies(wildPokemon.speciesId);
        const created = await PokedexCache.create(fetched);
        species = created.toObject();
      } catch {
        res.status(400).json({ data: null, error: `Species #${wildPokemon.speciesId} not found` });
        return;
      }
    }

    const nature = NATURES[Math.floor(Math.random() * NATURES.length)];
    const genderRatio = (species.genderRatio as number) ?? -1;
    let gender: 'male' | 'female' | 'none';
    if (genderRatio === -1) {
      gender = 'none';
    } else {
      gender = Math.random() < genderRatio / 8 ? 'female' : 'male';
    }

    const learnable = ((species.levelUpMoves ?? []) as Array<{ moveId: string; level: number }>)
      .filter(m => m.level <= level).slice(-4);
    const moveList = ((species.moves ?? []) as Array<{ name: string; pp: number | null }>);
    const moves = learnable.map(m => {
      const md = moveList.find(mv => mv.name === m.moveId);
      const pp = md?.pp ?? 5;
      return { moveId: m.moveId, currentPP: pp, maxPP: pp, ppUps: 0 };
    });

    const stats = computeStats(species.baseStats as BaseStats, level, nature, ZERO_EVS, ZERO_IVS);
    const wildPoke = await Pokemon.create({
      speciesId: species.pokeApiId, ownerId: new mongoose.Types.ObjectId(req.user!.userId),
      ownerType: 'wild', nickname: null, level,
      exp: expForLevel(level, (species.expGroup as string) || 'medium-fast'),
      currentHp: stats.hp, nature, gender, heldItem: rollHeldItem(true), moves,
      evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      statusCondition: null, statusCounter: null, volatileStatus: [],
      evolutionOverrides: [], isInParty: false, partySlot: null,
      caughtAt: null, caughtByPlayerId: null,
    });
    enemySide = [{ activePokemonId: wildPoke._id as mongoose.Types.ObjectId, fainted: [] }];
  } else if (type === 'pvp') {
    enemySide = enemyPlayerIds.map((id: string) => ({
      userId: new mongoose.Types.ObjectId(id), activePokemonId: null, usedPokemonIds: [], fainted: [],
    }));
  } else {
    enemySide = npcIds.map(id => ({
      npcId: new mongoose.Types.ObjectId(id), activePokemonId: null, fainted: [],
    }));
  }

  const battle = await Battle.create({
    campaignId: campaign._id, type, status: 'waiting', phase: 'move_submission',
    playerSide: playerIds.map(id => ({
      userId: new mongoose.Types.ObjectId(id), activePokemonId: null, usedPokemonIds: [], fainted: [],
    })),
    enemySide, wildCatchable: type === 'wild' ? wildCatchable : true,
    playerPokemonLimit: playerPokemonLimit ?? null, npcPokemonLimit: npcPokemonLimit ?? null,
    moneyReward: type === 'pve' ? moneyReward : 0,
    hiddenAbilitiesEnabled: campaign.hiddenAbilitiesEnabled ?? true,
    lastUpdatedAt: new Date(),
  });

  res.status(201).json({ data: { _id: battle._id, status: battle.status, type: battle.type }, error: null });
}

export async function startBattle(req: Request, res: Response): Promise<void> {
  const battle = await Battle.findById(req.params.id);
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'waiting') { res.status(400).json({ data: null, error: 'Battle has already started' }); return; }
  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;
  battle.status = 'active'; battle.turnNumber = 1; battle.phase = 'move_submission';
  battle.lastUpdatedAt = new Date();
  await battle.save();
  // Stamp all enemy slots that already have an active Pokémon with turn 1.
  // Direct update bypasses Mongoose subdocument change tracking issues.
  const activeEnemyIds = battle.enemySide.map(s => s.activePokemonId).filter(Boolean);
  if (activeEnemyIds.length > 0) {
    await Battle.updateOne(
      { _id: battle._id },
      { $set: { 'enemySide.$[elem].activeSentOutOnTurn': 1 } },
      { arrayFilters: [{ 'elem.activePokemonId': { $in: activeEnemyIds } }] },
    );
  }
  res.json({ data: { status: battle.status, phase: battle.phase }, error: null });
}

export async function advanceRound(req: Request, res: Response): Promise<void> {
  const battle = await Battle.findById(req.params.id);
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active') { res.status(400).json({ data: null, error: 'Battle is not active' }); return; }
  if (battle.phase !== 'end_of_round') { res.status(400).json({ data: null, error: 'Battle is not at end of round' }); return; }
  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;
  battle.set('turnQueue', []); battle.currentTargetIndex = 0;
  battle.turnNumber += 1; battle.phase = 'move_submission'; battle.lastUpdatedAt = new Date();
  await battle.save();
  res.json({ data: { turnNumber: battle.turnNumber, phase: battle.phase }, error: null });
}

export async function setWeather(req: Request, res: Response): Promise<void> {
  const battle = await Battle.findById(req.params.id);
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active') { res.status(400).json({ data: null, error: 'Battle is not active' }); return; }
  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;

  const { weather, turnsRemaining = null } = req.body as { weather: IBattle['weather']; turnsRemaining?: number | null };
  const validWeathers: Array<IBattle['weather']> = ['rain', 'sun', 'sandstorm', 'hail', 'snow', null];
  if (!validWeathers.includes(weather)) { res.status(400).json({ data: null, error: 'Invalid weather value' }); return; }

  const WEATHER_DISPLAY: Record<string, string> = {
    rain: 'heavy rain', sun: 'harsh sunlight', sandstorm: 'a sandstorm', hail: 'hail', snow: 'snow',
  };
  battle.weather = weather; battle.weatherTurnsRemaining = weather ? turnsRemaining : null;
  appendToLog(battle, weather ? `The DM set the weather to ${WEATHER_DISPLAY[weather]}!` : 'The weather was cleared by the DM.');
  battle.lastUpdatedAt = new Date(); await battle.save();
  res.json({ data: { weather: battle.weather, weatherTurnsRemaining: battle.weatherTurnsRemaining }, error: null });
}

export async function deleteBattle(req: Request, res: Response): Promise<void> {
  const battle = await Battle.findById(req.params.id);
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;
  await Battle.findByIdAndDelete(req.params.id);
  res.json({ data: { deleted: true }, error: null });
}

async function checkStatusBlock(
  pokemonId: mongoose.Types.ObjectId, statusCondition: string | null,
  statusCounter: number | null, displayName: string,
): Promise<{ blocked: boolean; events: string[] }> {
  if (statusCondition === 'paralysis') {
    if (Math.random() >= 0.25) return { blocked: false, events: [] };
    return { blocked: true, events: [`${displayName} is fully paralyzed! It can't move!`] };
  }
  if (statusCondition === 'freeze') {
    if (Math.random() < 0.2) {
      await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCondition: null, statusCounter: null } });
      return { blocked: false, events: [`${displayName} thawed out!`] };
    }
    return { blocked: true, events: [`${displayName} is frozen solid!`] };
  }
  if (statusCondition === 'sleep') {
    const counter = statusCounter !== null && statusCounter > 0 ? statusCounter : Math.floor(Math.random() * 3) + 1;
    const newCounter = counter - 1;
    if (newCounter <= 0) {
      await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCondition: null, statusCounter: null } });
      return { blocked: false, events: [`${displayName} woke up!`] };
    }
    await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCounter: newCounter } });
    return { blocked: true, events: [`${displayName} is fast asleep! Zzzz...`] };
  }
  return { blocked: false, events: [] };
}

async function resolveItemAction(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;
  if (!itemId || targets.length === 0) return events;
  const effect = BATTLE_ITEM_EFFECTS[itemId];
  if (!effect) return events;
  const targetId = targets[0];
  const pokemon = await Pokemon.findById(targetId, 'ownerId ownerType nickname speciesId level nature currentHp statusCondition evs hasHiddenAbility volatileStatus').lean();
  if (!pokemon) return events;
  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }, 'name baseStats abilities').lean();
  const displayName = pokeDisplayName(pokemon, cache);
  const ivs = await getIvsForOwner(pokemon.ownerId, pokemon.ownerType);
  const maxHp = cache ? computeStats(cache.baseStats as BaseStats, pokemon.level, pokemon.nature, pokemon.evs as BaseStats, ivs).hp : pokemon.currentHp;
  const user = await User.findById(actorId, 'username').lean();
  const userName = user?.username ?? 'Trainer';
  const itemName = slugToDisplayName(itemId);
  let wasUsed = false;

  if (effect.kind === 'hp_flat') {
    if (pokemon.currentHp <= 0) {
      events.push(`${userName} tried to use ${itemName} on ${displayName}, but it had fainted!`);
    } else if (pokemon.currentHp >= maxHp) {
      events.push(`${userName} used ${itemName} on ${displayName}, but its HP was already full!`);
    } else {
      const restored = Math.min(effect.amount, maxHp - pokemon.currentHp);
      await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: pokemon.currentHp + restored } });
      events.push(`${userName} used ${itemName} on ${displayName}! Restored ${restored} HP.`);
      wasUsed = true;
    }
  } else if (effect.kind === 'hp_full') {
    if (pokemon.currentHp <= 0) {
      events.push(`${userName} tried to use ${itemName} on ${displayName}, but it had fainted!`);
    } else if (pokemon.currentHp >= maxHp) {
      events.push(`${userName} used ${itemName} on ${displayName}, but its HP was already full!`);
    } else {
      await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: maxHp } });
      events.push(`${userName} used ${itemName} on ${displayName}! HP fully restored.`);
      wasUsed = true;
    }
  } else if (effect.kind === 'hp_full_cure') {
    if (pokemon.currentHp <= 0) {
      events.push(`${userName} tried to use ${itemName} on ${displayName}, but it had fainted!`);
    } else {
      const updates: Partial<{ currentHp: number; statusCondition: null; statusCounter: null }> = {};
      const parts: string[] = [];
      if (pokemon.currentHp < maxHp) { updates.currentHp = maxHp; parts.push('HP fully restored'); }
      if (pokemon.statusCondition) { updates.statusCondition = null; updates.statusCounter = null; parts.push('status cleared'); }
      if (parts.length === 0) {
        events.push(`${userName} used ${itemName} on ${displayName}, but there was nothing to restore!`);
      } else {
        await Pokemon.updateOne({ _id: targetId }, { $set: updates });
        events.push(`${userName} used ${itemName} on ${displayName}! ${parts.join(', ')}.`);
        wasUsed = true;
      }
    }
  } else if (effect.kind === 'revive') {
    if (pokemon.currentHp > 0) {
      events.push(`${userName} tried to use ${itemName} on ${displayName}, but it hadn't fainted!`);
    } else {
      const restoreHp = effect.amount === 'full' ? maxHp : Math.floor(maxHp / 2);
      await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: restoreHp, statusCondition: null, statusCounter: null } });
      events.push(`${userName} used ${itemName}! ${displayName} was revived with ${restoreHp} HP.`);
      wasUsed = true;
    }
  } else if (effect.kind === 'status_cure') {
    if (!pokemon.statusCondition) {
      events.push(`${userName} used ${itemName} on ${displayName}, but it had no status condition!`);
    } else {
      const cures = effect.cures;
      const canCure = cures === 'all' || (cures as string[]).includes(pokemon.statusCondition);
      if (!canCure) {
        events.push(`${userName} used ${itemName} on ${displayName}, but it had no effect!`);
      } else {
        await Pokemon.updateOne({ _id: targetId }, { $set: { statusCondition: null, statusCounter: null } });
        events.push(`${userName} used ${itemName} on ${displayName}! ${pokemon.statusCondition} was cured.`);
        wasUsed = true;
      }
    }

  } else if (effect.kind === 'stat_stage') {
    // X items (milestone 5.17d) — always consumed on use, even at +6, matching
    // the real games (unlike status_cure above, which project convention
    // deliberately doesn't consume on a genuine no-op — X items are a real,
    // narrower exception to that, and always-consume also sidesteps the
    // Contrary-inverts-the-cap-direction edge case a "check the cap first"
    // guard would otherwise need to handle).
    const abilitySlugs = cache
      ? getEffectiveAbilitySlugs(battle, targetId.toString(), (cache.abilities as CachedAbility[]) ?? [], pokemon.hasHiddenAbility as boolean)
      : [];
    const stageMap = battle.statStages as Record<string, StatStages>;
    const statEvents = applyStatStageEffects(stageMap, targetId.toString(), [{ stat: effect.stat, stages: effect.stages, target: 'self' }], displayName, abilitySlugs);
    battle.markModified('statStages');
    events.push(`${userName} used ${itemName} on ${displayName}!`, ...statEvents);
    wasUsed = true;

  } else if (effect.kind === 'crit_boost') {
    // Dire Hit — identical effect to the move Focus Energy (same volatile,
    // same +2 crit-stage contribution already read by resolveMove).
    const volStatus = (pokemon.volatileStatus as Array<{ condition: string }>) ?? [];
    if (volStatus.some(v => v.condition === 'focus-energy')) {
      events.push(`${userName} used ${itemName} on ${displayName}, but ${displayName} is already focusing!`);
    } else {
      await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: 'focus-energy', turnsRemaining: 99 } } });
      events.push(`${userName} used ${itemName} on ${displayName}! ${displayName} is getting pumped!`);
      wasUsed = true;
    }

  } else if (effect.kind === 'guard_spec') {
    // Guard Spec — identical effect to the move Mist, applied to the WHOLE
    // side (not just the recipient), same fieldConditions entry and 5-turn
    // duration Mist already uses.
    const side = resolveActingSide(battle, entry.activePokemonId);
    if (!side) {
      events.push(`${userName} used ${itemName}, but it had no effect!`);
    } else {
      const condition = `mist:${side}`;
      const already = (battle.fieldConditions ?? []).some(f => f.condition === condition);
      if (already) {
        events.push(`${userName} used ${itemName}, but ${side === 'playerSide' ? 'your' : "the opposing"} side is already protected!`);
      } else {
        battle.fieldConditions.push({ condition, turnsRemaining: 5 });
        battle.markModified('fieldConditions');
        events.push(`${userName} used ${itemName}! ${userName}'s team ${MIST_MESSAGE}`);
        wasUsed = true;
      }
    }
  }

  if (wasUsed) {
    const item = await Item.findOne({ ownerId: actorId, itemId });
    if (item) {
      if (item.quantity <= 1) { await Item.deleteOne({ _id: item._id }); }
      else { await Item.updateOne({ _id: item._id }, { $inc: { quantity: -1 } }); }
    }
  }
  return events;
}

export async function applyEntryAbilities(
  battle: HydratedDocument<IBattle>, incomingId: mongoose.Types.ObjectId, incomingSide: 'player' | 'enemy',
): Promise<string[]> {
  const poke = await Pokemon.findById(incomingId, 'speciesId nickname hasHiddenAbility').lean();
  if (!poke) return [];
  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name abilities').lean();
  if (!cache) return [];
  const abilities = (cache.abilities as CachedAbility[]) ?? [];
  const abilitySlugs = resolveActiveAbilitySlugs(abilities, poke.hasHiddenAbility as boolean, battle.hiddenAbilitiesEnabled);
  if (abilitySlugs.length === 0) return [];
  const pokeName = pokeDisplayName(poke, cache);
  const events: string[] = [];

  // Every active ability's entry trigger fires independently — EXCEPT weather-setting,
  // where the field itself can't be two things at once. If a Pokémon somehow has two
  // weather-setters active, the first one (by array order) wins; that's a narrow, honest
  // limitation, not a general "only one ability matters" rule.
  const weatherSlug = abilitySlugs.find(s => ENTRY_ABILITY_WEATHER[s]);
  if (weatherSlug) {
    const entryWeather = ENTRY_ABILITY_WEATHER[weatherSlug];
    const abilityName = slugToDisplayName(weatherSlug);
    if (entryWeather && battle.weather !== entryWeather) {
      if (battle.weather) {
        battle.weather = null; battle.weatherTurnsRemaining = null;
        events.push(`${pokeName}'s ${abilityName}! The weather cleared!`);
      } else {
        battle.weather = entryWeather; battle.weatherTurnsRemaining = null;
        events.push(`${pokeName}'s ${abilityName}! ${ENTRY_WEATHER_MESSAGES[entryWeather]}`);
      }
    }
  }

  if (abilitySlugs.includes('intimidate')) {
    const stageMap = battle.statStages as Record<string, StatStages>;
    const opposingSide = incomingSide === 'player' ? battle.enemySide : battle.playerSide;
    if (opposingSide.some(e => e.activePokemonId)) {
      events.push(`${pokeName}'s Intimidate!`);
      for (const entry of opposingSide) {
        if (!entry.activePokemonId) continue;
        const targetId = entry.activePokemonId.toString();
        const { poke: target, cache: tgtCache, name: targetName } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId hasHiddenAbility', 'name abilities');
        const tgtAbilities = target && tgtCache ? getEffectiveAbilitySlugs(battle, targetId, (tgtCache.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean) : [];
        events.push(...applyStatStageEffects(stageMap, targetId, [{ stat: 'atk', stages: -1, target: 'foe' }], targetName, tgtAbilities));
        for (const reaction of ['competitive', 'defiant'] as const) {
          if (!tgtAbilities.includes(reaction)) continue;
          const reactionStat: keyof StatStages = reaction === 'competitive' ? 'spa' : 'atk';
          events.push(`${targetName}'s ${slugToDisplayName(reaction)}!`);
          events.push(...applyStatStageEffects(stageMap, targetId, [{ stat: reactionStat, stages: 2, target: 'self' }], targetName));
        }
      }
      battle.markModified('statStages');
    }
  }

  if (abilitySlugs.includes('trace')) {
    const opposingSide = incomingSide === 'player' ? battle.enemySide : battle.playerSide;
    const candidates: { id: string; name: string; slug: string }[] = [];
    for (const entry of opposingSide) {
      if (!entry.activePokemonId) continue;
      const { poke: tgt, cache: tgtCache } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId hasHiddenAbility', 'name abilities');
      if (!tgt || !tgtCache) continue;
      const tgtSlugs = getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean)
        .filter(s => !TRACE_BLOCKED_ABILITIES.has(s));
      for (const tgtSlug of tgtSlugs) {
        candidates.push({ id: entry.activePokemonId.toString(), name: pokeDisplayName(tgt, tgtCache), slug: tgtSlug });
      }
    }
    if (candidates.length > 0) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      const tracedMap = (battle.tracedAbility ?? {}) as Record<string, string>;
      tracedMap[incomingId.toString()] = picked.slug;
      battle.tracedAbility = tracedMap;
      battle.markModified('tracedAbility');
      events.push(`${pokeName} traced ${picked.name}'s ${slugToDisplayName(picked.slug)}!`);
    }
  }
  return events;
}

// Entry hazards (milestone 5.14 Wave 7) — checked on every send-out/switch-in against
// the INCOMING Pokémon's own side (the side hazards were set against). Order matches
// the real games: Stealth Rock, then Spikes, then Toxic Spikes, then Sticky Web.
export async function applyEntryHazards(
  battle: HydratedDocument<IBattle>, incomingId: mongoose.Types.ObjectId, incomingSide: 'player' | 'enemy',
): Promise<string[]> {
  const sideKey: 'playerSide' | 'enemySide' = incomingSide === 'player' ? 'playerSide' : 'enemySide';
  const fieldConds = (battle.fieldConditions ?? []) as Array<{ condition: string; turnsRemaining: number }>;
  const relevant = fieldConds.filter(f => isHazardCondition(f.condition, sideKey));
  if (relevant.length === 0) return [];

  const poke = await Pokemon.findById(incomingId, 'nickname speciesId level nature evs hasHiddenAbility currentHp ownerId ownerType statusCondition').lean();
  if (!poke || poke.currentHp <= 0) return [];
  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name types baseStats abilities').lean();
  if (!cache) return [];
  const pokeName = pokeDisplayName(poke, cache);
  const types = (cache.types as string[]) ?? [];
  const abilitySlugs = getEffectiveAbilitySlugs(battle, incomingId.toString(), (cache.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
  const isGrounded = !types.includes('flying') && !abilitySlugs.includes('levitate');
  const events: string[] = [];
  let currentHp = poke.currentHp;

  const stealthRock = relevant.find(f => f.condition.startsWith('stealth-rock:'));
  if (stealthRock && cache.baseStats) {
    const ivs   = await getIvsForOwner(poke.ownerId, poke.ownerType);
    const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, ivs).hp;
    const effectiveness = getTypeEffectiveness('rock', types);
    const damage = Math.max(1, Math.floor(maxHp * 0.125 * effectiveness));
    currentHp = Math.max(0, currentHp - damage);
    await Pokemon.updateOne({ _id: incomingId }, { $set: { currentHp } });
    events.push(`Pointed stones dug into ${pokeName}!`);
  }

  const spikes = relevant.find(f => f.condition.startsWith('spikes:'));
  if (spikes && isGrounded && currentHp > 0 && cache.baseStats) {
    const layers = Number(spikes.condition.split(':')[2]) || 1;
    const ivs    = await getIvsForOwner(poke.ownerId, poke.ownerType);
    const maxHp  = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, ivs).hp;
    const damage = Math.max(1, Math.floor(maxHp * SPIKES_DAMAGE_FRACTION[layers]));
    currentHp = Math.max(0, currentHp - damage);
    await Pokemon.updateOne({ _id: incomingId }, { $set: { currentHp } });
    events.push(`${pokeName} was hurt by the spikes!`);
  }

  const toxicSpikes = relevant.find(f => f.condition.startsWith('toxic-spikes:'));
  if (toxicSpikes && currentHp > 0) {
    if (types.includes('poison')) {
      // Absorbed on contact — cleared for the whole side, not just this Pokémon.
      battle.fieldConditions = (battle.fieldConditions ?? []).filter(f => f !== toxicSpikes);
      battle.markModified('fieldConditions');
      events.push(`${pokeName} absorbed the toxic spikes!`);
    } else if (isGrounded && !poke.statusCondition) {
      const layers = Number(toxicSpikes.condition.split(':')[2]) || 1;
      events.push(...await applyStatusEffect(battle, incomingId, { status: layers >= 2 ? 'toxic' : 'poison', chance: 1 }));
    }
  }

  const stickyWeb = relevant.find(f => f.condition.startsWith('sticky-web:'));
  if (stickyWeb && isGrounded && currentHp > 0) {
    const stageMap = battle.statStages as Record<string, StatStages>;
    events.push(`${pokeName} was caught in a sticky web!`);
    events.push(...applyStatStageEffects(stageMap, incomingId.toString(), [{ stat: 'spe', stages: -1, target: 'foe' }], pokeName, abilitySlugs));
    battle.markModified('statStages');
  }

  return events;
}

// Healing Wish / Lunar Dance (milestone 5.14 Wave 10) — checked at the same send-out/
// switch-in call sites as applyEntryHazards. Consumes (and removes) the wish the
// instant a Pokémon lands in the matching slot, regardless of who it is.
export async function applyPendingWish(
  battle: HydratedDocument<IBattle>, incomingId: mongoose.Types.ObjectId, incomingSide: 'player' | 'enemy',
): Promise<string[]> {
  const sideKey: 'playerSide' | 'enemySide' = incomingSide === 'player' ? 'playerSide' : 'enemySide';
  const slotIndex = battle[sideKey].findIndex(e => e.activePokemonId?.toString() === incomingId.toString());
  if (slotIndex === -1) return [];
  const wishIdx = (battle.pendingWishes ?? []).findIndex(w => w.targetSide === sideKey && w.targetSlotIndex === slotIndex);
  if (wishIdx === -1) return [];
  const wish = battle.pendingWishes[wishIdx];
  battle.pendingWishes = battle.pendingWishes.filter((_, i) => i !== wishIdx);
  battle.markModified('pendingWishes');

  const poke = await Pokemon.findById(incomingId, 'nickname speciesId level nature evs hasHiddenAbility currentHp moves ownerId ownerType').lean();
  if (!poke || poke.currentHp <= 0) return [];
  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name baseStats').lean();
  if (!cache?.baseStats) return [];
  const pokeName = pokeDisplayName(poke, cache);
  const ivs   = await getIvsForOwner(poke.ownerId, poke.ownerType);
  const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, ivs).hp;

  const update: Record<string, unknown> = { currentHp: maxHp, statusCondition: null, statusCounter: null };
  if (wish.restorePP) {
    const moves = ((poke.moves as Array<{ moveId: string; maxPP: number }>) ?? []).map(m => ({ ...m, currentPP: m.maxPP }));
    update.moves = moves;
  }
  await Pokemon.updateOne({ _id: incomingId }, { $set: update });
  return [wish.restorePP
    ? `${pokeName} was fully healed by the lunar dance!`
    : `${pokeName} was fully healed by the healing wish!`];
}

async function applySwitchOutAbilities(
  battle: HydratedDocument<IBattle>, pokemonId: string, outgoing: Record<string, unknown> | null, outCache: Record<string, unknown> | null, outName: string,
): Promise<string[]> {
  if (!outgoing || !outCache) return [];
  const abilitySlugs = getEffectiveAbilitySlugs(battle, pokemonId, (outCache.abilities as CachedAbility[]) ?? [], (outgoing.hasHiddenAbility as boolean) ?? false);
  if (abilitySlugs.length === 0) return [];
  const events: string[] = [];
  if (abilitySlugs.includes('natural-cure') && outgoing.statusCondition) {
    await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCondition: null, statusCounter: null } });
    events.push(`${outName}'s Natural Cure! ${outName}'s status was cured!`);
  }
  if (abilitySlugs.includes('regenerator')) {
    const ivs = await getIvsForOwner(outgoing.ownerId as mongoose.Types.ObjectId, outgoing.ownerType as string);
    const maxHp = computeStats(outCache.baseStats as BaseStats, outgoing.level as number, outgoing.nature as string, outgoing.evs as BaseStats, ivs).hp;
    const currentHp = outgoing.currentHp as number;
    if (currentHp < maxHp) {
      const healAmt = Math.max(1, Math.floor(maxHp / 3));
      const newHp = Math.min(maxHp, currentHp + healAmt);
      await Pokemon.updateOne({ _id: pokemonId }, { $set: { currentHp: newHp } });
      events.push(`${outName}'s Regenerator! ${outName} restored ${newHp - currentHp} HP!`);
    }
  }
  return events;
}

// Two kinds of volatile encode a source Pokémon in their condition string —
// binding moves ("bound:<moveId>:<sourcePokemonId>") and Attract ("infatuated:
// <sourcePokemonId>"). Both end immediately when that source Pokémon leaves the
// field (faints or switches out), regardless of how many turns were left. Scans
// every OTHER currently-active Pokémon on either side (not sourceId's own side
// specifically — both effects are always on an opponent, but this is cheap
// enough to just check both).
async function releaseBoundTargets(battle: HydratedDocument<IBattle>, sourceId: mongoose.Types.ObjectId): Promise<string[]> {
  const activeIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((id): id is mongoose.Types.ObjectId => id != null && id.toString() !== sourceId.toString());
  if (activeIds.length === 0) return [];

  const boundPattern      = new RegExp(`^bound:[^:]+:${sourceId.toString()}$`);
  const infatuatedPattern = new RegExp(`^infatuated:${sourceId.toString()}$`);
  const affected = await Pokemon.find(
    { _id: { $in: activeIds }, $or: [{ 'volatileStatus.condition': boundPattern }, { 'volatileStatus.condition': infatuatedPattern }] },
    'nickname speciesId volatileStatus',
  ).lean();

  const events: string[] = [];
  for (const poke of affected) {
    const vol = (poke.volatileStatus as Array<{ condition: string }>) ?? [];
    const boundEntry      = vol.find(v => boundPattern.test(v.condition));
    const infatuatedEntry = vol.find(v => infatuatedPattern.test(v.condition));
    if (!boundEntry && !infatuatedEntry) continue;
    const toClear = [boundEntry?.condition, infatuatedEntry?.condition].filter((c): c is string => !!c);
    await Pokemon.updateOne({ _id: poke._id }, { $pull: { volatileStatus: { condition: { $in: toClear } } } });
    const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
    if (boundEntry) events.push(`${pokeDisplayName(poke, cache)} was freed from the bind!`);
    if (infatuatedEntry) events.push(`${pokeDisplayName(poke, cache)} got over its infatuation!`);
  }
  return events;
}

// Reverts a Mimic-copied move back to the original Mimic slot (milestone 5.14 Wave 13)
// — called from every switch-out/faint cleanup site, same lifetime as tracedAbility/
// typeOverride. A no-op if this Pokémon has no active mimicState entry.
async function revertMimic(battle: HydratedDocument<IBattle>, pokemonId: mongoose.Types.ObjectId): Promise<void> {
  const mimicMap = battle.mimicState as Record<string, MimicState>;
  const idStr = pokemonId.toString();
  const state = mimicMap[idStr];
  if (!state) return;
  const poke = await Pokemon.findById(pokemonId, 'moves').lean();
  const moves = (poke?.moves ?? []) as Array<{ moveId: string; currentPP: number; maxPP: number; ppUps: number }>;
  if (moves[state.slotIndex]) {
    const newMoves = moves.map((m, i) => i === state.slotIndex
      ? { moveId: state.originalMoveId, currentPP: state.originalCurrentPP, maxPP: state.originalMaxPP, ppUps: state.originalPpUps }
      : m);
    await Pokemon.updateOne({ _id: pokemonId }, { moves: newMoves });
  }
  delete mimicMap[idStr];
  battle.markModified('mimicState');
}

async function recallPokemon(battle: HydratedDocument<IBattle>, outgoingId: mongoose.Types.ObjectId): Promise<string[]> {
  await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  delete (battle.statStages as Record<string, StatStages>)[outgoingId.toString()];
  battle.markModified('statStages');
  delete (battle.consecutiveMoves as Record<string, unknown>)[outgoingId.toString()];
  battle.markModified('consecutiveMoves');
  delete (battle.lockedMoves as Record<string, unknown>)[outgoingId.toString()];
  battle.markModified('lockedMoves');
  const { poke: outgoing, cache: outCache, name: outName } = await fetchDisplay(outgoingId, 'ownerId ownerType nickname speciesId hasHiddenAbility statusCondition currentHp nature level evs', 'name abilities baseStats');
  const events = [`${outName} was recalled!`];
  events.push(...await releaseBoundTargets(battle, outgoingId));
  events.push(...await applySwitchOutAbilities(battle, outgoingId.toString(), outgoing, outCache, outName));
  delete (battle.tracedAbility as Record<string, string>)[outgoingId.toString()];
  battle.markModified('tracedAbility');
  delete (battle.typeOverride as Record<string, string[]>)[outgoingId.toString()];
  battle.markModified('typeOverride');
  delete (battle.lastHitMoveType as Record<string, string>)[outgoingId.toString()];
  battle.markModified('lastHitMoveType');
  await revertMimic(battle, outgoingId);
  return events;
}

// Roar/Whirlwind/Dragon Tail/Circle Throw — forces targetId to switch to a random
// OTHER non-fainted party member, with no player input (matches the real games,
// where the incoming Pokémon is randomly chosen, not picked by the defending
// trainer). Standalone wild targets have no roster to draw from and always fail;
// player/pvp entries respect Battle.playerPokemonLimit exactly like a voluntary
// switch would (a not-yet-used replacement only counts as a valid candidate if the
// limit isn't already reached); true NPC trainers have no such limit.
async function forceOpponentSwitch(
  battle: HydratedDocument<IBattle>, targetId: string, moveEvents: string[],
): Promise<void> {
  const playerEntry = battle.playerSide.find(e => e.activePokemonId?.toString() === targetId);
  const enemyEntry  = !playerEntry ? battle.enemySide.find(e => e.activePokemonId?.toString() === targetId) : undefined;
  if (!playerEntry && !enemyEntry) return;

  const { name: outgoingName } = await fetchDisplay(targetId, 'nickname speciesId', 'name');

  let candidates: mongoose.Types.ObjectId[] = [];
  let usedPokemonIds: mongoose.Types.ObjectId[] | null = null; // non-null => pokemon-limit tracking applies

  if (playerEntry) {
    const party = await Pokemon.find(
      { ownerId: playerEntry.userId, ownerType: 'player', isInParty: true, currentHp: { $gt: 0 } }, '_id',
    ).lean();
    candidates = party.map(p => p._id).filter(id => id.toString() !== targetId);
    usedPokemonIds = playerEntry.usedPokemonIds;
  } else if (enemyEntry?.userId) {
    // pvp opponent — real trainer, same rules as playerSide
    const party = await Pokemon.find(
      { ownerId: enemyEntry.userId, ownerType: 'player', isInParty: true, currentHp: { $gt: 0 } }, '_id',
    ).lean();
    candidates = party.map(p => p._id).filter(id => id.toString() !== targetId);
    usedPokemonIds = enemyEntry.usedPokemonIds;
  } else if (enemyEntry?.npcId) {
    const npc = await Npc.findById(enemyEntry.npcId, 'party').lean();
    const partyIds = (npc?.party ?? []) as mongoose.Types.ObjectId[];
    const party = partyIds.length > 0
      ? await Pokemon.find({ _id: { $in: partyIds }, currentHp: { $gt: 0 } }, '_id').lean()
      : [];
    candidates = party.map(p => p._id).filter(id => id.toString() !== targetId);
  }
  // standalone wild (no npcId, no userId) — candidates stays [], no roster to draw from

  if (usedPokemonIds !== null && battle.playerPokemonLimit !== null) {
    const usedSet = new Set(usedPokemonIds.map(id => id.toString()));
    const atLimit = usedPokemonIds.length >= battle.playerPokemonLimit;
    candidates = candidates.filter(id => usedSet.has(id.toString()) || !atLimit);
  }

  if (candidates.length === 0) {
    moveEvents.push(`${outgoingName} couldn't be forced out — there's nowhere to send it!`);
    return;
  }

  const chosenId = candidates[Math.floor(Math.random() * candidates.length)];
  moveEvents.push(...await recallPokemon(battle, new mongoose.Types.ObjectId(targetId)));

  const targetEntry = (playerEntry ?? enemyEntry)!;
  targetEntry.activePokemonId = chosenId;
  targetEntry.activeSentOutOnTurn = battle.turnNumber;
  if (usedPokemonIds !== null && !usedPokemonIds.some(id => id.toString() === chosenId.toString())) {
    usedPokemonIds.push(chosenId);
  }
  battle.markModified(playerEntry ? 'playerSide' : 'enemySide');

  const { poke: incoming, cache: incomingCache } = await fetchDisplay(chosenId, 'nickname speciesId', 'name');
  moveEvents.push(`${outgoingName} was dragged out! ${pokeDisplayName(incoming, incomingCache)} was sent out!`);
  moveEvents.push(...await applyEntryAbilities(battle, chosenId, playerEntry ? 'player' : 'enemy'));
  // Fainting from this is caught by submitTarget's own applyFaints/checkBattleEnd call
  // right after the whole move resolves — no need to duplicate it here.
  moveEvents.push(...await applyEntryHazards(battle, chosenId, playerEntry ? 'player' : 'enemy'));
  moveEvents.push(...await applyPendingWish(battle, chosenId, playerEntry ? 'player' : 'enemy'));
}

// Follow Me / Rage Powder — if the defending side has an active Pokémon with either
// volatile up, single-target foe moves redirect to them regardless of who was
// clicked. Only affects moves whose real target category is 'single' (spread moves
// ignore redirects). Rage Powder additionally exempts Grass-type attackers and the
// Overcoat ability; Follow Me has no such exemption. Returns null if no redirect applies.
async function resolveRedirectTarget(
  battle: HydratedDocument<IBattle>, entry: { activePokemonId: mongoose.Types.ObjectId; moveId: string },
  actingSide: 'playerSide' | 'enemySide',
): Promise<string | null> {
  const atkPoke = await Pokemon.findById(entry.activePokemonId, 'speciesId hasHiddenAbility').lean();
  if (!atkPoke) return null;
  const moveMeta = await fetchMoveMeta(atkPoke.speciesId, entry.moveId);
  if (getMoveTargetCategory(moveMeta?.target ?? '') !== 'single') return null;

  const defendingEntries = actingSide === 'playerSide' ? battle.enemySide : battle.playerSide;
  const candidateIds = defendingEntries.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!.toString());
  if (candidateIds.length === 0) return null;

  const candidates = await Pokemon.find({ _id: { $in: candidateIds }, currentHp: { $gt: 0 } }, 'volatileStatus').lean();
  const redirector = candidates.find(p => ((p.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'follow-me' || v.condition === 'rage-powder'));
  if (!redirector) return null;

  const redirectorVol = (redirector.volatileStatus as Array<{ condition: string }>) ?? [];
  const isRagePowderOnly = redirectorVol.some(v => v.condition === 'rage-powder') && !redirectorVol.some(v => v.condition === 'follow-me');
  if (isRagePowderOnly) {
    const atkCache = await PokedexCache.findOne({ pokeApiId: atkPoke.speciesId }, 'types abilities').lean();
    const isGrass  = ((atkCache?.types as string[]) ?? []).includes('grass');
    const abilitySlugs = atkCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (atkCache.abilities as CachedAbility[]) ?? [], atkPoke.hasHiddenAbility as boolean) : [];
    if (isGrass || abilitySlugs.includes('overcoat')) return null;
  }

  return redirector._id.toString();
}

async function resolveSwitch(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  if (!entry.switchToPokemonId) return [];
  const incomingId = entry.switchToPokemonId;
  const events: string[] = [];
  let sideLabel: 'player' | 'enemy';

  if (entry.actorType === 'npc') {
    const npcEntry = battle.enemySide.find(
      e => e.npcId?.toString() === entry.actorId.toString() && e.activePokemonId?.toString() === entry.activePokemonId.toString(),
    );
    if (!npcEntry) return [];
    const outgoingId = npcEntry.activePokemonId;
    if (outgoingId) events.push(...await recallPokemon(battle, outgoingId));
    npcEntry.activePokemonId = incomingId;
    npcEntry.activeSentOutOnTurn = battle.turnNumber;
    battle.markModified('enemySide');
    await Battle.updateOne(
      { _id: battle._id, 'enemySide.npcId': npcEntry.npcId },
      { $set: { 'enemySide.$.activeSentOutOnTurn': battle.turnNumber } },
    );
    sideLabel = 'enemy';
  } else {
    // Player-controlled actor — could be on playerSide, or (pvp only) on enemySide.
    const own = findOwnSideEntry(battle, entry.actorId.toString());
    if (!own) return [];
    const outgoingId = own.entry.activePokemonId;
    if (outgoingId) events.push(...await recallPokemon(battle, outgoingId));
    own.entry.activePokemonId = incomingId;
    own.entry.activeSentOutOnTurn = battle.turnNumber;
    battle.markModified(own.side);
    await Battle.updateOne(
      { _id: battle._id, [`${own.side}.userId`]: entry.actorId },
      { $set: { [`${own.side}.$.activeSentOutOnTurn`]: battle.turnNumber } },
    );
    if (!own.entry.usedPokemonIds.some(id => id.toString() === incomingId.toString())) {
      own.entry.usedPokemonIds.push(incomingId);
    }
    sideLabel = own.side === 'playerSide' ? 'player' : 'enemy';
  }

  const { poke: incoming, cache: inCache } = await fetchDisplay(incomingId, 'nickname speciesId', 'name');
  events.push(`${pokeDisplayName(incoming, inCache)} was sent out!`);
  events.push(...await applyEntryAbilities(battle, incomingId, sideLabel));
  events.push(...await applyEntryHazards(battle, incomingId, sideLabel));
  events.push(...await applyPendingWish(battle, incomingId, sideLabel));
  // Switches resolve mid-round inside autoSkipBlockedActors, well before the normal
  // end-of-round applyFaints call — a hazard-fainted switch-in needs to be caught
  // here directly, not left active-but-dead until the round ends.
  events.push(...await applyFaints(battle));
  events.push(...await checkBattleEnd(battle));
  return events;
}

// Baton Pass — like resolveSwitch, but the outgoing Pokémon's stat stages and a
// subset of its volatile statuses carry over to whoever comes in, instead of being
// wiped. switchToPokemonId is chosen by the player/DM at move-submission time (see
// submitMove/dmSubmitMove), not through the normal targeting phase, since the move
// doesn't target a foe at all.
const BATON_PASSABLE_VOLATILES = new Set(['leech-seed', 'ingrain', 'aqua-ring', 'cursed', 'focus-energy']);

async function resolveBatonPass(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  if (!entry.switchToPokemonId) return [];
  const incomingId = entry.switchToPokemonId;
  const outgoingId = entry.activePokemonId;
  const events: string[] = [];
  let sideLabel: 'player' | 'enemy';
  let ownEntry: PlayerSideEntry | EnemySideEntry;
  let sideKey: 'playerSide' | 'enemySide';

  if (entry.actorType === 'npc') {
    const npcEntry = battle.enemySide.find(
      e => e.npcId?.toString() === entry.actorId.toString() && e.activePokemonId?.toString() === outgoingId.toString(),
    );
    if (!npcEntry) return [];
    ownEntry = npcEntry; sideKey = 'enemySide'; sideLabel = 'enemy';
  } else {
    const own = findOwnSideEntry(battle, entry.actorId.toString());
    if (!own) return [];
    ownEntry = own.entry; sideKey = own.side; sideLabel = own.side === 'playerSide' ? 'player' : 'enemy';
  }

  // Snapshot what gets passed BEFORE any clearing happens.
  const outIdStr = outgoingId.toString();
  const stageMap = battle.statStages as Record<string, StatStages>;
  const passedStages = stageMap[outIdStr];
  const outgoingDoc = await Pokemon.findById(outgoingId, 'ownerId ownerType nickname speciesId hasHiddenAbility statusCondition currentHp nature level evs volatileStatus').lean();
  const passableVolatiles = ((outgoingDoc?.volatileStatus as Array<{ condition: string; turnsRemaining: number }>) ?? [])
    .filter(v => BATON_PASSABLE_VOLATILES.has(v.condition) || v.condition.startsWith('bound:'));

  // Same cleanup as a normal recall, EXCEPT stat stages — those get moved, not deleted.
  await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  delete (battle.consecutiveMoves as Record<string, unknown>)[outIdStr];
  battle.markModified('consecutiveMoves');
  delete (battle.lockedMoves as Record<string, unknown>)[outIdStr];
  battle.markModified('lockedMoves');
  const outCache = outgoingDoc ? await PokedexCache.findOne({ pokeApiId: outgoingDoc.speciesId }, 'name abilities baseStats').lean() : null;
  const outName  = pokeDisplayName(outgoingDoc, outCache);
  events.push(`${outName} went back, passing it on!`);
  events.push(...await releaseBoundTargets(battle, outgoingId));
  events.push(...await applySwitchOutAbilities(battle, outIdStr, outgoingDoc, outCache, outName));
  // Unlike stat stages, a traced ability is NOT something Baton Pass carries over —
  // the incoming Pokémon keeps its own ability, same as consecutiveMoves/lockedMoves.
  delete (battle.tracedAbility as Record<string, string>)[outIdStr];
  battle.markModified('tracedAbility');
  // Type changes (Soak/Conversion/etc.) and the last-hit-type memory aren't Baton
  // Pass-portable either — same treatment as tracedAbility.
  delete (battle.typeOverride as Record<string, string[]>)[outIdStr];
  battle.markModified('typeOverride');
  delete (battle.lastHitMoveType as Record<string, string>)[outIdStr];
  battle.markModified('lastHitMoveType');
  // Mimic's temporary swap isn't Baton Pass-portable either — same treatment.
  await revertMimic(battle, outgoingId);

  delete stageMap[outIdStr];
  const incIdStr = incomingId.toString();
  if (passedStages) stageMap[incIdStr] = passedStages;
  battle.markModified('statStages');
  if (passableVolatiles.length > 0) {
    await Pokemon.updateOne({ _id: incomingId }, { $push: { volatileStatus: { $each: passableVolatiles } } });
  }

  ownEntry.activePokemonId = incomingId;
  ownEntry.activeSentOutOnTurn = battle.turnNumber;
  battle.markModified(sideKey);
  if (sideKey === 'playerSide' && !(ownEntry as PlayerSideEntry).usedPokemonIds.some(id => id.toString() === incIdStr)) {
    (ownEntry as PlayerSideEntry).usedPokemonIds.push(incomingId);
  }

  const { poke: incoming, cache: inCache } = await fetchDisplay(incomingId, 'nickname speciesId', 'name');
  events.push(`${pokeDisplayName(incoming, inCache)} was sent out, inheriting the stat changes!`);
  events.push(...await applyEntryAbilities(battle, incomingId, sideLabel));
  events.push(...await applyEntryHazards(battle, incomingId, sideLabel));
  events.push(...await applyPendingWish(battle, incomingId, sideLabel));
  events.push(...await applyFaints(battle));
  events.push(...await checkBattleEnd(battle));
  return events;
}

async function resolveCatchAction(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;
  if (!itemId || targets.length === 0) return events;

  const wildPoke = await Pokemon.findById(targets[0], 'nickname speciesId level nature currentHp statusCondition moves evs').lean();
  if (!wildPoke || wildPoke.currentHp <= 0) { events.push('The wild Pokémon has already fainted!'); return events; }

  const cache = await PokedexCache.findOne({ pokeApiId: wildPoke.speciesId }, 'name baseStats catchRate types').lean();
  const speciesName = cache ? slugToDisplayName(cache.name as string) : 'Wild Pokémon';
  const displayName = wildPoke.nickname ?? speciesName;
  const user = await User.findById(actorId, 'username').lean();
  const userName = user?.username ?? 'Trainer';
  events.push(`${userName} threw a ${slugToDisplayName(itemId)} at ${displayName}!`);

  const maxHp = cache ? computeStats(cache.baseStats as BaseStats, wildPoke.level, wildPoke.nature, wildPoke.evs as BaseStats, ZERO_IVS).hp : wildPoke.currentHp;
  let caught = false;

  if (itemId === 'master-ball') {
    caught = true;
  } else {
    let ballMod = BALL_MODIFIERS[itemId] ?? 1.0;
    if (itemId === 'quick-ball') ballMod = battle.turnNumber === 1 ? 5.0 : 1.0;
    if (itemId === 'timer-ball') ballMod = Math.min(4.0, 1 + 0.3 * battle.turnNumber);
    if (itemId === 'nest-ball')  ballMod = Math.max(1.0, Math.min(4.0, (41 - wildPoke.level) / 10));
    if (itemId === 'net-ball') { const types = (cache?.types ?? []) as string[]; ballMod = types.some(t => t === 'water' || t === 'bug') ? 3.0 : 1.0; }
    const hpModifier = (3 * maxHp - 2 * wildPoke.currentHp) / (3 * maxHp);
    const catchValue = Math.min(255, Math.floor((cache?.catchRate as number ?? 45) * ballMod * hpModifier * statusCatchModifier(wildPoke.statusCondition)));
    const shakeCheck = Math.floor(65536 / Math.pow(255 / Math.max(catchValue, 1), 0.1875));
    let shakes = 0;
    for (let i = 0; i < 3; i++) {
      if (Math.floor(Math.random() * 65536) < shakeCheck) { shakes++; events.push(`The ball shook ${['once','twice','three times'][i]}...`); }
      else break;
    }
    caught = shakes === 3;
    if (!caught) events.push(['Oh no! The Pokémon broke free!','Darn! It appeared to be caught!','Aargh! Almost had it!'][shakes] ?? 'The Pokémon broke free!');
  }

  battle.catchAttempts.push({ playerId: new mongoose.Types.ObjectId(actorId.toString()), pokemonId: new mongoose.Types.ObjectId(targets[0].toString()), result: caught ? 'caught' : 'failed' });
  battle.markModified('catchAttempts');
  await Item.updateOne({ ownerId: actorId, itemId }, { $inc: { quantity: -1 } });
  await Item.deleteMany({ ownerId: actorId, itemId, quantity: { $lte: 0 } });

  if (caught) {
    const partyPokemon = await Pokemon.find({ ownerId: actorId, ownerType: 'player', isInParty: true }, 'partySlot').lean();
    const hasRoom = partyPokemon.length < 6;
    let nextSlot: number | null = null;
    if (hasRoom) {
      const usedSlots = new Set(partyPokemon.map(p => p.partySlot));
      nextSlot = 1; while (usedSlots.has(nextSlot)) nextSlot++;
    }
    await Pokemon.updateOne({ _id: targets[0] }, { $set: { ownerType: 'player', ownerId: actorId, isInParty: hasRoom, partySlot: nextSlot, caughtAt: new Date(), caughtByPlayerId: actorId } });
    const enemyEntry = battle.enemySide.find(e => e.activePokemonId?.toString() === targets[0].toString());
    if (enemyEntry) { enemyEntry.fainted.push(new mongoose.Types.ObjectId(targets[0].toString())); enemyEntry.activePokemonId = null; battle.markModified('enemySide'); }
    events.push(hasRoom
      ? `Gotcha! ${displayName} was caught! It was added to your party (slot ${nextSlot}).`
      : `Gotcha! ${displayName} was caught! Your party is full, so it was sent to your PC.`);
  }
  return events;
}

async function autoSkipBlockedActors(battle: HydratedDocument<IBattle>): Promise<void> {
  while (battle.currentTargetIndex < battle.turnQueue.length) {
    const entry = battle.turnQueue[battle.currentTargetIndex];

    if (entry.actionType === 'item') {
      const itemEvents = await resolveItemAction(battle, entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...itemEvents);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    if (entry.actionType === 'catch') {
      const catchEvents = await resolveCatchAction(battle, entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...catchEvents);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      const endEvents = await checkBattleEnd(battle);
      appendToLog(battle, ...endEvents);
      if (battle.status === 'complete') break;
      continue;
    }

    if (entry.actionType === 'run') {
      const { poke, cache } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
      appendToLog(battle, `${pokeDisplayName(poke, cache)} dashes away to reposition!`);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    if (entry.actionType === 'switch') {
      const switchEvents = await resolveSwitch(battle, entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...switchEvents);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    if (entry.actionType === 'move' && entry.moveId === 'baton-pass') {
      const bpEvents = await resolveBatonPass(battle, entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...bpEvents);
      await Pokemon.updateOne(
        { _id: entry.activePokemonId, moves: { $elemMatch: { moveId: 'baton-pass', currentPP: { $gt: 0 } } } },
        { $inc: { 'moves.$.currentPP': -1 } },
      );
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    const poke = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId statusCondition statusCounter currentHp volatileStatus').lean();
    if (!poke || poke.currentHp <= 0) {
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    if (entry.flinched) {
      const flinchCache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      appendToLog(battle, `${pokeDisplayName(poke, flinchCache)} flinched and couldn't move!`);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    const mustRecharge = ((poke.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'must-recharge');
    if (mustRecharge) {
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $pull: { volatileStatus: { condition: 'must-recharge' } } });
      const rechargeCache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      appendToLog(battle, `${pokeDisplayName(poke, rechargeCache)} must recharge!`);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    // Infatuation (Attract) is a volatile, not the primary statusCondition, so it's
    // gated independently — a Pokémon can be both infatuated AND paralyzed/asleep/etc.
    // and needs to pass both checks to act.
    const isInfatuated = ((poke.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('infatuated:'));
    if (isInfatuated) {
      const infatCache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      const infatName  = pokeDisplayName(poke, infatCache);
      if (Math.random() < 0.5) {
        appendToLog(battle, `${infatName} is immobilized by love!`);
        battle.turnQueue[battle.currentTargetIndex].resolved = true;
        battle.currentTargetIndex++;
        continue;
      }
      appendToLog(battle, `${infatName} is in love!`);
    }

    if (!poke.statusCondition) break;

    const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
    const { blocked, events } = await checkStatusBlock(poke._id as mongoose.Types.ObjectId, poke.statusCondition, poke.statusCounter, pokeDisplayName(poke, cache));
    appendToLog(battle, ...events);
    if (!blocked) break;
    battle.turnQueue[battle.currentTargetIndex].resolved = true;
    battle.currentTargetIndex++;
  }

  if (battle.currentTargetIndex >= battle.turnQueue.length) {
    await applyEndOfRound(battle);
  }
}

async function checkConfusion(battle: HydratedDocument<IBattle>, pokemonId: mongoose.Types.ObjectId): Promise<{ hitSelf: boolean; events: string[] }> {
  const poke = await Pokemon.findById(pokemonId, 'ownerId ownerType nickname speciesId level nature currentHp volatileStatus hasHiddenAbility evs').lean();
  if (!poke) return { hitSelf: false, events: [] };
  const confIdx = (poke.volatileStatus ?? []).findIndex(v => v.condition === 'confusion');
  if (confIdx === -1) return { hitSelf: false, events: [] };

  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name baseStats abilities').lean();
  const displayName = pokeDisplayName(poke, cache);

  const abilitySlugs = getEffectiveAbilitySlugs(battle, pokemonId.toString(), (cache?.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
  const confusionImmuneAbility = abilitySlugs.find(s => (STATUS_IMMUNITY_ABILITIES[s] ?? []).includes('confusion'));
  if (confusionImmuneAbility) {
    await Pokemon.updateOne({ _id: pokemonId }, { $pull: { volatileStatus: { condition: 'confusion' } } });
    return { hitSelf: false, events: [`${displayName}'s ${slugToDisplayName(confusionImmuneAbility)} snapped it out of confusion!`] };
  }

  const newTurns   = poke.volatileStatus[confIdx].turnsRemaining - 1;
  const didSnapOut = newTurns <= 0;
  if (didSnapOut) {
    await Pokemon.updateOne({ _id: pokemonId }, { $pull: { volatileStatus: { condition: 'confusion' } } });
  } else {
    await Pokemon.updateOne({ _id: pokemonId, 'volatileStatus.condition': 'confusion' }, { $set: { 'volatileStatus.$.turnsRemaining': newTurns } });
  }

  const events: string[] = [`${displayName} is confused...`];
  if (Math.random() < 0.5 && cache) {
    const ivs    = await getIvsForOwner(poke.ownerId, poke.ownerType);
    const stats  = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, ivs);
    const damage = Math.max(1, Math.floor(((2 * poke.level / 5 + 2) * 40 * stats.atk / stats.def) / 50 + 2));
    const newHp  = Math.max(0, poke.currentHp - damage);
    await Pokemon.updateOne({ _id: pokemonId }, { $set: { currentHp: newHp } });
    events.push(`${displayName} hurt itself in its confusion! (${damage} damage, ${newHp} HP remaining)`);
    if (didSnapOut) events.push(`${displayName} snapped out of its confusion!`);
    return { hitSelf: true, events };
  }
  if (didSnapOut) events.push(`${displayName} snapped out of its confusion!`);
  return { hitSelf: false, events };
}

async function applyStatusEffect(battle: HydratedDocument<IBattle>, targetId: mongoose.Types.ObjectId, effect: StatusMoveEffect): Promise<string[]> {
  const target = await Pokemon.findById(targetId, 'nickname speciesId statusCondition volatileStatus currentHp hasHiddenAbility').lean();
  if (!target || target.currentHp <= 0) return [];

  const cache = await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name types abilities').lean();
  const types = (cache?.types ?? []) as string[];
  const displayName = pokeDisplayName(target, cache);
  const statusLabels: Record<string, string> = { burn: 'burned', paralysis: 'paralyzed', sleep: 'fell asleep', freeze: 'was frozen solid', poison: 'was poisoned', toxic: 'was badly poisoned' };

  const isConfusion = effect.status === 'confusion';
  if (!isConfusion && target.statusCondition) return [`${displayName} is already ${statusLabels[target.statusCondition]}!`];
  if (isConfusion && target.volatileStatus.some(v => v.condition === 'confusion')) return [`${displayName} is already confused!`];

  // Safeguard (milestone 5.14 Wave 6) — blocks incoming status conditions (not
  // confusion, which is a volatile rather than a statusCondition in the real games
  // either) for the target's whole side, regardless of source (move, contact ability, etc).
  if (!isConfusion) {
    const targetSide = resolveActingSide(battle, targetId);
    if (targetSide && (battle.fieldConditions ?? []).some(f => f.condition === `safeguard:${targetSide}`)) {
      return [`${displayName}'s side is protected by Safeguard!`];
    }
  }

  const isImmune = (
    (effect.status === 'paralysis' && types.includes('electric')) ||
    (effect.status === 'burn'      && types.includes('fire'))     ||
    ((effect.status === 'poison' || effect.status === 'toxic') && (types.includes('poison') || types.includes('steel'))) ||
    (effect.status === 'freeze'    && types.includes('ice'))
  );
  if (isImmune) return [`It doesn't affect ${displayName}!`];

  const abilitySlugs = getEffectiveAbilitySlugs(battle, targetId.toString(), (cache?.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean);
  const statusImmuneAbility = abilitySlugs.find(s => (STATUS_IMMUNITY_ABILITIES[s] ?? []).includes(effect.status));
  if (statusImmuneAbility) {
    return [`${displayName}'s ${slugToDisplayName(statusImmuneAbility)} prevents the ${effect.status}!`];
  }

  if (isConfusion) {
    await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: 'confusion', turnsRemaining: Math.floor(Math.random() * 4) + 2 } } });
    return [`${displayName} became confused!`];
  }

  const update: Record<string, unknown> = { statusCondition: effect.status };
  if (effect.status === 'sleep') update.statusCounter = Math.floor(Math.random() * 3) + 1;
  if (effect.status === 'toxic') update.statusCounter = 1;
  await Pokemon.updateOne({ _id: targetId }, { $set: update });
  return [`${displayName} ${statusLabels[effect.status]}!`];
}

async function resolveMove(
  battle: HydratedDocument<IBattle>,
  attackerPokemonId: mongoose.Types.ObjectId, targetPokemonId: mongoose.Types.ObjectId,
  moveId: string, weather: IBattle['weather'], stages: { attacker?: StatStages; target?: StatStages } = {},
  powerOverride?: number, wonderRoomActive = false, magicRoomActive = false,
  screens: { reflect: boolean; lightScreen: boolean; auroraVeil: boolean } = { reflect: false, lightScreen: false, auroraVeil: false },
): Promise<{ damage: number; isCrit: boolean; events: string[]; category: string | null }> {
  const [attacker, target] = await Promise.all([Pokemon.findById(attackerPokemonId).lean(), Pokemon.findById(targetPokemonId).lean()]);
  if (!attacker || !target) return { damage: 0, isCrit: false, events: ['(Pokémon not found during move resolution)'], category: null };
  const [attackerCache, targetCache] = await Promise.all([PokedexCache.findOne({ pokeApiId: attacker.speciesId }).lean(), PokedexCache.findOne({ pokeApiId: target.speciesId }).lean()]);
  if (!attackerCache || !targetCache) return { damage: 0, isCrit: false, events: ['(Species cache missing during move resolution)'], category: null };
  const [attackerIvs, targetIvs] = await Promise.all([
    getIvsForOwner(attacker.ownerId, attacker.ownerType),
    getIvsForOwner(target.ownerId, target.ownerType),
  ]);

  const attackerName = pokeDisplayName(attacker, attackerCache);
  const targetName   = pokeDisplayName(target, targetCache);
  const moveName     = slugToDisplayName(moveId);
  type CachedMoveData = { name: string; type: string; category: string; power: number | null; implemented: boolean };
  let moveData = (attackerCache.moves as CachedMoveData[]).find(m => m.name === moveId);
  if (!moveData) {
    // Move data (power/type/category) is inherent to the move, not the attacker's
    // species — the attacker's own cache only has detail for moves it can actually
    // learn, so this is only ever null for a move outside that learnset (chiefly
    // Metronome rolling into something the user doesn't know). Fall back to any
    // other cached species that happens to have it, rather than treating it as
    // "not implemented".
    const anyCache = await PokedexCache.findOne({ 'moves.name': moveId }, { 'moves.$': 1 }).lean();
    moveData = (anyCache?.moves as CachedMoveData[] | undefined)?.[0];
  }

  // Fixed-damage moves (Seismic Toss, Endeavor, etc.) are cached with power:null since
  // their damage doesn't come from the power/stat formula at all — they'd otherwise
  // trip this guard and silently deal 0 (milestone 5.14 Wave 2 finding). Fling is cached
  // with power:null for the same underlying reason (its real power is item-dependent,
  // not a fixed PokeAPI value) — powerOverride supplies the real number in that case
  // (milestone 5.14 Wave 12), so a truthy override also bypasses this guard.
  if (!moveData || (!moveData.power && !powerOverride && !FIXED_DAMAGE_MOVES.has(moveId))) {
    const implNote = moveData && !moveData.implemented && !(moveId in STATUS_MOVES) && !(moveId in WEATHER_MOVES) && !SELF_TARGETING_MOVES.has(moveId) && !(moveId in STAT_STAGE_MOVES) ? ' (effect not yet implemented)' : '';
    return { damage: 0, isCrit: false, events: [`${attackerName} used ${moveName} on ${targetName}.${implNote}`], category: moveData?.category ?? null };
  }

  const hasFocusEnergy = ((attacker.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'focus-energy');
  // Crit stage table (milestone 5.14 Wave 3) — Focus Energy contributes +2 stages (Gen
  // 5+ value; corrected from this project's earlier flat 1/6 approximation, which
  // matched no real gen's actual rate) and high-crit-ratio moves contribute +1, stacking
  // in the same shared pool as the real games. A handful of moves (Storm Throw, Frost
  // Breath, Surging Strikes, Wicked Blow) always crit outright regardless of stage.
  // Fixed-damage moves can never land a critical hit in the real games.
  const critStage = (hasFocusEnergy ? 2 : 0) + (HIGH_CRIT_MOVES.has(moveId) ? 1 : 0);
  const isCrit = !FIXED_DAMAGE_MOVES.has(moveId) &&
    (ALWAYS_CRIT_MOVES.has(moveId) || Math.random() < CRIT_STAGE_RATES[Math.min(critStage, CRIT_STAGE_RATES.length - 1)]);
  const hasHelpingHand = ((attacker.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'helping-hand');

  const attackerAbilities = (attackerCache.abilities as CachedAbility[]) ?? [];
  const targetAbilities   = (targetCache.abilities   as CachedAbility[]) ?? [];
  const attackerAbilitySlugs = getEffectiveAbilitySlugs(battle, attackerPokemonId.toString(), attackerAbilities, attacker.hasHiddenAbility as boolean);
  const targetAbilitySlugs   = getEffectiveAbilitySlugs(battle, targetPokemonId.toString(),   targetAbilities,   target.hasHiddenAbility   as boolean);
  // "Primary" — the one ability @smogon/calc's single-ability field actually receives.
  // Every OTHER active ability still applies via the type-immunity pre-check below and
  // the secondary-multiplier pass after the library runs (see resolveDamagingMove).
  const attackerAbilitySlug = attackerAbilitySlugs[0] as string | undefined;
  const targetAbilitySlug   = targetAbilitySlugs[0] as string | undefined;
  const attackerAbilityName = attackerAbilitySlug ? slugToDisplayName(attackerAbilitySlug) : undefined;
  const targetAbilityName   = targetAbilitySlug   ? slugToDisplayName(targetAbilitySlug)   : undefined;

  const pinchEvents: string[] = [];
  for (const slug of attackerAbilitySlugs) {
    const boostedType = PINCH_ABILITIES[slug];
    if (boostedType && moveData.type?.toLowerCase() === boostedType) {
      const maxHp = computeStats(attackerCache.baseStats as BaseStats, attacker.level, attacker.nature, attacker.evs as BaseStats, attackerIvs).hp;
      if (attacker.currentHp <= Math.floor(maxHp / 3)) pinchEvents.push(`${attackerName}'s ${slugToDisplayName(slug)}!`);
    }
  }

  // @smogon/calc's result.desc() never actually contains the words "super effective" /
  // "not very effective" (checked the library source), so effectiveness has to be computed
  // directly from the move's type vs the target's type(s) rather than string-matched.
  // getEffectiveTypes consults Battle.typeOverride first (Soak/Conversion/Camouflage/
  // Reflect Type/Conversion 2, milestone 5.14 Wave 11), falling back to the cached
  // species types when no override is set.
  const attackerEffectiveTypes = getEffectiveTypes(battle, attackerPokemonId.toString(), (attackerCache.types as string[]) ?? []);
  const targetEffectiveTypes   = getEffectiveTypes(battle, targetPokemonId.toString(),   (targetCache.types   as string[]) ?? []);
  const moveType = moveData.type?.toLowerCase();
  const typeEffectiveness = moveType ? getTypeEffectiveness(moveType, targetEffectiveTypes) : 1;

  // Type-immunity/type-interaction abilities (Levitate, Water Absorb, Flash Fire, etc.)
  // are checked directly against the FULL target ability array before the move ever
  // reaches @smogon/calc — these are independent per-type checks, so a defender with
  // two of them (one non-hidden ability granting each) both genuinely apply, unlike the
  // single "primary" ability @smogon/calc itself only gets one of. Deliberately scoped to
  // plain type-keyed immunities only — Storm Drain/Lightning Rod's move-redirect, Sound
  // proof/Bulletproof's move-flag requirement (not a type), and Dry Skin's multi-part
  // weather/fire-vulnerability behavior are all excluded as separate, more invasive gaps.
  const typeImmunity = moveType && targetCache.baseStats ? TYPE_IMMUNITY_ABILITIES.find(t => targetAbilitySlugs.includes(t.abilitySlug) && t.type === moveType) : undefined;
  const wonderGuardBlocks = targetAbilitySlugs.includes('wonder-guard') && moveType && typeEffectiveness <= 1;
  if (typeImmunity || wonderGuardBlocks) {
    const abilitySlug = typeImmunity?.abilitySlug ?? 'wonder-guard';
    const events = [...pinchEvents, `${attackerName} used ${moveName} on ${targetName}, but it had no effect thanks to ${targetName}'s ${slugToDisplayName(abilitySlug)}!`];
    if (typeImmunity?.action === 'heal' && targetCache.baseStats) {
      const targetMaxHp = computeStats(targetCache.baseStats as BaseStats, target.level, target.nature, target.evs as BaseStats, targetIvs).hp;
      if (target.currentHp < targetMaxHp) {
        const healed = Math.min(targetMaxHp - target.currentHp, Math.floor(targetMaxHp / 4));
        await Pokemon.updateOne({ _id: targetPokemonId }, { $set: { currentHp: target.currentHp + healed } });
        events.push(`${targetName} restored ${healed} HP!`);
      }
    } else if (typeImmunity?.action === 'boost-stat' && typeImmunity.stat) {
      const stageMap = battle.statStages as Record<string, StatStages>;
      events.push(...applyStatStageEffects(stageMap, targetPokemonId.toString(), [{ stat: typeImmunity.stat, stages: 1, target: 'self' }], targetName));
      battle.markModified('statStages');
    } else if (typeImmunity?.action === 'flash-fire-boost') {
      const alreadyBoosted = ((target.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'flash-fire-boost');
      if (!alreadyBoosted) {
        await Pokemon.updateOne({ _id: targetPokemonId }, { $push: { volatileStatus: { condition: 'flash-fire-boost', turnsRemaining: 99 } } });
        events.push(`${targetName}'s Fire-type moves are powered up!`);
      }
    }
    return { damage: 0, isCrit: false, events, category: moveData.category ?? null };
  }

  let damage = 0;
  if (CUSTOM_FIXED_DAMAGE_MOVES.has(moveId)) {
    // No @smogon/calc support for these — computed directly, same treatment as
    // Pain Split/Strength Sap. Blocked outright by a 0x type-chart matchup (e.g.
    // Ghost-type immunity to Endeavor/Super Fang) since we bypass the library's own
    // type chart entirely by not calling calculate() for these.
    if (typeEffectiveness === 0) {
      damage = 0;
    } else if (moveId === 'endeavor') {
      damage = Math.max(0, target.currentHp - attacker.currentHp);
    } else if (moveId === 'super-fang' || moveId === 'ruination') {
      damage = Math.max(1, Math.floor(target.currentHp / 2));
    } else if (moveId === 'psywave') {
      // Gen 6+ formula: random 50%–150% of the user's level, in whole-percent steps.
      damage = Math.max(1, Math.floor((attacker.level * (Math.floor(Math.random() * 101) + 50)) / 100));
    }
  } else try {
    const toBoosts = (s?: StatStages) => s ? { atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe } : undefined;
    // overrides.types feeds a changed type (Soak/Conversion/etc.) into @smogon/calc's
    // OWN internal STAB/type-chart math, which otherwise derives types purely from its
    // built-in species dex by name and would silently ignore any override this project
    // applies elsewhere (milestone 5.14 Wave 11) — same overrides mechanism already used
    // one line below for Metronome's power override.
    const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), { level: attacker.level, nature: cap(attacker.nature) as any, evs: toCalcEvs(attacker.evs as BaseStats), ivs: toCalcIvs(attackerIvs), curHP: attacker.currentHp, status: toCalcStatus(attacker.statusCondition) as any, ability: attackerAbilityName as any, item: toCalcItem(attacker.heldItem as string | null) as any, boosts: toBoosts(stages.attacker) as any, overrides: { types: attackerEffectiveTypes.map(cap) } as any });
    const calcTarget   = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string),   { level: target.level,   nature: cap(target.nature)   as any, evs: toCalcEvs(target.evs as BaseStats),   ivs: toCalcIvs(targetIvs), curHP: target.currentHp,   ability: targetAbilityName   as any, item: toCalcItem(target.heldItem as string | null) as any,   boosts: toBoosts(stages.target)   as any, overrides: { types: targetEffectiveTypes.map(cap) } as any });
    // @smogon/calc has native Wonder Room (Def/SpDef swap) and Magic Room (held-item
    // suppression) support via Field flags — no need to hand-roll either. Both are live
    // now that a real held item reaches CalcPokemon (milestone 5.17a) — Magic Room's
    // flag was inert before this since there was nothing for it to suppress. It also has
    // NATIVE fixed-damage support for Seismic Toss/Night Shade/Dragon Rage/Sonic Boom/
    // Final Gambit (handleFixedDamageMoves + a dedicated Final Gambit branch in its own
    // gen789 mechanics) — no hand-rolling needed for those, they just flow through here
    // now that the power:null guard above no longer blocks them (milestone 5.14 Wave 2).
    // Fling (milestone 5.14 Wave 12) needs a special dodge: @smogon/calc has its OWN
    // native `case 'Fling':` handling that recomputes basePower from attacker.item —
    // completely ignoring overrides.basePower. This is moot for calcAttacker.item
    // itself anyway (the item's already been cleared from the DB by the time this
    // fresh fetch runs, see flingPowerOverride above), but the name-keyed special
    // case would still zero out the move even so. Passing a neutral stand-in move
    // name sidesteps it entirely, while overrides.type/category still make sure
    // Fling's own real type/category (not the stand-in's) are what the formula uses.
    const calcMoveName = moveId === 'fling' ? 'Tackle' : moveName;
    const moveOverrides: Record<string, unknown> = {};
    if (powerOverride) moveOverrides.basePower = powerOverride;
    if (moveId === 'fling') { moveOverrides.type = cap(moveType ?? 'dark'); moveOverrides.category = 'Physical'; }
    const result = calculate(GEN9, calcAttacker, calcTarget, new CalcMove(GEN9, calcMoveName, Object.keys(moveOverrides).length > 0 ? { overrides: moveOverrides } as any : undefined), new Field({ weather: toCalcWeather(weather) as any, isWonderRoom: wonderRoomActive, isMagicRoom: magicRoomActive, defenderSide: { isReflect: screens.reflect, isLightScreen: screens.lightScreen, isAuroraVeil: screens.auroraVeil } } as any));
    const rolls  = Array.isArray(result.damage) ? result.damage : [result.damage];
    const picked = rolls[Math.floor(Math.random() * rolls.length)];
    damage = Array.isArray(picked) ? picked[Math.floor(Math.random() * picked.length)] : (picked as number);
    if (isCrit && damage > 0) damage = Math.floor(damage * 1.5);
  } catch {
    if (moveId === 'seismic-toss' || moveId === 'night-shade') damage = typeEffectiveness === 0 ? 0 : attacker.level;
    else if (moveId === 'dragon-rage') damage = typeEffectiveness === 0 ? 0 : 40;
    else if (moveId === 'sonic-boom') damage = typeEffectiveness === 0 ? 0 : 20;
    else if (moveId === 'final-gambit') damage = typeEffectiveness === 0 ? 0 : attacker.currentHp;
    else {
      damage = Math.max(1, Math.floor(((powerOverride ?? moveData.power!) * attacker.level) / 50));
      if (attackerAbilitySlug === 'protean' || attackerAbilitySlug === 'libero') damage = Math.floor(damage * 1.5);
      else if (attackerAbilitySlug && attackerAbilitySlug in ILATE_MAP && moveData.type?.toLowerCase() === 'normal') damage = Math.floor(damage * 1.2);
      damage = Math.floor(damage * typeEffectiveness);
    }
  }
  // Secondary-ability multiplier stacking: @smogon/calc already fully and correctly
  // applied the PRIMARY ability (attackerAbilitySlugs[0] / targetAbilitySlugs[0]) inside
  // its own damage formula. Any additional active ability beyond that can't be handed to
  // the library a second time, so a small, well-known set of simple multiplier effects
  // are hand-applied here instead — the same technique this project already used for
  // Protean/-ilate in the fallback formula, just covering more abilities and running on
  // the primary @smogon/calc path too, not just the fallback. None of this applies to
  // fixed-damage moves — their damage is set, not scaled by anything (milestone 5.14
  // Wave 2), so the whole block is skipped for them.
  if (damage > 0 && !FIXED_DAMAGE_MOVES.has(moveId)) {
    const isStab = moveType != null && attackerEffectiveTypes.includes(moveType);
    for (const slug of attackerAbilitySlugs.slice(1)) {
      if (slug === 'guts' && attacker.statusCondition && moveData.category === 'physical') damage = Math.floor(damage * 1.5);
      else if ((slug === 'huge-power' || slug === 'pure-power') && moveData.category === 'physical') damage = Math.floor(damage * 2);
      else if (slug === 'technician' && (powerOverride ?? moveData.power!) <= 60) damage = Math.floor(damage * 1.5);
      else if (slug === 'adaptability' && isStab) damage = Math.floor(damage * (2 / 1.5));
      else if (slug === 'sniper' && isCrit) damage = Math.floor(damage * 1.5);
    }
    for (const slug of targetAbilitySlugs.slice(1)) {
      if ((slug === 'solid-rock' || slug === 'filter') && typeEffectiveness > 1) damage = Math.floor(damage * 0.75);
      else if (slug === 'multiscale' && target.currentHp >= computeStats(targetCache.baseStats as BaseStats, target.level, target.nature, target.evs as BaseStats, targetIvs).hp) damage = Math.floor(damage * 0.5);
    }
    // Knock Off (milestone 5.14 Wave 12) — 1.5x when the target holds a removable item;
    // the actual removal happens after the hit lands, back in resolveDamagingMove.
    if (moveId === 'knock-off' && target.heldItem) damage = Math.floor(damage * 1.5);
    damage = Math.max(1, damage);
  }

  if (hasHelpingHand && damage > 0) damage = Math.floor(damage * 1.5);
  damage = Math.max(0, damage);

  const effectNote =
    typeEffectiveness === 0 ? " It had no effect!"
    : typeEffectiveness > 1 ? " It's super effective!"
    : typeEffectiveness < 1 ? " It's not very effective..."
    : '';
  return { damage, isCrit: isCrit && damage > 0, events: [...pinchEvents, `${attackerName} used ${moveName} on ${targetName} for ${damage} damage!${effectNote}${isCrit && damage > 0 ? ' Critical hit!' : ''}`], category: moveData.category ?? null };
}

// attackerId/attackerType identify who dealt the fainting blow, if known — only
// passed by the single-move resolution path (submitTarget). End-of-round faints
// (status/weather/leech-seed DoT) have no single attacker, so loot never drops
// there; those callers simply omit the two args.
async function applyFaints(
  battle: HydratedDocument<IBattle>,
  attackerId?: mongoose.Types.ObjectId,
  attackerType?: 'player' | 'npc',
): Promise<string[]> {
  const events: string[] = [];
  const sides = [[battle.playerSide, 'playerSide'], [battle.enemySide, 'enemySide']] as const;
  for (const [entries, sideKey] of sides) {
    for (const entry of entries) {
      if (!entry.activePokemonId) continue;
      const poke = await Pokemon.findById(
        entry.activePokemonId,
        'currentHp nickname speciesId heldItem ownerId ownerType',
      ).lean();
      if (!poke || poke.currentHp > 0) continue;
      const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      events.push(`${pokeDisplayName(poke, cache)} fainted!`);
      events.push(...await releaseBoundTargets(battle, entry.activePokemonId));

      const clearedFields: Record<string, unknown> = { volatileStatus: [] };

      // Loot drop — only for wild-owned Pokémon (standalone wild spawns, or an
      // Npc.type:'wild' party member), only to a real attacking player, and
      // only when it was actually holding something. Trainer NPCs' held items
      // are flavor-only and never drop (see Key Decisions, milestone 5.12).
      if (poke.heldItem && attackerType === 'player' && attackerId) {
        let isWildSource = poke.ownerType === 'wild';
        if (poke.ownerType === 'npc') {
          const npc = await Npc.findById(poke.ownerId, 'type').lean();
          isWildSource = npc?.type === 'wild';
        }
        if (isWildSource) {
          const pocket = getPocket(poke.heldItem);
          if (pocket) {
            await Item.findOneAndUpdate(
              { ownerId: attackerId, itemId: poke.heldItem },
              { $inc: { quantity: 1 }, $setOnInsert: { pocket, ownerType: 'player' } },
              { upsert: true },
            );
            clearedFields.heldItem = null;
            events.push(`${pokeDisplayName(poke, cache)} dropped its ${slugToDisplayName(poke.heldItem)}!`);
          }
        }
      }

      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: clearedFields });
      delete (battle.statStages as Record<string, StatStages>)[entry.activePokemonId.toString()];
      battle.markModified('statStages');
      delete (battle.consecutiveMoves as Record<string, unknown>)[entry.activePokemonId.toString()];
      battle.markModified('consecutiveMoves');
      delete (battle.lockedMoves as Record<string, unknown>)[entry.activePokemonId.toString()];
      battle.markModified('lockedMoves');
      delete (battle.tracedAbility as Record<string, string>)[entry.activePokemonId.toString()];
      battle.markModified('tracedAbility');
      delete (battle.typeOverride as Record<string, string[]>)[entry.activePokemonId.toString()];
      battle.markModified('typeOverride');
      delete (battle.lastHitMoveType as Record<string, string>)[entry.activePokemonId.toString()];
      battle.markModified('lastHitMoveType');
      await revertMimic(battle, entry.activePokemonId);
      entry.fainted.push(entry.activePokemonId);
      entry.activePokemonId = null;
      battle.markModified(sideKey);
    }
  }
  return events;
}

// Awards EXP/EVs (computed from a set of fainted opposing Pokémon) to every party Pokémon
// belonging to `gainingEntries`' trainers. Shared by pve/wild (playerSide gains from
// enemySide's fainted NPCs/wild Pokémon) and pvp (each side gains from the other's fainted
// Pokémon — see distributeExp below).
async function awardExpToSide(
  battle: HydratedDocument<IBattle>,
  gainingEntries: Array<{ userId: mongoose.Types.ObjectId; usedPokemonIds: mongoose.Types.ObjectId[] }>,
  faintedOpponentIds: mongoose.Types.ObjectId[],
): Promise<string[]> {
  const events: string[] = [];
  if (faintedOpponentIds.length === 0 || gainingEntries.length === 0) return events;

  const faintedOpponents = await Pokemon.find({ _id: { $in: faintedOpponentIds } }, 'level speciesId').lean();
  const totalBaseExp = faintedOpponents.reduce((sum, p) => sum + p.level * 5, 0);
  if (totalBaseExp === 0) return events;

  const gainingUserIds  = gainingEntries.map(e => e.userId);
  const allPartyPokemon = await Pokemon.find({ ownerId: { $in: gainingUserIds }, ownerType: 'player', isInParty: true }, '_id ownerId nickname speciesId level exp nature currentHp evs evolutionOverrides').lean();
  const speciesIds = [...new Set([...allPartyPokemon.map(p => p.speciesId), ...faintedOpponents.map(p => p.speciesId)])];
  const caches     = speciesIds.length > 0 ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name expGroup baseStats evYield').lean() : [];
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  const campaign  = await Campaign.findById(battle.campaignId, 'levelCapEnabled').lean();
  const owners    = await User.find({ _id: { $in: gainingUserIds } }, 'badges trainerStats').lean();
  const capMap    = new Map(owners.map(u => [
    u._id.toString(),
    getEffectiveLevelCap(u.badges?.length ?? 0, campaign?.levelCapEnabled ?? true),
  ]));
  const ivsMap    = new Map(owners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));

  const totalEvYield = faintedOpponents.reduce((acc, p) => {
    const yieldStats = cacheMap.get(p.speciesId)?.evYield as BaseStats | undefined;
    if (yieldStats) (Object.keys(acc) as (keyof BaseStats)[]).forEach(k => { acc[k] += yieldStats[k]; });
    return acc;
  }, { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 } as BaseStats);

  for (const gainingEntry of gainingEntries) {
    const usedIds = new Set(gainingEntry.usedPokemonIds.map(id => id.toString()));
    const partyPokemon = allPartyPokemon.filter(p => p.ownerId.toString() === gainingEntry.userId.toString());
    for (const poke of partyPokemon) {
      const isActive = usedIds.has(poke._id.toString());
      const expGain  = isActive ? totalBaseExp : Math.floor(totalBaseExp / 2);
      if (expGain <= 0) continue;
      const cache       = cacheMap.get(poke.speciesId);
      const displayName = pokeDisplayName(poke, cache);
      events.push(`${displayName} gained ${expGain} EXP${isActive ? '' : ' (Exp. Share)'}!`);
      const { evs: newEvs, gainedStats } = applyEvGain(poke.evs as BaseStats, totalEvYield);
      if (gainedStats.length > 0) events.push(`${displayName} gained EVs in ${gainedStats.join(', ')}!`);
      const newExp = (poke.exp as number) + expGain;
      const expGroup  = (cache?.expGroup as string | undefined) ?? 'medium-fast';
      const baseStats = cache?.baseStats as BaseStats | undefined;
      const overrides = (poke.evolutionOverrides ?? []) as { condition: string; value: string }[];
      const cap       = capMap.get(gainingEntry.userId.toString()) ?? 100;
      const ivs       = ivsMap.get(gainingEntry.userId.toString()) ?? ZERO_IVS;

      const { level: newLevel, currentHp: newHp, speciesId: newSpeciesId, events: levelEvents, cappedOut } = await applyLevelUpLoop({
        displayName,
        level: poke.level as number,
        exp: newExp,
        currentHp: poke.currentHp as number,
        speciesId: poke.speciesId as number,
        nature: poke.nature as string,
        evolutionOverrides: overrides,
        expGroup,
        baseStats,
        evs: newEvs,
        ivs,
        cap,
      });
      events.push(...levelEvents);
      if (cappedOut) events.push(`${displayName} has reached the level cap and cannot grow further!`);
      await Pokemon.updateOne({ _id: poke._id }, { $set: { exp: newExp, level: newLevel, currentHp: newHp, speciesId: newSpeciesId, evs: newEvs } });
    }
  }
  return events;
}

async function distributeExp(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.expAwarded) return [];
  battle.expAwarded = true;

  const enemySideFaintedIds = battle.enemySide.flatMap(e => e.fainted);
  const events = await awardExpToSide(battle, battle.playerSide, enemySideFaintedIds);

  // Pvp is the only case where enemySide is itself a roster of real trainers — they
  // earn EXP/EVs too, based on how many of playerSide's Pokémon they knocked out.
  // No money changes hands between sides; that's not part of any battle-reward path.
  if (battle.type === 'pvp') {
    const playerSideFaintedIds = battle.playerSide.flatMap(e => e.fainted);
    const enemyTrainerEntries = battle.enemySide.filter(
      (e): e is typeof e & { userId: mongoose.Types.ObjectId } => e.userId != null,
    );
    events.push(...await awardExpToSide(battle, enemyTrainerEntries, playerSideFaintedIds));
  }

  return events;
}

// pve only — pays battle.moneyReward to every playerSide trainer (not split, not scaled
// by participation) on victory. DM sets the amount at battle/encounter creation.
async function awardBattleMoney(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.moneyAwarded) return [];
  battle.moneyAwarded = true;
  if (battle.type !== 'pve' || battle.moneyReward <= 0) return [];

  const playerUserIds = battle.playerSide.map(e => e.userId);
  if (playerUserIds.length === 0) return [];
  await User.updateMany({ _id: { $in: playerUserIds } }, { $inc: { money: battle.moneyReward } });
  return [`Each trainer received ₽${battle.moneyReward.toLocaleString()}!`];
}

// "Does this roster of real trainers have any usable Pokémon left" — the check already
// used for playerSide, extracted so pvp can apply the exact same rule to enemySide
// (which is also a roster of real trainers in that case, not NPCs/wild).
async function isTrainerSideEliminated(
  entries: Array<{ userId: mongoose.Types.ObjectId; usedPokemonIds: mongoose.Types.ObjectId[] }>,
  pokemonLimit: number | null,
): Promise<boolean> {
  if (entries.length === 0) return false;
  const results = await Promise.all(entries.map(async entry => {
    const usedIds      = new Set(entry.usedPokemonIds.map(id => id.toString()));
    const limitReached = pokemonLimit !== null && entry.usedPokemonIds.length >= pokemonLimit;
    const healthyParty  = await Pokemon.find({ ownerId: entry.userId, ownerType: 'player', isInParty: true, currentHp: { $gt: 0 } }, '_id').lean();
    if (healthyParty.length === 0) return true;
    return !healthyParty.some(p => usedIds.has(p._id.toString()) || !limitReached);
  }));
  return results.every(Boolean);
}

async function checkBattleEnd(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.status !== 'active') return [];
  const hasActiveEnemy = battle.enemySide.some(e => e.activePokemonId !== null);
  let enemySideEliminated = false;
  if (!hasActiveEnemy && battle.enemySide.length > 0) {
    if (battle.type === 'pvp') {
      const pvpEnemyEntries = battle.enemySide.filter(
        (e): e is typeof e & { userId: mongoose.Types.ObjectId } => e.userId != null,
      );
      enemySideEliminated = await isTrainerSideEliminated(pvpEnemyEntries, battle.playerPokemonLimit);
    } else {
      const npcIds = battle.enemySide.map(e => e.npcId).filter((id): id is mongoose.Types.ObjectId => id != null);
      if (npcIds.length > 0) {
        if (battle.npcPokemonLimit !== null) {
          const results = await Promise.all(battle.enemySide.map(async entry => {
            if (!entry.npcId) return true;
            if (entry.fainted.length >= battle.npcPokemonLimit!) return true;
            return (await Pokemon.find({ ownerId: entry.npcId, ownerType: 'npc', currentHp: { $gt: 0 } }, '_id').lean()).length === 0;
          }));
          enemySideEliminated = results.every(Boolean);
        } else {
          enemySideEliminated = (await Pokemon.countDocuments({ ownerId: { $in: npcIds }, ownerType: 'npc', currentHp: { $gt: 0 } })) === 0;
        }
      } else { enemySideEliminated = true; }
    }
  }

  const hasActivePlayer = battle.playerSide.some(e => e.activePokemonId !== null);
  let playerSideEliminated = false;
  if (!hasActivePlayer && battle.playerSide.length > 0) {
    playerSideEliminated = await isTrainerSideEliminated(battle.playerSide, battle.playerPokemonLimit);
  }

  if (!enemySideEliminated && !playerSideEliminated) return [];
  battle.status = 'complete'; battle.endedAt = new Date();
  battle.winningSide = enemySideEliminated ? 'playerSide' : 'enemySide';

  if (battle.type === 'pvp') {
    // Both sides may have earned EXP over the course of the battle regardless of which
    // side ran out of usable Pokémon first — distributeExp handles both directions.
    // The log stays neutral (no "you win"/"you lose") since it's shared by both viewers;
    // the frontend uses battle.winningSide to render a personalized result per player.
    const expEvents = await distributeExp(battle);
    return ['One side has no more usable Pokémon — the battle is over!', ...expEvents];
  }

  if (enemySideEliminated) {
    const expEvents = await distributeExp(battle);
    const moneyEvents = await awardBattleMoney(battle);
    if (battle.type === 'wild') { const wasCaught = battle.catchAttempts.some(a => a.result === 'caught'); return wasCaught ? expEvents : ['The wild Pokémon was defeated!', ...expEvents]; }
    return ['All enemies have been defeated! The players win!', ...expEvents, ...moneyEvents];
  }
  return ['All players have been defeated!'];
}

async function applyFractionHeal(
  pokeId: string, pokeObjId: mongoose.Types.ObjectId, maxHp: number, fraction: number,
  runningHp: Map<string, number>, label: string, allEvents: string[],
): Promise<void> {
  const curHp = runningHp.get(pokeId) ?? 0;
  if (curHp >= maxHp) return;
  const newHp = Math.min(maxHp, curHp + Math.max(1, Math.floor(maxHp * fraction)));
  runningHp.set(pokeId, newHp);
  await Pokemon.updateOne({ _id: pokeObjId }, { $set: { currentHp: newHp } });
  allEvents.push(`${label} restored ${newHp - curHp} HP!`);
}

async function applyEndOfRound(battle: HydratedDocument<IBattle>): Promise<void> {
  const allActiveIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((id): id is mongoose.Types.ObjectId => id != null);

  if (allActiveIds.length > 0) {
    const activePokemons = await Pokemon.find({ _id: { $in: allActiveIds }, currentHp: { $gt: 0 } }, 'ownerId ownerType speciesId level nature currentHp statusCondition statusCounter nickname volatileStatus hasHiddenAbility evs heldItem').lean();
    const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
    const caches     = speciesIds.length > 0 ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types abilities').lean() : [];
    const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
    const runningHp  = new Map(activePokemons.map(p => [p._id.toString(), p.currentHp]));
    const allEvents: string[] = [];

    // Batch the owners' Trainer IV spreads once per round rather than per Pokémon.
    const playerOwnerIds = [...new Set(activePokemons.filter(p => p.ownerType === 'player').map(p => (p.ownerId as mongoose.Types.ObjectId).toString()))];
    const ivOwners  = playerOwnerIds.length > 0 ? await User.find({ _id: { $in: playerOwnerIds } }, 'trainerStats').lean() : [];
    const ivsMap    = new Map(ivOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));
    const pokeIvs   = (poke: { ownerId: mongoose.Types.ObjectId; ownerType: string }): BaseStats =>
      poke.ownerType === 'player' ? (ivsMap.get(poke.ownerId.toString()) ?? ZERO_IVS) : ZERO_IVS;

    for (const poke of activePokemons) {
      if (poke.statusCondition !== 'burn' && poke.statusCondition !== 'poison' && poke.statusCondition !== 'toxic') continue;
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp;
      const pokeName = pokeDisplayName(poke, cache);
      const abilitySlugsForStatus = getEffectiveAbilitySlugs(battle, poke._id.toString(), (cache.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
      if ((poke.statusCondition === 'poison' || poke.statusCondition === 'toxic') && abilitySlugsForStatus.includes('poison-heal')) {
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const healAmt   = Math.max(1, Math.floor(maxHp / 8));
        const newHp     = Math.min(maxHp, currentHp + healAmt);
        if (newHp > currentHp) { runningHp.set(poke._id.toString(), newHp); await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } }); allEvents.push(`${pokeName}'s Poison Heal restored ${newHp - currentHp} HP!`); }
        continue;
      }
      let damage: number; const update: Record<string, unknown> = {};
      if (poke.statusCondition === 'toxic') { const counter = poke.statusCounter ?? 1; damage = Math.max(1, Math.floor(maxHp * counter / 16)); update.statusCounter = Math.min(counter + 1, 15); }
      else { damage = Math.max(1, Math.floor(maxHp / 8)); }
      const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
      const newHp     = Math.max(0, currentHp - damage);
      update.currentHp = newHp; runningHp.set(poke._id.toString(), newHp);
      await Pokemon.updateOne({ _id: poke._id }, { $set: update });
      allEvents.push(`${pokeName} is hurt by its ${poke.statusCondition}! (${damage} damage, ${newHp} HP remaining)`);
    }

    if (battle.weather === 'sandstorm' || battle.weather === 'hail') {
      const immuneSet = battle.weather === 'sandstorm' ? new Set(['rock','steel','ground']) : new Set(['ice']);
      for (const poke of activePokemons) {
        const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
        const isRoosting = ((poke.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'roosting');
        const effectiveTypes = isRoosting ? ((cache.types as string[]) ?? []).filter(t => t !== 'flying') : (cache.types as string[]) ?? [];
        if (effectiveTypes.some(t => immuneSet.has(t))) continue;
        const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp;
        const damage = Math.max(1, Math.floor(maxHp / 16));
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const newHp = Math.max(0, currentHp - damage);
        runningHp.set(poke._id.toString(), newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeDisplayName(poke, cache)} is ${battle.weather === 'sandstorm' ? 'buffeted by the sandstorm' : 'pelted by hail'}! (${damage} damage, ${newHp} HP remaining)`);
      }
    }

    for (const poke of activePokemons) {
      const toClear = ((poke.volatileStatus as Array<{ condition: string }>) ?? []).filter(v => v.condition === 'roosting' || v.condition === 'enduring' || v.condition.startsWith('protecting') || v.condition === 'follow-me' || v.condition === 'rage-powder' || v.condition === 'helping-hand').map(v => v.condition);
      if (toClear.length > 0) await Pokemon.updateOne({ _id: poke._id }, { $pull: { volatileStatus: { condition: { $in: toClear } } } });
    }

    // Wide Guard/Quick Guard are single-round side effects, same lifetime as the
    // per-Pokémon Protect family cleared just above — just stored on the battle
    // itself (Battle.fieldConditions) since they apply to a whole side, not one
    // Pokémon. Room effects (Trick Room/Magic Room/Wonder Room) are also stored
    // there but are multi-turn — decrement and expire with a message, same pattern
    // as the per-Pokémon "bound" countdown.
    if ((battle.fieldConditions ?? []).length > 0) {
      const remaining: typeof battle.fieldConditions = [];
      for (const fc of battle.fieldConditions) {
        if (fc.condition.startsWith('wide-guard:') || fc.condition.startsWith('quick-guard:')) continue;
        if (ROOM_MOVES.has(fc.condition)) {
          const turnsLeft = fc.turnsRemaining - 1;
          if (turnsLeft <= 0) { allEvents.push(ROOM_MESSAGES[fc.condition].end); continue; }
          remaining.push({ condition: fc.condition, turnsRemaining: turnsLeft });
          continue;
        }
        // Screens + Mist/Safeguard (milestone 5.14 Wave 6) — 5-turn side effects,
        // same decrement-and-expire shape as Room effects above.
        const [screenMoveId] = fc.condition.split(':');
        if (SCREEN_MOVES.has(screenMoveId) || screenMoveId === 'mist' || screenMoveId === 'safeguard') {
          const turnsLeft = fc.turnsRemaining - 1;
          if (turnsLeft <= 0) { allEvents.push(`${slugToDisplayName(screenMoveId)} wore off!`); continue; }
          remaining.push({ condition: fc.condition, turnsRemaining: turnsLeft });
          continue;
        }
        remaining.push(fc);
      }
      battle.fieldConditions = remaining;
      battle.markModified('fieldConditions');
    }

    // Future Sight / Doom Desire (milestone 5.14 Wave 9) — resolves using the
    // ATTACKER's snapshotted stats against whoever currently occupies the targeted
    // slot (fresh live fetch; may not be the originally-targeted Pokémon if it's
    // since switched out).
    if ((battle.pendingAttacks ?? []).length > 0) {
      const stillPending: PendingAttack[] = [];
      for (const pa of battle.pendingAttacks) {
        const turnsLeft = pa.turnsRemaining - 1;
        if (turnsLeft > 0) { stillPending.push({ ...pa, turnsRemaining: turnsLeft }); continue; }

        const slotEntry = battle[pa.targetSide][pa.targetSlotIndex] as (PlayerSideEntry | EnemySideEntry | undefined);
        const targetId  = slotEntry?.activePokemonId;
        const tgt       = targetId ? await Pokemon.findById(targetId).lean() : null;
        const tgtCurHp  = tgt ? (runningHp.get(targetId!.toString()) ?? tgt.currentHp) : 0;
        if (!tgt || tgtCurHp <= 0) {
          allEvents.push(`${pa.attackerName}'s ${slugToDisplayName(pa.moveId)} found no target!`);
          continue;
        }
        const tgtCache = await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name baseStats types abilities').lean();
        if (!tgtCache?.baseStats) { continue; }
        const tgtName = pokeDisplayName(tgt, tgtCache);
        const tgtAbilitySlugs = getEffectiveAbilitySlugs(battle, targetId!.toString(), (tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean);
        const tgtIvs = await getIvsForOwner(tgt.ownerId, tgt.ownerType);

        try {
          const atkCache = await PokedexCache.findOne({ pokeApiId: pa.attackerSpeciesId }, 'name').lean();
          const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName((atkCache?.name as string) ?? 'unknown'), {
            level: pa.attackerLevel, nature: cap(pa.attackerNature) as any,
            evs: toCalcEvs(pa.attackerEvs as unknown as BaseStats), ivs: toCalcIvs(pa.attackerIvs as unknown as BaseStats),
            ability: pa.attackerAbilitySlug ? (slugToDisplayName(pa.attackerAbilitySlug) as any) : undefined,
            item: toCalcItem(pa.attackerHeldItem) as any,
          });
          const calcTarget = new CalcPokemon(GEN9, slugToDisplayName(tgtCache.name as string), {
            level: tgt.level, nature: cap(tgt.nature) as any, evs: toCalcEvs(tgt.evs as BaseStats), ivs: toCalcIvs(tgtIvs),
            curHP: tgtCurHp, status: toCalcStatus(tgt.statusCondition) as any,
            ability: tgtAbilitySlugs[0] ? (slugToDisplayName(tgtAbilitySlugs[0]) as any) : undefined,
            item: toCalcItem(tgt.heldItem as string | null) as any,
          });
          const result = calculate(GEN9, calcAttacker, calcTarget, new CalcMove(GEN9, slugToDisplayName(pa.moveId)), new Field({}));
          const rolls  = Array.isArray(result.damage) ? result.damage : [result.damage];
          const picked = rolls[Math.floor(Math.random() * rolls.length)];
          const damage = Array.isArray(picked) ? picked[Math.floor(Math.random() * picked.length)] : (picked as number);
          const newHp  = Math.max(0, tgtCurHp - damage);
          runningHp.set(targetId!.toString(), newHp);
          await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newHp } });
          allEvents.push(`${tgtName} was hit by ${pa.attackerName}'s ${slugToDisplayName(pa.moveId)}! (${damage} damage)`);
        } catch {
          allEvents.push(`${pa.attackerName}'s ${slugToDisplayName(pa.moveId)} fizzled!`);
        }
      }
      battle.pendingAttacks = stillPending;
      battle.markModified('pendingAttacks');
    }

    // Counter/Mirror Coat/Metal Burst only care about damage taken THIS round —
    // wipe it every round so a Pokémon can't retaliate against a hit from two rounds ago.
    if (Object.keys(battle.damageTakenThisTurn ?? {}).length > 0) {
      battle.damageTakenThisTurn = {};
      battle.markModified('damageTakenThisTurn');
    }

    const stageMap = battle.statStages as Record<string, StatStages>;
    for (const poke of activePokemons) {
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const abilitySlugs = getEffectiveAbilitySlugs(battle, poke._id.toString(), (cache.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
      if (abilitySlugs.length === 0) continue;
      const pokeName = pokeDisplayName(poke, cache);
      const maxHp    = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp;

      // Every active ability's end-of-round tick fires independently (not an if/elseif
      // chain) — a Pokémon with two ticking abilities gets both effects the same round.
      if (abilitySlugs.includes('speed-boost')) { allEvents.push(...applyStatStageEffects(stageMap, poke._id.toString(), [{ stat: 'spe', stages: 1, target: 'self' }], pokeName, abilitySlugs)); battle.markModified('statStages'); }
      if (abilitySlugs.includes('rain-dish') && battle.weather === 'rain')   { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Rain Dish`, allEvents); }
      if (abilitySlugs.includes('ice-body')  && (battle.weather === 'hail' || battle.weather === 'snow')) { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Ice Body`, allEvents); }
      if (abilitySlugs.includes('dry-skin')) {
        const curHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        if (battle.weather === 'rain') { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Dry Skin`, allEvents); }
        else if (battle.weather === 'sun') { const dmg = Math.max(1,Math.floor(maxHp/8)); const newHp = Math.max(0,curHp-dmg); runningHp.set(poke._id.toString(),newHp); await Pokemon.updateOne({_id:poke._id},{$set:{currentHp:newHp}}); allEvents.push(`${pokeName}'s Dry Skin is seared by the sun! (${dmg} damage, ${newHp} HP remaining)`); }
      }
      if (abilitySlugs.includes('moody')) {
        const allStats: (keyof StatStages)[] = ['atk','def','spa','spd','spe','acc','eva'];
        const boostStat = allStats[Math.floor(Math.random()*allStats.length)];
        const dropStat  = allStats.filter(s=>s!==boostStat)[Math.floor(Math.random()*(allStats.length-1))];
        const evts = [...applyStatStageEffects(stageMap,poke._id.toString(),[{stat:boostStat,stages:2,target:'self'}],pokeName,abilitySlugs),...applyStatStageEffects(stageMap,poke._id.toString(),[{stat:dropStat,stages:-1,target:'self'}],pokeName,abilitySlugs)];
        if (evts.length) { allEvents.push(`${pokeName}'s Moody!`); allEvents.push(...evts); battle.markModified('statStages'); }
      }
      if (abilitySlugs.includes('shed-skin') && poke.statusCondition) {
        if (Math.random() < 1/3) { await Pokemon.updateOne({_id:poke._id},{$set:{statusCondition:null,statusCounter:null}}); allEvents.push(`${pokeName}'s Shed Skin! ${pokeName} shed its skin and cured its status!`); }
      }
    }

    // Leftovers / Black Sludge (milestone 5.17b) — held-item end-of-round effects,
    // same 1/16 maxHp fraction as Leftovers has always had; Black Sludge heals a
    // Poison-type holder identically but damages anyone else instead. Deliberately
    // a separate loop from the ability loop above rather than folded into it — that
    // loop early-continues when a Pokémon has no active ability at all, which would
    // wrongly skip an item-only holder.
    for (const poke of activePokemons) {
      if (!poke.heldItem || (poke.heldItem !== 'leftovers' && poke.heldItem !== 'black-sludge')) continue;
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const pokeName = pokeDisplayName(poke, cache);
      const maxHp    = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp;

      if (poke.heldItem === 'leftovers') {
        await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Leftovers`, allEvents);
      } else if (((cache.types as string[]) ?? []).includes('poison')) {
        await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Black Sludge`, allEvents);
      } else {
        const curHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const dmg   = Math.max(1, Math.floor(maxHp / 8));
        const newHp = Math.max(0, curHp - dmg);
        runningHp.set(poke._id.toString(), newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeName} is hurt by its Black Sludge! (${dmg} damage, ${newHp} HP remaining)`);
      }
    }

    const playerActiveIds = new Set(battle.playerSide.map(e => e.activePokemonId?.toString()).filter(Boolean));
    const enemyActiveIds  = new Set(battle.enemySide.map(e => e.activePokemonId?.toString()).filter(Boolean));

    for (const poke of activePokemons) {
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const maxHp   = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp;
      const pokeName = pokeDisplayName(poke, cache);
      const pokeId   = poke._id.toString();
      const volStatus = (poke.volatileStatus as Array<{ condition: string; turnsRemaining: number }>) ?? [];

      if (volStatus.some(v => v.condition === 'ingrain'))    { await applyFractionHeal(pokeId, poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Ingrain`,    allEvents); }
      if (volStatus.some(v => v.condition === 'aqua-ring'))  { await applyFractionHeal(pokeId, poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Aqua Ring`,  allEvents); }

      if (volStatus.some(v => v.condition === 'leech-seed')) {
        const curHp = runningHp.get(pokeId) ?? poke.currentHp;
        if (curHp <= 0) continue;
        const drain = Math.max(1, Math.floor(maxHp / 8));
        const newHp = Math.max(0, curHp - drain);
        runningHp.set(pokeId, newHp); await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeName} had its energy drained by Leech Seed! (${drain} damage)`);
        const opposingIds = playerActiveIds.has(pokeId) ? enemyActiveIds : playerActiveIds;
        const recipientId = [...opposingIds].find(id => id && (runningHp.get(id) ?? 0) > 0);
        if (recipientId) {
          const recipient = activePokemons.find(p => p._id.toString() === recipientId);
          const rCache    = recipient ? cacheMap.get(recipient.speciesId) : null;
          if (recipient && rCache) {
            const rMaxHp  = computeStats(rCache.baseStats as BaseStats, recipient.level, recipient.nature, recipient.evs as BaseStats, pokeIvs(recipient)).hp;
            const rCurHp  = runningHp.get(recipientId) ?? recipient.currentHp;
            const restore = Math.min(drain, rMaxHp - rCurHp);
            if (restore > 0) { const rNewHp = rCurHp + restore; runningHp.set(recipientId, rNewHp); await Pokemon.updateOne({ _id: recipient._id }, { $set: { currentHp: rNewHp } }); allEvents.push(`${pokeDisplayName(recipient, rCache)} absorbed the drained energy! (+${restore} HP)`); }
          }
        }
      }

      if (volStatus.some(v => v.condition === 'cursed')) {
        const curHp  = runningHp.get(pokeId) ?? poke.currentHp;
        const damage = Math.max(1, Math.floor(maxHp / 4));
        const newHp  = Math.max(0, curHp - damage);
        runningHp.set(pokeId, newHp); await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeName} is afflicted by the curse! (${damage} damage, ${newHp} HP remaining)`);
      }

      const boundEntry = volStatus.find(v => v.condition.startsWith('bound:'));
      if (boundEntry) {
        const curHp = runningHp.get(pokeId) ?? poke.currentHp;
        const trapMoveId = boundEntry.condition.split(':')[1];
        // Mean Look/Block/Spider Web (milestone 5.14 Wave 8) share the exact same
        // bound:<moveId>:<sourceId> volatile as the real binding moves (same switch-
        // block check, same release-when-source-leaves via releaseBoundTargets) — but
        // deal no chip damage and never expire on a turn counter, only when the user
        // who trapped them leaves the field. Cast with turnsRemaining:99, same
        // "persists until explicitly cleared" sentinel as focus-energy/ingrain.
        if (curHp > 0 && !NO_DAMAGE_TRAP_MOVES.has(trapMoveId)) {
          const damage = Math.max(1, Math.floor(maxHp / 8));
          const newHp  = Math.max(0, curHp - damage);
          runningHp.set(pokeId, newHp); await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
          allEvents.push(`${pokeName} is hurt by ${slugToDisplayName(trapMoveId)}! (${damage} damage, ${newHp} HP remaining)`);

          const turnsLeft = (boundEntry.turnsRemaining ?? 1) - 1;
          if (turnsLeft <= 0) {
            await Pokemon.updateOne({ _id: poke._id }, { $pull: { volatileStatus: { condition: boundEntry.condition } } });
            allEvents.push(`${pokeName} was freed from the bind!`);
          } else {
            await Pokemon.updateOne(
              { _id: poke._id, 'volatileStatus.condition': boundEntry.condition },
              { $set: { 'volatileStatus.$.turnsRemaining': turnsLeft } },
            );
          }
        }
      }

      // Perish Song (milestone 5.14 Wave 8) — hits 0 by fainting outright, picked up
      // by this same function's own applyFaints call right after this loop.
      const perishEntry = volStatus.find(v => v.condition === 'perish-song');
      if (perishEntry) {
        const curHp = runningHp.get(pokeId) ?? poke.currentHp;
        if (curHp > 0) {
          const turnsLeft = perishEntry.turnsRemaining - 1;
          if (turnsLeft <= 0) {
            runningHp.set(pokeId, 0);
            await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: 0 }, $pull: { volatileStatus: { condition: 'perish-song' } } });
            allEvents.push(`${pokeName}'s perish count fell to 0!`);
          } else {
            await Pokemon.updateOne(
              { _id: poke._id, 'volatileStatus.condition': 'perish-song' },
              { $set: { 'volatileStatus.$.turnsRemaining': turnsLeft } },
            );
            allEvents.push(`${pokeName}'s perish count fell to ${turnsLeft}!`);
          }
        }
      }
    }

    appendToLog(battle, ...allEvents);
  }

  if (battle.weatherTurnsRemaining !== null) {
    const WEATHER_END: Record<string, string> = { rain: 'The rain stopped.', sun: 'The harsh sunlight faded.', sandstorm: 'The sandstorm subsided.', hail: 'The hail stopped.', snow: 'The snow stopped.' };
    const newTurns = battle.weatherTurnsRemaining - 1;
    if (newTurns <= 0) { appendToLog(battle, battle.weather ? WEATHER_END[battle.weather] : 'The weather cleared.'); battle.weather = null; battle.weatherTurnsRemaining = null; }
    else { battle.weatherTurnsRemaining = newTurns; }
  }

  const eorFaintEvents = await applyFaints(battle);
  const eorEndEvents   = await checkBattleEnd(battle);
  appendToLog(battle, ...eorFaintEvents, ...eorEndEvents);
  if (battle.status === 'active') battle.phase = 'end_of_round';
}

export async function checkAndAdvance(battle: HydratedDocument<IBattle>): Promise<void> {
  if (battle.playerSide.some(e => e.activePokemonId == null)) return;
  // In pvp, enemySide entries are real trainers too — they must send out just like playerSide.
  if (battle.type === 'pvp' && battle.enemySide.some(e => e.activePokemonId == null)) return;

  const playerActors = battle.playerSide;
  const npcActors    = battle.type === 'pvp' ? battle.enemySide : battle.enemySide.filter(e => e.activePokemonId != null);
  const totalActors  = playerActors.length + npcActors.length;
  if (totalActors === 0 || battle.turnQueue.length < totalActors) return;

  const pokemonIds = battle.turnQueue.map(e => e.activePokemonId);
  const pokemons   = await Pokemon.find({ _id: { $in: pokemonIds } }, 'ownerId ownerType speciesId level nature statusCondition hasHiddenAbility evs heldItem').lean();
  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats abilities').lean();
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const pokemonMap = new Map(pokemons.map(p => [p._id.toString(), p]));

  // Batch the owners' Trainer IV spreads once per call rather than per Pokémon —
  // this is turn-order speed, so a player who chose Speed needs this wired for
  // the feature to matter in battle.
  const playerOwnerIds = [...new Set(pokemons.filter(p => p.ownerType === 'player').map(p => (p.ownerId as mongoose.Types.ObjectId).toString()))];
  const ivOwners = playerOwnerIds.length > 0 ? await User.find({ _id: { $in: playerOwnerIds } }, 'trainerStats').lean() : [];
  const ivsMap   = new Map(ivOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));
  const pokeIvs  = (poke: { ownerId: mongoose.Types.ObjectId; ownerType: string }): BaseStats =>
    poke.ownerType === 'player' ? (ivsMap.get(poke.ownerId.toString()) ?? ZERO_IVS) : ZERO_IVS;

  const withSpeed = battle.turnQueue.map(entry => {
    const poke  = pokemonMap.get(entry.activePokemonId.toString());
    const cache = poke ? cacheMap.get(poke.speciesId) : null;
    const abilitySlugs = poke && cache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (cache.abilities as CachedAbility[]) ?? [], (poke.hasHiddenAbility as boolean) ?? false) : [];
    const rawSpeed = poke && cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).speed : 0;
    const afterParalysis = poke?.statusCondition === 'paralysis' ? Math.floor(rawSpeed * 0.5) : rawSpeed;
    const weatherMatches = abilitySlugs.some(s => (WEATHER_SPEED_DOUBLERS[s] ?? []).includes(battle.weather ?? ''));
    const afterWeather = weatherMatches ? afterParalysis * 2 : afterParalysis;
    // Choice Scarf (milestone 5.17b) — 1.5x Speed for turn-order purposes only;
    // this never touches @smogon/calc, which doesn't use Speed in its damage
    // formula at all. Stacks with a weather-doubling ability, same as the real games.
    const speed = poke?.heldItem === 'choice-scarf' ? Math.floor(afterWeather * 1.5) : afterWeather;
    const pranksterBonus = abilitySlugs.includes('prankster') && PRANKSTER_MOVES.has(entry.moveId ?? '') ? 1 : 0;
    const movePriority   = (MOVE_PRIORITY[entry.moveId ?? ''] ?? 0) + pranksterBonus;
    return { entry, speed, movePriority };
  });

  // Trick Room only reverses the final speed tiebreak within a priority bracket —
  // item/switch-vs-move and priority-move ordering are unaffected, same as the real games.
  const trickRoomActive = (battle.fieldConditions ?? []).some(f => f.condition === 'trick-room');

  const actionPriority = (t: string) => (t === 'item' || t === 'catch' ? 2 : t === 'switch' ? 1 : 0);
  withSpeed.sort((a, b) => {
    const actionDiff = actionPriority(b.entry.actionType) - actionPriority(a.entry.actionType);
    if (actionDiff !== 0) return actionDiff;
    const movePriorityDiff = b.movePriority - a.movePriority;
    if (movePriorityDiff !== 0) return movePriorityDiff;
    return trickRoomActive ? a.speed - b.speed : b.speed - a.speed;
  });

  battle.set('turnQueue', withSpeed.map(x => x.entry));
  battle.phase              = 'targeting';
  battle.currentTargetIndex = 0;
  await autoSkipBlockedActors(battle);
}

type ActiveEntry = {
  moveId:          string;
  activePokemonId: mongoose.Types.ObjectId;
  actorType:       'player' | 'npc';
};

// Looks up a single cached move's type + accuracy for one species without loading the full moves array.
type MoveMeta = { type: string; accuracy: number | null; target?: string };
async function fetchMoveMeta(speciesId: number, moveId: string): Promise<MoveMeta | undefined> {
  const doc = await PokedexCache.findOne({ pokeApiId: speciesId, 'moves.name': moveId }, { 'moves.$': 1 }).lean();
  return (doc?.moves as MoveMeta[] | undefined)?.[0];
}

async function resolveWeatherMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry,
  weatherEffect: { weather: IBattle['weather']; startMessage: string }, moveEvents: string[],
): Promise<void> {
  const { poke: attacker, name: attackerName } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
  const moveName     = slugToDisplayName(entry.moveId);

  const moveMeta = attacker ? await fetchMoveMeta(attacker.speciesId, entry.moveId) : undefined;
  if (moveMeta?.accuracy != null && Math.random() >= moveMeta.accuracy / 100) {
    moveEvents.push(`${attackerName} used ${moveName}, but it failed!`);
    return;
  }

  if (battle.weather === weatherEffect.weather) {
    moveEvents.push(`${attackerName} used ${moveName}! But it had no effect...`);
  } else if (battle.weather) {
    battle.weather = null; battle.weatherTurnsRemaining = null;
    moveEvents.push(`${attackerName} used ${moveName}! The weather cleared!`);
  } else {
    battle.weather = weatherEffect.weather; battle.weatherTurnsRemaining = 5;
    moveEvents.push(`${attackerName} used ${moveName}! ${weatherEffect.startMessage}`);
  }
}

async function resolveSelfTargetMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry, moveEvents: string[],
): Promise<void> {
  const { poke: attacker, cache: atkCache, name: attackerName } = await fetchDisplay(entry.activePokemonId, 'ownerId ownerType nickname speciesId currentHp nature level volatileStatus hasHiddenAbility evs moves heldItem consumedHeldItem', 'name baseStats abilities types');
  const attackerIvs = attacker ? await getIvsForOwner(attacker.ownerId, attacker.ownerType) : ZERO_IVS;

  const moveMeta = attacker ? await fetchMoveMeta(attacker.speciesId, entry.moveId) : undefined;
  if (moveMeta?.accuracy != null && Math.random() >= moveMeta.accuracy / 100) {
    moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
    return;
  }

  let applyEffects = true;
  if (CHARGE_MOVES.has(entry.moveId) && attacker) {
    const chargeCondition = `charging-${entry.moveId}`;
    const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
    const isCharging  = volStatus.some(v => v.condition === chargeCondition);
    const skipCharge  = entry.moveId === 'solar-beam' && battle.weather === 'sun';
    const semiInvul   = SEMI_INVULNERABLE_MOVES.has(entry.moveId);

    if (!isCharging && !skipCharge) {
      const volatilesToPush = [{ condition: chargeCondition, turnsRemaining: 99 }];
      if (semiInvul) volatilesToPush.push({ condition: 'semi-invulnerable', turnsRemaining: 99 });
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { $each: volatilesToPush } } });
      moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}! ${attackerName} ${CHARGE_MESSAGES[entry.moveId]}`);
      applyEffects = false;
    } else if (isCharging) {
      const conditionsToPull: string[] = [chargeCondition];
      if (semiInvul) conditionsToPull.push('semi-invulnerable');
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $pull: { volatileStatus: { condition: { $in: conditionsToPull } } } });
    }
  }

  if (applyEffects) {
    moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}!`);

    const statEffects = STAT_STAGE_MOVES[entry.moveId];
    if (statEffects) {
      const selfEffects = statEffects.filter(e => e.target === 'self');
      if (selfEffects.length > 0) {
        const stageMap       = battle.statStages as Record<string, StatStages>;
        const atkAbilitySlugs = attacker && atkCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (atkCache.abilities as CachedAbility[]) ?? [], attacker.hasHiddenAbility as boolean) : [];
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), selfEffects, attackerName, atkAbilitySlugs));
        battle.markModified('statStages');
      }
    }

    const recoveryEffect = RECOVERY_MOVES[entry.moveId];
    if (recoveryEffect && attacker && atkCache?.baseStats) {
      const maxHp     = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature, attacker.evs as BaseStats, attackerIvs).hp;
      const currentHp = attacker.currentHp as number;
      if (recoveryEffect.type === 'rest') {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: maxHp, statusCondition: 'sleep', statusCounter: 2 } });
        moveEvents.push(`${attackerName} went to sleep and fully restored its HP!`);
      } else if (currentHp >= maxHp) {
        moveEvents.push(`${attackerName}'s HP is full!`);
      } else {
        const fraction = recoveryEffect.type === 'flat' ? recoveryEffect.fraction : battle.weather === 'sun' ? 2/3 : !battle.weather ? 0.5 : 0.25;
        const newHp    = Math.min(maxHp, currentHp + Math.floor(maxHp * fraction));
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } });
        moveEvents.push(`${attackerName} restored ${newHp - currentHp} HP!`);
        if (entry.moveId === 'roost') {
          await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'roosting', turnsRemaining: 0 } } });
        }
      }
    }

    if (entry.moveId === 'focus-energy' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'focus-energy')) {
        moveEvents.push(`${attackerName} is already focusing!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'focus-energy', turnsRemaining: 99 } } });
        moveEvents.push(`${attackerName} is getting pumped!`);
      }
    }

    if (entry.moveId === 'endure' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'enduring')) {
        moveEvents.push(`${attackerName} is already braced!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'enduring', turnsRemaining: 0 } } });
        moveEvents.push(`${attackerName} braced itself!`);
      }
    }

    if (entry.moveId === 'belly-drum' && attacker && atkCache?.baseStats) {
      const maxHp  = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature, attacker.evs as BaseStats, attackerIvs).hp;
      const curHp  = attacker.currentHp as number;
      const costHp = Math.floor(maxHp / 2);
      if (curHp <= costHp) {
        moveEvents.push(`${attackerName} doesn't have enough HP!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: curHp - costHp } });
        const stageMap = battle.statStages as Record<string, StatStages>;
        const atkId    = entry.activePokemonId.toString();
        if (!stageMap[atkId]) stageMap[atkId] = {} as StatStages;
        stageMap[atkId].atk = 6;
        battle.markModified('statStages');
        moveEvents.push(`${attackerName} cut its own HP and maximized its Attack!`);
      }
    }

    if (entry.moveId === 'fillet-away' && attacker && atkCache?.baseStats) {
      const maxHp  = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature, attacker.evs as BaseStats, attackerIvs).hp;
      const curHp  = attacker.currentHp as number;
      const costHp = Math.floor(maxHp / 2);
      if (curHp <= costHp) {
        moveEvents.push(`${attackerName} doesn't have enough HP!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: curHp - costHp } });
        const stageMap = battle.statStages as Record<string, StatStages>;
        const atkAbilitySlugs = atkCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (atkCache.abilities as CachedAbility[]) ?? [], attacker.hasHiddenAbility as boolean) : [];
        moveEvents.push(...applyStatStageEffects(
          stageMap, entry.activePokemonId.toString(),
          [{ stat: 'atk', stages: 2, target: 'self' }, { stat: 'spa', stages: 2, target: 'self' }, { stat: 'spe', stages: 2, target: 'self' }],
          attackerName, atkAbilitySlugs,
        ));
        battle.markModified('statStages');
        moveEvents.push(`${attackerName} cut its own HP and boosted its stats!`);
      }
    }

    if (entry.moveId === 'substitute' && attacker && atkCache?.baseStats) {
      // The substitute's own remaining HP is encoded in the volatile condition string
      // (substitute:<hp>), same convention as bound:/infatuated: — rewritten in place by
      // resolveDamagingMove's substitute-absorption check whenever it takes a hit.
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition.startsWith('substitute:'))) {
        moveEvents.push(`${attackerName} already has a substitute!`);
      } else {
        const maxHp  = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature, attacker.evs as BaseStats, attackerIvs).hp;
        const curHp  = attacker.currentHp as number;
        const costHp = Math.max(1, Math.floor(maxHp / 4));
        if (curHp <= costHp) {
          moveEvents.push(`${attackerName} doesn't have enough HP to make a substitute!`);
        } else {
          await Pokemon.updateOne(
            { _id: entry.activePokemonId },
            { $set: { currentHp: curHp - costHp }, $push: { volatileStatus: { condition: `substitute:${costHp}`, turnsRemaining: 99 } } },
          );
          moveEvents.push(`${attackerName} put in a substitute!`);
        }
      }
    }

    if (entry.moveId === 'ingrain' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'ingrain')) { moveEvents.push(`${attackerName} is already rooted!`); }
      else { await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'ingrain', turnsRemaining: 99 } } }); moveEvents.push(`${attackerName} planted its roots!`); }
    }

    if (entry.moveId === 'aqua-ring' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'aqua-ring')) { moveEvents.push(`${attackerName} is already surrounded by water!`); }
      else { await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'aqua-ring', turnsRemaining: 99 } } }); moveEvents.push(`${attackerName} surrounded itself with a veil of water!`); }
    }

    const protectVolatile = PROTECT_VOLATILE[entry.moveId];
    if (protectVolatile && attacker) {
      const vol = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (vol.some(v => v.condition.startsWith('protecting'))) { moveEvents.push(`${attackerName} can't protect itself!`); }
      else { await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: protectVolatile, turnsRemaining: 0 } } }); moveEvents.push(`${attackerName} protected itself!`); }
    }

    if ((entry.moveId === 'wide-guard' || entry.moveId === 'quick-guard')) {
      const side = resolveActingSide(battle, entry.activePokemonId);
      if (side) {
        const condition = `${entry.moveId}:${side}`;
        const alreadyGuarded = (battle.fieldConditions ?? []).some(f => f.condition === condition);
        if (alreadyGuarded) {
          moveEvents.push(`${attackerName}'s side is already protected!`);
        } else {
          battle.fieldConditions.push({ condition, turnsRemaining: 0 });
          battle.markModified('fieldConditions');
          const flavor = entry.moveId === 'wide-guard' ? 'a barrage of attacks' : 'a sneak attack';
          moveEvents.push(`${attackerName}'s side braced itself against ${flavor}!`);
        }
      }
    }

    if (SCREEN_MOVES.has(entry.moveId) || entry.moveId === 'mist' || entry.moveId === 'safeguard') {
      const side = resolveActingSide(battle, entry.activePokemonId);
      if (side) {
        const condition = `${entry.moveId}:${side}`;
        const already = (battle.fieldConditions ?? []).some(f => f.condition === condition);
        if (already) {
          moveEvents.push(`${attackerName}'s side is already protected!`);
        } else {
          battle.fieldConditions.push({ condition, turnsRemaining: 5 });
          battle.markModified('fieldConditions');
          const flavor = SCREEN_MESSAGES[entry.moveId] ?? (entry.moveId === 'mist' ? MIST_MESSAGE : SAFEGUARD_MESSAGE);
          moveEvents.push(`${attackerName}'s side ${flavor}`);
        }
      }
    }

    if (ENTRY_HAZARD_MOVES.has(entry.moveId)) {
      // Unlike every other side-condition move here, hazards land on the OPPONENT's
      // side (they hurt whoever switches in over there), not the caster's own side.
      const casterSide = resolveActingSide(battle, entry.activePokemonId);
      const side = casterSide === 'playerSide' ? 'enemySide' : casterSide === 'enemySide' ? 'playerSide' : null;
      if (side) {
        const stackCap = STACKABLE_HAZARDS[entry.moveId];
        if (stackCap) {
          const existing = (battle.fieldConditions ?? []).find(f => f.condition.startsWith(`${entry.moveId}:${side}:`));
          const currentLayers = existing ? Number(existing.condition.split(':')[2]) || 0 : 0;
          if (currentLayers >= stackCap) {
            moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
          } else {
            battle.fieldConditions = (battle.fieldConditions ?? []).filter(f => f !== existing);
            battle.fieldConditions.push({ condition: `${entry.moveId}:${side}:${currentLayers + 1}`, turnsRemaining: 0 });
            battle.markModified('fieldConditions');
            moveEvents.push(`${attackerName} scattered ${slugToDisplayName(entry.moveId)} around the opposing side!`);
          }
        } else {
          const condition = `${entry.moveId}:${side}`;
          const already = (battle.fieldConditions ?? []).some(f => f.condition === condition);
          if (already) {
            moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
          } else {
            battle.fieldConditions.push({ condition, turnsRemaining: 0 });
            battle.markModified('fieldConditions');
            const flavor = entry.moveId === 'stealth-rock' ? 'floating rocks' : 'a sticky web';
            moveEvents.push(`${attackerName} scattered ${flavor} around the opposing side!`);
          }
        }
      }
    }

    if (RAPID_SPIN_HAZARD_CLEAR.has(entry.moveId)) {
      // Damaging move — this only runs the CLEAR half; Rapid Spin's own +1 Speed self-
      // boost already fires via the normal selfStatEffects path (milestone 5.13).
      const casterSide = resolveActingSide(battle, entry.activePokemonId);
      if (casterSide) {
        const before = (battle.fieldConditions ?? []).length;
        battle.fieldConditions = (battle.fieldConditions ?? []).filter(f => !isHazardCondition(f.condition, casterSide));
        if (battle.fieldConditions.length !== before) {
          battle.markModified('fieldConditions');
          moveEvents.push(`${attackerName}'s side was cleared of hazards!`);
        }
      }
    }

    if (BOTH_SIDES_HAZARD_CLEAR.has(entry.moveId) && SELF_TARGETING_MOVES.has(entry.moveId)) {
      // Tidy Up only (Defog's clear is handled in the foe-effect path below, since
      // Defog targets a foe and needs that target resolved first).
      const before = (battle.fieldConditions ?? []).length;
      battle.fieldConditions = (battle.fieldConditions ?? []).filter(f => !isHazardCondition(f.condition, 'playerSide') && !isHazardCondition(f.condition, 'enemySide'));
      if (battle.fieldConditions.length !== before) {
        battle.markModified('fieldConditions');
        moveEvents.push('All hazards were cleared from the field!');
      }
    }

    if (entry.moveId === 'perish-song') {
      const allActivePokemonIds = [
        ...battle.playerSide.map(e => e.activePokemonId),
        ...battle.enemySide.map(e => e.activePokemonId),
      ].filter((id): id is mongoose.Types.ObjectId => id != null);
      let affectedAny = false;
      for (const id of allActivePokemonIds) {
        const target = await Pokemon.findById(id, 'volatileStatus currentHp').lean();
        if (!target || target.currentHp <= 0) continue;
        const already = ((target.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'perish-song');
        if (already) continue;
        await Pokemon.updateOne({ _id: id }, { $push: { volatileStatus: { condition: 'perish-song', turnsRemaining: PERISH_SONG_TURNS } } });
        affectedAny = true;
      }
      // No "${attackerName} used Perish Song!" line here — the self-targeting branch
      // this code lives in already pushes that generic line unconditionally before
      // dispatching to any move-specific handler (confirmed live: without this
      // comment/fix it printed twice).
      moveEvents.push(affectedAny
        ? `All Pokémon that heard the song will faint in ${PERISH_SONG_TURNS} turns!`
        : 'But nobody was affected!');
    }

    if (HEALING_WISH_MOVES.has(entry.moveId)) {
      const side = resolveActingSide(battle, entry.activePokemonId);
      if (side) {
        const slotIndex = battle[side].findIndex(e => e.activePokemonId?.toString() === entry.activePokemonId.toString());
        if (slotIndex !== -1) {
          const wish: PendingWish = { targetSide: side, targetSlotIndex: slotIndex, restorePP: entry.moveId === 'lunar-dance' };
          battle.pendingWishes.push(wish);
          battle.markModified('pendingWishes');
        }
      }
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: 0 } });
      moveEvents.push(`${attackerName}'s wish will be granted to whoever takes its place!`);
    }

    if (ROOM_MOVES.has(entry.moveId)) {
      const already = (battle.fieldConditions ?? []).some(f => f.condition === entry.moveId);
      const messages = ROOM_MESSAGES[entry.moveId];
      if (already) {
        battle.fieldConditions = battle.fieldConditions.filter(f => f.condition !== entry.moveId);
        battle.markModified('fieldConditions');
        moveEvents.push(messages.end);
      } else {
        battle.fieldConditions.push({ condition: entry.moveId, turnsRemaining: 5 });
        battle.markModified('fieldConditions');
        moveEvents.push(`${attackerName} ${messages.start}`);
      }
    }

    const redirectVolatile = REDIRECT_MOVES.has(entry.moveId) ? entry.moveId : null;
    if (redirectVolatile && attacker) {
      const vol = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (vol.some(v => v.condition === 'follow-me' || v.condition === 'rage-powder')) {
        moveEvents.push(`${attackerName} is already drawing attention!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: redirectVolatile, turnsRemaining: 0 } } });
        moveEvents.push(`${attackerName} became the center of attention!`);
      }
    }

    // Self type-change moves (milestone 5.14 Wave 11) — all three write directly to
    // Battle.typeOverride via getEffectiveTypes' backing map, keyed by pokemonId.
    if (entry.moveId === 'conversion' && attacker) {
      const firstMove = (attacker.moves as Array<{ moveId: string }> | undefined)?.[0];
      const firstMoveMeta = firstMove ? await fetchMoveMeta(attacker.speciesId, firstMove.moveId) : undefined;
      const newType = firstMoveMeta?.type?.toLowerCase();
      if (!newType) {
        moveEvents.push(`${attackerName} used Conversion, but it failed!`);
      } else {
        (battle.typeOverride as Record<string, string[]>)[entry.activePokemonId.toString()] = [newType];
        battle.markModified('typeOverride');
        moveEvents.push(`${attackerName} transformed into the ${slugToDisplayName(newType)} type!`);
      }
    }

    if (entry.moveId === 'camouflage') {
      // This project has no terrain/location system — Camouflage always resolves to
      // its real "no special terrain" outcome, pure Normal type.
      (battle.typeOverride as Record<string, string[]>)[entry.activePokemonId.toString()] = ['normal'];
      battle.markModified('typeOverride');
      moveEvents.push(`${attackerName} transformed into the Normal type!`);
    }

    if (entry.moveId === 'conversion-2') {
      const lastHitType = (battle.lastHitMoveType as Record<string, string>)[entry.activePokemonId.toString()];
      if (!lastHitType) {
        moveEvents.push(`${attackerName} used Conversion 2, but it failed!`);
      } else {
        const resistantTypes = ALL_TYPES.filter(t => getTypeEffectiveness(lastHitType, [t]) < 1);
        if (resistantTypes.length === 0) {
          moveEvents.push(`${attackerName} used Conversion 2, but it failed!`);
        } else {
          const newType = resistantTypes[Math.floor(Math.random() * resistantTypes.length)];
          (battle.typeOverride as Record<string, string[]>)[entry.activePokemonId.toString()] = [newType];
          battle.markModified('typeOverride');
          moveEvents.push(`${attackerName} transformed into the ${slugToDisplayName(newType)} type!`);
        }
      }
    }

    if (entry.moveId === 'recycle' && attacker) {
      if (attacker.heldItem || !attacker.consumedHeldItem) {
        moveEvents.push(`${attackerName} used Recycle, but it failed!`);
      } else {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { heldItem: attacker.consumedHeldItem, consumedHeldItem: null } });
        moveEvents.push(`${attackerName} recycled its ${slugToDisplayName(attacker.consumedHeldItem)}!`);
      }
    }

  }
}

// Helping Hand / Heal Pulse / Aromatic Mist — the first moves in this project that
// target an ally rather than a foe or the user. Callers (submitTarget) are
// responsible for validating the target is a legal ally/foe for the move.
async function resolveAllyTargetMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry, targetId: string, moveEvents: string[],
): Promise<void> {
  const { name: attackerName } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');

  const target = await Pokemon.findById(
    targetId, 'ownerId ownerType nickname speciesId currentHp nature level evs hasHiddenAbility volatileStatus',
  ).lean();
  const targetCache = target ? await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name baseStats abilities').lean() : null;
  const targetName  = pokeDisplayName(target, targetCache);

  if (entry.moveId === 'helping-hand') {
    const already = ((target?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'helping-hand');
    if (already) { moveEvents.push(`${attackerName} used Helping Hand, but it failed!`); return; }
    await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: 'helping-hand', turnsRemaining: 0 } } });
    moveEvents.push(`${attackerName} used Helping Hand! ${targetName}'s next move will hit harder!`);
    return;
  }

  if (entry.moveId === 'heal-pulse') {
    if (!target || !targetCache?.baseStats) { moveEvents.push(`${attackerName} used Heal Pulse, but it failed!`); return; }
    const targetIvs = await getIvsForOwner(target.ownerId, target.ownerType);
    const maxHp = computeStats(targetCache.baseStats as BaseStats, target.level, target.nature, target.evs as BaseStats, targetIvs).hp;
    if (target.currentHp >= maxHp) { moveEvents.push(`${attackerName} used Heal Pulse! ${targetName}'s HP is full!`); return; }
    const healed = Math.min(maxHp - target.currentHp, Math.floor(maxHp / 2));
    await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: target.currentHp + healed } });
    moveEvents.push(`${attackerName} used Heal Pulse! ${targetName} restored ${healed} HP!`);
    return;
  }

  if (entry.moveId === 'aromatic-mist') {
    const stageMap = battle.statStages as Record<string, StatStages>;
    const targetAbilitySlugs = target && targetCache
      ? getEffectiveAbilitySlugs(battle, targetId, (targetCache.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean)
      : [];
    moveEvents.push(`${attackerName} used Aromatic Mist!`);
    moveEvents.push(...applyStatStageEffects(stageMap, targetId, [{ stat: 'spd', stages: 1, target: 'self' }], targetName, targetAbilitySlugs));
    battle.markModified('statStages');
  }
}

async function resolveDamagingMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry, targets: string[],
  targetHpMap: Map<string, number>, enduringTargets: Set<string>,
  protectingTargets: Map<string, string | null>, moveEvents: string[],
  sideGuard: { wideGuard: boolean; quickGuard: boolean; reflect?: boolean; lightScreen?: boolean; auroraVeil?: boolean } = { wideGuard: false, quickGuard: false },
  // Keyed by pokemonId, value is the substitute's current remaining HP (absent/0 = no
  // substitute). Mutated in place as hits land so a multi-hit move sees the updated value.
  substituteTargets: Map<string, number> = new Map(),
  // Written to whenever entry.moveId is reassigned (Metronome's reroll, Copycat's
  // copy) so the caller can record the move that ACTUALLY executed for Sketch/Copycat
  // tracking, instead of the wrapper name — defaults to entry.moveId, so callers that
  // never reassign don't need to read anything special out of it.
  resolvedMoveId: { value: string } = { value: entry.moveId },
): Promise<void> {
  // Set only by the Me First block below — merged with escalatedPower (which wins if
  // somehow both apply) at the resolveMove call site further down.
  let meFirstPowerOverride: number | undefined;

  if (entry.moveId === 'metronome') {
    // Reroll BEFORE anything else reads entry.moveId, and reassign the local `entry`
    // reference (a plain object, not the live turnQueue subdocument) rather than
    // mutating it — the PP-deduction call after this function returns still needs to
    // see the original 'metronome' to decrement the right move's PP.
    const rolledMoveId = METRONOME_POOL[Math.floor(Math.random() * METRONOME_POOL.length)];
    const { poke: atkDoc, cache: atkCache } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
    moveEvents.push(`${pokeDisplayName(atkDoc, atkCache)} waggled a finger... it became ${slugToDisplayName(rolledMoveId)}!`);
    // entry is actually a live Mongoose subdocument at the call site (cast to the
    // plain ActiveEntry type) — {...entry} does NOT reliably copy its fields, since
    // they're accessor properties rather than own-enumerable data properties. Build
    // the replacement explicitly instead of spreading.
    entry = { activePokemonId: entry.activePokemonId, actorType: entry.actorType, moveId: rolledMoveId };
    resolvedMoveId.value = entry.moveId;
  }

  if (entry.moveId === 'copycat') {
    // Copies whatever move was last used by ANY Pokémon this battle (battle.globalLastMoveUsed,
    // recorded by submitTarget under the resolved moveId — so a Copycat chain, or copying a
    // Metronome roll, picks up the real move, not the wrapper name). Fails with nothing to
    // copy yet, or a self-referential/nonsensical source.
    const { name: atkName } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
    const lastMove = battle.globalLastMoveUsed;
    if (!lastMove || lastMove === 'copycat' || lastMove === 'sketch' || lastMove === 'struggle') {
      moveEvents.push(`${atkName} used Copycat, but it failed!`);
      return;
    }
    moveEvents.push(`${atkName} used Copycat! It mimicked ${slugToDisplayName(lastMove)}!`);
    entry = { activePokemonId: entry.activePokemonId, actorType: entry.actorType, moveId: lastMove };
    resolvedMoveId.value = entry.moveId;
  }

  if (entry.moveId === 'me-first') {
    // Steals the target's already-queued-but-unresolved move for this round and uses it
    // immediately at 1.5x power — the target's own turn later this round is untouched
    // (still resolves normally off their own PP). Single-target only, so targets[0] is
    // the one legal target picked in the targeting phase. Fails against a target who has
    // already acted (turnQueue entry resolved, or not found — e.g. a standalone wild
    // target with no queue entry to peek at), a non-move action, or a non-damaging move
    // (no cached base power) — matches the real restriction that Me First only works on
    // an opponent's about-to-be-used damaging move.
    const { name: atkName } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
    const targetId = targets[0];
    const targetQueueEntry = targetId
      ? battle.turnQueue.find(e => e.activePokemonId?.toString() === targetId && e.actionType === 'move' && !e.resolved && e.moveId)
      : undefined;
    const stolenMoveId = targetQueueEntry?.moveId ?? '';
    let stolenPower: number | undefined;
    if (stolenMoveId) {
      const anyCache = await PokedexCache.findOne({ 'moves.name': stolenMoveId }, { 'moves.$': 1 }).lean();
      stolenPower = ((anyCache?.moves as Array<{ name: string; power: number | null }> | undefined)?.[0]?.power) ?? undefined;
    }
    if (!stolenMoveId || !stolenPower) {
      moveEvents.push(`${atkName} used Me First, but it failed!`);
      return;
    }
    moveEvents.push(`${atkName} used Me First! It's about to use ${slugToDisplayName(stolenMoveId)}!`);
    meFirstPowerOverride = Math.floor(stolenPower * 1.5);
    entry = { activePokemonId: entry.activePokemonId, actorType: entry.actorType, moveId: stolenMoveId };
    resolvedMoveId.value = entry.moveId;
  }

  if (entry.moveId === 'fake-out') {
    // A live Pokémon's activePokemonId is unique across both sides, so match on that
    // directly rather than branching on actorType (which doesn't tell us the side in pvp).
    const sideEntry = battle.playerSide.find(e => e.activePokemonId?.toString() === entry.activePokemonId.toString())
      ?? battle.enemySide.find(e => e.activePokemonId?.toString() === entry.activePokemonId.toString());
    if (!sideEntry || sideEntry.activeSentOutOnTurn !== battle.turnNumber) {
      const { poke: atkDoc, cache: atkCache } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId', 'name');
      moveEvents.push(`${pokeDisplayName(atkDoc, atkCache)} used Fake Out! But it failed!`);
      return;
    }
  }

  if (entry.moveId === 'curse') {
    const { poke: atkDoc, cache: atkDocCache, name: atkName } = await fetchDisplay(entry.activePokemonId, 'ownerId ownerType nickname speciesId currentHp nature level hasHiddenAbility evs', 'name baseStats types abilities');
    moveEvents.push(`${atkName} used Curse!`);
    const isGhost = ((atkDocCache?.types as string[]) ?? []).includes('ghost');
    if (isGhost && atkDoc && atkDocCache?.baseStats) {
      const targetId = targets[0];
      if (targetId) {
        const { poke: tgtPoke, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId volatileStatus', 'name');
        if (((tgtPoke?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'cursed')) {
          moveEvents.push(`${tgtName} is already cursed!`);
        } else {
          const atkIvs = await getIvsForOwner(atkDoc.ownerId, atkDoc.ownerType);
          const maxHp  = computeStats(atkDocCache.baseStats as BaseStats, atkDoc.level, atkDoc.nature, atkDoc.evs as BaseStats, atkIvs).hp;
          const newHp  = Math.max(0, (atkDoc.currentHp as number) - Math.floor(maxHp / 2));
          await Promise.all([
            Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } }),
            Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: 'cursed', turnsRemaining: 99 } } }),
          ]);
          moveEvents.push(`${atkName} cut its own HP to curse ${tgtName}!`);
        }
      } else {
        moveEvents.push(`${atkName} used Curse, but there's no target!`);
      }
    } else {
      const stageMap2      = battle.statStages as Record<string, StatStages>;
      const abilitySlugs   = atkDoc && atkDocCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (atkDocCache.abilities as CachedAbility[]) ?? [], atkDoc.hasHiddenAbility ?? false) : [];
      const curseEffects   = (STAT_STAGE_MOVES['curse'] ?? []).filter(e => e.target === 'self');
      moveEvents.push(...applyStatStageEffects(stageMap2, entry.activePokemonId.toString(), curseEffects, atkName, abilitySlugs));
      battle.markModified('statStages');
    }
    return;
  }

  const moveEffect      = STATUS_MOVES[entry.moveId];
  const stageMap        = battle.statStages as Record<string, StatStages>;
  const recoilEffect    = RECOIL_MOVES[entry.moveId];
  const drainEffect     = DRAIN_MOVES[entry.moveId];
  const selfStatEffects = (STAT_STAGE_MOVES[entry.moveId] ?? []).filter(e => e.target === 'self');

  type AtkSnapshot = { ownerId: mongoose.Types.ObjectId; ownerType: string; currentHp: number; speciesId: number; nature: string; level: number; nickname: string | null; hasHiddenAbility?: boolean; volatileStatus?: Array<{ condition: string }>; evs: BaseStats; gender?: string | null; heldItem?: string | null; consumedHeldItem?: string | null };
  const atkSnap      = await Pokemon.findById(entry.activePokemonId, 'ownerId ownerType nickname currentHp speciesId nature level hasHiddenAbility volatileStatus evs gender heldItem consumedHeldItem').lean() as AtkSnapshot | null;
  const atkSnapCache = atkSnap ? await PokedexCache.findOne({ pokeApiId: atkSnap.speciesId }, 'name baseStats abilities').lean() : null;
  const atkIvs       = atkSnap ? await getIvsForOwner(atkSnap.ownerId, atkSnap.ownerType) : ZERO_IVS;

  // Two-turn moves (Fly, Dig, Dive, Bounce, Sky Attack, Solar Beam) that hit a foe: charge on the
  // first turn (no accuracy roll, no damage), then release on the second. Geomancy is the only
  // self-targeting member of CHARGE_MOVES and is handled entirely in resolveSelfTargetMove.
  if (CHARGE_MOVES.has(entry.moveId) && atkSnap) {
    const chargeCondition = `charging-${entry.moveId}`;
    const volStatus   = atkSnap.volatileStatus ?? [];
    const isCharging  = volStatus.some(v => v.condition === chargeCondition);
    const skipCharge  = entry.moveId === 'solar-beam' && battle.weather === 'sun';
    const semiInvul   = SEMI_INVULNERABLE_MOVES.has(entry.moveId);

    if (!isCharging && !skipCharge) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const volatilesToPush = [{ condition: chargeCondition, turnsRemaining: 99 }];
      if (semiInvul) volatilesToPush.push({ condition: 'semi-invulnerable', turnsRemaining: 99 });
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { $each: volatilesToPush } } });
      moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}! ${atkName} ${CHARGE_MESSAGES[entry.moveId]}`);
      return;
    } else if (isCharging) {
      const conditionsToPull: string[] = [chargeCondition];
      if (semiInvul) conditionsToPull.push('semi-invulnerable');
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $pull: { volatileStatus: { condition: { $in: conditionsToPull } } } });
    }
  }

  const attackerAbilitySlugs = atkSnap && atkSnapCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (atkSnapCache.abilities as CachedAbility[]) ?? [], atkSnap.hasHiddenAbility ?? false) : [];
  const sereneGrace = attackerAbilitySlugs.includes('serene-grace');

  const moveMeta = atkSnap ? await fetchMoveMeta(atkSnap.speciesId, entry.moveId) : undefined;
  const moveAccuracy = moveMeta?.accuracy ?? null;
  const moveTargetCategory = getMoveTargetCategory(moveMeta?.target ?? '');
  const moveIsPriority = (MOVE_PRIORITY[entry.moveId] ?? 0) > 0;
  const wonderRoomActive = (battle.fieldConditions ?? []).some(f => f.condition === 'wonder-room');
  const magicRoomActive  = (battle.fieldConditions ?? []).some(f => f.condition === 'magic-room');

  let typeChangeMoveType: string | null = null;
  const isTypeChanging = attackerAbilitySlugs.includes('protean') || attackerAbilitySlugs.includes('libero') || attackerAbilitySlugs.some(s => s in ILATE_MAP);
  if (isTypeChanging) {
    typeChangeMoveType = moveMeta?.type?.toLowerCase() ?? null;
  }

  // Track consecutive use of escalating-power moves (Fury Cutter, Rollout, Ice Ball).
  const consMoves = (battle.consecutiveMoves ?? {}) as Record<string, { moveId: string; count: number }>;
  const escalatingEffect = ESCALATING_POWER_MOVES[entry.moveId];
  let escalatedPower: number | undefined;
  if (escalatingEffect) {
    const prev = consMoves[entry.activePokemonId.toString()];
    const count = (prev?.moveId === entry.moveId ? prev.count : 0) + 1;
    consMoves[entry.activePokemonId.toString()] = { moveId: entry.moveId, count };
    battle.consecutiveMoves = consMoves;
    battle.markModified('consecutiveMoves');
    escalatedPower = escalatingEffect.basePower * Math.pow(2, Math.min(count, escalatingEffect.maxCount) - 1);
  } else if (consMoves[entry.activePokemonId.toString()]) {
    delete consMoves[entry.activePokemonId.toString()];
    battle.consecutiveMoves = consMoves;
    battle.markModified('consecutiveMoves');
  }

  // Fling (milestone 5.14 Wave 12) — power comes from the user's own held item, not a
  // fixed base power from PokedexCache; fails outright with no item or one with no
  // known Fling value. The item is thrown regardless of whether the hit lands (matches
  // the real games), so it's consumed here, once, before the target loop.
  let flingPowerOverride: number | undefined;
  let flingItemUsed: string | undefined;
  if (entry.moveId === 'fling') {
    const atkName = pokeDisplayName(atkSnap, atkSnapCache);
    const flingItem = atkSnap?.heldItem ?? null;
    const flingPower = flingItem ? getFlingPower(flingItem) : null;
    if (!flingItem || flingPower == null) {
      moveEvents.push(`${atkName} used Fling, but it has nothing to fling!`);
      return;
    }
    flingPowerOverride = flingPower;
    flingItemUsed = flingItem;
    await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { heldItem: null, consumedHeldItem: flingItem } });
    if (atkSnap) atkSnap.heldItem = null;
    moveEvents.push(`${atkName} flung its ${slugToDisplayName(flingItem)}!`);
  }

  // Life Orb (milestone 5.17b) — 10% of the attacker's OWN max HP recoil once per
  // move use, not once per target hit (unlike RECOIL_MOVES/DRAIN_MOVES below, which
  // never needed this guard since every real recoil move is single-target). Declared
  // outside the target loop so a spread move (Discharge, Earthquake, etc.) only
  // recoils once. The 1.3x damage boost itself needs no code here — it's part of
  // @smogon/calc's own formula once heldItem reaches CalcPokemon (5.17a).
  let lifeOrbApplied = false;

  for (const targetId of targets) {
    if (FORCE_SWITCH_STATUS_MOVES.has(entry.moveId)) {
      // Roar/Whirlwind bypass accuracy checks entirely (modern-gen rule) and deal no damage.
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}!`);
      await forceOpponentSwitch(battle, targetId, moveEvents);
      continue;
    }

    const counterEffect = COUNTER_MOVES[entry.moveId];
    if (counterEffect) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const stored  = (battle.damageTakenThisTurn as Record<string, { amount: number; category: string; attackerId: string }>)[entry.activePokemonId.toString()];
      const categoryMatches = stored && (counterEffect.category === 'both' || stored.category === counterEffect.category);
      const targetMatches   = stored && stored.attackerId === targetId;
      if (!categoryMatches || !targetMatches) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
        continue;
      }
      const protectCondition = protectingTargets.get(targetId);
      if (protectCondition) {
        const { poke: tgtDoc, cache: tgtC } = await fetchDisplay(targetId, 'nickname speciesId', 'name');
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}!`);
        moveEvents.push(`${pokeDisplayName(tgtDoc, tgtC)} protected itself!`);
        continue;
      }
      const retaliation = Math.max(1, Math.floor(stored.amount * counterEffect.multiplier));
      const currentHp    = targetHpMap.get(targetId) ?? 0;
      const isEnduring   = enduringTargets.has(targetId);
      const rawNewHp     = currentHp - retaliation;
      const newHp        = isEnduring && rawNewHp <= 0 ? 1 : Math.max(0, rawNewHp);
      await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newHp } });
      targetHpMap.set(targetId, newHp);
      const damageMap = battle.damageTakenThisTurn as Record<string, { amount: number; category: string; attackerId: string }>;
      damageMap[targetId] = { amount: retaliation, category: counterEffect.category === 'both' ? stored.category : counterEffect.category, attackerId: entry.activePokemonId.toString() };
      battle.markModified('damageTakenThisTurn');
      moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}! It hit back for ${retaliation} damage!${isEnduring && rawNewHp <= 0 ? ' It endured the hit!' : ''}`);
      continue;
    }

    if (OHKO_MOVES.has(entry.moveId) && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const { poke: tgt, cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId level hasHiddenAbility heldItem nature evs ownerId ownerType', 'name types abilities baseStats');
      if (!tgt || !tgtCache) { moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`); continue; }

      const moveType = moveMeta?.type?.toLowerCase();
      const typeEff  = moveType ? getTypeEffectiveness(moveType, (tgtCache.types as string[]) ?? []) : 1;
      const tgtAbilitySlugs = getEffectiveAbilitySlugs(battle, targetId, (tgtCache.abilities as CachedAbility[]) ?? [], (tgt as any).hasHiddenAbility ?? false);
      const typeImmune = moveType != null && TYPE_IMMUNITY_ABILITIES.some(t => tgtAbilitySlugs.includes(t.abilitySlug) && t.type === moveType);

      if (typeEff === 0 || typeImmune) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)} on ${tgtName}, but it had no effect!`);
      } else if (atkSnap.level < (tgt as any).level) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
      } else if (tgtAbilitySlugs.includes('sturdy')) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed against ${tgtName}'s Sturdy!`);
      } else {
        // Own accuracy formula, unrelated to the move's own listed accuracy value.
        const ohkoAccuracy = Math.min(100, Math.max(0, atkSnap.level - (tgt as any).level + 30));
        if (Math.random() * 100 >= ohkoAccuracy) {
          moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)} on ${tgtName}, but it missed!`);
        } else {
          const isEnduring = enduringTargets.has(targetId);
          // Focus Sash (milestone 5.17b) — an OHKO move only ever "deals" the target's
          // own current HP as damage, so full-HP is the only state that can ever be
          // saved from here (a chipped target dying to an OHKO was never at full HP).
          const currentHp = targetHpMap.get(targetId) ?? 0;
          const tgtMaxHp  = tgtCache.baseStats
            ? computeStats(tgtCache.baseStats as BaseStats, (tgt as any).level, (tgt as any).nature, (tgt as any).evs as BaseStats, await getIvsForOwner((tgt as any).ownerId, (tgt as any).ownerType)).hp
            : null;
          const hasFocusSash = !isEnduring && (tgt as any).heldItem === 'focus-sash' && tgtMaxHp != null && currentHp === tgtMaxHp;
          const newHp = (isEnduring || hasFocusSash) ? 1 : 0;
          const hpUpdate: Record<string, unknown> = { currentHp: newHp };
          if (hasFocusSash) { hpUpdate.heldItem = null; hpUpdate.consumedHeldItem = 'focus-sash'; }
          await Pokemon.updateOne({ _id: targetId }, { $set: hpUpdate });
          targetHpMap.set(targetId, newHp);
          moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}! It's a one-hit KO!${isEnduring ? ` ${tgtName} endured the hit!` : hasFocusSash ? ` ${tgtName} hung on using its Focus Sash!` : ''}`);
        }
      }
      continue;
    }

    if (moveAccuracy !== null) {
      const attackerAccStage = stageMap[entry.activePokemonId.toString()]?.acc ?? 0;
      const targetEvaStage   = stageMap[targetId]?.eva ?? 0;
      const hitChance = (moveAccuracy / 100) * accuracyStageMultiplier(attackerAccStage, targetEvaStage);
      if (Math.random() >= hitChance) {
        const { poke: tgtDoc, cache: tgtCache } = await fetchDisplay(targetId, 'nickname speciesId', 'name');
        const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)} on ${pokeDisplayName(tgtDoc, tgtCache)}, but it missed!`);
        continue;
      }
    }

    // Opponent-directed type-change moves (milestone 5.14 Wave 11) — Soak overwrites
    // the TARGET's type, Reflect Type copies the TARGET's type onto the USER. Neither
    // deals damage, same "custom branch + continue" shape as leech-seed/pain-split above.
    if (entry.moveId === 'soak') {
      const { cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId', 'name types');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const currentTypes = getEffectiveTypes(battle, targetId, (tgtCache?.types as string[]) ?? []);
      if (currentTypes.length === 1 && currentTypes[0] === 'water') {
        moveEvents.push(`${atkName} used Soak, but it failed!`);
      } else {
        (battle.typeOverride as Record<string, string[]>)[targetId] = ['water'];
        battle.markModified('typeOverride');
        moveEvents.push(`${atkName} used Soak! ${tgtName} transformed into the Water type!`);
      }
      continue;
    }

    if (entry.moveId === 'reflect-type') {
      const { cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId', 'name types');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const targetTypes = getEffectiveTypes(battle, targetId, (tgtCache?.types as string[]) ?? []);
      (battle.typeOverride as Record<string, string[]>)[entry.activePokemonId.toString()] = targetTypes;
      battle.markModified('typeOverride');
      moveEvents.push(`${atkName} used Reflect Type! ${atkName} took on ${tgtName}'s type!`);
      continue;
    }

    // Item-swap moves (milestone 5.14 Wave 12) — Trick and Switcheroo are mechanically
    // identical (Normal vs Dark flavor only): swap held items outright, failing only
    // when NEITHER side has one. Bestow is one-directional (give only, never fails on
    // an empty-handed user — it just has nothing to give) and fails if the target
    // already holds something, since Bestow can never overwrite an existing item.
    if ((entry.moveId === 'trick' || entry.moveId === 'switcheroo') && atkSnap) {
      const tgt = await Pokemon.findById(targetId, 'nickname speciesId heldItem').lean();
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name').lean() : null;
      const tgtName = pokeDisplayName(tgt, tgtCache);
      if (!atkSnap.heldItem && !tgt?.heldItem) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
      } else {
        const atkItem = atkSnap.heldItem ?? null;
        const tgtItem = tgt?.heldItem ?? null;
        await Promise.all([
          Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { heldItem: tgtItem } }),
          Pokemon.updateOne({ _id: targetId }, { $set: { heldItem: atkItem } }),
        ]);
        atkSnap.heldItem = tgtItem;
        moveEvents.push(`${atkName} switched items with ${tgtName} using ${slugToDisplayName(entry.moveId)}!`);
      }
      continue;
    }

    if (entry.moveId === 'bestow' && atkSnap) {
      const tgt = await Pokemon.findById(targetId, 'nickname speciesId heldItem').lean();
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name').lean() : null;
      const tgtName = pokeDisplayName(tgt, tgtCache);
      if (!atkSnap.heldItem) {
        moveEvents.push(`${atkName} used Bestow, but it has no item to give!`);
      } else if (tgt?.heldItem) {
        moveEvents.push(`${atkName} used Bestow, but ${tgtName} is already holding an item!`);
      } else {
        const givenItem = atkSnap.heldItem;
        await Promise.all([
          Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { heldItem: null } }),
          Pokemon.updateOne({ _id: targetId }, { $set: { heldItem: givenItem } }),
        ]);
        atkSnap.heldItem = null;
        moveEvents.push(`${atkName} gave its ${slugToDisplayName(givenItem)} to ${tgtName}!`);
      }
      continue;
    }

    if (entry.moveId === 'dream-eater') {
      const tgt      = await Pokemon.findById(targetId, 'statusCondition nickname speciesId').lean();
      if (tgt?.statusCondition !== 'sleep') {
        const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name').lean() : null;
        moveEvents.push(`Dream Eater had no effect on ${pokeDisplayName(tgt, tgtCache)}!`);
        continue;
      }
    }

    if (entry.moveId === 'pain-split' && atkSnap && atkSnapCache?.baseStats) {
      const { poke: tgt, cache: tgtCache } = await fetchDisplay(targetId, 'ownerId ownerType currentHp nickname speciesId level nature evs', 'name baseStats');
      if (tgt && tgtCache?.baseStats) {
        const tgtIvs   = await getIvsForOwner((tgt as any).ownerId, (tgt as any).ownerType);
        const atkMaxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp;
        const tgtMaxHp = computeStats(tgtCache.baseStats as BaseStats, (tgt as any).level, (tgt as any).nature, (tgt as any).evs as BaseStats, tgtIvs).hp;
        const average  = Math.floor((atkSnap.currentHp + (targetHpMap.get(targetId) ?? (tgt as any).currentHp)) / 2);
        const newAtkHp = Math.min(atkMaxHp, average); const newTgtHp = Math.min(tgtMaxHp, average);
        await Promise.all([Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } }), Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newTgtHp } })]);
        atkSnap.currentHp = newAtkHp; targetHpMap.set(targetId, newTgtHp);
        moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} used Pain Split on ${pokeDisplayName(tgt, tgtCache)}!`);
        moveEvents.push(`They split the pain! (${pokeDisplayName(atkSnap, atkSnapCache)}: ${newAtkHp} HP, ${pokeDisplayName(tgt, tgtCache)}: ${newTgtHp} HP)`);
      }
      continue;
    }

    if (entry.moveId === 'strength-sap' && atkSnap && atkSnapCache?.baseStats) {
      const { poke: tgt, cache: tgtCache } = await fetchDisplay(targetId, 'ownerId ownerType nickname speciesId level nature evs hasHiddenAbility', 'name baseStats abilities');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      if (tgt && tgtCache?.baseStats) {
        const tgtIvs = await getIvsForOwner((tgt as any).ownerId, (tgt as any).ownerType);
        // Real Strength Sap heals by the target's CURRENT (stage-modified) Attack; this
        // project approximates with the target's base computed Attack (no stage factor),
        // same simplification level already accepted for other stat-dependent effects.
        const tgtAtk   = computeStats(tgtCache.baseStats as BaseStats, (tgt as any).level, (tgt as any).nature, (tgt as any).evs as BaseStats, tgtIvs).atk;
        const atkMaxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp;
        const healed   = Math.min(atkMaxHp - atkSnap.currentHp, tgtAtk);
        if (healed > 0) {
          const newAtkHp = atkSnap.currentHp + healed;
          await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
          atkSnap.currentHp = newAtkHp;
        }
        moveEvents.push(`${atkName} used Strength Sap! ${atkName} restored ${Math.max(0, healed)} HP!`);
        const tgtName = pokeDisplayName(tgt, tgtCache);
        const tgtAbilitySlugs = getEffectiveAbilitySlugs(battle, targetId, (tgtCache.abilities as CachedAbility[]) ?? [], (tgt as any).hasHiddenAbility as boolean);
        moveEvents.push(...applyStatStageEffects(stageMap, targetId, [{ stat: 'atk', stages: -1, target: 'self' }], tgtName, tgtAbilitySlugs));
        battle.markModified('statStages');
      }
      continue;
    }

    if (entry.moveId === 'leech-seed') {
      const { poke: tgt, cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId volatileStatus', 'name types');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      if (((tgtCache?.types as string[]) ?? []).includes('grass')) {
        moveEvents.push(`${atkName} used Leech Seed! It had no effect on ${tgtName}!`);
      } else if (((tgt?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'leech-seed')) {
        moveEvents.push(`${tgtName} is already seeded!`);
      } else {
        await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: 'leech-seed', turnsRemaining: 99 } } });
        moveEvents.push(`${atkName} used Leech Seed! ${tgtName} was seeded!`);
      }
      continue;
    }

    if (NO_DAMAGE_TRAP_MOVES.has(entry.moveId)) {
      const { poke: tgt, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId volatileStatus', 'name');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const alreadyBound = ((tgt?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('bound:'));
      if (alreadyBound) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
      } else {
        await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: `bound:${entry.moveId}:${entry.activePokemonId.toString()}`, turnsRemaining: 99 } } });
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}! ${tgtName} can no longer flee!`);
      }
      continue;
    }

    if (DELAYED_DAMAGE_MOVES.has(entry.moveId) && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      let targetSide: 'playerSide' | 'enemySide' | null = null;
      let targetSlotIndex = -1;
      const playerIdx = battle.playerSide.findIndex(e => e.activePokemonId?.toString() === targetId);
      if (playerIdx !== -1) { targetSide = 'playerSide'; targetSlotIndex = playerIdx; }
      else {
        const enemyIdx = battle.enemySide.findIndex(e => e.activePokemonId?.toString() === targetId);
        if (enemyIdx !== -1) { targetSide = 'enemySide'; targetSlotIndex = enemyIdx; }
      }
      if (!targetSide) {
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}, but it failed!`);
      } else {
        const pending: PendingAttack = {
          moveId: entry.moveId,
          targetSide,
          targetSlotIndex,
          turnsRemaining: DELAYED_DAMAGE_TURNS,
          attackerName: atkName,
          attackerSpeciesId: atkSnap.speciesId,
          attackerLevel: atkSnap.level,
          attackerNature: atkSnap.nature,
          attackerEvs: atkSnap.evs as unknown as Record<string, number>,
          attackerIvs: atkIvs as unknown as Record<string, number>,
          attackerAbilitySlug: attackerAbilitySlugs[0] ?? null,
          attackerHeldItem: atkSnap.heldItem ?? null,
        };
        battle.pendingAttacks.push(pending);
        battle.markModified('pendingAttacks');
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)}! ${atkName} foresaw an attack!`);
      }
      continue;
    }

    if (entry.moveId === 'attract') {
      const { poke: tgt, cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId gender volatileStatus hasHiddenAbility', 'name abilities');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const oppositeGenders = !!tgt && !!atkSnap
        && tgt.gender !== 'none' && tgt.gender != null
        && atkSnap.gender !== 'none' && atkSnap.gender != null
        && tgt.gender !== atkSnap.gender;
      if (!oppositeGenders) {
        moveEvents.push(`${atkName} used Attract! It doesn't affect ${tgtName}!`);
        continue;
      }
      const tgtAbilitySlugs = tgt && tgtCache ? getEffectiveAbilitySlugs(battle, targetId, (tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean) : [];
      if (tgtAbilitySlugs.includes('oblivious')) {
        moveEvents.push(`${atkName} used Attract! ${tgtName}'s Oblivious prevents infatuation!`);
        continue;
      }
      if (((tgt?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('infatuated:'))) {
        moveEvents.push(`${atkName} used Attract, but it failed!`);
        continue;
      }
      await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition: `infatuated:${entry.activePokemonId.toString()}`, turnsRemaining: 99 } } });
      moveEvents.push(`${atkName} used Attract! ${tgtName} fell in love!`);
      continue;
    }

    if (entry.moveId === 'sketch') {
      // Targets an opponent, but the effect writes to the USER's own moveset — permanently
      // replaces Sketch's own slot with whatever move the target last used (battle.lastMoveByPokemon,
      // same tracking Copycat reads globally). Never consumes the copied move's PP; the normal
      // PP-deduction call after this function returns finds no 'sketch' slot left to decrement
      // once the swap below has happened, which is exactly the desired no-op.
      const { name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId', 'name');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const lastMoveMap  = (battle.lastMoveByPokemon ?? {}) as Record<string, string>;
      const copiedMoveId = lastMoveMap[targetId];
      const atkMoves = ((await Pokemon.findById(entry.activePokemonId, 'moves').lean())?.moves ?? []) as Array<{ moveId: string; currentPP: number; maxPP: number; ppUps: number }>;
      const sketchSlot = atkMoves.findIndex(m => m.moveId === 'sketch');
      if (!copiedMoveId || copiedMoveId === 'sketch' || copiedMoveId === 'struggle' || sketchSlot === -1) {
        moveEvents.push(`${atkName} used Sketch, but it failed!`);
      } else if (atkMoves.some(m => m.moveId === copiedMoveId)) {
        moveEvents.push(`${atkName} used Sketch on ${tgtName}, but it already knows ${slugToDisplayName(copiedMoveId)}!`);
      } else {
        const anyCache = await PokedexCache.findOne({ 'moves.name': copiedMoveId }, { 'moves.$': 1 }).lean();
        const pp = ((anyCache?.moves as Array<{ name: string; pp: number | null }> | undefined)?.[0]?.pp) ?? 5;
        const newMoves = atkMoves.map((m, i) => i === sketchSlot ? { moveId: copiedMoveId, currentPP: pp, maxPP: pp, ppUps: 0 } : m);
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { moves: newMoves });
        moveEvents.push(`${atkName} used Sketch on ${tgtName}! Sketch permanently became ${slugToDisplayName(copiedMoveId)}!`);
      }
      continue;
    }

    if (entry.moveId === 'mimic') {
      // Same target's-last-move lookup as Sketch, but TEMPORARY (fixed 5 PP, always —
      // real Mimic ignores PP Ups entirely) and reverted on switch-out/faint instead of
      // permanent. battle.mimicState snapshots the ORIGINAL Mimic slot's own data
      // (moveId/PP/ppUps) so it can be restored later, keyed by slotIndex since the
      // copied move's PP will drift independently while it's active.
      const { name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId', 'name');
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const lastMoveMap  = (battle.lastMoveByPokemon ?? {}) as Record<string, string>;
      const copiedMoveId = lastMoveMap[targetId];
      const atkPoke  = await Pokemon.findById(entry.activePokemonId, 'moves').lean();
      const atkMoves = (atkPoke?.moves ?? []) as Array<{ moveId: string; currentPP: number; maxPP: number; ppUps: number }>;
      const mimicSlot = atkMoves.findIndex(m => m.moveId === 'mimic');
      if (!copiedMoveId || copiedMoveId === 'mimic' || copiedMoveId === 'sketch' || copiedMoveId === 'struggle' || mimicSlot === -1) {
        moveEvents.push(`${atkName} used Mimic, but it failed!`);
      } else if (atkMoves.some(m => m.moveId === copiedMoveId)) {
        moveEvents.push(`${atkName} used Mimic on ${tgtName}, but it already knows ${slugToDisplayName(copiedMoveId)}!`);
      } else {
        const original = atkMoves[mimicSlot];
        const newMoves = atkMoves.map((m, i) => i === mimicSlot ? { moveId: copiedMoveId, currentPP: 5, maxPP: 5, ppUps: 0 } : m);
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { moves: newMoves });
        const mimicMap = battle.mimicState as Record<string, MimicState>;
        mimicMap[entry.activePokemonId.toString()] = {
          slotIndex: mimicSlot, originalMoveId: original.moveId,
          originalCurrentPP: original.currentPP, originalMaxPP: original.maxPP, originalPpUps: original.ppUps,
        };
        battle.markModified('mimicState');
        moveEvents.push(`${atkName} used Mimic on ${tgtName}! ${atkName} temporarily learned ${slugToDisplayName(copiedMoveId)}!`);
      }
      continue;
    }

    if (typeChangeMoveType && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const proteanSlug = attackerAbilitySlugs.find(s => s === 'protean' || s === 'libero');
      const ilateSlug    = attackerAbilitySlugs.find(s => s in ILATE_MAP);
      if (proteanSlug) {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(proteanSlug)}! ${atkName} became the ${typeChangeMoveType.charAt(0).toUpperCase() + typeChangeMoveType.slice(1)} type!`);
      } else if (ilateSlug && typeChangeMoveType === 'normal') {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(ilateSlug)}! The move became ${ILATE_MAP[ilateSlug]} type!`);
      }
    }

    // Focus Sash (milestone 5.17b) — fetched once per target here (not per hit) since
    // heldItem/maxHp don't change mid-sequence; the "still at full HP" check itself is
    // re-evaluated fresh on every hit below, which is what actually limits the save to
    // the first hit of a multi-hit move.
    const focusSashTgt = await Pokemon.findById(targetId, 'heldItem speciesId level nature evs ownerId ownerType').lean();
    const focusSashCache = focusSashTgt?.heldItem === 'focus-sash'
      ? await PokedexCache.findOne({ pokeApiId: focusSashTgt.speciesId }, 'baseStats').lean()
      : null;
    const focusSashMaxHp = focusSashTgt && focusSashCache?.baseStats
      ? computeStats(focusSashCache.baseStats as BaseStats, focusSashTgt.level, focusSashTgt.nature, focusSashTgt.evs as BaseStats, await getIvsForOwner(focusSashTgt.ownerId, focusSashTgt.ownerType)).hp
      : null;

    const hitCount  = getHitCount(entry.moveId);
    let totalDamage = 0; let actualHits = 0; let anyCrit = false;

    for (let hit = 1; hit <= hitCount; hit++) {
      if ((targetHpMap.get(targetId) ?? 0) <= 0) break;

      if (sideGuard.wideGuard && moveTargetCategory === 'auto') {
        moveEvents.push(`${slugToDisplayName(entry.moveId)} was blocked by Wide Guard!`);
        break;
      }
      if (sideGuard.quickGuard && moveIsPriority) {
        moveEvents.push(`${slugToDisplayName(entry.moveId)} was blocked by Quick Guard!`);
        break;
      }

      const protectCondition = protectingTargets.get(targetId);
      if (protectCondition) {
        const { poke: tgtDoc, cache: tgtC } = await fetchDisplay(targetId, 'nickname speciesId', 'name');
        moveEvents.push(`${pokeDisplayName(tgtDoc, tgtC)} protected itself!`);
        if (CONTACT_MOVES.has(entry.moveId) && atkSnap && atkSnapCache) {
          const atkName = pokeDisplayName(atkSnap, atkSnapCache);
          if (protectCondition === 'protecting-kings-shield') {
            moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), [{ stat: 'atk', stages: -2, target: 'self' }], atkName, attackerAbilitySlugs));
            battle.markModified('statStages');
          } else if (protectCondition === 'protecting-obstruct') {
            moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), [{ stat: 'def', stages: -2, target: 'self' }], atkName, attackerAbilitySlugs));
            battle.markModified('statStages');
          } else if (protectCondition === 'protecting-spiky-shield' && atkSnapCache.baseStats) {
            const maxHp   = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp;
            const chipDmg = Math.max(1, Math.floor(maxHp / 8));
            const newHp   = Math.max(0, atkSnap.currentHp - chipDmg);
            await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } });
            atkSnap.currentHp = newHp;
            moveEvents.push(`${atkName} was hurt by Spiky Shield! (${chipDmg} damage)`);
          } else if (protectCondition === 'protecting-baneful-bunker') {
            const statusEvents = await applyStatusEffect(battle, entry.activePokemonId, { status: 'poison', chance: 1 });
            if (statusEvents.length) { moveEvents.push(`${atkName} was poisoned by Baneful Bunker!`); moveEvents.push(...statusEvents); }
          } else if (protectCondition === 'protecting-silk-trap') {
            moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), [{ stat: 'spe', stages: -1, target: 'self' }], atkName, attackerAbilitySlugs));
            battle.markModified('statStages');
          } else if (protectCondition === 'protecting-burning-bulwark') {
            const statusEvents = await applyStatusEffect(battle, entry.activePokemonId, { status: 'burn', chance: 1 });
            if (statusEvents.length) { moveEvents.push(`${atkName} was burned by Burning Bulwark!`); moveEvents.push(...statusEvents); }
          }
        }
        break;
      }

      const { damage, isCrit, events, category } = await resolveMove(
        battle, entry.activePokemonId, new mongoose.Types.ObjectId(targetId), entry.moveId, battle.weather,
        { attacker: stageMap[entry.activePokemonId.toString()], target: stageMap[targetId] },
        escalatedPower ?? meFirstPowerOverride ?? flingPowerOverride, wonderRoomActive, magicRoomActive,
        { reflect: !!sideGuard.reflect, lightScreen: !!sideGuard.lightScreen, auroraVeil: !!sideGuard.auroraVeil },
      );
      if (isCrit) anyCrit = true;
      if (hitCount > 1) { moveEvents.push(`(Hit ${hit}) ${events[0]}`); } else { moveEvents.push(...events); }

      // A Substitute absorbs damage in place of the real Pokémon: no HP lost, no
      // damageTakenThisTurn recorded (so Counter/Mirror Coat/Metal Burst can't trigger off
      // an absorbed hit), and a multi-hit move stops the instant the substitute breaks —
      // the remaining hits don't carry over to the real Pokémon (matches the real games).
      // Secondary effects (status/stat-drops/flinch/recoil/drain) below aren't specially
      // blocked by a substitute — same simplification this project already accepts for
      // Protect (see the block above), kept consistent rather than fixed for one and not
      // the other.
      const subHp = substituteTargets.get(targetId);
      if (subHp != null && subHp > 0 && damage > 0) {
        totalDamage += damage;
        const newSubHp = subHp - damage;
        if (newSubHp <= 0) {
          await Pokemon.updateOne({ _id: targetId }, { $pull: { volatileStatus: { condition: { $regex: '^substitute:' } } } });
          substituteTargets.set(targetId, 0);
          moveEvents.push('The substitute broke!');
          break;
        }
        await Pokemon.updateOne(
          { _id: targetId, 'volatileStatus.condition': { $regex: '^substitute:' } },
          { $set: { 'volatileStatus.$.condition': `substitute:${newSubHp}` } },
        );
        substituteTargets.set(targetId, newSubHp);
        continue;
      }

      if (damage > 0) {
        const currentHp  = targetHpMap.get(targetId) ?? 0;
        const isEnduring = enduringTargets.has(targetId);
        // Focus Sash only saves from exactly full HP — re-checked against the CURRENT
        // running HP on every hit, so a multi-hit move only gets saved on its first
        // hit; by hit 2 currentHp no longer equals focusSashMaxHp and this is false.
        const hasFocusSash = !isEnduring && focusSashMaxHp != null && currentHp === focusSashMaxHp;
        const rawNewHp   = currentHp - damage;
        const newHp      = (isEnduring || hasFocusSash) && rawNewHp <= 0 ? 1 : Math.max(0, rawNewHp);
        const hpUpdate: Record<string, unknown> = { currentHp: newHp };
        if (hasFocusSash && rawNewHp <= 0) { hpUpdate.heldItem = null; hpUpdate.consumedHeldItem = 'focus-sash'; }
        await Pokemon.updateOne({ _id: targetId }, { $set: hpUpdate });
        targetHpMap.set(targetId, newHp);
        totalDamage += damage;
        if (isEnduring && rawNewHp <= 0) moveEvents.push('It endured the hit!');
        else if (hasFocusSash && rawNewHp <= 0) moveEvents.push('It hung on using its Focus Sash!');
        if (category === 'physical' || category === 'special') {
          const damageMap = battle.damageTakenThisTurn as Record<string, { amount: number; category: string; attackerId: string }>;
          damageMap[targetId] = { amount: damage, category, attackerId: entry.activePokemonId.toString() };
          battle.markModified('damageTakenThisTurn');
          // For Conversion 2 (milestone 5.14 Wave 11) — unlike damageTakenThisTurn this
          // persists across rounds, since Conversion 2 reacts to "the last move that hit
          // me" regardless of which round that was.
          const hitMoveType = moveMeta?.type?.toLowerCase();
          if (hitMoveType) {
            (battle.lastHitMoveType as Record<string, string>)[targetId] = hitMoveType;
            battle.markModified('lastHitMoveType');
          }
        }
      }
      actualHits++;
    }
    if (hitCount > 1) moveEvents.push(`Hit ${actualHits} time(s)!`);

    if (anyCrit) {
      const { poke: apTgt, cache: apCache } = await fetchDisplay(targetId, 'nickname speciesId hasHiddenAbility', 'name abilities');
      const apAbilities = apTgt && apCache ? getEffectiveAbilitySlugs(battle, targetId, (apCache.abilities as CachedAbility[]) ?? [], (apTgt.hasHiddenAbility as boolean) ?? false) : [];
      if (apAbilities.includes('anger-point')) {
        const apName = pokeDisplayName(apTgt, apCache);
        const apStageMap = battle.statStages as Record<string, StatStages>;
        if (!apStageMap[targetId]) apStageMap[targetId] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
        apStageMap[targetId].atk = 6; battle.markModified('statStages');
        moveEvents.push(`${apName}'s Anger Point! ${apName}'s Attack rose to the maximum!`);
      }
    }

    if (moveEffect && Math.random() < (sereneGrace ? Math.min(1, moveEffect.chance * 2) : moveEffect.chance)) {
      moveEvents.push(...await applyStatusEffect(battle, new mongoose.Types.ObjectId(targetId), moveEffect));
    }

    const statEffects = STAT_STAGE_MOVES[entry.moveId];
    if (statEffects) {
      let foeEffects = statEffects.filter(e => e.target === 'foe' && Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      // Mist (milestone 5.14 Wave 6) — blocks incoming NEGATIVE stat changes for the
      // target's side only; Decorate/Spicy Extract-style positive "used on a foe"
      // effects (see Wave 1) are unaffected, matching the real games.
      if (foeEffects.some(e => e.stages < 0)) {
        const targetSide = resolveActingSide(battle, new mongoose.Types.ObjectId(targetId));
        if (targetSide && (battle.fieldConditions ?? []).some(f => f.condition === `mist:${targetSide}`)) {
          const blocked = foeEffects.some(e => e.stages < 0);
          foeEffects = foeEffects.filter(e => e.stages >= 0);
          if (blocked) moveEvents.push(`${slugToDisplayName(entry.moveId)} was blocked by Mist!`);
        }
      }
      if (foeEffects.length > 0) {
        const { poke: tgt, cache: tgtCache, name: tgtName } = await fetchDisplay(targetId, 'nickname speciesId hasHiddenAbility', 'name abilities');
        const tgtAbilities = tgt && tgtCache ? getEffectiveAbilitySlugs(battle, targetId, (tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean) : [];
        moveEvents.push(...applyStatStageEffects(stageMap, targetId, foeEffects, tgtName, tgtAbilities));
        battle.markModified('statStages');
        if (foeEffects.some(e => e.stages < 0)) {
          for (const reaction of ['competitive', 'defiant'] as const) {
            if (!tgtAbilities.includes(reaction)) continue;
            const reactionStat: keyof StatStages = reaction === 'competitive' ? 'spa' : 'atk';
            moveEvents.push(`${tgtName}'s ${slugToDisplayName(reaction)}!`);
            moveEvents.push(...applyStatStageEffects(stageMap, targetId, [{ stat: reactionStat, stages: 2, target: 'self' }], tgtName));
            battle.markModified('statStages');
          }
        }
      }
    }

    if (BOTH_SIDES_HAZARD_CLEAR.has(entry.moveId) && entry.moveId === 'defog') {
      // Unconditional — real Defog always clears both sides regardless of whether the
      // -1 Evasion above landed or was blocked by Mist (a hazard clear isn't a "stat
      // change", so Mist doesn't touch it). Also clears screens/Mist/Safeguard on both
      // sides (real Gen 6+ behavior), not just hazards.
      const before = (battle.fieldConditions ?? []).length;
      battle.fieldConditions = (battle.fieldConditions ?? []).filter(f => {
        const [moveId, side] = f.condition.split(':');
        const isHazard = (side === 'playerSide' || side === 'enemySide') && ENTRY_HAZARD_MOVES.has(moveId);
        const isScreenOrGuard = (side === 'playerSide' || side === 'enemySide') && (SCREEN_MOVES.has(moveId) || moveId === 'mist' || moveId === 'safeguard');
        return !isHazard && !isScreenOrGuard;
      });
      if (battle.fieldConditions.length !== before) {
        battle.markModified('fieldConditions');
        moveEvents.push('Hazards and screens were blown away from the field!');
      }
    }

    if (selfStatEffects.length > 0 && atkSnap && atkSnapCache) {
      const rolledSelfEffects = selfStatEffects.filter(e => Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      if (rolledSelfEffects.length > 0) {
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), rolledSelfEffects, pokeDisplayName(atkSnap, atkSnapCache), attackerAbilitySlugs));
        battle.markModified('statStages');
      }
    }

    if (recoilEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      let recoilDmg: number;
      if (recoilEffect.type === 'damage') { recoilDmg = Math.max(1, Math.floor(totalDamage * recoilEffect.fraction)); }
      else { const maxHp = atkSnapCache.baseStats ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp : 1; recoilDmg = Math.max(1, Math.floor(maxHp * recoilEffect.fraction)); }
      const newAtkHp = Math.max(0, atkSnap.currentHp - recoilDmg);
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
      atkSnap.currentHp = newAtkHp;
      moveEvents.push(`${atkName} was hurt by recoil!`);
    }

    if (drainEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const maxHp     = atkSnapCache.baseStats ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp : 0;
      const restoreAmt = Math.max(1, Math.floor(totalDamage * drainEffect.fraction));
      const newAtkHp   = Math.min(maxHp, atkSnap.currentHp + restoreAmt);
      const restored   = newAtkHp - atkSnap.currentHp;
      if (restored > 0) {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
        atkSnap.currentHp = newAtkHp;
        moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} restored ${restored} HP!`);
      }
    }

    if (!lifeOrbApplied && atkSnap?.heldItem === 'life-orb' && totalDamage > 0 && atkSnapCache?.baseStats) {
      lifeOrbApplied = true;
      const maxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp;
      const recoilDmg = Math.max(1, Math.floor(maxHp / 10));
      const newAtkHp  = Math.max(0, atkSnap.currentHp - recoilDmg);
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
      atkSnap.currentHp = newAtkHp;
      moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} was hurt by its Life Orb!`);
    }

    const flinchChance = FLINCH_MOVES[entry.moveId];
    if (flinchChance && totalDamage > 0 && Math.random() < flinchChance) {
      const targetEntry = battle.turnQueue.find(e => e.activePokemonId.toString() === targetId && !e.resolved);
      if (targetEntry) targetEntry.flinched = true;
    }

    // Knock Off (milestone 5.14 Wave 12) — the +50% bonus for a target holding an item
    // is applied inside resolveMove itself (needs the pre-multiplier damage number), so
    // this block only handles the post-hit removal: the item is lost, not transferred to
    // the attacker (matches the real games), and remembered on the target for Recycle.
    if (entry.moveId === 'knock-off' && totalDamage > 0) {
      const tgt = await Pokemon.findById(targetId, 'nickname speciesId heldItem').lean();
      if (tgt?.heldItem) {
        const tgtCache = await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name').lean();
        await Pokemon.updateOne({ _id: targetId }, { $set: { heldItem: null, consumedHeldItem: tgt.heldItem } });
        moveEvents.push(`${pokeDisplayName(tgt, tgtCache)}'s ${slugToDisplayName(tgt.heldItem)} was knocked off!`);
      }
    }

    // Thief / Covet (milestone 5.14 Wave 12) — steals the target's held item only when
    // the user is currently empty-handed (matches the real games; Thief never overwrites
    // an item the user already has).
    if ((entry.moveId === 'thief' || entry.moveId === 'covet') && totalDamage > 0 && atkSnap && !atkSnap.heldItem) {
      const tgt = await Pokemon.findById(targetId, 'nickname speciesId heldItem').lean();
      if (tgt?.heldItem) {
        const tgtCache = await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name').lean();
        const stolenItem = tgt.heldItem;
        await Promise.all([
          Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { heldItem: stolenItem } }),
          Pokemon.updateOne({ _id: targetId }, { $set: { heldItem: null, consumedHeldItem: stolenItem } }),
        ]);
        atkSnap.heldItem = stolenItem;
        moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} stole ${pokeDisplayName(tgt, tgtCache)}'s ${slugToDisplayName(stolenItem)}!`);
      }
    }

    // Poison Barb is the one item among the 17 this project supports with a real Fling
    // secondary effect — everything else in FLING_POWER is a plain damage-only throw.
    if (entry.moveId === 'fling' && flingItemUsed === 'poison-barb' && totalDamage > 0) {
      moveEvents.push(...await applyStatusEffect(battle, new mongoose.Types.ObjectId(targetId), { status: 'poison', chance: 1 }));
    }

    if (CONTACT_MOVES.has(entry.moveId) && totalDamage > 0) {
      const defPoke = await Pokemon.findById(targetId, 'speciesId hasHiddenAbility nickname').lean();
      if (defPoke) {
        const defCache = await PokedexCache.findOne({ pokeApiId: defPoke.speciesId }, 'name abilities baseStats').lean();
        const defAbilitySlugs = getEffectiveAbilitySlugs(battle, targetId, (defCache?.abilities as CachedAbility[]) ?? [], defPoke.hasHiddenAbility as boolean);
        if (defAbilitySlugs.length > 0) {
          const defName = pokeDisplayName(defPoke, defCache);
          const atkId   = entry.activePokemonId;
          // Every contact ability the defender has triggers independently.
          if (defAbilitySlugs.some(s => s === 'rough-skin' || s === 'iron-barbs')) {
            const triggerSlug = defAbilitySlugs.find(s => s === 'rough-skin' || s === 'iron-barbs')!;
            if (atkSnap && atkSnapCache?.baseStats) {
              const maxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature, atkSnap.evs, atkIvs).hp;
              const dmg   = Math.max(1, Math.floor(maxHp / 8));
              const newHp = Math.max(0, atkSnap.currentHp - dmg);
              await Pokemon.updateOne({ _id: atkId }, { $set: { currentHp: newHp } });
              atkSnap.currentHp = newHp;
              moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} was hurt by ${defName}'s ${slugToDisplayName(triggerSlug)}!`);
            }
          }
          if (defAbilitySlugs.includes('poison-point') && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(battle, atkId, { status: 'poison', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Poison Point!`); moveEvents.push(...sEvts); }
          }
          if (defAbilitySlugs.includes('static') && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(battle, atkId, { status: 'paralysis', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Static!`); moveEvents.push(...sEvts); }
          }
          if (defAbilitySlugs.includes('flame-body') && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(battle, atkId, { status: 'burn', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Flame Body!`); moveEvents.push(...sEvts); }
          }
          if (defAbilitySlugs.includes('effect-spore') && Math.random() < 0.3) {
            const roll   = Math.random();
            const status = roll < 1/3 ? 'poison' : roll < 2/3 ? 'paralysis' : 'sleep';
            const sEvts  = await applyStatusEffect(battle, atkId, { status: status as StatusCondition, chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Effect Spore!`); moveEvents.push(...sEvts); }
          }
        }
      }
    }

    if (BINDING_MOVES.has(entry.moveId) && totalDamage > 0 && (targetHpMap.get(targetId) ?? 0) > 0) {
      const tgt = await Pokemon.findById(targetId, 'nickname speciesId volatileStatus').lean();
      const alreadyBound = ((tgt?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('bound:'));
      if (tgt && !alreadyBound) {
        const tgtCache  = await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name').lean();
        const duration  = 4 + Math.floor(Math.random() * 2); // 4-5 turns, matches Gen 6+
        const condition = `bound:${entry.moveId}:${entry.activePokemonId.toString()}`;
        await Pokemon.updateOne({ _id: targetId }, { $push: { volatileStatus: { condition, turnsRemaining: duration } } });
        moveEvents.push(`${pokeDisplayName(tgt, tgtCache)} was trapped by ${slugToDisplayName(entry.moveId)}!`);
      }
    }

    if (FORCE_SWITCH_DAMAGE_MOVES.has(entry.moveId) && totalDamage > 0 && (targetHpMap.get(targetId) ?? 0) > 0) {
      await forceOpponentSwitch(battle, targetId, moveEvents);
    }
  }

  const koCount = targets.filter(id => (targetHpMap.get(id) ?? 1) <= 0).length;
  if (koCount > 0) {
    let koAbilitySlugs = attackerAbilitySlugs;
    let koAtkCache: { name?: unknown; baseStats?: unknown; abilities?: unknown } | null = atkSnapCache;
    let koAtkName      = atkSnap ? pokeDisplayName(atkSnap, atkSnapCache) : null;

    if (koAbilitySlugs.length === 0) {
      const { poke: fetchedAtk, cache: fetchedCache } = await fetchDisplay(entry.activePokemonId, 'nickname speciesId hasHiddenAbility', 'name abilities baseStats');
      koAbilitySlugs = fetchedAtk && fetchedCache ? getEffectiveAbilitySlugs(battle, entry.activePokemonId.toString(), (fetchedCache.abilities as CachedAbility[]) ?? [], (fetchedAtk.hasHiddenAbility as boolean) ?? false) : [];
      koAtkCache = fetchedCache; koAtkName = pokeDisplayName(fetchedAtk, fetchedCache);
    }

    // Moxie and Beast Boost can both independently fire if a Pokémon somehow has both.
    for (const koAbilitySlug of koAbilitySlugs.filter(s => s === 'moxie' || s === 'beast-boost')) {
      let boostStat: keyof StatStages = 'atk';
      if (koAbilitySlug === 'beast-boost' && koAtkCache?.baseStats) {
        const bs = koAtkCache.baseStats as BaseStats;
        const statMap: [keyof StatStages, number][] = [['atk',bs.atk],['def',bs.def],['spa',bs.spatk],['spd',bs.spdef],['spe',bs.speed]];
        boostStat = statMap.reduce((best, cur) => cur[1] > best[1] ? cur : best)[0];
      }
      const atkId = entry.activePokemonId.toString();
      const atkName = koAtkName ?? 'Pokémon';
      for (let i = 0; i < koCount; i++) {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(koAbilitySlug)}!`);
        moveEvents.push(...applyStatStageEffects(stageMap, atkId, [{ stat: boostStat, stages: 1, target: 'self' }], atkName));
        battle.markModified('statStages');
      }
    }
  }

  // Manage move-lock state (Rollout, Thrash, Outrage, etc.).
  const lockEffect = LOCK_MOVES[entry.moveId];
  if (lockEffect) {
    const lockedMovesMap = (battle.lockedMoves ?? {}) as Record<string, { moveId: string; turnsRemaining: number }>;
    const pokemonKey = entry.activePokemonId.toString();
    const existingLock = lockedMovesMap[pokemonKey];
    if (!existingLock || existingLock.moveId !== entry.moveId) {
      const rawTurns = lockEffect.totalTurns === 'random' ? (Math.random() < 0.5 ? 2 : 3) : lockEffect.totalTurns;
      lockedMovesMap[pokemonKey] = { moveId: entry.moveId, turnsRemaining: rawTurns - 1 };
    } else {
      existingLock.turnsRemaining--;
      if (existingLock.turnsRemaining <= 0) {
        delete lockedMovesMap[pokemonKey];
        if (lockEffect.confuseAfter) {
          const confuseEvents = await applyStatusEffect(battle, entry.activePokemonId, { status: 'confusion', chance: 1 });
          moveEvents.push(...confuseEvents.map(e => e.replace('became confused!', 'became confused from fatigue!')));
        }
      }
    }
    battle.lockedMoves = lockedMovesMap;
    battle.markModified('lockedMoves');
  }

  // Recharge moves (milestone 5.14 Wave 5) — applies once per use, regardless of
  // hit/miss/Protect, hence placed here rather than inside the per-target loop above.
  // The actual skip is enforced in autoSkipBlockedActors via the 'must-recharge'
  // volatile, same shape as the flinch/status-block checks already there.
  if (RECHARGE_MOVES.has(entry.moveId)) {
    await Pokemon.updateOne({ _id: entry.activePokemonId }, { $push: { volatileStatus: { condition: 'must-recharge', turnsRemaining: 0 } } });
  }

  // Self-KO utility (milestone 5.14 Wave 10) — Explosion/Self-Destruct/Misty
  // Explosion/Memento all reach here via the normal foe-targeting damaging-move path
  // (Memento's stat-drop already fires earlier in the per-target loop above, from
  // Wave 1); the user faints unconditionally afterward, same "applies once per use"
  // placement as recharge above. Healing Wish/Lunar Dance are self-targeting and
  // handled in resolveSelfTargetMove instead — never reach this function.
  if (SELF_KO_MOVES.has(entry.moveId) && atkSnap) {
    await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: 0 } });
    moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} used up all its energy!`);
  }
}

export async function sendOut(req: Request, res: Response): Promise<void> {
  const { pokemonId } = req.body as { pokemonId: string };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  if (!pokemonId || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Invalid pokemonId' }); return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle)                          { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active')       { res.status(400).json({ data: null, error: 'Battle is not active' }); return; }
  if (battle.phase !== 'move_submission') { res.status(400).json({ data: null, error: 'Cannot send out a Pokémon outside move submission phase' }); return; }

  const own = findOwnSideEntry(battle, userId.toString());
  if (!own) { res.status(403).json({ data: null, error: 'You are not in this battle' }); return; }
  const { side, entry: playerEntry } = own;

  const pokeId  = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({ _id: pokeId, ownerId: userId, ownerType: 'player', isInParty: true }).lean();
  if (!pokemon)               { res.status(404).json({ data: null, error: 'Pokémon not found in your party' }); return; }
  if (pokemon.currentHp <= 0) { res.status(400).json({ data: null, error: 'That Pokémon has fainted' }); return; }

  const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === pokemonId);
  if (pokemonLimitReached(playerEntry.usedPokemonIds, pokemonId, battle.playerPokemonLimit)) {
    res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' }); return;
  }

  const outgoingId = playerEntry.activePokemonId;
  if (outgoingId && outgoingId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  }

  playerEntry.activePokemonId = pokeId;
  battle.markModified(side);
  if (!alreadyUsed) playerEntry.usedPokemonIds.push(pokeId);

  await finishSendOut(battle, pokeId, side === 'playerSide' ? 'player' : 'enemy', side, 'userId', userId);

  res.json({ data: { activePokemonId: pokemonId }, error: null });
}

export async function submitMove(req: Request, res: Response): Promise<void> {
  const { actionType = 'move', moveId, itemId, targetPokemonId, switchToPokemonId } =
    req.body as {
      actionType?: 'move' | 'item' | 'switch' | 'catch' | 'run';
      moveId?: string;
      itemId?: string;
      targetPokemonId?: string;
      switchToPokemonId?: string;
    };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  const battle = await Battle.findById(req.params.id);
  if (!battle)                            { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active')         { res.status(400).json({ data: null, error: 'Battle is not active' }); return; }
  if (battle.phase !== 'move_submission') { res.status(400).json({ data: null, error: 'Not in move submission phase' }); return; }

  const own = findOwnSideEntry(battle, userId.toString());
  if (!own)                              { res.status(403).json({ data: null, error: 'You are not in this battle' }); return; }
  const playerEntry = own.entry;
  if (!playerEntry.activePokemonId) { res.status(400).json({ data: null, error: 'You have not sent out a Pokémon yet' }); return; }

  const alreadySubmitted = battle.turnQueue.some(
    e => e.actorId.toString() === userId.toString() && e.actorType === 'player'
  );
  if (alreadySubmitted) { res.status(400).json({ data: null, error: 'You have already submitted a move this turn' }); return; }

  // If this Pokémon is locked into a move, block all other actions and force that move.
  const playerLockMap = (battle.lockedMoves ?? {}) as Record<string, { moveId: string; turnsRemaining: number }>;
  const playerLock    = playerEntry.activePokemonId ? playerLockMap[playerEntry.activePokemonId.toString()] : null;
  if (playerLock) {
    if (actionType !== 'move') {
      res.status(400).json({ data: null, error: `Your Pokémon is locked into ${slugToDisplayName(playerLock.moveId)} and cannot do anything else!` }); return;
    }
    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId!, actionType: 'move', moveId: playerLock.moveId, targets: [], resolved: false },
      res, { lockedMove: playerLock.moveId },
    );
    return;
  }

  if ((actionType === 'switch' || actionType === 'run') && playerEntry.activePokemonId) {
    const boundCheck = await Pokemon.findById(playerEntry.activePokemonId, 'volatileStatus').lean();
    const isBound = ((boundCheck?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('bound:'));
    if (isBound) { res.status(400).json({ data: null, error: 'Your Pokémon is trapped and cannot switch out or flee!' }); return; }
  }

  if (actionType === 'item') {
    if (!itemId || !targetPokemonId) { res.status(400).json({ data: null, error: 'itemId and targetPokemonId are required for item actions' }); return; }
    if (!mongoose.Types.ObjectId.isValid(targetPokemonId)) { res.status(400).json({ data: null, error: 'Invalid targetPokemonId' }); return; }

    const item = await Item.findOne({ ownerId: userId, itemId }).lean();
    if (!item)                                                      { res.status(400).json({ data: null, error: 'Item not found in your bag' }); return; }
    if (item.pocket !== 'healing' && item.pocket !== 'status_cure' && item.pocket !== 'berry' && item.pocket !== 'battle_boost') { res.status(400).json({ data: null, error: 'That item cannot be used in battle' }); return; }

    const targetObjId   = new mongoose.Types.ObjectId(targetPokemonId);
    const targetPokemon = await Pokemon.findOne({ _id: targetObjId, ownerId: userId, isInParty: true }).lean();
    if (!targetPokemon) { res.status(400).json({ data: null, error: 'Target Pokémon not found in your party' }); return; }

    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'item', moveId: '', itemId, targets: [targetObjId], resolved: false },
      res,
    );
    return;
  }

  if (actionType === 'run') {
    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'run', moveId: '', targets: [], resolved: false },
      res,
    );
    return;
  }

  if (actionType === 'catch') {
    if (battle.type !== 'wild') { res.status(400).json({ data: null, error: 'Catch actions are only valid in wild battles' }); return; }
    if (!battle.wildCatchable)  { res.status(400).json({ data: null, error: 'This wild Pokémon cannot be caught' }); return; }
    if (!itemId)                { res.status(400).json({ data: null, error: 'itemId (Poké Ball) is required for catch actions' }); return; }

    const ballItem = await Item.findOne({ ownerId: userId, itemId }).lean();
    if (!ballItem || ballItem.quantity < 1) { res.status(400).json({ data: null, error: 'You do not have that Poké Ball' }); return; }
    if (ballItem.pocket !== 'pokeballs')    { res.status(400).json({ data: null, error: 'That item is not a Poké Ball' }); return; }

    const wildEntry = targetPokemonId
      ? battle.enemySide.find(e => !e.npcId && e.activePokemonId?.toString() === targetPokemonId)
      : battle.enemySide.find(e => !e.npcId && e.activePokemonId != null);
    if (!wildEntry?.activePokemonId) { res.status(400).json({ data: null, error: 'No active wild Pokémon to catch' }); return; }

    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'catch', moveId: '', itemId, targets: [wildEntry.activePokemonId], resolved: false },
      res,
    );
    return;
  }

  if (actionType === 'switch') {
    const switchToId = parseSwitchToId(switchToPokemonId, playerEntry.activePokemonId, res, 'A valid switchToPokemonId is required for switch actions');
    if (!switchToId) return;
    if (!await validatePlayerSwitchTarget(userId, switchToId, res)) return;

    if (pokemonLimitReached(playerEntry.usedPokemonIds, switchToPokemonId!, battle.playerPokemonLimit)) {
      res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' }); return;
    }

    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId!, actionType: 'switch', moveId: '', switchToPokemonId: switchToId, targets: [], resolved: false },
      res,
    );
    return;
  }

  if (!moveId) { res.status(400).json({ data: null, error: 'moveId is required' }); return; }

  const pokemon = await Pokemon.findOne({ _id: playerEntry.activePokemonId }).lean();
  if (!pokemon) { res.status(404).json({ data: null, error: 'Active Pokémon not found' }); return; }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot)               { res.status(400).json({ data: null, error: 'That move is not on your active Pokémon' }); return; }
  if (moveSlot.currentPP <= 0) { res.status(400).json({ data: null, error: 'That move has no PP remaining' }); return; }

  // Baton Pass needs its incoming Pokémon chosen up front, same as a real switch —
  // unlike every other move, it never enters the interactive targeting phase; it
  // auto-resolves in autoSkipBlockedActors exactly like item/switch actions do.
  if (moveId === 'baton-pass') {
    const switchToId = parseSwitchToId(switchToPokemonId, playerEntry.activePokemonId, res, 'Baton Pass requires a valid switchToPokemonId (who to pass to)');
    if (!switchToId) return;
    if (!await validatePlayerSwitchTarget(userId, switchToId, res)) return;

    if (pokemonLimitReached(playerEntry.usedPokemonIds, switchToPokemonId!, battle.playerPokemonLimit)) {
      res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' }); return;
    }

    await queueActionAndRespond(
      battle,
      { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'move', moveId, switchToPokemonId: switchToId, targets: [], resolved: false },
      res,
    );
    return;
  }

  await queueActionAndRespond(
    battle,
    { actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'move', moveId, targets: [], resolved: false },
    res,
  );
}

export async function submitTarget(req: Request, res: Response): Promise<void> {
  const { targets } = req.body as { targets: string[] };
  const { userId, role } = req.user!;

  if (!Array.isArray(targets)) { res.status(400).json({ data: null, error: 'targets must be an array of Pokémon IDs' }); return; }
  if (!targets.every(t => mongoose.Types.ObjectId.isValid(t))) { res.status(400).json({ data: null, error: 'All target IDs must be valid' }); return; }

  const battle = await Battle.findById(req.params.id);
  if (!battle)                      { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active')   { res.status(400).json({ data: null, error: 'Battle is not active' }); return; }
  if (battle.phase !== 'targeting') { res.status(400).json({ data: null, error: 'Battle is not in targeting phase' }); return; }

  const idx = battle.currentTargetIndex;
  if (idx >= battle.turnQueue.length) { res.status(400).json({ data: null, error: 'No actor is waiting to pick targets' }); return; }

  const currentEntry = battle.turnQueue[idx];
  if (!currentEntry.moveId) { res.status(400).json({ data: null, error: 'Current action does not require target selection' }); return; }

  if (currentEntry.actorType === 'player') {
    if (currentEntry.actorId.toString() !== userId) { res.status(403).json({ data: null, error: 'It is not your turn to pick targets' }); return; }
  } else {
    if (role !== 'dm' && role !== 'admin') { res.status(403).json({ data: null, error: 'Only the DM can pick targets for NPCs' }); return; }
  }

  if (targets.length === 0 && !NO_TARGET_MOVE_IDS.has(currentEntry.moveId)) {
    res.status(400).json({ data: null, error: 'targets must be a non-empty array of Pokémon IDs' }); return;
  }

  // Which side the acting Pokémon belongs to — NOT the same thing as actorType.
  // In pvp, the opposing trainer's entries live on enemySide but are still actorType 'player'.
  const actingSide: 'playerSide' | 'enemySide' = currentEntry.actorType === 'npc'
    ? 'enemySide'
    : (findOwnSideEntry(battle, currentEntry.actorId.toString())?.side ?? 'playerSide');
  const ownEntries = actingSide === 'playerSide' ? battle.playerSide : battle.enemySide;
  const foeEntries  = actingSide === 'playerSide' ? battle.enemySide : battle.playerSide;
  const allyIds = ownEntries
    .filter(e => e.activePokemonId != null && e.activePokemonId.toString() !== currentEntry.activePokemonId.toString())
    .map(e => e.activePokemonId!.toString());
  const foeIds = foeEntries.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!.toString());

  const validTargetIds = ALLY_ONLY_MOVES.has(currentEntry.moveId)
    ? allyIds
    : ALLY_OR_FOE_MOVES.has(currentEntry.moveId)
    ? [...allyIds, ...foeIds]
    : foeIds;

  const invalidTargets = targets.filter(t => !validTargetIds.includes(t));
  if (invalidTargets.length > 0) { res.status(400).json({ data: null, error: 'One or more targets are not valid for this move' }); return; }

  // Follow Me / Rage Powder — redirect single-target foe moves to the redirector,
  // regardless of what was clicked. Never applies to ally-targeting or self-targeting
  // moves (those never had a foe target to begin with).
  let effectiveTargets = targets;
  if (targets.length === 1 && !ALLY_ONLY_MOVES.has(currentEntry.moveId) && !ALLY_OR_FOE_MOVES.has(currentEntry.moveId) && !SELF_TARGETING_MOVES.has(currentEntry.moveId)) {
    const redirected = await resolveRedirectTarget(battle, { activePokemonId: currentEntry.activePokemonId, moveId: currentEntry.moveId }, actingSide);
    if (redirected) effectiveTargets = [redirected];
  }

  const targetPokemons = await Pokemon.find({ _id: { $in: effectiveTargets } }, 'currentHp volatileStatus').lean();
  const fainted = targetPokemons.filter(p => p.currentHp <= 0);
  if (fainted.length > 0) { res.status(400).json({ data: null, error: 'Cannot target a fainted Pokémon' }); return; }

  const targetHpMap = new Map(targetPokemons.map(p => [p._id.toString(), p.currentHp]));

  const enduringTargets = new Set(
    targetPokemons
      .filter(p => ((p.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'enduring'))
      .map(p => p._id.toString()),
  );

  const protectingTargets = new Map(
    targetPokemons.map(p => {
      const vol     = (p.volatileStatus as Array<{ condition: string }>) ?? [];
      const protVol = vol.find(v => v.condition.startsWith('protecting'));
      return [p._id.toString(), protVol?.condition ?? null];
    }),
  );

  const substituteTargets = new Map(
    targetPokemons.map(p => {
      const vol    = (p.volatileStatus as Array<{ condition: string }>) ?? [];
      const subVol = vol.find(v => v.condition.startsWith('substitute:'));
      return [p._id.toString(), subVol ? Number(subVol.condition.split(':')[1]) || 0 : 0];
    }),
  );

  battle.turnQueue[idx].targets = effectiveTargets.map(t => new mongoose.Types.ObjectId(t));

  const { hitSelf, events: confusionEvents } = await checkConfusion(battle, currentEntry.activePokemonId);
  const moveEvents: string[] = [...confusionEvents];

  // Written to by resolveDamagingMove whenever it reassigns the acting move (Metronome's
  // reroll, Copycat's copy) — defaults to the submitted moveId for every other path.
  const resolvedMoveId = { value: currentEntry.moveId };

  if (!hitSelf) {
    const weatherEffect = WEATHER_MOVES[currentEntry.moveId];
    if (weatherEffect) {
      await resolveWeatherMove(battle, currentEntry as unknown as ActiveEntry, weatherEffect, moveEvents);
    } else if (SELF_TARGETING_MOVES.has(currentEntry.moveId)) {
      await resolveSelfTargetMove(battle, currentEntry as unknown as ActiveEntry, moveEvents);
    } else if (ALLY_ONLY_MOVES.has(currentEntry.moveId) || ALLY_OR_FOE_MOVES.has(currentEntry.moveId)) {
      await resolveAllyTargetMove(battle, currentEntry as unknown as ActiveEntry, effectiveTargets[0], moveEvents);
    } else {
      const defendingSide = actingSide === 'playerSide' ? 'enemySide' : 'playerSide';
      const fieldConds = (battle.fieldConditions ?? []) as Array<{ condition: string; turnsRemaining: number }>;
      const sideGuard = {
        wideGuard:   fieldConds.some(f => f.condition === `wide-guard:${defendingSide}`),
        quickGuard:  fieldConds.some(f => f.condition === `quick-guard:${defendingSide}`),
        reflect:     fieldConds.some(f => f.condition === `reflect:${defendingSide}`),
        lightScreen: fieldConds.some(f => f.condition === `light-screen:${defendingSide}`),
        auroraVeil:  fieldConds.some(f => f.condition === `aurora-veil:${defendingSide}`),
      };
      await resolveDamagingMove(battle, currentEntry as unknown as ActiveEntry, effectiveTargets, targetHpMap, enduringTargets, protectingTargets, moveEvents, sideGuard, substituteTargets, resolvedMoveId);
    }

    // Sketch/Copycat tracking — recorded under the move that ACTUALLY executed
    // (resolvedMoveId.value), not the submitted wrapper name.
    const lastMoveMap = (battle.lastMoveByPokemon ?? {}) as Record<string, string>;
    lastMoveMap[currentEntry.activePokemonId.toString()] = resolvedMoveId.value;
    battle.lastMoveByPokemon = lastMoveMap;
    battle.markModified('lastMoveByPokemon');
    battle.globalLastMoveUsed = resolvedMoveId.value;

    // Choice item lock (milestone 5.17b) — Choice Band/Specs/Scarf permanently lock
    // the holder into whichever move they just used until they switch out. Reuses
    // the same lockedMoves map LOCK_MOVES multi-turn moves (Outrage/Thrash/etc.)
    // already write to, with the turnsRemaining:99 "persists until cleared"
    // sentinel used elsewhere in this project — already cleaned up on switch-out/
    // faint by the three existing lockedMoves deletion sites, no new cleanup code
    // needed. Skipped whenever a lock entry already exists for this Pokémon this
    // turn: a LOCK_MOVES-driven lock's own countdown must keep decrementing
    // normally rather than being overwritten with a permanent one; once that
    // countdown naturally expires, the next freely-chosen move re-locks on its own.
    const lockKey = currentEntry.activePokemonId.toString();
    const lockedMovesMap = (battle.lockedMoves ?? {}) as Record<string, { moveId: string; turnsRemaining: number }>;
    if (!lockedMovesMap[lockKey]) {
      const holder = await Pokemon.findById(currentEntry.activePokemonId, 'heldItem').lean();
      if (holder?.heldItem && CHOICE_ITEMS.has(holder.heldItem)) {
        lockedMovesMap[lockKey] = { moveId: resolvedMoveId.value, turnsRemaining: 99 };
        battle.lockedMoves = lockedMovesMap;
        battle.markModified('lockedMoves');
      }
    }

    await Pokemon.updateOne(
      { _id: currentEntry.activePokemonId, moves: { $elemMatch: { moveId: currentEntry.moveId, currentPP: { $gt: 0 } } } },
      { $inc: { 'moves.$.currentPP': -1 } },
    );
  }

  battle.turnQueue[idx].resolved = true;
  appendToLog(battle, ...moveEvents);

  const faintEvents = await applyFaints(battle, currentEntry.actorId, currentEntry.actorType);
  const endEvents   = await checkBattleEnd(battle);
  appendToLog(battle, ...faintEvents, ...endEvents);

  battle.currentTargetIndex = idx + 1;
  if (endEvents.length === 0) await autoSkipBlockedActors(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { phase: battle.phase, currentTargetIndex: battle.currentTargetIndex }, error: null });
}

export async function getDmBattles(req: Request, res: Response): Promise<void> {
  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) { res.json({ data: [], error: null }); return; }
  const battles = await Battle.find({ campaignId: campaign._id, status: { $ne: 'complete' } }).sort({ lastUpdatedAt: -1 }).lean();
  res.json({ data: battles.map(b => ({ _id: b._id, type: b.type, status: b.status, turnNumber: b.turnNumber, lastUpdatedAt: b.lastUpdatedAt })), error: null });
}

export async function getActiveBattle(req: Request, res: Response): Promise<void> {
  const userId = new mongoose.Types.ObjectId(req.user!.userId);
  const battle = await Battle.findOne({
    $or: [{ 'playerSide.userId': userId }, { 'enemySide.userId': userId }],
    status: { $ne: 'complete' },
  }).sort({ lastUpdatedAt: -1 }).lean();
  if (!battle) { res.json({ data: null, error: null }); return; }
  res.json({ data: { _id: battle._id, status: battle.status, type: battle.type, turnNumber: battle.turnNumber, lastUpdatedAt: battle.lastUpdatedAt }, error: null });
}

export async function getBattleState(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;

  const battle = await Battle.findById(id).lean();
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }

  // enemySide only carries userIds in pvp battles — harmless no-op filter otherwise.
  const enemyUserIds = battle.enemySide.map(e => e.userId).filter((id): id is mongoose.Types.ObjectId => id != null);
  const userIds      = [...battle.playerSide.map(entry => entry.userId), ...enemyUserIds];
  const users        = await User.find({ _id: { $in: userIds } }, 'username').lean();
  const usernameMap  = new Map(users.map(u => [u._id.toString(), u.username]));

  const allActivePokemonIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((pid): pid is mongoose.Types.ObjectId => pid != null);

  const activePokemons = allActivePokemonIds.length > 0
    ? await Pokemon.find({ _id: { $in: allActivePokemonIds } }, 'ownerId ownerType nickname speciesId currentHp level nature statusCondition volatileStatus moves evs').lean()
    : [];

  const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types').lean()
    : [];

  const pokemonMap = new Map(activePokemons.map(p => [p._id.toString(), p]));
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const stageMap   = (battle.statStages ?? {}) as Record<string, StatStages>;

  // Batch the owners' Trainer IV spreads once per poll rather than per Pokémon.
  const playerOwnerIds = [...new Set(activePokemons.filter(p => p.ownerType === 'player').map(p => (p.ownerId as mongoose.Types.ObjectId).toString()))];
  const ivOwners = playerOwnerIds.length > 0 ? await User.find({ _id: { $in: playerOwnerIds } }, 'trainerStats').lean() : [];
  const ivsMap   = new Map(ivOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));
  const pokeIvs  = (poke: { ownerId: mongoose.Types.ObjectId; ownerType: string }): BaseStats =>
    poke.ownerType === 'player' ? (ivsMap.get(poke.ownerId.toString()) ?? ZERO_IVS) : ZERO_IVS;

  const buildInfo = (pokemonId: mongoose.Types.ObjectId | null) => {
    if (!pokemonId) return null;
    const poke = pokemonMap.get(pokemonId.toString());
    if (!poke) return null;
    const cache       = cacheMap.get(poke.speciesId);
    const speciesName = cache?.name ?? `#${poke.speciesId}`;
    const maxHp       = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, pokeIvs(poke)).hp : null;
    return {
      _id:             poke._id.toString(),
      name:            poke.nickname ?? speciesName,
      speciesName,
      speciesId:       poke.speciesId,
      level:           poke.level,
      types:           getEffectiveTypes(battle, pokemonId.toString(), (cache?.types as string[] | undefined) ?? []),
      currentHp:       poke.currentHp,
      maxHp,
      statusCondition: poke.statusCondition ?? null,
      isConfused:      poke.volatileStatus.some(v => v.condition === 'confusion'),
      moves:           (poke as any).moves as Array<{ moveId: string; currentPP: number; maxPP: number }> | undefined,
      statStages:      stageMap[pokemonId.toString()] ?? null,
    };
  };

  const playerSideWithNames = battle.playerSide.map(entry => ({
    ...entry,
    username:            usernameMap.get(entry.userId.toString()) ?? 'Unknown',
    activePokemonInfo:   buildInfo(entry.activePokemonId),
    usedPokemonCount:    entry.usedPokemonIds.length,
    pokemonLimitReached: battle.playerPokemonLimit !== null && entry.usedPokemonIds.length >= battle.playerPokemonLimit,
  }));

  const npcIds = battle.enemySide.map(e => e.npcId).filter((id): id is mongoose.Types.ObjectId => id != null);
  const npcs   = npcIds.length > 0 ? await Npc.find({ _id: { $in: npcIds } }, 'name').lean() : [];
  const npcNameMap = new Map(npcs.map(n => [(n._id as mongoose.Types.ObjectId).toString(), n.name]));

  const enemySideWithInfo = battle.enemySide.map(entry => ({
    ...entry,
    npcName: entry.npcId
      ? (npcNameMap.get(entry.npcId.toString()) ?? 'NPC')
      : entry.userId
        ? (usernameMap.get(entry.userId.toString()) ?? 'Unknown')
        : 'Wild Pokémon',
    // Only meaningful for pvp (a real trainer roster on enemySide) — mirrors playerSide's fields.
    username:            entry.userId ? (usernameMap.get(entry.userId.toString()) ?? 'Unknown') : undefined,
    usedPokemonCount:    entry.usedPokemonIds?.length ?? 0,
    pokemonLimitReached: battle.playerPokemonLimit !== null && (entry.usedPokemonIds?.length ?? 0) >= battle.playerPokemonLimit,
    activePokemonInfo:   buildInfo(entry.activePokemonId),
    faintedCount:        entry.fainted.length,
    npcLimitReached:     battle.npcPokemonLimit !== null && entry.fainted.length >= battle.npcPokemonLimit,
  }));

  let currentMoveTargetCategory: 'single' | 'auto' | null = null;
  let currentMoveAllyTarget: 'ally-only' | 'ally-or-foe' | null = null;
  let currentMoveAllyIds: string[] = [];
  if (battle.phase === 'targeting' && battle.currentTargetIndex < battle.turnQueue.length) {
    const currentEntry = battle.turnQueue[battle.currentTargetIndex];
    if (currentEntry.moveId && currentEntry.activePokemonId) {
      const actorPoke = pokemonMap.get(currentEntry.activePokemonId.toString());
      if (actorPoke) {
        const moveCache = await PokedexCache.findOne(
          { pokeApiId: actorPoke.speciesId, 'moves.name': currentEntry.moveId },
          { 'moves.$': 1 },
        ).lean();
        const moveTarget = (moveCache?.moves?.[0] as any)?.target ?? '';
        if (moveTarget) currentMoveTargetCategory = getMoveTargetCategory(moveTarget);
      }

      if (ALLY_ONLY_MOVES.has(currentEntry.moveId) || ALLY_OR_FOE_MOVES.has(currentEntry.moveId)) {
        currentMoveAllyTarget = ALLY_ONLY_MOVES.has(currentEntry.moveId) ? 'ally-only' : 'ally-or-foe';
        // battle here is a .lean() read, not a HydratedDocument, so findOwnSideEntry
        // (which expects the latter) can't be reused — inline the same side lookup.
        const actingSideForAlly: 'playerSide' | 'enemySide' = currentEntry.actorType === 'npc'
          ? 'enemySide'
          : (battle.playerSide.some(e => e.userId?.toString() === currentEntry.actorId.toString()) ? 'playerSide' : 'enemySide');
        const ownEntriesForAlly = actingSideForAlly === 'playerSide' ? battle.playerSide : battle.enemySide;
        currentMoveAllyIds = ownEntriesForAlly
          .filter(e => e.activePokemonId != null && e.activePokemonId.toString() !== currentEntry.activePokemonId!.toString())
          .map(e => e.activePokemonId!.toString());
      }
    }
  }

  res.json({
    data: {
      ...battle,
      playerSide:                playerSideWithNames,
      enemySide:                 enemySideWithInfo,
      noTargetMoveIds:           [...NO_TARGET_MOVE_IDS],
      currentMoveTargetCategory,
      currentMoveAllyTarget,
      currentMoveAllyIds,
      wildCatchable:             battle.wildCatchable,
    },
    error: null,
  });
}

export async function dmSendOut(req: Request, res: Response): Promise<void> {
  const { npcId, pokemonId, slotIndex = 0 } = req.body as {
    npcId: string;
    pokemonId: string;
    slotIndex?: number;
  };

  if (!npcId || !pokemonId || !mongoose.Types.ObjectId.isValid(npcId) || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Valid npcId and pokemonId are required' }); return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle)                                                       { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') { res.status(400).json({ data: null, error: 'Battle is not in move submission phase' }); return; }

  const npcEntries = battle.enemySide.filter(e => e.npcId?.toString() === npcId);
  if (npcEntries.length === 0) { res.status(404).json({ data: null, error: 'NPC not found in this battle' }); return; }
  if (slotIndex < 0 || slotIndex >= npcEntries.length) {
    res.status(400).json({ data: null, error: `slotIndex must be between 0 and ${npcEntries.length - 1}` }); return;
  }
  const npcEntry = npcEntries[slotIndex];

  const pokeId  = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({ _id: pokeId, ownerId: new mongoose.Types.ObjectId(npcId), ownerType: 'npc' }).lean();
  if (!pokemon)               { res.status(404).json({ data: null, error: 'Pokémon not found for this NPC' }); return; }
  if (pokemon.currentHp <= 0) { res.status(400).json({ data: null, error: 'That Pokémon has fainted' }); return; }

  const alreadyActiveInAnotherSlot = battle.enemySide.some(
    e => e.npcId?.toString() === npcId && e.activePokemonId?.toString() === pokemonId && e !== npcEntry,
  );
  if (alreadyActiveInAnotherSlot) { res.status(400).json({ data: null, error: 'That Pokémon is already active in another slot' }); return; }

  const outgoingNpcId = npcEntry.activePokemonId;
  if (outgoingNpcId && outgoingNpcId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingNpcId }, { $set: { volatileStatus: [] } });
  }

  npcEntry.activePokemonId = pokeId;
  await finishSendOut(battle, pokeId, 'enemy', 'enemySide', 'npcId', new mongoose.Types.ObjectId(npcId));

  res.json({ data: { activePokemonId: pokemonId }, error: null });
}

export async function dmSubmitMove(req: Request, res: Response): Promise<void> {
  const { npcId, moveId, actionType = 'move', switchToPokemonId, activePokemonId: slotPokemonId, itemId, targetPokemonId } =
    req.body as {
      npcId: string;
      moveId?: string;
      actionType?: 'move' | 'switch' | 'item';
      switchToPokemonId?: string;
      activePokemonId?: string;
      itemId?: string;
      targetPokemonId?: string;
    };

  if (!npcId) { res.status(400).json({ data: null, error: 'npcId is required' }); return; }

  const battle = await Battle.findById(req.params.id);
  if (!battle)                                                          { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') { res.status(400).json({ data: null, error: 'Battle is not in move submission phase' }); return; }

  const npcEntry = battle.type === 'wild'
    ? battle.enemySide.find(e => e.activePokemonId?.toString() === npcId)
    : slotPokemonId
      ? battle.enemySide.find(e => e.npcId?.toString() === npcId && e.activePokemonId?.toString() === slotPokemonId)
      : battle.enemySide.find(e => e.npcId?.toString() === npcId);
  if (!npcEntry) { res.status(404).json({ data: null, error: 'NPC not found in this battle' }); return; }

  const alreadySubmitted = slotPokemonId
    ? battle.turnQueue.some(e => e.actorId.toString() === npcId && e.activePokemonId?.toString() === slotPokemonId && e.actorType === 'npc')
    : battle.turnQueue.some(e => e.actorId.toString() === npcId && e.actorType === 'npc');
  if (alreadySubmitted) { res.status(400).json({ data: null, error: 'This NPC slot has already submitted a move this turn' }); return; }

  // If this Pokémon is locked into a move, block all other actions and force that move.
  const npcLockMap = (battle.lockedMoves ?? {}) as Record<string, { moveId: string; turnsRemaining: number }>;
  const npcLock    = npcEntry.activePokemonId ? npcLockMap[npcEntry.activePokemonId.toString()] : null;
  if (npcLock) {
    if (actionType !== 'move') {
      res.status(400).json({ data: null, error: `This Pokémon is locked into ${slugToDisplayName(npcLock.moveId)} and cannot do anything else!` }); return;
    }
    if (!npcEntry.activePokemonId) { res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon' }); return; }
    await queueActionAndRespond(
      battle,
      { actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'move', moveId: npcLock.moveId, targets: [], resolved: false },
      res, { lockedMove: npcLock.moveId },
    );
    return;
  }

  if (actionType === 'switch' && npcEntry.activePokemonId) {
    const boundCheck = await Pokemon.findById(npcEntry.activePokemonId, 'volatileStatus').lean();
    const isBound = ((boundCheck?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition.startsWith('bound:'));
    if (isBound) { res.status(400).json({ data: null, error: 'This Pokémon is trapped and cannot switch out!' }); return; }
  }

  if (battle.type === 'wild' && actionType === 'switch') { res.status(400).json({ data: null, error: 'Wild Pokémon cannot switch' }); return; }

  if (actionType === 'item') {
    if (!itemId)                                                                          { res.status(400).json({ data: null, error: 'itemId is required for item actions' }); return; }
    if (!targetPokemonId || !mongoose.Types.ObjectId.isValid(targetPokemonId))            { res.status(400).json({ data: null, error: 'A valid targetPokemonId is required for item actions' }); return; }
    if (!npcEntry.activePokemonId)                                                        { res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' }); return; }

    const npcObjId = new mongoose.Types.ObjectId(npcId);
    const bagItem  = await Item.findOne({ ownerId: npcObjId, itemId }).lean();
    if (!bagItem || bagItem.quantity < 1) { res.status(400).json({ data: null, error: 'Item not found in NPC bag' }); return; }

    await queueActionAndRespond(
      battle,
      { actorId: npcObjId, actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'item', itemId, targets: [new mongoose.Types.ObjectId(targetPokemonId)], resolved: false },
      res,
    );
    return;
  }

  if (actionType === 'switch') {
    const switchToId = parseSwitchToId(switchToPokemonId, npcEntry.activePokemonId, res, 'A valid switchToPokemonId is required for switch actions');
    if (!switchToId) return;
    if (!await validateNpcSwitchTarget(npcId, switchToPokemonId!, res)) return;

    const activePokemonId = npcEntry.activePokemonId ?? switchToId;
    await queueActionAndRespond(
      battle,
      { actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId, actionType: 'switch', switchToPokemonId: switchToId, targets: [], resolved: false },
      res,
    );
    return;
  }

  if (!moveId)                  { res.status(400).json({ data: null, error: 'moveId is required for move actions' }); return; }
  if (!npcEntry.activePokemonId) { res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' }); return; }

  const pokemon = await Pokemon.findOne({ _id: npcEntry.activePokemonId }).lean();
  if (!pokemon) { res.status(404).json({ data: null, error: 'NPC active Pokémon not found' }); return; }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot)               { res.status(400).json({ data: null, error: "That move is not on the NPC's active Pokémon" }); return; }
  if (moveSlot.currentPP <= 0) { res.status(400).json({ data: null, error: 'That move has no PP remaining' }); return; }

  // See submitMove — Baton Pass needs its incoming Pokémon chosen up front and
  // auto-resolves like a switch, never entering the interactive targeting phase.
  if (moveId === 'baton-pass') {
    const switchToId = parseSwitchToId(switchToPokemonId, npcEntry.activePokemonId, res, 'Baton Pass requires a valid switchToPokemonId (who to pass to)');
    if (!switchToId) return;
    if (!await validateNpcSwitchTarget(npcId, switchToPokemonId!, res)) return;

    await queueActionAndRespond(
      battle,
      { actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'move', moveId, switchToPokemonId: switchToId, targets: [], resolved: false },
      res,
    );
    return;
  }

  await queueActionAndRespond(
    battle,
    { actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'move', moveId, targets: [], resolved: false },
    res,
  );
}

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

export async function dmAutoSubmit(req: Request, res: Response): Promise<void> {
  const battle = await Battle.findById(req.params.id);
  if (!battle)                                                          { res.status(404).json({ data: null, error: 'Battle not found' }); return; }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') { res.status(400).json({ data: null, error: 'Battle is not in move submission phase' }); return; }

  let submitted = 0;

  for (const slot of battle.enemySide) {
    if (!slot.activePokemonId) continue;

    const isWild  = !slot.npcId;
    const actorId = isWild ? slot.activePokemonId : slot.npcId!;

    const alreadySubmitted = battle.turnQueue.some(
      e => e.actorId.toString() === actorId.toString()
        && e.actorType === 'npc'
        && e.activePokemonId?.toString() === slot.activePokemonId!.toString(),
    );
    if (alreadySubmitted) continue;

    const poke = await Pokemon.findById(slot.activePokemonId, 'moves currentHp nature level speciesId hasHiddenAbility evs heldItem').lean();
    if (!poke) continue;

    const movesWithPP = (poke.moves as { moveId: string; currentPP: number; maxPP: number }[]).filter(m => m.currentPP > 0);
    if (movesWithPP.length === 0) continue;

    type AiStrategy = 'random' | 'optimal' | 'defensive' | 'custom';
    const npcDoc = (!isWild && slot.npcId) ? await Npc.findById(slot.npcId, 'aiStrategy').lean() : null;
    const strategy: AiStrategy = (npcDoc?.aiStrategy as AiStrategy | undefined) ?? 'random';
    const actorObjId = new mongoose.Types.ObjectId(actorId.toString());

    if (strategy === 'defensive') {
      const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'baseStats').lean();
      const maxHp = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs as BaseStats, ZERO_IVS).hp : poke.currentHp;

      if (poke.currentHp < Math.floor(maxHp * 0.3)) {
        const healItem = await Item.findOne({ ownerId: actorObjId, ownerType: 'npc', pocket: 'healing', quantity: { $gt: 0 } }).lean();
        if (healItem) {
          battle.turnQueue.push({ actorId: actorObjId, actorType: 'npc', activePokemonId: slot.activePokemonId!, actionType: 'item', itemId: healItem.itemId, targets: [slot.activePokemonId!], resolved: false });
          submitted++; continue;
        }
        const restSlot = movesWithPP.find(m => m.moveId === 'rest');
        if (restSlot) {
          battle.turnQueue.push({ actorId: actorObjId, actorType: 'npc', activePokemonId: slot.activePokemonId!, actionType: 'move', moveId: 'rest', targets: [], resolved: false });
          submitted++; continue;
        }
      }
    }

    let chosenMoveId: string;

    if (strategy === 'optimal') {
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
      // batch the owners once per NPC decision (keyed via playerSide, no extra Pokemon field needed).
      const pokeIdToUserId = new Map(battle.playerSide.filter(e => e.activePokemonId != null).map(e => [e.activePokemonId!.toString(), e.userId.toString()]));
      const targetUserIds  = [...new Set(targetPokes.map(t => pokeIdToUserId.get(t._id.toString())).filter((id): id is string => !!id))];
      const targetOwners   = targetUserIds.length > 0 ? await User.find({ _id: { $in: targetUserIds } }, 'trainerStats').lean() : [];
      const targetIvsMap   = new Map(targetOwners.map(u => [u._id.toString(), ivsFromSpread(u.trainerStats)]));

      let bestScore = -1;
      for (const mv of movesWithPP) {
        if (NO_TARGET_MOVE_IDS.has(mv.moveId)) continue;
        for (const tgt of targetPokes) {
          const tCache = cacheBySpecies.get(tgt.speciesId);
          if (!tCache) continue;
          const tAbility = getEffectiveAbilitySlugs(battle, tgt._id.toString(), tCache.abilities as CachedAbility[], tgt.hasHiddenAbility ?? false)[0] ?? null;
          const targetIvs = targetIvsMap.get(pokeIdToUserId.get(tgt._id.toString()) ?? '') ?? ZERO_IVS;
          const score = await estimateDamage(poke, atkCache ?? { name: poke.speciesId }, atkAbility, mv.moveId, tgt, tCache, tAbility, battle.weather as string | null, ZERO_IVS, targetIvs);
          if (score > bestScore) { bestScore = score; chosenMoveId = mv.moveId; }
        }
      }
      chosenMoveId ??= movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
    } else {
      chosenMoveId = movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
    }

    battle.turnQueue.push({ actorId: actorObjId, actorType: 'npc', activePokemonId: slot.activePokemonId!, actionType: 'move', moveId: chosenMoveId, targets: [], resolved: false });
    submitted++;
  }

  if (submitted > 0) await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted, phase: battle.phase }, error: null });
}
