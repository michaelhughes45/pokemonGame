import { createContext } from 'react';

export type BadgeEntry = {
  badgeId: string;
  name: string;
  imageUrl: string;
  awardedAt: string;
};

export type TrainerStats = { hp: number; atk: number; def: number; spatk: number; spdef: number; speed: number };

export type User = {
  id: string;
  username: string;
  email: string;
  role: 'player' | 'dm' | 'admin';
  trainerStats: TrainerStats;
  trainerIvUnspent: number;
  badges: BadgeEntry[];
  money: number;
};

export type AuthContextType = {
  token: string | null;
  user: User | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  loading: boolean;
};

export const AuthContext = createContext<AuthContextType | null>(null);