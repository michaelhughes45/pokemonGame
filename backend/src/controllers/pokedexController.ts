import { Request, Response } from 'express';
import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from '../lib/pokeapi';

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
// GET /api/pokedex/search?q=<fragment>
// Returns up to 10 cached species whose name contains the query string.
// Returns an empty array (not 400) for short queries — keeps the UI simple.
// ---------------------------------------------------------------------------
export async function searchPokedex(req: Request, res: Response): Promise<void> {
  const q = ((req.query.q as string) ?? '').trim();
  if (q.length < 2) {
    return sendOk(res, []);
  }

  const results = await PokedexCache
    .find({ name: { $regex: q, $options: 'i' } }, 'pokeApiId name types')
    .limit(10)
    .lean();

  sendOk(res, results);
}

// ---------------------------------------------------------------------------
// GET /api/pokedex/:idOrName
// Returns full species data. Serves from the local cache when available;
// fetches from PokeAPI and caches the result on a miss.
// The try/catch around fetchSpecies is intentional: PokeAPI errors map to
// two distinct status codes (404 = species not found, 502 = API unreachable)
// that the global handler cannot distinguish.
// ---------------------------------------------------------------------------
export async function getSpecies(req: Request, res: Response): Promise<void> {
  const idOrName = String(req.params.idOrName);
  const isNumeric = /^\d+$/.test(idOrName);

  const cached = await PokedexCache.findOne(
    isNumeric ? { pokeApiId: parseInt(idOrName, 10) } : { name: idOrName.toLowerCase() },
  ).lean();

  if (cached) {
    return sendOk(res, cached);
  }

  let transformed;
  try {
    transformed = await fetchSpecies(idOrName.toLowerCase());
  } catch (err: any) {
    const msg: string = err?.message ?? '';
    if (msg.includes('not found')) {
      return sendError(res, 404, `Species not found: ${idOrName}`);
    }
    return sendError(res, 502, 'Failed to fetch from PokeAPI');
  }

  const entry = await PokedexCache.create(transformed);
  sendOk(res, entry.toObject());
}
