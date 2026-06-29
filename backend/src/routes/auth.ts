import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { register, login, getMe } from '../controllers/authController';

const router = Router();

// POST /api/auth/register — create account and receive a JWT
router.post('/register', register);

// POST /api/auth/login    — authenticate and receive a JWT
router.post('/login',    login);

// GET  /api/auth/me       — return the authenticated user's profile
router.get('/me', verifyToken, getMe);

export default router;
