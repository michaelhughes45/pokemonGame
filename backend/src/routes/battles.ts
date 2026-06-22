import { Router, Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { requireDm } from '../middleware/auth';
import { Battle, IBattle, TurnQueueEntry, StatStages } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { Item } from '../models/Item';
import { PokedexCache } from '../models/PokedexCache';
import { Npc } from '../models/Npc';
import { computeStats, expForLevel, BaseStats, NATURES } from '../lib/statCalc';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field } from '@smogon/calc';
import { fetchSpecies } from '../lib/pokeapi';
import { canEvolve } from '../lib/evolution';
import { BATTLE_ITEM_EFFECTS, BALL_MODIFIERS, statusCatchModifier } from '../lib/itemData';
import {
  GEN9,
  type CachedAbility,
  slugToDisplayName,
  pokeDisplayName,
  toCalcWeather,
  toCalcStatus,
  resolveAbilitySlug,
  applyStatStageEffects,
  cap,
  ZERO_STATS,
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
import {
  StatusMoveEffect,
  STATUS_MOVES,
  MOVE_PRIORITY,
  FLINCH_MOVES,
  SELF_TARGETING_MOVES,
  CHARGE_MOVES,
  CHARGE_MESSAGES,
  SEMI_INVULNERABLE_MOVES,
  StatEffect,
  STAT_STAGE_MOVES,
  STAT_DISPLAY_NAMES,
  RecoveryEffect,
  RECOVERY_MOVES,
  CONTACT_MOVES,
  PROTECT_VOLATILE,
  RecoilEffect,
  RECOIL_MOVES,
  MultiHitEffect,
  MULTI_HIT_MOVES,
  getHitCount,
  DrainEffect,
  DRAIN_MOVES,
  NO_TARGET_MOVE_IDS,
  PRANKSTER_MOVES,
  getMoveTargetCategory,
} from '../lib/moveData';

const router = Router();

// Finds or creates the log entry for the current turn and appends events to it.
function appendToLog(battle: HydratedDocument<IBattle>, ...events: string[]): void {
  if (events.length === 0) return;
  let entry = battle.turnLog.find(t => t.turn === battle.turnNumber);
  if (!entry) {
    battle.turnLog.push({ turn: battle.turnNumber, events: [] });
    entry = battle.turnLog[battle.turnLog.length - 1];
  }
  for (const ev of events) entry.events.push(ev);
  battle.markModified('turnLog');
}

// ---------------------------------------------------------------------------
// Helper: after every move submission, check whether every actor that has an
// active Pokémon has now submitted. If so, sort the turnQueue by effective
// speed (highest first) and advance the phase to 'targeting'.
// ---------------------------------------------------------------------------
async function checkAndAdvance(battle: HydratedDocument<IBattle>): Promise<void> {
  // All players must have sent out a Pokémon before the phase can advance
  if (battle.playerSide.some(e => e.activePokemonId == null)) return;

  const playerActors = battle.playerSide; // all have active Pokémon at this point
  const npcActors    = battle.enemySide.filter(e => e.activePokemonId != null);
  const totalActors  = playerActors.length + npcActors.length;

  if (totalActors === 0 || battle.turnQueue.length < totalActors) return;

  // All actors submitted — fetch Pokémon documents for speed calculation
  const pokemonIds = battle.turnQueue.map(e => e.activePokemonId);
  const pokemons   = await Pokemon.find({ _id: { $in: pokemonIds } }, 'speciesId level nature statusCondition hasHiddenAbility').lean();
  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats abilities').lean();

  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const pokemonMap = new Map(pokemons.map(p => [p._id.toString(), p]));

  const withSpeed = battle.turnQueue.map(entry => {
    const poke  = pokemonMap.get(entry.activePokemonId.toString());
    const cache = poke ? cacheMap.get(poke.speciesId) : null;

    // Resolve ability first — needed for both speed doubling and Prankster
    const abilitySlug = poke && cache
      ? resolveAbilitySlug((cache.abilities as CachedAbility[]) ?? [], (poke.hasHiddenAbility as boolean) ?? false)
      : null;

    const rawSpeed = poke && cache
      ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).speed
      : 0;
    // Paralysis halves speed; weather speed doublers (Swift Swim, Chlorophyll, etc.) double it.
    // Both can apply simultaneously — halve first, then double, matching main-game order.
    const afterParalysis = poke?.statusCondition === 'paralysis' ? Math.floor(rawSpeed * 0.5) : rawSpeed;
    const weatherMatches = abilitySlug != null
      && (WEATHER_SPEED_DOUBLERS[abilitySlug] ?? []).includes(battle.weather ?? '');
    const speed = weatherMatches ? afterParalysis * 2 : afterParalysis;

    // Prankster: status-category moves gain +1 priority for this actor
    const pranksterBonus = abilitySlug === 'prankster' && PRANKSTER_MOVES.has(entry.moveId ?? '') ? 1 : 0;
    const movePriority   = (MOVE_PRIORITY[entry.moveId ?? ''] ?? 0) + pranksterBonus;

    return { entry, speed, movePriority };
  });

  // Sort order:
  //   1. Action type tier — items/catch (2) → switches (1) → moves/run (0)
  //   2. Move priority tier — Quick Attack (+1) beats normal moves (0), Prankster adds +1 to status moves.
  //      Only applies within the moves tier; items and switches are unaffected.
  //   3. Speed — highest goes first within the same priority tier.
  const actionPriority = (t: string) => (t === 'item' || t === 'catch' ? 2 : t === 'switch' ? 1 : 0);
  withSpeed.sort((a, b) => {
    const actionDiff = actionPriority(b.entry.actionType) - actionPriority(a.entry.actionType);
    if (actionDiff !== 0) return actionDiff;
    const movePriorityDiff = b.movePriority - a.movePriority;
    if (movePriorityDiff !== 0) return movePriorityDiff;
    return b.speed - a.speed;
  });

  // battle.set() is the proper Mongoose API for replacing a field — it wraps
  // the value in a DocumentArray and marks the path modified automatically.
  battle.set('turnQueue', withSpeed.map(x => x.entry));
  battle.phase              = 'targeting';
  battle.currentTargetIndex = 0;

  await autoSkipBlockedActors(battle);
}




// Checks whether a Pokémon is blocked by its status condition this turn.
// Handles the sleep counter (decrement/wake-up), freeze thaw roll (20%),
// and paralysis skip roll (25%). Applies any state changes directly to the DB.
// Only sleep, freeze, and paralysis block move execution — burn/poison/toxic do not.
async function checkStatusBlock(
  pokemonId:       mongoose.Types.ObjectId,
  statusCondition: string | null,
  statusCounter:   number | null,
  displayName:     string,
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
    // Fall back to a fresh random counter if one was never set (e.g. manually applied in DB)
    const counter    = statusCounter !== null && statusCounter > 0 ? statusCounter : Math.floor(Math.random() * 3) + 1;
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

// Applies a battle item action (already submitted with target pre-filled).
// Looks up the effect, updates the target Pokémon's HP/status, deducts the item
// from the bag (only on a successful use), and returns turn-log event strings.
async function resolveItemAction(entry: TurnQueueEntry): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;

  if (!itemId || targets.length === 0) return events;

  const effect = BATTLE_ITEM_EFFECTS[itemId];
  if (!effect) return events;

  const targetId = targets[0];

  const pokemon = await Pokemon.findById(
    targetId,
    'nickname speciesId level nature currentHp statusCondition',
  ).lean();
  if (!pokemon) return events;

  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }, 'name baseStats').lean();
  const displayName = pokeDisplayName(pokemon, cache);
  const maxHp = cache
    ? computeStats(cache.baseStats as BaseStats, pokemon.level, pokemon.nature).hp
    : pokemon.currentHp;

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
      if (pokemon.currentHp < maxHp) {
        updates.currentHp = maxHp;
        parts.push('HP fully restored');
      }
      if (pokemon.statusCondition) {
        updates.statusCondition = null;
        updates.statusCounter   = null;
        parts.push('status cleared');
      }
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
      await Pokemon.updateOne(
        { _id: targetId },
        { $set: { currentHp: restoreHp, statusCondition: null, statusCounter: null } },
      );
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
        await Pokemon.updateOne(
          { _id: targetId },
          { $set: { statusCondition: null, statusCounter: null } },
        );
        events.push(`${userName} used ${itemName} on ${displayName}! ${pokemon.statusCondition} was cured.`);
        wasUsed = true;
      }
    }
  }

  if (wasUsed) {
    const item = await Item.findOne({ ownerId: actorId, itemId });
    if (item) {
      if (item.quantity <= 1) {
        await Item.deleteOne({ _id: item._id });
      } else {
        await Item.updateOne({ _id: item._id }, { $inc: { quantity: -1 } });
      }
    }
  }

  return events;
}

// Resolves a switch action: recalls the outgoing Pokémon (clearing its volatile
// statuses), sets the incoming Pokémon as active, and adds it to usedPokemonIds.
// Returns turn-log event strings.

