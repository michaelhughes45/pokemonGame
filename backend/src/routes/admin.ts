import { Router } from 'express';

const router = Router();

// Placeholder — real admin endpoints added in later milestones
router.get('/ping', (_req, res) => {
  res.json({ data: 'admin route reachable', error: null });
});

export default router;
