import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types returned by GET /api/battles/:id/state
// ---------------------------------------------------------------------------

type PlayerSideEntry = {
  userId: string;
  username: string;
  activePokemonId: string | null;
  usedPokemonIds: string[];
  fainted: string[];
};

type BattleState = {
  _id: string;
  type: 'pve' | 'wild' | 'pvp';
  status: 'waiting' | 'active' | 'complete';
  phase: 'move_submission' | 'targeting' | 'end_of_round';
  playerSide: PlayerSideEntry[];
  enemySide: unknown[];
  turnNumber: number;
  weather: string | null;
  playerPokemonLimit: number | null;
  lastUpdatedAt: string;
};

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  pve:  'PvE',
  wild: 'Wild',
  pvp:  'PvP',
};

const STATUS_LABELS: Record<string, string> = {
  waiting:  'Waiting',
  active:   'Active',
  complete: 'Complete',
};

// Tailwind colour classes per battle status — used for the badge
const STATUS_COLOURS: Record<string, string> = {
  waiting:  'bg-muted text-muted-foreground',
  active:   'bg-green-100 text-green-800',
  complete: 'bg-secondary text-secondary-foreground',
};

// ---------------------------------------------------------------------------
// BattlePage
// ---------------------------------------------------------------------------

export default function BattlePage() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();

  const [battle,  setBattle]  = useState<BattleState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function fetchState() {
      try {
        const res = await axios.get(`${API}/api/battles/${id}/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled) {
          setBattle(res.data.data);
          setError('');
        }
      } catch {
        if (!cancelled) setError('Could not load battle.');
      } finally {
        // Only clear the initial loading spinner on the very first fetch.
        // Subsequent polls run silently — the UI stays visible while data refreshes.
        if (!cancelled) setLoading(false);
      }
    }

    fetchState();
    const interval = setInterval(fetchState, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, token]);

  const isDm = user?.role === 'dm' || user?.role === 'admin';

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading battle…</p>
      </div>
    );
  }

  if (error || !battle) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-4">
        <p className="text-sm text-destructive">{error || 'Battle not found.'}</p>
        <Link to={isDm ? '/dm' : '/dashboard'} className="text-sm underline text-muted-foreground">
          ← {isDm ? 'DM Panel' : 'Dashboard'}
        </Link>
      </div>
    );
  }

  const statusColour = STATUS_COLOURS[battle.status] ?? 'bg-muted text-muted-foreground';

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Battle</h1>
          <Link
            to={isDm ? '/dm' : '/dashboard'}
            className="text-sm underline text-muted-foreground"
          >
            ← {isDm ? 'DM Panel' : 'Dashboard'}
          </Link>
        </div>

        {/* Battle info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              {TYPE_LABELS[battle.type] ?? battle.type} Battle
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColour}`}>
                {STATUS_LABELS[battle.status] ?? battle.status}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <p>Battle ID: <span className="font-mono text-foreground">{battle._id}</span></p>
            {battle.playerPokemonLimit !== null && (
              <p>Pokémon limit per player: {battle.playerPokemonLimit}</p>
            )}
            {battle.weather && <p>Weather: {battle.weather}</p>}
          </CardContent>
        </Card>

        {/* Player side */}
        <Card>
          <CardHeader><CardTitle>Player Side</CardTitle></CardHeader>
          <CardContent>
            {battle.playerSide.length === 0 ? (
              <p className="text-sm text-muted-foreground">No players in this battle.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {battle.playerSide.map(entry => (
                  <li key={entry.userId} className="flex items-center justify-between text-sm">
                    <span className="font-medium">{entry.username}</span>
                    <span className="text-muted-foreground">
                      {entry.activePokemonId ? 'Pokémon selected' : 'No active Pokémon'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Enemy side */}
        <Card>
          <CardHeader><CardTitle>Enemy Side</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No enemies yet — enemies are added via the encounter builder (coming soon).
            </p>
          </CardContent>
        </Card>

        {/* Waiting indicator */}
        {battle.status === 'waiting' && (
          <p className="text-sm text-center text-muted-foreground">
            Waiting for the DM to start the battle…
          </p>
        )}

      </div>
    </div>
  );
}
