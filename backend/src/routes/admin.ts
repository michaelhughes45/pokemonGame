import { Router } from 'express';
import {
  ping, fixPokemonExp, listUsers, updateUserRole, deleteUser, bulkDeleteUsers,
  listPokedexCache, refreshPokedexEntry,
} from '../controllers/adminController';

const router = Router();

// All routes in this file are already guarded by verifyToken + requireAdmin in index.ts.

// GET  /api/admin/ping             — smoke-test that auth middleware passed
router.get('/ping', ping);

// POST /api/admin/fix-pokemon-exp  — one-time exp floor migration
router.post('/fix-pokemon-exp', fixPokemonExp);

// GET  /api/admin/users            — list every user account
router.get('/users', listUsers);

// PATCH /api/admin/users/:id/role  — change a user's role
router.patch('/users/:id/role', updateUserRole);

// DELETE /api/admin/users/:id      — delete a user and cascade their owned data
router.delete('/users/:id', deleteUser);

// POST /api/admin/users/bulk-delete — sweep every user whose username matches a pattern
router.post('/users/bulk-delete', bulkDeleteUsers);

// GET  /api/admin/pokedex          — list/search cached Pokédex entries
router.get('/pokedex', listPokedexCache);

// POST /api/admin/pokedex/:id/refresh — force re-fetch a species from PokeAPI
router.post('/pokedex/:id/refresh', refreshPokedexEntry);

export default router;
