import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { verifyToken } from '../middleware/auth';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';

const router = Router();

// ---------------------------------------------------------------------------
// Stat calculation helpers
// ---------------------------------------------------------------------------

type StatKey = 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';

// Maps a nature name to which non-HP stat it boosts (+10%) and drops (-10%).
// Neutral natures (Hardy, Docile, Serious, Bashful, Quirky) have no entry.
const NATURE_MODIFIERS: Record<string, { boost?: StatKey; drop?: StatKey }> = {
  Lonely:  { boost: 'atk',   drop: 'def'   },
  Brave:   { boost: 'atk',   drop: 'speed' },
  Adamant: { boost: 'atk',   drop: 'spatk' },
  Naughty: { boost: 'atk',   drop: 'spdef' },
  Bold:    { boost: 'def',   drop: 'atk'   },
  Relaxed: { boost: 'def',   drop: 'speed' },
  Impish:  { boost: 'def',   drop: 'spatk' },
  Lax:     { boost: 'def',   drop: 'spdef' },
  Timid:   { boost: 'speed', drop: 'atk'   },
  Hasty:   { boost: 'speed', drop: 'def'   },
  Jolly:   { boost: 'speed', drop: 'spatk' },
  Naive:   { boost: 'speed', drop: 'spdef' },
  Modest:  { boost: 'spatk', drop: 'atk'   },
  Mild:    { boost: 'spatk', drop: 'def'   },
  Quiet:   { boost: 'spatk', drop: 'speed' },
  Rash:    { boost: 'spatk', drop: 'spdef' },
  Calm:    { boost: 'spdef', drop: 'atk'   },
  Gentle:  { boost: 'spdef', drop: 'def'   },
  Sassy:   { boost: 'spdef', drop: 'speed' },
  Careful: { boost: 'spdef', drop: 'spatk' },
};

// Gen 3+ stat formula. No IVs/EVs until Phase 5 (both treated as 0).
function computeStats(
  base: { hp: number; atk: number; def: number; spatk: number; spdef: number; speed: number },
  level: number,
  nature: string
): { hp: number; atk: number; def: number; spatk: number; spdef: number; speed: number } {
  const mod = NATURE_MODIFIERS[nature] ?? {};

  function calcOther(b: number, key: StatKey): number {
    const raw = Math.floor((2 * b * level) / 100) + 5;
    const mult = mod.boost === key ? 1.1 : mod.drop === key ? 0.9 : 1.0;
    return Math.floor(raw * mult);
  }

  return {
    hp:    Math.floor((2 * base.hp * level) / 100) + level + 10,
    atk:   calcOther(base.atk,   'atk'),
    def:   calcOther(base.def,   'def'),
    spatk: calcOther(base.spatk, 'spatk'),
    spdef: calcOther(base.spdef, 'spdef'),
    speed: calcOther(base.speed, 'speed'),
  };
}

