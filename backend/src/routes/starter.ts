import { Router } from 'express';
import { getStarter, pickStarter } from '../controllers/starterController';

const router = Router();

// All routes in this file are already guarded by verifyToken in index.ts.

// GET  /api/starter — check whether the current user has already chosen a starter
router.get('/', getStarter);

// POST /api/starter — pick a starter Pokémon
router.post('/', pickStarter);

export default router;
