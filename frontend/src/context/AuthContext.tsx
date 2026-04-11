import { createContext } from 'react';

export type User = {
  id: string;
  username: string;
  email: string;
  role: 'player' | 'dm' | 'admin';
  trainerStats: Record<string, number>;
  trainerStatChoice: string | null;
  badges: string[];
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