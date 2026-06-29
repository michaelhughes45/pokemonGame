import { Router } from 'express';
import { getBag, useItem } from '../controllers/itemController';

const router = Router();

// GET  /api/items      — player's full bag (sorted by pocket then itemId)
router.get('/', getBag);

// POST /api/items/use  — use an item from the bag on a Pokémon
router.post('/use', useItem);

export default router;
