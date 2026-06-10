import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CampaignPlayer = { _id: string; username: string };

type RosterPokemon = {
  _id: string;
  speciesId: number;
  speciesName: string;
  nickname: string | null;
  level: number;
  exp: number;
  expForCurrentLevel: number;
  expForNextLevel: number | null;
  currentHp: number;
  maxHp: number;
  nature: string;
  gender: string | null;
  statusCondition: string | null;
  heldItem: string | null;
  isInParty: boolean;
  partySlot: number | null;
};

type Roster = { party: RosterPokemon[]; pc: RosterPokemon[] };

function apiError(err: unknown, fallback: string) {
  return axios.isAxiosError(err)
    ? (err.response?.data?.error ?? fallback)
    : fallback;
}

// ---------------------------------------------------------------------------
// ExpBar
// Shows a thin coloured progress bar for EXP within the current level.
// ---------------------------------------------------------------------------

function ExpBar({ poke }: { poke: RosterPokemon }) {
  if (poke.level >= 100) {
    return <p className="text-xs text-muted-foreground">EXP: MAX</p>;
  }
  const gained = poke.exp - poke.expForCurrentLevel;
  const needed = (poke.expForNextLevel ?? poke.exp) - poke.expForCurrentLevel;
  const pct    = needed > 0 ? Math.min(100, Math.round((gained / needed) * 100)) : 100;
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
        <span>EXP</span>
        <span>{gained} / {needed}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-yellow-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HpBar
// ---------------------------------------------------------------------------

function HpBar({ current, max }: { current: number; max: number }) {
  const pct    = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const colour = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
        <span>HP</span>
        <span>{current} / {max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${colour}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PokemonCard
// Renders one Pokémon in the roster. Action controls are added in 4.14.4.
// ---------------------------------------------------------------------------

export type PokemonCardProps = {
  poke: RosterPokemon;
  /** Slot in the actions area — filled by 4.14.4 */
  actions?: React.ReactNode;
};

export function PokemonCard({ poke, actions }: PokemonCardProps) {
  const displayName = poke.nickname
    ? `${poke.nickname} (${poke.speciesName})`
    : poke.speciesName;

  const statusColour: Record<string, string> = {
    burn: 'bg-orange-500', paralysis: 'bg-yellow-500', sleep: 'bg-gray-500',
    freeze: 'bg-blue-400', poison: 'bg-purple-500', toxic: 'bg-purple-700',
  };

  return (
    <div className="flex gap-3 p-3 rounded-lg border bg-card">
      <img
        src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${poke.speciesId}.png`}
        alt={poke.speciesName}
        className="w-16 h-16 object-contain"
      />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/pokemon/${poke._id}`} className="font-semibold hover:underline truncate">
            {displayName}
          </Link>
          <Badge variant="secondary" className="text-xs shrink-0">Lv {poke.level}</Badge>
          {poke.statusCondition && (
            <span className={`text-[10px] font-bold text-white px-1.5 py-0.5 rounded ${statusColour[poke.statusCondition] ?? 'bg-gray-400'}`}>
              {poke.statusCondition.toUpperCase().slice(0, 3)}
            </span>
          )}
        </div>
        <HpBar current={poke.currentHp} max={poke.maxHp} />
        <ExpBar poke={poke} />
        {actions && <div className="pt-1">{actions}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionControls
// Award EXP or level-up a single Pokémon. Calls onRefresh after success so
// the parent re-fetches the full roster and bars update immediately.
// ---------------------------------------------------------------------------

type ActionControlsProps = {
  poke:      RosterPokemon;
  headers:   { Authorization: string };
  onRefresh: () => void;
};

function ActionControls({ poke, headers, onRefresh }: ActionControlsProps) {
  const [expInput, setExpInput] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [message,  setMessage]  = useState('');
  const [isError,  setIsError]  = useState(false);

  function showMsg(text: string, error = false) {
    setMessage(text);
    setIsError(error);
    setTimeout(() => setMessage(''), 4000);
  }

  async function handleAwardExp() {
    const amount = parseInt(expInput, 10);
    if (!amount || amount <= 0) {
      showMsg('Enter a positive number.', true);
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post(
        `${API}/api/dm/pokemon/${poke._id}/award-exp`,
        { exp: amount },
        { headers },
      );
      showMsg((res.data.data?.events as string[]).join(' '));
      setExpInput('');
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to award EXP'), true);
    } finally {
      setBusy(false);
    }
  }

  async function handleLevelUp() {
    setBusy(true);
    try {
      const res = await axios.post(
        `${API}/api/dm/pokemon/${poke._id}/level-up`,
        {},
        { headers },
      );
      showMsg((res.data.data?.events as string[]).join(' '));
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to level up'), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          value={expInput}
          onChange={e => setExpInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAwardExp()}
          placeholder="EXP amount"
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm min-w-0"
          disabled={busy}
        />
        <Button size="sm" onClick={handleAwardExp} disabled={busy || !expInput} className="shrink-0">
          Award EXP
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleLevelUp}
          disabled={busy || poke.level >= 100}
          className="shrink-0"
        >
          Level Up
        </Button>
      </div>
      {message && (
        <p className={`text-xs ${isError ? 'text-red-500' : 'text-green-600'}`}>{message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DmPlayersPage
// ---------------------------------------------------------------------------

export default function DmPlayersPage() {
  const { token } = useAuth();
  const headers   = { Authorization: `Bearer ${token}` };

  const [players,          setPlayers]          = useState<CampaignPlayer[]>([]);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [roster,           setRoster]           = useState<Roster | null>(null);
  const [rosterKey,        setRosterKey]        = useState(0);
  const [playersLoading,   setPlayersLoading]   = useState(true);
  const [rosterLoading,    setRosterLoading]    = useState(false);
  const [playersError,     setPlayersError]     = useState('');
  const [rosterError,      setRosterError]      = useState('');

  const refreshRoster = () => setRosterKey(k => k + 1);

  // Load campaign player list on mount
  useEffect(() => {
    axios.get(`${API}/api/campaigns/mine`, { headers })
      .then(res => setPlayers(res.data.data?.players ?? []))
      .catch(err => setPlayersError(apiError(err, 'Failed to load campaign players')))
      .finally(() => setPlayersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load roster whenever selectedUsername changes or refreshRoster() is called
  useEffect(() => {
    if (!selectedUsername) { setRoster(null); return; }
    setRosterLoading(true);
    setRosterError('');
    axios.get(`${API}/api/dm/players/${selectedUsername}/roster`, { headers })
      .then(res => setRoster(res.data.data))
      .catch(err => setRosterError(apiError(err, 'Failed to load roster')))
      .finally(() => setRosterLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUsername, rosterKey]);

  if (playersLoading) return <div className="p-6 text-center text-muted-foreground">Loading…</div>;
  if (playersError)   return <div className="p-6 text-center text-red-500">{playersError}</div>;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/dm" className="text-sm text-muted-foreground hover:underline">← DM Panel</Link>
        <h1 className="text-2xl font-bold">Player Pokémon</h1>
      </div>

      {/* Player picker */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Player</CardTitle>
        </CardHeader>
        <CardContent>
          {players.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players in your campaign yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {players.map(p => (
                <Button
                  key={p._id}
                  variant={selectedUsername === p.username ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedUsername(p.username)}
                >
                  {p.username}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Roster */}
      {selectedUsername && (
        <div className="space-y-4">
          {rosterLoading && (
            <p className="text-center text-muted-foreground">Loading roster…</p>
          )}
          {rosterError && (
            <p className="text-center text-red-500">{rosterError}</p>
          )}
          {roster && !rosterLoading && (
            <>
              {roster.party.length === 0 && roster.pc.length === 0 ? (
                <p className="text-center text-muted-foreground">
                  {selectedUsername} has no Pokémon yet.
                </p>
              ) : (
                <>
                  {roster.party.length > 0 && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          Party
                          <Badge variant="secondary" className="ml-2 text-xs">{roster.party.length}</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {roster.party.map(poke => (
                          <PokemonCard key={poke._id} poke={poke} actions={<ActionControls poke={poke} headers={headers} onRefresh={refreshRoster} />} />
                        ))}
                      </CardContent>
                    </Card>
                  )}
                  {roster.pc.length > 0 && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          PC Storage
                          <Badge variant="secondary" className="ml-2 text-xs">{roster.pc.length}</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {roster.pc.map(poke => (
                          <PokemonCard key={poke._id} poke={poke} actions={<ActionControls poke={poke} headers={headers} onRefresh={refreshRoster} />} />
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
