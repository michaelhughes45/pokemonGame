import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Item } from '../models/Item';
import { Campaign } from '../models/Campaign';
import { Npc } from '../models/Npc';
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

// ---------------------------------------------------------------------------
// GET /api/dm/npcs
// Returns all NPCs belonging to the DM's active campaign.
// ---------------------------------------------------------------------------
router.get('/npcs', async (req: Request, res: Response): Promise<void> => {
  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.json({ data: [], error: null });
    return;
  }

  const npcs = await Npc.find({ campaignId: campaign._id })
    .select('name type party')
    .lean();

  res.json({
    data: npcs.map(n => ({
      _id:        n._id,
      name:       n.name,
      type:       n.type,
      partyCount: n.party.length,
    })),
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/npcs
// Creates a new NPC in the DM's active campaign.
// Body: { name, type? }
// ---------------------------------------------------------------------------
router.post('/npcs', async (req: Request, res: Response): Promise<void> => {
  const { name, type = 'trainer' } = req.body as { name: string; type?: string };

  if (!name?.trim()) {
    res.status(400).json({ data: null, error: 'name is required' });
    return;
  }
  if (!['trainer', 'wild'].includes(type)) {
    res.status(400).json({ data: null, error: "type must be 'trainer' or 'wild'" });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const npc = await Npc.create({
    campaignId:  campaign._id,
    createdByDm: req.user!.userId,
    name:        name.trim(),
    type,
    party:       [],
    aiStrategy:  'random',
  });

  res.status(201).json({
    data:  { _id: npc._id, name: npc.name, type: npc.type, partyCount: 0 },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/pokemon
// Gives a Pokémon to an NPC. Mirrors the player give-pokemon endpoint but
// uses ownerType 'npc' and adds the Pokémon to the NPC's party array (max 12).
// Body: { species, level?, nature?, gender? }
// ---------------------------------------------------------------------------
router.post('/npcs/:npcId/pokemon', async (req: Request, res: Response): Promise<void> => {
  const { npcId } = req.params;
  const { species, level = 5, nature = 'Hardy', gender } = req.body as {
    species: string | number;
    level?:  number;
    nature?: string;
    gender?: string;
  };

  if (!mongoose.Types.ObjectId.isValid(npcId as string)) {
    res.status(400).json({ data: null, error: 'Invalid NPC ID' });
    return;
  }
  if (!species && species !== 0) {
    res.status(400).json({ data: null, error: 'species is required (name or dex number)' });
    return;
  }
  if (!VALID_NATURES.includes(nature)) {
    res.status(400).json({ data: null, error: `Invalid nature. Valid values: ${VALID_NATURES.join(', ')}` });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const npc = await Npc.findOne({ _id: npcId, campaignId: campaign._id });
  if (!npc) {
    res.status(404).json({ data: null, error: 'NPC not found in your campaign' });
    return;
  }
  if (npc.party.length >= 12) {
    res.status(400).json({ data: null, error: 'NPC party is full (max 12)' });
    return;
  }

  const isNumeric  = /^\d+$/.test(String(species));
  const lookupQuery = isNumeric ? { pokeApiId: Number(species) } : { name: String(species).toLowerCase() };
  const fetchKey   = isNumeric ? Number(species) : String(species).toLowerCase();

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
      (speciesDoc as any).levelUpMoves = transformed.levelUpMoves;
    } catch {
      // non-fatal
    }
  }

  type LevelUpMoveEntry = { moveId: string; level: number };
  type MoveEntry        = { name: string; pp: number | null };
  const levelUpMoves = (speciesDoc.levelUpMoves ?? []) as LevelUpMoveEntry[];
  const moveEntries  = (speciesDoc.moves ?? [])        as MoveEntry[];

  const maxHp = Math.floor((2 * speciesDoc.baseStats.hp * level) / 100) + level + 10;

  let resolvedGender: 'male' | 'female' | 'none';
  if (gender === 'male' || gender === 'female' || gender === 'none') {
    resolvedGender = gender;
  } else if (speciesDoc.genderRatio === -1) {
    resolvedGender = 'none';
  } else if (speciesDoc.genderRatio === 0) {
    resolvedGender = 'female';
  } else {
    resolvedGender = 'male';
  }

  const moveDetailMap = new Map(moveEntries.map(m => [m.name, m]));
  const moves = levelUpMoves
    .filter(m => m.level <= level && m.level > 0)
    .slice(-4)
    .map(entry => {
      const detail = moveDetailMap.get(entry.moveId);
      return { moveId: entry.moveId, currentPP: detail?.pp ?? 10, maxPP: detail?.pp ?? 10 };
    });

  const npcObjectId = new mongoose.Types.ObjectId(npcId as string);

  const pokemon = await Pokemon.create({
    speciesId: speciesDoc.pokeApiId,
    ownerId:   npcObjectId,
    ownerType: 'npc',
    nickname:  null,
    level,
    exp:       0,
    currentHp: maxHp,
    nature,
    gender:    resolvedGender,
    heldItem:  null,
    moves,
    isInParty: true,
    partySlot: null,
  });

  npc.party.push(pokemon._id);
  await npc.save();

  res.status(201).json({
    data: {
      _id:         pokemon._id,
      speciesId:   pokemon.speciesId,
      speciesName: speciesDoc.name,
      level:       pokemon.level,
      nature:      pokemon.nature,
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/dm/npcs/:npcId/party
// Returns the full party Pokémon list for an NPC, including moves, so the
// DM can select which Pokémon to send out and which move to submit.
// ---------------------------------------------------------------------------
router.get('/npcs/:npcId/party', async (req: Request, res: Response): Promise<void> => {
  const { npcId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(npcId as string)) {
    res.status(400).json({ data: null, error: 'Invalid NPC ID' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const npc = await Npc.findOne({ _id: npcId, campaignId: campaign._id }).lean();
  if (!npc) {
    res.status(404).json({ data: null, error: 'NPC not found in your campaign' });
    return;
  }

  const pokemons = await Pokemon.find(
    { ownerId: new mongoose.Types.ObjectId(npcId as string), ownerType: 'npc' },
    'speciesId nickname level currentHp nature moves'
  ).lean();

  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name').lean()
    : [];
  const nameMap = new Map(caches.map(c => [c.pokeApiId as number, c.name]));

  res.json({
    data: pokemons.map(p => ({
      _id:         p._id,
      speciesId:   p.speciesId,
      speciesName: nameMap.get(p.speciesId) ?? `#${p.speciesId}`,
      nickname:    p.nickname,
      level:       p.level,
      currentHp:   p.currentHp,
      moves:       p.moves,
    })),
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Evolution overrides
// POST   /api/dm/pokemon/:pokemonId/evolution-override  — prevent evolution
// DELETE /api/dm/pokemon/:pokemonId/evolution-override  — lift the override
//
// The DM can block a player's Pokémon from auto-evolving on level-up.
// Ownership is verified by confirming the Pokémon's owner is a player in
// the DM's active campaign.
// ---------------------------------------------------------------------------

async function assertDmOwnsPokemon(
  dmUserId: string,
  pokemonId: string,
  res: Response,
) {
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return null;
  }

  if (!mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Invalid Pokémon ID' });
    return null;
  }

  const pokemon = await Pokemon.findById(pokemonId);
  if (!pokemon || pokemon.ownerType !== 'player') {
    res.status(404).json({ data: null, error: 'Pokémon not found' });
    return null;
  }

  const playerIds = (campaign.playerIds as mongoose.Types.ObjectId[]).map(id => id.toString());
  if (!playerIds.includes(pokemon.ownerId.toString())) {
    res.status(403).json({ data: null, error: 'That Pokémon does not belong to a player in your campaign' });
    return null;
  }

  return pokemon;
}

router.post('/pokemon/:pokemonId/evolution-override', async (req: Request, res: Response) => {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, req.params.pokemonId as string, res);
  if (!pokemon) return;

  const alreadyPrevented = pokemon.evolutionOverrides.some(o => o.condition === 'prevent');
  if (alreadyPrevented) {
    res.json({ data: { message: 'Evolution is already blocked for this Pokémon' }, error: null });
    return;
  }

  pokemon.evolutionOverrides.push({ condition: 'prevent', value: '' });
  await pokemon.save();
  res.json({ data: { message: 'Evolution blocked' }, error: null });
});

router.delete('/pokemon/:pokemonId/evolution-override', async (req: Request, res: Response) => {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, req.params.pokemonId as string, res);
  if (!pokemon) return;

  const before = pokemon.evolutionOverrides.length;
  pokemon.evolutionOverrides = pokemon.evolutionOverrides.filter(o => o.condition !== 'prevent') as typeof pokemon.evolutionOverrides;
  if (pokemon.evolutionOverrides.length === before) {
    res.json({ data: { message: 'No evolution block was set' }, error: null });
    return;
  }

  await pokemon.save();
  res.json({ data: { message: 'Evolution block lifted' }, error: null });
});

export default router;
