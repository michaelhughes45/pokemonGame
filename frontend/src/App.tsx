import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import axios from 'axios';
import { AuthProvider } from './context/AuthProvider';
import { ThemeProvider } from './context/ThemeProvider';
import { ThemeToggle } from './components/ThemeToggle';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import StarterPage from './pages/StarterPage';
import DmPage from './pages/DmPage';
import PokemonDetailPage from './pages/PokemonDetailPage';
import PartyPage from './pages/PartyPage';
import PCPage from './pages/PCPage';
import BagPage from './pages/BagPage';
import BattlePage from './pages/BattlePage';
import TownPage from './pages/TownPage';
import EncountersPage from './pages/EncountersPage';
import EncounterFormPage from './pages/EncounterFormPage';
import DmPlayersPage from './pages/DmPlayersPage';
import AdminPage from './pages/AdminPage';

const API = import.meta.env.VITE_API_URL;

function RequireDm({ children }: { children: React.ReactNode }) {
  const { token, user, loading } = useAuth();
  if (loading) return null;
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role !== 'dm' && user?.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { token, user, loading } = useAuth();
  if (loading) return null;
  if (!token) return <Navigate to="/login" replace />;
  if (user?.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

// Blocks /pc and /town for players whose campaign is currently in Field mode.
// DMs/admins have no player character (see Key Decisions), so the check only
// applies to the 'player' role — everyone else passes through untouched.
function RequireTownMode({ children }: { children: React.ReactNode }) {
  const { token, user, loading } = useAuth();
  const [checking, setChecking] = useState(true);
  const [blocked, setBlocked]   = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!token || user?.role !== 'player') {
      setChecking(false);
      return;
    }
    let cancelled = false;
    axios
      .get(`${API}/api/campaigns/mine`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => { if (!cancelled) setBlocked(Boolean(res.data.data?.fieldModeEnabled)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [token, user, loading]);

  if (loading || checking) return null;
  if (blocked) {
    return (
      <Navigate
        to="/dashboard"
        replace
        state={{ blockedMessage: 'This area is unavailable while your campaign is in Field mode.' }}
      />
    );
  }
  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth();

  // Still checking localStorage / fetching user — render nothing to avoid flash
  if (loading) return null;

  // Not logged in — send to login
  if (!token) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

function AppRoutes() {
  const { token, loading } = useAuth();

  if (loading) return null;

  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
      <Route path="/register" element={token ? <Navigate to="/dashboard" replace /> : <RegisterPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/starter"
        element={
          <ProtectedRoute>
            <StarterPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/pokemon/:id"
        element={
          <ProtectedRoute>
            <PokemonDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/party"
        element={
          <ProtectedRoute>
            <PartyPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/pc"
        element={
          <ProtectedRoute>
            <RequireTownMode>
              <PCPage />
            </RequireTownMode>
          </ProtectedRoute>
        }
      />
      <Route
        path="/bag"
        element={
          <ProtectedRoute>
            <BagPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/battle/:id"
        element={
          <ProtectedRoute>
            <BattlePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/town"
        element={
          <ProtectedRoute>
            <RequireTownMode>
              <TownPage />
            </RequireTownMode>
          </ProtectedRoute>
        }
      />
      <Route
        path="/dm"
        element={
          <RequireDm>
            <DmPage />
          </RequireDm>
        }
      />
      <Route
        path="/dm/encounters"
        element={
          <RequireDm>
            <EncountersPage />
          </RequireDm>
        }
      />
      <Route
        path="/dm/encounters/new"
        element={
          <RequireDm>
            <EncounterFormPage />
          </RequireDm>
        }
      />
      <Route
        path="/dm/encounters/:id/edit"
        element={
          <RequireDm>
            <EncounterFormPage />
          </RequireDm>
        }
      />
      <Route
        path="/dm/players"
        element={
          <RequireDm>
            <DmPlayersPage />
          </RequireDm>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <AdminPage />
          </RequireAdmin>
        }
      />
      {/* Default: redirect root to dashboard (ProtectedRoute will bounce to /login if needed) */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <ThemeToggle />
          <AppRoutes />
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
