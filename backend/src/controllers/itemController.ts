import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Item } from '../models/Item';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { computeStats } from '../lib/statCalc';
import { canEvolve } from '../lib/evolution';
import { fetchSpecies } from '../lib/pokeapi';
import { getPlayerEffectiveLevelCap } from '../lib/levelCap';

// ---------------------------------------------------------------------------
// Item effect table
// Maps every supported itemId to what it does when used out of battle.
// The server is the authority on effects — we never trust the pocket value
// from the client for logic decisions.
// ---------------------------------------------------------------------------

type ItemEffect =
  | { kind: 'hp_flat';       amount: number }
  | { kind: 'hp_full' }
  | { kind: 'hp_full_cure' }                           // Full Restore: HP + cure status
  | { kind: 'revive';        amount: 'half' | 'full' }
  | { kind: 'status_cure';   cures: string[] | 'all' }
  | { kind: 'volatile_cure'; condition: string }        // Cure a volatile status (e.g. confusion)
  | { kind: 'pp_flat';       amount: number; target: 'one' | 'all' }
  | { kind: 'pp_full';       target: 'one' | 'all' }
  | { kind: 'level_up' }     // Rare Candy — increment level by 1, cap at 100
  | { kind: 'stat_boost' }   // EVs deferred to Phase 5 — item not consumed
  | { kind: 'held_item' }    // Equip as held item on a Pokémon
  | { kind: 'escape_rope' }  // Consumed immediately, no Pokémon target needed
  | { kind: 'battle_only' }; // Pokéballs only

