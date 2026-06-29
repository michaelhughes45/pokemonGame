import { Router } from 'express';
import { searchPokedex, getSpecies } from '../controllers/pokedexController';

const router = Router();

// This router is intentionally public — no verifyToken.

// GET /api/pokedex/search?q=  — name-fragment search (up to 10 results)
// Must be defined before /:idOrName so Express does not treat "search" as an id.
router.get('/search',     searchPokedex);

// GET /api/pokedex/:idOrName  — full species data by numeric id or name
router.get('/:idOrName',  getSpecies);

export default router;
