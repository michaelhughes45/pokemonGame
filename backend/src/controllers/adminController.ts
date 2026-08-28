import { Request, Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { User } from '../models/User';
import { Campaign } from '../models/Campaign';
import { Npc } from '../models/Npc';
import { Encounter } from '../models/Encounter';
import { Battle } from '../models/Battle';
import { Item } from '../models/Item';
import { fetchSpecies } from '../lib/pokeapi';
import { fixAllPokemonExp } from '../lib/fixPokemonExp';

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
  sendOk(res, await fixAllPokemonExp());
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// Lists every user account. campaignName resolves to whichever campaign is
// relevant for that user's role — a player's currentCampaignId, or a DM's own
// active campaign (DMs never populate currentCampaignId, see campaignController).
// ---------------------------------------------------------------------------
export async function listUsers(_req: Request, res: Response): Promise<void> {
  const users = await User.find({}, '-passwordHash').sort({ username: 1 }).lean();
  const campaigns = await Campaign.find({}, 'name dmId isActive').lean();

  const campaignById = new Map(campaigns.map(c => [c._id.toString(), c.name]));
  const campaignByDmId = new Map(
    campaigns.filter(c => c.isActive).map(c => [c.dmId.toString(), c.name]),
  );

  sendOk(res, users.map(u => ({
    _id:          u._id,
    username:     u.username,
    email:        u.email,
    role:         u.role,
    createdAt:    (u as any).createdAt,
    campaignName:
      campaignById.get(u.currentCampaignId?.toString() ?? '') ??
      campaignByDmId.get(u._id.toString()) ??
      null,
  })));
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/:id/role
// Body: { role: 'player' | 'dm' | 'admin' }
// Guardrails: an admin can't change their own role (avoids accidental
// self-lockout), and the last remaining admin account can't be demoted
// (avoids a campaign with no admin able to fix mistakes).
// ---------------------------------------------------------------------------
const VALID_ROLES = ['player', 'dm', 'admin'] as const;

export async function updateUserRole(req: Request, res: Response): Promise<void> {
  const { id }   = req.params;
  const { role } = req.body as { role?: string };

  if (!role || !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    sendError(res, 400, `role must be one of: ${VALID_ROLES.join(', ')}`);
    return;
  }

  if (id === req.user!.userId) {
    sendError(res, 400, 'You cannot change your own role');
    return;
  }

  const target = await User.findById(id, 'role').lean();
  if (!target) {
    sendError(res, 404, 'User not found');
    return;
  }

  if (target.role === 'admin' && role !== 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount <= 1) {
      sendError(res, 400, 'Cannot demote the last remaining admin');
      return;
    }
  }

  await User.updateOne({ _id: id }, { $set: { role } });
  sendOk(res, { _id: id, role });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/password-reset-token
// Generates a one-time code the admin relays to the user out-of-band (no
// email system exists in this project) — the admin activates the ability to
// reset but never sees/chooses the new password; the user picks their own via
// the public POST /api/auth/reset-password (see authController.resetPassword),
// which consumes the code. Expires in 1 hour, unused codes are overwritten by
// a fresh call.
// ---------------------------------------------------------------------------
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export async function generatePasswordResetToken(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const target = await User.findById(id, 'username').lean();
  if (!target) {
    sendError(res, 404, 'User not found');
    return;
  }

  const token     = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await User.updateOne(
    { _id: id },
    { $set: { passwordResetToken: token, passwordResetExpires: expiresAt } },
  );

  sendOk(res, { username: target.username, token, expiresAt });
}

// ---------------------------------------------------------------------------
// cascadeDeleteUser
// Shared by the single-delete route and bulk-delete sweep below. Deletes a
// user and cascades everything they own:
//   - their own Pokémon/Items (ownerType: 'player') — covers players, and any
//     dm/admin who happened to own a party before their role was changed
//   - their membership/pending invites in other DMs' campaigns
//   - if they're the DM of their own active campaign: blocked outright when
//     that campaign still has other real players (an admin deleting a test
//     DM account shouldn't be able to silently wipe out someone else's
//     campaign); otherwise the whole campaign tree — NPCs, NPC-owned
//     Pokémon/Items, Encounters, Battles — is deleted along with it.
// Returns a reason string instead of throwing when the delete is refused, so
// a bulk sweep can report per-user skips instead of aborting the whole batch.
// ---------------------------------------------------------------------------
async function cascadeDeleteUser(
  id: string,
  requesterId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (id === requesterId) {
    return { ok: false, reason: 'cannot delete your own account' };
  }

  const target = await User.findById(id, '_id').lean();
  if (!target) {
    return { ok: false, reason: 'user not found' };
  }

  const dmCampaign = await Campaign.findOne({ dmId: id, isActive: true }).lean();
  if (dmCampaign && dmCampaign.playerIds.length > 0) {
    return {
      ok: false,
      reason: `still DM of "${dmCampaign.name}" with ${dmCampaign.playerIds.length} player(s)`,
    };
  }

  const objId = new mongoose.Types.ObjectId(id);

  await Pokemon.deleteMany({ ownerId: id, ownerType: 'player' });
  await Item.deleteMany({ ownerId: id, ownerType: 'player' });
  await Campaign.updateMany(
    { playerIds: objId },
    { $pull: { playerIds: objId, pendingInvites: { userId: objId } } },
  );

  if (dmCampaign) {
    const npcs = await Npc.find({ campaignId: dmCampaign._id }, '_id').lean();
    const npcIds = npcs.map(n => n._id);
    await Pokemon.deleteMany({ ownerId: { $in: npcIds }, ownerType: 'npc' });
    await Item.deleteMany({ ownerId: { $in: npcIds }, ownerType: 'npc' });
    await Npc.deleteMany({ campaignId: dmCampaign._id });
    await Encounter.deleteMany({ campaignId: dmCampaign._id });
    await Battle.deleteMany({ campaignId: dmCampaign._id });
    await Campaign.deleteOne({ _id: dmCampaign._id });
  }

  await User.deleteOne({ _id: id });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id
// ---------------------------------------------------------------------------
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };

  const result = await cascadeDeleteUser(id, req.user!.userId);
  if (!result.ok) {
    const status = result.reason === 'user not found' ? 404 : 400;
    sendError(res, status, result.reason[0].toUpperCase() + result.reason.slice(1));
    return;
  }

  sendOk(res, { deleted: true });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/bulk-delete
// Body: { pattern: string } — case-insensitive substring match against
// username (e.g. "verify" sweeps verifydm1/verifyplayer2/etc, the leftover
// disposable test accounts from live-verification passes). Requires at least
// MIN_PATTERN_LENGTH characters so a too-broad pattern can't sweep the whole
// user table by accident. Admin-role accounts are never touched by a bulk
// sweep regardless of match — deleting an admin is always a deliberate
// single action via the route above.
// ---------------------------------------------------------------------------
const MIN_PATTERN_LENGTH = 3;

export async function bulkDeleteUsers(req: Request, res: Response): Promise<void> {
  const { pattern } = req.body as { pattern?: string };
  const trimmed = pattern?.trim() ?? '';

  if (trimmed.length < MIN_PATTERN_LENGTH) {
    sendError(res, 400, `pattern must be at least ${MIN_PATTERN_LENGTH} characters`);
    return;
  }

  const matches = await User.find(
    { username: { $regex: trimmed, $options: 'i' } },
    'username role',
  ).lean();

  const deleted: string[] = [];
  const skipped: { username: string; reason: string }[] = [];

  for (const u of matches) {
    if (u.role === 'admin') {
      skipped.push({ username: u.username, reason: 'admin accounts are never bulk-deleted' });
      continue;
    }
    const result = await cascadeDeleteUser(u._id.toString(), req.user!.userId);
    if (result.ok) {
      deleted.push(u.username);
    } else {
      skipped.push({ username: u.username, reason: result.reason });
    }
  }

  sendOk(res, { deleted, skipped, matchCount: matches.length });
}

// ---------------------------------------------------------------------------
// GET /api/admin/pokedex?q=<search>
// Lists cached PokedexCache entries, optionally filtered by name substring
// (case-insensitive). Capped at 60 results — the cache only ever holds
// species actually encountered in a campaign, not the full national dex.
// ---------------------------------------------------------------------------
export async function listPokedexCache(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const filter = q ? { name: { $regex: q, $options: 'i' } } : {};

  const entries = await PokedexCache
    .find(filter, 'pokeApiId name types cachedAt')
    .sort({ pokeApiId: 1 })
    .limit(60)
    .lean();

  sendOk(res, entries);
}

// ---------------------------------------------------------------------------
// POST /api/admin/pokedex/:id/refresh
// Force re-fetches a cached species from PokeAPI and overwrites every
// derived field (stats, moves, abilities, evolution chain, etc.) plus
// cachedAt. Safe to run any time — implemented flags always come back false
// from fetchSpecies (see lib/pokeapi.ts), there's no hand-curated per-doc
// state this could clobber; "implemented" is really decided by the static
// move/ability tables at battle time, not this field.
// ---------------------------------------------------------------------------
export async function refreshPokedexEntry(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  const existing = await PokedexCache.findById(id, 'pokeApiId').lean();
  if (!existing) {
    sendError(res, 404, 'Pokédex cache entry not found');
    return;
  }

  let transformed;
  try {
    transformed = await fetchSpecies(existing.pokeApiId as number);
  } catch {
    sendError(res, 502, 'Failed to fetch species from PokeAPI');
    return;
  }

  await PokedexCache.updateOne(
    { _id: id },
    { $set: { ...transformed, cachedAt: new Date() } },
  );

  sendOk(res, { refreshed: true, pokeApiId: existing.pokeApiId });
}
