import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Battle } from '../models/Battle';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';

const router = Router();

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

  // Verify the DM has an active campaign
  const campaign = await Campaign.findOne({
    dmId: req.user!.userId,
    isActive: true,
  }).lean();
  if (!campaign) {
    res.status(403).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  // Validate that every supplied playerId is a member of the campaign
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
