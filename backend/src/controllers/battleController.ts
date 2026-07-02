import { Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { Battle, IBattle, StatStages, TurnQueueEntry } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Npc } from '../models/Npc';
import { Item } from '../models/Item';
import { computeStats, expForLevel, BaseStats, NATURES } from '../lib/statCalc';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field } from '@smogon/calc';
import { canEvolve } from '../lib/evolution';
import { BATTLE_ITEM_EFFECTS, BALL_MODIFIERS, statusCatchModifier } from '../lib/itemData';
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
} from '../lib/moveData';
import {
  GEN9,
  type CachedAbility,
  slugToDisplayName,
  pokeDisplayName,
  toCalcWeather,
  toCalcStatus,
  resolveAbilitySlug,
  applyStatStageEffects,
  accuracyStageMultiplier,
  cap,
  ZERO_STATS,
  appendToLog,
} from '../lib/battleCalc';
import {
  StatusCondition,
  STATUS_IMMUNITY_ABILITIES,
  ILATE_MAP,
  PINCH_ABILITIES,
  WEATHER_SPEED_DOUBLERS,
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

export async function createBattle(req: Request, res: Response): Promise<void> {
  const {
    type, playerIds, npcIds = [], playerPokemonLimit = null, npcPokemonLimit = null,
    wildPokemon, wildCatchable = true,
  } = req.body as {
    type: string;
    playerIds: string[];
    npcIds?: string[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    wildPokemon?: { speciesId: number; level: number };
    wildCatchable?: boolean;
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

  if (npcIds.length > 0) {
    const foundNpcs = await Npc.find({ _id: { $in: npcIds }, campaignId: campaign._id }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(400).json({ data: null, error: 'One or more NPCs were not found in your campaign' });
      return;
    }
  }

  type EnemySlot = { npcId?: mongoose.Types.ObjectId; activePokemonId: mongoose.Types.ObjectId | null; fainted: mongoose.Types.ObjectId[] };
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
      return { moveId: m.moveId, currentPP: pp, maxPP: pp };
    });

    const stats = computeStats(species.baseStats as BaseStats, level, nature);
    const wildPoke = await Pokemon.create({
      speciesId: species.pokeApiId, ownerId: new mongoose.Types.ObjectId(req.user!.userId),
      ownerType: 'wild', nickname: null, level,
      exp: expForLevel(level, (species.expGroup as string) || 'medium-fast'),
      currentHp: stats.hp, nature, gender, heldItem: null, moves,
      evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      statusCondition: null, statusCounter: null, volatileStatus: [],
      evolutionOverrides: [], isInParty: false, partySlot: null,
      caughtAt: null, caughtByPlayerId: null,
    });
    enemySide = [{ activePokemonId: wildPoke._id as mongoose.Types.ObjectId, fainted: [] }];
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

async function resolveItemAction(entry: TurnQueueEntry): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;
  if (!itemId || targets.length === 0) return events;
  const effect = BATTLE_ITEM_EFFECTS[itemId];
  if (!effect) return events;
  const targetId = targets[0];
  const pokemon = await Pokemon.findById(targetId, 'nickname speciesId level nature currentHp statusCondition').lean();
  if (!pokemon) return events;
  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }, 'name baseStats').lean();
  const displayName = pokeDisplayName(pokemon, cache);
  const maxHp = cache ? computeStats(cache.baseStats as BaseStats, pokemon.level, pokemon.nature).hp : pokemon.currentHp;
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
  const ability = (poke.hasHiddenAbility as boolean)
    ? (abilities.find(a => a.isHidden) ?? abilities.find(a => !a.isHidden))
    : abilities.find(a => !a.isHidden);
  if (!ability) return [];
  const pokeName = pokeDisplayName(poke, cache);
  const abilitySlug = ability.name;
  const abilityName = slugToDisplayName(abilitySlug);
  const events: string[] = [];

  const entryWeather = ENTRY_ABILITY_WEATHER[abilitySlug];
  if (entryWeather) {
    if (battle.weather !== entryWeather) {
      if (battle.weather) {
        battle.weather = null; battle.weatherTurnsRemaining = null;
        events.push(`${pokeName}'s ${abilityName}! The weather cleared!`);
      } else {
        battle.weather = entryWeather; battle.weatherTurnsRemaining = null;
        events.push(`${pokeName}'s ${abilityName}! ${ENTRY_WEATHER_MESSAGES[entryWeather]}`);
      }
    }
  }

  if (abilitySlug === 'intimidate') {
    const stageMap = battle.statStages as Record<string, StatStages>;
    const opposingSide = incomingSide === 'player' ? battle.enemySide : battle.playerSide;
    if (opposingSide.some(e => e.activePokemonId)) {
      events.push(`${pokeName}'s ${abilityName}!`);
      for (const entry of opposingSide) {
        if (!entry.activePokemonId) continue;
        const targetId = entry.activePokemonId.toString();
        const target = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId hasHiddenAbility').lean();
        const tgtCache = target ? await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name abilities').lean() : null;
        const targetName = pokeDisplayName(target, tgtCache);
        const tgtAbility = target && tgtCache ? resolveAbilitySlug((tgtCache.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean) : null;
        events.push(...applyStatStageEffects(stageMap, targetId, [{ stat: 'atk', stages: -1, target: 'foe' }], targetName, tgtAbility));
        if (tgtAbility === 'competitive' || tgtAbility === 'defiant') {
          const reactionStat: keyof StatStages = tgtAbility === 'competitive' ? 'spa' : 'atk';
          events.push(`${targetName}'s ${slugToDisplayName(tgtAbility)}!`);
          events.push(...applyStatStageEffects(stageMap, targetId, [{ stat: reactionStat, stages: 2, target: 'self' }], targetName));
        }
      }
      battle.markModified('statStages');
    }
  }
  return events;
}

async function applySwitchOutAbilities(
  pokemonId: string, outgoing: Record<string, unknown> | null, outCache: Record<string, unknown> | null, outName: string,
): Promise<string[]> {
  if (!outgoing || !outCache) return [];
  const abilitySlug = resolveAbilitySlug((outCache.abilities as CachedAbility[]) ?? [], (outgoing.hasHiddenAbility as boolean) ?? false);
  if (!abilitySlug) return [];
  const events: string[] = [];
  if (abilitySlug === 'natural-cure' && outgoing.statusCondition) {
    await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCondition: null, statusCounter: null } });
    events.push(`${outName}'s Natural Cure! ${outName}'s status was cured!`);
  }
  if (abilitySlug === 'regenerator') {
    const maxHp = computeStats(outCache.baseStats as BaseStats, outgoing.level as number, outgoing.nature as string).hp;
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

async function recallPokemon(battle: HydratedDocument<IBattle>, outgoingId: mongoose.Types.ObjectId): Promise<string[]> {
  await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  delete (battle.statStages as Record<string, StatStages>)[outgoingId.toString()];
  battle.markModified('statStages');
  delete (battle.consecutiveMoves as Record<string, unknown>)[outgoingId.toString()];
  battle.markModified('consecutiveMoves');
  delete (battle.lockedMoves as Record<string, unknown>)[outgoingId.toString()];
  battle.markModified('lockedMoves');
  const outgoing = await Pokemon.findById(outgoingId, 'nickname speciesId hasHiddenAbility statusCondition currentHp nature level').lean();
  const outCache = outgoing ? await PokedexCache.findOne({ pokeApiId: outgoing.speciesId }, 'name abilities baseStats').lean() : null;
  const outName = pokeDisplayName(outgoing, outCache);
  const events = [`${outName} was recalled!`];
  events.push(...await applySwitchOutAbilities(outgoingId.toString(), outgoing, outCache, outName));
  return events;
}

async function resolveSwitch(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  if (!entry.switchToPokemonId) return [];
  const incomingId = entry.switchToPokemonId;
  const events: string[] = [];

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
  } else {
    const playerEntry = battle.playerSide.find(e => e.userId.toString() === entry.actorId.toString());
    if (!playerEntry) return [];
    const outgoingId = playerEntry.activePokemonId;
    if (outgoingId) events.push(...await recallPokemon(battle, outgoingId));
    playerEntry.activePokemonId = incomingId;
    playerEntry.activeSentOutOnTurn = battle.turnNumber;
    battle.markModified('playerSide');
    await Battle.updateOne(
      { _id: battle._id, 'playerSide.userId': playerEntry.userId },
      { $set: { 'playerSide.$.activeSentOutOnTurn': battle.turnNumber } },
    );
    if (!playerEntry.usedPokemonIds.some(id => id.toString() === incomingId.toString())) {
      playerEntry.usedPokemonIds.push(incomingId);
    }
  }

  const incoming = await Pokemon.findById(incomingId, 'nickname speciesId').lean();
  const inCache = incoming ? await PokedexCache.findOne({ pokeApiId: incoming.speciesId }, 'name').lean() : null;
  events.push(`${pokeDisplayName(incoming, inCache)} was sent out!`);
  events.push(...await applyEntryAbilities(battle, incomingId, entry.actorType === 'npc' ? 'enemy' : 'player'));
  return events;
}

