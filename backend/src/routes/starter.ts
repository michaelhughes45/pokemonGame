import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from '../lib/pokeapi';

const router = Router();

const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
];

// GET /api/starter — check whether the current user already has a starter
router.get('/', verifyToken, async (req: Request, res: Response) => {
  const count = await Pokemon.countDocuments({ ownerId: req.user!.userId });
  res.json({ data: { hasStarter: count > 0 }, error: null });
});

// POST /api/starter — pick a starter Pokémon
router.post('/', verifyToken, async (req: Request, res: Response): Promise<void> => {
  const { speciesId } = req.body as { speciesId: number };

  if (!speciesId || typeof speciesId !== 'number') {
    res.status(400).json({ data: null, error: 'speciesId (number) is required' });
    return;
  }

  // Prevent picking a second starter
  const existing = await Pokemon.countDocuments({ ownerId: req.user!.userId });
  if (existing > 0) {
    res.status(409).json({ data: null, error: 'You have already chosen a starter' });
    return;
  }

  // Ensure species is in the pokedex cache
  let cached = await PokedexCache.findOne({ pokeApiId: speciesId }).lean();
  if (!cached) {
    let transformed;
    try {
      transformed = await fetchSpecies(speciesId);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('not found')) {
        res.status(404).json({ data: null, error: `Species not found: ${speciesId}` });
      } else {
        res.status(502).json({ data: null, error: 'Failed to fetch from PokeAPI' });
      }
      return;
    }
    cached = await PokedexCache.create(transformed);
  }

  // Fetch raw PokeAPI data to find moves learned at level 1
  const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${speciesId}`);
  if (!pokeRes.ok) {
    res.status(502).json({ data: null, error: 'Failed to fetch move data from PokeAPI' });
    return;
  }
  const pokeData = await pokeRes.json() as any;

  // Collect move names learned at level 1 via level-up in any version group
  const level1MoveNames = new Set<string>();
  for (const m of pokeData.moves) {
    const learnedAtOne = m.version_group_details.some(
      (d: any) => d.move_learn_method.name === 'level-up' && d.level_learned_at === 1
    );
    if (learnedAtOne) level1MoveNames.add(m.move.name as string);
  }

  // Cross-reference with cached move data to get PP, take up to 4
  const moves = cached.moves
    .filter(m => level1MoveNames.has(m.name))
    .slice(0, 4)
    .map(m => ({ moveId: m.name, currentPP: m.pp ?? 35, maxPP: m.pp ?? 35 }));

  // HP formula (Gen 3+): floor(2 * baseHp * level / 100) + level + 10
  const level = 1;
  const currentHp = Math.floor((2 * cached.baseStats.hp * level) / 100) + level + 10;

  // Random nature
  const nature = NATURES[Math.floor(Math.random() * NATURES.length)];

  // Gender from genderRatio (-1 = genderless, 0–8 = female eighths)
  const gr = cached.genderRatio;
  const gender: 'male' | 'female' | 'none' =
    gr === -1 ? 'none' : Math.random() < gr / 8 ? 'female' : 'male';

  const pokemon = await Pokemon.create({
    speciesId,
    ownerId: req.user!.userId,
    ownerType: 'player',
    nickname: null,
    level,
    exp: 0,
    currentHp,
    nature,
    gender,
    heldItem: null,
    moves,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
    statusCondition: null,
    volatileStatus: [],
    evolutionOverrides: [],
    isInParty: true,
    partySlot: 1,
    caughtAt: null,
    caughtByPlayerId: null,
  });

  res.status(201).json({ data: pokemon.toObject(), error: null });
});

export default router;
