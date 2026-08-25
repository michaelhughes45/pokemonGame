import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Campaign } from '../models/Campaign';
import { User } from '../models/User';
import { getEffectiveLevelCap, unlockPendingLevelUpsForPlayer } from '../lib/levelCap';
import { SHOP_PRICES, getSellPrice } from '../lib/shopData';
import { getPocket, RANDOM_HELD_ITEM_POOL, MINT_ITEMS } from '../lib/itemData';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

async function findActiveCampaignByDm(userId: string) {
  return Campaign.findOne({ dmId: userId, isActive: true });
}

// Shared prefix for every campaign-flag toggle route (level cap, field mode,
// hidden abilities): validates the request body's `enabled` boolean and loads
// the calling DM's active campaign. Returns null (having already sent the
// error response) when either check fails, so callers just `if (!loaded) return;`.
async function loadCampaignForFlagToggle(req: Request, res: Response) {
  const { userId } = req.user!;
  const { enabled } = req.body as { enabled?: boolean };

  if (typeof enabled !== 'boolean') {
    sendError(res, 400, 'enabled must be a boolean');
    return null;
  }

  const campaign = await findActiveCampaignByDm(userId);
  if (!campaign) {
    sendError(res, 400, 'You do not have an active campaign');
    return null;
  }

  return { enabled, campaign };
}

// Factory for the two campaign flags that are a plain "set the field, save,
// echo it back" toggle with no side effects (unlike setLevelCapEnabled below,
// which also replays banked exp — kept explicit rather than forced into this shape).
function makeCampaignFlagToggle(field: 'fieldModeEnabled' | 'hiddenAbilitiesEnabled') {
  return async function (req: Request, res: Response): Promise<void> {
    const loaded = await loadCampaignForFlagToggle(req, res);
    if (!loaded) return;
    const { enabled, campaign } = loaded;

    campaign[field] = enabled;
    await campaign.save();

    sendOk(res, { [field]: campaign[field] });
  };
}

async function findUserByUsername(username: string) {
  return User.findOne({ username }).lean();
}

