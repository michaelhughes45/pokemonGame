import { Router, Request, Response } from 'express';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';

const router = Router();

// DELETE /api/dm/players/:username/starter
// Deletes all Pokémon belonging to the player so they can pick a new starter.
// Accessible to DM and admin (requireDm middleware is applied in index.ts).
router.delete('/players/:username/starter', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const user = await User.findOne({ username }).lean();
  if (!user) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return;
  }

  const result = await Pokemon.deleteMany({ ownerId: user._id });

  res.json({
    data: { deleted: result.deletedCount, username },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dm/players/:username/pokemon
// DM gives a Pokémon directly to a player. Goes into party if there's space
// (fewer than 6), otherwise goes to PC. Species must already be in the
// Pokédex cache — have the player or DM view it in the Pokédex first.
// Body: { speciesId, level?, nature?, gender? }
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
  const { speciesId, level = 5, nature = 'Hardy', gender } = req.body as {
    speciesId: number;
    level?: number;
    nature?: string;
    gender?: string;
  };

  if (!speciesId || typeof speciesId !== 'number') {
    res.status(400).json({ data: null, error: 'speciesId is required and must be a number' });
    return;
  }
  if (!VALID_NATURES.includes(nature)) {
    res.status(400).json({ data: null, error: `Invalid nature. Valid values: ${VALID_NATURES.join(', ')}` });
    return;
  }

  const user = await User.findOne({ username }).lean();
  if (!user) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return;
  }

  // Species must already be cached — viewing it on the Pokédex page will cache it
  const species = await PokedexCache.findOne({ pokeApiId: speciesId }).lean();
  if (!species) {
    res.status(404).json({
      data: null,
      error: `Species #${speciesId} is not in the Pokédex cache. View it in the Pokédex first.`,
    });
    return;
  }

  // Gen 3+ HP formula (no IVs/EVs until Phase 5)
  const maxHp = Math.floor((2 * species.baseStats.hp * level) / 100) + level + 10;

  // Resolve gender: use provided value, or derive from genderRatio in species data
  let resolvedGender: 'male' | 'female' | 'none';
  if (gender === 'male' || gender === 'female' || gender === 'none') {
    resolvedGender = gender;
  } else if (species.genderRatio === -1) {
    resolvedGender = 'none';   // genderless species (Magnemite, etc.)
  } else if (species.genderRatio === 0) {
    resolvedGender = 'female'; // always female (Chansey, etc.)
  } else {
    resolvedGender = 'male';
  }

  // Slot into party if there's room, otherwise send to PC
  const partyCount = await Pokemon.countDocuments({ ownerId: user._id, isInParty: true });
  const inParty   = partyCount < 6;
  const partySlot = inParty ? partyCount + 1 : null;

  const pokemon = await Pokemon.create({
    speciesId,
    ownerId:   user._id,
    ownerType: 'player',
    nickname:  null,
    level,
    exp:       0,
    currentHp: maxHp,
    nature,
    gender:    resolvedGender,
    heldItem:  null,
    moves:     [],
    isInParty: inParty,
    partySlot,
  });

  res.status(201).json({
    data: {
      _id:        pokemon._id,
      speciesId:  pokemon.speciesId,
      speciesName: species.name,
      level:      pokemon.level,
      nature:     pokemon.nature,
      gender:     pokemon.gender,
      isInParty:  pokemon.isInParty,
      partySlot:  pokemon.partySlot,
    },
    error: null,
  });
});

export default router;
