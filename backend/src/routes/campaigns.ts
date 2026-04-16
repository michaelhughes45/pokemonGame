import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { requireDm } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/campaigns/mine
// Returns the current user's campaign.
//   DM/admin → the campaign where they are the DM (if any)
//   Player   → the campaign they have accepted and joined (if any)
// Returns { data: null } if the user has no campaign — not an error.
// ---------------------------------------------------------------------------
router.get('/mine', async (req: Request, res: Response): Promise<void> => {
  const { userId, role } = req.user!;

  let campaign;

  if (role === 'dm' || role === 'admin') {
    // DMs own their campaign — look it up by dmId
    campaign = await Campaign.findOne({ dmId: userId, isActive: true }).lean();
  } else {
    // Players are linked by currentCampaignId on their user document
    const user = await User.findById(userId).lean();
    if (!user?.currentCampaignId) {
      res.json({ data: null, error: null });
      return;
    }
    campaign = await Campaign.findById(user.currentCampaignId).lean();
  }

  if (!campaign) {
    res.json({ data: null, error: null });
    return;
  }

  // Fetch player details (username) so the client can display names, not just IDs
  const players = await User.find({ _id: { $in: campaign.playerIds } })
    .select('username')
    .lean();

  // Fetch usernames for pending invites too
  const inviteUserIds = campaign.pendingInvites.map(i => i.userId);
  const inviteUsers = await User.find({ _id: { $in: inviteUserIds } })
    .select('username')
    .lean();
  const inviteUsernameMap = new Map(inviteUsers.map(u => [u._id.toString(), u.username]));

  const pendingInvites = campaign.pendingInvites.map(i => ({
    userId:   i.userId,
    username: inviteUsernameMap.get(i.userId.toString()) ?? 'Unknown',
    sentAt:   i.sentAt,
  }));

  res.json({
    data: {
      _id:            campaign._id,
      name:           campaign.name,
      dmId:           campaign.dmId,
      players,
      pendingInvites,
      isActive:       campaign.isActive,
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/campaigns/invites
// Returns all campaigns this user has a pending invite to.
// Used by the player's dashboard to show the accept/decline UI.
// ---------------------------------------------------------------------------
router.get('/invites', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;

  const campaigns = await Campaign.find({
    'pendingInvites.userId': new mongoose.Types.ObjectId(userId),
    isActive: true,
  }).lean();

  // Attach the DM's username to each result so the player knows who invited them
  const result = await Promise.all(
    campaigns.map(async (c) => {
      const dm = await User.findById(c.dmId).select('username').lean();
      return {
        _id:        c._id,
        name:       c.name,
        dmUsername: dm?.username ?? 'Unknown',
      };
    })
  );

  res.json({ data: result, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/campaigns
// DM creates a new campaign. A DM can only have one active campaign at a time.
// Body: { name }
// ---------------------------------------------------------------------------
router.post('/', requireDm, async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;
  const { name } = req.body as { name?: string };

  if (!name?.trim()) {
    res.status(400).json({ data: null, error: 'Campaign name is required' });
    return;
  }

  // Prevent duplicate active campaigns for the same DM
  const existing = await Campaign.findOne({ dmId: userId, isActive: true }).lean();
  if (existing) {
    res.status(400).json({ data: null, error: 'You already have an active campaign' });
    return;
  }

  const campaign = await Campaign.create({
    name: name.trim(),
    dmId: userId,
  });

  res.status(201).json({
    data: {
      _id:  campaign._id,
      name: campaign.name,
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/invite
// DM invites a player to their campaign by username.
// Body: { username }
// Guards: player must exist, not already in a campaign, not already invited.
// ---------------------------------------------------------------------------
router.post('/invite', requireDm, async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;
  const { username } = req.body as { username?: string };

  if (!username?.trim()) {
    res.status(400).json({ data: null, error: 'username is required' });
    return;
  }

  const campaign = await Campaign.findOne({ dmId: userId, isActive: true });
  if (!campaign) {
    res.status(400).json({ data: null, error: 'You do not have an active campaign. Create one first.' });
    return;
  }

  const target = await User.findOne({ username: username.trim() }).lean();
  if (!target) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return;
  }
  if (target.role !== 'player') {
    res.status(400).json({ data: null, error: 'Only players can be invited to a campaign' });
    return;
  }
  if (target.currentCampaignId) {
    res.status(400).json({ data: null, error: `"${username}" is already in a campaign` });
    return;
  }

  const targetId = target._id as mongoose.Types.ObjectId;

  // Check if already in the campaign
  const alreadyMember = campaign.playerIds.some(id => id.toString() === targetId.toString());
  if (alreadyMember) {
    res.status(400).json({ data: null, error: `"${username}" is already in your campaign` });
    return;
  }

  // Check if already invited
  const alreadyInvited = campaign.pendingInvites.some(
    i => i.userId.toString() === targetId.toString()
  );
  if (alreadyInvited) {
    res.status(400).json({ data: null, error: `"${username}" already has a pending invite` });
    return;
  }

  campaign.pendingInvites.push({ userId: targetId, sentAt: new Date() });
  await campaign.save();

  res.json({ data: { invited: username }, error: null });
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/invite/respond
// Player accepts or declines a campaign invite.
// Body: { campaignId, action: 'accept' | 'decline' }
// On accept: player is added to playerIds, invite removed, currentCampaignId set.
// On decline: invite is simply removed.
// ---------------------------------------------------------------------------
router.post('/invite/respond', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;
  const { campaignId, action } = req.body as { campaignId?: string; action?: string };

  if (!campaignId || !action) {
    res.status(400).json({ data: null, error: 'campaignId and action are required' });
    return;
  }
  if (action !== 'accept' && action !== 'decline') {
    res.status(400).json({ data: null, error: 'action must be "accept" or "decline"' });
    return;
  }

  const campaign = await Campaign.findById(campaignId);
  if (!campaign || !campaign.isActive) {
    res.status(404).json({ data: null, error: 'Campaign not found' });
    return;
  }

  const userObjId = new mongoose.Types.ObjectId(userId);

  // Confirm the player actually has an invite to this campaign
  const inviteIndex = campaign.pendingInvites.findIndex(
    i => i.userId.toString() === userId
  );
  if (inviteIndex === -1) {
    res.status(400).json({ data: null, error: 'You do not have a pending invite to this campaign' });
    return;
  }

  // Remove the invite regardless of accept/decline
  campaign.pendingInvites.splice(inviteIndex, 1);

  if (action === 'accept') {
    // Make sure the player isn't already in another campaign
    const user = await User.findById(userId).lean();
    if (user?.currentCampaignId) {
      res.status(400).json({ data: null, error: 'You are already in a campaign. Leave it before joining another.' });
      return;
    }

    campaign.playerIds.push(userObjId);
    await campaign.save();

    // Link the campaign on the user document so we can look it up quickly
    await User.updateOne({ _id: userId }, { currentCampaignId: campaign._id });

    res.json({ data: { joined: campaign.name }, error: null });
  } else {
    await campaign.save();
    res.json({ data: { declined: campaign.name }, error: null });
  }
});

// ---------------------------------------------------------------------------
// POST /api/campaigns/leave
// Player leaves their current campaign.
// Removes them from playerIds and clears currentCampaignId.
// ---------------------------------------------------------------------------
router.post('/leave', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;

  const user = await User.findById(userId).lean();
  if (!user?.currentCampaignId) {
    res.status(400).json({ data: null, error: 'You are not in a campaign' });
    return;
  }

  const campaign = await Campaign.findById(user.currentCampaignId);
  if (!campaign) {
    // Campaign was deleted — just clear the reference
    await User.updateOne({ _id: userId }, { currentCampaignId: null });
    res.json({ data: { left: true }, error: null });
    return;
  }

  campaign.playerIds = campaign.playerIds.filter(id => id.toString() !== userId);
  await campaign.save();

  await User.updateOne({ _id: userId }, { currentCampaignId: null });

  res.json({ data: { left: campaign.name }, error: null });
});

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/players/:username
// DM removes a player from their campaign.
// Also clears the player's currentCampaignId.
// ---------------------------------------------------------------------------
router.delete('/players/:username', requireDm, async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.user!;
  const { username } = req.params;

  const campaign = await Campaign.findOne({ dmId: userId, isActive: true });
  if (!campaign) {
    res.status(400).json({ data: null, error: 'You do not have an active campaign' });
    return;
  }

  const target = await User.findOne({ username }).lean();
  if (!target) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return;
  }

  const targetId = (target._id as mongoose.Types.ObjectId).toString();
  const wasMember = campaign.playerIds.some(id => id.toString() === targetId);
  if (!wasMember) {
    res.status(400).json({ data: null, error: `"${username}" is not in your campaign` });
    return;
  }

  campaign.playerIds = campaign.playerIds.filter(id => id.toString() !== targetId);
  await campaign.save();

  await User.updateOne({ _id: target._id }, { currentCampaignId: null });

  res.json({ data: { removed: username }, error: null });
});

export default router;
