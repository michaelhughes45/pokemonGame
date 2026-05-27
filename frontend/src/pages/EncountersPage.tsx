import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EncounterSummary = {
  _id: string;
  title: string;
  type: 'pve' | 'wild';
  enemies: { npcId: string }[];
  wildPokemon: { speciesId: number; level: number; catchable: boolean }[];
  playerPokemonLimit: number | null;
  npcPokemonLimit: number | null;
  isActive: boolean;
};

type CampaignPlayer = { _id: string; username: string };

function apiError(err: unknown, fallback: string) {
  return axios.isAxiosError(err)
    ? (err.response?.data?.error ?? fallback)
    : fallback;
}

// ---------------------------------------------------------------------------
// EncounterRow
// Renders one encounter with its type badge, stat summary, and action buttons.
// Launch flow: clicking "Launch" expands an inline player-picker. Confirming
// POSTs to /api/dm/encounters/:id/launch and navigates to /battle/:id.
// ---------------------------------------------------------------------------

type EncounterRowProps = {
  encounter: EncounterSummary;
  players: CampaignPlayer[];
  headers: { Authorization: string };
  onDelete: (id: string) => void;
};

function EncounterRow({ encounter, players, headers, onDelete }: EncounterRowProps) {
  const navigate = useNavigate();

  const [launching,       setLaunching]       = useState(false);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [launchError,     setLaunchError]     = useState('');
  const [confirmDelete,   setConfirmDelete]   = useState(false);
  const [deleting,        setDeleting]        = useState(false);

  function togglePlayer(id: string) {
    setSelectedPlayers(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function openLaunch() {
    // Pre-select all players for convenience
    setSelectedPlayers(new Set(players.map(p => p._id)));
    setLaunchError('');
    setLaunching(true);
  }

  async function handleLaunch() {
    if (selectedPlayers.size === 0) {
      setLaunchError('Select at least one player.');
      return;
    }
    setLaunchError('');
    try {
      const res = await axios.post(
        `${API}/api/dm/encounters/${encounter._id}/launch`,
        { playerIds: Array.from(selectedPlayers) },
        { headers },
      );
      navigate(`/battle/${res.data.data.battleId}`);
    } catch (err) {
      setLaunchError(apiError(err, 'Failed to launch encounter'));
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await axios.delete(`${API}/api/dm/encounters/${encounter._id}`, { headers });
      onDelete(encounter._id);
    } catch {
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  // Summary line: "2 NPCs" or "3 wild Pokémon"
  const summary = encounter.type === 'pve'
    ? `${encounter.enemies.length} NPC${encounter.enemies.length !== 1 ? 's' : ''}`
    : `${encounter.wildPokemon.length} wild Pokémon`;

  const limitNote = encounter.playerPokemonLimit !== null
    ? `limit ${encounter.playerPokemonLimit} per player`
    : 'no player limit';

  return (
    <li className="border rounded-md p-3 flex flex-col gap-3">

      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-medium text-sm truncate">{encounter.title}</span>
          <span className="text-xs text-muted-foreground">{summary} · {limitNote}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant={encounter.type === 'pve' ? 'default' : 'secondary'}>
            {encounter.type === 'pve' ? 'PvE' : 'Wild'}
          </Badge>
          {!encounter.isActive && (
            <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
          )}
        </div>
      </div>

      {/* Action buttons or launch form */}
      {launching ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          <p className="text-sm font-medium">Select players</p>
          {players.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players in campaign.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {players.map(p => (
                <label key={p._id} className="flex items-center gap-2 text-sm cursor-pointer min-h-9">
                  <input
                    type="checkbox"
                    checked={selectedPlayers.has(p._id)}
                    onChange={() => togglePlayer(p._id)}
                    className="h-4 w-4"
                  />
                  {p.username}
                </label>
              ))}
            </div>
          )}
          {launchError && <p className="text-sm text-destructive">{launchError}</p>}
          <div className="flex gap-2">
            <Button
              onClick={handleLaunch}
              disabled={selectedPlayers.size === 0}
              className="flex-1 min-h-11"
            >
              Launch with {selectedPlayers.size} player{selectedPlayers.size !== 1 ? 's' : ''}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setLaunching(false)}
              className="min-h-11"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={openLaunch}
            disabled={players.length === 0}
            className="min-h-9 text-sm"
            size="sm"
          >
            Launch →
          </Button>
          <Link to={`/dm/encounters/${encounter._id}/edit`}>
            <Button variant="outline" size="sm" className="min-h-9 text-sm">
              Edit
            </Button>
          </Link>
          {confirmDelete ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                className="min-h-9 text-sm"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-9 text-sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-9 text-sm text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// EncountersPage
// ---------------------------------------------------------------------------

export default function EncountersPage() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [encounters, setEncounters] = useState<EncounterSummary[]>([]);
  const [players,    setPlayers]    = useState<CampaignPlayer[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');

  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/dm/encounters`, { headers }),
      axios.get(`${API}/api/campaigns/mine`,   { headers }),
    ])
      .then(([encRes, campRes]) => {
        setEncounters(encRes.data.data ?? []);
        setPlayers(campRes.data.data?.players ?? []);
      })
      .catch(err => setError(apiError(err, 'Failed to load encounters')))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function removeEncounter(id: string) {
    setEncounters(prev => prev.filter(e => e._id !== id));
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Encounters</h1>
          <Link to="/dm" className="text-sm underline text-muted-foreground">
            ← DM Panel
          </Link>
        </div>

        {/* New encounter button */}
        <Link to="/dm/encounters/new">
          <Button className="w-full min-h-11">+ New Encounter</Button>
        </Link>

        {/* Encounter list */}
        <Card>
          <CardHeader>
            <CardTitle>Your Encounters</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : encounters.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No encounters yet. Create one above to get started.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {encounters.map(enc => (
                  <EncounterRow
                    key={enc._id}
                    encounter={enc}
                    players={players}
                    headers={headers}
                    onDelete={removeEncounter}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