async function removePlayerFromCampaign(
  campaign: InstanceType<typeof Campaign>,
  playerId: string | mongoose.Types.ObjectId,
): Promise<void> {
  campaign.playerIds = campaign.playerIds.filter(id => !id.equals(playerId));
  await campaign.save();
  await User.updateOne({ _id: playerId }, { currentCampaignId: null });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/mine
// Returns the current user's campaign.
//   DM/admin → the campaign where they are the DM (if any)
//   Player   → the campaign they have accepted and joined (if any)
// Returns { data: null } if the user has no campaign — not an error.
// ---------------------------------------------------------------------------
export async function getMine(req: Request, res: Response): Promise<void> {
  const { userId, role } = req.user!;

  let campaign;

  if (role === 'dm' || role === 'admin') {
    campaign = await findActiveCampaignByDm(userId);
  } else {
    const user = await User.findById(userId).lean();
    if (!user?.currentCampaignId) return sendOk(res, null);
    campaign = await Campaign.findById(user.currentCampaignId);
  }

  if (!campaign) return sendOk(res, null);

  const players = await User.find({ _id: { $in: campaign.playerIds } })
    .select('username')
    .lean();

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

  sendOk(res, {
    _id:             campaign._id,
    name:            campaign.name,
    dmId:            campaign.dmId,
    players,
    pendingInvites,
    isActive:         campaign.isActive,
    levelCapEnabled:  campaign.levelCapEnabled,
    fieldModeEnabled: campaign.fieldModeEnabled,
    hiddenAbilitiesEnabled: campaign.hiddenAbilitiesEnabled,
    shopItemIds:      campaign.shopItemIds,
    randomHeldItemIds: campaign.randomHeldItemIds,
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/invites
// Returns all campaigns this user has a pending invite to.
// Used by the player's dashboard to show the accept/decline UI.
// ---------------------------------------------------------------------------
export async function getInvites(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;

  const campaigns = await Campaign.find({
    'pendingInvites.userId': new mongoose.Types.ObjectId(userId),
    isActive: true,
  }).lean();

  // Batch-fetch all DMs in one query instead of one per campaign
  const dmIds = campaigns.map(c => c.dmId);
  const dms = await User.find({ _id: { $in: dmIds } }).select('username').lean();
  const dmMap = new Map(dms.map(d => [d._id.toString(), d.username]));

  const result = campaigns.map(c => ({
    _id:        c._id,
    name:       c.name,
    dmUsername: dmMap.get(c.dmId.toString()) ?? 'Unknown',
  }));

  sendOk(res, result);
}

// ---------------------------------------------------------------------------
// POST /api/campaigns
// DM creates a new campaign. A DM can only have one active campaign at a time.
// Body: { name }
// ---------------------------------------------------------------------------
export async function createCampaign(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { name } = req.body as { name?: string };

  if (!name?.trim()) {
    return sendError(res, 400, 'Campaign name is required');
  }

  const existing = await findActiveCampaignByDm(userId);
  if (existing) {
    return sendError(res, 400, 'You already have an active campaign');
  }

  const campaign = await Campaign.create({ name: name.trim(), dmId: userId });

  sendOk(res, { _id: campaign._id, name: campaign.name }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/invite
// DM invites a player to their campaign by username.
// Body: { username }
// Guards: player must exist, not already in a campaign, not already invited.
// ---------------------------------------------------------------------------
export async function invitePlayer(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { username } = req.body as { username?: string };

  if (!username?.trim()) {
    return sendError(res, 400, 'username is required');
  }

  const campaign = await findActiveCampaignByDm(userId);
  if (!campaign) {
    return sendError(res, 400, 'You do not have an active campaign. Create one first.');
  }

  const target = await findUserByUsername(username.trim());
  if (!target) {
    return sendError(res, 404, `Player "${username}" not found`);
  }
  if (target.role !== 'player') {
    return sendError(res, 400, 'Only players can be invited to a campaign');
  }
  if (target.currentCampaignId) {
    return sendError(res, 400, `"${username}" is already in a campaign`);
  }

  const targetId = target._id as mongoose.Types.ObjectId;

  if (campaign.playerIds.some(id => id.equals(targetId))) {
    return sendError(res, 400, `"${username}" is already in your campaign`);
  }
  if (campaign.pendingInvites.some(i => i.userId.equals(targetId))) {
    return sendError(res, 400, `"${username}" already has a pending invite`);
  }

  campaign.pendingInvites.push({ userId: targetId, sentAt: new Date() });
  await campaign.save();

  sendOk(res, { invited: username });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/invite/respond
// Player accepts or declines a campaign invite.
// Body: { campaignId, action: 'accept' | 'decline' }
// On accept: player is added to playerIds, invite removed, currentCampaignId set.
// On decline: invite is simply removed.
// ---------------------------------------------------------------------------
export async function respondToInvite(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { campaignId, action } = req.body as { campaignId?: string; action?: string };

  if (!campaignId || !action) {
    return sendError(res, 400, 'campaignId and action are required');
  }
  if (action !== 'accept' && action !== 'decline') {
    return sendError(res, 400, 'action must be "accept" or "decline"');
  }

  const campaign = await Campaign.findById(campaignId);
  if (!campaign || !campaign.isActive) {
    return sendError(res, 404, 'Campaign not found');
  }

  const inviteIndex = campaign.pendingInvites.findIndex(i => i.userId.equals(userId));
  if (inviteIndex === -1) {
    return sendError(res, 400, 'You do not have a pending invite to this campaign');
  }

  campaign.pendingInvites.splice(inviteIndex, 1);

  if (action === 'accept') {
    const user = await User.findById(userId).lean();
    if (user?.currentCampaignId) {
      return sendError(res, 400, 'You are already in a campaign. Leave it before joining another.');
    }

    campaign.playerIds.push(new mongoose.Types.ObjectId(userId));
    await campaign.save();
    await User.updateOne({ _id: userId }, { currentCampaignId: campaign._id });

    sendOk(res, { joined: campaign.name });
  } else {
    await campaign.save();
    sendOk(res, { declined: campaign.name });
  }
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/leave
// Player leaves their current campaign.
// Removes them from playerIds and clears currentCampaignId.
// ---------------------------------------------------------------------------
export async function leaveCampaign(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;

  const user = await User.findById(userId).lean();
  if (!user?.currentCampaignId) {
    return sendError(res, 400, 'You are not in a campaign');
  }

  const campaign = await Campaign.findById(user.currentCampaignId);
  if (!campaign) {
    // Campaign was deleted — just clear the dangling reference
    await User.updateOne({ _id: userId }, { currentCampaignId: null });
    return sendOk(res, { left: true });
  }

  await removePlayerFromCampaign(campaign, userId);
  sendOk(res, { left: campaign.name });
}

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/players/:username
// DM removes a player from their campaign.
// Also clears the player's currentCampaignId.
// ---------------------------------------------------------------------------
export async function removePlayer(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const username = String(req.params.username);

  const campaign = await findActiveCampaignByDm(userId);
  if (!campaign) {
    return sendError(res, 400, 'You do not have an active campaign');
  }

  const target = await findUserByUsername(username);
  if (!target) {
    return sendError(res, 404, `Player "${username}" not found`);
  }

  const targetId = target._id as mongoose.Types.ObjectId;

  if (!campaign.playerIds.some(id => id.equals(targetId))) {
    return sendError(res, 400, `"${username}" is not in your campaign`);
  }

  await removePlayerFromCampaign(campaign, targetId);
  sendOk(res, { removed: username });
}

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/level-cap
// DM toggles the campaign-wide level cap system on/off.
// Body: { enabled: boolean }
// ---------------------------------------------------------------------------
export async function setLevelCapEnabled(req: Request, res: Response): Promise<void> {
  const loaded = await loadCampaignForFlagToggle(req, res);
  if (!loaded) return;
  const { enabled, campaign } = loaded;

  campaign.levelCapEnabled = enabled;
  await campaign.save();

  // The cap may have just risen (disabled entirely, or re-enabled at a lower value
  // than a player's banked exp already supports) — replay each player's banked exp
  // against their new cap so any pending level-ups/evolutions unlock immediately.
  const owners = await User.find({ _id: { $in: campaign.playerIds } }, 'badges').lean();
  let unlockedCount = 0;
  for (const owner of owners) {
    const cap = getEffectiveLevelCap(owner.badges?.length ?? 0, campaign.levelCapEnabled);
    unlockedCount += await unlockPendingLevelUpsForPlayer(owner._id, cap);
  }

  sendOk(res, { levelCapEnabled: campaign.levelCapEnabled, unlockedCount });
}

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/field-mode
// DM toggles the campaign between Town mode (accessible) and Field mode
// (blocks players from /pc and /town — enforced client-side per route).
// Body: { enabled: boolean }
// ---------------------------------------------------------------------------
export const setFieldModeEnabled = makeCampaignFlagToggle('fieldModeEnabled');

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/hidden-abilities
// ---------------------------------------------------------------------------
export const setHiddenAbilitiesEnabled = makeCampaignFlagToggle('hiddenAbilitiesEnabled');

// ---------------------------------------------------------------------------
// GET /api/campaigns/shop-catalog
// Any authenticated user. Returns every item that has a real Pokémart price
// (lib/shopData.ts), with its pocket and buy/sell price — the DM uses it to
// pick which ones are for sale (cross-referenced against Campaign.shopItemIds
// client-side); players use the same data to show Pokémart prices. Not
// campaign-specific — the priced catalog itself is global.
// ---------------------------------------------------------------------------
export async function getShopCatalog(_req: Request, res: Response): Promise<void> {
  const catalog = Object.keys(SHOP_PRICES).map(itemId => ({
    itemId,
    pocket:    getPocket(itemId),
    buyPrice:  SHOP_PRICES[itemId],
    sellPrice: getSellPrice(itemId),
  }));

  sendOk(res, catalog);
}

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/shop-items
// DM sets which items are currently for sale in their campaign's Pokémart.
// Body: { itemIds: string[] } — full replace, not incremental. Anything not
// a real priced item (stale client state, typo, etc.) is silently dropped.
// ---------------------------------------------------------------------------
export async function setShopItems(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { itemIds } = req.body as { itemIds?: string[] };

  if (!Array.isArray(itemIds)) {
    return sendError(res, 400, 'itemIds must be an array');
  }

  const campaign = await findActiveCampaignByDm(userId);
  if (!campaign) {
    return sendError(res, 400, 'You do not have an active campaign');
  }

  const validItemIds = [...new Set(itemIds)].filter(id => id in SHOP_PRICES);
  campaign.shopItemIds = validItemIds;
  await campaign.save();

  sendOk(res, { shopItemIds: campaign.shopItemIds });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/held-item-catalog
// Milestone 6.8. Any authenticated user, same reasoning as getShopCatalog —
// not campaign-specific. Returns the full pool rollHeldItem (lib/itemData.ts)
// draws from: every item in the catalog (berries, medicine, Poké Balls,
// evolution stones, held_type/held_battle items, everything) plus all 25
// mints. The DM curates a subset of this against Campaign.randomHeldItemIds
// client-side, same flow as the Pokémart catalog.
// ---------------------------------------------------------------------------
export async function getHeldItemCatalog(_req: Request, res: Response): Promise<void> {
  const catalog = [...RANDOM_HELD_ITEM_POOL, ...MINT_ITEMS].map(itemId => ({
    itemId,
    pocket: getPocket(itemId),
  }));

  sendOk(res, catalog);
}

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/random-held-items
// Milestone 6.8. DM sets which items wild/NPC Pokémon in their campaign can
// randomly hold. Body: { itemIds: string[] | null } — full replace, not
// incremental. null resets to "uncurated" (every eligible item in play, this
// project's pre-6.8 behavior); an empty array is a real, distinct choice —
// the DM deliberately wants nothing to ever be rolled. Anything not a real
// item in the pool (stale client state, typo, etc.) is silently dropped from
// a non-null array.
// ---------------------------------------------------------------------------
export async function setRandomHeldItems(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { itemIds } = req.body as { itemIds?: string[] | null };

  if (itemIds !== null && !Array.isArray(itemIds)) {
    return sendError(res, 400, 'itemIds must be an array or null');
  }

  const campaign = await findActiveCampaignByDm(userId);
  if (!campaign) {
    return sendError(res, 400, 'You do not have an active campaign');
  }

  const fullPool = new Set([...RANDOM_HELD_ITEM_POOL, ...MINT_ITEMS]);
  campaign.randomHeldItemIds = itemIds === null
    ? null
    : [...new Set(itemIds)].filter(id => fullPool.has(id));
  await campaign.save();

  sendOk(res, { randomHeldItemIds: campaign.randomHeldItemIds });
}
