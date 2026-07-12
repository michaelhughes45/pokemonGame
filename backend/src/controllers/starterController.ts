import { Request, Response } from 'express';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from '../lib/pokeapi';
import { computeStats, expForLevel, NATURES, ZERO_EVS } from '../lib/statCalc';
import { getIvsForOwner } from '../lib/trainerIv';

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
// GET /api/starter
// Returns whether the current user has already chosen a starter.
// ---------------------------------------------------------------------------
export async function getStarter(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const count = await Pokemon.countDocuments({ ownerId: userId });
  sendOk(res, { hasStarter: count > 0 });
}

// ---------------------------------------------------------------------------
// POST /api/starter
// Claims a starter Pokémon for the current user. Fetches + caches species data
// from PokeAPI if not already in the local cache, then creates the Pokémon at
// level 1 with its learnable moves, a random nature, and a derived gender.
// ---------------------------------------------------------------------------
export async function pickStarter(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { speciesId } = req.body as { speciesId: number };

  if (!speciesId || typeof speciesId !== 'number') {
    return sendError(res, 400, 'speciesId (number) is required');
  }

  const existing = await Pokemon.countDocuments({ ownerId: userId });
  if (existing > 0) {
    return sendError(res, 409, 'You have already chosen a starter');
  }

  // Ensure species data is in the local cache, fetching from PokeAPI if needed.
  // The try/catch here is intentional: fetchSpecies can fail in two distinct ways
  // that need different status codes (404 = species doesn't exist, 502 = API down).
  let cached = await PokedexCache.findOne({ pokeApiId: speciesId }).lean();
  if (!cached) {
    let transformed;
    try {
      transformed = await fetchSpecies(speciesId);
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('not found')) {
        return sendError(res, 404, `Species not found: ${speciesId}`);
      }
      return sendError(res, 502, 'Failed to fetch from PokeAPI');
    }
    cached = await PokedexCache.create(transformed);
  }

  // Derive starting moves from the cache. If the cache entry pre-dates the
  // levelUpMoves field, fall back to a direct PokeAPI fetch.
  let moves: { moveId: string; currentPP: number; maxPP: number; ppUps: number }[] = [];

  if (cached.levelUpMoves?.length) {
    const moveDetailMap = new Map(cached.moves.map(m => [m.name, m]));
    moves = (cached.levelUpMoves as { moveId: string; level: number }[])
      .filter(m => m.level <= 1)
      .slice(0, 4)
      .map(entry => {
        const detail = moveDetailMap.get(entry.moveId);
        return { moveId: entry.moveId, currentPP: detail?.pp ?? 35, maxPP: detail?.pp ?? 35, ppUps: 0 };
      });
  } else {
    const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${speciesId}`);
    if (pokeRes.ok) {
      const pokeData = await pokeRes.json() as any;
      const level1MoveNames = new Set<string>();
      for (const m of pokeData.moves) {
        const learnedAtOne = m.version_group_details.some(
          (d: any) => d.move_learn_method.name === 'level-up' && d.level_learned_at === 1,
        );
        if (learnedAtOne) level1MoveNames.add(m.move.name as string);
      }
      moves = cached.moves
        .filter(m => level1MoveNames.has(m.name))
        .slice(0, 4)
        .map(m => ({ moveId: m.name, currentPP: m.pp ?? 35, maxPP: m.pp ?? 35, ppUps: 0 }));
    }
  }

  const level  = 1;
  const nature = NATURES[Math.floor(Math.random() * NATURES.length)];

  const gr = cached.genderRatio;
  const gender: 'male' | 'female' | 'none' =
    gr === -1 ? 'none' : Math.random() < gr / 8 ? 'female' : 'male';

  const ivs = await getIvsForOwner(userId, 'player');
  const currentHp = computeStats(cached.baseStats, level, nature, ZERO_EVS, ivs).hp;

  const pokemon = await Pokemon.create({
    speciesId,
    ownerId:            userId,
    ownerType:          'player',
    nickname:           null,
    level,
    exp:                expForLevel(level, (cached.expGroup as string) || 'medium-fast'),
    currentHp,
    nature,
    gender,
    heldItem:           null,
    moves,
    evs:                { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
    statusCondition:    null,
    volatileStatus:     [],
    evolutionOverrides: [],
    isInParty:          true,
    partySlot:          1,
    caughtAt:           null,
    caughtByPlayerId:   null,
  });

  sendOk(res, pokemon.toObject(), 201);
}
