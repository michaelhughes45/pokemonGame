import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { Item } from '../models/Item';
import { Campaign } from '../models/Campaign';
import { Npc } from '../models/Npc';
import { Encounter } from '../models/Encounter';
import { Battle } from '../models/Battle';
import { getPocket, moveIdFromTmItem, natureFromMintItem, rollHeldItem } from '../lib/itemData';
import { isTmHmMove, TM_HM_MOVES } from '../lib/tmHmData';
import { fetchSpecies } from '../lib/pokeapi';
import { computeStats, expForLevel, BaseStats, NATURES, ZERO_EVS, ZERO_IVS } from '../lib/statCalc';
import { canEvolve } from '../lib/evolution';
import { resolveEvolvedSpecies } from '../lib/evolutionResolve';
import { healPartyPokemon } from '../lib/healParty';
import { slugToDisplayName } from '../lib/battleCalc';
import { applyLevelUpLoop, getPlayerEffectiveLevelCap, unlockPendingLevelUpsForPlayer } from '../lib/levelCap';
import { getAutoLearnedMoves } from '../lib/moveLearning';
import { BADGE_CATALOG } from '../lib/badgeData';
import { EV_STAT_CAP, EV_TOTAL_CAP, EV_STAT_DISPLAY_NAMES } from '../lib/evData';
import { ivsFromSpread, getUnspentTrainerIv, getIvsForOwner } from '../lib/trainerIv';
import { fixAllPokemonExp } from '../lib/fixPokemonExp';
import { AI_STRATEGIES } from '../lib/npcAi';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LeanCampaign = {
  _id: mongoose.Types.ObjectId;
  playerIds: mongoose.Types.ObjectId[];
  [key: string]: unknown;
};

type LevelUpMoveEntry = { moveId: string; level: number };
type MoveEntry        = { name: string; pp: number | null };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

// Returns the DM's active campaign or sends a 403 and returns null.
async function assertDmCampaign(dmUserId: string, res: Response): Promise<LeanCampaign | null> {
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean();
  if (!campaign) {
    sendError(res, 403, 'You do not have an active campaign');
    return null;
  }
  return campaign as LeanCampaign;
}

// Verifies the DM has an active campaign and the target username is a member.
// Returns the target user document or null (after sending the appropriate error).
async function assertCampaignPlayer(
  dmUserId: string,
  username: string,
  res: Response,
): Promise<{ _id: mongoose.Types.ObjectId; [key: string]: unknown } | null> {
  const campaign = await assertDmCampaign(dmUserId, res);
  if (!campaign) return null;

  const target = await User.findOne({ username }).lean();
  if (!target) {
    sendError(res, 404, `Player "${username}" not found`);
    return null;
  }

  const targetId = (target._id as mongoose.Types.ObjectId).toString();
  if (!campaign.playerIds.some(id => id.toString() === targetId)) {
    sendError(res, 403, `"${username}" is not in your campaign`);
    return null;
  }

  return target as { _id: mongoose.Types.ObjectId; [key: string]: unknown };
}

// Validates an NPC ID, verifies the DM's campaign, and confirms the NPC belongs to it.
// Returns the hydrated Npc document (needed for party.push/save callers) or null.
async function assertDmNpc(
  dmUserId: string,
  npcId: string,
  res: Response,
): Promise<InstanceType<typeof Npc> | null> {
  if (!mongoose.Types.ObjectId.isValid(npcId)) {
    sendError(res, 400, 'Invalid NPC ID');
    return null;
  }
  const campaign = await assertDmCampaign(dmUserId, res);
  if (!campaign) return null;
  const npc = await Npc.findOne({ _id: npcId, campaignId: campaign._id });
  if (!npc) {
    sendError(res, 404, 'NPC not found in your campaign');
    return null;
  }
  return npc;
}

// Verifies the DM has an active campaign and owns the given Pokémon via campaign membership.
async function assertDmOwnsPokemon(
  dmUserId: string,
  pokemonId: string,
  res: Response,
): Promise<InstanceType<typeof Pokemon> | null> {
  const campaign = await assertDmCampaign(dmUserId, res);
  if (!campaign) return null;

  if (!mongoose.Types.ObjectId.isValid(pokemonId)) {
    sendError(res, 400, 'Invalid Pokémon ID');
    return null;
  }

  const pokemon = await Pokemon.findById(pokemonId);
  if (!pokemon || pokemon.ownerType !== 'player') {
    sendError(res, 404, 'Pokémon not found');
    return null;
  }

  if (!campaign.playerIds.some(id => id.toString() === pokemon.ownerId.toString())) {
    sendError(res, 403, 'That Pokémon does not belong to a player in your campaign');
    return null;
  }

  return pokemon;
}

// Validates an encounter ID and verifies it belongs to the DM's active campaign.
// Returns { encounter, campaign } so callers avoid a second campaign query.
async function assertDmEncounter(dmUserId: string, encounterId: string, res: Response) {
  if (!mongoose.Types.ObjectId.isValid(encounterId)) {
    sendError(res, 400, 'Invalid encounter ID');
    return null;
  }
  const campaign = await Campaign.findOne({ dmId: dmUserId, isActive: true }).lean() as LeanCampaign | null;
  if (!campaign) {
    sendError(res, 403, 'You do not have an active campaign');
    return null;
  }
  const encounter = await Encounter.findOne({
    _id:        encounterId,
    campaignId: campaign._id,
  }).lean();
  if (!encounter) {
    sendError(res, 404, 'Encounter not found in your campaign');
    return null;
  }
  return { encounter, campaign };
}

// Looks up a species from the PokedexCache, fetching from PokeAPI when absent.
// Also refreshes levelUpMoves/machineMoves/moves if either is missing from an
// existing cache entry (covers entries cached before machineMoves existed).
// Returns the species document or null (after sending a 404).
async function resolveSpeciesDoc(species: string | number, res: Response) {
  const isNumeric   = /^\d+$/.test(String(species));
  const lookupQuery = isNumeric ? { pokeApiId: Number(species) } : { name: String(species).toLowerCase() };
  const fetchKey    = isNumeric ? Number(species) : String(species).toLowerCase();

  let speciesDoc = await PokedexCache.findOne(lookupQuery).lean();

  if (!speciesDoc) {
    try {
      const transformed = await fetchSpecies(fetchKey);
      speciesDoc = (await PokedexCache.create(transformed)).toObject();
    } catch {
      sendError(res, 404, `Species "${species}" not found in PokeAPI.`);
      return null;
    }
  } else if (!speciesDoc.levelUpMoves?.length || !speciesDoc.machineMoves?.length) {
    try {
      const transformed = await fetchSpecies(fetchKey);
      await PokedexCache.updateOne(
        { pokeApiId: transformed.pokeApiId },
        { $set: {
          levelUpMoves: transformed.levelUpMoves,
          machineMoves: transformed.machineMoves,
          moves:        transformed.moves,
        } },
      );
      // Cast to any: lean() returns a plain object at runtime; this is purely a TS annotation issue.
      (speciesDoc as any).levelUpMoves = transformed.levelUpMoves;
      (speciesDoc as any).machineMoves = transformed.machineMoves;
      (speciesDoc as any).moves        = transformed.moves;
    } catch {
      // non-fatal — Pokémon will be created without learnable moves
    }
  }

  return speciesDoc;
}

