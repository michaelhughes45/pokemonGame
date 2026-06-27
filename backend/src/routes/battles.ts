import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { requireDm } from '../middleware/auth';
import {
  getDmBattles,
  getActiveBattle,
  getBattleState,
  createBattle,
  startBattle,
  advanceRound,
  setWeather,
  deleteBattle,
  sendOut,
  submitMove,
  submitTarget,
  dmSendOut,
  dmSubmitMove,
  dmAutoSubmit,
} from '../controllers/battleController';

const router = Router();

// POST /api/battles — DM creates a new battle (PvE or wild)
router.post('/', createBattle);

// Validate :id on every /:id route before the handler runs
router.param('id', (_req: Request, res: Response, next, id: string) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  next();
});

// POST /api/battles/:id/start — DM starts a waiting battle
router.post('/:id/start',          requireDm, startBattle);

// POST /api/battles/:id/send-out — Player sends out their active Pokémon
router.post('/:id/send-out',       sendOut);

// POST /api/battles/:id/dm-send-out — DM sends out an NPC's Pokémon
router.post('/:id/dm-send-out',    requireDm, dmSendOut);

// POST /api/battles/:id/submit-move — Player submits their action for the round (move/item/switch/catch/run)
router.post('/:id/submit-move',    submitMove);

// POST /api/battles/:id/dm-submit-move — DM submits a move or switch on behalf of an NPC
router.post('/:id/dm-submit-move', requireDm, dmSubmitMove);

// POST /api/battles/:id/dm-auto-submit — DM auto-submits moves for all unsubmitted NPC/wild slots using their AI strategy
router.post('/:id/dm-auto-submit', requireDm, dmAutoSubmit);

// GET /api/battles/dm — DM fetches all active battles for their campaign
router.get('/dm',                  getDmBattles);

// GET /api/battles/active — Player fetches their current active battle
router.get('/active',              getActiveBattle);

// POST /api/battles/:id/submit-target — Submits targets for the current actor's move during the targeting phase
router.post('/:id/submit-target',  submitTarget);

// POST /api/battles/:id/advance-round — DM advances from end-of-round to the next round
router.post('/:id/advance-round',  requireDm, advanceRound);

// POST /api/battles/:id/weather — DM manually sets the battle weather
router.post('/:id/weather',        requireDm, setWeather);

// DELETE /api/battles/:id — DM deletes a battle
router.delete('/:id',              requireDm, deleteBattle);

// GET /api/battles/:id/state — Returns the full battle state for polling (players and DM)
router.get('/:id/state',           getBattleState);

export default router;
