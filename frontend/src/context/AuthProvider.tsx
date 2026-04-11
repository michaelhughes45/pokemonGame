import { useEffect, useState } from 'react';
import axios from 'axios';
import { AuthContext } from './AuthContext';
import type { User } from './AuthContext';

const API = import.meta.env.VITE_API_URL;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  // Only loading if there's a token to validate — no token means nothing to wait for
  const [loading, setLoading] = useState(() => !!localStorage.getItem('token'));

  // On mount: if a token exists in localStorage, fetch the user to hydrate state
  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    if (!savedToken) return;

    axios
      .get(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${savedToken}` } })
      .then((res) => setUser(res.data.data))
      .catch(() => {
        // Token is invalid or expired — clear it
        localStorage.removeItem('token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(newToken: string) {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    const res = await axios.get(`${API}/api/auth/me`, {
      headers: { Authorization: `Bearer ${newToken}` },
    });
    setUser(res.data.data);
  }

  function logout() {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ token, user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
