import { Router, Request, Response } from 'express';
import mongoose, { HydratedDocument } from 'mongoose';
import { Battle, IBattle } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Npc } from '../models/Npc';
import { computeStats, BaseStats } from '../lib/statCalc';
import { calculate, Pokemon as CalcPokemon, Move as CalcMove, Field, Generations } from '@smogon/calc';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: after every move submission, check whether every actor that has an
// active Pokémon has now submitted. If so, sort the turnQueue by effective
// speed (highest first) and advance the phase to 'targeting'.
// ---------------------------------------------------------------------------
async function checkAndAdvance(battle: HydratedDocument<IBattle>): Promise<void> {
  // All players must have sent out a Pokémon before the phase can advance
  if (battle.playerSide.some(e => e.activePokemonId == null)) return;

  const playerActors = battle.playerSide; // all have active Pokémon at this point
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
// @smogon/calc helpers
// ---------------------------------------------------------------------------

const GEN9 = Generations.get(9);

// Convert a PokeAPI slug to a display name suitable for @smogon/calc and
// human-readable log strings.  "ice-beam" → "Ice Beam", "mr-mime" → "Mr Mime"
function slugToDisplayName(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Map our battle weather strings to the values @smogon/calc expects.
function toCalcWeather(weather: IBattle['weather']): string | undefined {
  if (!weather) return undefined;
  const map: Record<string, string> = {
    rain: 'Rain', sun: 'Sun', sandstorm: 'Sand', hail: 'Hail', snow: 'Snow',
  };
  return map[weather];
}

// Resolve a single move from one attacker against one target.
// Runs @smogon/calc with a random damage roll and a 1/24 crit roll.
// Returns the damage dealt and human-readable event strings for the turn log.
async function resolveMove(
  attackerPokemonId: mongoose.Types.ObjectId,
  targetPokemonId:   mongoose.Types.ObjectId,
  moveId:            string,
  weather:           IBattle['weather'],
): Promise<{ damage: number; events: string[] }> {
  const [attacker, target] = await Promise.all([
    Pokemon.findById(attackerPokemonId).lean(),
    Pokemon.findById(targetPokemonId).lean(),
  ]);
  if (!attacker || !target) {
    return { damage: 0, events: ['(Pokémon not found during move resolution)'] };
  }

  const [attackerCache, targetCache] = await Promise.all([
    PokedexCache.findOne({ pokeApiId: attacker.speciesId }).lean(),
    PokedexCache.findOne({ pokeApiId: target.speciesId }).lean(),
  ]);
  if (!attackerCache || !targetCache) {
    return { damage: 0, events: ['(Species cache missing during move resolution)'] };
  }

  const attackerName = attacker.nickname ?? slugToDisplayName(attackerCache.name as string);
  const targetName   = target.nickname   ?? slugToDisplayName(targetCache.name   as string);
  const moveName     = slugToDisplayName(moveId);

  // Look up the move's data from the attacker's species cache.
  // The `name` field on each cached move is the PokeAPI slug, matching moveId.
  const moveData = (attackerCache.moves as Array<{
    name: string; category: string; power: number | null; implemented: boolean;
  }>).find(m => m.name === moveId);

  // Status moves and unrecognised moves deal no damage
  if (!moveData || !moveData.power) {
    const implNote = moveData && !moveData.implemented ? ' (effect not yet implemented)' : '';
    return {
      damage: 0,
      events: [`${attackerName} used ${moveName} on ${targetName}.${implNote}`],
    };
  }

  const isCrit = Math.random() < 1 / 24; // Gen 6+ base crit rate

  let damage    = 0;
  let effectNote = '';

  try {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const zeroes = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

    const calcAttacker = new CalcPokemon(GEN9, slugToDisplayName(attackerCache.name as string), {
      level:  attacker.level,
      nature: cap(attacker.nature) as any,
      evs:    zeroes,
      ivs:    zeroes,
      curHP:  attacker.currentHp,
    });

    const calcTarget = new CalcPokemon(GEN9, slugToDisplayName(targetCache.name as string), {
      level:  target.level,
      nature: cap(target.nature) as any,
      evs:    zeroes,
      ivs:    zeroes,
      curHP:  target.currentHp,
    });

    const calcMove  = new CalcMove(GEN9, moveName);
    const calcField = new Field({ weather: toCalcWeather(weather) as any });

    const result = calculate(GEN9, calcAttacker, calcTarget, calcMove, calcField);
    const rolls  = Array.isArray(result.damage)
      ? (result.damage as number[])
      : [result.damage as number];
    damage = rolls[Math.floor(Math.random() * rolls.length)];
    // Apply crit multiplier manually (1.5× in Gen 6+)
    if (isCrit && damage > 0) damage = Math.floor(damage * 1.5);

    const desc = result.desc();
    if (damage === 0 || desc.includes('immune'))         effectNote = " It had no effect!";
    else if (desc.includes('super effective'))           effectNote = " It's super effective!";
    else if (desc.includes('not very effective'))        effectNote = " It's not very effective...";
  } catch {
    // Fallback if @smogon/calc doesn't recognise the species or move name
    damage = Math.max(1, Math.floor((moveData.power * attacker.level) / 50));
  }

  damage = Math.max(0, damage);

  const critNote = isCrit && damage > 0 ? ' Critical hit!' : '';

  return {
    damage,
    events: [`${attackerName} used ${moveName} on ${targetName} for ${damage} damage!${effectNote}${critNote}`],
  };
}

// Apply end-of-round effects (burn/poison/toxic damage) and reset the battle
// to move_submission for the next round.  Called after the last actor in the
// turnQueue resolves their move.
async function applyEndOfRound(battle: HydratedDocument<IBattle>): Promise<void> {
  const allActiveIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((id): id is mongoose.Types.ObjectId => id != null);

  if (allActiveIds.length > 0) {
    const activePokemons = await Pokemon.find(
      { _id: { $in: allActiveIds }, currentHp: { $gt: 0 } },
      'speciesId level nature currentHp statusCondition nickname',
    ).lean();

    const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
    const caches     = speciesIds.length > 0
      ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats').lean()
      : [];
    const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));

    const statusEvents: string[] = [];

    for (const poke of activePokemons) {
      if (
        poke.statusCondition !== 'burn' &&
        poke.statusCondition !== 'poison' &&
        poke.statusCondition !== 'toxic'
      ) continue;

      const cache = cacheMap.get(poke.speciesId);
      if (!cache) continue;

      const maxHp   = computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp;
      const pokeName = poke.nickname ?? slugToDisplayName(cache.name as string);
      const damage   = Math.max(1, Math.floor(maxHp / 8));
      const newHp    = Math.max(0, poke.currentHp - damage);

      await Pokemon.updateOne({ _id: poke._id }, { $set: { currentHp: newHp } });
      statusEvents.push(
        `${pokeName} is hurt by its ${poke.statusCondition}! (${damage} damage, ${newHp} HP remaining)`,
      );
    }

    if (statusEvents.length > 0) {
      let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
      if (!logEntry) {
        battle.turnLog.push({ turn: battle.turnNumber, events: [] });
        logEntry = battle.turnLog[battle.turnLog.length - 1];
      }
      for (const event of statusEvents) {
        logEntry.events.push(event);
      }
      battle.markModified('turnLog');
    }
  }

  // All moves resolved — hold at end_of_round so the DM can read the log
  // before advancing. The advance-round endpoint handles the actual reset.
  battle.phase = 'end_of_round';
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
  const { type, playerIds, npcIds = [], playerPokemonLimit = null } = req.body as {
    type: string;
    playerIds: string[];
    npcIds?: string[];
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
  if (!Array.isArray(npcIds)) {
    res.status(400).json({ data: null, error: 'npcIds must be an array' });
    return;
  }
  if (!npcIds.every(id => mongoose.Types.ObjectId.isValid(id))) {
    res.status(400).json({ data: null, error: 'All npcIds must be valid' });
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

  // Validate all requested NPCs exist and belong to this campaign
  if (npcIds.length > 0) {
    const foundNpcs = await Npc.find({
      _id:        { $in: npcIds },
      campaignId: campaign._id,
    }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      res.status(400).json({ data: null, error: 'One or more NPCs were not found in your campaign' });
      return;
    }
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
    enemySide: npcIds.map(id => ({
      npcId:           new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      fainted:         [],
    })),
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
// POST /api/battles/:id/submit-target
// Player or DM — submits target selection for the current actor in the
// speed-sorted turnQueue.
//
// - Player actors may only submit when it is their own turn
//   (turnQueue[currentTargetIndex].actorId === userId)
// - DM submits for NPC actors
// - Targets must be active, non-fainted Pokémon on the opposing side
//
// Fills in targets, increments currentTargetIndex, and transitions phase
// to 'end_of_round' once all actors have picked.
// Body: { targets: string[] }
// ---------------------------------------------------------------------------
router.post('/:id/submit-target', async (req: Request, res: Response): Promise<void> => {
  const { targets } = req.body as { targets: string[] };
  const { userId, role } = req.user!;

  if (!mongoose.Types.ObjectId.isValid(req.params.id as string)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    res.status(400).json({ data: null, error: 'targets must be a non-empty array of Pokémon IDs' });
    return;
  }

  if (!targets.every(t => mongoose.Types.ObjectId.isValid(t))) {
    res.status(400).json({ data: null, error: 'All target IDs must be valid' });
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
  if (battle.phase !== 'targeting') {
    res.status(400).json({ data: null, error: 'Battle is not in targeting phase' });
    return;
  }

  const idx = battle.currentTargetIndex;
  if (idx >= battle.turnQueue.length) {
    res.status(400).json({ data: null, error: 'No actor is waiting to pick targets' });
    return;
  }

  const currentEntry = battle.turnQueue[idx];

  // Verify the caller is the correct actor for this turn
  if (currentEntry.actorType === 'player') {
    if (currentEntry.actorId.toString() !== userId) {
      res.status(403).json({ data: null, error: 'It is not your turn to pick targets' });
      return;
    }
  } else {
    if (role !== 'dm' && role !== 'admin') {
      res.status(403).json({ data: null, error: 'Only the DM can pick targets for NPCs' });
      return;
    }
  }

  // Opposing side: players target enemies; NPCs target players
  const isPlayerActor = currentEntry.actorType === 'player';
  const validTargetIds = isPlayerActor
    ? battle.enemySide
        .filter(e => e.activePokemonId != null)
        .map(e => e.activePokemonId!.toString())
    : battle.playerSide
        .filter(e => e.activePokemonId != null)
        .map(e => e.activePokemonId!.toString());

  const invalidTargets = targets.filter(t => !validTargetIds.includes(t));
  if (invalidTargets.length > 0) {
    res.status(400).json({ data: null, error: 'One or more targets are not valid active opposing Pokémon' });
    return;
  }

  // Verify targets are alive
  const targetPokemons = await Pokemon.find({ _id: { $in: targets } }, 'currentHp').lean();
  const fainted = targetPokemons.filter(p => p.currentHp <= 0);
  if (fainted.length > 0) {
    res.status(400).json({ data: null, error: 'Cannot target a fainted Pokémon' });
    return;
  }

  // Build a HP map from the liveness check above so we can compute new HP
  // without an extra DB round-trip per target.
  const targetHpMap = new Map(targetPokemons.map(p => [p._id.toString(), p.currentHp]));

  // Fill targets and immediately resolve damage (sequential speed-order design)
  battle.turnQueue[idx].targets = targets.map(t => new mongoose.Types.ObjectId(t));

  const moveEvents: string[] = [];
  for (const targetId of targets) {
    const { damage, events } = await resolveMove(
      currentEntry.activePokemonId,
      new mongoose.Types.ObjectId(targetId),
      currentEntry.moveId,
      battle.weather,
    );
    moveEvents.push(...events);

    if (damage > 0) {
      const currentHp = targetHpMap.get(targetId) ?? 0;
      const newHp     = Math.max(0, currentHp - damage);
      await Pokemon.updateOne({ _id: targetId }, { $set: { currentHp: newHp } });
    }
  }

  // Deduct 1 PP from the attacker's move slot (floor at 0)
  await Pokemon.updateOne(
    { _id: currentEntry.activePokemonId, 'moves.moveId': currentEntry.moveId, 'moves.currentPP': { $gt: 0 } },
    { $inc: { 'moves.$.currentPP': -1 } },
  );

  // Mark the entry resolved and write events to the turn log
  battle.turnQueue[idx].resolved = true;

  let logEntry = battle.turnLog.find(t => t.turn === battle.turnNumber);
  if (!logEntry) {
    battle.turnLog.push({ turn: battle.turnNumber, events: [] });
    logEntry = battle.turnLog[battle.turnLog.length - 1];
  }
  for (const event of moveEvents) {
    logEntry.events.push(event);
  }
  battle.markModified('turnLog');

  battle.currentTargetIndex = idx + 1;

  // When the last actor resolves, apply end-of-round status damage and start the next round
  if (battle.currentTargetIndex >= battle.turnQueue.length) {
    await applyEndOfRound(battle);
  }

  battle.lastUpdatedAt = new Date();
  await battle.save();

  res.json({
    data:  { phase: battle.phase, currentTargetIndex: battle.currentTargetIndex },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/battles/:id/advance-round
// DM only — called after the DM has reviewed the end-of-round log.
// Clears the turnQueue, increments turnNumber, and resets phase to
// 'move_submission' so the next round can begin.
// ---------------------------------------------------------------------------
router.post('/:id/advance-round', async (req: Request, res: Response): Promise<void> => {
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
  if (battle.status !== 'active') {
    res.status(400).json({ data: null, error: 'Battle is not active' });
    return;
  }
  if (battle.phase !== 'end_of_round') {
    res.status(400).json({ data: null, error: 'Battle is not at end of round' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

  battle.set('turnQueue', []);
  battle.currentTargetIndex = 0;
  battle.turnNumber        += 1;
  battle.phase              = 'move_submission';
  battle.lastUpdatedAt      = new Date();
  await battle.save();

  res.json({ data: { turnNumber: battle.turnNumber, phase: battle.phase }, error: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/battles/:id
// DM only — permanently deletes a battle.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
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

  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign || campaign._id.toString() !== battle.campaignId.toString()) {
    res.status(403).json({ data: null, error: 'Not your campaign' });
    return;
  }

  await Battle.findByIdAndDelete(req.params.id);
  res.json({ data: { deleted: true }, error: null });
});

// ---------------------------------------------------------------------------
// GET /api/battles/:id/state
// Any authenticated user. Used for the client polling loop (3.2+).
//
// Returns the full battle document with:
//   - player usernames joined from the users collection
//   - activePokemonInfo (name, currentHp, maxHp) joined for every active
//     Pokémon on both sides so the frontend can display health bars and
//     targeting options without extra per-Pokémon requests.
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

  // Join usernames for the player side
  const userIds = battle.playerSide.map(entry => entry.userId);
  const users   = await User.find({ _id: { $in: userIds } }, 'username').lean();
  const usernameMap = new Map(users.map(u => [u._id.toString(), u.username]));

  // Collect every active Pokémon ID from both sides so we can join name + HP
  // in a single query rather than N individual requests.
  const allActivePokemonIds = [
    ...battle.playerSide.map(e => e.activePokemonId),
    ...battle.enemySide.map(e => e.activePokemonId),
  ].filter((pid): pid is mongoose.Types.ObjectId => pid != null);

  const activePokemons = allActivePokemonIds.length > 0
    ? await Pokemon.find(
        { _id: { $in: allActivePokemonIds } },
        'nickname speciesId currentHp level nature'
      ).lean()
    : [];

  const speciesIds = [...new Set(activePokemons.map(p => p.speciesId))];
  const caches     = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name baseStats').lean()
    : [];

  const pokemonMap = new Map(activePokemons.map(p => [p._id.toString(), p]));
  const cacheMap   = new Map(caches.map(c => [c.pokeApiId as number, c]));

  // Build a compact info object for a single active Pokémon slot.
  const buildInfo = (pokemonId: mongoose.Types.ObjectId | null) => {
    if (!pokemonId) return null;
    const poke = pokemonMap.get(pokemonId.toString());
    if (!poke) return null;
    const cache       = cacheMap.get(poke.speciesId);
    const speciesName = cache?.name ?? `#${poke.speciesId}`;
    const maxHp       = cache
      ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature).hp
      : null;
    return {
      _id:         poke._id.toString(),
      name:        poke.nickname ?? speciesName,
      speciesName,
      currentHp:   poke.currentHp,
      maxHp,
    };
  };

  const playerSideWithNames = battle.playerSide.map(entry => ({
    ...entry,
    username:          usernameMap.get(entry.userId.toString()) ?? 'Unknown',
    activePokemonInfo: buildInfo(entry.activePokemonId),
  }));

  // Join NPC names so the frontend can label enemy slots without extra requests
  const npcIds  = battle.enemySide.map(e => e.npcId);
  const npcs    = npcIds.length > 0
    ? await Npc.find({ _id: { $in: npcIds } }, 'name').lean()
    : [];
  const npcNameMap = new Map(npcs.map(n => [(n._id as mongoose.Types.ObjectId).toString(), n.name]));

  const enemySideWithInfo = battle.enemySide.map(entry => ({
    ...entry,
    npcName:           npcNameMap.get(entry.npcId.toString()) ?? 'NPC',
    activePokemonInfo: buildInfo(entry.activePokemonId),
  }));

  res.json({
    data: {
      ...battle,
      playerSide: playerSideWithNames,
      enemySide:  enemySideWithInfo,
    },
    error: null,
  });
});

export default router;