// Derives gender from species data, with an optional explicit override.
function resolveGender(
  genderRatio: number,
  requestedGender?: string,
): 'male' | 'female' | 'none' {
  if (requestedGender === 'male' || requestedGender === 'female' || requestedGender === 'none') {
    return requestedGender;
  }
  if (genderRatio === -1) return 'none';   // genderless species (Magnemite, etc.)
  if (genderRatio === 0)  return 'female'; // always female (Chansey, etc.)
  return 'male';
}

// Derives the last 4 level-up moves learnable at or below the given level.
function deriveStartingMoves(
  speciesDoc: { levelUpMoves?: unknown; moves?: unknown },
  level: number,
) {
  const levelUpMoves  = (speciesDoc.levelUpMoves ?? []) as LevelUpMoveEntry[];
  const moveEntries   = (speciesDoc.moves         ?? []) as MoveEntry[];
  const moveDetailMap = new Map(moveEntries.map(m => [m.name, m]));

  return levelUpMoves
    .filter(m => m.level <= level && m.level > 0)
    .slice(-4)
    .map(entry => {
      const detail = moveDetailMap.get(entry.moveId);
      return { moveId: entry.moveId, currentPP: detail?.pp ?? 10, maxPP: detail?.pp ?? 10, ppUps: 0 };
    });
}

// Resolves the pocket for an item slug; sends a 400 and returns null if unrecognised.
// For TM/HM items ("tm-<moveId>"), also rejects moves that have never actually
// been released as a real TM/HM in any game (checked against lib/tmHmData.ts).
// For mint items ("mint-<nature>"), rejects anything that isn't one of the 25 real natures.
function resolveItemPocket(itemId: string, res: Response): string | null {
  const pocket = getPocket(itemId);
  if (!pocket) {
    sendError(res, 400,
      `"${itemId}" is not a recognised item. Check the PokeAPI slug (e.g. "super-potion", "poke-ball").`,
    );
    return null;
  }
  if (pocket === 'tm_hm') {
    const moveId = moveIdFromTmItem(itemId);
    if (!moveId || !isTmHmMove(moveId)) {
      sendError(res, 400, `"${moveId ?? itemId}" has never been released as a TM/HM in any game.`);
      return null;
    }
  }
  if (pocket === 'mint' && !natureFromMintItem(itemId)) {
    sendError(res, 400, `"${itemId}" is not a recognised mint. Expected "mint-<nature>", e.g. "mint-bold".`);
    return null;
  }
  return pocket;
}

// Shared by every give-item route (player/campaign/NPC) — the 1–99 cap matches
// this project's item-quantity convention everywhere else.
function assertValidGiveQuantity(quantity: number, res: Response): boolean {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    sendError(res, 400, 'quantity must be an integer between 1 and 99');
    return false;
  }
  return true;
}

