import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { BaseStats } from '../lib/statCalc';
import { EV_STAT_DISPLAY_NAMES } from '../lib/evData';
import { ivsFromSpread, getUnspentTrainerIv } from '../lib/trainerIv';

const TRAINER_STAT_KEYS = Object.keys(EV_STAT_DISPLAY_NAMES) as (keyof BaseStats)[];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

const ALLOWED_ROLES = ['player', 'dm', 'admin'] as const;

function signToken(userId: string, role: string): string {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET!, { expiresIn: '7d' });
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
export async function register(req: Request, res: Response): Promise<void> {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password) {
    return sendError(res, 400, 'username, email, and password are required');
  }

  // Default to 'player' if role is missing or not in the allowed list
  const assignedRole = ALLOWED_ROLES.includes(role) ? role : 'player';
  const passwordHash = await bcrypt.hash(password, 12);
  const user         = await User.create({ username, email, passwordHash, role: assignedRole });
  const token        = signToken(user._id.toString(), user.role);

  sendOk(res, { token, user: { id: user._id, username: user.username, role: user.role } }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError(res, 400, 'email and password are required');
  }

  const user = await User.findOne({ email }).lean();
  if (!user) {
    return sendError(res, 401, 'Invalid credentials');
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    return sendError(res, 401, 'Invalid credentials');
  }

  const token = signToken(user._id.toString(), user.role);
  sendOk(res, { token, user: { id: user._id, username: user.username, role: user.role } });
}

// ---------------------------------------------------------------------------
// GET /api/auth/me  (requires verifyToken — applied per-route in auth.ts)
// ---------------------------------------------------------------------------
export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.user!.userId).lean();
  if (!user) {
    return sendError(res, 404, 'User not found');
  }

  const badgeCount = user.badges?.length ?? 0;

  sendOk(res, {
    id:                user._id,
    username:          user.username,
    email:             user.email,
    role:              user.role,
    trainerStats:      ivsFromSpread(user.trainerStats),
    trainerIvUnspent:  getUnspentTrainerIv(badgeCount, user.trainerStats),
    badges:            user.badges,
    money:             user.money,
  });
}

// ---------------------------------------------------------------------------
// POST /api/auth/trainer-stat  (requires verifyToken — applied per-route in auth.ts)
// Spends `amount` of the player's earned-but-unspent Trainer IV points
// (milestone 5.5) into a single stat. Points are locked in once spent — a DM
// must reset the whole spread (DELETE on the dm router) to reclaim them.
// Body: { stat: 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'speed', amount: number }
// ---------------------------------------------------------------------------
export async function allocateTrainerIv(req: Request, res: Response): Promise<void> {
  const { stat, amount } = req.body as { stat?: string; amount?: number };

  if (!stat || !TRAINER_STAT_KEYS.includes(stat as keyof BaseStats)) {
    return sendError(res, 400, `stat must be one of: ${TRAINER_STAT_KEYS.map(k => EV_STAT_DISPLAY_NAMES[k]).join(', ')}`);
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return sendError(res, 400, 'amount must be a positive integer');
  }

  const user = await User.findById(req.user!.userId).select('badges trainerStats').lean();
  if (!user) {
    return sendError(res, 404, 'User not found');
  }

  const unspent = getUnspentTrainerIv(user.badges?.length ?? 0, user.trainerStats);
  if (amount > unspent) {
    return sendError(res, 400, `Only ${unspent} unspent IV point${unspent === 1 ? '' : 's'} available.`);
  }

  await User.updateOne({ _id: req.user!.userId }, { $inc: { [`trainerStats.${stat}`]: amount } });

  const updated = await User.findById(req.user!.userId).select('badges trainerStats').lean();
  sendOk(res, {
    trainerStats:     ivsFromSpread(updated?.trainerStats),
    trainerIvUnspent: getUnspentTrainerIv(updated?.badges?.length ?? 0, updated?.trainerStats),
  });
}
