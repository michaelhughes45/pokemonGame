import { Router } from 'express';
import { ping, fixPokemonExp } from '../controllers/adminController';

const router = Router();

// All routes in this file are already guarded by verifyToken + requireAdmin in index.ts.

// GET  /api/admin/ping             — smoke-test that auth middleware passed
router.get('/ping', ping);

// POST /api/admin/fix-pokemon-exp  — one-time exp floor migration
router.post('/fix-pokemon-exp', fixPokemonExp);

export default router;
