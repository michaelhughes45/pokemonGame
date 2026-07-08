import { createContext } from 'react';

export type BadgeEntry = {
  badgeId: string;
  name: string;
  imageUrl: string;
  awardedAt: string;
};

export type User = {
  id: string;
  username: string;
  email: string;
  role: 'player' | 'dm' | 'admin';
  trainerStats: Record<string, number>;
  trainerStatChoice: string | null;
  badges: BadgeEntry[];
  money: number;
};

export type AuthContextType = {
  token: string | null;
  user: User | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
};

export const AuthContext = createContext<AuthContextType | null>(null);