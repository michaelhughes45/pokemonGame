import { Router, Request, Response } from 'express';
import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from '../lib/pokeapi';

const router = Router();

router.get('/:idOrName', async (req: Request, res: Response): Promise<void> => {
  const idOrName = req.params.idOrName as string;

  try {
    // --- Step 1: check cache ---
    const isNumeric = /^\d+$/.test(idOrName);
    const cached = await PokedexCache.findOne(
      isNumeric ? { pokeApiId: parseInt(idOrName, 10) } : { name: idOrName.toLowerCase() }
    ).lean();

    if (cached) {
      res.json({ data: cached, error: null });
      return;
    }

    // --- Step 2: cache miss — fetch from PokeAPI ---
    let transformed;
    try {
      transformed = await fetchSpecies(idOrName.toLowerCase());
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('not found')) {
        res.status(404).json({ data: null, error: `Species not found: ${idOrName}` });
      } else {
        res.status(502).json({ data: null, error: 'Failed to fetch from PokeAPI' });
      }
      return;
    }

    // --- Step 3: save to cache and return ---
    const entry = await PokedexCache.create(transformed);
    res.json({ data: entry.toObject(), error: null });
  } catch (err) {
    console.error('Pokedex route error:', err);
    res.status(500).json({ data: null, error: 'Internal server error' });
  }
});

export default router;
