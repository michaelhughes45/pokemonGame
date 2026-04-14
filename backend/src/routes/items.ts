import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { verifyToken } from '../middleware/auth';
import { Item } from '../models/Item';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { computeStats } from '../lib/statCalc';

const router = Router();

// ---------------------------------------------------------------------------
// Item effect table
// Maps every supported itemId to what it does when used out of battle.
// The server is the authority on effects — we never trust the pocket value
// from the client for logic decisions.
// ---------------------------------------------------------------------------

type ItemEffect =
  | { kind: 'hp_flat';       amount: number }
  | { kind: 'hp_full' }
  | { kind: 'hp_full_cure' }                          // Full Restore: HP + cure status
  | { kind: 'revive';        amount: 'half' | 'full' }
  | { kind: 'status_cure';   cures: string[] | 'all' }
  | { kind: 'volatile_cure'; condition: string }       // Cure a volatile status (e.g. confusion)
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
  // Consumed on use — no mechanical effect until overworld is added.
  'escape-rope':    { kind: 'escape_rope' },
};

// ---------------------------------------------------------------------------
// GET /api/items
// Returns the logged-in player's bag as a flat array.
// The frontend groups by pocket for the tab UI.
// ---------------------------------------------------------------------------
router.get('/', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const items = await Item.find({ ownerId: req.user!.userId })
      .lean()
      .sort({ pocket: 1, itemId: 1 });

    res.json({ data: items, error: null });
  } catch (err) {
    console.error('Items GET error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

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
router.post('/use', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { itemId, pokemonId, moveIndex } = req.body as {
      itemId:     string;
      pokemonId:  string;
      moveIndex?: number;
    };

    // ── Basic validation ───────────────────────────────────────────────────
    if (!itemId || typeof itemId !== 'string') {
      res.status(400).json({ data: null, error: 'itemId is required' });
      return;
    }

    // ── Resolve effect ─────────────────────────────────────────────────────
    // Check the player's bag first (handles Pokéballs by pocket, not itemId)
    const bagEntry = await Item.findOne({ ownerId: req.user!.userId, itemId }).lean();
    if (!bagEntry) {
      res.status(404).json({ data: null, error: 'You do not have that item.' });
      return;
    }
    if (bagEntry.pocket === 'pokeballs') {
      res.status(400).json({ data: null, error: 'Poké Balls can only be used in battle.' });
      return;
    }

    const effect = ITEM_EFFECTS[itemId];
    if (!effect) {
      res.status(400).json({ data: null, error: `No effect defined for item: ${itemId}` });
      return;
    }

    // Early exits that don't consume the item
    if (effect.kind === 'battle_only') {
      res.status(400).json({ data: null, error: 'This item can only be used in battle.' });
      return;
    }
    if (effect.kind === 'stat_boost') {
      res.status(400).json({
        data: null,
        error: 'EV system not yet active. Vitamins will work in Phase 5.',
      });
      return;
    }

    // ── Escape rope: consumed immediately, no Pokémon target needed ────────
    if (effect.kind === 'escape_rope') {
      const liveItem = await Item.findOne({ ownerId: req.user!.userId, itemId });
      if (liveItem) {
        if (liveItem.quantity <= 1) await liveItem.deleteOne();
        else { liveItem.quantity -= 1; await liveItem.save(); }
      }
      res.json({ data: { message: 'You used the Escape Rope!' }, error: null });
      return;
    }

    // ── All other effects need a valid Pokémon target ──────────────────────
    if (!pokemonId || !mongoose.Types.ObjectId.isValid(pokemonId)) {
      res.status(400).json({ data: null, error: 'Valid pokemonId is required' });
      return;
    }

    const pokemon = await Pokemon.findOne({
      _id:     pokemonId,
      ownerId: req.user!.userId,
    });
    if (!pokemon) {
      res.status(404).json({ data: null, error: 'Pokémon not found.' });
      return;
    }

    // ── Apply effect ───────────────────────────────────────────────────────
    let message = '';

    if (
      effect.kind === 'hp_flat' ||
      effect.kind === 'hp_full' ||
      effect.kind === 'hp_full_cure'
    ) {
      // Healing items don't work on fainted Pokémon — use Revive instead
      if (pokemon.currentHp === 0) {
        res.status(400).json({
          data: null,
          error: 'This item cannot be used on a fainted Pokémon. Use a Revive instead.',
        });
        return;
      }

      const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
        .select('baseStats').lean();
      if (!species) {
        res.status(400).json({ data: null, error: 'Species data not found in cache.' });
        return;
      }
      const maxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;

      if (pokemon.currentHp >= maxHp && effect.kind !== 'hp_full_cure') {
        res.status(400).json({ data: null, error: 'That Pokémon is already at full HP.' });
        return;
      }

      const before = pokemon.currentHp;
      pokemon.currentHp = effect.kind === 'hp_flat'
        ? Math.min(maxHp, pokemon.currentHp + effect.amount)
        : maxHp;

      if (effect.kind === 'hp_full_cure') {
        pokemon.statusCondition = null;
      }

      const restored = pokemon.currentHp - before;
      message = restored > 0
        ? `Restored ${restored} HP${effect.kind === 'hp_full_cure' ? ' and cured status' : ''}.`
        : 'Cured status condition.';

    } else if (effect.kind === 'revive') {
      if (pokemon.currentHp > 0) {
        res.status(400).json({ data: null, error: 'Revive can only be used on a fainted Pokémon.' });
        return;
      }

      const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
        .select('baseStats').lean();
      if (!species) {
        res.status(400).json({ data: null, error: 'Species data not found in cache.' });
        return;
      }
      const maxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;

      pokemon.currentHp = effect.amount === 'half'
        ? Math.max(1, Math.floor(maxHp / 2))
        : maxHp;

      message = `Revived! Restored to ${pokemon.currentHp} HP.`;

    } else if (effect.kind === 'status_cure') {
      if (!pokemon.statusCondition) {
        res.status(400).json({ data: null, error: 'That Pokémon has no status condition.' });
        return;
      }

      const curable =
        effect.cures === 'all' ||
        effect.cures.includes(pokemon.statusCondition);

      if (!curable) {
        res.status(400).json({
          data: null,
          error: `That item cannot cure ${pokemon.statusCondition}.`,
        });
        return;
      }

      pokemon.statusCondition = null;
      message = 'Status condition cured.';

    } else if (effect.kind === 'pp_flat' || effect.kind === 'pp_full') {
      if (pokemon.moves.length === 0) {
        res.status(400).json({ data: null, error: 'That Pokémon has no moves.' });
        return;
      }

      if (effect.target === 'one') {
        // moveIndex must be provided and point to a real move slot
        if (typeof moveIndex !== 'number' || moveIndex < 0 || moveIndex >= pokemon.moves.length) {
          res.status(400).json({ data: null, error: 'Valid moveIndex (0–3) is required for this item.' });
          return;
        }

        const move = pokemon.moves[moveIndex];
        if (move.currentPP >= move.maxPP) {
          res.status(400).json({ data: null, error: 'That move already has full PP.' });
          return;
        }

        move.currentPP = effect.kind === 'pp_flat'
          ? Math.min(move.maxPP, move.currentPP + effect.amount)
          : move.maxPP;

        message = `Restored PP for ${move.moveId}.`;
      } else {
        // Elixir / Max Elixir — restore all moves
        const allFull = pokemon.moves.every(m => m.currentPP >= m.maxPP);
        if (allFull) {
          res.status(400).json({ data: null, error: 'All moves already have full PP.' });
          return;
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
      if (pokemon.level >= 100) {
        res.status(400).json({ data: null, error: 'That Pokémon is already at level 100.' });
        return;
      }

      const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
        .select('baseStats').lean();
      if (!species) {
        res.status(400).json({ data: null, error: 'Species data not found in cache.' });
        return;
      }

      const oldMaxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;
      pokemon.level += 1;
      const newMaxHp = computeStats(species.baseStats, pokemon.level, pokemon.nature).hp;

      // Current HP rises by the same amount as max HP — same as the main games.
      // Evolution check is deferred to milestone 4.4.
      pokemon.currentHp += (newMaxHp - oldMaxHp);

      message = `Grew to level ${pokemon.level}!`;

    } else if (effect.kind === 'volatile_cure') {
      const before = pokemon.volatileStatus.length;
      pokemon.volatileStatus = pokemon.volatileStatus.filter(
        v => v.condition !== effect.condition
      );
      if (pokemon.volatileStatus.length === before) {
        res.status(400).json({
          data: null,
          error: `That Pokémon is not affected by ${effect.condition}.`,
        });
        return;
      }
      pokemon.markModified('volatileStatus');
      message = `${effect.condition.charAt(0).toUpperCase() + effect.condition.slice(1)} cured.`;

    } else if (effect.kind === 'held_item') {
      // Guard: don't let the player "equip" what the pokemon is already holding
      if (pokemon.heldItem === itemId) {
        res.status(400).json({ data: null, error: 'That Pokémon is already holding that item.' });
        return;
      }

      const previousHeldItem = pokemon.heldItem;
      pokemon.heldItem = itemId;

      // Return the old held item to the bag so it isn't lost
      if (previousHeldItem) {
        await Item.findOneAndUpdate(
          { ownerId: req.user!.userId, itemId: previousHeldItem },
          { $inc: { quantity: 1 }, $setOnInsert: { pocket: 'held_type' } },
          { upsert: true }
        );
        message = `Equipped ${itemId}. ${previousHeldItem} was returned to your bag.`;
      } else {
        message = `Equipped ${itemId}.`;
      }
    }

    // ── Save Pokémon changes ───────────────────────────────────────────────
    await pokemon.save();

    // ── Consume one item from the bag ──────────────────────────────────────
    // We use the live document (not the lean snapshot) to avoid stale quantity.
    const liveItem = await Item.findOne({ ownerId: req.user!.userId, itemId });
    if (liveItem) {
      if (liveItem.quantity <= 1) {
        await liveItem.deleteOne();
      } else {
        liveItem.quantity -= 1;
        await liveItem.save();
      }
    }

    res.json({ data: { message }, error: null });
  } catch (err) {
    console.error('Items use error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

export default router;
