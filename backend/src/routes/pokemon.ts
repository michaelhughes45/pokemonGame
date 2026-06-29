import { Router } from 'express';
import {
  getParty,
  reorderParty,
  getPc,
  swapParty,
  healParty,
  replaceMoveSlot,
  getPokemon,
  releasePokemon,
} from '../controllers/pokemonController';

const router = Router();

// All routes in this file are already guarded by verifyToken in index.ts.

// GET  /api/pokemon/party           — party (enriched with species + maxHp)
router.get('/party',           getParty);

// PATCH /api/pokemon/party/reorder  — reorder party slots
router.patch('/party/reorder', reorderParty);

// GET  /api/pokemon/pc              — PC storage (enriched)
router.get('/pc',              getPc);

// POST /api/pokemon/party/swap      — move PC pokemon into party (optional swap)
router.post('/party/swap',     swapParty);

// POST /api/pokemon/heal-party      — heal all party pokemon to full HP+PP+status
router.post('/heal-party',     healParty);

// PATCH /api/pokemon/:id/moves      — replace a move slot via Move Reminder
router.patch('/:id/moves',     replaceMoveSlot);

// GET  /api/pokemon/:id             — full detail for one pokemon
router.get('/:id',             getPokemon);

// DELETE /api/pokemon/:id           — release (permanently delete) a pokemon
router.delete('/:id',          releasePokemon);

export default router;
