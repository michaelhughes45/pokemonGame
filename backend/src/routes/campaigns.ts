import { Router } from 'express';
import { requireDm } from '../middleware/auth';
import {
  getMine,
  getInvites,
  createCampaign,
  invitePlayer,
  respondToInvite,
  leaveCampaign,
  removePlayer,
  setLevelCapEnabled,
} from '../controllers/campaignController';

const router = Router();

// GET  /api/campaigns/mine               — current user's campaign (DM or player)
router.get('/mine',             getMine);

// GET  /api/campaigns/invites            — pending invites for the current player
router.get('/invites',          getInvites);

// POST /api/campaigns                    — DM creates a new campaign
router.post('/',       requireDm, createCampaign);

// POST /api/campaigns/invite             — DM invites a player by username
router.post('/invite', requireDm, invitePlayer);

// POST /api/campaigns/invite/respond     — Player accepts or declines an invite
router.post('/invite/respond',  respondToInvite);

// POST /api/campaigns/leave              — Player leaves their current campaign
router.post('/leave',           leaveCampaign);

// DELETE /api/campaigns/players/:username — DM removes a player from the campaign
router.delete('/players/:username', requireDm, removePlayer);

// PATCH /api/campaigns/level-cap        — DM toggles the campaign-wide level cap
router.patch('/level-cap', requireDm, setLevelCapEnabled);

export default router;
