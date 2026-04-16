import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Item } from '../models/Item';
import { Campaign } from '../models/Campaign';
import { getPocket } from '../lib/itemData';
import { fetchSpecies } from '../lib/pokeapi';

const router = Router();

// ---------------------------------------------------------------------------
// assertCampaignPlayer
// Shared guard used by all DM routes that target a specific player.
// Checks:
//   1. The DM has an active campaign.
//   2. The target username exists.
//   3. The target player is a member of that campaign.
// Returns the target user document on success, or sends a 403/404 and returns
// null so the calling route can do an early return.
// ---------------------------------------------------------------------------
async function assertCampaignPlayer(
  dmUserId: string,
  username: string,
  res: Response
): Promise<{ _id: mongoose.Types.ObjectId; [key: string]: unknown } | null> {
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return null;
  }

  const target = await User.findOne({ username }).lean();
  if (!target) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return null;
  }

  const targetId = (target._id as mongoose.Types.ObjectId).toString();
  const inCampaign = campaign.playerIds.some(id => id.toString() === targetId);
  if (!inCampaign) {
    res.status(403).json({ data: null, error: `"${username}" is not in your campaign` });
    return null;
  }

  return target as { _id: mongoose.Types.ObjectId; [key: string]: unknown };
}

// DELETE /api/dm/players/:username/starter
// Deletes all Pokémon belonging to the player so they can pick a new starter.
// Accessible to DM and admin (requireDm middleware is applied in index.ts).
router.delete('/players/:username/starter', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const user = await assertCampaignPlayer(req.user!.userId, username as string, res);
  if (!user) return;

  const result = await Pokemon.deleteMany({ ownerId: user._id });

  res.json({
    data: { deleted: result.deletedCount, username },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/players/:username/pokemon
// DM gives a Pokémon directly to a player. Goes into party if there's space
// (fewer than 6), otherwise goes to PC.
// Body: { species, level?, nature?, gender? }
//   species — national dex number (e.g. 25) OR name (e.g. "pikachu")
// ---------------------------------------------------------------------------

const VALID_NATURES = [
  'Hardy','Lonely','Brave','Adamant','Naughty',
  'Bold','Relaxed','Impish','Lax',
  'Timid','Hasty','Jolly','Naive',
  'Modest','Mild','Quiet','Rash',
  'Calm','Gentle','Sassy','Careful',
  'Docile','Serious','Bashful','Quirky',
];

router.post('/players/:username/pokemon', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const { species, level = 5, nature = 'Hardy', gender } = req.body as {
    species: string | number;
    level?: number;
    nature?: string;
    gender?: string;
  };

  if (!species && species !== 0) {
    res.status(400).json({ data: null, error: 'species is required (name or dex number)' });
    return;
  }
  if (!VALID_NATURES.includes(nature)) {
    res.status(400).json({ data: null, error: `Invalid nature. Valid values: ${VALID_NATURES.join(', ')}` });
    return;
  }

  const user = await assertCampaignPlayer(req.user!.userId, username as string, res);
  if (!user) return;

  // Determine whether the DM passed a numeric ID or a name string
  const isNumeric = /^\d+$/.test(String(species));
  const lookupQuery = isNumeric
    ? { pokeApiId: Number(species) }
    : { name: String(species).toLowerCase() };
  const fetchKey = isNumeric ? Number(species) : String(species).toLowerCase();

  // Look up species in cache. If missing, fetch from PokeAPI and cache it now.
  // If cached but predates the levelUpMoves field, refresh that field so the
  // Pokémon gets the correct starting moves.
  let speciesDoc = await PokedexCache.findOne(lookupQuery).lean();
  if (!speciesDoc) {
    try {
      const transformed = await fetchSpecies(fetchKey);
      speciesDoc = (await PokedexCache.create(transformed)).toObject();
    } catch {
      res.status(404).json({ data: null, error: `Species "${species}" not found in PokeAPI.` });
      return;
    }
  } else if (!speciesDoc.levelUpMoves?.length) {
    try {
      const transformed = await fetchSpecies(fetchKey);
      await PokedexCache.updateOne(
        { pokeApiId: transformed.pokeApiId },
        { $set: { levelUpMoves: transformed.levelUpMoves } }
      );
      // Cast to any to avoid Mongoose DocumentArray vs plain array type mismatch.
      // lean() already returns plain objects at runtime — this is purely a TS annotation issue.
      (speciesDoc as any).levelUpMoves = transformed.levelUpMoves;
    } catch {
      // Refresh failed — Pokémon will be created without moves, not fatal
    }
  }

  // Extract the data we need as plain typed locals so we don't fight Mongoose's
  // complex inferred types (DocumentArray, Subdocument, etc.) throughout the function.
  type LevelUpMoveEntry = { moveId: string; level: number };
  type MoveEntry        = { name: string; pp: number | null };
  const levelUpMoves = (speciesDoc.levelUpMoves ?? []) as LevelUpMoveEntry[];
  const moveEntries  = (speciesDoc.moves ?? [])        as MoveEntry[];

  // Gen 3+ HP formula (no IVs/EVs until Phase 5)
  const maxHp = Math.floor((2 * speciesDoc.baseStats.hp * level) / 100) + level + 10;

  // Resolve gender: use provided value, or derive from genderRatio in species data
  let resolvedGender: 'male' | 'female' | 'none';
  if (gender === 'male' || gender === 'female' || gender === 'none') {
    resolvedGender = gender;
  } else if (speciesDoc.genderRatio === -1) {
    resolvedGender = 'none';   // genderless species (Magnemite, etc.)
  } else if (speciesDoc.genderRatio === 0) {
    resolvedGender = 'female'; // always female (Chansey, etc.)
  } else {
    resolvedGender = 'male';
  }

  // Slot into party if there's room, otherwise send to PC
  const partyCount = await Pokemon.countDocuments({ ownerId: user._id, isInParty: true });
  const inParty   = partyCount < 6;
  const partySlot = inParty ? partyCount + 1 : null;

  // Last 4 moves the Pokémon would have learned by this level, most recent first.
  // levelUpMoves is sorted ascending by level, so .slice(-4) grabs the most recent 4.
  const moveDetailMap = new Map(moveEntries.map(m => [m.name, m]));
  const moves = levelUpMoves
    .filter(m => m.level <= level && m.level > 0)
    .slice(-4)
    .map(entry => {
      const detail = moveDetailMap.get(entry.moveId);
      return {
        moveId:    entry.moveId,
        currentPP: detail?.pp ?? 10,
        maxPP:     detail?.pp ?? 10,
      };
    });

  const pokemon = await Pokemon.create({
    speciesId: speciesDoc.pokeApiId,
    ownerId:   user._id,
    ownerType: 'player',
    nickname:  null,
    level,
    exp:       0,
    currentHp: maxHp,
    nature,
    gender:    resolvedGender,
    heldItem:  null,
    moves,
    isInParty: inParty,
    partySlot,
  });

  res.status(201).json({
    data: {
      _id:         pokemon._id,
      speciesId:   pokemon.speciesId,
      speciesName: speciesDoc.name,
      level:       pokemon.level,
      nature:      pokemon.nature,
      gender:      pokemon.gender,
      isInParty:   pokemon.isInParty,
      partySlot:   pokemon.partySlot,
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/items/give
// Give items directly to a player's bag.
// Body: { username, itemId, quantity? }
//   itemId   — PokeAPI slug, e.g. "super-potion"
//   quantity — how many to add (default 1)
//
// The pocket is derived automatically from the item ID so the DM doesn't
// need to know or specify it. Returns 400 for unrecognised item IDs.
// Uses upsert so giving an item the player already has just increments
// their existing stack.
// ---------------------------------------------------------------------------
router.post('/items/give', async (req: Request, res: Response): Promise<void> => {
  const { username, itemId, quantity = 1 } = req.body as {
    username:  string;
    itemId:    string;
    quantity?: number;
  };

  if (!username?.trim()) {
    res.status(400).json({ data: null, error: 'username is required' });
    return;
  }
  if (!itemId?.trim()) {
    res.status(400).json({ data: null, error: 'itemId is required' });
    return;
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    res.status(400).json({ data: null, error: 'quantity must be an integer between 1 and 99' });
    return;
  }

  const pocket = getPocket(itemId.trim());
  if (!pocket) {
    res.status(400).json({
      data: null,
      error: `"${itemId}" is not a recognised item. Check the PokeAPI slug (e.g. "super-potion", "poke-ball").`,
    });
    return;
  }

  const user = await assertCampaignPlayer(req.user!.userId, username.trim(), res);
  if (!user) return;

  const item = await Item.findOneAndUpdate(
    { ownerId: user._id, itemId: itemId.trim() },
    {
      $inc:         { quantity },
      $setOnInsert: { pocket },
    },
    { upsert: true, new: true }
  );

  res.status(201).json({
    data: {
      itemId:   item.itemId,
      quantity: item.quantity,
      pocket:   item.pocket,
      username,
    },
    error: null,
  });
});

export default router;
