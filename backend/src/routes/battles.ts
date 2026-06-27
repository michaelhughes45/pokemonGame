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

router.post('/', createBattle);

router.param('id', (_req: Request, res: Response, next, id: string) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ data: null, error: 'Invalid battle ID' });
    return;
  }
  next();
});

router.post('/:id/start',          requireDm, startBattle);
router.post('/:id/send-out',       sendOut);
router.post('/:id/dm-send-out',    requireDm, dmSendOut);
router.post('/:id/submit-move',    submitMove);
router.post('/:id/dm-submit-move', requireDm, dmSubmitMove);
router.post('/:id/dm-auto-submit', requireDm, dmAutoSubmit);
router.get('/dm',                  getDmBattles);
router.get('/active',              getActiveBattle);
router.post('/:id/submit-target',  submitTarget);
router.post('/:id/advance-round',  requireDm, advanceRound);
router.post('/:id/weather',        requireDm, setWeather);
router.delete('/:id',              requireDm, deleteBattle);
router.get('/:id/state',           getBattleState);

export default router;
