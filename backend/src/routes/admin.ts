import { Router, Request, Response } from 'express';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { expForLevel } from '../lib/statCalc';

const router = Router();

router.get('/ping', (_req, res) => {
  res.json({ data: 'admin route reachable', error: null });
});

// ---------------------------------------------------------------------------
// POST /api/admin/fix-pokemon-exp
// One-time migration: for any Pokémon whose exp is below the minimum for their
// current level, bumps it up to expForLevel(level, expGroup).
// Safe to run multiple times — only touches Pokémon that still need fixing.
// ---------------------------------------------------------------------------
router.post('/fix-pokemon-exp', async (_req: Request, res: Response): Promise<void> => {
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

export default router;