// Shared by every give-money route (player/campaign) — deliberately not capped
// like items, since money grants are commonly in the thousands.
function assertValidMoneyAmount(amount: unknown, res: Response): amount is number {
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
    sendError(res, 400, 'amount must be a positive integer');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// DELETE /api/dm/players/:username/starter
// Deletes all Pokémon belonging to the player so they can pick a new starter.
// ---------------------------------------------------------------------------
export async function deletePlayerStarter(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  const result = await Pokemon.deleteMany({ ownerId: user._id });
  sendOk(res, { deleted: result.deletedCount, username });
}

// ---------------------------------------------------------------------------
// DELETE /api/dm/players/:username/trainer-stat
// Clears a player's one-time Trainer IV stat choice so they can pick again.
// ---------------------------------------------------------------------------
export async function resetPlayerTrainerStat(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  await User.updateOne({ _id: user._id }, { trainerStats: {} });
  sendOk(res, { message: `Reset all of ${username}'s Trainer IV points`, username });
}

// ---------------------------------------------------------------------------
// POST /api/dm/players/:username/pokemon
// DM gives a Pokémon directly to a player. Slots into party if there's room
// (max 6), otherwise goes to the player's PC.
// Body: { species, level?, nature?, gender? }
// ---------------------------------------------------------------------------
export async function givePlayerPokemon(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const { species, level = 5, nature: rawNature = 'random', gender } = req.body as {
    species: string | number;
    level?: number;
    nature?: string;
    gender?: string;
  };

  const nature = rawNature.toLowerCase() === 'random'
    ? NATURES[Math.floor(Math.random() * NATURES.length)]
    : rawNature;

  if (!species && species !== 0) {
    return sendError(res, 400, 'species is required (name or dex number)');
  }
  if (!NATURES.includes(nature)) {
    return sendError(res, 400, `Invalid nature. Valid values: ${NATURES.join(', ')}`);
  }

  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  const speciesDoc = await resolveSpeciesDoc(species, res);
  if (!speciesDoc) return;

  // Gen 3+ HP formula (no IVs/EVs until Phase 5)
  const maxHp         = Math.floor((2 * speciesDoc.baseStats.hp * level) / 100) + level + 10;
  const resolvedGender = resolveGender(speciesDoc.genderRatio as number, gender);
  const moves          = deriveStartingMoves(speciesDoc, level);
  const partyCount = await Pokemon.countDocuments({ ownerId: user._id, isInParty: true });
  const hasRoom     = partyCount < 6;

  const pokemon = await Pokemon.create({
    speciesId: speciesDoc.pokeApiId,
    ownerId:   user._id,
    ownerType: 'player',
    nickname:  null,
    level,
    exp:       expForLevel(level, (speciesDoc.expGroup as string) || 'medium-fast'),
    currentHp: maxHp,
    nature,
    gender:    resolvedGender,
    heldItem:  null,
    moves,
    isInParty: hasRoom,
    partySlot: hasRoom ? partyCount + 1 : null,
  });

  sendOk(res, {
    _id:         pokemon._id,
    speciesId:   pokemon.speciesId,
    speciesName: speciesDoc.name,
    level:       pokemon.level,
    nature:      pokemon.nature,
    gender:      pokemon.gender,
    isInParty:   pokemon.isInParty,
    partySlot:   pokemon.partySlot,
  }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/items/give
// Give items directly to a player's bag.
// Body: { username, itemId, quantity? }
// ---------------------------------------------------------------------------
export async function givePlayerItem(req: Request, res: Response): Promise<void> {
  const { username, itemId, quantity = 1 } = req.body as {
    username?: string;
    itemId?: string;
    quantity?: number;
  };

  if (!username?.trim()) {
    return sendError(res, 400, 'username is required');
  }
  if (!itemId?.trim()) {
    return sendError(res, 400, 'itemId is required');
  }
  if (!assertValidGiveQuantity(quantity, res)) return;

  const pocket = resolveItemPocket(itemId.trim(), res);
  if (!pocket) return;

  const user = await assertCampaignPlayer(req.user!.userId, username.trim(), res);
  if (!user) return;

  const item = await Item.findOneAndUpdate(
    { ownerId: user._id, itemId: itemId.trim() },
    { $inc: { quantity }, $setOnInsert: { pocket } },
    { upsert: true, new: true },
  );

  sendOk(res, { itemId: item.itemId, quantity: item.quantity, pocket: item.pocket, username }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/campaign/items/give
// Give the same item to every player in the DM's active campaign at once —
// each player still gets their own independent Item doc/quantity, exactly
// like givePlayerItem, just looped across the whole roster in one action.
// Body: { itemId, quantity? }
// ---------------------------------------------------------------------------
export async function giveCampaignItem(req: Request, res: Response): Promise<void> {
  const { itemId, quantity = 1 } = req.body as {
    itemId?: string;
    quantity?: number;
  };

  if (!itemId?.trim()) {
    return sendError(res, 400, 'itemId is required');
  }
  if (!assertValidGiveQuantity(quantity, res)) return;

  const pocket = resolveItemPocket(itemId.trim(), res);
  if (!pocket) return;

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  if (campaign.playerIds.length === 0) {
    return sendError(res, 400, 'Your campaign has no players yet');
  }

  await Promise.all(campaign.playerIds.map(playerId =>
    Item.findOneAndUpdate(
      { ownerId: playerId, itemId: itemId.trim() },
      { $inc: { quantity }, $setOnInsert: { pocket } },
      { upsert: true },
    ),
  ));

  sendOk(res, { itemId: itemId.trim(), quantity, pocket, playerCount: campaign.playerIds.length }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/money/give
// Give Pokédollars directly to one player. Deliberately separate from the
// item system so it isn't bound by the 1–99 item quantity cap — money grants
// are commonly in the thousands, matching Pokémart prices.
// Body: { username, amount }
// ---------------------------------------------------------------------------
export async function givePlayerMoney(req: Request, res: Response): Promise<void> {
  const { username, amount } = req.body as { username?: string; amount?: number };

  if (!username?.trim()) {
    return sendError(res, 400, 'username is required');
  }
  if (!assertValidMoneyAmount(amount, res)) return;

  const user = await assertCampaignPlayer(req.user!.userId, username.trim(), res);
  if (!user) return;

  const updated = await User.findByIdAndUpdate(user._id, { $inc: { money: amount } }, { new: true });

  sendOk(res, { username: username.trim(), amount, money: updated!.money }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/campaign/money/give
// Give the same amount of Pokédollars to every player in the DM's active
// campaign at once — mirrors giveCampaignItem's bulk pattern.
// Body: { amount }
// ---------------------------------------------------------------------------
export async function giveCampaignMoney(req: Request, res: Response): Promise<void> {
  const { amount } = req.body as { amount?: number };

  if (!assertValidMoneyAmount(amount, res)) return;

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  if (campaign.playerIds.length === 0) {
    return sendError(res, 400, 'Your campaign has no players yet');
  }

  await User.updateMany({ _id: { $in: campaign.playerIds } }, { $inc: { money: amount } });

  sendOk(res, { amount, playerCount: campaign.playerIds.length }, 201);
}

// ---------------------------------------------------------------------------
// GET /api/dm/tm-hm-moves
// Returns the full static catalog of moves that have ever been a real TM/HM,
// so the DM's give-item UI can search/pick one client-side. Static reference
// data (see lib/tmHmData.ts) — no campaign scoping needed.
// ---------------------------------------------------------------------------
export async function getTmHmCatalog(_req: Request, res: Response): Promise<void> {
  sendOk(res, TM_HM_MOVES);
}

// ---------------------------------------------------------------------------
// GET /api/dm/badges
// Returns the full hardcoded badge catalog (all regions) so the DM can pick
// which badge to award. Static reference data — no campaign scoping needed.
// ---------------------------------------------------------------------------
export async function getBadgeCatalog(_req: Request, res: Response): Promise<void> {
  sendOk(res, BADGE_CATALOG);
}

// ---------------------------------------------------------------------------
// POST /api/dm/players/:username/badges
// Awards a badge to a player in the DM's campaign — badgeId may come from
// the hardcoded catalog or from the campaign's own customBadges.
// Body: { badgeId }
// ---------------------------------------------------------------------------
export async function awardBadge(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const { badgeId } = req.body as { badgeId?: string };

  if (!badgeId?.trim()) {
    return sendError(res, 400, 'badgeId is required');
  }

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const customBadges = (campaign.customBadges ?? []) as { badgeId: string; name: string; imageUrl: string }[];
  const entry = BADGE_CATALOG.find(b => b.badgeId === badgeId.trim())
    ?? customBadges.find(b => b.badgeId === badgeId.trim());
  if (!entry) {
    return sendError(res, 400, `"${badgeId}" is not a recognised badge`);
  }

  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  const existingBadges = (user.badges ?? []) as { badgeId: string }[];
  if (existingBadges.some(b => b.badgeId === entry.badgeId)) {
    return sendOk(res, { message: `${username} already has the ${entry.name}` });
  }

  await User.updateOne(
    { _id: user._id },
    { $push: { badges: {
      badgeId:   entry.badgeId,
      name:      entry.name,
      imageUrl:  entry.imageUrl,
      awardedAt: new Date(),
    } } },
  );

  // A new badge can only raise this player's effective level cap (never lower
  // it), so replay their roster's banked exp against the new cap — any
  // Pokémon that already had enough exp banked levels/evolves immediately
  // instead of waiting for the next battle or DM action to touch it.
  const newCap = await getPlayerEffectiveLevelCap(user._id);
  const unlockedCount = await unlockPendingLevelUpsForPlayer(user._id, newCap);

  sendOk(res, { message: `Awarded ${entry.name} to ${username}`, unlockedCount }, 201);
}

// ---------------------------------------------------------------------------
// DELETE /api/dm/players/:username/badges/:badgeId
// Revokes a previously-awarded badge from a player in the DM's campaign.
// ---------------------------------------------------------------------------
export async function revokeBadge(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const badgeId  = String(req.params.badgeId);

  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  const result = await User.updateOne({ _id: user._id }, { $pull: { badges: { badgeId } } });
  if (result.modifiedCount === 0) {
    return sendOk(res, { message: `${username} does not have that badge` });
  }

  sendOk(res, { message: `Revoked ${badgeId} from ${username}` });
}

// ---------------------------------------------------------------------------
// GET /api/dm/badges/custom
// Returns the DM's campaign-scoped custom badges (homebrew gyms).
// ---------------------------------------------------------------------------
export async function getCustomBadges(req: Request, res: Response): Promise<void> {
  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  sendOk(res, campaign.customBadges ?? []);
}

// ---------------------------------------------------------------------------
// POST /api/dm/badges/custom
// Defines a new homebrew badge scoped to the DM's active campaign.
// Body: { name, imageUrl }
// ---------------------------------------------------------------------------
export async function createCustomBadge(req: Request, res: Response): Promise<void> {
  const { name, imageUrl } = req.body as { name?: string; imageUrl?: string };

  if (!name?.trim()) {
    return sendError(res, 400, 'name is required');
  }
  if (!imageUrl?.trim()) {
    return sendError(res, 400, 'imageUrl is required');
  }

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const entry = {
    badgeId:   `custom-${new mongoose.Types.ObjectId().toString()}`,
    name:      name.trim(),
    imageUrl:  imageUrl.trim(),
    createdAt: new Date(),
  };

  await Campaign.updateOne({ _id: campaign._id }, { $push: { customBadges: entry } });

  sendOk(res, entry, 201);
}

// ---------------------------------------------------------------------------
// DELETE /api/dm/badges/custom/:badgeId
// Removes a homebrew badge definition from the DM's campaign. Does not
// retroactively remove it from players who were already awarded it — a
// player's badges are a denormalized copy, same as catalog badges.
// ---------------------------------------------------------------------------
export async function deleteCustomBadge(req: Request, res: Response): Promise<void> {
  const badgeId = String(req.params.badgeId);

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const result = await Campaign.updateOne(
    { _id: campaign._id },
    { $pull: { customBadges: { badgeId } } },
  );
  if (result.modifiedCount === 0) {
    return sendOk(res, { message: 'No custom badge with that ID was found' });
  }

  sendOk(res, { message: `Removed custom badge ${badgeId}` });
}

// ---------------------------------------------------------------------------
// GET /api/dm/npcs
// Returns all NPCs belonging to the DM's active campaign.
// Returns { data: [] } (not a 403) when the DM has no campaign yet.
// ---------------------------------------------------------------------------
export async function getNpcs(req: Request, res: Response): Promise<void> {
  const campaign = await Campaign.findOne({ dmId: req.user!.userId, isActive: true }).lean();
  if (!campaign) {
    return sendOk(res, []);
  }

  const npcs = await Npc.find({ campaignId: campaign._id })
    .select('name type party aiStrategy')
    .lean();

  sendOk(res, npcs.map(n => ({
    _id:        n._id,
    name:       n.name,
    type:       n.type,
    partyCount: n.party.length,
    aiStrategy: n.aiStrategy,
  })));
}

// ---------------------------------------------------------------------------
// POST /api/dm/npcs
// Creates a new NPC in the DM's active campaign.
// Body: { name, type?, aiStrategy? }
// ---------------------------------------------------------------------------
export async function createNpc(req: Request, res: Response): Promise<void> {
  const { name, type = 'trainer', aiStrategy = 'random' } = req.body as { name?: string; type?: string; aiStrategy?: string };

  if (!name?.trim()) {
    return sendError(res, 400, 'name is required');
  }
  if (!['trainer', 'wild'].includes(type)) {
    return sendError(res, 400, "type must be 'trainer' or 'wild'");
  }
  if (!(AI_STRATEGIES as string[]).includes(aiStrategy)) {
    return sendError(res, 400, `aiStrategy must be one of: ${AI_STRATEGIES.join(', ')}`);
  }

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const npc = await Npc.create({
    campaignId:  campaign._id,
    createdByDm: req.user!.userId,
    name:        name.trim(),
    type,
    party:       [],
    aiStrategy,
  });

  sendOk(res, { _id: npc._id, name: npc.name, type: npc.type, partyCount: 0, aiStrategy: npc.aiStrategy }, 201);
}

// ---------------------------------------------------------------------------
// PATCH /api/dm/npcs/:npcId/ai-strategy
// Updates an existing NPC's default AI tier (milestone 6.5). This is the NPC's
// permanent default only — it does not touch any battle already in progress,
// where the DM controls each slot's tier independently via a battle-local
// override (see setNpcSlotAiStrategy in battleController.ts).
// Body: { aiStrategy }
// ---------------------------------------------------------------------------
export async function setNpcAiStrategy(req: Request, res: Response): Promise<void> {
  const { npcId } = req.params;
  const { aiStrategy } = req.body as { aiStrategy?: string };

  if (!aiStrategy || !(AI_STRATEGIES as string[]).includes(aiStrategy)) {
    return sendError(res, 400, `aiStrategy must be one of: ${AI_STRATEGIES.join(', ')}`);
  }

  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const npc = await Npc.findOneAndUpdate(
    { _id: npcId, campaignId: campaign._id },
    { $set: { aiStrategy } },
    { new: true },
  ).lean();
  if (!npc) return sendError(res, 404, 'NPC not found in your campaign');

  sendOk(res, { _id: npc._id, aiStrategy: npc.aiStrategy });
}

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/pokemon
// Gives a Pokémon to an NPC and adds it to the NPC's party array.
// Body: { species, level?, nature?, gender? }
// ---------------------------------------------------------------------------
export async function giveNpcPokemon(req: Request, res: Response): Promise<void> {
  const npcId = String(req.params.npcId);
  const { species, level = 5, nature: rawNature = 'random', gender } = req.body as {
    species: string | number;
    level?: number;
    nature?: string;
    gender?: string;
  };

  const nature = rawNature.toLowerCase() === 'random'
    ? NATURES[Math.floor(Math.random() * NATURES.length)]
    : rawNature;

  if (!species && species !== 0) {
    return sendError(res, 400, 'species is required (name or dex number)');
  }
  if (!NATURES.includes(nature)) {
    return sendError(res, 400, `Invalid nature. Valid values: ${NATURES.join(', ')}`);
  }

  const npc = await assertDmNpc(req.user!.userId, npcId, res);
  if (!npc) return;

  const speciesDoc = await resolveSpeciesDoc(species, res);
  if (!speciesDoc) return;

  const maxHp          = Math.floor((2 * speciesDoc.baseStats.hp * level) / 100) + level + 10;
  const resolvedGender = resolveGender(speciesDoc.genderRatio as number, gender);
  const moves          = deriveStartingMoves(speciesDoc, level);

  // assertDmNpc only returns the npc doc, not its campaign (unlike
  // assertDmEncounter's { encounter, campaign } pair) — one extra lean lookup
  // for the DM's curated random-held-item pool (milestone 6.8).
  const npcCampaign = await Campaign.findById(npc.campaignId, 'randomHeldItemIds').lean();

  const pokemon = await Pokemon.create({
    speciesId: speciesDoc.pokeApiId,
    ownerId:   npc._id,
    ownerType: 'npc',
    nickname:  null,
    level,
    exp:       expForLevel(level, (speciesDoc.expGroup as string) || 'medium-fast'),
    currentHp: maxHp,
    nature,
    gender:    resolvedGender,
    heldItem:  rollHeldItem(npc.type === 'wild', npcCampaign?.randomHeldItemIds),
    moves,
    isInParty: true,
    partySlot: null,
  });

  npc.party.push(pokemon._id);
  await npc.save();

  sendOk(res, {
    _id:         pokemon._id,
    speciesId:   pokemon.speciesId,
    speciesName: speciesDoc.name,
    level:       pokemon.level,
    nature:      pokemon.nature,
  }, 201);
}

// ---------------------------------------------------------------------------
// GET /api/dm/npcs/:npcId/party
// Returns the full party Pokémon list for an NPC.
// ---------------------------------------------------------------------------
export async function getNpcParty(req: Request, res: Response): Promise<void> {
  const npcId = String(req.params.npcId);
  const npc = await assertDmNpc(req.user!.userId, npcId, res);
  if (!npc) return;

  const pokemons = await Pokemon.find(
    { ownerId: npc._id, ownerType: 'npc' },
    'speciesId nickname level currentHp nature moves heldItem',
  ).lean();

  const speciesIds = [...new Set(pokemons.map(p => p.speciesId))];
  const caches = speciesIds.length > 0
    ? await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId name').lean()
    : [];
  const nameMap = new Map(caches.map(c => [c.pokeApiId as number, c.name]));

  sendOk(res, pokemons.map(p => ({
    _id:         p._id,
    speciesId:   p.speciesId,
    speciesName: nameMap.get(p.speciesId) ?? `#${p.speciesId}`,
    nickname:    p.nickname,
    level:       p.level,
    currentHp:   p.currentHp,
    moves:       p.moves,
    heldItem:    p.heldItem,
  })));
}

// ---------------------------------------------------------------------------
// POST /api/dm/pokemon/:pokemonId/evolution-override  — block evolution
// DELETE /api/dm/pokemon/:pokemonId/evolution-override — lift the block
// ---------------------------------------------------------------------------
export async function blockEvolution(req: Request, res: Response): Promise<void> {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, String(req.params.pokemonId), res);
  if (!pokemon) return;

  if (pokemon.evolutionOverrides.some(o => o.condition === 'prevent')) {
    return sendOk(res, { message: 'Evolution is already blocked for this Pokémon' });
  }

  pokemon.evolutionOverrides.push({ condition: 'prevent', value: '' });
  await pokemon.save();
  sendOk(res, { message: 'Evolution blocked' });
}

export async function unblockEvolution(req: Request, res: Response): Promise<void> {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, String(req.params.pokemonId), res);
  if (!pokemon) return;

  const before = pokemon.evolutionOverrides.length;
  pokemon.evolutionOverrides = pokemon.evolutionOverrides.filter(
    o => o.condition !== 'prevent',
  ) as typeof pokemon.evolutionOverrides;

  if (pokemon.evolutionOverrides.length === before) {
    return sendOk(res, { message: 'No evolution block was set' });
  }

  await pokemon.save();
  sendOk(res, { message: 'Evolution block lifted' });
}

// ---------------------------------------------------------------------------
// PATCH /api/dm/pokemon/:pokemonId/hidden-ability — toggle hidden ability on/off
// ---------------------------------------------------------------------------
export async function toggleHiddenAbility(req: Request, res: Response): Promise<void> {
  const pokemon = await assertDmOwnsPokemon(req.user!.userId, String(req.params.pokemonId), res);
  if (!pokemon) return;

  pokemon.hasHiddenAbility = !pokemon.hasHiddenAbility;
  await pokemon.save();
  sendOk(res, { hasHiddenAbility: pokemon.hasHiddenAbility });
}

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/heal
// Restores every Pokémon in the NPC's party to full HP + PP, clears status.
// ---------------------------------------------------------------------------
export async function healNpc(req: Request, res: Response): Promise<void> {
  const npc = await assertDmNpc(req.user!.userId, String(req.params.npcId), res);
  if (!npc) return;

  const party = await Pokemon.find({ ownerId: npc._id, ownerType: 'npc' }).lean();

  if (party.length === 0) {
    return sendOk(res, { message: 'This NPC has no Pokémon.' });
  }

  await healPartyPokemon(party, ZERO_IVS);

  sendOk(res, { message: `${npc.name}'s party has been healed!` });
}

// ---------------------------------------------------------------------------
// GET /api/dm/npcs/:npcId/bag
// Returns all items in an NPC's bag.
// ---------------------------------------------------------------------------
export async function getNpcBag(req: Request, res: Response): Promise<void> {
  const npc = await assertDmNpc(req.user!.userId, String(req.params.npcId), res);
  if (!npc) return;

  const items = await Item.find({ ownerId: npc._id, ownerType: 'npc' }).lean();
  sendOk(res, items);
}

// ---------------------------------------------------------------------------
// POST /api/dm/npcs/:npcId/give-item
// Give items to an NPC's bag.
// Body: { itemId, quantity? }
// ---------------------------------------------------------------------------
export async function giveNpcItem(req: Request, res: Response): Promise<void> {
  const npcId = String(req.params.npcId);
  const { itemId, quantity = 1 } = req.body as { itemId?: string; quantity?: number };

  if (!itemId?.trim()) {
    return sendError(res, 400, 'itemId is required');
  }
  if (!assertValidGiveQuantity(quantity, res)) return;

  const pocket = resolveItemPocket(itemId.trim(), res);
  if (!pocket) return;

  const npc = await assertDmNpc(req.user!.userId, npcId, res);
  if (!npc) return;

  const item = await Item.findOneAndUpdate(
    { ownerId: npc._id, itemId: itemId.trim() },
    { $inc: { quantity }, $setOnInsert: { pocket, ownerType: 'npc' } },
    { upsert: true, new: true },
  );

  sendOk(res, { itemId: item.itemId, quantity: item.quantity, pocket: item.pocket }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/fix-pokemon-exp
// One-time migration: bumps any Pokémon below their level minimum EXP.
// Safe to run multiple times.
// ---------------------------------------------------------------------------
export async function fixPokemonExp(_req: Request, res: Response): Promise<void> {
  sendOk(res, await fixAllPokemonExp());
}

// ---------------------------------------------------------------------------
// GET /api/dm/encounters
// Returns all encounters for the DM's active campaign.
// ---------------------------------------------------------------------------
export async function getEncounters(req: Request, res: Response): Promise<void> {
  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const encounters = await Encounter.find({ campaignId: campaign._id }).lean();
  sendOk(res, encounters);
}

// ---------------------------------------------------------------------------
// POST /api/dm/encounters
// Creates a new encounter for the DM's active campaign.
// Body: { title, type, enemies?, wildPokemon?, playerPokemonLimit?, npcPokemonLimit?,
//         expMultiplier?, notes?, isActive? }
// ---------------------------------------------------------------------------
export async function createEncounter(req: Request, res: Response): Promise<void> {
  const campaign = await assertDmCampaign(req.user!.userId, res);
  if (!campaign) return;

  const {
    title,
    type,
    enemies = [],
    wildPokemon = [],
    playerPokemonLimit = null,
    npcPokemonLimit = null,
    expMultiplier = 1,
    moneyReward = 0,
    notes = '',
    isActive = true,
  } = req.body as {
    title?: string;
    type?: string;
    enemies?: { npcId: string }[];
    wildPokemon?: { speciesId: number; level: number; catchable?: boolean }[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    expMultiplier?: number;
    moneyReward?: number;
    notes?: string;
    isActive?: boolean;
  };

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return sendError(res, 400, 'title is required');
  }
  if (!['pve', 'wild'].includes(type ?? '')) {
    return sendError(res, 400, "type must be 'pve' or 'wild'");
  }
  if (playerPokemonLimit !== null && (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)) {
    return sendError(res, 400, 'playerPokemonLimit must be a positive integer or null');
  }
  if (npcPokemonLimit !== null && (!Number.isInteger(npcPokemonLimit) || npcPokemonLimit < 1)) {
    return sendError(res, 400, 'npcPokemonLimit must be a positive integer or null');
  }
  if (typeof expMultiplier !== 'number' || expMultiplier <= 0) {
    return sendError(res, 400, 'expMultiplier must be a positive number');
  }
  if (!Number.isInteger(moneyReward) || moneyReward < 0) {
    return sendError(res, 400, 'moneyReward must be a non-negative integer');
  }
  if (moneyReward > 0 && type !== 'pve') {
    return sendError(res, 400, 'moneyReward is only supported for pve encounters');
  }

  if (type === 'pve') {
    if (!Array.isArray(enemies) || enemies.length === 0) {
      return sendError(res, 400, 'PvE encounters require at least one enemy NPC');
    }
    if (!enemies.every(e => mongoose.Types.ObjectId.isValid(e.npcId))) {
      return sendError(res, 400, 'All enemy npcIds must be valid');
    }
    const npcIds     = enemies.map(e => new mongoose.Types.ObjectId(e.npcId));
    const foundNpcs  = await Npc.find({ _id: { $in: npcIds }, campaignId: campaign._id }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      return sendError(res, 403, 'One or more NPCs do not belong to your campaign');
    }
  }

  if (type === 'wild') {
    if (!Array.isArray(wildPokemon) || wildPokemon.length === 0) {
      return sendError(res, 400, 'Wild encounters require at least one wild Pokémon entry');
    }
    for (const wp of wildPokemon) {
      if (!Number.isInteger(wp.speciesId) || wp.speciesId < 1) {
        return sendError(res, 400, 'Each wildPokemon entry must have a valid speciesId');
      }
      if (!Number.isInteger(wp.level) || wp.level < 1 || wp.level > 100) {
        return sendError(res, 400, 'Each wildPokemon level must be between 1 and 100');
      }
    }
  }

  const encounter = await Encounter.create({
    campaignId:  campaign._id,
    createdByDm: req.user!.userId,
    title:       title.trim(),
    type,
    enemies:    type === 'pve'
      ? enemies.map(e => ({ npcId: new mongoose.Types.ObjectId(e.npcId) }))
      : [],
    wildPokemon: type === 'wild'
      ? wildPokemon.map(wp => ({ speciesId: wp.speciesId, level: wp.level, catchable: wp.catchable ?? true }))
      : [],
    playerPokemonLimit,
    npcPokemonLimit,
    expMultiplier,
    moneyReward: type === 'pve' ? moneyReward : 0,
    notes,
    isActive,
  });

  sendOk(res, encounter, 201);
}

// ---------------------------------------------------------------------------
// GET /api/dm/encounters/:id
// Returns a single encounter by ID.
// ---------------------------------------------------------------------------
export async function getEncounter(req: Request, res: Response): Promise<void> {
  const result = await assertDmEncounter(req.user!.userId, String(req.params.id), res);
  if (!result) return;
  sendOk(res, result.encounter);
}

// ---------------------------------------------------------------------------
// PUT /api/dm/encounters/:id
// Updates an encounter. Only provided fields change; all rules re-validated.
// ---------------------------------------------------------------------------
export async function updateEncounter(req: Request, res: Response): Promise<void> {
  const result = await assertDmEncounter(req.user!.userId, String(req.params.id), res);
  if (!result) return;
  const { encounter: existing, campaign } = result;

  const {
    title, type, enemies, wildPokemon,
    playerPokemonLimit, npcPokemonLimit, expMultiplier, moneyReward, notes, isActive,
  } = req.body as {
    title?: string;
    type?: string;
    enemies?: { npcId: string }[];
    wildPokemon?: { speciesId: number; level: number; catchable?: boolean }[];
    playerPokemonLimit?: number | null;
    npcPokemonLimit?: number | null;
    expMultiplier?: number;
    moneyReward?: number;
    notes?: string;
    isActive?: boolean;
  };

  const resolvedType = (type ?? existing.type) as 'pve' | 'wild';

  if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
    return sendError(res, 400, 'title cannot be empty');
  }
  if (type !== undefined && !['pve', 'wild'].includes(type)) {
    return sendError(res, 400, "type must be 'pve' or 'wild'");
  }
  if (playerPokemonLimit !== undefined && playerPokemonLimit !== null &&
      (!Number.isInteger(playerPokemonLimit) || playerPokemonLimit < 1)) {
    return sendError(res, 400, 'playerPokemonLimit must be a positive integer or null');
  }
  if (npcPokemonLimit !== undefined && npcPokemonLimit !== null &&
      (!Number.isInteger(npcPokemonLimit) || npcPokemonLimit < 1)) {
    return sendError(res, 400, 'npcPokemonLimit must be a positive integer or null');
  }
  if (expMultiplier !== undefined && (typeof expMultiplier !== 'number' || expMultiplier <= 0)) {
    return sendError(res, 400, 'expMultiplier must be a positive number');
  }
  if (moneyReward !== undefined && (!Number.isInteger(moneyReward) || moneyReward < 0)) {
    return sendError(res, 400, 'moneyReward must be a non-negative integer');
  }
  if (moneyReward !== undefined && moneyReward > 0 && resolvedType !== 'pve') {
    return sendError(res, 400, 'moneyReward is only supported for pve encounters');
  }

  if (enemies !== undefined && resolvedType === 'pve') {
    if (!Array.isArray(enemies) || enemies.length === 0) {
      return sendError(res, 400, 'PvE encounters require at least one enemy NPC');
    }
    if (!enemies.every(e => mongoose.Types.ObjectId.isValid(e.npcId))) {
      return sendError(res, 400, 'All enemy npcIds must be valid');
    }
    const npcIds    = enemies.map(e => new mongoose.Types.ObjectId(e.npcId));
    const foundNpcs = await Npc.find({ _id: { $in: npcIds }, campaignId: campaign._id }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      return sendError(res, 403, 'One or more NPCs do not belong to your campaign');
    }
  }

  if (wildPokemon !== undefined && resolvedType === 'wild') {
    if (!Array.isArray(wildPokemon) || wildPokemon.length === 0) {
      return sendError(res, 400, 'Wild encounters require at least one wild Pokémon entry');
    }
    for (const wp of wildPokemon) {
      if (!Number.isInteger(wp.speciesId) || wp.speciesId < 1) {
        return sendError(res, 400, 'Each wildPokemon entry must have a valid speciesId');
      }
      if (!Number.isInteger(wp.level) || wp.level < 1 || wp.level > 100) {
        return sendError(res, 400, 'Each wildPokemon level must be between 1 and 100');
      }
    }
  }

  const update: Record<string, unknown> = {};
  if (title             !== undefined) update.title             = title.trim();
  if (type              !== undefined) update.type              = type;
  if (isActive          !== undefined) update.isActive          = isActive;
  if (notes             !== undefined) update.notes             = notes;
  if (expMultiplier     !== undefined) update.expMultiplier     = expMultiplier;
  if (moneyReward       !== undefined) update.moneyReward       = resolvedType === 'pve' ? moneyReward : 0;
  if (playerPokemonLimit !== undefined) update.playerPokemonLimit = playerPokemonLimit;
  if (npcPokemonLimit    !== undefined) update.npcPokemonLimit    = npcPokemonLimit;
  if (enemies !== undefined && resolvedType === 'pve') {
    update.enemies = enemies.map(e => ({ npcId: new mongoose.Types.ObjectId(e.npcId) }));
  }
  if (wildPokemon !== undefined && resolvedType === 'wild') {
    update.wildPokemon = wildPokemon.map(wp => ({
      speciesId: wp.speciesId,
      level:     wp.level,
      catchable: wp.catchable ?? true,
    }));
  }

  const updated = await Encounter.findByIdAndUpdate(existing._id, { $set: update }, { new: true }).lean();
  sendOk(res, updated);
}

// ---------------------------------------------------------------------------
// DELETE /api/dm/encounters/:id
// Deletes an encounter. Does not cascade to any Battles launched from it.
// ---------------------------------------------------------------------------
export async function deleteEncounter(req: Request, res: Response): Promise<void> {
  const result = await assertDmEncounter(req.user!.userId, String(req.params.id), res);
  if (!result) return;
  await Encounter.deleteOne({ _id: result.encounter._id });
  sendOk(res, { message: 'Encounter deleted' });
}

// ---------------------------------------------------------------------------
// POST /api/dm/encounters/:id/launch
// Creates a Battle document from an encounter template.
// Body: { playerIds: string[] }
// ---------------------------------------------------------------------------
export async function launchEncounter(req: Request, res: Response): Promise<void> {
  const result = await assertDmEncounter(req.user!.userId, String(req.params.id), res);
  if (!result) return;
  const { encounter, campaign } = result;

  const { playerIds } = req.body as { playerIds?: string[] };

  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    return sendError(res, 400, 'playerIds must be a non-empty array');
  }
  if (!playerIds.every(id => mongoose.Types.ObjectId.isValid(id))) {
    return sendError(res, 400, 'All playerIds must be valid ObjectIds');
  }

  const campaignPlayerStrings = campaign.playerIds.map(id => id.toString());
  const outsiders = playerIds.filter(id => !campaignPlayerStrings.includes(id));
  if (outsiders.length > 0) {
    return sendError(res, 400, `These player IDs are not in your campaign: ${outsiders.join(', ')}`);
  }

  type EnemySlot = {
    npcId?: mongoose.Types.ObjectId;
    activePokemonId: mongoose.Types.ObjectId | null;
    fainted: mongoose.Types.ObjectId[];
    aiStrategy?: 'worst' | 'random' | 'highest-damage' | 'smartest';
  };

  let enemySide: EnemySlot[] = [];

  if (encounter.type === 'pve') {
    const enemies = encounter.enemies as Array<{ npcId: mongoose.Types.ObjectId; slotCount: number | null }>;
    if (enemies.length === 0) {
      return sendError(res, 400, 'This encounter has no NPCs configured');
    }
    const npcIds    = enemies.map(e => e.npcId);
    const foundNpcs = await Npc.find({ _id: { $in: npcIds }, campaignId: campaign._id }, '_id').lean();
    if (foundNpcs.length !== npcIds.length) {
      return sendError(res, 400, 'One or more NPCs in this encounter no longer exist');
    }
    for (const enemy of enemies) {
      const slots = enemy.slotCount ?? playerIds.length;
      for (let i = 0; i < slots; i++) {
        enemySide.push({
          npcId:           new mongoose.Types.ObjectId(enemy.npcId.toString()),
          activePokemonId: null,
          fainted:         [],
        });
      }
    }
  } else if (encounter.type === 'wild') {
    const wildEntries = encounter.wildPokemon as Array<{ speciesId: number; level: number; catchable: boolean }>;
    if (wildEntries.length === 0) {
      return sendError(res, 400, 'This encounter has no wild Pokémon configured');
    }

    for (const wp of wildEntries) {
      let species = await PokedexCache.findOne({ pokeApiId: wp.speciesId }).lean();
      if (!species) {
        try {
          const fetched = await fetchSpecies(wp.speciesId);
          species = (await PokedexCache.create(fetched)).toObject();
        } catch {
          return sendError(res, 400, `Species #${wp.speciesId} not found`);
        }
      }

      const nature      = NATURES[Math.floor(Math.random() * NATURES.length)];
      const genderRatio = (species.genderRatio as number) ?? -1;
      const gender      = resolveGender(genderRatio);

      const learnable = ((species.levelUpMoves ?? []) as Array<{ moveId: string; level: number }>)
        .filter(m => m.level <= wp.level)
        .slice(-4);
      const moveList = (species.moves ?? []) as Array<{ name: string; pp: number | null }>;
      const moves = learnable.map(m => {
        const md = moveList.find(mv => mv.name === m.moveId);
        const pp = md?.pp ?? 5;
        return { moveId: m.moveId, currentPP: pp, maxPP: pp, ppUps: 0 };
      });

      const stats    = computeStats(species.baseStats as BaseStats, wp.level, nature, ZERO_EVS, ZERO_IVS);
      const wildPoke = await Pokemon.create({
        speciesId:          species.pokeApiId,
        ownerId:            new mongoose.Types.ObjectId(req.user!.userId),
        ownerType:          'wild',
        nickname:           null,
        level:              wp.level,
        exp:                expForLevel(wp.level, (species.expGroup as string) || 'medium-fast'),
        currentHp:          stats.hp,
        nature,
        gender,
        heldItem:           rollHeldItem(true, campaign.randomHeldItemIds as string[] | null),
        moves,
        evs:                { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 },
        statusCondition:    null,
        statusCounter:      null,
        volatileStatus:     [],
        evolutionOverrides: [],
        isInParty:          false,
        partySlot:          null,
        caughtAt:           null,
        caughtByPlayerId:   null,
      });

      // No send-out step for wild Pokémon — active the instant the battle launches,
      // so the battle-local AI tier (milestone 6.5) has to seed straight to 'random' here.
      enemySide.push({ activePokemonId: wildPoke._id as mongoose.Types.ObjectId, fainted: [], aiStrategy: 'random' });
    }
  }

  const battle = await Battle.create({
    campaignId:  campaign._id,
    type:        encounter.type,
    status:      'waiting',
    phase:       'move_submission',
    playerSide:  playerIds.map(id => ({
      userId:          new mongoose.Types.ObjectId(id),
      activePokemonId: null,
      usedPokemonIds:  [],
      fainted:         [],
    })),
    enemySide,
    wildCatchable:      encounter.type === 'wild'
      ? (encounter.wildPokemon as Array<{ catchable: boolean }>).some(wp => wp.catchable)
      : false,
    playerPokemonLimit: encounter.playerPokemonLimit ?? null,
    npcPokemonLimit:    encounter.npcPokemonLimit    ?? null,
    moneyReward:        encounter.type === 'pve' ? (encounter.moneyReward ?? 0) : 0,
    expMultiplier:      encounter.expMultiplier ?? 1,
    encounterId:        encounter._id,
    lastUpdatedAt:      new Date(),
  });

  sendOk(res, { battleId: battle._id, type: battle.type, status: battle.status }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/dm/pokemon/:pokemonId/award-exp
// Awards EXP to a campaign player's Pokémon, running the full level-up chain.
// Body: { exp: number }
// ---------------------------------------------------------------------------
export async function awardExp(req: Request, res: Response): Promise<void> {
  const pokemonId = String(req.params.pokemonId);
  const { exp: expGain } = req.body as { exp?: number };

  if (typeof expGain !== 'number' || !Number.isInteger(expGain) || expGain <= 0) {
    return sendError(res, 400, 'exp must be a positive integer');
  }

  const pokemon = await assertDmOwnsPokemon(req.user!.userId, pokemonId, res);
  if (!pokemon) return;

  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
    .select('name expGroup baseStats')
    .lean();
  if (!cache) {
    return sendError(res, 400, 'Species data not found in cache.');
  }

  const displayName = pokemon.nickname ?? slugToDisplayName(cache.name as string);
  const events: string[] = [`${displayName} gained ${expGain} EXP!`];

  const newExp    = (pokemon.exp as number) + expGain;
  const expGroup  = (cache.expGroup as string) || 'medium-fast';
  const baseStats = cache.baseStats as BaseStats | undefined;
  const overrides = (pokemon.evolutionOverrides ?? []) as { condition: string; value: string }[];
  const cap       = await getPlayerEffectiveLevelCap(pokemon.ownerId);
  const ivs       = await getIvsForOwner(pokemon.ownerId, 'player');

  const { level: newLevel, currentHp: newHp, speciesId: newSpeciesId, moves: newMoves, events: levelEvents, cappedOut } = await applyLevelUpLoop({
    displayName,
    level: pokemon.level as number,
    exp: newExp,
    currentHp: pokemon.currentHp as number,
    speciesId: pokemon.speciesId as number,
    nature: pokemon.nature as string,
    evolutionOverrides: overrides,
    expGroup,
    baseStats,
    evs: pokemon.evs as BaseStats,
    ivs,
    cap,
    moves: (pokemon.moves as unknown as { moveId: string; currentPP: number; maxPP: number; ppUps: number }[]) ?? [],
  });
  events.push(...levelEvents);
  if (cappedOut) events.push(`${displayName} has reached the level cap and cannot grow further!`);

  await Pokemon.updateOne(
    { _id: pokemon._id },
    { $set: { exp: newExp, level: newLevel, currentHp: newHp, speciesId: newSpeciesId, moves: newMoves } },
  );

  sendOk(res, { events, level: newLevel, exp: newExp, speciesId: newSpeciesId });
}

// ---------------------------------------------------------------------------
// POST /api/dm/pokemon/:pokemonId/level-up
// Increments a campaign player's Pokémon by one level (Rare Candy equivalent).
// ---------------------------------------------------------------------------
export async function levelUp(req: Request, res: Response): Promise<void> {
  const pokemonId = String(req.params.pokemonId);

  const pokemon = await assertDmOwnsPokemon(req.user!.userId, pokemonId, res);
  if (!pokemon) return;

  const cap = await getPlayerEffectiveLevelCap(pokemon.ownerId);
  if ((pokemon.level as number) >= cap) {
    return sendError(res, 400, cap >= 100
      ? 'That Pokémon is already at level 100.'
      : `That Pokémon is already at its level cap (Lv. ${cap}).`);
  }

  const cache = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId })
    .select('name baseStats evolutionChain')
    .lean();
  if (!cache) {
    return sendError(res, 400, 'Species data not found in cache.');
  }

  const displayName = pokemon.nickname ?? slugToDisplayName(cache.name as string);
  const events: string[] = [];
  const baseStats = cache.baseStats as BaseStats | undefined;
  const ivs = await getIvsForOwner(pokemon.ownerId, 'player');

  if (baseStats) {
    const oldMaxHp  = computeStats(baseStats, pokemon.level as number, pokemon.nature as string, pokemon.evs as BaseStats, ivs).hp;
    pokemon.level   = (pokemon.level as number) + 1;
    const newMaxHp  = computeStats(baseStats, pokemon.level as number, pokemon.nature as string, pokemon.evs as BaseStats, ivs).hp;
    pokemon.currentHp = (pokemon.currentHp as number) + (newMaxHp - oldMaxHp);
  } else {
    pokemon.level = (pokemon.level as number) + 1;
  }

  events.push(`${displayName} grew to level ${pokemon.level}!`);

  const learnedMoves = await getAutoLearnedMoves(
    pokemon.speciesId as number, pokemon.level as number,
    pokemon.moves.map(m => m.moveId), pokemon.moves.length,
  );
  for (const learned of learnedMoves) {
    pokemon.moves.push(learned);
    events.push(`${displayName} learned ${slugToDisplayName(learned.moveId)}!`);
  }

  const overrides    = (pokemon.evolutionOverrides ?? []) as { condition: string; value: string }[];
  const evolveIntoId = await canEvolve({
    speciesId:          pokemon.speciesId as number,
    level:              pokemon.level as number,
    evolutionOverrides: overrides,
  });

  if (evolveIntoId !== null) {
    pokemon.speciesId = evolveIntoId;
    const { displayName: evolvedName, fullHp } = await resolveEvolvedSpecies(
      evolveIntoId, pokemon.level as number, pokemon.nature as string, pokemon.evs as BaseStats, ivs,
    );
    if (fullHp !== null) pokemon.currentHp = fullHp;
    events.push(`${displayName} evolved into ${evolvedName}!`);
  }

  await pokemon.save();
  sendOk(res, { events, level: pokemon.level, exp: pokemon.exp, speciesId: pokemon.speciesId });
}

// ---------------------------------------------------------------------------
// PATCH /api/dm/pokemon/:pokemonId/evs
// Directly sets a campaign player's Pokémon's full EV spread (DM override tool —
// bypasses the vitamin/berry +10/-10 increments players use from their bag).
// Body: { evs: { hp, atk, def, spatk, spdef, speed } } — all six required.
// ---------------------------------------------------------------------------
const EV_STAT_KEYS: (keyof BaseStats)[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'];

export async function setPokemonEvs(req: Request, res: Response): Promise<void> {
  const pokemonId = String(req.params.pokemonId);
  const { evs } = req.body as { evs?: Partial<Record<keyof BaseStats, unknown>> };

  const pokemon = await assertDmOwnsPokemon(req.user!.userId, pokemonId, res);
  if (!pokemon) return;

  if (!evs || typeof evs !== 'object') {
    return sendError(res, 400, 'evs object is required');
  }

  for (const key of EV_STAT_KEYS) {
    const value = evs[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > EV_STAT_CAP) {
      return sendError(res, 400, `${EV_STAT_DISPLAY_NAMES[key]} EVs must be an integer between 0 and ${EV_STAT_CAP}`);
    }
  }

  const total = EV_STAT_KEYS.reduce((sum, key) => sum + (evs[key] as number), 0);
  if (total > EV_TOTAL_CAP) {
    return sendError(res, 400, `Total EVs cannot exceed ${EV_TOTAL_CAP} (submitted ${total})`);
  }

  const newEvs = Object.fromEntries(EV_STAT_KEYS.map(key => [key, evs[key] as number])) as BaseStats;
  pokemon.evs = newEvs;
  pokemon.markModified('evs');
  await pokemon.save();

  sendOk(res, { evs: pokemon.evs });
}

// ---------------------------------------------------------------------------
// GET /api/dm/players/:username/roster
// Returns all Pokémon for a campaign player, split into party and PC,
// enriched with species name, maxHp, and EXP progress fields.
// ---------------------------------------------------------------------------
export async function getPlayerRoster(req: Request, res: Response): Promise<void> {
  const username = String(req.params.username);
  const user = await assertCampaignPlayer(req.user!.userId, username, res);
  if (!user) return;

  const badges = (user.badges ?? []) as { badgeId: string }[];
  const trainerStats = ivsFromSpread(user.trainerStats);
  const trainerIvUnspent = getUnspentTrainerIv(badges.length, user.trainerStats);

  const pokemons = await Pokemon.find({ ownerId: user._id, ownerType: 'player' })
    .select('speciesId nickname level exp currentHp nature gender statusCondition heldItem isInParty partySlot evs')
    .lean();

  if (pokemons.length === 0) {
    return sendOk(res, { party: [], pc: [], badges, trainerStats, trainerIvUnspent });
  }

  const uniqueSpeciesIds = [...new Set(pokemons.map(p => p.speciesId as number))];
  const speciesDocs = await PokedexCache.find({ pokeApiId: { $in: uniqueSpeciesIds } })
    .select('pokeApiId name baseStats expGroup')
    .lean();
  const speciesMap = new Map(speciesDocs.map(s => [s.pokeApiId as number, s]));

  const enriched = pokemons.map(poke => {
    const species   = speciesMap.get(poke.speciesId as number);
    const expGroup  = (species?.expGroup as string) || 'medium-fast';
    const baseStats = species?.baseStats as BaseStats | undefined;
    const maxHp     = baseStats ? computeStats(baseStats, poke.level as number, poke.nature as string, poke.evs as BaseStats, trainerStats).hp : 0;

    return {
      _id:                poke._id,
      speciesId:          poke.speciesId,
      speciesName:        species?.name ?? `#${poke.speciesId}`,
      nickname:           poke.nickname,
      level:              poke.level,
      exp:                poke.exp,
      expForCurrentLevel: expForLevel(poke.level as number, expGroup),
      expForNextLevel:    (poke.level as number) >= 100 ? null : expForLevel((poke.level as number) + 1, expGroup),
      currentHp:          poke.currentHp,
      maxHp,
      nature:             poke.nature,
      gender:             poke.gender,
      statusCondition:    poke.statusCondition,
      heldItem:           poke.heldItem,
      isInParty:          poke.isInParty,
      partySlot:          poke.partySlot,
      evs:                poke.evs,
    };
  });

  const party = enriched
    .filter(p => p.isInParty)
    .sort((a, b) => ((a.partySlot as number) ?? 99) - ((b.partySlot as number) ?? 99));
  const pc = enriched.filter(p => !p.isInParty);

  sendOk(res, { party, pc, badges, trainerStats, trainerIvUnspent });
}
