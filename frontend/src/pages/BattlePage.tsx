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

// Joined by the state endpoint — name and HP for whatever Pokémon is currently active
type ActivePokemonInfo = {
  _id: string;
  name: string;
  speciesName: string;
  currentHp: number;
  maxHp: number | null;
  statusCondition: string | null;
  isConfused: boolean;
};

type PlayerSideEntry = {
  userId: string;
  username: string;
  activePokemonId: string | null;
  usedPokemonIds: string[];
  fainted: string[];
  activePokemonInfo: ActivePokemonInfo | null;
};

type EnemySideEntry = {
  npcId: string;
  npcName: string;
  activePokemonId: string | null;
  fainted: string[];
  activePokemonInfo: ActivePokemonInfo | null;
};

// Returned by GET /api/dm/npcs/:npcId/party
type NpcPartyPokemon = {
  _id: string;
  speciesId: number;
  speciesName: string;
  nickname: string | null;
  level: number;
  currentHp: number;
  moves: MoveSlot[];
};

type TurnLogEntry = {
  turn: number;
  events: string[];
};

type BattleState = {
  _id: string;
  type: 'pve' | 'wild' | 'pvp';
  status: 'waiting' | 'active' | 'complete';
  phase: 'move_submission' | 'targeting' | 'end_of_round';
  playerSide: PlayerSideEntry[];
  enemySide: EnemySideEntry[];
  turnNumber: number;
  turnQueue: TurnQueueEntry[];
  currentTargetIndex: number;
  weather: string | null;
  weatherTurnsRemaining: number | null;
  noTargetMoveIds: string[];
  playerPokemonLimit: number | null;
  turnLog: TurnLogEntry[];
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

const CONDITION_BADGES: Record<string, { label: string; cls: string }> = {
  burn:      { label: 'BRN', cls: 'bg-orange-100 text-orange-800' },
  paralysis: { label: 'PAR', cls: 'bg-yellow-100 text-yellow-800' },
  sleep:     { label: 'SLP', cls: 'bg-blue-100   text-blue-800'   },
  freeze:    { label: 'FRZ', cls: 'bg-cyan-100   text-cyan-800'   },
  poison:    { label: 'PSN', cls: 'bg-purple-100 text-purple-800' },
  toxic:     { label: 'TOX', cls: 'bg-fuchsia-100 text-fuchsia-800' },
  confusion: { label: 'CNF', cls: 'bg-pink-100   text-pink-800'   },
};

function StatusBadge({ info }: { info: ActivePokemonInfo }) {
  const badges: { label: string; cls: string }[] = [];
  if (info.statusCondition && CONDITION_BADGES[info.statusCondition]) {
    badges.push(CONDITION_BADGES[info.statusCondition]);
  }
  if (info.isConfused) badges.push(CONDITION_BADGES.confusion);
  if (badges.length === 0) return null;
  return (
    <span className="flex gap-1">
      {badges.map((b, i) => (
        <span key={i} className={`text-xs font-bold px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>
      ))}
    </span>
  );
}

const WEATHER_CONFIG: Record<string, { label: string; cls: string }> = {
  rain:      { label: 'Rain',      cls: 'bg-blue-100 text-blue-800'    },
  sun:       { label: 'Harsh Sun', cls: 'bg-amber-100 text-amber-800'  },
  sandstorm: { label: 'Sandstorm', cls: 'bg-orange-100 text-orange-800' },
  hail:      { label: 'Hail',      cls: 'bg-cyan-100 text-cyan-800'    },
  snow:      { label: 'Snow',      cls: 'bg-slate-100 text-slate-700'  },
};

function WeatherBadge({ battle }: { battle: BattleState }) {
  if (!battle.weather) return null;
  const cfg = WEATHER_CONFIG[battle.weather];
  if (!cfg) return <span className="text-sm text-muted-foreground">Weather: {battle.weather}</span>;
  const turns = battle.weatherTurnsRemaining !== null ? ` · ${battle.weatherTurnsRemaining}t` : '';
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}{turns}
    </span>
  );
}

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
  const [selectedTargets,     setSelectedTargets]     = useState<string[]>([]);
  // DM NPC management: cached party data keyed by npcId, and which NPC's
  // send-out picker is currently open.
  const [npcParties,          setNpcParties]          = useState<Record<string, NpcPartyPokemon[]>>({});
  const [partyLoading,        setPartyLoading]        = useState<string | null>(null);
  const [expandedSendOut,     setExpandedSendOut]     = useState<string | null>(null);
  const [weatherInput,        setWeatherInput]        = useState('');
  const [weatherTurns,        setWeatherTurns]        = useState('');
  const [weatherActionError,  setWeatherActionError]  = useState('');

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
  }, [activePokemonId, token, battle?.turnNumber]);

  // Reset target selection whenever it becomes a new actor's turn
  const currentTargetIndex = battle?.currentTargetIndex;
  useEffect(() => {
    setSelectedTargets([]);
    setActionError('');
  }, [currentTargetIndex]);

  // Auto-fetch NPC parties for any NPC that has an active Pokémon but whose
  // party the DM hasn't loaded yet (handles page refresh mid-battle).
  const userRole = user?.role;
  useEffect(() => {
    if ((userRole !== 'dm' && userRole !== 'admin') || !battle || battle.status !== 'active') return;
    const uncached = battle.enemySide.filter(
      e => e.activePokemonId && !npcParties[e.npcId]
    );
    uncached.forEach(entry => {
      axios.get(`${API}/api/dm/npcs/${entry.npcId}/party`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => setNpcParties(prev => ({ ...prev, [entry.npcId]: res.data.data ?? [] })))
        .catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle?.enemySide, userRole]);

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
  // Targeting phase derived state
  // ---------------------------------------------------------------------------

  const currentTargetEntry = battle?.phase === 'targeting'
    ? battle.turnQueue[battle.currentTargetIndex]
    : undefined;

  // True when the current actor is this user (player turn) or this user is
  // the DM and the actor is an NPC.
  const isMyTargetTurn = currentTargetEntry
    ? (currentTargetEntry.actorType === 'player' && currentTargetEntry.actorId === user?.id) ||
      (currentTargetEntry.actorType === 'npc' && isDm)
    : false;

  // Display name for the actor currently picking targets
  const targetActorDisplayName = (() => {
    if (!currentTargetEntry || !battle) return '';
    if (currentTargetEntry.actorType === 'player') {
      return battle.playerSide.find(e => e.userId === currentTargetEntry.actorId)?.username ?? 'Unknown';
    }
    return battle.enemySide.find(e => e.npcId === currentTargetEntry.actorId)
      ?.activePokemonInfo?.name ?? 'NPC';
  })();

  const isNoTargetMove = currentTargetEntry
    ? (battle?.noTargetMoveIds ?? []).includes(currentTargetEntry.moveId)
    : false;

  // Valid targets the current actor can choose from (opposing side, active and alive)
  const opposingTargets: ActivePokemonInfo[] = (() => {
    if (!currentTargetEntry || !battle) return [];
    const side = currentTargetEntry.actorType === 'player' ? battle.enemySide : battle.playerSide;
    return side
      .filter(e => e.activePokemonId && e.activePokemonInfo && e.activePokemonInfo.currentHp > 0)
      .map(e => e.activePokemonInfo!);
  })();

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

  async function fetchNpcParty(npcId: string) {
    if (npcParties[npcId]) { setExpandedSendOut(npcId); return; }
    setPartyLoading(npcId);
    try {
      const res = await axios.get(`${API}/api/dm/npcs/${npcId}/party`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setNpcParties(prev => ({ ...prev, [npcId]: res.data.data ?? [] }));
      setExpandedSendOut(npcId);
    } catch { /* silently fail — list stays empty */ }
    finally { setPartyLoading(null); }
  }

  async function handleDmSendOut(npcId: string, pokemonId: string) {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/dm-send-out`, { npcId, pokemonId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setExpandedSendOut(null);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to send out Pokémon.'));
    } finally { setSubmitting(false); }
  }

  async function handleDmSubmitMove(npcId: string, moveId: string) {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/dm-submit-move`, { npcId, moveId }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit move.'));
    } finally { setSubmitting(false); }
  }

  async function handleAdvanceRound() {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/advance-round`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to advance round.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetWeather() {
    if (!id || submitting) return;
    setSubmitting(true);
    setWeatherActionError('');
    try {
      const weather = weatherInput || null;
      const turnsRemaining = weatherTurns ? parseInt(weatherTurns, 10) : null;
      await axios.post(
        `${API}/api/battles/${id}/weather`,
        { weather, turnsRemaining },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setWeatherInput('');
      setWeatherTurns('');
    } catch (err: unknown) {
      setWeatherActionError(apiError(err, 'Failed to set weather.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNoTargetMove() {
    if (!id || submitting) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/submit-target`, { targets: [] }, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit move.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitTarget() {
    if (!id || selectedTargets.length === 0) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/submit-target`, { targets: selectedTargets }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSelectedTargets([]);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit targets.'));
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
            {battle.weather && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Weather:</span>
                <WeatherBadge battle={battle} />
              </div>
            )}
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
                <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
                  <span>
                    {activePokemonDetail.nickname ?? activePokemonDetail.species.name}
                    {' '}Lv.{activePokemonDetail.level}
                    {' · '}HP {activePokemonDetail.currentHp}/{activePokemonDetail.maxHp}
                  </span>
                  {myEntry?.activePokemonInfo && <StatusBadge info={myEntry.activePokemonInfo} />}
                </div>
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

        {/* DM: NPC actions during move submission */}
        {isDm && battle.status === 'active' && battle.phase === 'move_submission' && battle.enemySide.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">NPC Actions</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {battle.enemySide.map(entry => {
                const npcMoveSubmitted = battle.turnQueue.some(
                  e => e.actorId === entry.npcId && e.actorType === 'npc'
                );
                const party = npcParties[entry.npcId] ?? [];
                const activePokemon = entry.activePokemonId
                  ? party.find(p => p._id === entry.activePokemonId)
                  : null;

                return (
                  <div key={entry.npcId} className="flex flex-col gap-2 border rounded-md p-3">
                    <p className="text-sm font-medium">{entry.npcName}</p>

                    {!entry.activePokemonId ? (
                      expandedSendOut === entry.npcId ? (
                        <div className="flex flex-col gap-2">
                          {partyLoading === entry.npcId ? (
                            <p className="text-sm text-muted-foreground">Loading party…</p>
                          ) : party.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No Pokémon in this NPC's party.</p>
                          ) : (
                            party.map(p => {
                              const fainted = p.currentHp <= 0;
                              return (
                                <button
                                  key={p._id}
                                  onClick={() => !fainted && !submitting && handleDmSendOut(entry.npcId, p._id)}
                                  disabled={fainted || submitting}
                                  className={[
                                    'flex items-center justify-between rounded-md border px-4 py-3 text-sm text-left min-h-11 transition-colors',
                                    fainted ? 'opacity-40 cursor-not-allowed bg-muted' : 'hover:bg-accent cursor-pointer',
                                  ].join(' ')}
                                >
                                  <span className="font-medium">{p.nickname ?? p.speciesName}</span>
                                  <span className="text-muted-foreground text-xs">
                                    Lv.{p.level} · {fainted ? 'Fainted' : `HP ${p.currentHp}`}
                                  </span>
                                </button>
                              );
                            })
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setExpandedSendOut(null)} className="min-h-9">
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => fetchNpcParty(entry.npcId)}
                          disabled={partyLoading === entry.npcId}
                          className="w-full min-h-9"
                        >
                          {partyLoading === entry.npcId ? 'Loading…' : 'Send Out Pokémon'}
                        </Button>
                      )
                    ) : npcMoveSubmitted ? (
                      <p className="text-xs text-muted-foreground">
                        {entry.activePokemonInfo?.name ?? 'Pokémon'} — move submitted
                      </p>
                    ) : activePokemon ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                          {entry.activePokemonInfo?.name ?? activePokemon.nickname ?? activePokemon.speciesName} — choose a move:
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {activePokemon.moves.map(slot => {
                            const noPP = slot.currentPP <= 0;
                            return (
                              <button
                                key={slot.moveId}
                                onClick={() => !noPP && !submitting && handleDmSubmitMove(entry.npcId, slot.moveId)}
                                disabled={noPP || submitting}
                                className={[
                                  'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                  noPP ? 'opacity-40 cursor-not-allowed bg-muted' : 'hover:bg-accent cursor-pointer',
                                ].join(' ')}
                              >
                                <span className="font-medium">{formatMove(slot.moveId)}</span>
                                <span className="text-muted-foreground text-xs mt-0.5">PP {slot.currentPP}/{slot.maxPP}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Loading party…</p>
                    )}
                  </div>
                );
              })}
              {actionError && <p className="text-sm text-destructive">{actionError}</p>}
            </CardContent>
          </Card>
        )}

        {/* Targeting phase */}
        {battle.status === 'active' && battle.phase === 'targeting' && currentTargetEntry && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {isMyTargetTurn ? 'Pick Targets' : 'Targeting Phase'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {isMyTargetTurn ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Using{' '}
                    <span className="font-medium text-foreground">
                      {formatMove(currentTargetEntry.moveId)}
                    </span>
                    {isNoTargetMove ? '.' : ' — select one or more targets below.'}
                  </p>

                  {!isNoTargetMove && (
                    opposingTargets.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No valid targets available.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {opposingTargets.map(info => {
                          const selected = selectedTargets.includes(info._id);
                          return (
                            <button
                              key={info._id}
                              onClick={() =>
                                setSelectedTargets(prev =>
                                  prev.includes(info._id)
                                    ? prev.filter(t => t !== info._id)
                                    : [...prev, info._id]
                                )
                              }
                              className={[
                                'flex items-center justify-between rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                selected
                                  ? 'border-primary bg-primary/10 font-medium'
                                  : 'hover:bg-accent cursor-pointer',
                              ].join(' ')}
                            >
                              <span>{info.name}</span>
                              <span className="flex items-center gap-2">
                                <span className="text-muted-foreground text-xs">
                                  HP {info.currentHp}{info.maxHp != null ? `/${info.maxHp}` : ''}
                                </span>
                                <StatusBadge info={info} />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )
                  )}

                  {actionError && <p className="text-sm text-destructive">{actionError}</p>}

                  {isNoTargetMove ? (
                    <Button
                      onClick={handleNoTargetMove}
                      disabled={submitting}
                      className="w-full min-h-11"
                    >
                      {submitting ? 'Confirming…' : `Use ${formatMove(currentTargetEntry.moveId)}`}
                    </Button>
                  ) : (
                    <Button
                      onClick={handleSubmitTarget}
                      disabled={selectedTargets.length === 0 || submitting}
                      className="w-full min-h-11"
                    >
                      {submitting ? 'Confirming…' : `Confirm Target${selectedTargets.length !== 1 ? 's' : ''}`}
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-sm text-center text-muted-foreground py-2">
                  Waiting for{' '}
                  <span className="font-medium text-foreground">{targetActorDisplayName}</span>
                  {isNoTargetMove ? ' to use their move…' : ' to pick targets…'}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* End of round — show log and let DM advance */}
        {battle.status === 'active' && battle.phase === 'end_of_round' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Round {battle.turnNumber} Complete</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {isDm ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Review the log below, then advance when ready.
                  </p>
                  {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                  <Button
                    onClick={handleAdvanceRound}
                    disabled={submitting}
                    className="w-full min-h-11"
                  >
                    {submitting ? 'Advancing…' : 'Advance to Next Round'}
                  </Button>
                  <div className="flex flex-col gap-2 pt-2 border-t">
                    <p className="text-sm text-muted-foreground">Set weather for next round:</p>
                    <div className="flex gap-2">
                      <select
                        value={weatherInput}
                        onChange={e => setWeatherInput(e.target.value)}
                        className="flex-1 rounded-md border px-3 py-2 text-sm bg-background"
                      >
                        <option value="">— clear —</option>
                        <option value="rain">Rain</option>
                        <option value="sun">Harsh Sun</option>
                        <option value="sandstorm">Sandstorm</option>
                        <option value="hail">Hail</option>
                        <option value="snow">Snow</option>
                      </select>
                      <input
                        type="number"
                        min={1}
                        placeholder="turns"
                        value={weatherTurns}
                        onChange={e => setWeatherTurns(e.target.value)}
                        className="w-20 rounded-md border px-3 py-2 text-sm bg-background"
                      />
                      <Button
                        onClick={handleSetWeather}
                        disabled={submitting}
                        variant="secondary"
                        className="min-h-11"
                      >
                        Set
                      </Button>
                    </div>
                    {weatherActionError && <p className="text-sm text-destructive">{weatherActionError}</p>}
                  </div>
                </>
              ) : (
                <p className="text-sm text-center text-muted-foreground py-2">
                  Round complete — waiting for the DM to advance…
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Battle Log — visible to everyone once events exist */}
        {battle.status === 'active' && battle.turnLog.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Battle Log</CardTitle></CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 max-h-64 overflow-y-auto pr-1">
                {[...battle.turnLog].reverse().map((entry, idx) => (
                  <div key={entry.turn}>
                    <p className={`text-xs font-semibold mb-1 ${idx === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                      Turn {entry.turn}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {entry.events.map((event, i) => (
                        <li
                          key={i}
                          className={`text-sm ${idx === 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                        >
                          {event}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
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
                    <li key={entry.userId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{entry.username}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {entry.activePokemonInfo ? (
                          <>
                            <span className="text-xs">
                              {entry.activePokemonInfo.name}
                              {' · '}HP {entry.activePokemonInfo.currentHp}
                              {entry.activePokemonInfo.maxHp != null ? `/${entry.activePokemonInfo.maxHp}` : ''}
                            </span>
                            <StatusBadge info={entry.activePokemonInfo} />
                          </>
                        ) : (
                          <span className="text-xs">No Pokémon out</span>
                        )}
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
            {battle.enemySide.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No enemies yet — enemies are added via the encounter builder (coming soon).
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {battle.enemySide.map(entry => (
                  <li key={entry.npcId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      {entry.activePokemonInfo?.name ?? entry.npcName}
                    </span>
                    <span className="flex items-center gap-2">
                      {entry.activePokemonInfo ? (
                        <>
                          <span className="text-muted-foreground text-xs">
                            HP {entry.activePokemonInfo.currentHp}
                            {entry.activePokemonInfo.maxHp != null ? `/${entry.activePokemonInfo.maxHp}` : ''}
                          </span>
                          <StatusBadge info={entry.activePokemonInfo} />
                        </>
                      ) : (
                        <span className="text-muted-foreground text-xs">No Pokémon out</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
