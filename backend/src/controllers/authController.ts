import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';

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

  sendOk(res, {
    id:                user._id,
    username:          user.username,
    email:             user.email,
    role:              user.role,
    trainerStats:      user.trainerStats,
    trainerStatChoice: user.trainerStatChoice,
    badges:            user.badges,
    money:             user.money,
  });
}