// ---------------------------------------------------------------------------
// GET /api/pokemon/party
// Returns the logged-in user's party (isInParty: true), enriched with species
// name and types so the dashboard can render previews without extra fetches.
// ---------------------------------------------------------------------------
router.get('/party', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const partyDocs = await Pokemon.find({
      ownerId: req.user!.userId,
      isInParty: true,
    })
      .lean()
      .sort({ partySlot: 1 });

    // Batch-load species data for all party members
    const speciesIds = partyDocs.map(p => p.speciesId);
    const speciesEntries = await PokedexCache.find({ pokeApiId: { $in: speciesIds } })
      .select('pokeApiId name types baseStats')
      .lean();
    const speciesMap = new Map(speciesEntries.map(s => [s.pokeApiId, s]));

    const enriched = partyDocs.map(p => {
      const species = speciesMap.get(p.speciesId);
      const stats = species ? computeStats(species.baseStats, p.level, p.nature) : null;
      return {
        _id:             p._id,
        speciesId:       p.speciesId,
        nickname:        p.nickname,
        level:           p.level,
        currentHp:       p.currentHp,
        maxHp:           stats?.hp ?? null,
        gender:          p.gender,
        statusCondition: p.statusCondition,
        partySlot:       p.partySlot,
        speciesName:     species?.name ?? null,
        types:           species?.types ?? [],
      };
    });

    res.json({ data: enriched, error: null });
  } catch (err) {
    console.error('Party route error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/pokemon/party/reorder
// Accepts { order: string[] } — an array of pokemon _id strings in the new
// desired slot order. Updates partySlot on each document so slot 1 = index 0,
// slot 2 = index 1, etc. All IDs must belong to this user and be in-party.
// ---------------------------------------------------------------------------
router.patch('/party/reorder', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { order } = req.body as { order: string[] };

    if (!Array.isArray(order) || order.length === 0 || order.length > 6) {
      res.status(400).json({ data: null, error: 'order must be an array of 1–6 pokemon IDs' });
      return;
    }

    // Validate every entry is a real ObjectId before touching the DB
    if (order.some(id => !mongoose.Types.ObjectId.isValid(id))) {
      res.status(400).json({ data: null, error: 'Invalid pokemon ID in order array' });
      return;
    }

    // Confirm all belong to this user and are currently in-party
    const found = await Pokemon.find({
      _id: { $in: order },
      ownerId: req.user!.userId,
      isInParty: true,
    }).select('_id').lean();

    if (found.length !== order.length) {
      res.status(400).json({ data: null, error: 'One or more pokemon not found in your party' });
      return;
    }

    // Write each slot update in parallel — Promise.all fires all queries at once
    await Promise.all(
      order.map((id, index) =>
        Pokemon.updateOne({ _id: id }, { partySlot: index + 1 })
      )
    );

    res.json({ data: { updated: order.length }, error: null });
  } catch (err) {
    console.error('Party reorder error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pokemon/pc
// Returns all pokemon owned by the logged-in player that are NOT in their
// party, enriched with species name and types (same shape as /party).
// ---------------------------------------------------------------------------
router.get('/pc', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const pcDocs = await Pokemon.find({
      ownerId:   req.user!.userId,
      isInParty: false,
    }).lean().sort({ createdAt: 1 }); // stable order: oldest first

    const speciesIds    = pcDocs.map(p => p.speciesId);
    const speciesEntries = await PokedexCache.find({ pokeApiId: { $in: speciesIds } })
      .select('pokeApiId name types baseStats')
      .lean();
    const speciesMap = new Map(speciesEntries.map(s => [s.pokeApiId, s]));

    const enriched = pcDocs.map(p => {
      const species = speciesMap.get(p.speciesId);
      const stats   = species ? computeStats(species.baseStats, p.level, p.nature) : null;
      return {
        _id:             p._id,
        speciesId:       p.speciesId,
        nickname:        p.nickname,
        level:           p.level,
        currentHp:       p.currentHp,
        maxHp:           stats?.hp ?? null,
        gender:          p.gender,
        statusCondition: p.statusCondition,
        speciesName:     species?.name ?? null,
        types:           species?.types ?? [],
      };
    });

    res.json({ data: enriched, error: null });
  } catch (err) {
    console.error('PC route error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/pokemon/party/swap
// Moves a PC pokemon into the party.
//   - If party has fewer than 6: body only needs { pcPokemonId }
//   - If party is full: body needs { pcPokemonId, partyPokemonId } — the two
//     are swapped (party member goes to PC, PC pokemon takes its slot).
// ---------------------------------------------------------------------------
router.post('/party/swap', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { pcPokemonId, partyPokemonId } = req.body as {
      pcPokemonId: string;
      partyPokemonId?: string;
    };

    if (!pcPokemonId || !mongoose.Types.ObjectId.isValid(pcPokemonId)) {
      res.status(400).json({ data: null, error: 'Invalid pcPokemonId' });
      return;
    }

    // Verify the PC pokemon belongs to this user and is actually on PC
    const pcPokemon = await Pokemon.findOne({
      _id:       pcPokemonId,
      ownerId:   req.user!.userId,
      isInParty: false,
    });
    if (!pcPokemon) {
      res.status(404).json({ data: null, error: 'PC Pokémon not found' });
      return;
    }

    if (partyPokemonId) {
      // ── Swap mode: exchange a party member with the PC pokemon ──────────
      if (!mongoose.Types.ObjectId.isValid(partyPokemonId)) {
        res.status(400).json({ data: null, error: 'Invalid partyPokemonId' });
        return;
      }

      const partyPokemon = await Pokemon.findOne({
        _id:       partyPokemonId,
        ownerId:   req.user!.userId,
        isInParty: true,
      });
      if (!partyPokemon) {
        res.status(404).json({ data: null, error: 'Party Pokémon not found' });
        return;
      }

      // Grab the slot before we overwrite it
      const slot = partyPokemon.partySlot;

      // Send party member to PC
      await Pokemon.updateOne(
        { _id: partyPokemonId },
        { isInParty: false, partySlot: null }
      );

      // Move PC pokemon into the vacated slot
      await Pokemon.updateOne(
        { _id: pcPokemonId },
        { isInParty: true, partySlot: slot }
      );
    } else {
      // ── Add mode: party has room, just add ──────────────────────────────
      const partyCount = await Pokemon.countDocuments({
        ownerId:   req.user!.userId,
        isInParty: true,
      });

      if (partyCount >= 6) {
        res.status(400).json({
          data:  null,
          error: 'Party is full. Provide partyPokemonId to swap a member out.',
        });
        return;
      }

      await Pokemon.updateOne(
        { _id: pcPokemonId },
        { isInParty: true, partySlot: partyCount + 1 }
      );
    }

    res.json({ data: { ok: true }, error: null });
  } catch (err) {
    console.error('Party swap error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pokemon/:id
// Returns a single Pokémon with full species data + computed stats.
// Players can only view their own; DM/admin can view any.
// ---------------------------------------------------------------------------
router.get('/:id', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(404).json({ data: null, error: 'Pokémon not found' });
      return;
    }

    const pokemon = await Pokemon.findById(id).lean();
    if (!pokemon) {
      res.status(404).json({ data: null, error: 'Pokémon not found' });
      return;
    }

    const { userId, role } = req.user!;
    if (role === 'player' && pokemon.ownerId.toString() !== userId) {
      res.status(403).json({ data: null, error: 'Forbidden' });
      return;
    }

    const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }).lean();
    if (!species) {
      res.status(404).json({ data: null, error: 'Species data not cached' });
      return;
    }

    // Resolve names for each step in the evolution chain (best-effort from cache)
    const chainIds = species.evolutionChain.map(s => s.speciesId);
    const chainEntries = chainIds.length
      ? await PokedexCache.find({ pokeApiId: { $in: chainIds } })
          .select('pokeApiId name')
          .lean()
      : [];
    const chainNameMap = new Map(chainEntries.map(s => [s.pokeApiId, s.name]));

    const evolutionChainWithNames = species.evolutionChain.map(step => ({
      speciesId: step.speciesId,
      condition: step.condition,
      value:     step.value,
      name:      chainNameMap.get(step.speciesId) ?? null,
    }));

    const stats = computeStats(species.baseStats, pokemon.level, pokemon.nature);

    res.json({
      data: {
        _id:             pokemon._id,
        speciesId:       pokemon.speciesId,
        nickname:        pokemon.nickname,
        level:           pokemon.level,
        exp:             pokemon.exp,
        currentHp:       pokemon.currentHp,
        maxHp:           stats.hp,
        nature:          pokemon.nature,
        gender:          pokemon.gender,
        heldItem:        pokemon.heldItem,
        moves:           pokemon.moves,
        statusCondition: pokemon.statusCondition,
        isInParty:       pokemon.isInParty,
        partySlot:       pokemon.partySlot,
        stats,
        species: {
          name:           species.name,
          types:          species.types,
          baseStats:      species.baseStats,
          abilities:      species.abilities,
          learnableMoves: species.moves,
          evolutionChain: evolutionChainWithNames,
          isLegendary:    species.isLegendary,
          isMythical:     species.isMythical,
        },
      },
      error: null,
    });
  } catch (err) {
    console.error('Pokemon detail route error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

export default router;
