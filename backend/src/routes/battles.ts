import { Router, Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { Battle, IBattle, TurnQueueEntry } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { Item } from '../models/Item';
import { PokedexCache } from '../models/PokedexCache';
import { Npc } from '../models/Npc';
import { computeStats, BaseStats } from '../lib/statCalc';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field, Generations } from '@smogon/calc';

const router = Router();

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
  const pokemons   = await Pokemon.find({ _id: { $in: pokemonIds } }, 'speciesId level nature statusCondition').lean();
  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats').lean();

  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const pokemonMap = new Map(pokemons.map(p => [p._id.toString(), p]));

  const withSpeed = battle.turnQueue.map(entry => {
    const poke  = pokemonMap.get(entry.activePokemonId.toString());
    const cache = poke ? cacheMap.get(poke.speciesId) : null;
    const rawSpeed = poke && cache
      ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).speed
      : 0;
    const speed = poke?.statusCondition === 'paralysis' ? Math.floor(rawSpeed * 0.5) : rawSpeed;
    return { entry, speed };
  });

  // Item actions always go before moves (trainer acts first, like the main games).
  // Within the same tier, highest Speed goes first; ties keep submission order.
  withSpeed.sort((a, b) => {
    const aItem = a.entry.actionType === 'item' ? 1 : 0;
    const bItem = b.entry.actionType === 'item' ? 1 : 0;
    if (aItem !== bItem) return bItem - aItem;
    return b.speed - a.speed;
  });

  // battle.set() is the proper Mongoose API for replacing a field — it wraps
  // the value in a DocumentArray and marks the path modified automatically.
  battle.set('turnQueue', withSpeed.map(x => x.entry));
  battle.phase              = 'targeting';
  battle.currentTargetIndex = 0;

  await autoSkipBlockedActors(battle);
}

// ---------------------------------------------------------------------------
// @smogon/calc helpers
// ---------------------------------------------------------------------------

const GEN9 = Generations.get(9);

