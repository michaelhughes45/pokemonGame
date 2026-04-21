import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnQueueEntry = {
  actorId: string;
  actorType: 'player' | 'npc';
  activePokemonId: string;
  moveId: string;
  targets: string[];
  resolved: boolean;
};

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
  turnQueue: TurnQueueEntry[];
  weather: string | null;
  playerPokemonLimit: number | null;
  lastUpdatedAt: string;
};

// Returned by GET /api/pokemon/party
type PartyPokemon = {
  _id: string;
  speciesId: number;
  nickname: string | null;
  level: number;
  currentHp: number;
  maxHp: number | null;
  speciesName: string | null;
  statusCondition: string | null;
};

// Returned by GET /api/pokemon/:id (subset we need)
type MoveSlot = { moveId: string; currentPP: number; maxPP: number };
type LearnableMove = { name: string; type: string; power: number | null; accuracy: number | null };

type ActivePokemonDetail = {
  _id: string;
  nickname: string | null;
  level: number;
  currentHp: number;
  maxHp: number;
  moves: MoveSlot[];
  species: { name: string; types: string[]; learnableMoves: LearnableMove[] };
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  pve: 'PvE', wild: 'Wild', pvp: 'PvP',
};

const STATUS_LABELS: Record<string, string> = {
  waiting: 'Waiting', active: 'Active', complete: 'Complete',
};

const STATUS_COLOURS: Record<string, string> = {
  waiting:  'bg-muted text-muted-foreground',
  active:   'bg-green-100 text-green-800',
  complete: 'bg-secondary text-secondary-foreground',
};

const PHASE_LABELS: Record<string, string> = {
  move_submission: 'Move Submission',
  targeting:       'Targeting',
  end_of_round:    'End of Round',
};

function apiError(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === 'object' &&
    'response' in err &&
    err.response &&
    typeof err.response === 'object' &&
    'data' in err.response &&
    err.response.data &&
    typeof err.response.data === 'object' &&
    'error' in err.response.data &&
    typeof (err.response.data as { error: unknown }).error === 'string'
  ) {
    return (err.response.data as { error: string }).error;
  }
  return fallback;
}

