import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Pokemon } from '../models/Pokemon';
import { Npc } from '../models/Npc';
import { PokedexCache } from '../models/PokedexCache';
import { computeStats, expForLevel } from '../lib/statCalc';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

// Validates the ID, finds the pokemon, and checks that the caller is allowed
// to access it (players are restricted to their own; DMs/admins see all).
// Returns the lean pokemon document or null (after sending the error).
async function assertPokemonAccess(
  id: string,
  userId: string,
  role: string,
  res: Response,
) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    sendError(res, 404, 'Pokémon not found');
    return null;
  }
  const pokemon = await Pokemon.findById(id).lean();
  if (!pokemon) {
    sendError(res, 404, 'Pokémon not found');
    return null;
  }
  if (role === 'player' && pokemon.ownerId.toString() !== userId) {
    sendError(res, 403, 'Forbidden');
    return null;
  }
  return pokemon;
}

type LeanPokemonDoc = {
  _id: unknown;
  speciesId: number;
  level: number;
  nature: string;
  nickname?: string | null;
  currentHp: number;
  gender: string;
  statusCondition: string | null;
  partySlot: number | null;
};

// Batch-loads species data for a list of pokemon documents and returns an
// enriched array that includes maxHp, speciesName, types, and partySlot.
// partySlot is null for PC pokemon — callers can omit it from their response
// shape if unneeded, but including it is harmless.
async function enrichPokemonList(docs: LeanPokemonDoc[]) {
  const speciesIds = docs.map(p => p.speciesId);
  const speciesEntries = await PokedexCache.find({ pokeApiId: { $in: speciesIds } })
    .select('pokeApiId name types baseStats')
    .lean();
  const speciesMap = new Map(speciesEntries.map(s => [s.pokeApiId, s]));

  return docs.map(p => {
    const species = speciesMap.get(p.speciesId);
    const stats   = species ? computeStats(species.baseStats, p.level, p.nature) : null;
    return {
      _id:             p._id,
      speciesId:       p.speciesId,
      nickname:        p.nickname,
      level:           p.level,
      currentHp:       p.currentHp,
      maxHp:           stats?.hp ?? null,
      gender:          p.gender,
      statusCondition: p.statusCondition,
      partySlot:       p.partySlot,
      speciesName:     species?.name ?? null,
      types:           species?.types ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/pokemon/party
// Returns the logged-in user's party (isInParty: true), enriched with species
// name and types so the dashboard can render previews without extra fetches.
// ---------------------------------------------------------------------------
export async function getParty(req: Request, res: Response): Promise<void> {
  const partyDocs = await Pokemon.find({
    ownerId:   req.user!.userId,
    isInParty: true,
  }).lean().sort({ partySlot: 1 });

  sendOk(res, await enrichPokemonList(partyDocs));
}

// ---------------------------------------------------------------------------
// PATCH /api/pokemon/party/reorder
// Accepts { order: string[] } — pokemon IDs in the desired slot order.
// ---------------------------------------------------------------------------
export async function reorderParty(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { order } = req.body as { order: string[] };

  if (!Array.isArray(order) || order.length === 0 || order.length > 6) {
    return sendError(res, 400, 'order must be an array of 1–6 pokemon IDs');
  }
  if (order.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    return sendError(res, 400, 'Invalid pokemon ID in order array');
  }

  const found = await Pokemon.find({
    _id: { $in: order }, ownerId: userId, isInParty: true,
  }).select('_id').lean();

  if (found.length !== order.length) {
    return sendError(res, 400, 'One or more pokemon not found in your party');
  }

  await Promise.all(order.map((id, index) =>
    Pokemon.updateOne({ _id: id }, { partySlot: index + 1 }),
  ));

  sendOk(res, { updated: order.length });
}

// ---------------------------------------------------------------------------
// GET /api/pokemon/pc
// Returns all pokemon NOT in the party, enriched with the same shape as /party.
// ---------------------------------------------------------------------------
export async function getPc(req: Request, res: Response): Promise<void> {
  const pcDocs = await Pokemon.find({
    ownerId:   req.user!.userId,
    isInParty: false,
  }).lean().sort({ createdAt: 1 });

  sendOk(res, await enrichPokemonList(pcDocs));
}

// ---------------------------------------------------------------------------
// POST /api/pokemon/party/swap
// Moves a PC pokemon into the party.
//   Without partyPokemonId: appends to the next open slot.
//   With partyPokemonId: swaps the two (party member goes to PC).
// ---------------------------------------------------------------------------
export async function swapParty(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { pcPokemonId, partyPokemonId } = req.body as {
    pcPokemonId:   string;
    partyPokemonId?: string;
  };

  if (!pcPokemonId || !mongoose.Types.ObjectId.isValid(pcPokemonId)) {
    return sendError(res, 400, 'Invalid pcPokemonId');
  }

  const pcPokemon = await Pokemon.findOne({ _id: pcPokemonId, ownerId: userId, isInParty: false });
  if (!pcPokemon) {
    return sendError(res, 404, 'PC Pokémon not found');
  }

  if (partyPokemonId) {
    if (!mongoose.Types.ObjectId.isValid(partyPokemonId)) {
      return sendError(res, 400, 'Invalid partyPokemonId');
    }
    const partyPokemon = await Pokemon.findOne({ _id: partyPokemonId, ownerId: userId, isInParty: true });
    if (!partyPokemon) {
      return sendError(res, 404, 'Party Pokémon not found');
    }
    const slot = partyPokemon.partySlot;
    await Pokemon.updateOne({ _id: partyPokemonId }, { isInParty: false, partySlot: null });
    await Pokemon.updateOne({ _id: pcPokemonId },    { isInParty: true,  partySlot: slot });
  } else {
    const partyCount = await Pokemon.countDocuments({ ownerId: userId, isInParty: true });
    await Pokemon.updateOne({ _id: pcPokemonId }, { isInParty: true, partySlot: partyCount + 1 });
  }

  sendOk(res, { ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/pokemon/heal-party
// Restores every party Pokémon to full HP + PP and clears status conditions.
// ---------------------------------------------------------------------------
export async function healParty(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;

  const party = await Pokemon.find({ ownerId: userId, ownerType: 'player', isInParty: true }).lean();
  if (party.length === 0) {
    return sendOk(res, { message: 'Your party is already in great shape!' });
  }

  const speciesIds = [...new Set(party.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats').lean();
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  await Promise.all(party.map(poke => {
    const cache      = cacheMap.get(poke.speciesId);
    const maxHp      = cache ? computeStats(cache.baseStats as any, poke.level, poke.nature).hp : poke.currentHp;
    const fullMoves  = (poke.moves as { moveId: string; currentPP: number; maxPP: number }[])
      .map(m => ({ ...m, currentPP: m.maxPP }));
    return Pokemon.updateOne(
      { _id: poke._id },
      { $set: { currentHp: maxHp, statusCondition: null, statusCounter: null, volatileStatus: [], moves: fullMoves } },
    );
  }));

  sendOk(res, { message: 'Your Pokémon have been healed!' });
}

// ---------------------------------------------------------------------------
// PATCH /api/pokemon/:id/moves
// Replace one move slot via the Move Reminder.
// Body: { slot: 0–3, moveId: string }
// Players can only modify their own Pokémon; DM/admin can modify any.
// ---------------------------------------------------------------------------
export async function replaceMoveSlot(req: Request, res: Response): Promise<void> {
  const { userId, role } = req.user!;
  const { slot, moveId } = req.body as { slot: unknown; moveId: unknown };

  if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) > 3) {
    return sendError(res, 400, 'slot must be an integer 0–3');
  }
  if (!moveId || typeof moveId !== 'string') {
    return sendError(res, 400, 'moveId is required');
  }

  const pokemon = await assertPokemonAccess(String(req.params.id), userId, role, res);
  if (!pokemon) return;

  const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }).lean();
  if (!species) {
    return sendError(res, 404, 'Species data not cached');
  }

  type LevelUpMove = { moveId: string; level: number };
  const levelUpMoves = (species.levelUpMoves ?? []) as LevelUpMove[];
  const learnEntry   = levelUpMoves.find(lm => lm.moveId === moveId && lm.level <= pokemon.level);
  if (!learnEntry) {
    return sendError(res, 400, "Move not available at this Pokémon's level");
  }

  type MoveRecord = { name: string; pp: number | null };
  const moveDetail = ((species.moves ?? []) as MoveRecord[]).find(m => m.name === moveId);
  const pp = moveDetail?.pp ?? 5;

  type MoveSlot = { moveId: string; currentPP: number; maxPP: number };
  const currentMoves = (pokemon.moves ?? []) as MoveSlot[];

  if ((slot as number) >= currentMoves.length) {
    return sendError(res, 400, `No move in slot ${slot}`);
  }

  const newMoves: MoveSlot[] = currentMoves.map((m, i) =>
    i === (slot as number) ? { moveId: moveId as string, currentPP: pp, maxPP: pp } : m,
  );

  await Pokemon.updateOne({ _id: pokemon._id }, { moves: newMoves });
  sendOk(res, { moves: newMoves });
}

// ---------------------------------------------------------------------------
// GET /api/pokemon/:id
// Returns a single Pokémon with full species data and computed stats.
// Players can only view their own; DM/admin can view any.
// ---------------------------------------------------------------------------
export async function getPokemon(req: Request, res: Response): Promise<void> {
  const { userId, role } = req.user!;

  const pokemon = await assertPokemonAccess(String(req.params.id), userId, role, res);
  if (!pokemon) return;

  const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }).lean();
  if (!species) {
    return sendError(res, 404, 'Species data not cached');
  }

  // Resolve names for each step in the evolution chain (best-effort from cache)
  const chainIds = species.evolutionChain.map((s: any) => s.speciesId);
  const chainEntries = chainIds.length
    ? await PokedexCache.find({ pokeApiId: { $in: chainIds } }).select('pokeApiId name').lean()
    : [];
  const chainNameMap = new Map(chainEntries.map(s => [s.pokeApiId, s.name]));

  const evolutionChainWithNames = (species.evolutionChain as any[]).map(step => ({
    speciesId: step.speciesId,
    condition: step.condition,
    value:     step.value,
    name:      chainNameMap.get(step.speciesId) ?? null,
  }));

  const stats = computeStats(species.baseStats, pokemon.level, pokemon.nature);

  // Build reminderMoves: level-up moves learnable at or below the Pokémon's current
  // level, enriched with display data for the Move Reminder UI.
  type MoveDetail = {
    name: string; type: string; category: string;
    power: number | null; accuracy: number | null; pp: number | null; flavorText?: string;
  };
  const moveDetailMap = new Map((species.moves as MoveDetail[]).map(m => [m.name, m]));

  type LevelUpMove = { moveId: string; level: number };
  const reminderMoves = ((species.levelUpMoves ?? []) as LevelUpMove[])
    .filter(lm => lm.level <= pokemon.level)
    .map(lm => {
      const detail = moveDetailMap.get(lm.moveId);
      return {
        moveId:     lm.moveId,
        level:      lm.level,
        type:       detail?.type       ?? '',
        category:   detail?.category   ?? '',
        power:      detail?.power      ?? null,
        accuracy:   detail?.accuracy   ?? null,
        pp:         detail?.pp         ?? 5,
        flavorText: detail?.flavorText ?? '',
      };
    })
    .sort((a, b) => a.level - b.level || a.moveId.localeCompare(b.moveId));

  const expGroup = (species.expGroup as string) || 'medium-fast';

  sendOk(res, {
    _id:                pokemon._id,
    ownerId:            pokemon.ownerId.toString(),
    speciesId:          pokemon.speciesId,
    nickname:           pokemon.nickname,
    level:              pokemon.level,
    exp:                pokemon.exp,
    expForCurrentLevel: expForLevel(pokemon.level, expGroup),
    expForNextLevel:    pokemon.level >= 100 ? null : expForLevel(pokemon.level + 1, expGroup),
    currentHp:          pokemon.currentHp,
    maxHp:              stats.hp,
    nature:             pokemon.nature,
    gender:             pokemon.gender,
    heldItem:           pokemon.heldItem,
    moves:              pokemon.moves,
    statusCondition:    pokemon.statusCondition,
    isInParty:          pokemon.isInParty,
    partySlot:          pokemon.partySlot,
    evolutionOverrides: pokemon.evolutionOverrides,
    hasHiddenAbility:   pokemon.hasHiddenAbility ?? false,
    stats,
    species: {
      name:           species.name,
      types:          species.types,
      baseStats:      species.baseStats,
      abilities:      species.abilities,
      learnableMoves: species.moves,
      reminderMoves,
      evolutionChain: evolutionChainWithNames,
      isLegendary:    species.isLegendary,
      isMythical:     species.isMythical,
    },
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/pokemon/:id
// Permanently releases (deletes) a Pokémon.
// Players can only release their own; DM/admin can release any.
// Players are blocked from releasing their last Pokémon.
// If the released Pokémon was in the party, remaining slots are compacted.
// ---------------------------------------------------------------------------
export async function releasePokemon(req: Request, res: Response): Promise<void> {
  const { userId, role } = req.user!;
  const id = String(req.params.id);

  const pokemon = await assertPokemonAccess(id, userId, role, res);
  if (!pokemon) return;

  const total = await Pokemon.countDocuments({ ownerId: pokemon.ownerId });
  if (total <= 1) {
    return sendError(res, 400, "Cannot release a trainer's last Pokémon");
  }

  const { isInParty, ownerId, ownerType } = pokemon;

  await Pokemon.deleteOne({ _id: id });

  if (ownerType === 'npc') {
    await Npc.updateOne({ party: id }, { $pull: { party: new mongoose.Types.ObjectId(id) } });
  }

  // Compact party slots so they run 1, 2, 3 … with no gaps
  if (isInParty) {
    const remaining = await Pokemon.find({ ownerId, isInParty: true })
      .select('_id')
      .lean()
      .sort({ partySlot: 1 });

    await Promise.all(remaining.map((p, index) =>
      Pokemon.updateOne({ _id: p._id }, { partySlot: index + 1 }),
    ));
  }

  sendOk(res, { ok: true });
}