async function resolveCatchAction(battle: HydratedDocument<IBattle>, entry: TurnQueueEntry): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;
  if (!itemId || targets.length === 0) return events;

  const wildPoke = await Pokemon.findById(targets[0], 'nickname speciesId level nature currentHp statusCondition moves').lean();
  if (!wildPoke || wildPoke.currentHp <= 0) { events.push('The wild Pokémon has already fainted!'); return events; }

  const cache = await PokedexCache.findOne({ pokeApiId: wildPoke.speciesId }, 'name baseStats catchRate types').lean();
  const speciesName = cache ? slugToDisplayName(cache.name as string) : 'Wild Pokémon';
  const displayName = wildPoke.nickname ?? speciesName;
  const user = await User.findById(actorId, 'username').lean();
  const userName = user?.username ?? 'Trainer';
  events.push(`${userName} threw a ${slugToDisplayName(itemId)} at ${displayName}!`);

  const maxHp = cache ? computeStats(cache.baseStats as BaseStats, wildPoke.level, wildPoke.nature).hp : wildPoke.currentHp;
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
    const usedSlots = new Set(partyPokemon.map(p => p.partySlot));
    let nextSlot = 1; while (usedSlots.has(nextSlot)) nextSlot++;
    await Pokemon.updateOne({ _id: targets[0] }, { $set: { ownerType: 'player', ownerId: actorId, isInParty: true, partySlot: nextSlot, caughtAt: new Date(), caughtByPlayerId: actorId } });
    const enemyEntry = battle.enemySide.find(e => e.activePokemonId?.toString() === targets[0].toString());
    if (enemyEntry) { enemyEntry.fainted.push(new mongoose.Types.ObjectId(targets[0].toString())); enemyEntry.activePokemonId = null; battle.markModified('enemySide'); }
    events.push(`Gotcha! ${displayName} was caught! It was added to your party (slot ${nextSlot}).`);
  }
  return events;
}

