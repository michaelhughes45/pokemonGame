import { Router } from 'express';
import { verifyToken } from '../middleware/auth';
import { register, login, resetPassword, getMe, allocateTrainerIv } from '../controllers/authController';

const router = Router();

// POST /api/auth/register — create account and receive a JWT
router.post('/register', register);

// POST /api/auth/login    — authenticate and receive a JWT
router.post('/login',    login);

// POST /api/auth/reset-password — redeem an admin-issued code to set a new password
router.post('/reset-password', resetPassword);

// GET  /api/auth/me       — return the authenticated user's profile
router.get('/me', verifyToken, getMe);

// POST /api/auth/trainer-stat — spend unspent Trainer IV points into one stat
router.post('/trainer-stat', verifyToken, allocateTrainerIv);

export default router;
