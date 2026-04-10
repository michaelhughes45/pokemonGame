import { Router } from 'express';

const router = Router();

// Placeholder — real DM endpoints added in later milestones
router.get('/ping', (_req, res) => {
  res.json({ data: 'dm route reachable', error: null });
});

export default router;
