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
  setFieldModeEnabled,
  setHiddenAbilitiesEnabled,
  getShopCatalog,
  setShopItems,
  getHeldItemCatalog,
  setRandomHeldItems,
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

// PATCH /api/campaigns/field-mode       — DM toggles Town/Field mode
router.patch('/field-mode', requireDm, setFieldModeEnabled);

// PATCH /api/campaigns/hidden-abilities — DM toggles hidden abilities campaign-wide
router.patch('/hidden-abilities', requireDm, setHiddenAbilitiesEnabled);

// GET  /api/campaigns/shop-catalog      — full priced item catalog (DM curates from
//                                          it, players read it to show Pokémart prices)
router.get('/shop-catalog', getShopCatalog);

// PATCH /api/campaigns/shop-items       — DM sets which items are for sale
router.patch('/shop-items', requireDm, setShopItems);

// GET  /api/campaigns/held-item-catalog — full random-held-item pool (34 held_type + 25 mints)
router.get('/held-item-catalog', getHeldItemCatalog);

// PATCH /api/campaigns/random-held-items — DM sets which items can randomly be held
router.patch('/random-held-items', requireDm, setRandomHeldItems);

export default router;