// Fires when any Pokémon is sent onto the field (send-out, dm-send-out, mid-battle switch).
// Handles Intimidate and weather-setting abilities. Returns turn-log event strings.
async function applyEntryAbilities(
  battle:       HydratedDocument<IBattle>,
  incomingId:   mongoose.Types.ObjectId,
  incomingSide: 'player' | 'enemy',
): Promise<string[]> {
  const poke = await Pokemon.findById(incomingId, 'speciesId nickname hasHiddenAbility').lean();
  if (!poke) return [];
  const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name abilities').lean();
  if (!cache) return [];

  const abilities = (cache.abilities as CachedAbility[]) ?? [];
  const ability   = (poke.hasHiddenAbility as boolean)
    ? (abilities.find(a => a.isHidden) ?? abilities.find(a => !a.isHidden))
    : abilities.find(a => !a.isHidden);
  if (!ability) return [];

  const pokeName    = pokeDisplayName(poke, cache);
  const abilitySlug = ability.name;
  const abilityName = slugToDisplayName(abilitySlug);
  const events: string[] = [];

  // Weather-setting abilities (Drought, Drizzle, Sand Stream, Snow Warning)
  const entryWeather = ENTRY_ABILITY_WEATHER[abilitySlug];
  if (entryWeather) {
    if (battle.weather === entryWeather) {
      // Same weather already active — no visible effect
    } else if (battle.weather) {
      battle.weather               = null;
      battle.weatherTurnsRemaining = null;
      events.push(`${pokeName}'s ${abilityName}! The weather cleared!`);
    } else {
      battle.weather               = entryWeather;
      battle.weatherTurnsRemaining = null; // indefinite — ability weather has no countdown
      events.push(`${pokeName}'s ${abilityName}! ${ENTRY_WEATHER_MESSAGES[entryWeather]}`);
    }
  }

  // Intimidate — lowers Atk of all active opposing Pokémon by 1
  if (abilitySlug === 'intimidate') {
    const stageMap     = battle.statStages as Record<string, StatStages>;
    const opposingSide = incomingSide === 'player' ? battle.enemySide : battle.playerSide;
    const hasTargets   = opposingSide.some(e => e.activePokemonId);

    if (hasTargets) {
      events.push(`${pokeName}'s ${abilityName}!`);
      for (const entry of opposingSide) {
        if (!entry.activePokemonId) continue;
        const targetId   = entry.activePokemonId.toString();
        const target     = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId hasHiddenAbility').lean();
        const tgtCache   = target ? await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name abilities').lean() : null;
        const targetName = pokeDisplayName(target, tgtCache);
        const tgtAbility = target && tgtCache ? resolveAbilitySlug((tgtCache.abilities as CachedAbility[]) ?? [], target.hasHiddenAbility as boolean) : null;
        events.push(...applyStatStageEffects(stageMap, targetId, [{ stat: 'atk', stages: -1, target: 'foe' }], targetName, tgtAbility));

        // Competitive/Defiant: react to Intimidate's Atk drop
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

// Applies switch-out ability effects for the outgoing Pokémon and returns turn-log events.
// Natural Cure clears any non-volatile status; Regenerator restores 1/3 max HP.
async function applySwitchOutAbilities(
  pokemonId: string,
  outgoing:  Record<string, unknown> | null,
  outCache:  Record<string, unknown> | null,
  outName:   string,
): Promise<string[]> {
  if (!outgoing || !outCache) return [];

  const abilitySlug = resolveAbilitySlug(
    (outCache.abilities as CachedAbility[]) ?? [],
    (outgoing.hasHiddenAbility as boolean) ?? false,
  );
  if (!abilitySlug) return [];

  const events: string[] = [];

  if (abilitySlug === 'natural-cure' && outgoing.statusCondition) {
    await Pokemon.updateOne({ _id: pokemonId }, { $set: { statusCondition: null, statusCounter: null } });
    events.push(`${outName}'s Natural Cure! ${outName}'s status was cured!`);
  }

  if (abilitySlug === 'regenerator') {
    const maxHp     = computeStats(outCache.baseStats as BaseStats, outgoing.level as number, outgoing.nature as string).hp;
    const currentHp = outgoing.currentHp as number;
    if (currentHp < maxHp) {
      const healAmt = Math.max(1, Math.floor(maxHp / 3));
      const newHp   = Math.min(maxHp, currentHp + healAmt);
      await Pokemon.updateOne({ _id: pokemonId }, { $set: { currentHp: newHp } });
      events.push(`${outName}'s Regenerator! ${outName} restored ${newHp - currentHp} HP!`);
    }
  }

  return events;
}

// Clears volatile status and stat stages for the outgoing Pokémon, logs the recall
// event, and fires switch-out ability effects. Shared by NPC and player recall paths.
async function recallPokemon(
  battle:     HydratedDocument<IBattle>,
  outgoingId: mongoose.Types.ObjectId,
): Promise<string[]> {
  await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  delete (battle.statStages as Record<string, StatStages>)[outgoingId.toString()];
  battle.markModified('statStages');
  const outgoing = await Pokemon.findById(
    outgoingId, 'nickname speciesId hasHiddenAbility statusCondition currentHp nature level',
  ).lean();
  const outCache = outgoing
    ? await PokedexCache.findOne({ pokeApiId: outgoing.speciesId }, 'name abilities baseStats').lean()
    : null;
  const outName  = pokeDisplayName(outgoing, outCache);
  const events   = [`${outName} was recalled!`];
  events.push(...await applySwitchOutAbilities(outgoingId.toString(), outgoing, outCache, outName));
  return events;
}

async function resolveSwitch(
  battle: HydratedDocument<IBattle>,
  entry:  TurnQueueEntry,
): Promise<string[]> {
  if (!entry.switchToPokemonId) return [];

  const incomingId = entry.switchToPokemonId;
  const events: string[] = [];

  if (entry.actorType === 'npc') {
    // When an NPC has multiple slots (one per player), match by both npcId and
    // activePokemonId so the switch lands on the exact slot that queued it.
    const npcEntry = battle.enemySide.find(
      e => e.npcId?.toString() === entry.actorId.toString()
        && e.activePokemonId?.toString() === entry.activePokemonId.toString(),
    );
    if (!npcEntry) return [];

    const outgoingId = npcEntry.activePokemonId;
    if (outgoingId) events.push(...await recallPokemon(battle, outgoingId));

    npcEntry.activePokemonId = incomingId;
  } else {
    const playerEntry = battle.playerSide.find(
      e => e.userId.toString() === entry.actorId.toString(),
    );
    if (!playerEntry) return [];

    const outgoingId = playerEntry.activePokemonId;
    if (outgoingId) events.push(...await recallPokemon(battle, outgoingId));

    playerEntry.activePokemonId = incomingId;

    const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === incomingId.toString());
    if (!alreadyUsed) {
      playerEntry.usedPokemonIds.push(incomingId);
    }
  }

  const incoming = await Pokemon.findById(incomingId, 'nickname speciesId').lean();
  const inCache  = incoming
    ? await PokedexCache.findOne({ pokeApiId: incoming.speciesId }, 'name').lean()
    : null;
  const inName   = pokeDisplayName(incoming, inCache);
  events.push(`${inName} was sent out!`);

  const incomingSide = entry.actorType === 'npc' ? 'enemy' : 'player';
  events.push(...await applyEntryAbilities(battle, incomingId, incomingSide));

  return events;
}

// ---------------------------------------------------------------------------
// Catch mechanics
// ---------------------------------------------------------------------------


async function resolveCatchAction(
  battle: HydratedDocument<IBattle>,
  entry:  TurnQueueEntry,
): Promise<string[]> {
  const events: string[] = [];
  const { itemId, targets, actorId } = entry;
  if (!itemId || targets.length === 0) return events;

  const wildPoke = await Pokemon.findById(
    targets[0],
    'nickname speciesId level nature currentHp statusCondition moves',
  ).lean();
  if (!wildPoke || wildPoke.currentHp <= 0) {
    events.push('The wild Pokémon has already fainted!');
    return events;
  }

  const cache       = await PokedexCache.findOne({ pokeApiId: wildPoke.speciesId }, 'name baseStats catchRate types').lean();
  const speciesName = cache ? slugToDisplayName(cache.name as string) : 'Wild Pokémon';
  const displayName = wildPoke.nickname ?? speciesName;
  const user        = await User.findById(actorId, 'username').lean();
  const userName    = user?.username ?? 'Trainer';
  const ballName    = slugToDisplayName(itemId);

  events.push(`${userName} threw a ${ballName} at ${displayName}!`);

  const maxHp = cache
    ? computeStats(cache.baseStats as BaseStats, wildPoke.level, wildPoke.nature).hp
    : wildPoke.currentHp;

  let caught = false;

  if (itemId === 'master-ball') {
    caught = true;
  } else {
    let ballMod = BALL_MODIFIERS[itemId] ?? 1.0;
    if (itemId === 'quick-ball') ballMod = battle.turnNumber === 1 ? 5.0 : 1.0;
    if (itemId === 'timer-ball') ballMod = Math.min(4.0, 1 + 0.3 * battle.turnNumber);
    if (itemId === 'nest-ball')  ballMod = Math.max(1.0, Math.min(4.0, (41 - wildPoke.level) / 10));
    if (itemId === 'net-ball') {
      const types = (cache?.types ?? []) as string[];
      ballMod = types.some(t => t === 'water' || t === 'bug') ? 3.0 : 1.0;
    }

    const hpModifier = (3 * maxHp - 2 * wildPoke.currentHp) / (3 * maxHp);
    const statusMod  = statusCatchModifier(wildPoke.statusCondition);
    const catchRate  = (cache?.catchRate as number) ?? 45;
    const catchValue = Math.min(255, Math.floor(catchRate * ballMod * hpModifier * statusMod));

    // Gen 3+ shake check: shakeCheck = floor(65536 / (255/catchValue)^0.1875)
    // Each shake passes if random(0–65535) < shakeCheck
    const shakeCheck = Math.floor(65536 / Math.pow(255 / Math.max(catchValue, 1), 0.1875));
    let shakes = 0;
    const shakeLabels = ['once', 'twice', 'three times'];
    for (let i = 0; i < 3; i++) {
      if (Math.floor(Math.random() * 65536) < shakeCheck) {
        shakes++;
        events.push(`The ball shook ${shakeLabels[i]}...`);
      } else break;
    }
    caught = shakes === 3;

    if (!caught) {
      const shakeMessages = [
        'Oh no! The Pokémon broke free!',
        'Darn! It appeared to be caught!',
        'Aargh! Almost had it!',
      ];
      events.push(shakeMessages[shakes] ?? 'The Pokémon broke free!');
    }
  }

  // Log the attempt on the battle document
  battle.catchAttempts.push({
    playerId:  new mongoose.Types.ObjectId(actorId.toString()),
    pokemonId: new mongoose.Types.ObjectId(targets[0].toString()),
    result:    caught ? 'caught' : 'failed',
  });
  battle.markModified('catchAttempts');

  // Consume the Pokéball regardless of outcome
  await Item.updateOne({ ownerId: actorId, itemId }, { $inc: { quantity: -1 } });
  await Item.deleteMany({ ownerId: actorId, itemId, quantity: { $lte: 0 } });

  if (caught) {
    // Find the lowest open party slot for this player (no hard cap)
    const partyPokemon = await Pokemon.find(
      { ownerId: actorId, ownerType: 'player', isInParty: true },
      'partySlot',
    ).lean();
    const usedSlots = new Set(partyPokemon.map(p => p.partySlot));
    let nextSlot = 1;
    while (usedSlots.has(nextSlot)) nextSlot++;
    const goesToParty = true;

    const healedMoves = ((wildPoke as any).moves ?? []).map((m: any) => ({ ...m, currentPP: m.maxPP }));
    await Pokemon.updateOne(
      { _id: targets[0] },
      {
        $set: {
          ownerType:        'player',
          ownerId:          actorId,
          isInParty:        goesToParty,
          partySlot:        goesToParty ? nextSlot : null,
          caughtAt:         new Date(),
          caughtByPlayerId: actorId,
          // Only heal when going to PC — party catches keep their battle HP/status
          ...(goesToParty ? {} : {
            currentHp:       maxHp,
            statusCondition: null,
            statusCounter:   null,
            volatileStatus:  [],
            moves:           healedMoves,
          }),
        },
      },
    );
    // Remove from the active slot so checkBattleEnd sees no active enemy
    const enemyEntry = battle.enemySide.find(
      e => e.activePokemonId?.toString() === targets[0].toString(),
    );
    if (enemyEntry) {
      enemyEntry.fainted.push(new mongoose.Types.ObjectId(targets[0].toString()));
      enemyEntry.activePokemonId = null;
      battle.markModified('enemySide');
    }
    const destination = goesToParty ? `added to your party (slot ${nextSlot})` : 'transferred to your PC';
    events.push(`Gotcha! ${displayName} was caught! It was ${destination}.`);
  }

  return events;
}

// Starting from battle.currentTargetIndex, auto-skips consecutive actors whose
// move is blocked by sleep, freeze, or paralysis. Stops at the first actor that
// can move (or when the queue is exhausted, in which case applyEndOfRound fires).
// Called at two points: when the phase first becomes 'targeting' (checkAndAdvance)
// and after each actor resolves in submit-target — so blocked actors never need
// client input and the battle advances automatically past them.
async function autoSkipBlockedActors(battle: HydratedDocument<IBattle>): Promise<void> {
  while (battle.currentTargetIndex < battle.turnQueue.length) {
    const entry = battle.turnQueue[battle.currentTargetIndex];

    // Item actions are fully specified at submission time — auto-resolve without client input.
    if (entry.actionType === 'item') {
      const itemEvents = await resolveItemAction(entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...itemEvents);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    // Catch actions are fully specified at submission time — auto-resolve, then check if battle ended.
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

    // Run actions resolve in speed order but require no targeting input.
    if (entry.actionType === 'run') {
      const poke  = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId').lean();
      const cache = poke ? await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean() : null;
      const name  = pokeDisplayName(poke, cache);
      appendToLog(battle, `${name} dashes away to reposition!`);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    // Switch actions are fully specified at submission time — auto-resolve without client input.
    if (entry.actionType === 'switch') {
      const switchEvents = await resolveSwitch(battle, entry as unknown as TurnQueueEntry);
      appendToLog(battle, ...switchEvents);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    const poke = await Pokemon.findById(
      entry.activePokemonId,
      'nickname speciesId statusCondition statusCounter currentHp',
    ).lean();

    // Skip actors whose Pokémon fainted earlier this round (hit by a faster actor)
    if (!poke || poke.currentHp <= 0) {
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    // Skip flinched actors — flinch can only be set by a faster attacker, so this
    // Pokémon had not yet moved when it was hit.
    if (entry.flinched) {
      const flinchCache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      const flinchName  = pokeDisplayName(poke, flinchCache);
      appendToLog(battle, `${flinchName} flinched and couldn't move!`);
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    if (!poke.statusCondition) break; // no status — this actor moves normally

    const cache       = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
    const displayName = pokeDisplayName(poke, cache);

    const { blocked, events } = await checkStatusBlock(
      poke._id as mongoose.Types.ObjectId,
      poke.statusCondition,
      poke.statusCounter,
      displayName,
    );

    // Log events before the break check — wake-up and thaw emit events with blocked:false
    appendToLog(battle, ...events);

    if (!blocked) break; // this actor moves normally — stop skipping

    battle.turnQueue[battle.currentTargetIndex].resolved = true;
    battle.currentTargetIndex++;
  }

  if (battle.currentTargetIndex >= battle.turnQueue.length) {
    await applyEndOfRound(battle);
  }
}

// Checks and processes confusion for the given Pokémon at the start of their move.
// Decrements the confusion counter each turn; on the last turn, the roll still fires
// and snap-out is announced afterward (matching Gen 8+ behavior).
// Returns hitSelf:true when the Pokémon hurts itself — in that case the caller should
// skip resolveMove and PP deduction entirely.
async function checkConfusion(
  pokemonId: mongoose.Types.ObjectId,
): Promise<{ hitSelf: boolean; events: string[] }> {
  const poke = await Pokemon.findById(
    pokemonId,
    'nickname speciesId level nature currentHp volatileStatus hasHiddenAbility',
  ).lean();
  if (!poke) return { hitSelf: false, events: [] };

  const confIdx = (poke.volatileStatus ?? []).findIndex(v => v.condition === 'confusion');
  if (confIdx === -1) return { hitSelf: false, events: [] };

  const cache       = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name baseStats abilities').lean();
  const displayName = pokeDisplayName(poke, cache);

  // If the Pokémon has an immunity ability, snap it out immediately rather than rolling the 50% check.
  const abilitySlug = resolveAbilitySlug(
    (cache?.abilities as CachedAbility[]) ?? [],
    poke.hasHiddenAbility as boolean,
  );
  if (abilitySlug && (STATUS_IMMUNITY_ABILITIES[abilitySlug] ?? []).includes('confusion')) {
    await Pokemon.updateOne({ _id: pokemonId }, { $pull: { volatileStatus: { condition: 'confusion' } } });
    return { hitSelf: false, events: [`${displayName}'s ${slugToDisplayName(abilitySlug)} snapped it out of confusion!`] };
  }

  const newTurns   = poke.volatileStatus[confIdx].turnsRemaining - 1;
  const didSnapOut = newTurns <= 0;

  if (didSnapOut) {
    await Pokemon.updateOne({ _id: pokemonId }, { $pull: { volatileStatus: { condition: 'confusion' } } });
  } else {
    await Pokemon.updateOne(
      { _id: pokemonId, 'volatileStatus.condition': 'confusion' },
      { $set: { 'volatileStatus.$.turnsRemaining': newTurns } },
    );
  }

  const events: string[] = [`${displayName} is confused...`];

  // 50% self-hit (skip if cache is missing — can't calculate damage without base stats)
  if (Math.random() < 0.5 && cache) {
    const stats  = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature);
    // Standard Gen 5+ confusion damage: 40-power typeless physical, own Atk vs own Def, no crit
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

// Attempts to apply a status effect to a target Pokémon.
// Checks: target already has a status, target is already confused (for confusion),
// and type-based immunity (Electric immune to paralysis, Fire to burn, etc.).
// For sleep: sets a random 1–3 turn counter. For toxic: sets counter to 1 (first tick).
// For confusion: sets a random 2–5 turn counter in volatileStatus.
async function applyStatusEffect(
  targetId: mongoose.Types.ObjectId,
  effect:   StatusMoveEffect,
): Promise<string[]> {
  const target = await Pokemon.findById(
    targetId,
    'nickname speciesId statusCondition volatileStatus currentHp hasHiddenAbility',
  ).lean();
  if (!target || target.currentHp <= 0) return [];

  const isConfusion = effect.status === 'confusion';

  if (!isConfusion && target.statusCondition) return [];
  if (isConfusion && target.volatileStatus.some(v => v.condition === 'confusion')) return [];

  const cache = await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name types abilities').lean();
  const types = (cache?.types ?? []) as string[];
  const displayName = pokeDisplayName(target, cache);

  const isImmune = (
    (effect.status === 'paralysis' && types.includes('electric')) ||
    (effect.status === 'burn'      && types.includes('fire'))     ||
    ((effect.status === 'poison' || effect.status === 'toxic') &&
      (types.includes('poison') || types.includes('steel')))      ||
    (effect.status === 'freeze'    && types.includes('ice'))
  );
  if (isImmune) return [];

  const abilitySlug = resolveAbilitySlug(
    (cache?.abilities as CachedAbility[]) ?? [],
    target.hasHiddenAbility as boolean,
  );
  if (abilitySlug) {
    const immuneStatuses = STATUS_IMMUNITY_ABILITIES[abilitySlug] ?? [];
    if (immuneStatuses.includes(effect.status)) {
      return [`${displayName}'s ${slugToDisplayName(abilitySlug)} prevents the ${effect.status}!`];
    }
  }

  if (isConfusion) {
    const turnsRemaining = Math.floor(Math.random() * 4) + 2; // 2–5 turns
    await Pokemon.updateOne(
      { _id: targetId },
      { $push: { volatileStatus: { condition: 'confusion', turnsRemaining } } },
    );
    return [`${displayName} became confused!`];
  }

  const update: Record<string, unknown> = { statusCondition: effect.status };
  if (effect.status === 'sleep') update.statusCounter = Math.floor(Math.random() * 3) + 1;
  if (effect.status === 'toxic') update.statusCounter = 1;
  await Pokemon.updateOne({ _id: targetId }, { $set: update });

  const labels: Record<string, string> = {
    burn: 'burned', paralysis: 'paralyzed', sleep: 'fell asleep',
    freeze: 'was frozen solid', poison: 'was poisoned', toxic: 'was badly poisoned',
  };
  return [`${displayName} ${labels[effect.status]}!`];
}

// Resolve a single move from one attacker against one target.
// Runs @smogon/calc with a random damage roll and a 1/24 crit roll.
// Returns the damage dealt and human-readable event strings for the turn log.
async function resolveMove(
  attackerPokemonId: mongoose.Types.ObjectId,
  targetPokemonId:   mongoose.Types.ObjectId,
  moveId:            string,
  weather:           IBattle['weather'],
  stages:            { attacker?: StatStages; target?: StatStages } = {},
): Promise<{ damage: number; isCrit: boolean; events: string[] }> {
  const [attacker, target] = await Promise.all([
    Pokemon.findById(attackerPokemonId).lean(),
    Pokemon.findById(targetPokemonId).lean(),
  ]);
  if (!attacker || !target) {
    return { damage: 0, isCrit: false, events: ['(Pokémon not found during move resolution)'] };
  }

  const [attackerCache, targetCache] = await Promise.all([
    PokedexCache.findOne({ pokeApiId: attacker.speciesId }).lean(),
    PokedexCache.findOne({ pokeApiId: target.speciesId }).lean(),
  ]);
  if (!attackerCache || !targetCache) {
    return { damage: 0, isCrit: false, events: ['(Species cache missing during move resolution)'] };
  }

  const attackerName = pokeDisplayName(attacker, attackerCache);
  const targetName   = pokeDisplayName(target, targetCache);
  const moveName     = slugToDisplayName(moveId);

  // Look up the move's data from the attacker's species cache.
  // The `name` field on each cached move is the PokeAPI slug, matching moveId.
  const moveData = (attackerCache.moves as Array<{
    name: string; type: string; category: string; power: number | null; implemented: boolean;
  }>).find(m => m.name === moveId);

  // Status moves and unrecognised moves deal no damage
  if (!moveData || !moveData.power) {
    const implNote = moveData && !moveData.implemented && !(moveId in STATUS_MOVES) && !(moveId in WEATHER_MOVES) && !SELF_TARGETING_MOVES.has(moveId) ? ' (effect not yet implemented)' : '';
    return {
      damage: 0,
      isCrit: false,
      events: [`${attackerName} used ${moveName} on ${targetName}.${implNote}`],
    };
  }

  const attackerVolatiles = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
  const hasFocusEnergy    = attackerVolatiles.some(v => v.condition === 'focus-energy');
  const isCrit = Math.random() < (hasFocusEnergy ? 1 / 6 : 1 / 24); // Gen 6+ base; Focus Energy raises to 1/6

  // First non-hidden ability from each species cache, converted to the display
  // name format @smogon/calc expects ("speed-boost" → "Speed Boost").
  const attackerAbilities = (attackerCache.abilities as CachedAbility[]) ?? [];
  const targetAbilities   = (targetCache.abilities   as CachedAbility[]) ?? [];
  const attackerAbility = attacker.hasHiddenAbility
    ? (attackerAbilities.find(a => a.isHidden) ?? attackerAbilities.find(a => !a.isHidden))
    : attackerAbilities.find(a => !a.isHidden);
  const targetAbility = target.hasHiddenAbility
    ? (targetAbilities.find(a => a.isHidden) ?? targetAbilities.find(a => !a.isHidden))
    : targetAbilities.find(a => !a.isHidden);
  const attackerAbilityName = attackerAbility ? slugToDisplayName(attackerAbility.name) : undefined;
  const targetAbilityName   = targetAbility   ? slugToDisplayName(targetAbility.name)   : undefined;

  // Check if a pinch ability (Torrent, Blaze, Overgrow, Swarm) is active this turn.
  const pinchEvents: string[] = [];
  if (attackerAbility) {
    const boostedType = PINCH_ABILITIES[attackerAbility.name];
    if (boostedType && moveData.type?.toLowerCase() === boostedType) {
      const maxHp = computeStats(attackerCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
      if (attacker.currentHp <= Math.floor(maxHp / 3)) {
        pinchEvents.push(`${attackerName}'s ${attackerAbilityName}!`);
      }
    }
  }

  let damage    = 0;
  let effectNote = '';

  try {
    // Strip acc/eva — smogon/calc only uses atk/def/spa/spd/spe in damage formula
    const toBoosts = (s?: StatStages) => s
      ? { atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe }
      : undefined;

    const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), {
      level:   attacker.level,
      nature:  cap(attacker.nature) as any,
      evs:     ZERO_STATS,
      ivs:     ZERO_STATS,
      curHP:   attacker.currentHp,
      status:  toCalcStatus(attacker.statusCondition) as any,
      ability: attackerAbilityName as any,
      boosts:  toBoosts(stages.attacker) as any,
    });

    const calcTarget = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level:   target.level,
      nature:  cap(target.nature) as any,
      evs:     ZERO_STATS,
      ivs:     ZERO_STATS,
      curHP:   target.currentHp,
      ability: targetAbilityName as any,
      boosts:  toBoosts(stages.target) as any,
    });

    const calcMove  = new CalcMove(GEN9, moveName);
    const calcField = new Field({ weather: toCalcWeather(weather) as any });

    const result = calculate(GEN9, calcAttacker, calcTarget, calcMove, calcField);
    const rolls  = Array.isArray(result.damage)
      ? (result.damage as number[])
      : [result.damage as number];
    damage = rolls[Math.floor(Math.random() * rolls.length)];
    // Apply crit multiplier manually (1.5× in Gen 6+)
    if (isCrit && damage > 0) damage = Math.floor(damage * 1.5);

    const desc = result.desc();
    if (damage === 0 || desc.includes('immune'))         effectNote = " It had no effect!";
    else if (desc.includes('super effective'))           effectNote = " It's super effective!";
    else if (desc.includes('not very effective'))        effectNote = " It's not very effective...";
  } catch {
    // Fallback if @smogon/calc doesn't recognise the species or move name
    damage = Math.max(1, Math.floor((moveData.power * attacker.level) / 50));
    // Apply type-changing ability multipliers that @smogon/calc would normally handle
    const atkAbilitySlug = attackerAbility?.name;
    if (atkAbilitySlug === 'protean' || atkAbilitySlug === 'libero') {
      damage = Math.floor(damage * 1.5); // STAB on every move
    } else if (atkAbilitySlug && atkAbilitySlug in ILATE_MAP && moveData.type?.toLowerCase() === 'normal') {
      damage = Math.floor(damage * 1.2); // -ilate power boost
    }
  }

  damage = Math.max(0, damage);

  const critNote = isCrit && damage > 0 ? ' Critical hit!' : '';

  return {
    damage,
    isCrit: isCrit && damage > 0,
    events: [...pinchEvents, `${attackerName} used ${moveName} on ${targetName} for ${damage} damage!${effectNote}${critNote}`],
  };
}

// Checks every active Pokémon on both sides for HP ≤ 0. For each fainted
// Pokémon: logs the faint event, clears volatile statuses, pushes the ID into
// the side's fainted[] array, and nulls activePokemonId on that entry.
// Returns faint event strings so the caller can append them to the turn log.
async function applyFaints(battle: HydratedDocument<IBattle>): Promise<string[]> {
  const events: string[] = [];

  const sides = [
    [battle.playerSide, 'playerSide'],
    [battle.enemySide,  'enemySide'],
  ] as const;

  for (const [entries, sideKey] of sides) {
    for (const entry of entries) {
      if (!entry.activePokemonId) continue;
      const poke = await Pokemon.findById(
        entry.activePokemonId, 'currentHp nickname speciesId',
      ).lean();
      if (!poke || poke.currentHp > 0) continue;

      const cache       = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
      const displayName = pokeDisplayName(poke, cache);
      events.push(`${displayName} fainted!`);

      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { volatileStatus: [] } });
      delete (battle.statStages as Record<string, StatStages>)[entry.activePokemonId.toString()];
      battle.markModified('statStages');
      entry.fainted.push(entry.activePokemonId);
      entry.activePokemonId = null;
      battle.markModified(sideKey);
    }
  }

  return events;
}

// Awards EXP to every Pokémon in each player's party after a player-side victory.
// Gen 6+ Exp. Share: active battlers (usedPokemonIds) get full EXP; benched
// Pokémon get half. Simplified formula: base_exp = sum of (enemy_level × 5) for
// all fainted enemies — replaced by the real per-species yield in Phase 5.
// The expAwarded flag prevents double-awarding if this is called more than once.
async function distributeExp(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.expAwarded) return [];
  battle.expAwarded = true;

  const events: string[] = [];

  const allFaintedEnemyIds = battle.enemySide.flatMap(e => e.fainted);
  if (allFaintedEnemyIds.length === 0) return events;

  const faintedEnemies = await Pokemon.find(
    { _id: { $in: allFaintedEnemyIds } },
    'level',
  ).lean();
  const totalBaseExp = faintedEnemies.reduce((sum, p) => sum + p.level * 5, 0);
  if (totalBaseExp === 0) return events;

  const playerUserIds = battle.playerSide.map(e => e.userId);
  const allPartyPokemon = await Pokemon.find(
    { ownerId: { $in: playerUserIds }, ownerType: 'player', isInParty: true },
    '_id ownerId nickname speciesId level exp nature currentHp evolutionOverrides',
  ).lean();

  const speciesIds = [...new Set(allPartyPokemon.map(p => p.speciesId))];
  const caches = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name expGroup baseStats').lean()
    : [];
  const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));

  for (const playerEntry of battle.playerSide) {
    const usedIds = new Set(playerEntry.usedPokemonIds.map(id => id.toString()));
    const partyPokemon = allPartyPokemon.filter(
      p => p.ownerId.toString() === playerEntry.userId.toString(),
    );

    for (const poke of partyPokemon) {
      const isActive = usedIds.has(poke._id.toString());
      const expGain  = isActive ? totalBaseExp : Math.floor(totalBaseExp / 2);
      if (expGain <= 0) continue;

      const cache       = cacheMap.get(poke.speciesId);
      const displayName = pokeDisplayName(poke, cache);
      events.push(`${displayName} gained ${expGain} EXP${isActive ? '' : ' (Exp. Share)'}!`);

      const newExp      = (poke.exp as number) + expGain;
      let newLevel      = poke.level as number;
      let newHp         = poke.currentHp as number;
      let newSpeciesId  = poke.speciesId as number;
      const expGroup    = (cache?.expGroup as string | undefined) ?? 'medium-fast';
      const baseStats   = cache?.baseStats as BaseStats | undefined;
      const overrides   = (poke.evolutionOverrides ?? []) as { condition: string; value: string }[];

      while (newLevel < 100 && newExp >= expForLevel(newLevel + 1, expGroup)) {
        if (baseStats && newHp > 0) {
          const oldMaxHp = computeStats(baseStats, newLevel, poke.nature as string).hp;
          newLevel += 1;
          const newMaxHp = computeStats(baseStats, newLevel, poke.nature as string).hp;
          newHp += (newMaxHp - oldMaxHp);
        } else {
          newLevel += 1;
        }
        events.push(`${displayName} grew to level ${newLevel}!`);

        const evolveIntoId = await canEvolve({ speciesId: newSpeciesId, level: newLevel, evolutionOverrides: overrides });
        if (evolveIntoId !== null) {
          let evolvedCache = await PokedexCache.findOne({ pokeApiId: evolveIntoId }).select('name baseStats').lean();
          if (!evolvedCache) {
            try {
              const fetched = await fetchSpecies(evolveIntoId);
              const created = await PokedexCache.create(fetched);
              evolvedCache = created.toObject();
            } catch { /* leave null — name falls back below */ }
          }
          if (evolvedCache?.baseStats) {
            newHp = computeStats(evolvedCache.baseStats as BaseStats, newLevel, poke.nature).hp;
          }
          const evolvedName = evolvedCache ? slugToDisplayName(evolvedCache.name as string) : 'a new form';
          events.push(`${displayName} evolved into ${evolvedName}!`);
          newSpeciesId = evolveIntoId;
        }
      }

      await Pokemon.updateOne(
        { _id: poke._id },
        { $set: { exp: newExp, level: newLevel, currentHp: newHp, speciesId: newSpeciesId } },
      );
    }
  }

  return events;
}

// Checks whether one side of the battle has been fully eliminated.
//
// Enemy side eliminated: no NPC has an active Pokémon AND no NPC party Pokémon
// have HP > 0 (the DM has no one left to send out).
//
// Player side eliminated: no player has an active Pokémon AND every player has
// exhausted all sendable options (previously-used Pokémon still alive are always
// sendable; new ones require the limit not to be reached).
//
// When a winner is found, sets battle.status = 'complete' and battle.endedAt,
// then returns the result event string(s) for the turn log.
async function checkBattleEnd(battle: HydratedDocument<IBattle>): Promise<string[]> {
  if (battle.status !== 'active') return [];

  // --- Enemy side ---
  const hasActiveEnemy = battle.enemySide.some(e => e.activePokemonId !== null);
  let enemySideEliminated = false;
  if (!hasActiveEnemy && battle.enemySide.length > 0) {
    const npcIds = battle.enemySide
      .map(e => e.npcId)
      .filter((id): id is mongoose.Types.ObjectId => id != null);
    if (npcIds.length > 0) {
      if (battle.npcPokemonLimit !== null) {
        // Limit set: enemy side is out when every NPC has used their full allowance
        // and all of those Pokémon have fainted — same logic as the player side.
        const results = await Promise.all(
          battle.enemySide.map(async entry => {
            if (!entry.npcId) return true;
            const limitReached = (entry.fainted.length >= battle.npcPokemonLimit!);
            if (limitReached) return true;
            const healthyParty = await Pokemon.find(
              { ownerId: entry.npcId, ownerType: 'npc', currentHp: { $gt: 0 } },
              '_id',
            ).lean();
            return healthyParty.length === 0;
          }),
        );
        enemySideEliminated = results.every(Boolean);
      } else {
        // No limit: all NPC Pokémon across the party must faint
        const healthyEnemyCount = await Pokemon.countDocuments({
          ownerId:   { $in: npcIds },
          ownerType: 'npc',
          currentHp: { $gt: 0 },
        });
        enemySideEliminated = healthyEnemyCount === 0;
      }
    } else {
      // Wild battle: no active Pokémon and no NPC party to fall back to
      enemySideEliminated = true;
    }
  }

  // --- Player side ---
  const hasActivePlayer = battle.playerSide.some(e => e.activePokemonId !== null);
  let playerSideEliminated = false;
  if (!hasActivePlayer && battle.playerSide.length > 0) {
    const results = await Promise.all(
      battle.playerSide.map(async entry => {
        const usedIds      = new Set(entry.usedPokemonIds.map(id => id.toString()));
        const limitReached = battle.playerPokemonLimit !== null
          && entry.usedPokemonIds.length >= battle.playerPokemonLimit;

        const healthyParty = await Pokemon.find(
          { ownerId: entry.userId, ownerType: 'player', isInParty: true, currentHp: { $gt: 0 } },
          '_id',
        ).lean();

        if (healthyParty.length === 0) return true;
        const canSendAny = healthyParty.some(
          p => usedIds.has(p._id.toString()) || !limitReached,
        );
        return !canSendAny;
      }),
    );
    playerSideEliminated = results.every(Boolean);
  }

  if (!enemySideEliminated && !playerSideEliminated) return [];

  battle.status  = 'complete';
  battle.endedAt = new Date();

  if (enemySideEliminated) {
    const expEvents = await distributeExp(battle);
    if (battle.type === 'wild') {
      const wasCaught = battle.catchAttempts.some(a => a.result === 'caught');
      // "Gotcha!" already logged by resolveCatchAction; just add EXP events for a catch
      return wasCaught
        ? expEvents
        : ['The wild Pokémon was defeated!', ...expEvents];
    }
    return ['All enemies have been defeated! The players win!', ...expEvents];
  }
  return ['All players have been defeated!'];
}

// Heal a Pokémon by `fraction` of its maxHp (min 1), capped at maxHp.
// Updates runningHp and the DB in-place; pushes a narration line to allEvents.
// No-ops silently if the Pokémon is already at full HP.
async function applyFractionHeal(
  pokeId:    string,
  pokeObjId: mongoose.Types.ObjectId,
  maxHp:     number,
  fraction:  number,
  runningHp: Map<string, number>,
  label:     string,
  allEvents: string[],
): Promise<void> {
  const curHp = runningHp.get(pokeId) ?? 0;
  if (curHp >= maxHp) return;
  const healAmt = Math.max(1, Math.floor(maxHp * fraction));
  const newHp   = Math.min(maxHp, curHp + healAmt);
  runningHp.set(pokeId, newHp);
  await Pokemon.updateOne({ _id: pokeObjId }, { $set: { currentHp: newHp } });
  allEvents.push(`${label} restored ${newHp - curHp} HP!`);
}

// Apply end-of-round effects (burn/poison/toxic damage, weather damage,
// weather countdown) and park the battle at end_of_round.
async function applyEndOfRound(battle: HydratedDocument<IBattle>): Promise<void> {
  const allActiveIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((id): id is mongoose.Types.ObjectId => id != null);

  if (allActiveIds.length > 0) {
    const activePokemons = await Pokemon.find(
      { _id: { $in: allActiveIds }, currentHp: { $gt: 0 } },
      'speciesId level nature currentHp statusCondition statusCounter nickname volatileStatus hasHiddenAbility',
    ).lean();

    const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
    const caches     = speciesIds.length > 0
      ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types abilities').lean()
      : [];
    const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));


    // Track running HP so stacked end-of-round damage sources don't overwrite each other.
    const runningHp = new Map(activePokemons.map(p => [p._id.toString(), p.currentHp]));
    const allEvents: string[] = [];

    // --- Status damage (burn / poison / toxic) ---
    for (const poke of activePokemons) {
      if (
        poke.statusCondition !== 'burn' &&
        poke.statusCondition !== 'poison' &&
        poke.statusCondition !== 'toxic'
      ) continue;

      const cache = cacheMap.get(poke.speciesId);
      if (!cache) continue;

      const maxHp    = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const pokeName = pokeDisplayName(poke, cache);

      // Poison Heal: heal 1/8 maxHp instead of taking poison/toxic damage.
      const abilitySlugForStatus = resolveAbilitySlug(
        (cache.abilities as CachedAbility[]) ?? [],
        poke.hasHiddenAbility as boolean,
      );
      if (
        (poke.statusCondition === 'poison' || poke.statusCondition === 'toxic') &&
        abilitySlugForStatus === 'poison-heal'
      ) {
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const healAmt   = Math.max(1, Math.floor(maxHp / 8));
        const newHp     = Math.min(maxHp, currentHp + healAmt);
        const restored  = newHp - currentHp;
        if (restored > 0) {
          runningHp.set(poke._id.toString(), newHp);
          await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
          allEvents.push(`${pokeName}'s Poison Heal restored ${restored} HP!`);
        }
        continue;
      }

      // Toxic damage scales each round: counter/16 × maxHp (counter starts at 1, caps at 15).
      // Burn and poison deal a flat 1/8 maxHp.
      let damage: number;
      const update: Record<string, unknown> = {};
      if (poke.statusCondition === 'toxic') {
        const counter = poke.statusCounter ?? 1;
        damage = Math.max(1, Math.floor(maxHp * counter / 16));
        update.statusCounter = Math.min(counter + 1, 15);
      } else {
        damage = Math.max(1, Math.floor(maxHp / 8));
      }

      const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
      const newHp     = Math.max(0, currentHp - damage);
      update.currentHp = newHp;
      runningHp.set(poke._id.toString(), newHp);

      await Pokemon.updateOne({ _id: poke._id }, { $set: update });
      allEvents.push(`${pokeName} is hurt by its ${poke.statusCondition}! (${damage} damage, ${newHp} HP remaining)`);
    }

    // --- Weather damage (sandstorm / hail) ---
    if (battle.weather === 'sandstorm' || battle.weather === 'hail') {
      const SANDSTORM_IMMUNE = new Set(['rock', 'steel', 'ground']);
      const HAIL_IMMUNE      = new Set(['ice']);
      const immuneSet        = battle.weather === 'sandstorm' ? SANDSTORM_IMMUNE : HAIL_IMMUNE;

      for (const poke of activePokemons) {
        const cache = cacheMap.get(poke.speciesId);
        if (!cache) continue;

        const pokeTypes    = (cache.types as string[]) ?? [];
        const isRoosting   = ((poke.volatileStatus as Array<{ condition: string }>) ?? [])
          .some(v => v.condition === 'roosting');
        const effectiveTypes = isRoosting ? pokeTypes.filter(t => t !== 'flying') : pokeTypes;
        if (effectiveTypes.some(t => immuneSet.has(t))) continue;

        const maxHp     = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
        const damage    = Math.max(1, Math.floor(maxHp / 16));
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const newHp     = Math.max(0, currentHp - damage);
        const pokeName  = pokeDisplayName(poke, cache);

        runningHp.set(poke._id.toString(), newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });

        const verb = battle.weather === 'sandstorm' ? 'buffeted by the sandstorm' : 'pelted by hail';
        allEvents.push(`${pokeName} is ${verb}! (${damage} damage, ${newHp} HP remaining)`);
      }
    }

    // Clear single-turn volatiles: Roost (Flying removal), Endure (HP clamp), and all Protect variants.
    // These are only valid for the turn they were used and must not carry into the next round.
    for (const poke of activePokemons) {
      const vol     = (poke.volatileStatus as Array<{ condition: string }>) ?? [];
      const toClear = vol
        .filter(v => v.condition === 'roosting' || v.condition === 'enduring' || v.condition.startsWith('protecting'))
        .map(v => v.condition);
      if (toClear.length > 0) {
        await Pokemon.updateOne({ _id: poke._id }, { $pull: { volatileStatus: { condition: { $in: toClear } } } });
      }
    }

    // --- End-of-round ability effects ---
    // Speed Boost, Rain Dish, Ice Body, Dry Skin, Moody all fire after status and weather damage
    // so their HP changes read from runningHp rather than the original snapshot.
    const stageMap = battle.statStages as Record<string, StatStages>;
    for (const poke of activePokemons) {
      const cache = cacheMap.get(poke.speciesId);
      if (!cache) continue;

      const abilitySlug = resolveAbilitySlug(
        (cache.abilities as CachedAbility[]) ?? [],
        poke.hasHiddenAbility as boolean,
      );
      if (!abilitySlug) continue;

      const pokeName  = pokeDisplayName(poke, cache);
      const maxHp     = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;

      if (abilitySlug === 'speed-boost') {
        const events = applyStatStageEffects(stageMap, poke._id.toString(), [{ stat: 'spe', stages: 1, target: 'self' }], pokeName, abilitySlug);
        allEvents.push(...events);
        battle.markModified('statStages');

      } else if (abilitySlug === 'rain-dish' && battle.weather === 'rain') {
        await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1 / 16, runningHp, `${pokeName}'s Rain Dish`, allEvents);

      } else if (abilitySlug === 'ice-body' && (battle.weather === 'hail' || battle.weather === 'snow')) {
        await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1 / 16, runningHp, `${pokeName}'s Ice Body`, allEvents);

      } else if (abilitySlug === 'dry-skin') {
        if (battle.weather === 'rain') {
          await applyFractionHeal(poke._id.toString(), poke._id, maxHp, 1 / 16, runningHp, `${pokeName}'s Dry Skin`, allEvents);
        } else if (battle.weather === 'sun') {
          const damage = Math.max(1, Math.floor(maxHp / 8));
          const newHp  = Math.max(0, currentHp - damage);
          runningHp.set(poke._id.toString(), newHp);
          await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
          allEvents.push(`${pokeName}'s Dry Skin is seared by the sun! (${damage} damage, ${newHp} HP remaining)`);
        }

      } else if (abilitySlug === 'moody') {
        const allStats: (keyof StatStages)[] = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
        const boostStat  = allStats[Math.floor(Math.random() * allStats.length)];
        const dropStats  = allStats.filter(s => s !== boostStat);
        const dropStat   = dropStats[Math.floor(Math.random() * dropStats.length)];
        const events = [
          ...applyStatStageEffects(stageMap, poke._id.toString(), [{ stat: boostStat, stages: 2,  target: 'self' }], pokeName, abilitySlug),
          ...applyStatStageEffects(stageMap, poke._id.toString(), [{ stat: dropStat,  stages: -1, target: 'self' }], pokeName, abilitySlug),
        ];
        if (events.length) {
          allEvents.push(`${pokeName}'s Moody!`);
          allEvents.push(...events);
          battle.markModified('statStages');
        }

      } else if (abilitySlug === 'shed-skin' && poke.statusCondition) {
        if (Math.random() < 1 / 3) {
          await Pokemon.updateOne({ _id: poke._id }, { $set: { statusCondition: null, statusCounter: null } });
          allEvents.push(`${pokeName}'s Shed Skin! ${pokeName} shed its skin and cured its status!`);
        }
      }
    }

    // --- Volatile end-of-round effects (Ingrain, Aqua Ring, Leech Seed, Cursed) ---
    // Build a set of active IDs per side for Leech Seed restore targeting.
    const playerActiveIds = new Set(battle.playerSide.map(e => e.activePokemonId?.toString()).filter(Boolean));
    const enemyActiveIds  = new Set(battle.enemySide.map(e => e.activePokemonId?.toString()).filter(Boolean));

    for (const poke of activePokemons) {
      const cache    = cacheMap.get(poke.speciesId);
      if (!cache) continue;
      const maxHp    = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const pokeName = pokeDisplayName(poke, cache);
      const pokeId   = poke._id.toString();
      const volStatus = (poke.volatileStatus as Array<{ condition: string }>) ?? [];

      // Ingrain: heal 1/16 maxHp per round
      if (volStatus.some(v => v.condition === 'ingrain')) {
        await applyFractionHeal(pokeId, poke._id, maxHp, 1 / 16, runningHp, `${pokeName}'s Ingrain`, allEvents);
      }

      // Aqua Ring: heal 1/16 maxHp per round
      if (volStatus.some(v => v.condition === 'aqua-ring')) {
        await applyFractionHeal(pokeId, poke._id, maxHp, 1 / 16, runningHp, `${pokeName}'s Aqua Ring`, allEvents);
      }

      // Leech Seed: drain 1/8 maxHp, restore to the first opposing active Pokémon with HP > 0
      if (volStatus.some(v => v.condition === 'leech-seed')) {
        const curHp = runningHp.get(pokeId) ?? poke.currentHp;
        const drain = Math.max(1, Math.floor(maxHp / 8));
        const newHp = Math.max(0, curHp - drain);
        runningHp.set(pokeId, newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeName} had its energy drained by Leech Seed! (${drain} damage)`);

        // Restore to the first active Pokémon on the opposing side that still has HP
        const opposingIds = playerActiveIds.has(pokeId) ? enemyActiveIds : playerActiveIds;
        const recipientId = [...opposingIds].find(id => id && (runningHp.get(id) ?? 0) > 0);
        if (recipientId) {
          const recipient  = activePokemons.find(p => p._id.toString() === recipientId);
          const rCache     = recipient ? cacheMap.get(recipient.speciesId) : null;
          if (recipient && rCache) {
            const rMaxHp  = computeStats(rCache.baseStats as BaseStats, recipient.level, recipient.nature).hp;
            const rCurHp  = runningHp.get(recipientId) ?? recipient.currentHp;
            const restore = Math.min(drain, rMaxHp - rCurHp);
            if (restore > 0) {
              const rNewHp = rCurHp + restore;
              runningHp.set(recipientId, rNewHp);
              await Pokemon.updateOne({ _id: recipient._id }, { $set: { currentHp: rNewHp } });
              const rName = pokeDisplayName(recipient, rCache);
              allEvents.push(`${rName} absorbed the drained energy! (+${restore} HP)`);
            }
          }
        }
      }

      // Cursed (Ghost Curse): deal 1/4 maxHp damage each round
      if (volStatus.some(v => v.condition === 'cursed')) {
        const curHp  = runningHp.get(pokeId) ?? poke.currentHp;
        const damage = Math.max(1, Math.floor(maxHp / 4));
        const newHp  = Math.max(0, curHp - damage);
        runningHp.set(pokeId, newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
        allEvents.push(`${pokeName} is afflicted by the curse! (${damage} damage, ${newHp} HP remaining)`);
      }
    }

    appendToLog(battle, ...allEvents);
  }

  // --- Weather countdown ---
  if (battle.weatherTurnsRemaining !== null) {
    const WEATHER_END: Record<string, string> = {
      rain: 'The rain stopped.',
      sun: 'The harsh sunlight faded.',
      sandstorm: 'The sandstorm subsided.',
      hail: 'The hail stopped.',
      snow: 'The snow stopped.',
    };

    const newTurns = battle.weatherTurnsRemaining - 1;
    if (newTurns <= 0) {
      const endMessage = battle.weather ? WEATHER_END[battle.weather] : 'The weather cleared.';
      battle.weather               = null;
      battle.weatherTurnsRemaining = null;

      appendToLog(battle, endMessage);
    } else {
      battle.weatherTurnsRemaining = newTurns;
    }
  }

  // Detect faints and check for battle end after end-of-round damage
  const eorFaintEvents = await applyFaints(battle);
  const eorEndEvents   = await checkBattleEnd(battle);
  appendToLog(battle, ...eorFaintEvents, ...eorEndEvents);

  // Hold at end_of_round so the DM can read the log before advancing.
  // Only park here if the battle is still active — if checkBattleEnd ended it, leave it complete.
  if (battle.status === 'active') {
    battle.phase = 'end_of_round';
  }
}

// ---------------------------------------------------------------------------
// POST /api/battles
// DM only (requireDm middleware applied in index.ts).
//
// Creates a new battle document for the DM's active campaign.
// Body:
//   type            — 'pve' | 'wild' | 'pvp'
//   playerIds       — array of user ObjectId strings (must all be in the campaign)
//   playerPokemonLimit? — number | null  (null = no limit)
//
// The enemy side starts empty — it will be populated once the NPC/encounter
// builder is built in milestone 4.3/4.4.
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response): Promise<void> => {
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

  const campaign = await Campaign.findOne({
    dmId: req.user!.userId,
    isActive: true,
  }).lean();
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

  // Validate all requested NPCs exist and belong to this campaign
  if (npcIds.length > 0) {
    const foundNpcs = await Npc.find({
      _id:        { $in: npcIds },
      campaignId: campaign._id,
    }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(400).json({ data: null, error: 'One or more NPCs were not found in your campaign' });
      return;
    }
  }

  // --- Wild battle: generate the wild Pokémon document ---
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

    // Fetch species from cache or PokeAPI
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
      .filter(m => m.level <= level)
      .slice(-4);
    const moveList = ((species.moves ?? []) as Array<{ name: string; pp: number | null }>);
    const moves = learnable.map(m => {
      const md = moveList.find(mv => mv.name === m.moveId);
      const pp = md?.pp ?? 5;
      return { moveId: m.moveId, currentPP: pp, maxPP: pp };
    });

    const stats = computeStats(species.baseStats as BaseStats, level, nature);

    const wildPoke = await Pokemon.create({
      speciesId:        species.pokeApiId,
      ownerId:          new mongoose.Types.ObjectId(req.user!.userId),
      ownerType:        'wild',
      nickname:         null,
      level,
      exp:              expForLevel(level, (species.expGroup as string) || 'medium-fast'),
      currentHp:        stats.hp,
      nature,
      gender,
      heldItem:         null,
      moves,
      evs:              { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
      statusCondition:  null,
      statusCounter:    null,
      volatileStatus:   [],
      evolutionOverrides: [],
      isInParty:        false,
      partySlot:        null,
      caughtAt:         null,
      caughtByPlayerId: null,
    });

    enemySide = [{ activePokemonId: wildPoke._id as mongoose.Types.ObjectId, fainted: [] }];
  } else {
    enemySide = npcIds.map(id => ({
      npcId:           new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      fainted:         [],
    }));
  }

  const battle = await Battle.create({
    campaignId: campaign._id,
    type,
    status:     'waiting',
    phase:      'move_submission',
    playerSide: playerIds.map(id => ({
      userId:          new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      usedPokemonIds:  [],
      fainted:         [],
    })),
    enemySide,
    wildCatchable:      type === 'wild' ? wildCatchable : true,
    playerPokemonLimit: playerPokemonLimit ?? null,
    npcPokemonLimit:    npcPokemonLimit ?? null,
    lastUpdatedAt:      new Date(),
  });

  res.status(201).json({
    data: { _id: battle._id, status: battle.status, type: battle.type },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Param middleware — validates :id on every /:id route before the handler runs.
// Eliminates the repeated isValid guard at the top of each handler.
// ---------------------------------------------------------------------------
router.param('id', (_req: Request, res: Response, next, id: string) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  next();
});

// Verifies the requesting DM owns the battle's campaign.
// Returns false and sends a 403 when the check fails; call site should return immediately.
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

// ---------------------------------------------------------------------------
// POST /api/battles/:id/start
// DM only — activates a waiting battle.
// Changes status from 'waiting' → 'active' and sets turnNumber to 1.
// ---------------------------------------------------------------------------
router.post('/:id/start', requireDm, async (req: Request, res: Response): Promise<void> => {

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'waiting') {
    res.status(400).json({ data: null, error: 'Battle has already started' });
    return;
  }

  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;

  battle.status        = 'active';
  battle.turnNumber    = 1;
  battle.phase         = 'move_submission';
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { status: battle.status, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/send-out
// Player — picks which party Pokémon to send into battle.
// Sets activePokemonId on the player's side entry and adds to usedPokemonIds
// if this Pokémon hasn't been used in this battle before.
// Body: { pokemonId: string }
// ---------------------------------------------------------------------------
router.post('/:id/send-out', async (req: Request, res: Response): Promise<void> => {
  const { pokemonId } = req.body as { pokemonId: string };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  if (!pokemonId || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Invalid pokemonId' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Cannot send out a Pokémon outside move submission phase' });
    return;
  }

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry) {
    res.status(403).json({ data: null, error: 'You are not in this battle' });
    return;
  }

  const pokeId = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({
    _id:       pokeId,
    ownerId:   userId,
    ownerType: 'player',
    isInParty: true,
  }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Pokémon not found in your party' });
    return;
  }
  if (pokemon.currentHp <= 0) {
    res.status(400).json({ data: null, error: 'That Pokémon has fainted' });
    return;
  }

  // playerPokemonLimit only restricts first-time sends; switching to a previously
  // used Pokémon is always allowed (handled in milestone 3.10)
  const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === pokemonId);
  if (!alreadyUsed && battle.playerPokemonLimit !== null) {
    if (playerEntry.usedPokemonIds.length >= battle.playerPokemonLimit) {
      res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' });
      return;
    }
  }

  // Clear volatile statuses (confusion, etc.) on the outgoing Pokémon
  const outgoingId = playerEntry.activePokemonId;
  if (outgoingId && outgoingId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingId }, { $set: { volatileStatus: [] } });
  }

  playerEntry.activePokemonId = pokeId;
  if (!alreadyUsed) {
    playerEntry.usedPokemonIds.push(pokeId);
  }

  const entryEvents = await applyEntryAbilities(battle, pokeId, 'player');
  appendToLog(battle, ...entryEvents);

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { activePokemonId: pokemonId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-send-out
// DM only — sets the active Pokémon for an NPC slot on the enemy side.
// Body: { npcId: string, pokemonId: string }
// ---------------------------------------------------------------------------
router.post('/:id/dm-send-out', requireDm, async (req: Request, res: Response): Promise<void> => {
  const { npcId, pokemonId, slotIndex = 0 } = req.body as {
    npcId: string;
    pokemonId: string;
    // 0-based index among all enemySide entries that share this npcId.
    // Defaults to 0 — backward-compatible with single-slot battles.
    slotIndex?: number;
  };

  if (!npcId || !pokemonId || !mongoose.Types.ObjectId.isValid(npcId) || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Valid npcId and pokemonId are required' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Battle is not in move submission phase' });
    return;
  }

  // Collect all slots for this NPC (multi-slot PvE battles have one per player)
  const npcEntries = battle.enemySide.filter(e => e.npcId?.toString() === npcId);
  if (npcEntries.length === 0) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }
  if (slotIndex < 0 || slotIndex >= npcEntries.length) {
    res.status(400).json({
      data:  null,
      error: `slotIndex must be between 0 and ${npcEntries.length - 1}`,
    });
    return;
  }
  const npcEntry = npcEntries[slotIndex];

  const pokeId = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({
    _id:       pokeId,
    ownerId:   new mongoose.Types.ObjectId(npcId),
    ownerType: 'npc',
  }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Pokémon not found for this NPC' });
    return;
  }
  if (pokemon.currentHp <= 0) {
    res.status(400).json({ data: null, error: 'That Pokémon has fainted' });
    return;
  }

  // Prevent the same Pokémon from being active in two slots simultaneously.
  // (A different slot for the same NPC may already have this Pokémon out.)
  const alreadyActiveInAnotherSlot = battle.enemySide.some(
    e => e.npcId?.toString() === npcId
      && e.activePokemonId?.toString() === pokemonId
      && e !== npcEntry,
  );
  if (alreadyActiveInAnotherSlot) {
    res.status(400).json({ data: null, error: 'That Pokémon is already active in another slot' });
    return;
  }

  // Clear volatile statuses (confusion, etc.) on the outgoing Pokémon
  const outgoingNpcId = npcEntry.activePokemonId;
  if (outgoingNpcId && outgoingNpcId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingNpcId }, { $set: { volatileStatus: [] } });
  }

  npcEntry.activePokemonId = pokeId;

  const npcEntryEvents = await applyEntryAbilities(battle, pokeId, 'enemy');
  appendToLog(battle, ...npcEntryEvents);

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { activePokemonId: pokemonId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/submit-move
// Player — submits their action for the current round.
// actionType 'move': body { moveId }
// actionType 'item': body { actionType: 'item', itemId, targetPokemonId }
//   Item actions are self-targeted (own party Pokémon) — target is pre-filled
//   so they skip the enemy targeting picker entirely.
// ---------------------------------------------------------------------------
router.post('/:id/submit-move', async (req: Request, res: Response): Promise<void> => {
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
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Not in move submission phase' });
    return;
  }

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry) {
    res.status(403).json({ data: null, error: 'You are not in this battle' });
    return;
  }
  if (!playerEntry.activePokemonId) {
    res.status(400).json({ data: null, error: 'You have not sent out a Pokémon yet' });
    return;
  }

  const alreadySubmitted = battle.turnQueue.some(
    e => e.actorId.toString() === userId.toString() && e.actorType === 'player'
  );
  if (alreadySubmitted) {
    res.status(400).json({ data: null, error: 'You have already submitted a move this turn' });
    return;
  }

  // ---- item action ----
  if (actionType === 'item') {
    if (!itemId || !targetPokemonId) {
      res.status(400).json({ data: null, error: 'itemId and targetPokemonId are required for item actions' });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(targetPokemonId)) {
      res.status(400).json({ data: null, error: 'Invalid targetPokemonId' });
      return;
    }

    const item = await Item.findOne({ ownerId: userId, itemId }).lean();
    if (!item) {
      res.status(400).json({ data: null, error: 'Item not found in your bag' });
      return;
    }
    if (item.pocket !== 'healing' && item.pocket !== 'status_cure') {
      res.status(400).json({ data: null, error: 'That item cannot be used in battle' });
      return;
    }

    const targetObjId = new mongoose.Types.ObjectId(targetPokemonId);
    const targetPokemon = await Pokemon.findOne({ _id: targetObjId, ownerId: userId, isInParty: true }).lean();
    if (!targetPokemon) {
      res.status(400).json({ data: null, error: 'Target Pokémon not found in your party' });
      return;
    }

    battle.turnQueue.push({
      actorId:         userId,
      actorType:       'player',
      activePokemonId: playerEntry.activePokemonId,
      actionType:      'item',
      moveId:          '',
      itemId,
      targets:         [targetObjId],
      resolved:        false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- run action ----
  if (actionType === 'run') {
    battle.turnQueue.push({
      actorId:         userId,
      actorType:       'player',
      activePokemonId: playerEntry.activePokemonId,
      actionType:      'run',
      moveId:          '',
      targets:         [],
      resolved:        false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- catch action ----
  if (actionType === 'catch') {
    if (battle.type !== 'wild') {
      res.status(400).json({ data: null, error: 'Catch actions are only valid in wild battles' });
      return;
    }
    if (!battle.wildCatchable) {
      res.status(400).json({ data: null, error: 'This wild Pokémon cannot be caught' });
      return;
    }
    if (!itemId) {
      res.status(400).json({ data: null, error: 'itemId (Poké Ball) is required for catch actions' });
      return;
    }

    const ballItem = await Item.findOne({ ownerId: userId, itemId }).lean();
    if (!ballItem || ballItem.quantity < 1) {
      res.status(400).json({ data: null, error: 'You do not have that Poké Ball' });
      return;
    }
    if (ballItem.pocket !== 'pokeballs') {
      res.status(400).json({ data: null, error: 'That item is not a Poké Ball' });
      return;
    }

    // Multi-wild: client passes targetPokemonId to specify which wild to throw at.
    // Single-wild (backward compat): omit targetPokemonId and the only active slot is used.
    const wildEntry = targetPokemonId
      ? battle.enemySide.find(
          e => !e.npcId && e.activePokemonId?.toString() === targetPokemonId,
        )
      : battle.enemySide.find(e => !e.npcId && e.activePokemonId != null);

    if (!wildEntry?.activePokemonId) {
      res.status(400).json({ data: null, error: 'No active wild Pokémon to catch' });
      return;
    }

    battle.turnQueue.push({
      actorId:         userId,
      actorType:       'player',
      activePokemonId: playerEntry.activePokemonId,
      actionType:      'catch',
      moveId:          '',
      itemId,
      targets:         [wildEntry.activePokemonId],
      resolved:        false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- switch action ----
  if (actionType === 'switch') {
    if (!switchToPokemonId || !mongoose.Types.ObjectId.isValid(switchToPokemonId)) {
      res.status(400).json({ data: null, error: 'A valid switchToPokemonId is required for switch actions' });
      return;
    }

    const switchToId = new mongoose.Types.ObjectId(switchToPokemonId);

    if (playerEntry.activePokemonId?.toString() === switchToPokemonId) {
      res.status(400).json({ data: null, error: 'That Pokémon is already active' });
      return;
    }

    const switchTarget = await Pokemon.findOne({
      _id:       switchToId,
      ownerId:   userId,
      ownerType: 'player',
      isInParty: true,
    }).lean();
    if (!switchTarget) {
      res.status(404).json({ data: null, error: 'Pokémon not found in your party' });
      return;
    }
    if (switchTarget.currentHp <= 0) {
      res.status(400).json({ data: null, error: 'That Pokémon has fainted' });
      return;
    }

    const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === switchToPokemonId);
    if (!alreadyUsed && battle.playerPokemonLimit !== null) {
      if (playerEntry.usedPokemonIds.length >= battle.playerPokemonLimit) {
        res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' });
        return;
      }
    }

    battle.turnQueue.push({
      actorId:           userId,
      actorType:         'player',
      activePokemonId:   playerEntry.activePokemonId!,
      actionType:        'switch',
      moveId:            '',
      switchToPokemonId: switchToId,
      targets:           [],
      resolved:          false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- move action ----
  if (!moveId) {
    res.status(400).json({ data: null, error: 'moveId is required' });
    return;
  }

  const pokemon = await Pokemon.findOne({ _id: playerEntry.activePokemonId }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Active Pokémon not found' });
    return;
  }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot) {
    res.status(400).json({ data: null, error: 'That move is not on your active Pokémon' });
    return;
  }
  if (moveSlot.currentPP <= 0) {
    res.status(400).json({ data: null, error: 'That move has no PP remaining' });
    return;
  }

  battle.turnQueue.push({
    actorId:         userId,
    actorType:       'player',
    activePokemonId: playerEntry.activePokemonId,
    actionType:      'move',
    moveId,
    targets:         [],
    resolved:        false,
  });

  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-submit-move
// DM only — submits a move or switch on behalf of an NPC.
// Body (move):   { npcId, moveId }
// Body (switch): { npcId, actionType: 'switch', switchToPokemonId }
// ---------------------------------------------------------------------------
router.post('/:id/dm-submit-move', requireDm, async (req: Request, res: Response): Promise<void> => {
  const {
    npcId, moveId, actionType = 'move', switchToPokemonId,
    activePokemonId: slotPokemonId, itemId, targetPokemonId,
  } = req.body as {
    npcId: string;
    moveId?: string;
    actionType?: 'move' | 'switch' | 'item';
    switchToPokemonId?: string;
    // Optional: the activePokemonId of the specific slot to submit for.
    // Required when an NPC has multiple active slots (one per player).
    // Omit for single-slot battles — the only active Pokémon is used.
    activePokemonId?: string;
    itemId?: string;
    targetPokemonId?: string;
  };

  if (!npcId) {
    res.status(400).json({ data: null, error: 'npcId is required' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Battle is not in move submission phase' });
    return;
  }

  // For NPC battles match by npcId; for wild battles the DM passes the
  // wild Pokémon's activePokemonId in the npcId field.
  // When an NPC has multiple slots (multi-slot PvE) the caller must also
  // pass activePokemonId to identify the exact slot. Single-slot battles
  // can omit it — the first match by npcId is used (backward-compatible).
  const npcEntry = battle.type === 'wild'
    ? battle.enemySide.find(e => e.activePokemonId?.toString() === npcId)
    : slotPokemonId
      ? battle.enemySide.find(
          e => e.npcId?.toString() === npcId
            && e.activePokemonId?.toString() === slotPokemonId,
        )
      : battle.enemySide.find(e => e.npcId?.toString() === npcId);
  if (!npcEntry) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }

  // Duplicate-submission guard: for multi-slot NPC battles, each slot submits
  // independently (same actorId/npcId, different activePokemonId). When
  // slotPokemonId is provided, scope the check to that specific slot only.
  const alreadySubmitted = slotPokemonId
    ? battle.turnQueue.some(
        e => e.actorId.toString() === npcId
          && e.activePokemonId?.toString() === slotPokemonId
          && e.actorType === 'npc',
      )
    : battle.turnQueue.some(
        e => e.actorId.toString() === npcId && e.actorType === 'npc',
      );
  if (alreadySubmitted) {
    res.status(400).json({ data: null, error: 'This NPC slot has already submitted a move this turn' });
    return;
  }

  // Wild Pokémon cannot switch
  if (battle.type === 'wild' && actionType === 'switch') {
    res.status(400).json({ data: null, error: 'Wild Pokémon cannot switch' });
    return;
  }

  // ---- item action ----
  if (actionType === 'item') {
    if (!itemId) {
      res.status(400).json({ data: null, error: 'itemId is required for item actions' });
      return;
    }
    if (!targetPokemonId || !mongoose.Types.ObjectId.isValid(targetPokemonId)) {
      res.status(400).json({ data: null, error: 'A valid targetPokemonId is required for item actions' });
      return;
    }
    if (!npcEntry.activePokemonId) {
      res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' });
      return;
    }

    const npcObjId = new mongoose.Types.ObjectId(npcId);
    const bagItem  = await Item.findOne({ ownerId: npcObjId, itemId }).lean();
    if (!bagItem || bagItem.quantity < 1) {
      res.status(400).json({ data: null, error: 'Item not found in NPC bag' });
      return;
    }

    battle.turnQueue.push({
      actorId:         npcObjId,
      actorType:       'npc',
      activePokemonId: npcEntry.activePokemonId,
      actionType:      'item',
      itemId,
      targets:         [new mongoose.Types.ObjectId(targetPokemonId)],
      resolved:        false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- switch action ----
  if (actionType === 'switch') {
    if (!switchToPokemonId || !mongoose.Types.ObjectId.isValid(switchToPokemonId)) {
      res.status(400).json({ data: null, error: 'A valid switchToPokemonId is required for switch actions' });
      return;
    }
    if (npcEntry.activePokemonId?.toString() === switchToPokemonId) {
      res.status(400).json({ data: null, error: 'That Pokémon is already active' });
      return;
    }

    const npc = await Npc.findById(npcId, 'party').lean();
    if (!npc || !npc.party.some((id: mongoose.Types.ObjectId) => id.toString() === switchToPokemonId)) {
      res.status(400).json({ data: null, error: 'That Pokémon is not in this NPC\'s party' });
      return;
    }

    const switchTarget = await Pokemon.findById(switchToPokemonId, 'currentHp').lean();
    if (!switchTarget) {
      res.status(404).json({ data: null, error: 'Switch target Pokémon not found' });
      return;
    }
    if (switchTarget.currentHp <= 0) {
      res.status(400).json({ data: null, error: 'Cannot switch to a fainted Pokémon' });
      return;
    }

    const activePokemonId = npcEntry.activePokemonId ?? new mongoose.Types.ObjectId(switchToPokemonId);
    battle.turnQueue.push({
      actorId:           new mongoose.Types.ObjectId(npcId),
      actorType:         'npc',
      activePokemonId,
      actionType:        'switch',
      switchToPokemonId: new mongoose.Types.ObjectId(switchToPokemonId),
      targets:           [],
      resolved:          false,
    });

    await checkAndAdvance(battle);
    battle.lastUpdatedAt = new Date();
    await battle.save();

    res.json({ data: { submitted: true, phase: battle.phase }, error: null });
    return;
  }

  // ---- move action ----
  if (!moveId) {
    res.status(400).json({ data: null, error: 'moveId is required for move actions' });
    return;
  }
  if (!npcEntry.activePokemonId) {
    res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' });
    return;
  }

  const pokemon = await Pokemon.findOne({ _id: npcEntry.activePokemonId }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'NPC active Pokémon not found' });
    return;
  }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot) {
    res.status(400).json({ data: null, error: "That move is not on the NPC's active Pokémon" });
    return;
  }
  if (moveSlot.currentPP <= 0) {
    res.status(400).json({ data: null, error: 'That move has no PP remaining' });
    return;
  }

  battle.turnQueue.push({
    actorId:         new mongoose.Types.ObjectId(npcId),
    actorType:       'npc',
    activePokemonId: npcEntry.activePokemonId,
    actionType:      'move',
    moveId,
    targets:         [],
    resolved:        false,
  });

  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// estimateDamage — run @smogon/calc in read-only mode and return the average
// damage roll. Returns 0 on any error (unrecognised move / Pokémon name).
// Used by the optimal AI strategy in dm-auto-submit.
// ---------------------------------------------------------------------------
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
      level:   attacker.level,
      nature:  cap(attacker.nature) as any,
      evs:     ZERO_STATS,
      ivs:     ZERO_STATS,
      curHP:   attacker.currentHp,
      ability: attackerAbilitySlug ? slugToDisplayName(attackerAbilitySlug) as any : undefined,
    });
    const calcTgt = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level:   target.level,
      nature:  cap(target.nature) as any,
      evs:     ZERO_STATS,
      ivs:     ZERO_STATS,
      curHP:   target.currentHp,
      ability: targetAbilitySlug ? slugToDisplayName(targetAbilitySlug) as any : undefined,
    });
    const result = calculate(GEN9, calcAtk, calcTgt, new CalcMove(GEN9, slugToDisplayName(moveId)), new Field({ weather: toCalcWeather(weather as any) as any }));
    const rolls  = Array.isArray(result.damage) ? (result.damage as number[]) : [result.damage as number];
    return rolls.reduce((s, r) => s + r, 0) / rolls.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-auto-submit
// DM only. Submits move choices for every unsubmitted NPC and wild slot using
// each NPC's aiStrategy. Wild Pokémon always use random.
//
// Strategies:
//   random    — picks a random move with PP > 0
//   defensive — if HP < 30%: try healing item → try Rest → fall back to random
//   optimal   — picks the move with the highest average @smogon/calc damage
//   custom    — falls back to random (custom notes are not machine-readable)
//
// Targets are left empty ([]); the DM fills them during the targeting phase.
// Returns { submitted: N, phase } so the frontend can update its view.
// ---------------------------------------------------------------------------
router.post('/:id/dm-auto-submit', requireDm, async (req: Request, res: Response): Promise<void> => {

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Battle is not in move submission phase' });
    return;
  }

  let submitted = 0;

  for (const slot of battle.enemySide) {
    if (!slot.activePokemonId) continue;

    const isWild  = !slot.npcId;
    const actorId = isWild ? slot.activePokemonId : slot.npcId!;

    // Skip slots that already have a submission this turn
    const alreadySubmitted = battle.turnQueue.some(
      e => e.actorId.toString() === actorId.toString()
        && e.actorType === 'npc'
        && e.activePokemonId?.toString() === slot.activePokemonId!.toString(),
    );
    if (alreadySubmitted) continue;

    const poke = await Pokemon.findById(
      slot.activePokemonId,
      'moves currentHp nature level speciesId hasHiddenAbility',
    ).lean();
    if (!poke) continue;

    const movesWithPP = (poke.moves as { moveId: string; currentPP: number; maxPP: number }[])
      .filter(m => m.currentPP > 0);
    if (movesWithPP.length === 0) continue;

    // Determine AI strategy (wild always random)
    type AiStrategy = 'random' | 'optimal' | 'defensive' | 'custom';
    const npcDoc = (!isWild && slot.npcId)
      ? await Npc.findById(slot.npcId, 'aiStrategy').lean()
      : null;
    const strategy: AiStrategy = (npcDoc?.aiStrategy as AiStrategy | undefined) ?? 'random';

    const actorObjId = new mongoose.Types.ObjectId(actorId.toString());

    // ── Defensive: heal or rest when HP < 30% ────────────────────────────
    if (strategy === 'defensive') {
      const cache = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'baseStats').lean();
      const maxHp = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp : poke.currentHp;

      if (poke.currentHp < Math.floor(maxHp * 0.3)) {
        const healItem = await Item.findOne({
          ownerId:   actorObjId,
          ownerType: 'npc',
          pocket:    'healing',
          quantity:  { $gt: 0 },
        }).lean();

        if (healItem) {
          battle.turnQueue.push({
            actorId:         actorObjId,
            actorType:       'npc',
            activePokemonId: slot.activePokemonId!,
            actionType:      'item',
            itemId:          healItem.itemId,
            targets:         [slot.activePokemonId!],
            resolved:        false,
          });
          submitted++;
          continue;
        }

        const restSlot = movesWithPP.find(m => m.moveId === 'rest');
        if (restSlot) {
          battle.turnQueue.push({
            actorId:         actorObjId,
            actorType:       'npc',
            activePokemonId: slot.activePokemonId!,
            actionType:      'move',
            moveId:          'rest',
            targets:         [],
            resolved:        false,
          });
          submitted++;
          continue;
        }
        // Fall through to random below
      }
    }

    // ── Optimal: highest average damage across all targets ────────────────
    let chosenMoveId: string;

    if (strategy === 'optimal') {
      const activePlayerIds = battle.playerSide
        .filter(e => e.activePokemonId != null)
        .map(e => e.activePokemonId!);

      const atkCache = await PokedexCache.findOne(
        { pokeApiId: poke.speciesId },
        'name abilities',
      ).lean();
      const atkAbility = atkCache
        ? resolveAbilitySlug(atkCache.abilities as CachedAbility[], poke.hasHiddenAbility ?? false)
        : null;

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
          const score = await estimateDamage(
            poke, atkCache ?? { name: poke.speciesId }, atkAbility,
            mv.moveId,
            tgt, tCache, tAbility,
            battle.weather as string | null,
          );
          if (score > bestScore) { bestScore = score; chosenMoveId = mv.moveId; }
        }
      }
      // If no damaging move found (all self-targeting), fall back to random
      chosenMoveId ??= movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
    } else {
      // random / defensive-fallback / custom
      chosenMoveId = movesWithPP[Math.floor(Math.random() * movesWithPP.length)].moveId;
    }

    battle.turnQueue.push({
      actorId:         actorObjId,
      actorType:       'npc',
      activePokemonId: slot.activePokemonId!,
      actionType:      'move',
      moveId:          chosenMoveId,
      targets:         [],
      resolved:        false,
    });
    submitted++;
  }

  if (submitted > 0) {
    await checkAndAdvance(battle);
  }
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/battles/dm
// DM only (requireDm middleware applied in index.ts).
//
// Returns all non-complete battles for the DM's active campaign so the DM
// panel can list them and the DM can navigate back into any open battle.
// ---------------------------------------------------------------------------
router.get('/dm', async (req: Request, res: Response): Promise<void> => {
  const campaign = await Campaign.findOne({
    dmId:     req.user!.userId,
    isActive: true,
  }).lean();

  if (!campaign) {
    res.json({ data: [], error: null });
    return;
  }

  const battles = await Battle.find({
    campaignId: campaign._id,
    status:     { $ne: 'complete' },
  })
    .sort({ lastUpdatedAt: -1 })
    .lean();

  res.json({
    data: battles.map(b => ({
      _id:           b._id,
      type:          b.type,
      status:        b.status,
      turnNumber:    b.turnNumber,
      lastUpdatedAt: b.lastUpdatedAt,
    })),
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/battles/active
// Any authenticated user.
//
// Returns the caller's current non-complete battle (waiting or active), if any.
// The dashboard uses this to surface "Battle in progress" without the client
// needing to know a battle ID up front.
// ---------------------------------------------------------------------------
router.get('/active', async (req: Request, res: Response): Promise<void> => {
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  const battle = await Battle.findOne({
    'playerSide.userId': userId,
    status: { $ne: 'complete' },
  })
    .sort({ lastUpdatedAt: -1 })
    .lean();

  if (!battle) {
    res.json({ data: null, error: null });
    return;
  }

  res.json({
    data: {
      _id:           battle._id,
      status:        battle.status,
      type:          battle.type,
      turnNumber:    battle.turnNumber,
      lastUpdatedAt: battle.lastUpdatedAt,
    },
    error: null,
  });
});

// Narrowed entry type used by submit-target sub-functions — all fields are required
// at the point submit-target runs (the queue entry has been fully populated).
type ActiveEntry = {
  moveId:          string;
  activePokemonId: mongoose.Types.ObjectId;
  actorType:       'player' | 'npc';
};

// Resolves a weather move (sunny-day, rain-dance, etc.) during the targeting phase.
async function resolveWeatherMove(
  battle:        HydratedDocument<IBattle>,
  entry:         ActiveEntry,
  weatherEffect: { weather: IBattle['weather']; startMessage: string },
  moveEvents:    string[],
): Promise<void> {
  const attacker = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId').lean();
  const atkCache = attacker
    ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name').lean()
    : null;
  const attackerName = pokeDisplayName(attacker, atkCache);
  const moveName     = slugToDisplayName(entry.moveId);

  if (battle.weather === weatherEffect.weather) {
    moveEvents.push(`${attackerName} used ${moveName}! But it had no effect...`);
  } else if (battle.weather) {
    battle.weather               = null;
    battle.weatherTurnsRemaining = null;
    moveEvents.push(`${attackerName} used ${moveName}! The weather cleared!`);
  } else {
    battle.weather               = weatherEffect.weather;
    battle.weatherTurnsRemaining = 5;
    moveEvents.push(`${attackerName} used ${moveName}! ${weatherEffect.startMessage}`);
  }
}

// Resolves a self-targeting move (stat boost, recovery, charge, volatile setup, etc.)
// during the targeting phase.
async function resolveSelfTargetMove(
  battle:     HydratedDocument<IBattle>,
  entry:      ActiveEntry,
  moveEvents: string[],
): Promise<void> {
  const attacker = await Pokemon.findById(
    entry.activePokemonId, 'nickname speciesId currentHp nature level volatileStatus hasHiddenAbility',
  ).lean();
  const atkCache = attacker
    ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name baseStats abilities types').lean()
    : null;
  const attackerName = pokeDisplayName(attacker, atkCache);

  // Two-turn moves: turn 1 enters charge state (no effect); turn 2 fires normally.
  // Solar Beam skips the charge turn when the weather is harsh sunlight.
  let applyEffects = true;
  if (CHARGE_MOVES.has(entry.moveId) && attacker) {
    const chargeCondition = `charging-${entry.moveId}`;
    const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
    const isCharging  = volStatus.some(v => v.condition === chargeCondition);
    const skipCharge  = entry.moveId === 'solar-beam' && battle.weather === 'sun';
    const semiInvul   = SEMI_INVULNERABLE_MOVES.has(entry.moveId);

    if (!isCharging && !skipCharge) {
      // Turn 1: push charge volatile (+ semi-invulnerable for Fly/Dig/etc.)
      const volatilesToPush = [{ condition: chargeCondition, turnsRemaining: 99 }];
      if (semiInvul) volatilesToPush.push({ condition: 'semi-invulnerable', turnsRemaining: 99 });
      await Pokemon.updateOne(
        { _id: entry.activePokemonId },
        { $push: { volatileStatus: { $each: volatilesToPush } } },
      );
      moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}! ${attackerName} ${CHARGE_MESSAGES[entry.moveId]}`);
      applyEffects = false;
    } else if (isCharging) {
      // Turn 2: clear charge volatile and semi-invulnerable if applicable
      const conditionsToPull: string[] = [chargeCondition];
      if (semiInvul) conditionsToPull.push('semi-invulnerable');
      await Pokemon.updateOne(
        { _id: entry.activePokemonId },
        { $pull: { volatileStatus: { condition: { $in: conditionsToPull } } } },
      );
    }
    // skipCharge (Solar Beam in sun): no volatile changes — applyEffects stays true
  }

  if (applyEffects) {
    moveEvents.push(`${attackerName} used ${slugToDisplayName(entry.moveId)}!`);

    // Ghost-type Curse uses HP sacrifice + cursed volatile instead of stat stages.
    const isGhostCurse = entry.moveId === 'curse' &&
      ((atkCache?.types as string[]) ?? []).includes('ghost');

    const statEffects = STAT_STAGE_MOVES[entry.moveId];
    if (statEffects && !isGhostCurse) {
      const selfEffects = statEffects.filter(e => e.target === 'self');
      if (selfEffects.length > 0) {
        const stageMap       = battle.statStages as Record<string, StatStages>;
        const atkAbilitySlug = attacker && atkCache
          ? resolveAbilitySlug((atkCache.abilities as CachedAbility[]) ?? [], attacker.hasHiddenAbility as boolean)
          : null;
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), selfEffects, attackerName, atkAbilitySlug));
        battle.markModified('statStages');
      }
    }

    const recoveryEffect = RECOVERY_MOVES[entry.moveId];
    if (recoveryEffect && attacker && atkCache?.baseStats) {
      const maxHp     = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
      const currentHp = attacker.currentHp as number;

      if (recoveryEffect.type === 'rest') {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $set: { currentHp: maxHp, statusCondition: 'sleep', statusCounter: 2 } },
        );
        moveEvents.push(`${attackerName} went to sleep and fully restored its HP!`);
      } else if (currentHp >= maxHp) {
        moveEvents.push(`${attackerName}'s HP is full!`);
      } else {
        const fraction = recoveryEffect.type === 'flat'
          ? recoveryEffect.fraction
          : battle.weather === 'sun' ? 2 / 3
          : !battle.weather          ? 0.5
          :                            0.25; // rain / sandstorm / hail / snow
        const newHp    = Math.min(maxHp, currentHp + Math.floor(maxHp * fraction));
        const restored = newHp - currentHp;
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } });
        moveEvents.push(`${attackerName} restored ${restored} HP!`);

        // Roost: temporarily remove Flying type for end-of-round weather damage this turn
        if (entry.moveId === 'roost') {
          await Pokemon.updateOne(
            { _id: entry.activePokemonId },
            { $push: { volatileStatus: { condition: 'roosting', turnsRemaining: 0 } } },
          );
        }
      }
    }

    // Focus Energy: raise crit rate stage — push volatile so resolveMove uses 1/6 rate
    if (entry.moveId === 'focus-energy' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'focus-energy')) {
        moveEvents.push(`${attackerName} is already focusing!`);
      } else {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $push: { volatileStatus: { condition: 'focus-energy', turnsRemaining: 99 } } },
        );
        moveEvents.push(`${attackerName} is getting pumped!`);
      }
    }

    // Endure: brace for the turn — volatile causes the damage clamp in the target loop
    if (entry.moveId === 'endure' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'enduring')) {
        moveEvents.push(`${attackerName} is already braced!`);
      } else {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $push: { volatileStatus: { condition: 'enduring', turnsRemaining: 0 } } },
        );
        moveEvents.push(`${attackerName} braced itself!`);
      }
    }

    // Belly Drum: cut HP by half and max out Attack stage
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

    // Ingrain: root the user — heals 1/16 maxHp each end-of-round
    if (entry.moveId === 'ingrain' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'ingrain')) {
        moveEvents.push(`${attackerName} is already rooted!`);
      } else {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $push: { volatileStatus: { condition: 'ingrain', turnsRemaining: 99 } } },
        );
        moveEvents.push(`${attackerName} planted its roots!`);
      }
    }

    // Aqua Ring: veil of water — heals 1/16 maxHp each end-of-round
    if (entry.moveId === 'aqua-ring' && attacker) {
      const volStatus = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (volStatus.some(v => v.condition === 'aqua-ring')) {
        moveEvents.push(`${attackerName} is already surrounded by water!`);
      } else {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $push: { volatileStatus: { condition: 'aqua-ring', turnsRemaining: 99 } } },
        );
        moveEvents.push(`${attackerName} surrounded itself with a veil of water!`);
      }
    }

    // Protect family: push the variant's volatile so incoming hit-loop checks see it
    const protectVolatile = PROTECT_VOLATILE[entry.moveId];
    if (protectVolatile && attacker) {
      const vol = (attacker.volatileStatus as Array<{ condition: string }>) ?? [];
      if (vol.some(v => v.condition.startsWith('protecting'))) {
        moveEvents.push(`${attackerName} can't protect itself!`);
      } else {
        await Pokemon.updateOne(
          { _id: entry.activePokemonId },
          { $push: { volatileStatus: { condition: protectVolatile, turnsRemaining: 0 } } },
        );
        moveEvents.push(`${attackerName} protected itself!`);
      }
    }

    // Ghost Curse: sacrifice half HP to inflict the cursed volatile on one opposing Pokémon
    if (isGhostCurse && attacker && atkCache?.baseStats) {
      const opposing = entry.actorType === 'player' ? battle.enemySide : battle.playerSide;
      const target   = opposing.find(e => e.activePokemonId != null);
      if (target?.activePokemonId) {
        const maxHp  = computeStats(atkCache.baseStats as BaseStats, attacker.level, attacker.nature).hp;
        const costHp = Math.floor(maxHp / 2);
        const newHp  = Math.max(0, (attacker.currentHp as number) - costHp);
        const tgtPoke  = await Pokemon.findById(target.activePokemonId, 'nickname speciesId volatileStatus').lean();
        const tgtCache = tgtPoke
          ? await PokedexCache.findOne({ pokeApiId: (tgtPoke as any).speciesId }, 'name').lean()
          : null;
        const tgtName  = pokeDisplayName(tgtPoke, tgtCache, 'the target');
        const alreadyCursed = ((tgtPoke?.volatileStatus as Array<{ condition: string }>) ?? [])
          .some(v => v.condition === 'cursed');
        if (alreadyCursed) {
          moveEvents.push(`${tgtName} is already cursed!`);
        } else {
          await Promise.all([
            Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newHp } }),
            Pokemon.updateOne({ _id: target.activePokemonId }, { $push: { volatileStatus: { condition: 'cursed', turnsRemaining: 99 } } }),
          ]);
          moveEvents.push(`${attackerName} cut its own HP to curse ${tgtName}!`);
        }
      } else {
        moveEvents.push(`${attackerName} used Curse, but there's no target!`);
      }
    }
  }
}