// "hydro-pump" → "Hydro Pump"
function formatMove(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Display name for a party Pokémon
function pokemonLabel(p: PartyPokemon): string {
  return p.nickname ?? p.speciesName ?? `#${p.speciesId}`;
}

// ---------------------------------------------------------------------------
// BattlePage
// ---------------------------------------------------------------------------

export default function BattlePage() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();

  const [battle,              setBattle]              = useState<BattleState | null>(null);
  const [loading,             setLoading]             = useState(true);
  const [error,               setError]               = useState('');
  const [party,               setParty]               = useState<PartyPokemon[]>([]);
  const [activePokemonDetail, setActivePokemonDetail] = useState<ActivePokemonDetail | null>(null);
  const [submitting,          setSubmitting]          = useState(false);
  const [actionError,         setActionError]         = useState('');

  // Polling loop — fetches full battle state every 3 seconds
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
        if (!cancelled) setLoading(false);
      }
    }

    fetchState();
    const interval = setInterval(fetchState, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id, token]);

  // Fetch party for players (not DM) so they can pick which Pokémon to send out
  useEffect(() => {
    if (!token || user?.role === 'dm' || user?.role === 'admin') return;
    axios.get(`${API}/api/pokemon/party`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => setParty(res.data.data ?? []))
      .catch(() => {});
  }, [token, user?.role]);

  // Fetch active Pokémon detail (moves, type data) when activePokemonId becomes known
  const myEntry = battle?.playerSide.find(e => e.userId === user?.id);
  const activePokemonId = myEntry?.activePokemonId ?? null;

  useEffect(() => {
    if (!activePokemonId || !token) {
      setActivePokemonDetail(null);
      return;
    }
    let cancelled = false;
    axios.get(`${API}/api/pokemon/${activePokemonId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => { if (!cancelled) setActivePokemonDetail(res.data.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activePokemonId, token]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const isDm = user?.role === 'dm' || user?.role === 'admin';

  // Has the current player already submitted a move this round?
  const alreadySubmitted = battle?.turnQueue.some(
    e => e.actorId === user?.id && e.actorType === 'player'
  ) ?? false;

  // Build a lookup from moveId slug → learnable move details for type/power display
  const moveDetailMap = new Map(
    (activePokemonDetail?.species.learnableMoves ?? []).map(m => [m.name, m])
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleStartBattle() {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/start`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to start battle.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendOut(pokemonId: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/send-out`, { pokemonId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to send out Pokémon.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitMove(moveId: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/submit-move`, { moveId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit move.'));
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

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
              {battle.status === 'active' && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                  {PHASE_LABELS[battle.phase] ?? battle.phase}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {battle.status === 'active' && (
              <p>Turn <span className="font-medium text-foreground">{battle.turnNumber}</span></p>
            )}
            {battle.playerPokemonLimit !== null && (
              <p>Pokémon limit per player: {battle.playerPokemonLimit}</p>
            )}
            {battle.weather && <p>Weather: {battle.weather}</p>}
          </CardContent>
        </Card>

        {/* DM: start battle */}
        {isDm && battle.status === 'waiting' && (
          <Card>
            <CardContent className="pt-6 flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Players are waiting. Start the battle when everyone is ready.
              </p>
              {actionError && <p className="text-sm text-destructive">{actionError}</p>}
              <Button
                onClick={handleStartBattle}
                disabled={submitting}
                className="w-full min-h-11"
              >
                {submitting ? 'Starting…' : 'Start Battle'}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Player: waiting for DM to start */}
        {!isDm && battle.status === 'waiting' && (
          <p className="text-sm text-center text-muted-foreground">
            Waiting for the DM to start the battle…
          </p>
        )}

        {/* Player: send-out picker — shown when battle is active but no active Pokémon yet */}
        {!isDm && battle.status === 'active' && !myEntry?.activePokemonId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Choose your Pokémon</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {actionError && <p className="text-sm text-destructive">{actionError}</p>}
              {party.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Pokémon in your party.</p>
              ) : (
                party.map(p => {
                  const fainted = p.currentHp <= 0;
                  return (
                    <button
                      key={p._id}
                      onClick={() => !fainted && !submitting && handleSendOut(p._id)}
                      disabled={fainted || submitting}
                      className={[
                        'flex items-center justify-between rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                        fainted
                          ? 'opacity-40 cursor-not-allowed bg-muted'
                          : 'hover:bg-accent cursor-pointer',
                      ].join(' ')}
                    >
                      <span className="font-medium">{pokemonLabel(p)}</span>
                      <span className="text-muted-foreground text-xs">
                        Lv.{p.level}
                        {' · '}
                        {fainted
                          ? 'Fainted'
                          : `HP ${p.currentHp}${p.maxHp != null ? `/${p.maxHp}` : ''}`
                        }
                      </span>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>
        )}

        {/* Player: move submission */}
        {!isDm && battle.status === 'active' && battle.phase === 'move_submission' && myEntry?.activePokemonId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {alreadySubmitted ? 'Move Submitted' : 'Choose a Move'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {/* Active Pokémon summary */}
              {activePokemonDetail && (
                <p className="text-sm text-muted-foreground">
                  {activePokemonDetail.nickname ?? activePokemonDetail.species.name}
                  {' '}Lv.{activePokemonDetail.level}
                  {' · '}HP {activePokemonDetail.currentHp}/{activePokemonDetail.maxHp}
                </p>
              )}

              {alreadySubmitted ? (
                <p className="text-sm text-center text-muted-foreground py-2">
                  Move submitted — waiting for other trainers…
                </p>
              ) : (
                <>
                  {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                  {activePokemonDetail ? (
                    <div className="grid grid-cols-2 gap-2">
                      {activePokemonDetail.moves.map(slot => {
                        const detail = moveDetailMap.get(slot.moveId);
                        const noPP   = slot.currentPP <= 0;
                        return (
                          <button
                            key={slot.moveId}
                            onClick={() => !noPP && !submitting && handleSubmitMove(slot.moveId)}
                            disabled={noPP || submitting}
                            className={[
                              'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                              noPP
                                ? 'opacity-40 cursor-not-allowed bg-muted'
                                : 'hover:bg-accent cursor-pointer',
                            ].join(' ')}
                          >
                            <span className="font-medium">{formatMove(slot.moveId)}</span>
                            <span className="text-muted-foreground text-xs mt-0.5">
                              {detail?.type ? `${detail.type} · ` : ''}
                              {detail?.power != null ? `Pwr ${detail.power} · ` : ''}
                              PP {slot.currentPP}/{slot.maxPP}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Loading moves…</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Active battle — targeting phase notice */}
        {battle.status === 'active' && battle.phase === 'targeting' && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-center text-muted-foreground">
                All moves submitted — targeting phase (coming in milestone 3.4)
              </p>
            </CardContent>
          </Card>
        )}

        {/* Player side — shows send-out and submission status for everyone */}
        <Card>
          <CardHeader><CardTitle>Player Side</CardTitle></CardHeader>
          <CardContent>
            {battle.playerSide.length === 0 ? (
              <p className="text-sm text-muted-foreground">No players in this battle.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {battle.playerSide.map(entry => {
                  const submitted = battle.turnQueue.some(
                    e => e.actorId === entry.userId && e.actorType === 'player'
                  );
                  return (
                    <li key={entry.userId} className="flex items-center justify-between text-sm">
                      <span className="font-medium">{entry.username}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {entry.activePokemonId
                          ? 'Pokémon out'
                          : 'No Pokémon out'}
                        {battle.status === 'active' && battle.phase === 'move_submission' && (
                          <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                            submitted
                              ? 'bg-green-100 text-green-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}>
                            {submitted ? 'Submitted' : 'Pending'}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
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

      </div>
    </div>
  );
}
