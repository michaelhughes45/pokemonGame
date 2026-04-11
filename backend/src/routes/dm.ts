import { Router, Request, Response } from 'express';
import { User } from '../models/User';
import { Pokemon } from '../models/Pokemon';

const router = Router();

// DELETE /api/dm/players/:username/starter
// Deletes all Pokémon belonging to the player so they can pick a new starter.
// Accessible to DM and admin (requireDm middleware is applied in index.ts).
router.delete('/players/:username/starter', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const user = await User.findOne({ username }).lean();
  if (!user) {
    res.status(404).json({ data: null, error: `Player "${username}" not found` });
    return;
  }

  const result = await Pokemon.deleteMany({ ownerId: user._id });

  res.json({
    data: { deleted: result.deletedCount, username },
    error: null,
  });
});

export default router;