// Resolves a damaging move against one or more targets during the targeting phase.
async function resolveDamagingMove(
  battle:            HydratedDocument<IBattle>,
  entry:             ActiveEntry,
  targets:           string[],
  targetHpMap:       Map<string, number>,
  enduringTargets:   Set<string>,
  protectingTargets: Map<string, string | null>,
  moveEvents:        string[],
): Promise<void> {
  const moveEffect      = STATUS_MOVES[entry.moveId];
  const stageMap        = battle.statStages as Record<string, StatStages>;
  const recoilEffect    = RECOIL_MOVES[entry.moveId];
  const drainEffect     = DRAIN_MOVES[entry.moveId];
  const selfStatEffects = (STAT_STAGE_MOVES[entry.moveId] ?? []).filter(e => e.target === 'self');

  // Always pre-fetch attacker data — used for recoil, drain, contact abilities, Serene Grace,
  // Contrary/Simple, on-KO boosts, and type-changing ability narration.
  type AtkSnapshot = { currentHp: number; speciesId: number; nature: string; level: number; nickname: string | null; hasHiddenAbility?: boolean };
  const atkSnap      = await Pokemon.findById(
    entry.activePokemonId, 'nickname currentHp speciesId nature level hasHiddenAbility',
  ).lean() as AtkSnapshot | null;
  const atkSnapCache = atkSnap
    ? await PokedexCache.findOne({ pokeApiId: atkSnap.speciesId }, 'name baseStats abilities').lean()
    : null;

  // Resolve attacker ability once — used for Serene Grace, Contrary/Simple, type-changing, etc.
  const attackerAbilitySlug = atkSnap && atkSnapCache
    ? resolveAbilitySlug((atkSnapCache.abilities as CachedAbility[]) ?? [], atkSnap.hasHiddenAbility ?? false)
    : null;
  const sereneGrace = attackerAbilitySlug === 'serene-grace';

  // For type-changing abilities (Protean/Libero, -ilate), look up the move's type once
  // before the target loop so the narration can fire correctly per target.
  let typeChangeMoveType: string | null = null;
  const isTypeChanging = attackerAbilitySlug === 'protean' || attackerAbilitySlug === 'libero'
    || (attackerAbilitySlug != null && attackerAbilitySlug in ILATE_MAP);
  if (isTypeChanging && atkSnap) {
    type MoveEntry = { type: string };
    const moveCacheDoc = await PokedexCache.findOne(
      { pokeApiId: atkSnap.speciesId, 'moves.name': entry.moveId },
      { 'moves.$': 1 },
    ).lean();
    typeChangeMoveType = (moveCacheDoc?.moves as MoveEntry[] | undefined)?.[0]?.type?.toLowerCase() ?? null;
  }

  for (const targetId of targets) {
    // Dream Eater only damages and heals if the target is asleep
    if (entry.moveId === 'dream-eater') {
      const tgt      = await Pokemon.findById(targetId, 'statusCondition nickname speciesId').lean();
      if (tgt?.statusCondition !== 'sleep') {
        const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name').lean() : null;
        const tgtName  = pokeDisplayName(tgt, tgtCache);
        moveEvents.push(`Dream Eater had no effect on ${tgtName}!`);
        continue;
      }
    }

    // Pain Split: average current HP between user and target, capped at each's maxHp
    if (entry.moveId === 'pain-split' && atkSnap && atkSnapCache?.baseStats) {
      const tgt      = await Pokemon.findById(targetId, 'currentHp nickname speciesId level nature').lean();
      const tgtCache = tgt ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name baseStats').lean() : null;
      if (tgt && tgtCache?.baseStats) {
        const atkMaxHp = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp;
        const tgtMaxHp = computeStats(tgtCache.baseStats as BaseStats, (tgt as any).level, (tgt as any).nature).hp;
        const atkCurHp = atkSnap.currentHp;
        const tgtCurHp = targetHpMap.get(targetId) ?? (tgt as any).currentHp;
        const average  = Math.floor((atkCurHp + tgtCurHp) / 2);
        const newAtkHp = Math.min(atkMaxHp, average);
        const newTgtHp = Math.min(tgtMaxHp, average);
        await Promise.all([
          Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } }),
          Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newTgtHp } }),
        ]);
        atkSnap.currentHp = newAtkHp;
        targetHpMap.set(targetId, newTgtHp);
        const atkName = pokeDisplayName(atkSnap, atkSnapCache);
        const tgtName = pokeDisplayName(tgt, tgtCache);
        moveEvents.push(`${atkName} used Pain Split on ${tgtName}!`);
        moveEvents.push(`They split the pain! (${atkName}: ${newAtkHp} HP, ${tgtName}: ${newTgtHp} HP)`);
      }
      continue; // skip normal resolveMove flow
    }

    // Leech Seed: plant a seed on the target — drains 1/8 maxHp each end-of-round
    if (entry.moveId === 'leech-seed') {
      const tgt      = await Pokemon.findById(targetId, 'nickname speciesId volatileStatus').lean();
      const tgtCache = tgt
        ? await PokedexCache.findOne({ pokeApiId: (tgt as any).speciesId }, 'name types').lean()
        : null;
      const tgtName  = pokeDisplayName(tgt, tgtCache);
      const atkName  = pokeDisplayName(atkSnap, atkSnapCache);
      const tgtTypes = (tgtCache?.types as string[]) ?? [];
      if (tgtTypes.includes('grass')) {
        moveEvents.push(`${atkName} used Leech Seed! It had no effect on ${tgtName}!`);
      } else {
        const alreadySeeded = ((tgt?.volatileStatus as Array<{ condition: string }>) ?? [])
          .some(v => v.condition === 'leech-seed');
        if (alreadySeeded) {
          moveEvents.push(`${tgtName} is already seeded!`);
        } else {
          await Pokemon.updateOne(
            { _id: targetId },
            { $push: { volatileStatus: { condition: 'leech-seed', turnsRemaining: 99 } } },
          );
          moveEvents.push(`${atkName} used Leech Seed! ${tgtName} was seeded!`);
        }
      }
      continue;
    }

    // Type-changing ability narration (fires before the attack, once per target)
    if (typeChangeMoveType && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      if (attackerAbilitySlug === 'protean' || attackerAbilitySlug === 'libero') {
        const typeDisplay = typeChangeMoveType.charAt(0).toUpperCase() + typeChangeMoveType.slice(1);
        moveEvents.push(`${atkName}'s ${slugToDisplayName(attackerAbilitySlug)}! ${atkName} became the ${typeDisplay} type!`);
      } else if (attackerAbilitySlug && attackerAbilitySlug in ILATE_MAP && typeChangeMoveType === 'normal') {
        moveEvents.push(`${atkName}'s ${slugToDisplayName(attackerAbilitySlug)}! The move became ${ILATE_MAP[attackerAbilitySlug]} type!`);
      }
    }

    const hitCount   = getHitCount(entry.moveId);
    let totalDamage  = 0;
    let actualHits   = 0;
    let anyCrit      = false;

    for (let hit = 1; hit <= hitCount; hit++) {
      // Stop hitting if the target already fainted from a previous hit
      if ((targetHpMap.get(targetId) ?? 0) <= 0) break;

      // Protect check: skip damage and apply variant contact side-effects
      const protectCondition = protectingTargets.get(targetId);
      if (protectCondition) {
        const tgtDoc  = await Pokemon.findById(targetId, 'nickname speciesId').lean();
        const tgtC    = tgtDoc ? await PokedexCache.findOne({ pokeApiId: (tgtDoc as any).speciesId }, 'name').lean() : null;
        const tgtName = pokeDisplayName(tgtDoc, tgtC);
        moveEvents.push(`${tgtName} protected itself!`);

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
            if (statusEvents.length) {
              moveEvents.push(`${atkName} was poisoned by Baneful Bunker!`);
              moveEvents.push(...statusEvents);
            }
          }
        }
        break; // no further hits against a protected target
      }

      const { damage, isCrit, events } = await resolveMove(
        entry.activePokemonId,
        new mongoose.Types.ObjectId(targetId),
        entry.moveId,
        battle.weather,
        {
          attacker: stageMap[entry.activePokemonId.toString()],
          target:   stageMap[targetId],
        },
      );

      if (isCrit) anyCrit = true;

      if (hitCount > 1) {
        moveEvents.push(`(Hit ${hit}) ${events[0]}`);
      } else {
        moveEvents.push(...events);
      }

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

    if (hitCount > 1) {
      moveEvents.push(`Hit ${actualHits} time(s)!`);
    }

    // Anger Point: if any hit was a critical hit, the defender's Atk jumps to +6
    if (anyCrit) {
      const apTgt   = await Pokemon.findById(targetId, 'nickname speciesId hasHiddenAbility').lean();
      const apCache = apTgt ? await PokedexCache.findOne({ pokeApiId: apTgt.speciesId }, 'name abilities').lean() : null;
      const apAbility = apTgt && apCache
        ? resolveAbilitySlug((apCache.abilities as CachedAbility[]) ?? [], (apTgt.hasHiddenAbility as boolean) ?? false)
        : null;
      if (apAbility === 'anger-point') {
        const apName = pokeDisplayName(apTgt, apCache);
        const apStageMap = battle.statStages as Record<string, StatStages>;
        if (!apStageMap[targetId]) apStageMap[targetId] = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
        apStageMap[targetId].atk = 6;
        battle.markModified('statStages');
        moveEvents.push(`${apName}'s Anger Point! ${apName}'s Attack rose to the maximum!`);
      }
    }

    // Secondary status effect — rolled once after all hits resolve
    if (moveEffect && Math.random() < (sereneGrace ? Math.min(1, moveEffect.chance * 2) : moveEffect.chance)) {
      const statusEvents = await applyStatusEffect(new mongoose.Types.ObjectId(targetId), moveEffect);
      moveEvents.push(...statusEvents);
    }

    // Foe stat stage effects — chance rolled per effect (e.g. Crunch 20% Def drop)
    const statEffects = STAT_STAGE_MOVES[entry.moveId];
    if (statEffects) {
      const foeEffects = statEffects.filter(e => e.target === 'foe' && Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      if (foeEffects.length > 0) {
        const tgt        = await Pokemon.findById(targetId, 'nickname speciesId hasHiddenAbility').lean();
        const tgtCache   = tgt ? await PokedexCache.findOne({ pokeApiId: tgt.speciesId }, 'name abilities').lean() : null;
        const tgtName    = pokeDisplayName(tgt, tgtCache);
        const tgtAbility = tgt && tgtCache ? resolveAbilitySlug((tgtCache.abilities as CachedAbility[]) ?? [], tgt.hasHiddenAbility as boolean) : null;
        moveEvents.push(...applyStatStageEffects(stageMap, targetId, foeEffects, tgtName, tgtAbility));
        battle.markModified('statStages');

        // Competitive/Defiant: react to any foe-caused stat drop
        if (foeEffects.some(e => e.stages < 0) && (tgtAbility === 'competitive' || tgtAbility === 'defiant')) {
          const reactionStat: keyof StatStages = tgtAbility === 'competitive' ? 'spa' : 'atk';
          moveEvents.push(`${tgtName}'s ${slugToDisplayName(tgtAbility)}!`);
          moveEvents.push(...applyStatStageEffects(stageMap, targetId, [{ stat: reactionStat, stages: 2, target: 'self' }], tgtName));
          battle.markModified('statStages');
        }
      }
    }

    // Self stat effects on damaging moves (e.g. Close Combat −1 Def/SpDef, Charge Beam +1 SpAtk)
    if (selfStatEffects.length > 0 && atkSnap && atkSnapCache) {
      const rolledSelfEffects = selfStatEffects.filter(e => Math.random() < (sereneGrace ? Math.min(1, (e.chance ?? 1) * 2) : (e.chance ?? 1)));
      if (rolledSelfEffects.length > 0) {
        const atkName = pokeDisplayName(atkSnap, atkSnapCache);
        moveEvents.push(...applyStatStageEffects(stageMap, entry.activePokemonId.toString(), rolledSelfEffects, atkName, attackerAbilitySlug));
        battle.markModified('statStages');
      }
    }

    // Recoil — based on total damage dealt across all hits
    if (recoilEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      let recoilDmg: number;
      if (recoilEffect.type === 'damage') {
        recoilDmg = Math.max(1, Math.floor(totalDamage * recoilEffect.fraction));
      } else {
        // Struggle: fraction of attacker's own max HP
        const maxHp = atkSnapCache.baseStats
          ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp
          : 1;
        recoilDmg = Math.max(1, Math.floor(maxHp * recoilEffect.fraction));
      }
      const newAtkHp = Math.max(0, atkSnap.currentHp - recoilDmg);
      await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
      atkSnap.currentHp = newAtkHp;
      moveEvents.push(`${atkName} was hurt by recoil!`);
    }

    // Drain — based on total damage dealt across all hits
    if (drainEffect && totalDamage > 0 && atkSnap && atkSnapCache) {
      const atkName = pokeDisplayName(atkSnap, atkSnapCache);
      const maxHp   = atkSnapCache.baseStats
        ? computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp
        : 0;
      const restoreAmt = Math.max(1, Math.floor(totalDamage * drainEffect.fraction));
      const newAtkHp   = Math.min(maxHp, atkSnap.currentHp + restoreAmt);
      const restored   = newAtkHp - atkSnap.currentHp;
      if (restored > 0) {
        await Pokemon.updateOne({ _id: entry.activePokemonId }, { $set: { currentHp: newAtkHp } });
        atkSnap.currentHp = newAtkHp;
        moveEvents.push(`${atkName} restored ${restored} HP!`);
      }
    }

    // Flinch — rolled once per target after all hits resolve, only if damage was dealt.
    // Only unresolved queue entries can be flinched (faster attacker condition guaranteed
    // by speed sort — if the target already resolved, it moved first and can't flinch).
    const flinchChance = FLINCH_MOVES[entry.moveId];
    if (flinchChance && totalDamage > 0 && Math.random() < flinchChance) {
      const targetEntry = battle.turnQueue.find(
        e => e.activePokemonId.toString() === targetId && !e.resolved,
      );
      if (targetEntry) targetEntry.flinched = true;
    }

    // Contact abilities — if the move makes contact and dealt damage, the defender's
    // ability may trigger an effect on the attacker (status, recoil, etc.).
    if (CONTACT_MOVES.has(entry.moveId) && totalDamage > 0) {
      const defPoke = await Pokemon.findById(targetId, 'speciesId hasHiddenAbility nickname').lean();
      if (defPoke) {
        const defCache = await PokedexCache.findOne(
          { pokeApiId: defPoke.speciesId }, 'name abilities baseStats',
        ).lean();
        const defAbilitySlug = resolveAbilitySlug(
          (defCache?.abilities as CachedAbility[]) ?? [],
          defPoke.hasHiddenAbility as boolean,
        );
        if (defAbilitySlug) {
          const defName   = pokeDisplayName(defPoke, defCache);
          const atkId     = entry.activePokemonId;

          if (defAbilitySlug === 'rough-skin' || defAbilitySlug === 'iron-barbs') {
            if (atkSnap && atkSnapCache?.baseStats) {
              const maxHp    = computeStats(atkSnapCache.baseStats as BaseStats, atkSnap.level, atkSnap.nature).hp;
              const dmg      = Math.max(1, Math.floor(maxHp / 8));
              const newAtkHp = Math.max(0, atkSnap.currentHp - dmg);
              await Pokemon.updateOne({ _id: atkId }, { $set: { currentHp: newAtkHp } });
              atkSnap.currentHp = newAtkHp;
              const atkName = pokeDisplayName(atkSnap, atkSnapCache);
              moveEvents.push(`${atkName} was hurt by ${defName}'s ${slugToDisplayName(defAbilitySlug)}!`);
            }
          } else if (defAbilitySlug === 'poison-point' && Math.random() < 0.3) {
            const statusEvents = await applyStatusEffect(atkId, { status: 'poison', chance: 1 });
            if (statusEvents.length) {
              moveEvents.push(`${defName}'s Poison Point!`);
              moveEvents.push(...statusEvents);
            }
          } else if (defAbilitySlug === 'static' && Math.random() < 0.3) {
            const statusEvents = await applyStatusEffect(atkId, { status: 'paralysis', chance: 1 });
            if (statusEvents.length) {
              moveEvents.push(`${defName}'s Static!`);
              moveEvents.push(...statusEvents);
            }
          } else if (defAbilitySlug === 'flame-body' && Math.random() < 0.3) {
            const statusEvents = await applyStatusEffect(atkId, { status: 'burn', chance: 1 });
            if (statusEvents.length) {
              moveEvents.push(`${defName}'s Flame Body!`);
              moveEvents.push(...statusEvents);
            }
          } else if (defAbilitySlug === 'effect-spore' && Math.random() < 0.3) {
            const roll   = Math.random();
            const status = roll < 1 / 3 ? 'poison' : roll < 2 / 3 ? 'paralysis' : 'sleep';
            const statusEvents = await applyStatusEffect(atkId, { status: status as StatusCondition, chance: 1 });
            if (statusEvents.length) {
              moveEvents.push(`${defName}'s Effect Spore!`);
              moveEvents.push(...statusEvents);
            }
          }
        }
      }
    }
  }

  // On-KO stat boosts: Moxie (+1 Atk) and Beast Boost (+1 highest base stat)
  const koCount = targets.filter(id => (targetHpMap.get(id) ?? 1) <= 0).length;
  if (koCount > 0) {
    let koAbilitySlug  = attackerAbilitySlug;
    let koAtkCache: { name?: unknown; baseStats?: unknown; abilities?: unknown } | null = atkSnapCache;
    let koAtkName      = atkSnap
      ? pokeDisplayName(atkSnap, atkSnapCache)
      : null;

    // atkSnap is conditionally pre-fetched; if it wasn't, fetch only what KO check needs
    if (koAbilitySlug == null) {
      const fetchedAtk   = await Pokemon.findById(entry.activePokemonId, 'nickname speciesId hasHiddenAbility').lean();
      const fetchedCache = fetchedAtk
        ? await PokedexCache.findOne({ pokeApiId: fetchedAtk.speciesId }, 'name abilities baseStats').lean()
        : null;
      koAbilitySlug = fetchedAtk && fetchedCache
        ? resolveAbilitySlug((fetchedCache.abilities as CachedAbility[]) ?? [], (fetchedAtk.hasHiddenAbility as boolean) ?? false)
        : null;
      koAtkCache = fetchedCache;
      koAtkName  = pokeDisplayName(fetchedAtk, fetchedCache);
    }

    if (koAbilitySlug === 'moxie' || koAbilitySlug === 'beast-boost') {
      // Beast Boost: find the holder's highest base stat (among the 5 combat stats)
      let boostStat: keyof StatStages = 'atk';
      if (koAbilitySlug === 'beast-boost' && koAtkCache?.baseStats) {
        const bs = koAtkCache.baseStats as BaseStats;
        const statMap: [keyof StatStages, number][] = [
          ['atk', bs.atk], ['def', bs.def], ['spa', bs.spatk], ['spd', bs.spdef], ['spe', bs.speed],
        ];
        boostStat = statMap.reduce((best, cur) => cur[1] > best[1] ? cur : best)[0];
      }
      const atkId       = entry.activePokemonId.toString();
      const atkName     = koAtkName ?? 'Pokémon';
      const abilityName = slugToDisplayName(koAbilitySlug);
      for (let i = 0; i < koCount; i++) {
        moveEvents.push(`${atkName}'s ${abilityName}!`);
        moveEvents.push(...applyStatStageEffects(stageMap, atkId, [{ stat: boostStat, stages: 1, target: 'self' }], atkName));
        battle.markModified('statStages');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/battles/:id/submit-target
// Player or DM — submits target selection for the current actor in the
// speed-sorted turnQueue.
//
// - Player actors may only submit when it is their own turn
//   (turnQueue[currentTargetIndex].actorId === userId)
// - DM submits for NPC actors
// - Targets must be active, non-fainted Pokémon on the opposing side
//
// Fills in targets, increments currentTargetIndex, and transitions phase
// to 'end_of_round' once all actors have picked.
// Body: { targets: string[] }
// ---------------------------------------------------------------------------
router.post('/:id/submit-target', async (req: Request, res: Response): Promise<void> => {
  const { targets } = req.body as { targets: string[] };
  const { userId, role } = req.user!;


  if (!Array.isArray(targets)) {
    res.status(400).json({ data: null, error: 'targets must be an array of Pokémon IDs' });
    return;
  }

  if (!targets.every(t => mongoose.Types.ObjectId.isValid(t))) {
    res.status(400).json({ data: null, error: 'All target IDs must be valid' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'targeting') {
    res.status(400).json({ data: null, error: 'Battle is not in targeting phase' });
    return;
  }

  const idx = battle.currentTargetIndex;
  if (idx >= battle.turnQueue.length) {
    res.status(400).json({ data: null, error: 'No actor is waiting to pick targets' });
    return;
  }

  const currentEntry = battle.turnQueue[idx];

  // Items and switches auto-resolve before targeting; if one somehow reaches here it's a bug
  if (!currentEntry.moveId) {
    res.status(400).json({ data: null, error: 'Current action does not require target selection' });
    return;
  }

  // Verify the caller is the correct actor for this turn
  if (currentEntry.actorType === 'player') {
    if (currentEntry.actorId.toString() !== userId) {
      res.status(403).json({ data: null, error: 'It is not your turn to pick targets' });
      return;
    }
  } else {
    if (role !== 'dm' && role !== 'admin') {
      res.status(403).json({ data: null, error: 'Only the DM can pick targets for NPCs' });
      return;
    }
  }

  // No-target moves (weather, self-buff, recovery) submit an empty array — that's valid.
  // Any other move must have at least one target.
  if (targets.length === 0 && !NO_TARGET_MOVE_IDS.has(currentEntry.moveId)) {
    res.status(400).json({ data: null, error: 'targets must be a non-empty array of Pokémon IDs' });
    return;
  }

  // Opposing side: players target enemies; NPCs target players
  const isPlayerActor = currentEntry.actorType === 'player';
  const validTargetIds = isPlayerActor
    ? battle.enemySide
        .filter(e => e.activePokemonId != null)
        .map(e => e.activePokemonId!.toString())
    : battle.playerSide
        .filter(e => e.activePokemonId != null)
        .map(e => e.activePokemonId!.toString());

  const invalidTargets = targets.filter(t => !validTargetIds.includes(t));
  if (invalidTargets.length > 0) {
    res.status(400).json({ data: null, error: 'One or more targets are not valid active opposing Pokémon' });
    return;
  }

  // Verify targets are alive
  const targetPokemons = await Pokemon.find({ _id: { $in: targets } }, 'currentHp volatileStatus').lean();
  const fainted = targetPokemons.filter(p => p.currentHp <= 0);
  if (fainted.length > 0) {
    res.status(400).json({ data: null, error: 'Cannot target a fainted Pokémon' });
    return;
  }

  // Build a HP map from the liveness check above so we can compute new HP
  // without an extra DB round-trip per target.
  const targetHpMap = new Map(targetPokemons.map(p => [p._id.toString(), p.currentHp]));

  // Targets that used Endure this turn — their HP is clamped to 1 instead of 0.
  const enduringTargets = new Set(
    targetPokemons
      .filter(p => ((p.volatileStatus as Array<{ condition: string }>) ?? []).some(v => v.condition === 'enduring'))
      .map(p => p._id.toString()),
  );

  // Maps target ID → protecting volatile condition (e.g. 'protecting-kings-shield'), or null.
  // Used in the hit loop to skip damage and apply variant contact side-effects.
  const protectingTargets = new Map(
    targetPokemons.map(p => {
      const vol    = (p.volatileStatus as Array<{ condition: string }>) ?? [];
      const protVol = vol.find(v => v.condition.startsWith('protecting'));
      return [p._id.toString(), protVol?.condition ?? null];
    }),
  );

  // Fill targets and immediately resolve damage (sequential speed-order design)
  battle.turnQueue[idx].targets = targets.map(t => new mongoose.Types.ObjectId(t));

  // Confusion check: 50% chance the Pokémon hurts itself instead of using its move.
  // If hitSelf, skip resolveMove and PP deduction — confusion self-hits don't cost PP.
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

    // Deduct 1 PP from the attacker's move slot (floor at 0)
    // $elemMatch required so $ resolves to the element matching BOTH conditions, not whichever element satisfies either first
    await Pokemon.updateOne(
      { _id: currentEntry.activePokemonId, moves: { $elemMatch: { moveId: currentEntry.moveId, currentPP: { $gt: 0 } } } },
      { $inc: { 'moves.$.currentPP': -1 } },
    );
  }

  // Mark the entry resolved and write events to the turn log
  battle.turnQueue[idx].resolved = true;

  appendToLog(battle, ...moveEvents);

  // Detect faints caused by this move and check whether the battle has ended
  const faintEvents = await applyFaints(battle);
  const endEvents   = await checkBattleEnd(battle);
  appendToLog(battle, ...faintEvents, ...endEvents);

  battle.currentTargetIndex = idx + 1;
  // Skip further resolution if the battle ended mid-round
  if (endEvents.length === 0) {
    await autoSkipBlockedActors(battle);
  }

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({
    data:  { phase: battle.phase, currentTargetIndex: battle.currentTargetIndex },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/advance-round
// DM only — called after the DM has reviewed the end-of-round log.
// Clears the turnQueue, increments turnNumber, and resets phase to
// 'move_submission' so the next round can begin.
// ---------------------------------------------------------------------------
router.post('/:id/advance-round', requireDm, async (req: Request, res: Response): Promise<void> => {

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'end_of_round') {
    res.status(400).json({ data: null, error: 'Battle is not at end of round' });
    return;
  }

  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;

  battle.set('turnQueue', []);
  battle.currentTargetIndex = 0;
  battle.turnNumber        += 1;
  battle.phase              = 'move_submission';
  battle.lastUpdatedAt      = new Date();
  await battle.save();

  res.json({ data: { turnNumber: battle.turnNumber, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/weather
// DM only — manually set or clear weather on an active battle.
// Body: { weather: 'rain'|'sun'|'sandstorm'|'hail'|'snow'|null, turnsRemaining?: number|null }
// turnsRemaining null means indefinite (no countdown).
// ---------------------------------------------------------------------------
router.post('/:id/weather', requireDm, async (req: Request, res: Response): Promise<void> => {

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }

  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;

  const { weather, turnsRemaining = null } = req.body as {
    weather: IBattle['weather'];
    turnsRemaining?: number | null;
  };

  const validWeathers: Array<IBattle['weather']> = ['rain', 'sun', 'sandstorm', 'hail', 'snow', null];
  if (!validWeathers.includes(weather)) {
    res.status(400).json({ data: null, error: 'Invalid weather value' });
    return;
  }

  const WEATHER_DISPLAY: Record<string, string> = {
    rain: 'heavy rain', sun: 'harsh sunlight',
    sandstorm: 'a sandstorm', hail: 'hail', snow: 'snow',
  };

  battle.weather               = weather;
  battle.weatherTurnsRemaining = weather ? turnsRemaining : null;

  const logMessage = weather
    ? `The DM set the weather to ${WEATHER_DISPLAY[weather]}!`
    : 'The weather was cleared by the DM.';

  appendToLog(battle, logMessage);

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { weather: battle.weather, weatherTurnsRemaining: battle.weatherTurnsRemaining }, error: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/battles/:id
// DM only — permanently deletes a battle.
// ---------------------------------------------------------------------------
router.delete('/:id', requireDm, async (req: Request, res: Response): Promise<void> => {

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }

  if (!await assertDmOwnsBattle(req.user!.userId, battle, res)) return;

  await Battle.findByIdAndDelete(req.params.id);
  res.json({ data: { deleted: true }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/battles/:id/state
// Any authenticated user. Used for the client polling loop (3.2+).
//
// Returns the full battle document with:
//   - player usernames joined from the users collection
//   - activePokemonInfo (name, currentHp, maxHp) joined for every active
//     Pokémon on both sides so the frontend can display health bars and
//     targeting options without extra per-Pokémon requests.
// ---------------------------------------------------------------------------
router.get('/:id/state', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;

  const battle = await Battle.findById(id).lean();
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }

  // Join usernames for the player side
  const userIds = battle.playerSide.map(entry => entry.userId);
  const users   = await User.find({ _id: { $in: userIds } }, 'username').lean();
  const usernameMap = new Map(users.map(u => [u._id.toString(), u.username]));

  // Collect every active Pokémon ID from both sides so we can join name + HP
  // in a single query rather than N individual requests.
  const allActivePokemonIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((pid): pid is mongoose.Types.ObjectId => pid != null);

  const activePokemons = allActivePokemonIds.length > 0
    ? await Pokemon.find(
        { _id: { $in: allActivePokemonIds } },
        'nickname speciesId currentHp level nature statusCondition volatileStatus moves'
      ).lean()
    : [];

  const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats').lean()
    : [];

  const pokemonMap = new Map(activePokemons.map(p => [p._id.toString(), p]));
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  // Build a compact info object for a single active Pokémon slot.
  const stageMap = (battle.statStages ?? {}) as Record<string, StatStages>;

  const buildInfo = (pokemonId: mongoose.Types.ObjectId | null) => {
    if (!pokemonId) return null;
    const poke = pokemonMap.get(pokemonId.toString());
    if (!poke) return null;
    const cache       = cacheMap.get(poke.speciesId);
    const speciesName = cache?.name ?? `#${poke.speciesId}`;
    const maxHp       = cache
      ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp
      : null;
    return {
      _id:             poke._id.toString(),
      name:            poke.nickname ?? speciesName,
      speciesName,
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
    pokemonLimitReached: battle.playerPokemonLimit !== null
      && entry.usedPokemonIds.length >= battle.playerPokemonLimit,
  }));

  // Join NPC names so the frontend can label enemy slots without extra requests
  const npcIds = battle.enemySide
    .map(e => e.npcId)
    .filter((id): id is mongoose.Types.ObjectId => id != null);
  const npcs = npcIds.length > 0
    ? await Npc.find({ _id: { $in: npcIds } }, 'name').lean()
    : [];
  const npcNameMap = new Map(npcs.map(n => [(n._id as mongoose.Types.ObjectId).toString(), n.name]));

  const enemySideWithInfo = battle.enemySide.map(entry => ({
    ...entry,
    npcName: entry.npcId
      ? (npcNameMap.get(entry.npcId.toString()) ?? 'NPC')
      : 'Wild Pokémon',
    activePokemonInfo:   buildInfo(entry.activePokemonId),
    faintedCount:        entry.fainted.length,
    npcLimitReached:     battle.npcPokemonLimit !== null
      && entry.fainted.length >= battle.npcPokemonLimit,
  }));

  // Determine the target category for the current targeting actor's move so the
  // frontend knows whether to show a picker (single) or auto-submit (auto).
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
});

export default router;
