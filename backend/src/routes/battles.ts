import { Router, Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { Battle, IBattle } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { computeStats, BaseStats } from '../lib/statCalc';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: after every move submission, check whether every actor that has an
// active Pokémon has now submitted. If so, sort the turnQueue by effective
// speed (highest first) and advance the phase to 'targeting'.
// ---------------------------------------------------------------------------
async function checkAndAdvance(battle: HydratedDocument<IBattle>): Promise<void> {
  const playerActors = battle.playerSide.filter(e => e.activePokemonId != null);
  const npcActors    = battle.enemySide.filter(e => e.activePokemonId != null);
  const totalActors  = playerActors.length + npcActors.length;

  if (totalActors === 0 || battle.turnQueue.length < totalActors) return;

  // All actors submitted — fetch Pokémon documents for speed calculation
  const pokemonIds = battle.turnQueue.map(e => e.activePokemonId);
  const pokemons   = await Pokemon.find({ _id: { $in: pokemonIds } }, 'speciesId level nature').lean();
  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches     = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats').lean();

  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));
  const pokemonMap = new Map(pokemons.map(p => [p._id.toString(), p]));

  const withSpeed = battle.turnQueue.map(entry => {
    const poke  = pokemonMap.get(entry.activePokemonId.toString());
    const cache = poke ? cacheMap.get(poke.speciesId) : null;
    const speed = poke && cache
      ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).speed
      : 0;
    return { entry, speed };
  });

  // Highest speed goes first; ties keep submission order (stable sort)
  withSpeed.sort((a, b) => b.speed - a.speed);

  // battle.set() is the proper Mongoose API for replacing a field — it wraps
  // the value in a DocumentArray and marks the path modified automatically.
  battle.set('turnQueue', withSpeed.map(x => x.entry));
  battle.phase              = 'targeting';
  battle.currentTargetIndex = 0;
}