async function autoSkipBlockedActors(battle: HydratedDocument<IBattle>): Promise<void> {
  while (battle.currentTargetIndex < battle.turnQueue.length) {
    const entry = battle.turnQueue[battle.currentTargetIndex];

    if (entry.actionType === 'item') {
      const itemEvents = await resolveItemAction(entry as unknown as TurnQueueEntry);
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
      const poke  = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId').lean();
      const cache = poke ? await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean() : null;
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

    const poke = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId statusCondition statusCounter currentHp').lean();
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

async function checkConfusion(pokemonId: mongoose.Types.ObjectId): Promise<{ hitSelf: boolean; events: string[] }> {
  const poke = await Pokemon.findById(pokemonId, 'nickname speciesId level nature currentHp volatileStatus hasHiddenAbility').lean();
  if (!poke) return { hitSelf: false, events: [] };
  const confIdx = (poke.volatileStatus ?? []).findIndex(v => v.condition === 'confusion');
  if (confIdx === -1) return { hitSelf: false, events: [] };

  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name baseStats abilities').lean();
  const displayName = pokeDisplayName(poke, cache);

  const abilitySlug = resolveAbilitySlug((cache?.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
  if (abilitySlug && (STATUS_IMMUNITY_ABILITIES[abilitySlug] ?? []).includes('confusion')) {
    await Pokemon.updateOne({ _id: pokemonId }, { $pull: { volatileStatus: { condition: 'confusion' } } });
    return { hitSelf: false, events: [`${displayName}'s ${slugToDisplayName(abilitySlug)} snapped it out of confusion!`] };
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
    const stats  = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature);
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

async function applyStatusEffect(targetId: mongoose.Types.ObjectId, effect: StatusMoveEffect): Promise<string[]> {
  const target = await Pokemon.findById(targetId, 'nickname speciesId statusCondition volatileStatus currentHp hasHiddenAbility').lean();
  if (!target || target.currentHp <= 0) return [];

  const cache = await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name types abilities').lean();
  const types = (cache?.types ?? []) as string[];
  const displayName = pokeDisplayName(target, cache);
  const statusLabels: Record<string, string> = { burn: 'burned', paralysis: 'paralyzed', sleep: 'fell asleep', freeze: 'was frozen solid', poison: 'was poisoned', toxic: 'was badly poisoned' };

  const isConfusion = effect.status === 'confusion';
  if (!isConfusion && target.statusCondition) return [`${displayName} is already ${statusLabels[target.statusCondition]}!`];
  if (isConfusion && target.volatileStatus.some(v => v.condition === 'confusion')) return [`${displayName} is already confused!`];

  const isImmune = (
    (effect.status === 'paralysis' && types.includes('electric')) ||
    (effect.status === 'burn'      && types.includes('fire'))     ||
    ((effect.status === 'poison' || effect.status === 'toxic') && (types.includes('poison') || types.includes('steel'))) ||
    (effect.status === 'freeze'    && types.includes('ice'))
  );
  if (isImmune) return [`It doesn't affect ${displayName}!`];

  const abilitySlug = resolveAbilitySlug((cache?.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean);
  if (abilitySlug) {
    const immuneStatuses = STATUS_IMMUNITY_ABILITIES[abilitySlug] ?? [];
    if (immuneStatuses.includes(effect.status)) return [`${displayName}'s ${slugToDisplayName(abilitySlug)} prevents the ${effect.status}!`];
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
  attackerPokemonId: mongoose.Types.ObjectId, targetPokemonId: mongoose.Types.ObjectId,
  moveId: string, weather: IBattle['weather'], stages: { attacker?: StatStages; target?: StatStages } = {},
  powerOverride?: number,
): Promise<{ damage: number; isCrit: boolean; events: string[] }> {
  const [attacker, target] = await Promise.all([Pokemon.findById(attackerPokemonId).lean(), Pokemon.findById(targetPokemonId).lean()]);
  if (!attacker || !target) return { damage: 0, isCrit: false, events: ['(Pokémon not found during move resolution)'] };
  const [attackerCache, targetCache] = await Promise.all([PokedexCache.findOne({ pokeApiId: attacker.speciesId }).lean(), PokedexCache.findOne({ pokeApiId: target.speciesId }).lean()]);
  if (!attackerCache || !targetCache) return { damage: 0, isCrit: false, events: ['(Species cache missing during move resolution)'] };

  const attackerName = pokeDisplayName(attacker, attackerCache);
  const targetName   = pokeDisplayName(target, targetCache);
  const moveName     = slugToDisplayName(moveId);
  const moveData = (attackerCache.moves as Array<{ name: string; type: string; category: string; power: number | null; implemented: boolean }>).find(m => m.name === moveId);

  if (!moveData || !moveData.power) {
    const implNote = moveData && !moveData.implemented && !(moveId in STATUS_MOVES) && !(moveId in WEATHER_MOVES) && !SELF_TARGETING_MOVES.has(moveId) && !(moveId in STAT_STAGE_MOVES) ? ' (effect not yet implemented)' : '';
    return { damage: 0, isCrit: false, events: [`${attackerName} used ${moveName} on ${targetName}.${implNote}`] };
  }

  const hasFocusEnergy = ((attacker.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'focus-energy');
  const isCrit = Math.random() < (hasFocusEnergy ? 1 / 6 : 1 / 24);

  const attackerAbilities = (attackerCache.abilities as CachedAbility[]) ?? [];
  const targetAbilities   = (targetCache.abilities   as CachedAbility[]) ?? [];
  const attackerAbility = attacker.hasHiddenAbility ? (attackerAbilities.find(a => a.isHidden) ?? attackerAbilities.find(a => !a.isHidden)) : attackerAbilities.find(a => !a.isHidden);
  const targetAbility   = target.hasHiddenAbility   ? (targetAbilities.find(a => a.isHidden)   ?? targetAbilities.find(a => !a.isHidden))   : targetAbilities.find(a => !a.isHidden);
  const attackerAbilityName = attackerAbility ? slugToDisplayName(attackerAbility.name) : undefined;
  const targetAbilityName   = targetAbility   ? slugToDisplayName(targetAbility.name)   : undefined;

  const pinchEvents: string[] = [];
  if (attackerAbility) {
    const boostedType = PINCH_ABILITIES[attackerAbility.name];
    if (boostedType && moveData.type?.toLowerCase() === boostedType) {
      const maxHp = computeStats(attackerCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
      if (attacker.currentHp <= Math.floor(maxHp / 3)) pinchEvents.push(`${attackerName}'s ${attackerAbilityName}!`);
    }
  }

  let damage = 0; let effectNote = '';
  try {
    const toBoosts = (s?: StatStages) => s ? { atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe } : undefined;
    const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), { level: attacker.level, nature: cap(attacker.nature) as any, evs: ZERO_STATS, ivs: ZERO_STATS, curHP: attacker.currentHp, status: toCalcStatus(attacker.statusCondition) as any, ability: attackerAbilityName as any, boosts: toBoosts(stages.attacker) as any });
    const calcTarget   = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string),   { level: target.level,   nature: cap(target.nature)   as any, evs: ZERO_STATS, ivs: ZERO_STATS, curHP: target.currentHp,   ability: targetAbilityName   as any, boosts: toBoosts(stages.target)   as any });
    const result = calculate(GEN9, calcAttacker, calcTarget, new CalcMove(GEN9, moveName, powerOverride ? { overrides: { basePower: powerOverride } } as any : undefined), new Field({ weather: toCalcWeather(weather) as any }));
    const rolls  = Array.isArray(result.damage) ? result.damage : [result.damage];
    const picked = rolls[Math.floor(Math.random() * rolls.length)];
    damage = Array.isArray(picked) ? picked[Math.floor(Math.random() * picked.length)] : (picked as number);
    if (isCrit && damage > 0) damage = Math.floor(damage * 1.5);
    const desc = result.desc();
    if (damage === 0 || desc.includes('immune'))  effectNote = " It had no effect!";
    else if (desc.includes('super effective'))    effectNote = " It's super effective!";
    else if (desc.includes('not very effective')) effectNote = " It's not very effective...";
  } catch {
    damage = Math.max(1, Math.floor(((powerOverride ?? moveData.power) * attacker.level) / 50));
    const atkAbilitySlug = attackerAbility?.name;
    if (atkAbilitySlug === 'protean' || atkAbilitySlug === 'libero') damage = Math.floor(damage * 1.5);
    else if (atkAbilitySlug && atkAbilitySlug in ILATE_MAP && moveData.type?.toLowerCase() === 'normal') damage = Math.floor(damage * 1.2);
  }
  damage = Math.max(0, damage);
  return { damage, isCrit: isCrit && damage > 0, events: [...pinchEvents, `${attackerName} used ${moveName} on ${targetName} for ${damage} damage!${effectNote}${isCrit && damage > 0 ? ' Critical hit!' : ''}`] };
}

async function applyFaints(battle: HydratedDocument<IBattle>): Promise<string[]> {
  const events: string[] = [];
  const sides = [[battle.playerSide, 'playerSide'], [battle.enemySide, 'enemySide']] as const;
  for (const [entries, sideKey] of sides) {
    for (const entry of entries) {
      if (!entry.activePokemonId) continue;
      const poke = await Pokemon.findById(entry.activePokemonId, 'currentHp nickname speciesId').lean();
      if (!poke || poke.currentHp > 0) continue;
      const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      events.push(`${pokeDisplayName(poke, cache)} fainted!`);
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { volatileStatus: [] } });
      delete (battle.statStages as Record<string, StatStages>)[entry.activePokemonId.toString()];
      battle.markModified('statStages');
      delete (battle.consecutiveMoves as Record<string, unknown>)[entry.activePokemonId.toString()];
      battle.markModified('consecutiveMoves');
      delete (battle.lockedMoves as Record<string, unknown>)[entry.activePokemonId.toString()];
      battle.markModified('lockedMoves');
      entry.fainted.push(entry.activePokemonId);
      entry.activePokemonId = null;
      battle.markModified(sideKey);
    }
  }
  return events;
}

async function distributeExp(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.expAwarded) return [];
  battle.expAwarded = true;
  const events: string[] = [];
  const allFaintedEnemyIds = battle.enemySide.flatMap(e => e.fainted);
  if (allFaintedEnemyIds.length === 0) return events;
  const faintedEnemies = await Pokemon.find({ _id: { $in: allFaintedEnemyIds } }, 'level').lean();
  const totalBaseExp = faintedEnemies.reduce((sum, p) => sum + p.level * 5, 0);
  if (totalBaseExp === 0) return events;

  const playerUserIds  = battle.playerSide.map(e => e.userId);
  const allPartyPokemon = await Pokemon.find({ ownerId: { $in: playerUserIds }, ownerType: 'player', isInParty: true }, '_id ownerId nickname speciesId level exp nature currentHp evolutionOverrides').lean();
  const speciesIds = [...new Set(allPartyPokemon.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0 ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name expGroup baseStats').lean() : [];
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  for (const playerEntry of battle.playerSide) {
    const usedIds = new Set(playerEntry.usedPokemonIds.map(id => id.toString()));
    const partyPokemon = allPartyPokemon.filter(p => p.ownerId.toString() === playerEntry.userId.toString());
    for (const poke of partyPokemon) {
      const isActive = usedIds.has(poke._id.toString());
      const expGain  = isActive ? totalBaseExp : Math.floor(totalBaseExp / 2);
      if (expGain <= 0) continue;
      const cache       = cacheMap.get(poke.speciesId);
      const displayName = pokeDisplayName(poke, cache);
      events.push(`${displayName} gained ${expGain} EXP${isActive ? '' : ' (Exp. Share)'}!`);
      const newExp = (poke.exp as number) + expGain;
      let newLevel = poke.level as number; let newHp = poke.currentHp as number; let newSpeciesId = poke.speciesId as number;
      const expGroup  = (cache?.expGroup as string | undefined) ?? 'medium-fast';
      const baseStats = cache?.baseStats as BaseStats | undefined;
      const overrides = (poke.evolutionOverrides ?? []) as { condition: string; value: string }[];

      while (newLevel < 100 && newExp >= expForLevel(newLevel + 1, expGroup)) {
        if (baseStats && newHp > 0) {
          const oldMaxHp = computeStats(baseStats, newLevel, poke.nature as string).hp;
          newLevel += 1;
          newHp += computeStats(baseStats, newLevel, poke.nature as string).hp - oldMaxHp;
        } else { newLevel += 1; }
        events.push(`${displayName} grew to level ${newLevel}!`);
        const evolveIntoId = await canEvolve({ speciesId: newSpeciesId, level: newLevel, evolutionOverrides: overrides });
        if (evolveIntoId !== null) {
          let evolvedCache = await PokedexCache.findOne({ pokeApiId: evolveIntoId }).select('name baseStats').lean();
          if (!evolvedCache) {
            try { const fetched = await fetchSpecies(evolveIntoId); evolvedCache = (await PokedexCache.create(fetched)).toObject(); } catch { /* skip */ }
          }
          if (evolvedCache?.baseStats) newHp = computeStats(evolvedCache.baseStats as BaseStats, newLevel, poke.nature).hp;
          events.push(`${displayName} evolved into ${evolvedCache ? slugToDisplayName(evolvedCache.name as string) : 'a new form'}!`);
          newSpeciesId = evolveIntoId;
        }
      }
      await Pokemon.updateOne({ _id: poke._id }, { $set: { exp: newExp, level: newLevel, currentHp: newHp, speciesId: newSpeciesId } });
    }
  }
  return events;
}

async function checkBattleEnd(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.status !== 'active') return [];
  const hasActiveEnemy = battle.enemySide.some(e => e.activePokemonId !== null);
  let enemySideEliminated = false;
  if (!hasActiveEnemy && battle.enemySide.length > 0) {
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

  const hasActivePlayer = battle.playerSide.some(e => e.activePokemonId !== null);
  let playerSideEliminated = false;
  if (!hasActivePlayer && battle.playerSide.length > 0) {
    const results = await Promise.all(battle.playerSide.map(async entry => {
      const usedIds      = new Set(entry.usedPokemonIds.map(id => id.toString()));
      const limitReached = battle.playerPokemonLimit !== null && entry.usedPokemonIds.length >= battle.playerPokemonLimit;
      const healthyParty = await Pokemon.find({ ownerId: entry.userId, ownerType: 'player', isInParty: true, currentHp: { $gt: 0 } }, '_id').lean();
      if (healthyParty.length === 0) return true;
      return !healthyParty.some(p => usedIds.has(p._id.toString()) || !limitReached);
    }));
    playerSideEliminated = results.every(Boolean);
  }

  if (!enemySideEliminated && !playerSideEliminated) return [];
  battle.status = 'complete'; battle.endedAt = new Date();
  if (enemySideEliminated) {
    const expEvents = await distributeExp(battle);
    if (battle.type === 'wild') { const wasCaught = battle.catchAttempts.some(a => a.result === 'caught'); return wasCaught ? expEvents : ['The wild Pokémon was defeated!', ...expEvents]; }
    return ['All enemies have been defeated! The players win!', ...expEvents];
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
    const activePokemons = await Pokemon.find({ _id: { $in: allActiveIds }, currentHp: { $gt: 0 } }, 'speciesId level nature currentHp statusCondition statusCounter nickname volatileStatus hasHiddenAbility').lean();
    const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
    const caches     = speciesIds.length > 0 ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types abilities').lean() : [];
    const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
    const runningHp  = new Map(activePokemons.map(p => [p._id.toString(), p.currentHp]));
    const allEvents: string[] = [];

    for (const poke of activePokemons) {
      if (poke.statusCondition !== 'burn' && poke.statusCondition !== 'poison' && poke.statusCondition !== 'toxic') continue;
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const pokeName = pokeDisplayName(poke, cache);
      const abilitySlugForStatus = resolveAbilitySlug((cache.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
      if ((poke.statusCondition === 'poison' || poke.statusCondition === 'toxic') && abilitySlugForStatus === 'poison-heal') {
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
        const maxHp = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
        const damage = Math.max(1, Math.floor(maxHp / 16));
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const newHp = Math.max(0, currentHp - damage);
        runningHp.set(poke._id.toString(), newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeDisplayName(poke, cache)} is ${battle.weather === 'sandstorm' ? 'buffeted by the sandstorm' : 'pelted by hail'}! (${damage} damage, ${newHp} HP remaining)`);
      }
    }

    for (const poke of activePokemons) {
      const toClear = ((poke.volatileStatus as Array<{ condition: string }>) ?? []).filter(v => v.condition === 'roosting' || v.condition === 'enduring' || v.condition.startsWith('protecting')).map(v => v.condition);
      if (toClear.length > 0) await Pokemon.updateOne({ _id: poke._id }, { $pull: { volatileStatus: { condition: { $in: toClear } } } });
    }

    const stageMap = battle.statStages as Record<string, StatStages>;
    for (const poke of activePokemons) {
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const abilitySlug = resolveAbilitySlug((cache.abilities as CachedAbility[]) ?? [], poke.hasHiddenAbility as boolean);
      if (!abilitySlug) continue;
      const pokeName = pokeDisplayName(poke, cache);
      const maxHp    = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const curHp    = runningHp.get(poke._id.toString()) ?? poke.currentHp;

      if (abilitySlug === 'speed-boost') { allEvents.push(...applyStatStageEffects(stageMap, poke._id.toString(), [{ stat: 'spe', stages: 1, target: 'self' }], pokeName, abilitySlug)); battle.markModified('statStages'); }
      else if (abilitySlug === 'rain-dish' && battle.weather === 'rain')   { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Rain Dish`, allEvents); }
      else if (abilitySlug === 'ice-body'  && (battle.weather === 'hail' || battle.weather === 'snow')) { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Ice Body`, allEvents); }
      else if (abilitySlug === 'dry-skin') {
        if (battle.weather === 'rain') { await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1/16, runningHp, `${pokeName}'s Dry Skin`, allEvents); }
        else if (battle.weather === 'sun') { const dmg = Math.max(1,Math.floor(maxHp/8)); const newHp = Math.max(0,curHp-dmg); runningHp.set(poke._id.toString(),newHp); await Pokemon.updateOne({_id:poke._id},{$set:{currentHp:newHp}}); allEvents.push(`${pokeName}'s Dry Skin is seared by the sun! (${dmg} damage, ${newHp} HP remaining)`); }
      } else if (abilitySlug === 'moody') {
        const allStats: (keyof StatStages)[] = ['atk','def','spa','spd','spe','acc','eva'];
        const boostStat = allStats[Math.floor(Math.random()*allStats.length)];
        const dropStat  = allStats.filter(s=>s!==boostStat)[Math.floor(Math.random()*(allStats.length-1))];
        const evts = [...applyStatStageEffects(stageMap,poke._id.toString(),[{stat:boostStat,stages:2,target:'self'}],pokeName,abilitySlug),...applyStatStageEffects(stageMap,poke._id.toString(),[{stat:dropStat,stages:-1,target:'self'}],pokeName,abilitySlug)];
        if (evts.length) { allEvents.push(`${pokeName}'s Moody!`); allEvents.push(...evts); battle.markModified('statStages'); }
      } else if (abilitySlug === 'shed-skin' && poke.statusCondition) {
        if (Math.random() < 1/3) { await Pokemon.updateOne({_id:poke._id},{$set:{statusCondition:null,statusCounter:null}}); allEvents.push(`${pokeName}'s Shed Skin! ${pokeName} shed its skin and cured its status!`); }
      }
    }

    const playerActiveIds = new Set(battle.playerSide.map(e => e.activePokemonId?.toString()).filter(Boolean));
    const enemyActiveIds  = new Set(battle.enemySide.map(e => e.activePokemonId?.toString()).filter(Boolean));

    for (const poke of activePokemons) {
      const cache = cacheMap.get(poke.speciesId); if (!cache) continue;
      const maxHp   = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const pokeName = pokeDisplayName(poke, cache);
      const pokeId   = poke._id.toString();
      const volStatus = (poke.volatileStatus as Array<{ condition: string }>) ?? [];

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
            const rMaxHp  = computeStats(rCache.baseStats as BaseStats, recipient.level, recipient.nature).hp;
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

  const playerActors = battle.playerSide;
  const npcActors    = battle.enemySide.filter(e => e.activePokemonId != null);
  const totalActors  = playerActors.length + npcActors.length;
  if (totalActors === 0 || battle.turnQueue.length < totalActors) return;

  const pokemonIds = battle.turnQueue.map(e => e.activePokemonId);
  const pokemons   = await Pokemon.find({ _id: { $in: pokemonIds } }, 'speciesId level nature statusCondition hasHiddenAbility').lean();
  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats abilities').lean();
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const pokemonMap = new Map(pokemons.map(p => [p._id.toString(), p]));

  const withSpeed = battle.turnQueue.map(entry => {
    const poke  = pokemonMap.get(entry.activePokemonId.toString());
    const cache = poke ? cacheMap.get(poke.speciesId) : null;
    const abilitySlug = poke && cache ? resolveAbilitySlug((cache.abilities as CachedAbility[]) ?? [], (poke.hasHiddenAbility as boolean) ?? false) : null;
    const rawSpeed = poke && cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).speed : 0;
    const afterParalysis = poke?.statusCondition === 'paralysis' ? Math.floor(rawSpeed * 0.5) : rawSpeed;
    const weatherMatches = abilitySlug != null && (WEATHER_SPEED_DOUBLERS[abilitySlug] ?? []).includes(battle.weather ?? '');
    const speed = weatherMatches ? afterParalysis * 2 : afterParalysis;
    const pranksterBonus = abilitySlug === 'prankster' && PRANKSTER_MOVES.has(entry.moveId ?? '') ? 1 : 0;
    const movePriority   = (MOVE_PRIORITY[entry.moveId ?? ''] ?? 0) + pranksterBonus;
    return { entry, speed, movePriority };
  });

  const actionPriority = (t: string) => (t === 'item' || t === 'catch' ? 2 : t === 'switch' ? 1 : 0);
  withSpeed.sort((a, b) => {
    const actionDiff = actionPriority(b.entry.actionType) - actionPriority(a.entry.actionType);
    if (actionDiff !== 0) return actionDiff;
    const movePriorityDiff = b.movePriority - a.movePriority;
    if (movePriorityDiff !== 0) return movePriorityDiff;
    return b.speed - a.speed;
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
type MoveMeta = { type: string; accuracy: number | null };
async function fetchMoveMeta(speciesId: number, moveId: string): Promise<MoveMeta | undefined> {
  const doc = await PokedexCache.findOne({ pokeApiId: speciesId, 'moves.name': moveId }, { 'moves.$': 1 }).lean();
  return (doc?.moves as MoveMeta[] | undefined)?.[0];
}

async function resolveWeatherMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry,
  weatherEffect: { weather: IBattle['weather']; startMessage: string }, moveEvents: string[],
): Promise<void> {
  const attacker = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId').lean();
  const atkCache = attacker ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name').lean() : null;
  const attackerName = pokeDisplayName(attacker, atkCache);
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
  const attacker = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId currentHp nature level volatileStatus hasHiddenAbility').lean();
  const atkCache = attacker ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name baseStats abilities types').lean() : null;
  const attackerName = pokeDisplayName(attacker, atkCache);

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
        const atkAbilitySlug = attacker && atkCache ? resolveAbilitySlug((atkCache.abilities as CachedAbility[]) ?? [], attacker.hasHiddenAbility as boolean) : null;
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), selfEffects, attackerName, atkAbilitySlug));
        battle.markModified('statStages');
      }
    }

    const recoveryEffect = RECOVERY_MOVES[entry.moveId];
    if (recoveryEffect && attacker && atkCache?.baseStats) {
      const maxHp     = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
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
      const maxHp  = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
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

  }
}

async function resolveDamagingMove(
  battle: HydratedDocument<IBattle>, entry: ActiveEntry, targets: string[],
  targetHpMap: Map<string, number>, enduringTargets: Set<string>,
  protectingTargets: Map<string, string | null>, moveEvents: string[],
): Promise<void> {
  if (entry.moveId === 'fake-out') {
    const sideEntry = entry.actorType === 'player'
      ? battle.playerSide.find(e => e.activePokemonId?.toString() === entry.activePokemonId.toString())
      : battle.enemySide.find(e => e.activePokemonId?.toString() === entry.activePokemonId.toString());
    if (!sideEntry || sideEntry.activeSentOutOnTurn !== battle.turnNumber) {
      const atkDoc   = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId').lean();
      const atkCache = atkDoc ? await PokedexCache.findOne({ pokeApiId: atkDoc.speciesId }, 'name').lean() : null;
      moveEvents.push(`${pokeDisplayName(atkDoc, atkCache)} used Fake Out! But it failed!`);
      return;
    }
  }

  if (entry.moveId === 'curse') {
    const atkDoc      = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId currentHp nature level hasHiddenAbility').lean();
    const atkDocCache = atkDoc ? await PokedexCache.findOne({ pokeApiId: atkDoc.speciesId }, 'name baseStats types abilities').lean() : null;
    const atkName     = pokeDisplayName(atkDoc, atkDocCache);
    moveEvents.push(`${atkName} used Curse!`);
    const isGhost = ((atkDocCache?.types as string[]) ?? []).includes('ghost');
    if (isGhost && atkDoc && atkDocCache?.baseStats) {
      const targetId = targets[0];
      if (targetId) {
        const tgtPoke  = await Pokemon.findById(targetId, 'nickname speciesId volatileStatus').lean();
        const tgtCache = tgtPoke ? await PokedexCache.findOne({ pokeApiId: (tgtPoke as any).speciesId }, 'name').lean() : null;
        const tgtName  = pokeDisplayName(tgtPoke, tgtCache);
        if (((tgtPoke?.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'cursed')) {
          moveEvents.push(`${tgtName} is already cursed!`);
        } else {
          const maxHp  = computeStats(atkDocCache.baseStats as BaseStats, atkDoc.level, atkDoc.nature).hp;
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
      const abilitySlug    = atkDoc && atkDocCache ? resolveAbilitySlug((atkDocCache.abilities as CachedAbility[]) ?? [], atkDoc.hasHiddenAbility ?? false) : null;
      const curseEffects   = (STAT_STAGE_MOVES['curse'] ?? []).filter(e => e.target === 'self');
      moveEvents.push(...applyStatStageEffects(stageMap2, entry.activePokemonId.toString(), curseEffects, atkName, abilitySlug));
      battle.markModified('statStages');
    }
    return;
  }

  const moveEffect      = STATUS_MOVES[entry.moveId];
  const stageMap        = battle.statStages as Record<string, StatStages>;
  const recoilEffect    = RECOIL_MOVES[entry.moveId];
  const drainEffect     = DRAIN_MOVES[entry.moveId];
  const selfStatEffects = (STAT_STAGE_MOVES[entry.moveId] ?? []).filter(e => e.target === 'self');

  type AtkSnapshot = { currentHp: number; speciesId: number; nature: string; level: number; nickname: string | null; hasHiddenAbility?: boolean; volatileStatus?: Array<{ condition: string }> };
  const atkSnap      = await Pokemon.findById(entry.activePokemonId, 'nickname currentHp speciesId nature level hasHiddenAbility volatileStatus').lean() as AtkSnapshot | null;
  const atkSnapCache = atkSnap ? await PokedexCache.findOne({ pokeApiId: atkSnap.speciesId }, 'name baseStats abilities').lean() : null;

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

  const attackerAbilitySlug = atkSnap && atkSnapCache ? resolveAbilitySlug((atkSnapCache.abilities as CachedAbility[]) ?? [], atkSnap.hasHiddenAbility ?? false) : null;
  const sereneGrace = attackerAbilitySlug === 'serene-grace';

  const moveMeta = atkSnap ? await fetchMoveMeta(atkSnap.speciesId, entry.moveId) : undefined;
  const moveAccuracy = moveMeta?.accuracy ?? null;

  let typeChangeMoveType: string | null = null;
  const isTypeChanging = attackerAbilitySlug === 'protean' || attackerAbilitySlug === 'libero' || (attackerAbilitySlug != null && attackerAbilitySlug in ILATE_MAP);
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

  for (const targetId of targets) {
    if (moveAccuracy !== null) {
      const attackerAccStage = stageMap[entry.activePokemonId.toString()]?.acc ?? 0;
      const targetEvaStage   = stageMap[targetId]?.eva ?? 0;
      const hitChance = (moveAccuracy / 100) * accuracyStageMultiplier(attackerAccStage, targetEvaStage);
      if (Math.random() >= hitChance) {
        const tgtDoc   = await Pokemon.findById(targetId, 'nickname speciesId').lean();
        const tgtCache = tgtDoc ? await PokedexCache.findOne({ pokeApiId: (tgtDoc as any).speciesId }, 'name').lean() : null;
        const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
        moveEvents.push(`${atkName} used ${slugToDisplayName(entry.moveId)} on ${pokeDisplayName(tgtDoc, tgtCache)}, but it missed!`);
        continue;
      }
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
      const tgt      = await Pokemon.findById(targetId, 'currentHp nickname speciesId level nature').lean();
      const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name baseStats').lean() : null;
      if (tgt && tgtCache?.baseStats) {
        const atkMaxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp;
        const tgtMaxHp = computeStats(tgtCache.baseStats as BaseStats, (tgt as any).level, (tgt as any).nature).hp;
        const average  = Math.floor((atkSnap.currentHp + (targetHpMap.get(targetId) ?? (tgt as any).currentHp)) / 2);
        const newAtkHp = Math.min(atkMaxHp, average); const newTgtHp = Math.min(tgtMaxHp, average);
        await Promise.all([Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } }), Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newTgtHp } })]);
        atkSnap.currentHp = newAtkHp; targetHpMap.set(targetId, newTgtHp);
        moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} used Pain Split on ${pokeDisplayName(tgt, tgtCache)}!`);
        moveEvents.push(`They split the pain! (${pokeDisplayName(atkSnap, atkSnapCache)}: ${newAtkHp} HP, ${pokeDisplayName(tgt, tgtCache)}: ${newTgtHp} HP)`);
      }
      continue;
    }

    if (entry.moveId === 'leech-seed') {
      const tgt      = await Pokemon.findById(targetId, 'nickname speciesId volatileStatus').lean();
      const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name types').lean() : null;
      const tgtName  = pokeDisplayName(tgt, tgtCache);
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

    if (typeChangeMoveType && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      if (attackerAbilitySlug === 'protean' || attackerAbilitySlug === 'libero') {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(attackerAbilitySlug)}! ${atkName} became the ${typeChangeMoveType.charAt(0).toUpperCase() + typeChangeMoveType.slice(1)} type!`);
      } else if (attackerAbilitySlug && attackerAbilitySlug in ILATE_MAP && typeChangeMoveType === 'normal') {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(attackerAbilitySlug)}! The move became ${ILATE_MAP[attackerAbilitySlug]} type!`);
      }
    }

    const hitCount  = getHitCount(entry.moveId);
    let totalDamage = 0; let actualHits = 0; let anyCrit = false;

    for (let hit = 1; hit <= hitCount; hit++) {
      if ((targetHpMap.get(targetId) ?? 0) <= 0) break;

      const protectCondition = protectingTargets.get(targetId);
      if (protectCondition) {
        const tgtDoc  = await Pokemon.findById(targetId, 'nickname speciesId').lean();
        const tgtC    = tgtDoc ? await PokedexCache.findOne({ pokeApiId: (tgtDoc as any).speciesId }, 'name').lean() : null;
        moveEvents.push(`${pokeDisplayName(tgtDoc, tgtC)} protected itself!`);
        if (CONTACT_MOVES.has(entry.moveId) && atkSnap && atkSnapCache) {
          const atkName = pokeDisplayName(atkSnap, atkSnapCache);
          if (protectCondition === 'protecting-kings-shield') {
            moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), [{ stat: 'atk', stages: -2, target: 'self' }], atkName, attackerAbilitySlug));
            battle.markModified('statStages');
          } else if (protectCondition === 'protecting-obstruct') {
            moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), [{ stat: 'def', stages: -2, target: 'self' }], atkName, attackerAbilitySlug));
            battle.markModified('statStages');
          } else if (protectCondition === 'protecting-spiky-shield' && atkSnapCache.baseStats) {
            const maxHp   = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp;
            const chipDmg = Math.max(1, Math.floor(maxHp / 8));
            const newHp   = Math.max(0, atkSnap.currentHp - chipDmg);
            await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } });
            atkSnap.currentHp = newHp;
            moveEvents.push(`${atkName} was hurt by Spiky Shield! (${chipDmg} damage)`);
          } else if (protectCondition === 'protecting-baneful-bunker') {
            const statusEvents = await applyStatusEffect(entry.activePokemonId, { status: 'poison', chance: 1 });
            if (statusEvents.length) { moveEvents.push(`${atkName} was poisoned by Baneful Bunker!`); moveEvents.push(...statusEvents); }
          }
        }
        break;
      }

      const { damage, isCrit, events } = await resolveMove(
        entry.activePokemonId, new mongoose.Types.ObjectId(targetId), entry.moveId, battle.weather,
        { attacker: stageMap[entry.activePokemonId.toString()], target: stageMap[targetId] },
        escalatedPower,
      );
      if (isCrit) anyCrit = true;
      if (hitCount > 1) { moveEvents.push(`(Hit ${hit}) ${events[0]}`); } else { moveEvents.push(...events); }

      if (damage > 0) {
        const currentHp  = targetHpMap.get(targetId) ?? 0;
        const isEnduring = enduringTargets.has(targetId);
        const rawNewHp   = currentHp - damage;
        const newHp      = isEnduring && rawNewHp <= 0 ? 1 : Math.max(0, rawNewHp);
        await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newHp } });
        targetHpMap.set(targetId, newHp);
        totalDamage += damage;
        if (isEnduring && rawNewHp <= 0) moveEvents.push('It endured the hit!');
      }
      actualHits++;
    }
    if (hitCount > 1) moveEvents.push(`Hit ${actualHits} time(s)!`);

    if (anyCrit) {
      const apTgt   = await Pokemon.findById(targetId, 'nickname speciesId hasHiddenAbility').lean();
      const apCache = apTgt ? await PokedexCache.findOne({ pokeApiId: apTgt.speciesId }, 'name abilities').lean() : null;
      const apAbility = apTgt && apCache ? resolveAbilitySlug((apCache.abilities as CachedAbility[]) ?? [], (apTgt.hasHiddenAbility as boolean) ?? false) : null;
      if (apAbility === 'anger-point') {
        const apName = pokeDisplayName(apTgt, apCache);
        const apStageMap = battle.statStages as Record<string, StatStages>;
        if (!apStageMap[targetId]) apStageMap[targetId] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
        apStageMap[targetId].atk = 6; battle.markModified('statStages');
        moveEvents.push(`${apName}'s Anger Point! ${apName}'s Attack rose to the maximum!`);
      }
    }

    if (moveEffect && Math.random() < (sereneGrace ? Math.min(1, moveEffect.chance * 2) : moveEffect.chance)) {
      moveEvents.push(...await applyStatusEffect(new mongoose.Types.ObjectId(targetId), moveEffect));
    }

    const statEffects = STAT_STAGE_MOVES[entry.moveId];
    if (statEffects) {
      const foeEffects = statEffects.filter(e => e.target === 'foe' && Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      if (foeEffects.length > 0) {
        const tgt      = await Pokemon.findById(targetId, 'nickname speciesId hasHiddenAbility').lean();
        const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name abilities').lean() : null;
        const tgtName  = pokeDisplayName(tgt, tgtCache);
        const tgtAbility = tgt && tgtCache ? resolveAbilitySlug((tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean) : null;
        moveEvents.push(...applyStatStageEffects(stageMap, targetId, foeEffects, tgtName, tgtAbility));
        battle.markModified('statStages');
        if (foeEffects.some(e => e.stages < 0) && (tgtAbility === 'competitive' || tgtAbility === 'defiant')) {
          const reactionStat: keyof StatStages = tgtAbility === 'competitive' ? 'spa' : 'atk';
          moveEvents.push(`${tgtName}'s ${slugToDisplayName(tgtAbility)}!`);
          moveEvents.push(...applyStatStageEffects(stageMap, targetId, [{ stat: reactionStat, stages: 2, target: 'self' }], tgtName));
          battle.markModified('statStages');
        }
      }
    }

    if (selfStatEffects.length > 0 && atkSnap && atkSnapCache) {
      const rolledSelfEffects = selfStatEffects.filter(e => Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      if (rolledSelfEffects.length > 0) {
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), rolledSelfEffects, pokeDisplayName(atkSnap, atkSnapCache), attackerAbilitySlug));
        battle.markModified('statStages');
      }
    }

    if (recoilEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      let recoilDmg: number;
      if (recoilEffect.type === 'damage') { recoilDmg = Math.max(1, Math.floor(totalDamage * recoilEffect.fraction)); }
      else { const maxHp = atkSnapCache.baseStats ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp : 1; recoilDmg = Math.max(1, Math.floor(maxHp * recoilEffect.fraction)); }
      const newAtkHp = Math.max(0, atkSnap.currentHp - recoilDmg);
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
      atkSnap.currentHp = newAtkHp;
      moveEvents.push(`${atkName} was hurt by recoil!`);
    }

    if (drainEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const maxHp     = atkSnapCache.baseStats ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp : 0;
      const restoreAmt = Math.max(1, Math.floor(totalDamage * drainEffect.fraction));
      const newAtkHp   = Math.min(maxHp, atkSnap.currentHp + restoreAmt);
      const restored   = newAtkHp - atkSnap.currentHp;
      if (restored > 0) {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
        atkSnap.currentHp = newAtkHp;
        moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} restored ${restored} HP!`);
      }
    }

    const flinchChance = FLINCH_MOVES[entry.moveId];
    if (flinchChance && totalDamage > 0 && Math.random() < flinchChance) {
      const targetEntry = battle.turnQueue.find(e => e.activePokemonId.toString() === targetId && !e.resolved);
      if (targetEntry) targetEntry.flinched = true;
    }

    if (CONTACT_MOVES.has(entry.moveId) && totalDamage > 0) {
      const defPoke = await Pokemon.findById(targetId, 'speciesId hasHiddenAbility nickname').lean();
      if (defPoke) {
        const defCache = await PokedexCache.findOne({ pokeApiId: defPoke.speciesId }, 'name abilities baseStats').lean();
        const defAbilitySlug = resolveAbilitySlug((defCache?.abilities as CachedAbility[]) ?? [], defPoke.hasHiddenAbility as boolean);
        if (defAbilitySlug) {
          const defName = pokeDisplayName(defPoke, defCache);
          const atkId   = entry.activePokemonId;
          if (defAbilitySlug === 'rough-skin' || defAbilitySlug === 'iron-barbs') {
            if (atkSnap && atkSnapCache?.baseStats) {
              const maxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp;
              const dmg   = Math.max(1, Math.floor(maxHp / 8));
              const newHp = Math.max(0, atkSnap.currentHp - dmg);
              await Pokemon.updateOne({ _id: atkId }, { $set: { currentHp: newHp } });
              atkSnap.currentHp = newHp;
              moveEvents.push(`${pokeDisplayName(atkSnap, atkSnapCache)} was hurt by ${defName}'s ${slugToDisplayName(defAbilitySlug)}!`);
            }
          } else if (defAbilitySlug === 'poison-point' && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(atkId, { status: 'poison', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Poison Point!`); moveEvents.push(...sEvts); }
          } else if (defAbilitySlug === 'static' && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(atkId, { status: 'paralysis', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Static!`); moveEvents.push(...sEvts); }
          } else if (defAbilitySlug === 'flame-body' && Math.random() < 0.3) {
            const sEvts = await applyStatusEffect(atkId, { status: 'burn', chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Flame Body!`); moveEvents.push(...sEvts); }
          } else if (defAbilitySlug === 'effect-spore' && Math.random() < 0.3) {
            const roll   = Math.random();
            const status = roll < 1/3 ? 'poison' : roll < 2/3 ? 'paralysis' : 'sleep';
            const sEvts  = await applyStatusEffect(atkId, { status: status as StatusCondition, chance: 1 });
            if (sEvts.length) { moveEvents.push(`${defName}'s Effect Spore!`); moveEvents.push(...sEvts); }
          }
        }
      }
    }
  }

  const koCount = targets.filter(id => (targetHpMap.get(id) ?? 1) <= 0).length;
  if (koCount > 0) {
    let koAbilitySlug  = attackerAbilitySlug;
    let koAtkCache: { name?: unknown; baseStats?: unknown; abilities?: unknown } | null = atkSnapCache;
    let koAtkName      = atkSnap ? pokeDisplayName(atkSnap, atkSnapCache) : null;

    if (koAbilitySlug == null) {
      const fetchedAtk   = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId hasHiddenAbility').lean();
      const fetchedCache = fetchedAtk ? await PokedexCache.findOne({ pokeApiId: fetchedAtk.speciesId }, 'name abilities baseStats').lean() : null;
      koAbilitySlug = fetchedAtk && fetchedCache ? resolveAbilitySlug((fetchedCache.abilities as CachedAbility[]) ?? [], (fetchedAtk.hasHiddenAbility as boolean) ?? false) : null;
      koAtkCache = fetchedCache; koAtkName = pokeDisplayName(fetchedAtk, fetchedCache);
    }

    if (koAbilitySlug === 'moxie' || koAbilitySlug === 'beast-boost') {
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
          const confuseEvents = await applyStatusEffect(entry.activePokemonId, { status: 'confusion', chance: 1 });
          moveEvents.push(...confuseEvents.map(e => e.replace('became confused!', 'became confused from fatigue!')));
        }
      }
    }
    battle.lockedMoves = lockedMovesMap;
    battle.markModified('lockedMoves');
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

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry) { res.status(403).json({ data: null, error: 'You are not in this battle' }); return; }

  const pokeId  = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({ _id: pokeId, ownerId: userId, ownerType: 'player', isInParty: true }).lean();
  if (!pokemon)               { res.status(404).json({ data: null, error: 'Pokémon not found in your party' }); return; }
  if (pokemon.currentHp <= 0) { res.status(400).json({ data: null, error: 'That Pokémon has fainted' }); return; }

  const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === pokemonId);
  if (!alreadyUsed && battle.playerPokemonLimit !== null) {
    if (playerEntry.usedPokemonIds.length >= battle.playerPokemonLimit) {
      res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' }); return;
    }
  }

  const outgoingId = playerEntry.activePokemonId;
  if (outgoingId && outgoingId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  }

  playerEntry.activePokemonId = pokeId;
  battle.markModified('playerSide');
  if (!alreadyUsed) playerEntry.usedPokemonIds.push(pokeId);

  const entryEvents = await applyEntryAbilities(battle, pokeId, 'player');
  appendToLog(battle, ...entryEvents);
  battle.lastUpdatedAt = new Date();
  await battle.save();
  // Direct update for activeSentOutOnTurn — bypasses Mongoose subdocument tracking.
  await Battle.updateOne(
    { _id: battle._id, 'playerSide.userId': userId },
    { $set: { 'playerSide.$.activeSentOutOnTurn': battle.turnNumber } },
  );

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

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry)                 { res.status(403).json({ data: null, error: 'You are not in this battle' }); return; }
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
    battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId!, actionType: 'move', moveId: playerLock.moveId, targets: [], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase, lockedMove: playerLock.moveId }, error: null });
    return;
  }

  if (actionType === 'item') {
    if (!itemId || !targetPokemonId) { res.status(400).json({ data: null, error: 'itemId and targetPokemonId are required for item actions' }); return; }
    if (!mongoose.Types.ObjectId.isValid(targetPokemonId)) { res.status(400).json({ data: null, error: 'Invalid targetPokemonId' }); return; }

    const item = await Item.findOne({ ownerId: userId, itemId }).lean();
    if (!item)                                                      { res.status(400).json({ data: null, error: 'Item not found in your bag' }); return; }
    if (item.pocket !== 'healing' && item.pocket !== 'status_cure') { res.status(400).json({ data: null, error: 'That item cannot be used in battle' }); return; }

    const targetObjId   = new mongoose.Types.ObjectId(targetPokemonId);
    const targetPokemon = await Pokemon.findOne({ _id: targetObjId, ownerId: userId, isInParty: true }).lean();
    if (!targetPokemon) { res.status(400).json({ data: null, error: 'Target Pokémon not found in your party' }); return; }

    battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'item', moveId: '', itemId, targets: [targetObjId], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  if (actionType === 'run') {
    battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'run', moveId: '', targets: [], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
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

    battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'catch', moveId: '', itemId, targets: [wildEntry.activePokemonId], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  if (actionType === 'switch') {
    if (!switchToPokemonId || !mongoose.Types.ObjectId.isValid(switchToPokemonId)) {
      res.status(400).json({ data: null, error: 'A valid switchToPokemonId is required for switch actions' }); return;
    }
    const switchToId = new mongoose.Types.ObjectId(switchToPokemonId);
    if (playerEntry.activePokemonId?.toString() === switchToPokemonId) {
      res.status(400).json({ data: null, error: 'That Pokémon is already active' }); return;
    }
    const switchTarget = await Pokemon.findOne({ _id: switchToId, ownerId: userId, ownerType: 'player', isInParty: true }).lean();
    if (!switchTarget)               { res.status(404).json({ data: null, error: 'Pokémon not found in your party' }); return; }
    if (switchTarget.currentHp <= 0) { res.status(400).json({ data: null, error: 'That Pokémon has fainted' }); return; }

    const alreadyUsedSwitch = playerEntry.usedPokemonIds.some(id => id.toString() === switchToPokemonId);
    if (!alreadyUsedSwitch && battle.playerPokemonLimit !== null) {
      if (playerEntry.usedPokemonIds.length >= battle.playerPokemonLimit) {
        res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' }); return;
      }
    }

    battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId!, actionType: 'switch', moveId: '', switchToPokemonId: switchToId, targets: [], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  if (!moveId) { res.status(400).json({ data: null, error: 'moveId is required' }); return; }

  const pokemon = await Pokemon.findOne({ _id: playerEntry.activePokemonId }).lean();
  if (!pokemon) { res.status(404).json({ data: null, error: 'Active Pokémon not found' }); return; }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot)               { res.status(400).json({ data: null, error: 'That move is not on your active Pokémon' }); return; }
  if (moveSlot.currentPP <= 0) { res.status(400).json({ data: null, error: 'That move has no PP remaining' }); return; }

  battle.turnQueue.push({ actorId: userId, actorType: 'player', activePokemonId: playerEntry.activePokemonId, actionType: 'move', moveId, targets: [], resolved: false });
  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
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

  const isPlayerActor = currentEntry.actorType === 'player';
  const validTargetIds = isPlayerActor
    ? battle.enemySide.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!.toString())
    : battle.playerSide.filter(e => e.activePokemonId != null).map(e => e.activePokemonId!.toString());

  const invalidTargets = targets.filter(t => !validTargetIds.includes(t));
  if (invalidTargets.length > 0) { res.status(400).json({ data: null, error: 'One or more targets are not valid active opposing Pokémon' }); return; }

  const targetPokemons = await Pokemon.find({ _id: { $in: targets } }, 'currentHp volatileStatus').lean();
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

  battle.turnQueue[idx].targets = targets.map(t => new mongoose.Types.ObjectId(t));

  const { hitSelf, events: confusionEvents } = await checkConfusion(currentEntry.activePokemonId);
  const moveEvents: string[] = [...confusionEvents];

  if (!hitSelf) {
    const weatherEffect = WEATHER_MOVES[currentEntry.moveId];
    if (weatherEffect) {
      await resolveWeatherMove(battle, currentEntry as unknown as ActiveEntry, weatherEffect, moveEvents);
    } else if (SELF_TARGETING_MOVES.has(currentEntry.moveId)) {
      await resolveSelfTargetMove(battle, currentEntry as unknown as ActiveEntry, moveEvents);
    } else {
      await resolveDamagingMove(battle, currentEntry as unknown as ActiveEntry, targets, targetHpMap, enduringTargets, protectingTargets, moveEvents);
    }

    await Pokemon.updateOne(
      { _id: currentEntry.activePokemonId, moves: { $elemMatch: { moveId: currentEntry.moveId, currentPP: { $gt: 0 } } } },
      { $inc: { 'moves.$.currentPP': -1 } },
    );
  }

  battle.turnQueue[idx].resolved = true;
  appendToLog(battle, ...moveEvents);

  const faintEvents = await applyFaints(battle);
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
  const battle = await Battle.findOne({ 'playerSide.userId': userId, status: { $ne: 'complete' } }).sort({ lastUpdatedAt: -1 }).lean();
  if (!battle) { res.json({ data: null, error: null }); return; }
  res.json({ data: { _id: battle._id, status: battle.status, type: battle.type, turnNumber: battle.turnNumber, lastUpdatedAt: battle.lastUpdatedAt }, error: null });
}

