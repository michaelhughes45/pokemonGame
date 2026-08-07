import { Router } from 'express';
import { buyItem, sellItem } from '../controllers/shopController';

const router = Router();

// POST /api/shop/buy   — player buys an item from their campaign's Pokémart
router.post('/buy',  buyItem);

// POST /api/shop/sell  — player sells an item from their own bag
router.post('/sell', sellItem);

export default router;
