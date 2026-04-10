import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

type JwtPayload = {
  userId: string;
  role: 'player' | 'dm' | 'admin';
};

// Extend Express's Request type so req.user is available in route handlers
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireDm(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || (req.user.role !== 'dm' && req.user.role !== 'admin')) {
    res.status(403).json({ data: null, error: 'DM or Admin access required' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ data: null, error: 'Admin access required' });
    return;
  }
  next();
}

export function verifyToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ data: null, error: 'Missing or malformed token' });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ data: null, error: 'Invalid or expired token' });
  }
}