// ---------------------------------------------------------------------------
// POST /api/battles
// DM only (requireDm middleware applied in index.ts).
//
// Creates a new battle document for the DM's active campaign.
// Body:
//   type            — 'pve' | 'wild' | 'pvp'
//   playerIds       — array of user ObjectId strings (must all be in the campaign)
//   playerPokemonLimit? — number | null  (null = no limit)
//
// The enemy side starts empty — it will be populated once the NPC/encounter
// builder is built in milestone 4.3/4.4.
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { type, playerIds, playerPokemonLimit = null } = req.body as {
    type: string;
    playerIds: string[];
    playerPokemonLimit?: number | null;
  };

  if (!['pve', 'wild', 'pvp'].includes(type)) {
    res.status(400).json({ data: null, error: "type must be 'pve', 'wild', or 'pvp'" });
    return;
  }
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    res.status(400).json({ data: null, error: 'playerIds must be a non-empty array' });
    return;
  }
  if (
    playerPokemonLimit !== null &&
    (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)
  ) {
    res.status(400).json({ data: null, error: 'playerPokemonLimit must be a positive integer or null' });
    return;
  }

  const campaign = await Campaign.findOne({
    dmId: req.user!.userId,
    isActive: true,
  }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const campaignPlayerStrings = campaign.playerIds.map(id => id.toString());
  const invalidIds = playerIds.filter(id => !campaignPlayerStrings.includes(id));
  if (invalidIds.length > 0) {
    res.status(400).json({
      data:  null,
      error: `These player IDs are not in your campaign: ${invalidIds.join(', ')}`,
    });
    return;
  }

  const battle = await Battle.create({
    campaignId: campaign._id,
    type,
    status:     'waiting',
    phase:      'move_submission',
    playerSide: playerIds.map(id => ({
      userId:          new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      usedPokemonIds:  [],
      fainted:         [],
    })),
    enemySide:          [],
    playerPokemonLimit: playerPokemonLimit ?? null,
    lastUpdatedAt:      new Date(),
  });

  res.status(201).json({
    data: { _id: battle._id, status: battle.status, type: battle.type },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/start
// DM only — activates a waiting battle.
// Changes status from 'waiting' → 'active' and sets turnNumber to 1.
// ---------------------------------------------------------------------------
router.post('/:id/start', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'waiting') {
    res.status(400).json({ data: null, error: 'Battle has already started' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

  battle.status        = 'active';
  battle.turnNumber    = 1;
  battle.phase         = 'move_submission';
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { status: battle.status, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/send-out
// Player — picks which party Pokémon to send into battle.
// Sets activePokemonId on the player's side entry and adds to usedPokemonIds
// if this Pokémon hasn't been used in this battle before.
// Body: { pokemonId: string }
// ---------------------------------------------------------------------------
router.post('/:id/send-out', async (req: Request, res: Response): Promise<void> => {
  const { pokemonId } = req.body as { pokemonId: string };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  if (!pokemonId || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Invalid pokemonId' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Cannot send out a Pokémon outside move submission phase' });
    return;
  }

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry) {
    res.status(403).json({ data: null, error: 'You are not in this battle' });
    return;
  }

  const pokeId = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({
    _id:       pokeId,
    ownerId:   userId,
    ownerType: 'player',
    isInParty: true,
  }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Pokémon not found in your party' });
    return;
  }
  if (pokemon.currentHp <= 0) {
    res.status(400).json({ data: null, error: 'That Pokémon has fainted' });
    return;
  }

  // playerPokemonLimit only restricts first-time sends; switching to a previously
  // used Pokémon is always allowed (handled in milestone 3.10)
  const alreadyUsed = playerEntry.usedPokemonIds.some(id => id.toString() === pokemonId);
  if (!alreadyUsed && battle.playerPokemonLimit !== null) {
    if (playerEntry.usedPokemonIds.length >= battle.playerPokemonLimit) {
      res.status(400).json({ data: null, error: 'Pokémon limit reached for this battle' });
      return;
    }
  }

  playerEntry.activePokemonId = pokeId;
  if (!alreadyUsed) {
    playerEntry.usedPokemonIds.push(pokeId);
  }
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { activePokemonId: pokemonId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-send-out
// DM only — sets the active Pokémon for an NPC slot on the enemy side.
// Body: { npcId: string, pokemonId: string }
// ---------------------------------------------------------------------------
router.post('/:id/dm-send-out', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  const { npcId, pokemonId } = req.body as { npcId: string; pokemonId: string };

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  if (!npcId || !pokemonId || !mongoose.Types.ObjectId.isValid(npcId) || !mongoose.Types.ObjectId.isValid(pokemonId)) {
    res.status(400).json({ data: null, error: 'Valid npcId and pokemonId are required' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Battle is not in move submission phase' });
    return;
  }

  const npcEntry = battle.enemySide.find(e => e.npcId.toString() === npcId);
  if (!npcEntry) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }

  const pokeId = new mongoose.Types.ObjectId(pokemonId);
  const pokemon = await Pokemon.findOne({
    _id:       pokeId,
    ownerId:   new mongoose.Types.ObjectId(npcId),
    ownerType: 'npc',
  }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Pokémon not found for this NPC' });
    return;
  }
  if (pokemon.currentHp <= 0) {
    res.status(400).json({ data: null, error: 'That Pokémon has fainted' });
    return;
  }

  npcEntry.activePokemonId = pokeId;
  battle.lastUpdatedAt     = new Date();
  await battle.save();

  res.json({ data: { activePokemonId: pokemonId }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/submit-move
// Player — submits their move choice for the current round.
// Validates that the move is on the active Pokémon and has PP remaining.
// After adding to turnQueue, calls checkAndAdvance: if all actors have now
// submitted the phase automatically transitions to 'targeting'.
// Body: { moveId: string }
// ---------------------------------------------------------------------------
router.post('/:id/submit-move', async (req: Request, res: Response): Promise<void> => {
  const { moveId } = req.body as { moveId: string };
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  if (!moveId) {
    res.status(400).json({ data: null, error: 'moveId is required' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Not in move submission phase' });
    return;
  }

  const playerEntry = battle.playerSide.find(e => e.userId.toString() === userId.toString());
  if (!playerEntry) {
    res.status(403).json({ data: null, error: 'You are not in this battle' });
    return;
  }
  if (!playerEntry.activePokemonId) {
    res.status(400).json({ data: null, error: 'You have not sent out a Pokémon yet' });
    return;
  }

  const alreadySubmitted = battle.turnQueue.some(
    e => e.actorId.toString() === userId.toString() && e.actorType === 'player'
  );
  if (alreadySubmitted) {
    res.status(400).json({ data: null, error: 'You have already submitted a move this turn' });
    return;
  }

  const pokemon = await Pokemon.findOne({ _id: playerEntry.activePokemonId }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'Active Pokémon not found' });
    return;
  }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot) {
    res.status(400).json({ data: null, error: 'That move is not on your active Pokémon' });
    return;
  }
  if (moveSlot.currentPP <= 0) {
    res.status(400).json({ data: null, error: 'That move has no PP remaining' });
    return;
  }

  battle.turnQueue.push({
    actorId:         userId,
    actorType:       'player',
    activePokemonId: playerEntry.activePokemonId,
    moveId,
    targets:         [],
    resolved:        false,
  });

  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/dm-submit-move
// DM only — submits a move on behalf of an NPC.
// Body: { npcId: string, moveId: string }
// ---------------------------------------------------------------------------
router.post('/:id/dm-submit-move', async (req: Request, res: Response): Promise<void> => {
  const { role } = req.user!;
  if (role !== 'dm' && role !== 'admin') {
    res.status(403).json({ data: null, error: 'DM only' });
    return;
  }

  const { npcId, moveId } = req.body as { npcId: string; moveId: string };

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  if (!npcId || !moveId) {
    res.status(400).json({ data: null, error: 'npcId and moveId are required' });
    return;
  }

  const battle = await Battle.findById(req.params.id);
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }
  if (battle.status !== 'active' || battle.phase !== 'move_submission') {
    res.status(400).json({ data: null, error: 'Battle is not in move submission phase' });
    return;
  }

  const npcEntry = battle.enemySide.find(e => e.npcId.toString() === npcId);
  if (!npcEntry) {
    res.status(404).json({ data: null, error: 'NPC not found in this battle' });
    return;
  }
  if (!npcEntry.activePokemonId) {
    res.status(400).json({ data: null, error: 'NPC has not sent out a Pokémon yet' });
    return;
  }

  const alreadySubmitted = battle.turnQueue.some(
    e => e.actorId.toString() === npcId && e.actorType === 'npc'
  );
  if (alreadySubmitted) {
    res.status(400).json({ data: null, error: 'This NPC has already submitted a move this turn' });
    return;
  }

  const pokemon = await Pokemon.findOne({ _id: npcEntry.activePokemonId }).lean();
  if (!pokemon) {
    res.status(404).json({ data: null, error: 'NPC active Pokémon not found' });
    return;
  }
  const moveSlot = pokemon.moves.find(m => m.moveId === moveId);
  if (!moveSlot) {
    res.status(400).json({ data: null, error: "That move is not on the NPC's active Pokémon" });
    return;
  }
  if (moveSlot.currentPP <= 0) {
    res.status(400).json({ data: null, error: 'That move has no PP remaining' });
    return;
  }

  battle.turnQueue.push({
    actorId:         new mongoose.Types.ObjectId(npcId),
    actorType:       'npc',
    activePokemonId: npcEntry.activePokemonId,
    moveId,
    targets:         [],
    resolved:        false,
  });

  await checkAndAdvance(battle);
  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({ data: { submitted: true, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/battles/dm
// DM only (requireDm middleware applied in index.ts).
//
// Returns all non-complete battles for the DM's active campaign so the DM
// panel can list them and the DM can navigate back into any open battle.
// ---------------------------------------------------------------------------
router.get('/dm', async (req: Request, res: Response): Promise<void> => {
  const campaign = await Campaign.findOne({
    dmId:     req.user!.userId,
    isActive: true,
  }).lean();

  if (!campaign) {
    res.json({ data: [], error: null });
    return;
  }

  const battles = await Battle.find({
    campaignId: campaign._id,
    status:     { $ne: 'complete' },
  })
    .sort({ lastUpdatedAt: -1 })
    .lean();

  res.json({
    data: battles.map(b => ({
      _id:           b._id,
      type:          b.type,
      status:        b.status,
      turnNumber:    b.turnNumber,
      lastUpdatedAt: b.lastUpdatedAt,
    })),
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/battles/active
// Any authenticated user.
//
// Returns the caller's current non-complete battle (waiting or active), if any.
// The dashboard uses this to surface "Battle in progress" without the client
// needing to know a battle ID up front.
// ---------------------------------------------------------------------------
router.get('/active', async (req: Request, res: Response): Promise<void> => {
  const userId = new mongoose.Types.ObjectId(req.user!.userId);

  const battle = await Battle.findOne({
    'playerSide.userId': userId,
    status: { $ne: 'complete' },
  })
    .sort({ lastUpdatedAt: -1 })
    .lean();

  if (!battle) {
    res.json({ data: null, error: null });
    return;
  }

  res.json({
    data: {
      _id:           battle._id,
      status:        battle.status,
      type:          battle.type,
      turnNumber:    battle.turnNumber,
      lastUpdatedAt: battle.lastUpdatedAt,
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/battles/:id/state
// Any authenticated user. Used for the client polling loop (3.2+).
//
// Returns the full battle document with player usernames joined in so the
// frontend doesn't need to make extra requests to display who's in the battle.
// ---------------------------------------------------------------------------
router.get('/:id/state', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

  const battle = await Battle.findById(id).lean();
  if (!battle) {
    res.status(404).json({ data: null, error: 'Battle not found' });
    return;
  }

  // Join usernames for the player side so the UI can display names instead of IDs
  const userIds = battle.playerSide.map(entry => entry.userId);
  const users = await User.find({ _id: { $in: userIds } }, 'username').lean();
  const usernameMap = new Map(users.map(u => [u._id.toString(), u.username]));

  const playerSideWithNames = battle.playerSide.map(entry => ({
    ...entry,
    username: usernameMap.get(entry.userId.toString()) ?? 'Unknown',
  }));

  res.json({
    data: {
      ...battle,
      playerSide: playerSideWithNames,
    },
    error: null,
  });
});

export default router;
