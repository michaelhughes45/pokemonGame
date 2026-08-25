import { Router } from 'express';
import {
  getParty,
  reorderParty,
  getPc,
  swapParty,
  withdrawFromParty,
  healParty,
  replaceMoveSlot,
  teachTmMove,
  setNickname,
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

// POST /api/pokemon/party/withdraw  — move a party pokemon to the PC (no swap partner needed)
router.post('/party/withdraw', withdrawFromParty);

// POST /api/pokemon/heal-party      — heal all party pokemon to full HP+PP+status
router.post('/heal-party',     healParty);

// PATCH /api/pokemon/:id/moves      — replace a move slot via Move Reminder
router.patch('/:id/moves',     replaceMoveSlot);

// PATCH /api/pokemon/:id/teach-tm   — replace a move slot by teaching a TM/HM
router.patch('/:id/teach-tm',  teachTmMove);

// PATCH /api/pokemon/:id/nickname   — set (or clear) a Pokémon's nickname
router.patch('/:id/nickname',  setNickname);

// GET  /api/pokemon/:id             — full detail for one pokemon
router.get('/:id',             getPokemon);

// DELETE /api/pokemon/:id           — release (permanently delete) a pokemon
router.delete('/:id',          releasePokemon);

export default router;
