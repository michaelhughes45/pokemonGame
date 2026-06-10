import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Item } from '../models/Item';
import { Campaign } from '../models/Campaign';
import { Npc } from '../models/Npc';
import { Encounter } from '../models/Encounter';
import { Battle } from '../models/Battle';
import { getPocket } from '../lib/itemData';
import { fetchSpecies } from '../lib/pokeapi';
import { computeStats, expForLevel, BaseStats, NATURES } from '../lib/statCalc';
import { canEvolve } from '../lib/evolution';
import { slugToDisplayName } from '../lib/battleCalc';

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
  const { species, level = 5, nature: rawNature = 'random', gender } = req.body as {
    species: string | number;
    level?: number;
    nature?: string;
    gender?: string;
  };

  const nature = rawNature.toLowerCase() === 'random'
    ? NATURES[Math.floor(Math.random() * NATURES.length)]
    : rawNature;

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

  // Always slot into party at the next position
  const partyCount = await Pokemon.countDocuments({ ownerId: user._id, isInParty: true });
  const inParty    = true;
  const partySlot  = partyCount + 1;

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
    exp:       expForLevel(level, (speciesDoc.expGroup as string) || 'medium-fast'),
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
// uses ownerType 'npc' and adds the Pokémon to the NPC's party array.
// Body: { species, level?, nature?, gender? }
// ---------------------------------------------------------------------------
router.post('/npcs/:npcId/pokemon', async (req: Request, res: Response): Promise<void> => {
  const { npcId } = req.params;
  const { species, level = 5, nature: rawNature = 'random', gender } = req.body as {
    species: string | number;
    level?:  number;
    nature?: string;
    gender?: string;
  };

  const nature = rawNature.toLowerCase() === 'random'
    ? NATURES[Math.floor(Math.random() * NATURES.length)]
    : rawNature;

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
    exp:       expForLevel(level, (speciesDoc.expGroup as string) || 'medium-fast'),
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

// ---------------------------------------------------------------------------
// PATCH /api/dm/pokemon/:pokemonId/hidden-ability  — toggle hidden ability on/off
//
// When enabled, resolveMove uses the species' hidden ability slot instead of
// slot 1. Falls back to slot 1 if the species has no hidden ability listed.
// ---------------------------------------------------------------------------
router.patch('/pokemon/:pokemonId/hidden-ability', async (req: Request, res: Response) => {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, req.params.pokemonId as string, res);
  if (!pokemon) return;

  pokemon.hasHiddenAbility = !pokemon.hasHiddenAbility;
  await pokemon.save();
  res.json({
    data: { hasHiddenAbility: pokemon.hasHiddenAbility },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/heal
// Restores every Pokémon in the NPC's party to full HP + PP and clears
// all status conditions. DM only; NPC must belong to the DM's campaign.
// ---------------------------------------------------------------------------
router.post('/npcs/:npcId/heal', async (req: Request, res: Response): Promise<void> => {
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

  const party = await Pokemon.find({ ownerId: new mongoose.Types.ObjectId(npcId as string), ownerType: 'npc' }).lean();
  if (party.length === 0) {
    res.json({ data: { message: 'This NPC has no Pokémon.' }, error: null });
    return;
  }

  const speciesIds = [...new Set(party.map(p => p.speciesId))];
  const caches = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats').lean();
  const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));

  await Promise.all(party.map(poke => {
    const cache    = cacheMap.get(poke.speciesId);
    const maxHp    = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp : poke.currentHp;
    const fullMoves = (poke.moves as { moveId: string; currentPP: number; maxPP: number }[])
      .map(m => ({ ...m, currentPP: m.maxPP }));
    return Pokemon.updateOne(
      { _id: poke._id },
      { $set: { currentHp: maxHp, statusCondition: null, statusCounter: null, volatileStatus: [], moves: fullMoves } },
    );
  }));

  res.json({ data: { message: `${npc.name}'s party has been healed!` }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/dm/npcs/:npcId/bag
// Returns all items in an NPC's bag.
// ---------------------------------------------------------------------------
router.get('/npcs/:npcId/bag', async (req: Request, res: Response): Promise<void> => {
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

  const items = await Item.find(
    { ownerId: new mongoose.Types.ObjectId(npcId as string), ownerType: 'npc' },
  ).lean();

  res.json({ data: items, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/give-item
// Give items to an NPC's bag.
// Body: { itemId, quantity? }
// ---------------------------------------------------------------------------
router.post('/npcs/:npcId/give-item', async (req: Request, res: Response): Promise<void> => {
  const { npcId } = req.params;
  const { itemId, quantity = 1 } = req.body as { itemId: string; quantity?: number };

  if (!mongoose.Types.ObjectId.isValid(npcId as string)) {
    res.status(400).json({ data: null, error: 'Invalid NPC ID' });
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
      data:  null,
      error: `"${itemId}" is not a recognised item. Check the PokeAPI slug (e.g. "super-potion", "poke-ball").`,
    });
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

  const item = await Item.findOneAndUpdate(
    { ownerId: new mongoose.Types.ObjectId(npcId as string), itemId: itemId.trim() },
    {
      $inc:         { quantity },
      $setOnInsert: { pocket, ownerType: 'npc' },
    },
    { upsert: true, new: true },
  );

  res.status(201).json({
    data: { itemId: item.itemId, quantity: item.quantity, pocket: item.pocket },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/fix-pokemon-exp
// One-time migration: bumps any Pokémon whose exp is below their level minimum
// up to expForLevel(level, expGroup). Safe to run multiple times.
// ---------------------------------------------------------------------------
router.post('/fix-pokemon-exp', async (req: Request, res: Response): Promise<void> => {
  const allPokemon = await Pokemon.find({}, '_id speciesId level exp').lean();

  const speciesIds = [...new Set(allPokemon.map(p => p.speciesId))];
  const caches = await PokedexCache.find(
    { pokeApiId: { $in: speciesIds } },
    'pokeApiId expGroup',
  ).lean();
  const expGroupMap = new Map(
    caches.map(c => [c.pokeApiId as number, (c.expGroup as string) || 'medium-fast']),
  );

  let fixed = 0;
  for (const poke of allPokemon) {
    const expGroup = expGroupMap.get(poke.speciesId) ?? 'medium-fast';
    const minExp   = expForLevel(poke.level, expGroup);
    if (poke.exp < minExp) {
      await Pokemon.updateOne({ _id: poke._id }, { $set: { exp: minExp } });
      fixed++;
    }
  }

  res.json({ data: { fixed, total: allPokemon.length }, error: null });
});

// ---------------------------------------------------------------------------
// ENCOUNTER CRUD
// All routes require the DM to have an active campaign. Encounters are scoped
// to that campaign — a DM can only see/edit their own campaign's encounters.
// ---------------------------------------------------------------------------

// Shared helper: fetch the DM's active campaign or send 403.
async function assertDmCampaign(
  dmUserId: string,
  res: Response,
): Promise<{ _id: mongoose.Types.ObjectId; [key: string]: unknown } | null> {
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return null;
  }
  return campaign as { _id: mongoose.Types.ObjectId; [key: string]: unknown };
}

// Shared helper: fetch a specific encounter that belongs to this DM's campaign.
// Sends 400/403/404 and returns null on failure so the caller can early-return.
async function assertDmEncounter(
  dmUserId: string,
  encounterId: string,
  res: Response,
) {
  if (!mongoose.Types.ObjectId.isValid(encounterId)) {
    res.status(400).json({ data: null, error: 'Invalid encounter ID' });
    return null;
  }
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return null;
  }
  const encounter = await Encounter.findOne({
    _id: encounterId,
    campaignId: campaign._id as mongoose.Types.ObjectId,
  }).lean();
  if (!encounter) {
    res.status(404).json({ data: null, error: 'Encounter not found in your campaign' });
    return null;
  }
  return encounter;
}

// ---------------------------------------------------------------------------
// GET /api/dm/encounters
// Returns all encounters for the DM's active campaign.
// ---------------------------------------------------------------------------
router.get('/encounters', async (req: Request, res: Response): Promise<void> => {
  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const encounters = await Encounter.find({ campaignId: campaign._id }).lean();
  res.json({ data: encounters, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/dm/encounters
// Creates a new encounter for the DM's active campaign.
//
// Body:
//   title (string, required)
//   type  ('pve' | 'wild', required)  — 'pvp' reserved for Phase 5
//   enemies        ([{ npcId }], required when type === 'pve')
//   wildPokemon    ([{ speciesId, level, catchable? }], required when type === 'wild')
//   playerPokemonLimit  (number | null, optional)
//   npcPokemonLimit     (number | null, optional)
//   expMultiplier       (number, optional, default 1)
//   notes               (string, optional)
//   isActive            (boolean, optional, default true)
// ---------------------------------------------------------------------------
router.post('/encounters', async (req: Request, res: Response): Promise<void> => {
  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const {
    title,
    type,
    enemies = [],
    wildPokemon = [],
    playerPokemonLimit = null,
    npcPokemonLimit = null,
    expMultiplier = 1,
    notes = '',
    isActive = true,
  } = req.body as {
    title?: string;
    type?: string;
    enemies?: { npcId: string }[];
    wildPokemon?: { speciesId: number; level: number; catchable?: boolean }[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    expMultiplier?: number;
    notes?: string;
    isActive?: boolean;
  };

  // --- Basic validation ---
  if (!title || typeof title !== 'string' || title.trim() === '') {
    res.status(400).json({ data: null, error: 'title is required' });
    return;
  }
  if (!['pve', 'wild'].includes(type ?? '')) {
    res.status(400).json({ data: null, error: "type must be 'pve' or 'wild'" });
    return;
  }
  if (
    playerPokemonLimit !== null &&
    (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'playerPokemonLimit must be a positive integer or null' });
    return;
  }
  if (
    npcPokemonLimit !== null &&
    (!Number.isInteger(npcPokemonLimit) || npcPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'npcPokemonLimit must be a positive integer or null' });
    return;
  }
  if (typeof expMultiplier !== 'number' || expMultiplier <= 0) {
    res.status(400).json({ data: null, error: 'expMultiplier must be a positive number' });
    return;
  }

  // --- Type-specific validation ---
  if (type === 'pve') {
    if (!Array.isArray(enemies) || enemies.length === 0) {
      res.status(400).json({ data: null, error: 'PvE encounters require at least one enemy NPC' });
      return;
    }
    // All npcIds must be valid ObjectIds
    if (!enemies.every(e => mongoose.Types.ObjectId.isValid(e.npcId))) {
      res.status(400).json({ data: null, error: 'All enemy npcIds must be valid' });
      return;
    }
    // All NPCs must belong to this campaign
    const npcIds = enemies.map(e => new mongoose.Types.ObjectId(e.npcId));
    const foundNpcs = await Npc.find(
      { _id: { $in: npcIds }, campaignId: campaign._id },
      '_id',
    ).lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(403).json({ data: null, error: 'One or more NPCs do not belong to your campaign' });
      return;
    }
  }

  if (type === 'wild') {
    if (!Array.isArray(wildPokemon) || wildPokemon.length === 0) {
      res.status(400).json({ data: null, error: 'Wild encounters require at least one wild Pokémon entry' });
      return;
    }
    for (const wp of wildPokemon) {
      if (!Number.isInteger(wp.speciesId) || wp.speciesId < 1) {
        res.status(400).json({ data: null, error: 'Each wildPokemon entry must have a valid speciesId' });
        return;
      }
      if (!Number.isInteger(wp.level) || wp.level < 1 || wp.level > 100) {
        res.status(400).json({ data: null, error: 'Each wildPokemon level must be between 1 and 100' });
        return;
      }
    }
  }

  const encounter = await Encounter.create({
    campaignId:  campaign._id,
    createdByDm: req.user!.userId,
    title:       title.trim(),
    type,
    enemies:     type === 'pve'
      ? enemies.map(e => ({ npcId: new mongoose.Types.ObjectId(e.npcId) }))
      : [],
    wildPokemon: type === 'wild'
      ? wildPokemon.map(wp => ({
          speciesId: wp.speciesId,
          level:     wp.level,
          catchable: wp.catchable ?? true,
        }))
      : [],
    playerPokemonLimit,
    npcPokemonLimit,
    expMultiplier,
    notes,
    isActive,
  });

  res.status(201).json({ data: encounter, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/dm/encounters/:id
// Returns a single encounter by ID (must belong to the DM's campaign).
// ---------------------------------------------------------------------------
router.get('/encounters/:id', async (req: Request, res: Response): Promise<void> => {
  const encounter = await assertDmEncounter(req.user!.userId, req.params.id as string, res);
  if (!encounter) return;

  res.json({ data: encounter, error: null });
});

// ---------------------------------------------------------------------------
// PUT /api/dm/encounters/:id
// Updates an encounter. All fields are optional — only provided fields change.
// Re-runs the same validation rules as POST for any field that is present.
// ---------------------------------------------------------------------------
router.put('/encounters/:id', async (req: Request, res: Response): Promise<void> => {
  const existing = await assertDmEncounter(req.user!.userId, req.params.id as string, res);
  if (!existing) return;

  // We need the full campaign document to validate NPC ownership on type changes
  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const {
    title,
    type,
    enemies,
    wildPokemon,
    playerPokemonLimit,
    npcPokemonLimit,
    expMultiplier,
    notes,
    isActive,
  } = req.body as {
    title?: string;
    type?: string;
    enemies?: { npcId: string }[];
    wildPokemon?: { speciesId: number; level: number; catchable?: boolean }[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    expMultiplier?: number;
    notes?: string;
    isActive?: boolean;
  };

  // Build the resolved type for downstream checks (use incoming or fall back to existing)
  const resolvedType = (type ?? existing.type) as 'pve' | 'wild';

  // Validate each field that was actually provided
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    res.status(400).json({ data: null, error: 'title cannot be empty' });
    return;
  }
  if (type !== undefined && !['pve', 'wild'].includes(type)) {
    res.status(400).json({ data: null, error: "type must be 'pve' or 'wild'" });
    return;
  }
  if (
    playerPokemonLimit !== undefined &&
    playerPokemonLimit !== null &&
    (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'playerPokemonLimit must be a positive integer or null' });
    return;
  }
  if (
    npcPokemonLimit !== undefined &&
    npcPokemonLimit !== null &&
    (!Number.isInteger(npcPokemonLimit) || npcPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'npcPokemonLimit must be a positive integer or null' });
    return;
  }
  if (expMultiplier !== undefined && (typeof expMultiplier !== 'number' || expMultiplier <= 0)) {
    res.status(400).json({ data: null, error: 'expMultiplier must be a positive number' });
    return;
  }

  // Validate NPC list if enemies are being changed and encounter is (or will be) PvE
  if (enemies !== undefined && resolvedType === 'pve') {
    if (!Array.isArray(enemies) || enemies.length === 0) {
      res.status(400).json({ data: null, error: 'PvE encounters require at least one enemy NPC' });
      return;
    }
    if (!enemies.every(e => mongoose.Types.ObjectId.isValid(e.npcId))) {
      res.status(400).json({ data: null, error: 'All enemy npcIds must be valid' });
      return;
    }
    const npcIds = enemies.map(e => new mongoose.Types.ObjectId(e.npcId));
    const foundNpcs = await Npc.find(
      { _id: { $in: npcIds }, campaignId: campaign._id },
      '_id',
    ).lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(403).json({ data: null, error: 'One or more NPCs do not belong to your campaign' });
      return;
    }
  }

  // Validate wild Pokémon if being changed and encounter is (or will be) wild
  if (wildPokemon !== undefined && resolvedType === 'wild') {
    if (!Array.isArray(wildPokemon) || wildPokemon.length === 0) {
      res.status(400).json({ data: null, error: 'Wild encounters require at least one wild Pokémon entry' });
      return;
    }
    for (const wp of wildPokemon) {
      if (!Number.isInteger(wp.speciesId) || wp.speciesId < 1) {
        res.status(400).json({ data: null, error: 'Each wildPokemon entry must have a valid speciesId' });
        return;
      }
      if (!Number.isInteger(wp.level) || wp.level < 1 || wp.level > 100) {
        res.status(400).json({ data: null, error: 'Each wildPokemon level must be between 1 and 100' });
        return;
      }
    }
  }

  // Build the $set payload — only include fields that were provided
  const update: Record<string, unknown> = {};
  if (title      !== undefined) update.title      = title.trim();
  if (type       !== undefined) update.type        = type;
  if (isActive   !== undefined) update.isActive    = isActive;
  if (notes      !== undefined) update.notes       = notes;
  if (expMultiplier  !== undefined) update.expMultiplier  = expMultiplier;
  if (playerPokemonLimit !== undefined) update.playerPokemonLimit = playerPokemonLimit;
  if (npcPokemonLimit    !== undefined) update.npcPokemonLimit    = npcPokemonLimit;
  if (enemies !== undefined && resolvedType === 'pve') {
    update.enemies = enemies.map(e => ({ npcId: new mongoose.Types.ObjectId(e.npcId) }));
  }
  if (wildPokemon !== undefined && resolvedType === 'wild') {
    update.wildPokemon = wildPokemon.map(wp => ({
      speciesId: wp.speciesId,
      level:     wp.level,
      catchable: wp.catchable ?? true,
    }));
  }

  const updated = await Encounter.findByIdAndUpdate(
    existing._id,
    { $set: update },
    { new: true },
  ).lean();

  res.json({ data: updated, error: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/dm/encounters/:id
// Deletes an encounter (must belong to the DM's campaign).
// Does not delete any Battles that were launched from this encounter —
// those remain for historical reference.
// ---------------------------------------------------------------------------
router.delete('/encounters/:id', async (req: Request, res: Response): Promise<void> => {
  const encounter = await assertDmEncounter(req.user!.userId, req.params.id as string, res);
  if (!encounter) return;

  await Encounter.deleteOne({ _id: encounter._id });
  res.json({ data: { message: 'Encounter deleted' }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/dm/encounters/:id/launch
// Creates a Battle document from an encounter template and returns the new
// battle's ID so the DM can redirect to /battle/:id.
//
// Body: { playerIds: string[] }  — which campaign players join this battle
//
// PvE logic:
//   For each NPC in encounter.enemies, enemySide gets slotCount slots (or
//   playerIds.length if slotCount is null) all pointing to the same npcId
//   (activePokemonId: null). The DM sends out a different party Pokémon into
//   each slot via dm-send-out with a slotIndex param.
//
//   Example: 3 players + 1 NPC (slotCount null) → 3 enemySide entries.
//   Example: 3 players + 1 NPC (slotCount 7)    → 7 enemySide entries.
//   Example: 3 players + 2 NPCs (slotCount null) → 6 enemySide entries (3 per NPC).
//
// The encounter's playerPokemonLimit and npcPokemonLimit are carried into the
// Battle document. encounterId is set so the battle can be traced back.
// ---------------------------------------------------------------------------
router.post('/encounters/:id/launch', async (req: Request, res: Response): Promise<void> => {
  const encounter = await assertDmEncounter(req.user!.userId, req.params.id as string, res);
  if (!encounter) return;

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const { playerIds } = req.body as { playerIds?: string[] };

  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    res.status(400).json({ data: null, error: 'playerIds must be a non-empty array' });
    return;
  }
  if (!playerIds.every(id => mongoose.Types.ObjectId.isValid(id))) {
    res.status(400).json({ data: null, error: 'All playerIds must be valid ObjectIds' });
    return;
  }

  // All players must be members of this campaign
  const campaignPlayerStrings = (campaign.playerIds as mongoose.Types.ObjectId[]).map(id => id.toString());
  const outsiders = playerIds.filter(id => !campaignPlayerStrings.includes(id));
  if (outsiders.length > 0) {
    res.status(400).json({
      data:  null,
      error: `These player IDs are not in your campaign: ${outsiders.join(', ')}`,
    });
    return;
  }

  // --- Build enemySide ---
  // PvE: each NPC gets one slot per player (N slots, same npcId, activePokemonId null)
  type EnemySlot = {
    npcId?: mongoose.Types.ObjectId;
    activePokemonId: mongoose.Types.ObjectId | null;
    fainted: mongoose.Types.ObjectId[];
  };

  let enemySide: EnemySlot[] = [];

  if (encounter.type === 'pve') {
    const enemies = encounter.enemies as Array<{ npcId: mongoose.Types.ObjectId; slotCount: number | null }>;
    if (enemies.length === 0) {
      res.status(400).json({ data: null, error: 'This encounter has no NPCs configured' });
      return;
    }
    // Verify all NPCs still exist in the campaign (they may have been deleted since creation)
    const npcIds = enemies.map(e => e.npcId);
    const foundNpcs = await Npc.find(
      { _id: { $in: npcIds }, campaignId: campaign._id },
      '_id',
    ).lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(400).json({ data: null, error: 'One or more NPCs in this encounter no longer exist' });
      return;
    }

    // One slot per configured slotCount (or per player if slotCount is null) for each NPC
    for (const enemy of enemies) {
      const slots = enemy.slotCount ?? playerIds.length;
      for (let i = 0; i < slots; i++) {
        enemySide.push({
          npcId:           new mongoose.Types.ObjectId(enemy.npcId.toString()),
          activePokemonId: null,
          fainted:         [],
        });
      }
    }
  } else if (encounter.type === 'wild') {
    const wildEntries = encounter.wildPokemon as Array<{
      speciesId: number;
      level: number;
      catchable: boolean;
    }>;
    if (wildEntries.length === 0) {
      res.status(400).json({ data: null, error: 'This encounter has no wild Pokémon configured' });
      return;
    }

    // Generate one wild Pokémon document per entry and create one enemySide slot
    for (const wp of wildEntries) {
      // Fetch species from cache; fall back to PokeAPI on first encounter
      let species = await PokedexCache.findOne({ pokeApiId: wp.speciesId }).lean();
      if (!species) {
        try {
          const fetched = await fetchSpecies(wp.speciesId);
          const created = await PokedexCache.create(fetched);
          species = created.toObject();
        } catch {
          res.status(400).json({ data: null, error: `Species #${wp.speciesId} not found` });
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

      // Last 4 moves learnable at or below the target level
      const learnable = ((species.levelUpMoves ?? []) as Array<{ moveId: string; level: number }>)
        .filter(m => m.level <= wp.level)
        .slice(-4);
      const moveList = ((species.moves ?? []) as Array<{ name: string; pp: number | null }>);
      const moves = learnable.map(m => {
        const md = moveList.find(mv => mv.name === m.moveId);
        const pp = md?.pp ?? 5;
        return { moveId: m.moveId, currentPP: pp, maxPP: pp };
      });

      const stats = computeStats(species.baseStats as BaseStats, wp.level, nature);

      const wildPoke = await Pokemon.create({
        speciesId:          species.pokeApiId,
        // DM's userId as ownerId — same convention as POST /api/battles wild creation
        ownerId:            new mongoose.Types.ObjectId(req.user!.userId),
        ownerType:          'wild',
        nickname:           null,
        level:              wp.level,
        exp:                expForLevel(wp.level, (species.expGroup as string) || 'medium-fast'),
        currentHp:          stats.hp,
        nature,
        gender,
        heldItem:           null,
        moves,
        evs:                { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
        statusCondition:    null,
        statusCounter:      null,
        volatileStatus:     [],
        evolutionOverrides: [],
        isInParty:          false,
        partySlot:          null,
        caughtAt:           null,
        caughtByPlayerId:   null,
      });

      enemySide.push({
        activePokemonId: wildPoke._id as mongoose.Types.ObjectId,
        fainted:         [],
      });
    }
  }

  const battle = await Battle.create({
    campaignId: campaign._id,
    type:       encounter.type,
    status:     'waiting',
    phase:      'move_submission',
    playerSide: playerIds.map(id => ({
      userId:          new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      usedPokemonIds:  [],
      fainted:         [],
    })),
    enemySide,
    // Wild: catchable if any entry has catchable:true. PvE: always false.
    wildCatchable: encounter.type === 'wild'
      ? (encounter.wildPokemon as Array<{ catchable: boolean }>).some(wp => wp.catchable)
      : false,
    playerPokemonLimit: encounter.playerPokemonLimit ?? null,
    npcPokemonLimit:    encounter.npcPokemonLimit    ?? null,
    encounterId:        encounter._id,
    lastUpdatedAt:      new Date(),
  });

  res.status(201).json({
    data:  { battleId: battle._id, type: battle.type, status: battle.status },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/pokemon/:pokemonId/award-exp
// Awards a specific EXP amount to a campaign player's Pokémon, running the
// full level-up and evolution chain exactly as distributeExp does.
// Body: { exp: number }
// ---------------------------------------------------------------------------
router.post('/pokemon/:pokemonId/award-exp', async (req: Request, res: Response): Promise<void> => {
  const { pokemonId } = req.params;
  const { exp: expGain } = req.body as { exp?: number };

  if (typeof expGain !== 'number' || !Number.isInteger(expGain) || expGain <= 0) {
    res.status(400).json({ data: null, error: 'exp must be a positive integer' });
    return;
  }

  const pokemon = await assertDmOwnsPokemon(req.user!.userId, pokemonId as string, res);
  if (!pokemon) return;

  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
    .select('name expGroup baseStats')
    .lean();
  if (!cache) {
    res.status(400).json({ data: null, error: 'Species data not found in cache.' });
    return;
  }

  const displayName = pokemon.nickname ?? slugToDisplayName(cache.name as string);
  const events: string[] = [`${displayName} gained ${expGain} EXP!`];

  const newExp      = (pokemon.exp as number) + expGain;
  let newLevel      = pokemon.level as number;
  let newHp         = pokemon.currentHp as number;
  let newSpeciesId  = pokemon.speciesId as number;
  const expGroup    = (cache.expGroup as string) || 'medium-fast';
  const baseStats   = cache.baseStats as BaseStats | undefined;
  const overrides   = (pokemon.evolutionOverrides ?? []) as { condition: string; value: string }[];

  while (newLevel < 100 && newExp >= expForLevel(newLevel + 1, expGroup)) {
    if (baseStats && newHp > 0) {
      const oldMaxHp = computeStats(baseStats, newLevel, pokemon.nature as string).hp;
      newLevel += 1;
      const newMaxHp = computeStats(baseStats, newLevel, pokemon.nature as string).hp;
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
        } catch { /* leave null — name falls back */ }
      }
      if (evolvedCache?.baseStats) {
        newHp = computeStats(evolvedCache.baseStats as BaseStats, newLevel, pokemon.nature as string).hp;
      }
      const evolvedName = evolvedCache ? slugToDisplayName(evolvedCache.name as string) : 'a new form';
      events.push(`${displayName} evolved into ${evolvedName}!`);
      newSpeciesId = evolveIntoId;
    }
  }

  await Pokemon.updateOne(
    { _id: pokemon._id },
    { $set: { exp: newExp, level: newLevel, currentHp: newHp, speciesId: newSpeciesId } },
  );

  res.json({ data: { events, level: newLevel, exp: newExp, speciesId: newSpeciesId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/dm/pokemon/:pokemonId/level-up
// Increments a campaign player's Pokémon by one level (Rare Candy equivalent).
// Adjusts currentHp by the maxHp delta and checks for evolution.
// ---------------------------------------------------------------------------
router.post('/pokemon/:pokemonId/level-up', async (req: Request, res: Response): Promise<void> => {
  const { pokemonId } = req.params;

  const pokemon = await assertDmOwnsPokemon(req.user!.userId, pokemonId as string, res);
  if (!pokemon) return;

  if ((pokemon.level as number) >= 100) {
    res.status(400).json({ data: null, error: 'That Pokémon is already at level 100.' });
    return;
  }

  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
    .select('name baseStats evolutionChain')
    .lean();
  if (!cache) {
    res.status(400).json({ data: null, error: 'Species data not found in cache.' });
    return;
  }

  const displayName = pokemon.nickname ?? slugToDisplayName(cache.name as string);
  const events: string[] = [];
  const baseStats = cache.baseStats as BaseStats | undefined;

  if (baseStats) {
    const oldMaxHp = computeStats(baseStats, pokemon.level as number, pokemon.nature as string).hp;
    pokemon.level = (pokemon.level as number) + 1;
    const newMaxHp = computeStats(baseStats, pokemon.level as number, pokemon.nature as string).hp;
    pokemon.currentHp = (pokemon.currentHp as number) + (newMaxHp - oldMaxHp);
  } else {
    pokemon.level = (pokemon.level as number) + 1;
  }

  events.push(`${displayName} grew to level ${pokemon.level}!`);

  const overrides = (pokemon.evolutionOverrides ?? []) as { condition: string; value: string }[];
  const evolveIntoId = await canEvolve({
    speciesId:          pokemon.speciesId as number,
    level:              pokemon.level as number,
    evolutionOverrides: overrides,
  });
  if (evolveIntoId !== null) {
    pokemon.speciesId = evolveIntoId;
    let evolvedCache = await PokedexCache.findOne({ pokeApiId: evolveIntoId }).select('name baseStats').lean();
    if (!evolvedCache) {
      try {
        const fetched = await fetchSpecies(evolveIntoId);
        const created = await PokedexCache.create(fetched);
        evolvedCache = created.toObject();
      } catch { /* leave null */ }
    }
    if (evolvedCache?.baseStats) {
      pokemon.currentHp = computeStats(evolvedCache.baseStats as BaseStats, pokemon.level as number, pokemon.nature as string).hp;
    }
    const evolvedName = evolvedCache ? slugToDisplayName(evolvedCache.name as string) : 'a new form';
    events.push(`${displayName} evolved into ${evolvedName}!`);
  }

  await pokemon.save();

  res.json({ data: { events, level: pokemon.level, exp: pokemon.exp, speciesId: pokemon.speciesId }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/dm/players/:username/roster
// Returns all Pokémon owned by a campaign player, split into party and PC,
// each enriched with species name, maxHp, and EXP progress fields.
// ---------------------------------------------------------------------------
router.get('/players/:username/roster', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const user = await assertCampaignPlayer(req.user!.userId, username as string, res);
  if (!user) return;

  const pokemons = await Pokemon.find({ ownerId: user._id, ownerType: 'player' })
    .select('speciesId nickname level exp currentHp nature gender statusCondition heldItem isInParty partySlot')
    .lean();

  if (pokemons.length === 0) {
    res.json({ data: { party: [], pc: [] }, error: null });
    return;
  }

  const uniqueSpeciesIds = [...new Set(pokemons.map(p => p.speciesId as number))];
  const speciesDocs = await PokedexCache.find({ pokeApiId: { $in: uniqueSpeciesIds } })
    .select('pokeApiId name baseStats expGroup')
    .lean();
  const speciesMap = new Map(speciesDocs.map(s => [s.pokeApiId as number, s]));

  const enriched = pokemons.map(poke => {
    const species = speciesMap.get(poke.speciesId as number);
    const expGroup = (species?.expGroup as string) || 'medium-fast';
    const baseStats = species?.baseStats as BaseStats | undefined;
    const maxHp = baseStats ? computeStats(baseStats, poke.level as number, poke.nature as string).hp : 0;

    return {
      _id:               poke._id,
      speciesId:         poke.speciesId,
      speciesName:       species?.name ?? `#${poke.speciesId}`,
      nickname:          poke.nickname,
      level:             poke.level,
      exp:               poke.exp,
      expForCurrentLevel: expForLevel(poke.level as number, expGroup),
      expForNextLevel:   (poke.level as number) >= 100 ? null : expForLevel((poke.level as number) + 1, expGroup),
      currentHp:         poke.currentHp,
      maxHp,
      nature:            poke.nature,
      gender:            poke.gender,
      statusCondition:   poke.statusCondition,
      heldItem:          poke.heldItem,
      isInParty:         poke.isInParty,
      partySlot:         poke.partySlot,
    };
  });

  const party = enriched
    .filter(p => p.isInParty)
    .sort((a, b) => ((a.partySlot as number) ?? 99) - ((b.partySlot as number) ?? 99));
  const pc = enriched.filter(p => !p.isInParty);

  res.json({ data: { party, pc }, error: null });
});

export default router;
