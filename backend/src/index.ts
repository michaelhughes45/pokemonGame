import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './lib/db';
import authRouter from './routes/auth';
import dmRouter from './routes/dm';
import adminRouter from './routes/admin';
import { verifyToken, requireDm, requireAdmin } from './middleware/auth';

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/dm', verifyToken, requireDm, dmRouter);
app.use('/api/admin', verifyToken, requireAdmin, adminRouter);

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  });
