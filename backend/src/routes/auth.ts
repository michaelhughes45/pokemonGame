import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { verifyToken } from '../middleware/auth';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { username, email, password, role } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ data: null, error: 'username, email, and password are required' });
    return;
  }

  // Only allow valid roles — default to 'player' if not provided or invalid
  const allowedRoles = ['player', 'dm', 'admin'] as const;
  const assignedRole = allowedRoles.includes(role) ? role : 'player';

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({ username, email, passwordHash, role: assignedRole });

  const token = jwt.sign(
    { userId: user._id.toString(), role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  res.status(201).json({
    data: { token, user: { id: user._id, username: user.username, role: user.role } },
    error: null,
  });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ data: null, error: 'email and password are required' });
    return;
  }

  const user = await User.findOne({ email }).lean();

  if (!user) {
    res.status(401).json({ data: null, error: 'Invalid credentials' });
    return;
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);

  if (!passwordMatch) {
    res.status(401).json({ data: null, error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign(
    { userId: user._id.toString(), role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  res.json({
    data: { token, user: { id: user._id, username: user.username, role: user.role } },
    error: null,
  });
});

// GET /api/auth/me
router.get('/me', verifyToken, async (req: Request, res: Response) => {
  const user = await User.findById(req.user!.userId).lean();

  if (!user) {
    res.status(404).json({ data: null, error: 'User not found' });
    return;
  }

  res.json({
    data: {
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      trainerStats: user.trainerStats,
      trainerStatChoice: user.trainerStatChoice,
      badges: user.badges,
      money: user.money,
    },
    error: null,
  });
});

export default router;