// Convert a PokeAPI slug to a display name suitable for @smogon/calc and
// human-readable log strings.  "ice-beam" → "Ice Beam", "mr-mime" → "Mr Mime"
function slugToDisplayName(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Map our battle weather strings to the values @smogon/calc expects.
function toCalcWeather(weather: IBattle['weather']): string | undefined {
  if (!weather) return undefined;
  const map: Record<string, string> = {
    rain: 'Rain', sun: 'Sun', sandstorm: 'Sand', hail: 'Hail', snow: 'Snow',
  };
  return map[weather];
}

// Map our statusCondition strings to the StatusName values @smogon/calc expects.
function toCalcStatus(status: string | null | undefined): string | undefined {
  if (!status) return undefined;
  const map: Record<string, string> = {
    burn: 'brn', paralysis: 'par', poison: 'psn', toxic: 'tox', sleep: 'slp', freeze: 'frz',
  };
  return map[status];
}

type StatusMoveEffect = {
  status: 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic' | 'confusion';
  chance: number; // 0–1
};

// Moves that inflict a status condition, either as their primary effect (chance 1)
// or as a secondary effect on damage moves.  Keyed by PokeAPI move slug.
const STATUS_MOVES: Record<string, StatusMoveEffect> = {
  // Paralysis
  'thunder-wave':  { status: 'paralysis', chance: 1 },
  'glare':         { status: 'paralysis', chance: 1 },
  'stun-spore':    { status: 'paralysis', chance: 1 },
  'nuzzle':        { status: 'paralysis', chance: 1 },
  'zap-cannon':    { status: 'paralysis', chance: 1 },
  'body-slam':     { status: 'paralysis', chance: 0.3 },
  'thunder':       { status: 'paralysis', chance: 0.3 },
  'thunderbolt':   { status: 'paralysis', chance: 0.1 },
  'discharge':     { status: 'paralysis', chance: 0.3 },
  'spark':         { status: 'paralysis', chance: 0.3 },
  'volt-tackle':   { status: 'paralysis', chance: 0.1 },
  'bounce':        { status: 'paralysis', chance: 0.3 },
  // Burn
  'will-o-wisp':   { status: 'burn', chance: 1 },
  'ember':         { status: 'burn', chance: 0.1 },
  'flamethrower':  { status: 'burn', chance: 0.1 },
  'fire-blast':    { status: 'burn', chance: 0.1 },
  'fire-punch':    { status: 'burn', chance: 0.1 },
  'flame-wheel':   { status: 'burn', chance: 0.1 },
  'blaze-kick':    { status: 'burn', chance: 0.1 },
  'heat-wave':     { status: 'burn', chance: 0.1 },
  'sacred-fire':   { status: 'burn', chance: 0.5 },
  'scald':         { status: 'burn', chance: 0.3 },
  'lava-plume':    { status: 'burn', chance: 0.3 },
  'magma-storm':   { status: 'burn', chance: 0.3 },
  // Toxic / Poison
  'toxic':         { status: 'toxic',  chance: 1 },
  'poison-powder': { status: 'poison', chance: 1 },
  'poison-gas':    { status: 'poison', chance: 1 },
  'poison-sting':  { status: 'poison', chance: 0.3 },
  'poison-jab':    { status: 'poison', chance: 0.3 },
  'gunk-shot':     { status: 'poison', chance: 0.3 },
  'cross-poison':  { status: 'poison', chance: 0.1 },
  'sludge':        { status: 'poison', chance: 0.3 },
  'sludge-bomb':   { status: 'poison', chance: 0.3 },
  'sludge-wave':   { status: 'poison', chance: 0.1 },
  // Sleep
  'hypnosis':      { status: 'sleep', chance: 1 },
  'sleep-powder':  { status: 'sleep', chance: 1 },
  'spore':         { status: 'sleep', chance: 1 },
  'lovely-kiss':   { status: 'sleep', chance: 1 },
  'sing':          { status: 'sleep', chance: 1 },
  'grass-whistle': { status: 'sleep', chance: 1 },
  'dark-void':     { status: 'sleep', chance: 1 },
  // Freeze
  'ice-beam':      { status: 'freeze', chance: 0.1 },
  'blizzard':      { status: 'freeze', chance: 0.1 },
  'ice-punch':     { status: 'freeze', chance: 0.1 },
  'freeze-dry':    { status: 'freeze', chance: 0.1 },
  'aurora-beam':   { status: 'freeze', chance: 0.1 },
  'powder-snow':   { status: 'freeze', chance: 0.1 },
  // Confusion
  'confuse-ray':   { status: 'confusion', chance: 1 },
  'supersonic':    { status: 'confusion', chance: 1 },
  'sweet-kiss':    { status: 'confusion', chance: 1 },
  'teeter-dance':  { status: 'confusion', chance: 1 },
  'flatter':       { status: 'confusion', chance: 1 },
  'swagger':       { status: 'confusion', chance: 1 },
  'dynamicpunch':  { status: 'confusion', chance: 1 },
  'hurricane':     { status: 'confusion', chance: 0.3 },
  'dizzy-punch':   { status: 'confusion', chance: 0.2 },
  'confusion':     { status: 'confusion', chance: 0.1 },
  'psybeam':       { status: 'confusion', chance: 0.1 },
  'water-pulse':   { status: 'confusion', chance: 0.2 },
};

// Moves that change field weather.  These have no target — they affect the whole
// battle.  The target the player submits is ignored during resolution.
type WeatherMoveEffect = {
  weather: NonNullable<IBattle['weather']>;
  startMessage: string;
};
const WEATHER_MOVES: Record<string, WeatherMoveEffect> = {
  'sunny-day':        { weather: 'sun',       startMessage: 'The sunlight turned harsh!' },
  'rain-dance':       { weather: 'rain',       startMessage: 'It started to rain!' },
  'sandstorm':        { weather: 'sandstorm',  startMessage: 'A sandstorm kicked up!' },
  'hail':             { weather: 'hail',       startMessage: 'It started to hail!' },
  'snowscape':        { weather: 'snow',       startMessage: 'It started to snow!' },
  'chilly-reception': { weather: 'snow',       startMessage: 'It started to snow!' },
};

// Moves that target only the user (stat boosts, recovery, etc.).
// These require no enemy target — submitting an empty targets array is valid.
const SELF_TARGETING_MOVES = new Set([
  // Stat boosts
  'swords-dance', 'calm-mind', 'nasty-plot', 'bulk-up', 'iron-defense',
  'amnesia', 'agility', 'barrier', 'cosmic-power', 'growth', 'harden',
  'withdraw', 'defense-curl', 'coil', 'quiver-dance', 'shift-gear',
  'dragon-dance', 'shell-smash', 'geomancy', 'rock-polish', 'autotomize',
  'charge', 'focus-energy',
  // Recovery
  'recover', 'soft-boiled', 'roost', 'moonlight', 'morning-sun',
  'synthesis', 'rest', 'slack-off', 'milk-drink', 'heal-order', 'shores-up',
  // Other self-targeting
  'endure', 'belly-drum', 'substitute', 'ingrain', 'aqua-ring', 'magnet-rise', 'stockpile',
]);

// All move IDs that require no enemy target selection.
// Sent to the client via the state endpoint so the UI can skip the target picker.
const NO_TARGET_MOVE_IDS = new Set([
  ...Object.keys(WEATHER_MOVES),
  ...SELF_TARGETING_MOVES,
]);

// Item effects for healing and status_cure items usable in battle.
// Mirrors the relevant entries in items.ts ITEM_EFFECTS.
type BattleItemEffect =
  | { kind: 'hp_flat';      amount: number }
  | { kind: 'hp_full' }
  | { kind: 'hp_full_cure' }
  | { kind: 'revive';       amount: 'half' | 'full' }
  | { kind: 'status_cure';  cures: string[] | 'all' };

const BATTLE_ITEM_EFFECTS: Record<string, BattleItemEffect> = {
  'potion':         { kind: 'hp_flat',     amount: 20 },
  'super-potion':   { kind: 'hp_flat',     amount: 60 },
  'hyper-potion':   { kind: 'hp_flat',     amount: 120 },
  'max-potion':     { kind: 'hp_full' },
  'full-restore':   { kind: 'hp_full_cure' },
  'revive':         { kind: 'revive',      amount: 'half' },
  'max-revive':     { kind: 'revive',      amount: 'full' },
  'oran-berry':     { kind: 'hp_flat',     amount: 10 },
  'sitrus-berry':   { kind: 'hp_flat',     amount: 25 },
  'antidote':       { kind: 'status_cure', cures: ['poison', 'toxic'] },
  'parlyz-heal':    { kind: 'status_cure', cures: ['paralysis'] },
  'burn-heal':      { kind: 'status_cure', cures: ['burn'] },
  'ice-heal':       { kind: 'status_cure', cures: ['freeze'] },
  'awakening':      { kind: 'status_cure', cures: ['sleep'] },
  'full-heal':      { kind: 'status_cure', cures: 'all' },
  'cheri-berry':    { kind: 'status_cure', cures: ['paralysis'] },
  'chesto-berry':   { kind: 'status_cure', cures: ['sleep'] },
  'pecha-berry':    { kind: 'status_cure', cures: ['poison', 'toxic'] },
  'rawst-berry':    { kind: 'status_cure', cures: ['burn'] },
  'aspear-berry':   { kind: 'status_cure', cures: ['freeze'] },
  'lum-berry':      { kind: 'status_cure', cures: 'all' },
  'poke-flute':     { kind: 'status_cure', cures: ['sleep'] },
  'blue-flute':     { kind: 'status_cure', cures: ['sleep'] },
  'green-flute':    { kind: 'status_cure', cures: ['sleep'] },
};

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
  const displayName = pokemon.nickname ?? (cache ? slugToDisplayName(cache.name as string) : 'Pokémon');
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
      if (itemEvents.length > 0) {
        let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
        if (!logEntry) {
          battle.turnLog.push({ turn: battle.turnNumber, events: [] });
          logEntry = battle.turnLog[battle.turnLog.length - 1];
        }
        for (const ev of itemEvents) logEntry.events.push(ev);
        battle.markModified('turnLog');
      }
      battle.turnQueue[battle.currentTargetIndex].resolved = true;
      battle.currentTargetIndex++;
      continue;
    }

    const poke = await Pokemon.findById(
      entry.activePokemonId,
      'nickname speciesId statusCondition statusCounter',
    ).lean();
    if (!poke || !poke.statusCondition) break; // no status — this actor moves normally

    const cache       = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name').lean();
    const displayName = poke.nickname ?? (cache ? slugToDisplayName(cache.name as string) : 'Pokémon');

    const { blocked, events } = await checkStatusBlock(
      poke._id as mongoose.Types.ObjectId,
      poke.statusCondition,
      poke.statusCounter,
      displayName,
    );

    // Log events before the break check — wake-up and thaw emit events with blocked:false
    if (events.length > 0) {
      let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
      if (!logEntry) {
        battle.turnLog.push({ turn: battle.turnNumber, events: [] });
        logEntry = battle.turnLog[battle.turnLog.length - 1];
      }
      for (const event of events) logEntry.events.push(event);
      battle.markModified('turnLog');
    }

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
    'nickname speciesId level nature currentHp volatileStatus',
  ).lean();
  if (!poke) return { hitSelf: false, events: [] };

  const confIdx = (poke.volatileStatus ?? []).findIndex(v => v.condition === 'confusion');
  if (confIdx === -1) return { hitSelf: false, events: [] };

  const cache       = await PokedexCache.findOne({ pokeApiId: poke.speciesId }, 'name baseStats').lean();
  const displayName = poke.nickname ?? (cache ? slugToDisplayName(cache.name as string) : 'Pokémon');

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
    'nickname speciesId statusCondition volatileStatus currentHp',
  ).lean();
  if (!target || target.currentHp <= 0) return [];

  const isConfusion = effect.status === 'confusion';

  if (!isConfusion && target.statusCondition) return [];
  if (isConfusion && target.volatileStatus.some(v => v.condition === 'confusion')) return [];

  const cache = await PokedexCache.findOne({ pokeApiId: target.speciesId }, 'name types').lean();
  const types = (cache?.types ?? []) as string[];
  const displayName = target.nickname ?? (cache ? slugToDisplayName(cache.name as string) : 'Pokémon');

  const isImmune = (
    (effect.status === 'paralysis' && types.includes('electric')) ||
    (effect.status === 'burn'      && types.includes('fire'))     ||
    ((effect.status === 'poison' || effect.status === 'toxic') &&
      (types.includes('poison') || types.includes('steel')))      ||
    (effect.status === 'freeze'    && types.includes('ice'))
  );
  if (isImmune) return [];

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
): Promise<{ damage: number; events: string[] }> {
  const [attacker, target] = await Promise.all([
    Pokemon.findById(attackerPokemonId).lean(),
    Pokemon.findById(targetPokemonId).lean(),
  ]);
  if (!attacker || !target) {
    return { damage: 0, events: ['(Pokémon not found during move resolution)'] };
  }

  const [attackerCache, targetCache] = await Promise.all([
    PokedexCache.findOne({ pokeApiId: attacker.speciesId }).lean(),
    PokedexCache.findOne({ pokeApiId: target.speciesId }).lean(),
  ]);
  if (!attackerCache || !targetCache) {
    return { damage: 0, events: ['(Species cache missing during move resolution)'] };
  }

  const attackerName = attacker.nickname ?? slugToDisplayName(attackerCache.name as string);
  const targetName   = target.nickname   ?? slugToDisplayName(targetCache.name   as string);
  const moveName     = slugToDisplayName(moveId);

  // Look up the move's data from the attacker's species cache.
  // The `name` field on each cached move is the PokeAPI slug, matching moveId.
  const moveData = (attackerCache.moves as Array<{
    name: string; category: string; power: number | null; implemented: boolean;
  }>).find(m => m.name === moveId);

  // Status moves and unrecognised moves deal no damage
  if (!moveData || !moveData.power) {
    const implNote = moveData && !moveData.implemented && !(moveId in STATUS_MOVES) && !(moveId in WEATHER_MOVES) && !SELF_TARGETING_MOVES.has(moveId) ? ' (effect not yet implemented)' : '';
    return {
      damage: 0,
      events: [`${attackerName} used ${moveName} on ${targetName}.${implNote}`],
    };
  }

  const isCrit = Math.random() < 1 / 24; // Gen 6+ base crit rate

  let damage    = 0;
  let effectNote = '';

  try {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const zeroes = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

    const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), {
      level:  attacker.level,
      nature: cap(attacker.nature) as any,
      evs:    zeroes,
      ivs:    zeroes,
      curHP:  attacker.currentHp,
      status: toCalcStatus(attacker.statusCondition) as any,
    });

    const calcTarget = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level:  target.level,
      nature: cap(target.nature) as any,
      evs:    zeroes,
      ivs:    zeroes,
      curHP:  target.currentHp,
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
  }

  damage = Math.max(0, damage);

  const critNote = isCrit && damage > 0 ? ' Critical hit!' : '';

  return {
    damage,
    events: [`${attackerName} used ${moveName} on ${targetName} for ${damage} damage!${effectNote}${critNote}`],
  };
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
      'speciesId level nature currentHp statusCondition statusCounter nickname',
    ).lean();

    const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
    const caches     = speciesIds.length > 0
      ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats types').lean()
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
      const pokeName = poke.nickname ?? slugToDisplayName(cache.name as string);

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

        const pokeTypes = (cache.types as string[]) ?? [];
        if (pokeTypes.some(t => immuneSet.has(t))) continue;

        const maxHp     = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
        const damage    = Math.max(1, Math.floor(maxHp / 16));
        const currentHp = runningHp.get(poke._id.toString()) ?? poke.currentHp;
        const newHp     = Math.max(0, currentHp - damage);
        const pokeName  = poke.nickname ?? slugToDisplayName(cache.name as string);

        runningHp.set(poke._id.toString(), newHp);
        await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });

        const verb = battle.weather === 'sandstorm' ? 'buffeted by the sandstorm' : 'pelted by hail';
        allEvents.push(`${pokeName} is ${verb}! (${damage} damage, ${newHp} HP remaining)`);
      }
    }

    if (allEvents.length > 0) {
      let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
      if (!logEntry) {
        battle.turnLog.push({ turn: battle.turnNumber, events: [] });
        logEntry = battle.turnLog[battle.turnLog.length - 1];
      }
      for (const event of allEvents) logEntry.events.push(event);
      battle.markModified('turnLog');
    }
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

      let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
      if (!logEntry) {
        battle.turnLog.push({ turn: battle.turnNumber, events: [] });
        logEntry = battle.turnLog[battle.turnLog.length - 1];
      }
      logEntry.events.push(endMessage);
      battle.markModified('turnLog');
    } else {
      battle.weatherTurnsRemaining = newTurns;
    }
  }

  // All moves resolved — hold at end_of_round so the DM can read the log
  // before advancing. The advance-round endpoint handles the actual reset.
  battle.phase = 'end_of_round';
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
  const { type, playerIds, npcIds = [], playerPokemonLimit = null } = req.body as {
    type: string;
    playerIds: string[];
    npcIds?: string[];
    playerPokemonLimit?: number | null;
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
    enemySide: npcIds.map(id => ({
      npcId:           new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      fainted:         [],
    })),
    playerPokemonLimit: playerPokemonLimit ?? null,
    lastUpdatedAt:      new Date(),
  });

  res.status(201).json({
    data: { _id: battle._id, status: battle.status, type: battle.type },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/start
// DM only — activates a waiting battle.
// Changes status from 'waiting' → 'active' and sets turnNumber to 1.
// ---------------------------------------------------------------------------
router.post('/:id/start', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'waiting') {
    res.status(400).json({ data: null, error: 'Battle has already started' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

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

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
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
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { activePokemonId: pokemonId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-send-out
// DM only — sets the active Pokémon for an NPC slot on the enemy side.
// Body: { npcId: string, pokemonId: string }
// ---------------------------------------------------------------------------
router.post('/:id/dm-send-out', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  const { npcId, pokemonId } = req.body as { npcId: string; pokemonId: string };

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
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

  const npcEntry = battle.enemySide.find(e => e.npcId.toString() === npcId);
  if (!npcEntry) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }

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

  // Clear volatile statuses (confusion, etc.) on the outgoing Pokémon
  const outgoingNpcId = npcEntry.activePokemonId;
  if (outgoingNpcId && outgoingNpcId.toString() !== pokemonId) {
    await Pokemon.updateOne({ _id: outgoingNpcId }, { $set: { volatileStatus: [] } });
  }

  npcEntry.activePokemonId = pokeId;
  battle.lastUpdatedAt     = new Date();
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
  const { actionType = 'move', moveId, itemId, targetPokemonId } =
    req.body as {
      actionType?: 'move' | 'item';
      moveId?: string;
      itemId?: string;
      targetPokemonId?: string;
    };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
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
// DM only — submits a move on behalf of an NPC.
// Body: { npcId: string, moveId: string }
// ---------------------------------------------------------------------------
router.post('/:id/dm-submit-move', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  const { npcId, moveId } = req.body as { npcId: string; moveId: string };

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  if (!npcId || !moveId) {
    res.status(400).json({ data: null, error: 'npcId and moveId are required' });
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

  const npcEntry = battle.enemySide.find(e => e.npcId.toString() === npcId);
  if (!npcEntry) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }
  if (!npcEntry.activePokemonId) {
    res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' });
    return;
  }

  const alreadySubmitted = battle.turnQueue.some(
    e => e.actorId.toString() === npcId && e.actorType === 'npc'
  );
  if (alreadySubmitted) {
    res.status(400).json({ data: null, error: 'This NPC has already submitted a move this turn' });
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

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

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
  const targetPokemons = await Pokemon.find({ _id: { $in: targets } }, 'currentHp').lean();
  const fainted = targetPokemons.filter(p => p.currentHp <= 0);
  if (fainted.length > 0) {
    res.status(400).json({ data: null, error: 'Cannot target a fainted Pokémon' });
    return;
  }

  // Build a HP map from the liveness check above so we can compute new HP
  // without an extra DB round-trip per target.
  const targetHpMap = new Map(targetPokemons.map(p => [p._id.toString(), p.currentHp]));

  // Fill targets and immediately resolve damage (sequential speed-order design)
  battle.turnQueue[idx].targets = targets.map(t => new mongoose.Types.ObjectId(t));

  // Confusion check: 50% chance the Pokémon hurts itself instead of using its move.
  // If hitSelf, skip resolveMove and PP deduction — confusion self-hits don't cost PP.
  const { hitSelf, events: confusionEvents } = await checkConfusion(currentEntry.activePokemonId);
  const moveEvents: string[] = [...confusionEvents];

  if (!hitSelf) {
    const moveEffect   = STATUS_MOVES[currentEntry.moveId];
    const weatherEffect = WEATHER_MOVES[currentEntry.moveId];

    if (weatherEffect) {
      // Weather move: set field weather, no damage, no target needed
      const attacker = await Pokemon.findById(currentEntry.activePokemonId, 'nickname speciesId').lean();
      const atkCache  = attacker
        ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name').lean()
        : null;
      const attackerName = attacker?.nickname ?? (atkCache ? slugToDisplayName(atkCache.name as string) : 'Pokémon');
      const moveName     = slugToDisplayName(currentEntry.moveId);

      if (battle.weather === weatherEffect.weather) {
        // Same weather already active — no effect, no counter reset
        moveEvents.push(`${attackerName} used ${moveName}! But it had no effect...`);
      } else if (battle.weather) {
        // Different weather active — cancel both
        battle.weather               = null;
        battle.weatherTurnsRemaining = null;
        moveEvents.push(`${attackerName} used ${moveName}! The weather cleared!`);
      } else {
        // No weather — start new weather
        battle.weather               = weatherEffect.weather;
        battle.weatherTurnsRemaining = 5;
        moveEvents.push(`${attackerName} used ${moveName}! ${weatherEffect.startMessage}`);
      }
    } else if (SELF_TARGETING_MOVES.has(currentEntry.moveId)) {
      // Self-targeting move: log usage only (stat changes / recovery not yet implemented)
      const attacker = await Pokemon.findById(currentEntry.activePokemonId, 'nickname speciesId').lean();
      const atkCache  = attacker
        ? await PokedexCache.findOne({ pokeApiId: attacker.speciesId }, 'name').lean()
        : null;
      const attackerName = attacker?.nickname ?? (atkCache ? slugToDisplayName(atkCache.name as string) : 'Pokémon');
      moveEvents.push(`${attackerName} used ${slugToDisplayName(currentEntry.moveId)}!`);
    } else {
      for (const targetId of targets) {
        const { damage, events } = await resolveMove(
          currentEntry.activePokemonId,
          new mongoose.Types.ObjectId(targetId),
          currentEntry.moveId,
          battle.weather,
        );
        moveEvents.push(...events);

        if (damage > 0) {
          const currentHp = targetHpMap.get(targetId) ?? 0;
          const newHp     = Math.max(0, currentHp - damage);
          await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newHp } });
        }

        // Secondary status effect — rolled per target so multi-target moves work correctly
        if (moveEffect && Math.random() < moveEffect.chance) {
          const statusEvents = await applyStatusEffect(new mongoose.Types.ObjectId(targetId), moveEffect);
          moveEvents.push(...statusEvents);
        }
      }
    }

    // Deduct 1 PP from the attacker's move slot (floor at 0)
    await Pokemon.updateOne(
      { _id: currentEntry.activePokemonId, 'moves.moveId': currentEntry.moveId, 'moves.currentPP': { $gt: 0 } },
      { $inc: { 'moves.$.currentPP': -1 } },
    );
  }

  // Mark the entry resolved and write events to the turn log
  battle.turnQueue[idx].resolved = true;

  let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
  if (!logEntry) {
    battle.turnLog.push({ turn: battle.turnNumber, events: [] });
    logEntry = battle.turnLog[battle.turnLog.length - 1];
  }
  for (const event of moveEvents) {
    logEntry.events.push(event);
  }
  battle.markModified('turnLog');

  battle.currentTargetIndex = idx + 1;
  await autoSkipBlockedActors(battle);

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
router.post('/:id/advance-round', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
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
  if (battle.phase !== 'end_of_round') {
    res.status(400).json({ data: null, error: 'Battle is not at end of round' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

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
router.post('/:id/weather', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
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

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

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

  let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
  if (!logEntry) {
    battle.turnLog.push({ turn: battle.turnNumber, events: [] });
    logEntry = battle.turnLog[battle.turnLog.length - 1];
  }
  logEntry.events.push(logMessage);
  battle.markModified('turnLog');

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { weather: battle.weather, weatherTurnsRemaining: battle.weatherTurnsRemaining }, error: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/battles/:id
// DM only — permanently deletes a battle.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

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

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

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
        'nickname speciesId currentHp level nature statusCondition volatileStatus'
      ).lean()
    : [];

  const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats').lean()
    : [];

  const pokemonMap = new Map(activePokemons.map(p => [p._id.toString(), p]));
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  // Build a compact info object for a single active Pokémon slot.
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
    };
  };

  const playerSideWithNames = battle.playerSide.map(entry => ({
    ...entry,
    username:          usernameMap.get(entry.userId.toString()) ?? 'Unknown',
    activePokemonInfo: buildInfo(entry.activePokemonId),
  }));

  // Join NPC names so the frontend can label enemy slots without extra requests
  const npcIds  = battle.enemySide.map(e => e.npcId);
  const npcs    = npcIds.length > 0
    ? await Npc.find({ _id: { $in: npcIds } }, 'name').lean()
    : [];
  const npcNameMap = new Map(npcs.map(n => [(n._id as mongoose.Types.ObjectId).toString(), n.name]));

  const enemySideWithInfo = battle.enemySide.map(entry => ({
    ...entry,
    npcName:           npcNameMap.get(entry.npcId.toString()) ?? 'NPC',
    activePokemonInfo: buildInfo(entry.activePokemonId),
  }));

  res.json({
    data: {
      ...battle,
      playerSide:       playerSideWithNames,
      enemySide:        enemySideWithInfo,
      noTargetMoveIds:  [...NO_TARGET_MOVE_IDS],
    },
    error: null,
  });
});

export default router;
