import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { connectDB } from './lib/db';
import authRouter from './routes/auth';
import dmRouter from './routes/dm';
import adminRouter from './routes/admin';
import pokedexRouter from './routes/pokedex';
import starterRouter from './routes/starter';
import pokemonRouter from './routes/pokemon';
import itemsRouter from './routes/items';
import campaignsRouter from './routes/campaigns';
import battlesRouter from './routes/battles';
import shopRouter from './routes/shop';
import { verifyToken, requireDm, requireAdmin } from './middleware/auth';

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/pokedex', pokedexRouter);
app.use('/api/starter', verifyToken, starterRouter);
app.use('/api/pokemon', verifyToken, pokemonRouter);
app.use('/api/items', verifyToken, itemsRouter);
app.use('/api/campaigns', verifyToken, campaignsRouter);
app.use('/api/battles', verifyToken, battlesRouter);
app.use('/api/shop', verifyToken, shopRouter);
app.use('/api/dm', verifyToken, requireDm, dmRouter);
app.use('/api/admin', verifyToken, requireAdmin, adminRouter);

// Global error handler — catches any unhandled error passed to next(err) or thrown in an async handler.
// Respects the error's own statusCode/status when present (e.g. body-parser's 400 on malformed
// JSON) instead of always reporting 500 — but only surfaces the error's own message for 4xx
// errors, since those are client-caused and safe to show; 5xx/unrecognized errors stay generic
// to avoid leaking internals (stack traces, DB errors, etc.) to the client.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const errObj  = err as { statusCode?: number; status?: number; message?: string };
  const status  = errObj?.statusCode ?? errObj?.status ?? 500;
  const message = status >= 400 && status < 500 && errObj?.message ? errObj.message : 'Internal server error';
  res.status(status).json({ data: null, error: message });
});

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