const ITEM_EFFECTS: Record<string, ItemEffect> = {
  // ── Healing ────────────────────────────────────────────────────────────────
  'potion':         { kind: 'hp_flat', amount: 20 },
  'super-potion':   { kind: 'hp_flat', amount: 60 },
  'hyper-potion':   { kind: 'hp_flat', amount: 120 },
  'max-potion':     { kind: 'hp_full' },
  'full-restore':   { kind: 'hp_full_cure' },
  'revive':         { kind: 'revive', amount: 'half' },
  'max-revive':     { kind: 'revive', amount: 'full' },
  'oran-berry':     { kind: 'hp_flat', amount: 10 },
  'sitrus-berry':   { kind: 'hp_flat', amount: 25 },

  // ── Status cures ───────────────────────────────────────────────────────────
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

  // ── Flutes ─────────────────────────────────────────────────────────────────
  // Poké Flute, Blue Flute, Green Flute all wake sleeping Pokémon
  'poke-flute':     { kind: 'status_cure',   cures: ['sleep'] },
  'blue-flute':     { kind: 'status_cure',   cures: ['sleep'] },
  'green-flute':    { kind: 'status_cure',   cures: ['sleep'] },
  // Yellow Flute snaps Pokémon out of confusion (a volatile status)
  'yellow-flute':   { kind: 'volatile_cure', condition: 'confusion' },

  // ── PP recovery ────────────────────────────────────────────────────────────
  'ether':          { kind: 'pp_flat', amount: 10, target: 'one' },
  'max-ether':      { kind: 'pp_full', target: 'one' },
  'elixir':         { kind: 'pp_flat', amount: 10, target: 'all' },
  'max-elixir':     { kind: 'pp_full', target: 'all' },

  // ── Level up ───────────────────────────────────────────────────────────────
  'rare-candy':     { kind: 'level_up' },

  // ── Stat boosters (EVs — deferred to Phase 5) ──────────────────────────────
  'hp-up':          { kind: 'stat_boost' },
  'protein':        { kind: 'stat_boost' },
  'iron':           { kind: 'stat_boost' },
  'calcium':        { kind: 'stat_boost' },
  'zinc':           { kind: 'stat_boost' },
  'carbos':         { kind: 'stat_boost' },
  'pp-up':          { kind: 'stat_boost' },
  'pp-max':         { kind: 'stat_boost' },

  // ── Held-type items ────────────────────────────────────────────────────────
  'charcoal':       { kind: 'held_item' },
  'mystic-water':   { kind: 'held_item' },
  'magnet':         { kind: 'held_item' },
  'miracle-seed':   { kind: 'held_item' },
  'never-melt-ice': { kind: 'held_item' },
  'spell-tag':      { kind: 'held_item' },
  'twisted-spoon':  { kind: 'held_item' },
  'black-belt':     { kind: 'held_item' },
  'poison-barb':    { kind: 'held_item' },
  'soft-sand':      { kind: 'held_item' },
  'hard-stone':     { kind: 'held_item' },
  'silver-powder':  { kind: 'held_item' },
  'sharp-beak':     { kind: 'held_item' },
  'dragon-fang':    { kind: 'held_item' },
  'black-glasses':  { kind: 'held_item' },
  'silk-scarf':     { kind: 'held_item' },
  'metal-coat':     { kind: 'held_item' },

  // ── Escape ─────────────────────────────────────────────────────────────────
  'escape-rope':    { kind: 'escape_rope' },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

// Fetches species base stats from the cache; sends a 400 and returns null if missing.
async function fetchSpeciesBaseStats(speciesId: number, res: Response) {
  const species = await PokedexCache.findOne({ pokeApiId: speciesId })
    .select('baseStats')
    .lean();
  if (!species) {
    sendError(res, 400, 'Species data not found in cache.');
    return null;
  }
  return species;
}

// Decrements an item's quantity by 1 and deletes the document if it reaches 0.
// Uses a fresh DB read to avoid acting on a stale quantity from an earlier lean snapshot.
async function consumeItem(userId: string, itemId: string): Promise<void> {
  const liveItem = await Item.findOne({ ownerId: userId, itemId });
  if (!liveItem) return;
  if (liveItem.quantity <= 1) {
    await liveItem.deleteOne();
  } else {
    liveItem.quantity -= 1;
    await liveItem.save();
  }
}

// ---------------------------------------------------------------------------
// GET /api/items
// Returns the logged-in player's bag as a flat array.
// The frontend groups by pocket for the tab UI.
// ---------------------------------------------------------------------------
export async function getBag(req: Request, res: Response): Promise<void> {
  const items = await Item.find({ ownerId: req.user!.userId })
    .lean()
    .sort({ pocket: 1, itemId: 1 });

  sendOk(res, items);
}

// ---------------------------------------------------------------------------
// POST /api/items/use
// Body: { itemId, pokemonId, moveIndex? }
//
// moveIndex is required for Ether/Max Ether (pp target: 'one').
// For Elixir/Max Elixir the server applies PP to all moves automatically.
//
// On success: quantity decremented; document deleted if it reaches 0.
// battle_only and stat_boost return 400 without consuming anything.
// ---------------------------------------------------------------------------
export async function useItem(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { itemId, pokemonId, moveIndex } = req.body as {
    itemId:     string;
    pokemonId:  string;
    moveIndex?: number;
  };

  if (!itemId || typeof itemId !== 'string') {
    return sendError(res, 400, 'itemId is required');
  }

  // Resolve from bag first — handles Pokéballs by pocket, not itemId
  const bagEntry = await Item.findOne({ ownerId: userId, itemId }).lean();
  if (!bagEntry) {
    return sendError(res, 404, 'You do not have that item.');
  }
  if (bagEntry.pocket === 'pokeballs') {
    return sendError(res, 400, 'Poké Balls can only be used in battle.');
  }

  const effect = ITEM_EFFECTS[itemId];
  if (!effect) {
    return sendError(res, 400, `No effect defined for item: ${itemId}`);
  }

  // Early exits that don't consume the item
  if (effect.kind === 'battle_only') {
    return sendError(res, 400, 'This item can only be used in battle.');
  }
  if (effect.kind === 'stat_boost') {
    return sendError(res, 400, 'EV system not yet active. Vitamins will work in Phase 5.');
  }

  // Escape rope: consumed immediately, no Pokémon target needed
  if (effect.kind === 'escape_rope') {
    await consumeItem(userId, itemId);
    return sendOk(res, { message: 'You used the Escape Rope!' });
  }

  // All other effects need a valid Pokémon target
  if (!pokemonId || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    return sendError(res, 400, 'Valid pokemonId is required');
  }

  const pokemon = await Pokemon.findOne({ _id: pokemonId, ownerId: userId });
  if (!pokemon) {
    return sendError(res, 404, 'Pokémon not found.');
  }

  let message = '';

  if (effect.kind === 'hp_flat' || effect.kind === 'hp_full' || effect.kind === 'hp_full_cure') {
    if (pokemon.currentHp === 0) {
      return sendError(res, 400, 'This item cannot be used on a fainted Pokémon. Use a Revive instead.');
    }

    const species = await fetchSpeciesBaseStats(pokemon.speciesId, res);
    if (!species) return;
    const maxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;

    if (pokemon.currentHp >= maxHp && effect.kind !== 'hp_full_cure') {
      return sendError(res, 400, 'That Pokémon is already at full HP.');
    }

    const before = pokemon.currentHp;
    pokemon.currentHp = effect.kind === 'hp_flat'
      ? Math.min(maxHp, pokemon.currentHp + effect.amount)
      : maxHp;

    if (effect.kind === 'hp_full_cure') pokemon.statusCondition = null;

    const restored = pokemon.currentHp - before;
    message = restored > 0
      ? `Restored ${restored} HP${effect.kind === 'hp_full_cure' ? ' and cured status' : ''}.`
      : 'Cured status condition.';

  } else if (effect.kind === 'revive') {
    if (pokemon.currentHp > 0) {
      return sendError(res, 400, 'Revive can only be used on a fainted Pokémon.');
    }

    const species = await fetchSpeciesBaseStats(pokemon.speciesId, res);
    if (!species) return;
    const maxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;

    pokemon.currentHp = effect.amount === 'half'
      ? Math.max(1, Math.floor(maxHp / 2))
      : maxHp;

    message = `Revived! Restored to ${pokemon.currentHp} HP.`;

  } else if (effect.kind === 'status_cure') {
    if (!pokemon.statusCondition) {
      return sendError(res, 400, 'That Pokémon has no status condition.');
    }

    const curable = effect.cures === 'all' || effect.cures.includes(pokemon.statusCondition);
    if (!curable) {
      return sendError(res, 400, `That item cannot cure ${pokemon.statusCondition}.`);
    }

    pokemon.statusCondition = null;
    message = 'Status condition cured.';

  } else if (effect.kind === 'pp_flat' || effect.kind === 'pp_full') {
    if (pokemon.moves.length === 0) {
      return sendError(res, 400, 'That Pokémon has no moves.');
    }

    if (effect.target === 'one') {
      if (typeof moveIndex !== 'number' || moveIndex < 0 || moveIndex >= pokemon.moves.length) {
        return sendError(res, 400, 'Valid moveIndex (0–3) is required for this item.');
      }
      const move = pokemon.moves[moveIndex];
      if (move.currentPP >= move.maxPP) {
        return sendError(res, 400, 'That move already has full PP.');
      }
      move.currentPP = effect.kind === 'pp_flat'
        ? Math.min(move.maxPP, move.currentPP + effect.amount)
        : move.maxPP;
      message = `Restored PP for ${move.moveId}.`;
    } else {
      if (pokemon.moves.every(m => m.currentPP >= m.maxPP)) {
        return sendError(res, 400, 'All moves already have full PP.');
      }
      for (const move of pokemon.moves) {
        move.currentPP = effect.kind === 'pp_flat'
          ? Math.min(move.maxPP, move.currentPP + effect.amount)
          : move.maxPP;
      }
      message = 'Restored PP for all moves.';
    }

    // Mongoose needs this hint because we mutated array sub-documents directly
    pokemon.markModified('moves');

  } else if (effect.kind === 'level_up') {
    const cap = await getPlayerEffectiveLevelCap(userId);
    if (pokemon.level >= cap) {
      return sendError(res, 400, cap >= 100
        ? 'That Pokémon is already at level 100.'
        : `That Pokémon is already at its level cap (Lv. ${cap}).`);
    }

    const species = await fetchSpeciesBaseStats(pokemon.speciesId, res);
    if (!species) return;

    const oldMaxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;
    pokemon.level += 1;
    const newMaxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;
    // Current HP rises by the same delta as max HP — same as the main games
    pokemon.currentHp += (newMaxHp - oldMaxHp);

    message = `Grew to level ${pokemon.level}!`;

    const evolveIntoId = await canEvolve({
      speciesId:          pokemon.speciesId,
      level:              pokemon.level,
      evolutionOverrides: (pokemon.evolutionOverrides ?? []) as { condition: string; value: string }[],
    });
    if (evolveIntoId !== null) {
      pokemon.speciesId = evolveIntoId;
      let evolved = await PokedexCache.findOne({ pokeApiId: evolveIntoId }).select('name baseStats').lean();
      if (!evolved) {
        try {
          const fetched = await fetchSpecies(evolveIntoId);
          const created = await PokedexCache.create(fetched);
          evolved = created.toObject();
        } catch { /* leave evolved null — name falls back below */ }
      }
      if (evolved?.baseStats) {
        pokemon.currentHp = computeStats(evolved.baseStats, pokemon.level, pokemon.nature).hp;
      }
      const evolvedName = evolved ? (evolved.name as string) : 'a new form';
      message += ` ${pokemon.nickname ?? 'It'} evolved into ${evolvedName}!`;
    }

  } else if (effect.kind === 'volatile_cure') {
    const before = pokemon.volatileStatus.length;
    pokemon.volatileStatus = pokemon.volatileStatus.filter(v => v.condition !== effect.condition);
    if (pokemon.volatileStatus.length === before) {
      return sendError(res, 400, `That Pokémon is not affected by ${effect.condition}.`);
    }
    pokemon.markModified('volatileStatus');
    message = `${effect.condition.charAt(0).toUpperCase() + effect.condition.slice(1)} cured.`;

  } else if (effect.kind === 'held_item') {
    if (pokemon.heldItem === itemId) {
      return sendError(res, 400, 'That Pokémon is already holding that item.');
    }

    const previousHeldItem = pokemon.heldItem;
    pokemon.heldItem = itemId;

    // Return the old held item to the bag so it isn't lost
    if (previousHeldItem) {
      await Item.findOneAndUpdate(
        { ownerId: userId, itemId: previousHeldItem },
        { $inc: { quantity: 1 }, $setOnInsert: { pocket: 'held_type' } },
        { upsert: true },
      );
      message = `Equipped ${itemId}. ${previousHeldItem} was returned to your bag.`;
    } else {
      message = `Equipped ${itemId}.`;
    }
  }

  await pokemon.save();
  await consumeItem(userId, itemId);
  sendOk(res, { message });
}