export async function getBattleState(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;

  const battle = await Battle.findById(id).lean();
  if (!battle) { res.status(404).json({ data: null, error: 'Battle not found' }); return; }

  const userIds     = battle.playerSide.map(entry => entry.userId);
  const users       = await User.find({ _id: { $in: userIds } }, 'username').lean();
  const usernameMap = new Map(users.map(u => [u._id.toString(), u.username]));

  const allActivePokemonIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((pid): pid is mongoose.Types.ObjectId => pid != null);

  const activePokemons = allActivePokemonIds.length > 0
    ? await Pokemon.find({ _id: { $in: allActivePokemonIds } }, 'nickname speciesId currentHp level nature statusCondition volatileStatus moves').lean()
    : [];

  const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types').lean()
    : [];

  const pokemonMap = new Map(activePokemons.map(p => [p._id.toString(), p]));
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const stageMap   = (battle.statStages ?? {}) as Record<string, StatStages>;

  const buildInfo = (pokemonId: mongoose.Types.ObjectId | null) => {
    if (!pokemonId) return null;
    const poke = pokemonMap.get(pokemonId.toString());
    if (!poke) return null;
    const cache       = cacheMap.get(poke.speciesId);
    const speciesName = cache?.name ?? `#${poke.speciesId}`;
    const maxHp       = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp : null;
    return {
      _id:             poke._id.toString(),
      name:            poke.nickname ?? speciesName,
      speciesName,
      speciesId:       poke.speciesId,
      level:           poke.level,
      types:           (cache?.types as string[] | undefined) ?? [],
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
    npcName:           entry.npcId ? (npcNameMap.get(entry.npcId.toString()) ?? 'NPC') : 'Wild Pokémon',
    activePokemonInfo: buildInfo(entry.activePokemonId),
    faintedCount:      entry.fainted.length,
    npcLimitReached:   battle.npcPokemonLimit !== null && entry.fainted.length >= battle.npcPokemonLimit,
  }));

  let currentMoveTargetCategory: 'single' | 'auto' | null = null;
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
    }
  }

  res.json({
    data: {
      ...battle,
      playerSide:                playerSideWithNames,
      enemySide:                 enemySideWithInfo,
      noTargetMoveIds:           [...NO_TARGET_MOVE_IDS],
      currentMoveTargetCategory,
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
  const npcEntryEvents = await applyEntryAbilities(battle, pokeId, 'enemy');
  appendToLog(battle, ...npcEntryEvents);
  battle.lastUpdatedAt = new Date();
  await battle.save();
  await Battle.updateOne(
    { _id: battle._id, 'enemySide.npcId': new mongoose.Types.ObjectId(npcId) },
    { $set: { 'enemySide.$.activeSentOutOnTurn': battle.turnNumber } },
  );

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
    battle.turnQueue.push({ actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'move', moveId: npcLock.moveId, targets: [], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase, lockedMove: npcLock.moveId }, error: null });
    return;
  }

  if (battle.type === 'wild' && actionType === 'switch') { res.status(400).json({ data: null, error: 'Wild Pokémon cannot switch' }); return; }

  if (actionType === 'item') {
    if (!itemId)                                                                          { res.status(400).json({ data: null, error: 'itemId is required for item actions' }); return; }
    if (!targetPokemonId || !mongoose.Types.ObjectId.isValid(targetPokemonId))            { res.status(400).json({ data: null, error: 'A valid targetPokemonId is required for item actions' }); return; }
    if (!npcEntry.activePokemonId)                                                        { res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' }); return; }

    const npcObjId = new mongoose.Types.ObjectId(npcId);
    const bagItem  = await Item.findOne({ ownerId: npcObjId, itemId }).lean();
    if (!bagItem || bagItem.quantity < 1) { res.status(400).json({ data: null, error: 'Item not found in NPC bag' }); return; }

    battle.turnQueue.push({ actorId: npcObjId, actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'item', itemId, targets: [new mongoose.Types.ObjectId(targetPokemonId)], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  if (actionType === 'switch') {
    if (!switchToPokemonId || !mongoose.Types.ObjectId.isValid(switchToPokemonId)) { res.status(400).json({ data: null, error: 'A valid switchToPokemonId is required for switch actions' }); return; }
    if (npcEntry.activePokemonId?.toString() === switchToPokemonId)                { res.status(400).json({ data: null, error: 'That Pokémon is already active' }); return; }

    const npc = await Npc.findById(npcId, 'party').lean();
    if (!npc || !npc.party.some((id: mongoose.Types.ObjectId) => id.toString() === switchToPokemonId)) {
      res.status(400).json({ data: null, error: "That Pokémon is not in this NPC's party" }); return;
    }
    const switchTarget = await Pokemon.findById(switchToPokemonId, 'currentHp').lean();
    if (!switchTarget)               { res.status(404).json({ data: null, error: 'Switch target Pokémon not found' }); return; }
    if (switchTarget.currentHp <= 0) { res.status(400).json({ data: null, error: 'Cannot switch to a fainted Pokémon' }); return; }

    const activePokemonId = npcEntry.activePokemonId ?? new mongoose.Types.ObjectId(switchToPokemonId);
    battle.turnQueue.push({ actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId, actionType: 'switch', switchToPokemonId: new mongoose.Types.ObjectId(switchToPokemonId), targets: [], resolved: false });
    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();
    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  if (!moveId)                  { res.status(400).json({ data: null, error: 'moveId is required for move actions' }); return; }
  if (!npcEntry.activePokemonId) { res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' }); return; }

  const pokemon = await Pokemon.findOne({ _id: npcEntry.activePokemonId }).lean();
  if (!pokemon) { res.status(404).json({ data: null, error: 'NPC active Pokémon not found' }); return; }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot)               { res.status(400).json({ data: null, error: "That move is not on the NPC's active Pokémon" }); return; }
  if (moveSlot.currentPP <= 0) { res.status(400).json({ data: null, error: 'That move has no PP remaining' }); return; }

  battle.turnQueue.push({ actorId: new mongoose.Types.ObjectId(npcId), actorType: 'npc', activePokemonId: npcEntry.activePokemonId, actionType: 'move', moveId, targets: [], resolved: false });
  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
}

async function estimateDamage(
  attacker: { currentHp: number; nature: string; level: number },
  attackerCache: { name: unknown },
  attackerAbilitySlug: string | null,
  moveId: string,
  target: { currentHp: number; nature: string; level: number },
  targetCache: { name: unknown },
  targetAbilitySlug: string | null,
  weather: string | null,
): Promise<number> {
  try {
    const calcAtk = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), {
      level: attacker.level, nature: cap(attacker.nature) as any, evs: ZERO_STATS, ivs: ZERO_STATS,
      curHP: attacker.currentHp, ability: attackerAbilitySlug ? slugToDisplayName(attackerAbilitySlug) as any : undefined,
    });
    const calcTgt = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level: target.level, nature: cap(target.nature) as any, evs: ZERO_STATS, ivs: ZERO_STATS,
      curHP: target.currentHp, ability: targetAbilitySlug ? slugToDisplayName(targetAbilitySlug) as any : undefined,
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

    const poke = await Pokemon.findById(slot.activePokemonId, 'moves currentHp nature level speciesId hasHiddenAbility').lean();
    if (!poke) continue;

    const movesWithPP = (poke.moves as { moveId: string; currentPP: number; maxPP: number }[]).filter(m => m.currentPP > 0);
    if (movesWithPP.length === 0) continue;

    type AiStrategy = 'random' | 'optimal' | 'defensive' | 'custom';
    const npcDoc = (!isWild && slot.npcId) ? await Npc.findById(slot.npcId, 'aiStrategy').lean() : null;
    const strategy: AiStrategy = (npcDoc?.aiStrategy as AiStrategy | undefined) ?? 'random';
    const actorObjId = new mongoose.Types.ObjectId(actorId.toString());

    if (strategy === 'defensive') {
      const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'baseStats').lean();
      const maxHp = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp : poke.currentHp;

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
      const atkAbility = atkCache ? resolveAbilitySlug(atkCache.abilities as CachedAbility[], poke.hasHiddenAbility ?? false) : null;

      const targetPokes = activePlayerIds.length > 0
        ? await Pokemon.find({ _id: { $in: activePlayerIds } }, 'currentHp nature level speciesId hasHiddenAbility').lean()
        : [];
      const tCaches = targetPokes.length > 0
        ? await PokedexCache.find({ pokeApiId: { $in: targetPokes.map(t => t.speciesId) } }, 'pokeApiId name abilities').lean()
        : [];
      const cacheBySpecies = new Map(tCaches.map(c => [c.pokeApiId as number, c]));

      let bestScore = -1;
      for (const mv of movesWithPP) {
        if (NO_TARGET_MOVE_IDS.has(mv.moveId)) continue;
        for (const tgt of targetPokes) {
          const tCache = cacheBySpecies.get(tgt.speciesId);
          if (!tCache) continue;
          const tAbility = resolveAbilitySlug(tCache.abilities as CachedAbility[], tgt.hasHiddenAbility ?? false);
          const score = await estimateDamage(poke, atkCache ?? { name: poke.speciesId }, atkAbility, mv.moveId, tgt, tCache, tAbility, battle.weather as string | null);
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
