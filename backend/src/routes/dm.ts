import { Router } from 'express';
import {
  deletePlayerStarter,
  resetPlayerTrainerStat,
  givePlayerPokemon,
  givePlayerItem,
  giveCampaignItem,
  givePlayerMoney,
  giveCampaignMoney,
  getTmHmCatalog,
  getNpcs,
  createNpc,
  setNpcAiStrategy,
  giveNpcPokemon,
  getNpcParty,
  blockEvolution,
  unblockEvolution,
  toggleHiddenAbility,
  healNpc,
  getNpcBag,
  giveNpcItem,
  fixPokemonExp,
  getEncounters,
  createEncounter,
  getEncounter,
  updateEncounter,
  deleteEncounter,
  launchEncounter,
  awardExp,
  levelUp,
  setPokemonEvs,
  getPlayerRoster,
  getBadgeCatalog,
  awardBadge,
  revokeBadge,
  getCustomBadges,
  createCustomBadge,
  deleteCustomBadge,
} from '../controllers/dmController';

const router = Router();

// All routes in this file are already guarded by verifyToken + requireDm in index.ts.

// --- Players ---
router.delete('/players/:username/starter',   deletePlayerStarter);
router.delete('/players/:username/trainer-stat', resetPlayerTrainerStat);
router.post('/players/:username/pokemon',     givePlayerPokemon);
router.get('/players/:username/roster',       getPlayerRoster);
router.post('/players/:username/badges',      awardBadge);
router.delete('/players/:username/badges/:badgeId', revokeBadge);

// --- Badge catalog ---
router.get('/badges',                         getBadgeCatalog);
router.get('/badges/custom',                  getCustomBadges);
router.post('/badges/custom',                 createCustomBadge);
router.delete('/badges/custom/:badgeId',      deleteCustomBadge);

// --- Player items ---
router.post('/items/give',                    givePlayerItem);
router.post('/campaign/items/give',           giveCampaignItem);
router.post('/money/give',                    givePlayerMoney);
router.post('/campaign/money/give',           giveCampaignMoney);
router.get('/tm-hm-moves',                    getTmHmCatalog);

// --- NPCs ---
router.get('/npcs',                           getNpcs);
router.post('/npcs',                          createNpc);
router.patch('/npcs/:npcId/ai-strategy',      setNpcAiStrategy);
router.post('/npcs/:npcId/pokemon',           giveNpcPokemon);
router.get('/npcs/:npcId/party',              getNpcParty);
router.post('/npcs/:npcId/heal',              healNpc);
router.get('/npcs/:npcId/bag',                getNpcBag);
router.post('/npcs/:npcId/give-item',         giveNpcItem);

// --- Pokémon management ---
router.post('/pokemon/:pokemonId/evolution-override',   blockEvolution);
router.delete('/pokemon/:pokemonId/evolution-override', unblockEvolution);
router.patch('/pokemon/:pokemonId/hidden-ability',      toggleHiddenAbility);
router.post('/pokemon/:pokemonId/award-exp',            awardExp);
router.post('/pokemon/:pokemonId/level-up',             levelUp);
router.patch('/pokemon/:pokemonId/evs',                 setPokemonEvs);

// --- Encounters ---
router.get('/encounters',          getEncounters);
router.post('/encounters',         createEncounter);
router.get('/encounters/:id',      getEncounter);
router.put('/encounters/:id',      updateEncounter);
router.delete('/encounters/:id',   deleteEncounter);
router.post('/encounters/:id/launch', launchEncounter);

// --- Admin utilities ---
router.post('/fix-pokemon-exp',    fixPokemonExp);

export default router;
