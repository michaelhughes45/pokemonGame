import { Request, Response } from 'express';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { expForLevel } from '../lib/statCalc';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

// ---------------------------------------------------------------------------
// GET /api/admin/ping
// Smoke-test that the admin route is reachable and auth middleware passed.
// ---------------------------------------------------------------------------
export function ping(_req: Request, res: Response): void {
  sendOk(res, 'admin route reachable');
}

// ---------------------------------------------------------------------------
// POST /api/admin/fix-pokemon-exp
// One-time migration: bumps any Pokémon whose exp is below the minimum for
// their level up to expForLevel(level, expGroup).
// Safe to run multiple times — only touches Pokémon that still need fixing.
// ---------------------------------------------------------------------------
export async function fixPokemonExp(_req: Request, res: Response): Promise<void> {
  const allPokemon = await Pokemon.find({}, '_id speciesId level exp').lean();

  const speciesIds = [...new Set(allPokemon.map(p => p.speciesId))];
  const caches = await PokedexCache.find(
    { pokeApiId: { $in: speciesIds } },
    'pokeApiId expGroup',
  ).lean();
  const expGroupMap = new Map(
    caches.map(c => [c.pokeApiId as number, (c.expGroup as string) || 'medium-fast']),
  );

  const toFix = allPokemon
    .map(p => ({ ...p, minExp: expForLevel(p.level, expGroupMap.get(p.speciesId) ?? 'medium-fast') }))
    .filter(p => p.exp < p.minExp);

  await Promise.all(toFix.map(p =>
    Pokemon.updateOne({ _id: p._id }, { $set: { exp: p.minExp } }),
  ));

  sendOk(res, { fixed: toFix.length, total: allPokemon.length });
}
