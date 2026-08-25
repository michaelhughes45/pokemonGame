import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { TYPE_BG } from '../lib/typeColors';
import { apiError } from '../lib/apiError';
import { formatName as formatMove } from '../lib/formatName';
import { HpBar } from '../components/HpBar';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnQueueEntry = {
  actorId: string;
  actorType: 'player' | 'npc';
  activePokemonId: string;
  actionType: 'move' | 'item' | 'switch' | 'catch' | 'run';
  moveId: string;
  targets: string[];
  resolved: boolean;
};

type BagItem = {
  _id: string;
  itemId: string;
  quantity: number;
  pocket: string;
};

// EV-reducing berries live in the 'berry' pocket alongside battle-usable ones
// (Oran, Sitrus, Cheri, etc.) but have no in-battle effect — exclude them
// from battle item lists so they aren't offered where they'd silently no-op.
const EV_BERRIES = new Set([
  'pomeg-berry', 'kelpsy-berry', 'qualot-berry', 'hondew-berry', 'grepa-berry', 'tamato-berry',
]);

// Milestone 6.5 — battle-local AI tier override options. 'smartest' behaves
// identically to 'highest-damage' until 6.7 gives it real tactics.
const AI_STRATEGY_OPTIONS = ['worst', 'random', 'highest-damage', 'smartest'] as const;
const AI_STRATEGY_LABELS: Record<string, string> = {
  worst: 'Worst', random: 'Random', 'highest-damage': 'Highest Damage', smartest: 'Smartest',
};

type StatStages = {
  atk: number; def: number; spa: number; spd: number;
  spe: number; acc: number; eva: number;
};

// Joined by the state endpoint — name and HP for whatever Pokémon is currently active
type ActivePokemonInfo = {
  _id: string;
  name: string;
  speciesName: string;
  speciesId: number;
  level: number;
  types: string[];
  currentHp: number;
  maxHp: number | null;
  statusCondition: string | null;
  isConfused: boolean;
  moves?: MoveSlot[];
  statStages: StatStages | null;
};

type PlayerSideEntry = {
  userId: string;
  username: string;
  activePokemonId: string | null;
  usedPokemonIds: string[];
  fainted: string[];
  activePokemonInfo: ActivePokemonInfo | null;
  usedPokemonCount: number;
  pokemonLimitReached: boolean;
};

type EnemySideEntry = {
  npcId?: string;  // absent for wild and pvp battles
  npcName: string;
  // Only present for pvp — the opposing trainer's own fields, mirroring PlayerSideEntry.
  userId?: string;
  username?: string;
  usedPokemonIds?: string[];
  // Unlike the fields above, these two are always sent (0/false for npc/wild entries).
  usedPokemonCount: number;
  pokemonLimitReached: boolean;
  activePokemonId: string | null;
  fainted: string[];
  activePokemonInfo: ActivePokemonInfo | null;
  // Battle-local AI tier override (milestone 6.5) — undefined for pvp entries
  // (real trainers, never AI-controlled).
  aiStrategy?: 'worst' | 'random' | 'highest-damage' | 'smartest';
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
  currentMoveTargetCategory: 'single' | 'auto' | null;
  currentMoveAllyTarget: 'ally-only' | 'ally-or-foe' | null;
  currentMoveAllyIds: string[];
  // Milestone 6.6 — fresh-computed suggestion for the current NPC/wild actor's
  // single-target foe move; null for player turns, no-target/auto/ally moves, or
  // when there's simply nothing left to target.
  currentMoveSuggestedTargetId: string | null;
  playerPokemonLimit: number | null;
  wildCatchable: boolean;
  turnLog: TurnLogEntry[];
  lastUpdatedAt: string;
  winningSide: 'playerSide' | 'enemySide' | null;
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
  active:   'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  complete: 'bg-secondary text-secondary-foreground',
};

const PHASE_LABELS: Record<string, string> = {
  move_submission: 'Move Submission',
  targeting:       'Targeting',
  end_of_round:    'End of Round',
};

const CONDITION_BADGES: Record<string, { label: string; cls: string }> = {
  burn:      { label: 'BRN', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' },
  paralysis: { label: 'PAR', cls: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' },
  sleep:     { label: 'SLP', cls: 'bg-blue-100   text-blue-800 dark:bg-blue-900 dark:text-blue-200'   },
  freeze:    { label: 'FRZ', cls: 'bg-cyan-100   text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200'   },
  poison:    { label: 'PSN', cls: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' },
  toxic:     { label: 'TOX', cls: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900 dark:text-fuchsia-200' },
  confusion: { label: 'CNF', cls: 'bg-pink-100   text-pink-800 dark:bg-pink-900 dark:text-pink-200'   },
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

const STAGE_STAT_LABELS: [keyof StatStages, string][] = [
  ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'],
  ['spe', 'Spe'], ['acc', 'Acc'], ['eva', 'Eva'],
];

function StatStageBadges({ stages }: { stages: StatStages | null }) {
  if (!stages) return null;
  const active = STAGE_STAT_LABELS.filter(([key]) => stages[key] !== 0);
  if (active.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {active.map(([key, label]) => {
        const val = stages[key];
        const positive = val > 0;
        const cls = positive
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
          : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
        return (
          <span key={key} className={`text-xs font-bold px-1.5 py-0.5 rounded ${cls}`}>
            {label}{positive ? `+${val}` : val}
          </span>
        );
      })}
    </span>
  );
}

const WEATHER_CONFIG: Record<string, { label: string; cls: string }> = {
  rain:      { label: 'Rain',      cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'    },
  sun:       { label: 'Harsh Sun', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'  },
  sandstorm: { label: 'Sandstorm', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' },
  hail:      { label: 'Hail',      cls: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200'    },
  snow:      { label: 'Snow',      cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'  },
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

function BattlePokemonCard({ info, extra }: { info: ActivePokemonInfo; extra?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3 flex gap-3 items-center">
        <img
          src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${info.speciesId}.png`}
          alt={info.speciesName}
          width={56}
          height={56}
          className="pixelated shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-sm">{info.name}</span>
            {info.name !== info.speciesName && (
              <span className="text-xs text-muted-foreground">({info.speciesName})</span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">Lv. {info.level}</span>
          </div>
          <div className="flex gap-1 flex-wrap mt-1 items-center">
            {info.types.map(t => (
              <span key={t} className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ${TYPE_BG[t] ?? 'bg-gray-400'}`}>
                {formatMove(t)}
              </span>
            ))}
            <StatusBadge info={info} />
            <StatStageBadges stages={info.statStages} />
          </div>
          <HpBar current={info.currentHp} max={info.maxHp} />
          {extra}
        </div>
      </CardContent>
    </Card>
  );
}

// Shared "one row per trainer" roster list — used for the Player Side card
// and, in pvp, the Enemy Side card (a pvp enemySide is just another roster
// of real trainers, structurally identical to playerSide).
function TrainerRosterList({
  entries,
  battle,
}: {
  entries: { userId?: string; username?: string; activePokemonInfo: ActivePokemonInfo | null }[];
  battle: BattleState;
}) {
  return (
    <div className="flex flex-col gap-3">
      {entries.map(entry => {
        const submitted = battle.turnQueue.some(
          e => e.actorId === entry.userId && e.actorType === 'player'
        );
        return (
          <div key={entry.userId} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{entry.username}</span>
              {battle.status === 'active' && battle.phase === 'move_submission' && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  submitted
                    ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                    : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                }`}>
                  {submitted ? 'Submitted' : 'Pending'}
                </span>
              )}
            </div>
            {entry.activePokemonInfo
              ? <BattlePokemonCard info={entry.activePokemonInfo} />
              : <p className="text-xs text-muted-foreground">No Pokémon out</p>
            }
          </div>
        );
      })}
    </div>
  );
}

// Display name for a party Pokémon
function pokemonLabel(p: PartyPokemon): string {
  return p.nickname ?? p.speciesName ?? `#${p.speciesId}`;
}

// Shared list of clickable party-Pokémon rows, used by the send-out, Baton
// Pass, and Switch pickers — each disables fainted/active/limit-blocked
// entries the same way and just wires a different action into onSelect.
function PartyPicker({
  party,
  myEntry,
  submitting,
  showLevel = false,
  onSelect,
}: {
  party: PartyPokemon[];
  myEntry: { activePokemonId: string | null; usedPokemonIds: string[]; pokemonLimitReached: boolean } | undefined;
  submitting: boolean;
  showLevel?: boolean;
  onSelect: (pokemonId: string) => void;
}) {
  return (
    <>
      {party.map(p => {
        const isActive     = p._id === myEntry?.activePokemonId;
        const fainted      = p.currentHp <= 0;
        const alreadyUsed  = myEntry?.usedPokemonIds.includes(p._id) ?? false;
        const limitBlocked = !alreadyUsed && (myEntry?.pokemonLimitReached ?? false);
        const disabled     = isActive || fainted || limitBlocked || submitting;

        let subLabel: string;
        if (isActive)           subLabel = 'Active';
        else if (fainted)       subLabel = 'Fainted';
        else if (limitBlocked)  subLabel = 'Limit reached';
        else subLabel = `HP ${p.currentHp}${p.maxHp != null ? `/${p.maxHp}` : ''}`;

        return (
          <button
            key={p._id}
            onClick={() => !disabled && onSelect(p._id)}
            disabled={disabled}
            className={[
              'flex items-center justify-between rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
              disabled ? 'opacity-40 cursor-not-allowed bg-muted' : 'hover:bg-accent cursor-pointer',
            ].join(' ')}
          >
            <span className="font-medium">{pokemonLabel(p)}</span>
            <span className="text-muted-foreground text-xs">
              {showLevel ? <>Lv.{p.level}{' · '}{subLabel}</> : subLabel}
            </span>
          </button>
        );
      })}
    </>
  );
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
  const [npcActionTab,        setNpcActionTab]        = useState<Record<string, 'move' | 'switch' | 'item'>>({});
  const [npcBags,             setNpcBags]             = useState<Record<string, BagItem[]>>({});
  const [npcBagLoading,       setNpcBagLoading]       = useState<string | null>(null);
  const [npcSelectedItem,     setNpcSelectedItem]     = useState<Record<string, string | null>>({});
  // Milestone 6.5 — Move tab is now select-then-confirm like the Item tab already
  // was, so "Auto NPCs" suggestions and manual move picks alike sit here until a
  // bulk "Submit All" commits them. Keyed by the wild Pokémon's own activePokemonId
  // for wild slots, or `${npcId}:${slotIndex}` (matching npcActionTab's slotKey
  // convention) for NPC slots. 6.7.3/6.7.4 — a suggestion can now be an item or
  // switch action (trainer NPCs only, 'smartest' only), not just a move, hence
  // the discriminated value type; manual clicks in the Move tab always store the
  // 'move' variant.
  type NpcSelectedAction =
    | { type: 'move'; moveId: string }
    | { type: 'item'; itemId: string; targetPokemonId: string }
    | { type: 'switch'; switchToPokemonId: string };
  const [npcSelectedMove,     setNpcSelectedMove]     = useState<Record<string, NpcSelectedAction>>({});
  const [weatherInput,        setWeatherInput]        = useState('');
  const [weatherTurns,        setWeatherTurns]        = useState('');
  const [weatherActionError,  setWeatherActionError]  = useState('');
  const [bagItems,            setBagItems]            = useState<BagItem[]>([]);
  const [actionTab,           setActionTab]           = useState<'move' | 'item' | 'switch' | 'ball'>('move');
  const [selectedItemId,      setSelectedItemId]      = useState<string | null>(null);
  // Baton Pass is the only move that needs a follow-up choice (who to send in) —
  // set once the player clicks it, cleared on submit/cancel, same shape as the item flow.
  const [pendingBatonPass,    setPendingBatonPass]     = useState(false);
  const [runConfirmPending,   setRunConfirmPending]   = useState(false);
  // Which wild Pokémon the player has chosen to throw a ball at.
  // null = nothing selected yet (only relevant in multi-wild battles).
  const [catchTarget,         setCatchTarget]         = useState<string | null>(null);
  // Battle Log mode: 'live' is the existing newest-first view; 'replay' steps
  // through turnLog chronologically from turn 1. replayIndex is 0-based into
  // battle.turnLog (already stored in ascending turn order) — turns up to and
  // including this index are revealed.
  const [logMode,             setLogMode]             = useState<'live' | 'replay'>('live');
  const [replayIndex,         setReplayIndex]         = useState(0);
  const [replayPlaying,       setReplayPlaying]       = useState(false);

  // Replay autoplay — advances one turn every 2s while playing; auto-pauses
  // on reaching the last turn. Re-created whenever the log grows so a battle
  // that's still live can keep autoplaying into newly-arrived turns.
  useEffect(() => {
    if (logMode !== 'replay' || !replayPlaying || !battle) return;
    const maxIndex = battle.turnLog.length - 1;
    const timer = setInterval(() => {
      setReplayIndex(i => {
        if (i >= maxIndex) {
          setReplayPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [logMode, replayPlaying, battle?.turnLog.length]);

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

  // Fetch party for players (not DM) so they can pick which Pokémon to send out.
  // Re-runs each new round so HP stays fresh (fainted Pokémon are greyed out correctly).
  useEffect(() => {
    if (!token || user?.role === 'dm' || user?.role === 'admin') return;
    axios.get(`${API}/api/pokemon/party`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => setParty(res.data.data ?? []))
      .catch(() => {});
  }, [token, user?.role, battle?.turnNumber]);

  // Fetch healing + status_cure + berry items for players; re-runs each new round so quantities stay fresh
  useEffect(() => {
    if (!token || user?.role === 'dm' || user?.role === 'admin') return;
    axios.get(`${API}/api/items`, { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        const all: BagItem[] = res.data.data ?? [];
        setBagItems(all.filter(i =>
          i.pocket === 'healing' || i.pocket === 'status_cure' || i.pocket === 'pokeballs' || i.pocket === 'battle_boost'
          || (i.pocket === 'berry' && !EV_BERRIES.has(i.itemId))
        ));
      })
      .catch(() => {});
  }, [token, user?.role, battle?.turnNumber]);

  // Reset action tab and item selection at the start of each new round
  useEffect(() => {
    setActionTab('move');
    setSelectedItemId(null);
    setRunConfirmPending(false);
    setNpcSelectedMove({});
  }, [battle?.turnNumber]);

  // Fetch active Pokémon detail (moves, type data) when activePokemonId becomes known.
  // In pvp, "you" might be on playerSide or (as the opposing trainer) on enemySide —
  // check both, and remember which one so display logic below can tell the sides apart.
  const myPlayerEntry = battle?.playerSide.find(e => e.userId === user?.id);
  const myEnemyEntry  = battle?.enemySide.find(e => e.userId === user?.id);
  const mySide: 'playerSide' | 'enemySide' | null =
    myPlayerEntry ? 'playerSide' : myEnemyEntry ? 'enemySide' : null;
  const myEntry = myPlayerEntry
    ? myPlayerEntry
    : myEnemyEntry
      ? { ...myEnemyEntry, usedPokemonIds: myEnemyEntry.usedPokemonIds ?? [] }
      : undefined;
  const activePokemonId = myEntry?.activePokemonId ?? null;

  // Wild encounters: list of enemy slots that still have an active wild Pokémon.
  // Used for multi-wild target picking in the Ball tab.
  const catchableWild = battle?.type === 'wild'
    ? battle.enemySide.filter(e => !e.npcId && e.activePokemonId != null)
    : [];
  const isMultiWild = catchableWild.length > 1;

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

  // Reset target selection whenever it becomes a new actor's turn — milestone 6.6:
  // pre-select the fresh-computed NPC/wild suggestion (if any) instead of leaving
  // it empty, so the DM can one-click "Confirm Target" or click a different
  // Pokémon to override. Deliberately NOT in the dependency array below — this
  // should only re-run when the actor turn actually changes, not on every 3s poll
  // (which would wipe out a DM's manual override mid-turn).
  const currentTargetIndex = battle?.currentTargetIndex;
  useEffect(() => {
    setSelectedTargets(battle?.currentMoveSuggestedTargetId ? [battle.currentMoveSuggestedTargetId] : []);
    setActionError('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTargetIndex]);

  // Fetch (and refresh each round) all NPC parties in this battle so HP and PP stay current.
  // Runs on turn number change so fainted Pokémon are grayed out and PP is accurate.
  const userRole = user?.role;
  useEffect(() => {
    if ((userRole !== 'dm' && userRole !== 'admin') || !battle || battle.status !== 'active') return;
    const seen = new Set<string>();
    battle.enemySide.forEach(entry => {
      if (!entry.npcId || seen.has(entry.npcId)) return;
      seen.add(entry.npcId);
      axios.get(`${API}/api/dm/npcs/${entry.npcId}/party`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(res => setNpcParties(prev => ({ ...prev, [entry.npcId!]: res.data.data ?? [] })))
        .catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle?.turnNumber, battle?.status, userRole, token]);

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

  // "<player/trainer> <pokemon>" label for the actor currently picking targets, used
  // both in the Targeting card and as a synthetic "waiting for…" battle log line.
  // actorType 'player' can mean either side in pvp (the opposing trainer's entries
  // live on enemySide but are still actorType 'player'), so check both rather than
  // assuming playerSide. For NPC trainers with more than one active Pokémon, and for
  // battles with more than one simultaneous wild Pokémon, the name is suffixed with
  // a 1-based number matching the existing "Slot N" grouping shown elsewhere.
  const targetActorLabel = (() => {
    if (!currentTargetEntry || !battle) return '';

    if (currentTargetEntry.actorType === 'player') {
      const entry = battle.playerSide.find(e => e.userId === currentTargetEntry.actorId)
        ?? battle.enemySide.find(e => e.userId === currentTargetEntry.actorId);
      const trainerName = entry?.username ?? 'Unknown';
      const pokeName = entry?.activePokemonInfo?.name ?? 'Pokémon';
      return `${trainerName} ${pokeName}`;
    }

    // NPC actor — actorId is the shared trainer npcId for real NPC trainers, but the
    // Pokémon's own activePokemonId for wild Pokémon (each wild mon acts independently).
    const npcEntry = battle.enemySide.find(e => e.npcId === currentTargetEntry.actorId);
    if (npcEntry) {
      const slots = battle.enemySide.filter(e => e.npcId === npcEntry.npcId);
      const slotIdx = slots.findIndex(e => e.activePokemonId === currentTargetEntry.activePokemonId);
      const pokeName = (slotIdx !== -1 ? slots[slotIdx] : npcEntry).activePokemonInfo?.name ?? 'Pokémon';
      const suffix = slots.length > 1 && slotIdx !== -1 ? String(slotIdx + 1) : '';
      return `${npcEntry.npcName} ${pokeName}${suffix}`;
    }

    const wildSlots = battle.enemySide.filter(e => !e.npcId);
    const wildIdx = wildSlots.findIndex(e => e.activePokemonId === currentTargetEntry.activePokemonId);
    const pokeName = (wildIdx !== -1 ? wildSlots[wildIdx] : undefined)?.activePokemonInfo?.name ?? 'Pokémon';
    const suffix = wildSlots.length > 1 && wildIdx !== -1 ? String(wildIdx + 1) : '';
    return `DM ${pokeName}${suffix}`;
  })();

  const isNoTargetMove = currentTargetEntry
    ? (battle?.noTargetMoveIds ?? []).includes(currentTargetEntry.moveId)
    : false;

  // Ephemeral "waiting for…" line shown at the end of the current turn's Battle Log
  // entries during targeting. Computed client-side rather than persisted via
  // appendToLog — it reflects live polling state, not a permanent turn event, so it
  // should disappear once the actor submits and must never appear in Replay mode.
  const battleLogWaitingLine = battle?.phase === 'targeting' && currentTargetEntry
    ? `Waiting for ${targetActorLabel} move…`
    : null;

  const isAutoTargetMove = !isNoTargetMove && battle?.currentMoveTargetCategory === 'auto';
  const isSingleTargetMove = !isNoTargetMove && !isAutoTargetMove;

  // Valid targets the current actor can choose from (opposing side, active and alive).
  // Which side is "opposing" depends on which side the actor is ON, not actorType —
  // in pvp the opposing trainer's entries live on enemySide but are still actorType 'player'.
  const opposingTargets: ActivePokemonInfo[] = (() => {
    if (!currentTargetEntry || !battle) return [];
    const actingSide: 'playerSide' | 'enemySide' = currentTargetEntry.actorType === 'npc'
      ? 'enemySide'
      : battle.playerSide.some(e => e.userId === currentTargetEntry.actorId) ? 'playerSide' : 'enemySide';
    const side = actingSide === 'playerSide' ? battle.enemySide : battle.playerSide;
    return side
      .filter(e => e.activePokemonId && e.activePokemonInfo && e.activePokemonInfo.currentHp > 0)
      .map(e => e.activePokemonInfo!);
  })();

  // Teammate's active Pokémon — only meaningful in battles with more than one
  // active Pokémon per side. Helping Hand/Aromatic Mist are ally-only; Heal Pulse
  // can hit either, so its picker shows both lists together with an "Ally" tag.
  const allyTargetIds = new Set(battle?.currentMoveAllyIds ?? []);
  const allyTargets: ActivePokemonInfo[] = (() => {
    if (!battle || allyTargetIds.size === 0) return [];
    const allEntries = [...battle.playerSide, ...battle.enemySide];
    return [...allyTargetIds]
      .map(id => allEntries.find(e => e.activePokemonId === id)?.activePokemonInfo)
      .filter((info): info is ActivePokemonInfo => !!info && info.currentHp > 0);
  })();
  const pickerTargets: ActivePokemonInfo[] = battle?.currentMoveAllyTarget === 'ally-only'
    ? allyTargets
    : battle?.currentMoveAllyTarget === 'ally-or-foe'
      ? [...allyTargets, ...opposingTargets]
      : opposingTargets;

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

  async function handleSubmitItem(itemId: string, targetPokemonId: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(
        `${API}/api/battles/${id}/submit-move`,
        { actionType: 'item', itemId, targetPokemonId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setSelectedItemId(null);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to use item.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitSwitch(switchToPokemonId: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(
        `${API}/api/battles/${id}/submit-move`,
        { actionType: 'switch', switchToPokemonId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit switch.'));
    } finally {
      setSubmitting(false);
    }
  }

  // Baton Pass — moveId and switchToPokemonId are submitted together in one
  // request; the backend never puts this move through the interactive targeting
  // phase (see submitMove), so there's no separate target-submission step.
  async function handleSubmitBatonPass(switchToPokemonId: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(
        `${API}/api/battles/${id}/submit-move`,
        { moveId: 'baton-pass', switchToPokemonId },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setPendingBatonPass(false);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit Baton Pass.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitCatch(itemId: string, targetPokemonId?: string) {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(
        `${API}/api/battles/${id}/submit-move`,
        { actionType: 'catch', itemId, ...(targetPokemonId ? { targetPokemonId } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setCatchTarget(null);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to throw Poké Ball.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitRun() {
    if (!id) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(
        `${API}/api/battles/${id}/submit-move`,
        { actionType: 'run' },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setRunConfirmPending(false);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to run.'));
    } finally {
      setSubmitting(false);
    }
  }

  // slotKey = "${npcId}:${slotIndex}" — used to track which slot's send-out picker is open
  async function fetchNpcParty(npcId: string, slotKey: string) {
    if (npcParties[npcId]) { setExpandedSendOut(slotKey); return; }
    setPartyLoading(npcId);
    try {
      const res = await axios.get(`${API}/api/dm/npcs/${npcId}/party`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setNpcParties(prev => ({ ...prev, [npcId]: res.data.data ?? [] }));
      setExpandedSendOut(slotKey);
    } catch { /* silently fail — list stays empty */ }
    finally { setPartyLoading(null); }
  }

  // slotIndex lets the backend target a specific slot when an NPC has multiple entries
  async function handleDmSendOut(npcId: string, pokemonId: string, slotIndex?: number) {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/dm-send-out`,
        { npcId, pokemonId, ...(slotIndex !== undefined ? { slotIndex } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setExpandedSendOut(null);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to send out Pokémon.'));
    } finally { setSubmitting(false); }
  }


  async function handleDmSubmitSwitch(npcId: string, switchToPokemonId: string, slotPokemonId?: string) {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/dm-submit-move`,
        { npcId, actionType: 'switch', switchToPokemonId, ...(slotPokemonId ? { activePokemonId: slotPokemonId } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to submit switch.'));
    } finally { setSubmitting(false); }
  }

  async function fetchNpcBag(npcId: string) {
    if (npcBags[npcId]) return;
    setNpcBagLoading(npcId);
    try {
      const res = await axios.get(`${API}/api/dm/npcs/${npcId}/bag`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setNpcBags(prev => ({ ...prev, [npcId]: res.data.data ?? [] }));
    } catch { /* silently fail — list stays empty */ }
    finally { setNpcBagLoading(null); }
  }

  async function handleDmSubmitItem(npcId: string, itemId: string, targetPokemonId: string, slotKey: string, slotPokemonId?: string) {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/dm-submit-move`,
        { npcId, actionType: 'item', itemId, targetPokemonId, ...(slotPokemonId ? { activePokemonId: slotPokemonId } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setNpcSelectedItem(prev => ({ ...prev, [slotKey]: null }));
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to use item.'));
    } finally { setSubmitting(false); }
  }

  // Battle-local AI tier override (milestone 6.5) — npcId is the wild Pokémon's own
  // activePokemonId for wild slots (same overloaded convention dm-submit-move already
  // uses). Updates local state optimistically so the dropdown reflects the choice
  // immediately instead of waiting for the next 3s poll; a failed request just gets
  // corrected by that same next poll rather than an explicit revert.
  async function handleChangeNpcAiStrategy(npcId: string, aiStrategy: string, slotIndex?: number) {
    if (!id) return;
    setBattle(prev => {
      if (!prev) return prev;
      let idx = -1;
      return {
        ...prev,
        enemySide: prev.enemySide.map(e => {
          const matches = prev.type === 'wild' ? e.activePokemonId === npcId : e.npcId === npcId;
          if (!matches) return e;
          idx++;
          const isTarget = slotIndex === undefined || idx === slotIndex;
          return isTarget ? { ...e, aiStrategy: aiStrategy as EnemySideEntry['aiStrategy'] } : e;
        }),
      };
    });
    try {
      await axios.patch(`${API}/api/battles/${id}/npc-ai-strategy`,
        { npcId, aiStrategy, ...(slotIndex !== undefined ? { slotIndex } : {}) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to change AI strategy.'));
    }
  }

  // Milestone 6.5 — "Auto NPCs" is now suggest-and-review, not instant-submit:
  // fetches a suggested move per unsubmitted NPC/wild slot and pre-fills each into
  // npcSelectedMove (the same select-then-confirm state the Move tab's buttons now
  // use, mirroring how the Item tab already worked), replacing any prior selection.
  // The DM can still click a different move on any slot to override before
  // committing everything at once via handleSubmitAllNpcMoves. 6.7.3/6.7.4 — a
  // suggestion can now be an item or switch action (trainer NPCs only, 'smartest'
  // only for either); actionType discriminates the three shapes coming back from
  // the endpoint. A switch suggestion also lazily loads that NPC's party (if not
  // already cached) so the Move-tab banner can show the replacement's real name
  // instead of just an id — fetchNpcParty's setExpandedSendOut side effect is a
  // harmless no-op here since this slot already has an active Pokémon.
  async function handleAutoNpcSuggest() {
    if (!id) return;
    setSubmitting(true); setActionError('');
    try {
      const res = await axios.post(`${API}/api/battles/${id}/dm-auto-submit`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const suggestions: ({ npcId: string; slotIndex: number } & (
        | { actionType: 'move'; moveId: string }
        | { actionType: 'item'; itemId: string; targetPokemonId: string }
        | { actionType: 'switch'; switchToPokemonId: string }
      ))[] = res.data.data?.suggestions ?? [];
      setNpcSelectedMove(prev => {
        const next = { ...prev };
        for (const s of suggestions) {
          const isWild = battle?.enemySide.some(e => !e.npcId && e.activePokemonId === s.npcId) ?? false;
          const key = isWild ? s.npcId : `${s.npcId}:${s.slotIndex}`;
          if (s.actionType === 'item') {
            next[key] = { type: 'item', itemId: s.itemId, targetPokemonId: s.targetPokemonId };
          } else if (s.actionType === 'switch') {
            next[key] = { type: 'switch', switchToPokemonId: s.switchToPokemonId };
            if (!isWild) fetchNpcParty(s.npcId, key);
          } else {
            next[key] = { type: 'move', moveId: s.moveId };
          }
        }
        return next;
      });
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to suggest NPC moves.'));
    } finally { setSubmitting(false); }
  }

  // Commits every currently-selected Move-tab pick (auto-suggested or manually-
  // picked alike) — sequential awaits since these all mutate the same battle
  // document. Each slot's selection is cleared as soon as ITS OWN submission
  // succeeds (not all at once at the end) so one slot failing — e.g. a stale
  // selection for a Pokémon that fainted to a faster attacker earlier this same
  // batch — doesn't block or desync the rest of the batch. 6.7.3/6.7.4 — a
  // selection can be an item or switch action (auto-suggested only, never
  // manually picked from this tab), so the payload branches on action.type; the
  // item variant is always self-targeted (targetPokemonId is this same slot's
  // own active Pokémon). Wild slots never get an item or switch suggestion (no
  // bag or bench), so action there is always the 'move' variant in practice.
  function buildNpcActionBody(npcId: string, action: NpcSelectedAction, activePokemonId?: string) {
    if (action.type === 'item') {
      return { npcId, actionType: 'item', itemId: action.itemId, targetPokemonId: action.targetPokemonId, ...(activePokemonId ? { activePokemonId } : {}) };
    }
    if (action.type === 'switch') {
      return { npcId, actionType: 'switch', switchToPokemonId: action.switchToPokemonId, ...(activePokemonId ? { activePokemonId } : {}) };
    }
    return { npcId, moveId: action.moveId, ...(activePokemonId ? { activePokemonId } : {}) };
  }

  async function handleSubmitAllNpcMoves() {
    if (!id || !battle) return;
    const entries = Object.entries(npcSelectedMove).filter(([, action]) => action);
    if (entries.length === 0) return;
    setSubmitting(true); setActionError('');
    let lastError = '';
    for (const [key, action] of entries) {
      try {
        if (key.includes(':')) {
          const [npcId, slotIdxStr] = key.split(':');
          const slot = battle.enemySide.filter(e => e.npcId === npcId)[Number(slotIdxStr)];
          if (slot?.activePokemonId) {
            await axios.post(`${API}/api/battles/${id}/dm-submit-move`, buildNpcActionBody(npcId, action, slot.activePokemonId), { headers: { Authorization: `Bearer ${token}` } });
          }
        } else {
          // Wild — key is the wild Pokémon's own activePokemonId (no slot index needed).
          await axios.post(`${API}/api/battles/${id}/dm-submit-move`, buildNpcActionBody(key, action), { headers: { Authorization: `Bearer ${token}` } });
        }
        setNpcSelectedMove(prev => { const next = { ...prev }; delete next[key]; return next; });
      } catch (err: unknown) {
        lastError = apiError(err, 'Failed to submit one or more NPC moves.');
      }
    }
    if (lastError) setActionError(lastError);
    setSubmitting(false);
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

  async function handleAutoTargetMove(targetIds: string[]) {
    if (!id || targetIds.length === 0 || submitting) return;
    setSubmitting(true);
    setActionError('');
    try {
      await axios.post(`${API}/api/battles/${id}/submit-target`, { targets: targetIds }, {
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
        <Link to={isDm ? '/dm' : '/dashboard'} className="inline-flex items-center min-h-11 text-sm underline text-muted-foreground">
          ← {isDm ? 'DM Panel' : 'Dashboard'}
        </Link>
      </div>
    );
  }

  const statusColour = STATUS_COLOURS[battle.status] ?? 'bg-muted text-muted-foreground';

  // In pvp, "Player Side"/"Enemy Side" are meaningless labels — both are real trainers.
  // Label them relative to the viewer when they're a participant, or neutrally (Team A/B)
  // when the viewer is the DM observing.
  const playerSideTitle = battle.type !== 'pvp'
    ? 'Player Side'
    : mySide === 'playerSide' ? 'Your Team' : mySide === 'enemySide' ? 'Opponent Team' : 'Team A';
  const enemySideTitle = battle.type !== 'pvp'
    ? 'Enemy Side'
    : mySide === 'enemySide' ? 'Your Team' : mySide === 'playerSide' ? 'Opponent Team' : 'Team B';

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
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
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

        {/* Battle complete banner */}
        {battle.status === 'complete' && (
          <Card>
            <CardHeader>
              <CardTitle>Battle Complete</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {/* The turn log itself stays neutral (both pvp viewers read the same lines) —
                    winningSide + mySide let us show each participant a personal result here. */}
                {battle.type === 'pvp' && mySide && battle.winningSide
                  ? (battle.winningSide === mySide ? 'You won this battle!' : 'You lost this battle.')
                  : 'This battle has ended. See the battle log below for the full summary.'}
              </p>
            </CardContent>
          </Card>
        )}

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
                <PartyPicker party={party} myEntry={myEntry} submitting={submitting} showLevel onSelect={handleSendOut} />
              )}
            </CardContent>
          </Card>
        )}

        {/* Player: action submission (move or item) */}
        {!isDm && battle.status === 'active' && battle.phase === 'move_submission' && myEntry?.activePokemonId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {alreadySubmitted ? 'Action Submitted' : 'Choose an Action'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {activePokemonDetail && (
                <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
                  <span>
                    {activePokemonDetail.nickname ?? activePokemonDetail.species.name}
                    {' '}Lv.{activePokemonDetail.level}
                    {' · '}HP {activePokemonDetail.currentHp}/{activePokemonDetail.maxHp}
                  </span>
                  {myEntry?.activePokemonInfo && <StatusBadge info={myEntry.activePokemonInfo} />}
                  {myEntry?.activePokemonInfo && <StatStageBadges stages={myEntry.activePokemonInfo.statStages} />}
                </div>
              )}

              {alreadySubmitted ? (
                <p className="text-sm text-center text-muted-foreground py-2">
                  Action submitted — waiting for other trainers…
                </p>
              ) : (
                <>
                  {actionError && <p className="text-sm text-destructive">{actionError}</p>}
                  <Tabs value={actionTab} onValueChange={v => { setActionTab(v as 'move' | 'item' | 'switch' | 'ball'); setSelectedItemId(null); setPendingBatonPass(false); }}>
                    <TabsList>
                      <TabsTrigger value="move">Move</TabsTrigger>
                      <TabsTrigger value="item">Item</TabsTrigger>
                      <TabsTrigger value="switch">Switch</TabsTrigger>
                      {battle.type === 'wild' && battle.wildCatchable && (
                        <TabsTrigger value="ball">Ball</TabsTrigger>
                      )}
                    </TabsList>

                    <TabsContent value="move">
                      {pendingBatonPass ? (
                        <div className="flex flex-col gap-2 mt-2">
                          <div className="flex items-center gap-2 mb-1">
                            <button
                              onClick={() => setPendingBatonPass(false)}
                              className="text-xs text-muted-foreground hover:text-foreground min-h-11 min-w-11 pr-2"
                            >
                              ← Back
                            </button>
                            <span className="text-sm font-medium">Baton Pass to:</span>
                          </div>
                          {party.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No other Pokémon in your party.</p>
                          ) : (
                            <PartyPicker party={party} myEntry={myEntry} submitting={submitting} onSelect={handleSubmitBatonPass} />
                          )}
                        </div>
                      ) : activePokemonDetail ? (
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          {activePokemonDetail.moves.map(slot => {
                            const detail = moveDetailMap.get(slot.moveId);
                            const noPP   = slot.currentPP <= 0;
                            const isBatonPass = slot.moveId === 'baton-pass';
                            return (
                              <button
                                key={slot.moveId}
                                onClick={() =>
                                  !noPP && !submitting &&
                                  (isBatonPass ? setPendingBatonPass(true) : handleSubmitMove(slot.moveId))
                                }
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
                        <p className="text-sm text-muted-foreground mt-2">Loading moves…</p>
                      )}
                    </TabsContent>

                    <TabsContent value="item">
                      {selectedItemId == null ? (
                        bagItems.length === 0 ? (
                          <p className="text-sm text-muted-foreground mt-2">No usable items in bag.</p>
                        ) : (
                          <div className="flex flex-col gap-2 mt-2">
                            {bagItems.map(item => (
                              <button
                                key={item.itemId}
                                onClick={() => setSelectedItemId(item.itemId)}
                                className="flex justify-between items-center rounded-md border px-4 py-3 text-sm text-left hover:bg-accent cursor-pointer min-h-11"
                              >
                                <span className="font-medium">{formatMove(item.itemId)}</span>
                                <span className="text-muted-foreground text-xs">×{item.quantity}</span>
                              </button>
                            ))}
                          </div>
                        )
                      ) : (
                        <div className="flex flex-col gap-2 mt-2">
                          <div className="flex items-center gap-2 mb-1">
                            <button
                              onClick={() => setSelectedItemId(null)}
                              className="text-xs text-muted-foreground hover:text-foreground min-h-11 min-w-11 pr-2"
                            >
                              ← Back
                            </button>
                            <span className="text-sm font-medium">Use {formatMove(selectedItemId)} on:</span>
                          </div>
                          {party.map(p => {
                            const fainted = p.currentHp <= 0;
                            return (
                              <button
                                key={p._id}
                                onClick={() => !submitting && handleSubmitItem(selectedItemId, p._id)}
                                disabled={submitting}
                                className={[
                                  'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left min-h-11',
                                  submitting ? 'opacity-40 cursor-not-allowed' : 'hover:bg-accent cursor-pointer',
                                ].join(' ')}
                              >
                                <span className="font-medium">{pokemonLabel(p)}</span>
                                <span className="text-muted-foreground text-xs">
                                  Lv.{p.level}
                                  {' · '}
                                  {fainted ? 'Fainted' : `HP ${p.currentHp}${p.maxHp != null ? `/${p.maxHp}` : ''}`}
                                  {p.statusCondition ? ` · ${p.statusCondition}` : ''}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="switch">
                      {battle.playerPokemonLimit !== null && myEntry && (
                        <p className="text-sm text-muted-foreground mt-2">
                          {myEntry.usedPokemonCount} / {battle.playerPokemonLimit} Pokémon used this battle
                        </p>
                      )}
                      {party.length === 0 ? (
                        <p className="text-sm text-muted-foreground mt-2">No Pokémon in your party.</p>
                      ) : (
                        <div className="flex flex-col gap-2 mt-2">
                          <PartyPicker party={party} myEntry={myEntry} submitting={submitting} onSelect={handleSubmitSwitch} />
                        </div>
                      )}
                    </TabsContent>

                    {battle.type === 'wild' && battle.wildCatchable && (
                      <TabsContent value="ball">
                        {/* Multi-wild target picker — only shown when >1 wild Pokémon is still active */}
                        {isMultiWild && (
                          <div className="mt-2 mb-3 flex flex-col gap-1">
                            <p className="text-xs text-muted-foreground font-medium mb-1">
                              Throw at which Pokémon?
                            </p>
                            {catchableWild.map(entry => (
                              <button
                                key={entry.activePokemonId}
                                onClick={() => setCatchTarget(
                                  catchTarget === entry.activePokemonId ? null : entry.activePokemonId!
                                )}
                                className={[
                                  'flex items-center justify-between rounded-md border px-3 py-2 text-sm text-left transition-colors min-h-11',
                                  catchTarget === entry.activePokemonId
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'hover:bg-accent cursor-pointer',
                                ].join(' ')}
                              >
                                <span className="font-medium">{entry.activePokemonInfo?.name ?? 'Wild Pokémon'}</span>
                                <span className="text-xs opacity-70">
                                  HP {entry.activePokemonInfo?.currentHp ?? '?'}
                                  {entry.activePokemonInfo?.maxHp != null ? `/${entry.activePokemonInfo.maxHp}` : ''}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {bagItems.filter(i => i.pocket === 'pokeballs').length === 0 ? (
                          <p className="text-sm text-muted-foreground mt-2">No Poké Balls in bag.</p>
                        ) : (
                          <div className="flex flex-col gap-2 mt-2">
                            {bagItems.filter(i => i.pocket === 'pokeballs').map(item => {
                              const needsTarget = isMultiWild && !catchTarget;
                              return (
                                <button
                                  key={item.itemId}
                                  onClick={() => !submitting && !needsTarget && handleSubmitCatch(
                                    item.itemId,
                                    catchTarget ?? undefined,
                                  )}
                                  disabled={submitting || needsTarget}
                                  title={needsTarget ? 'Select a target above first' : undefined}
                                  className={[
                                    'flex justify-between items-center rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                    needsTarget || submitting
                                      ? 'opacity-40 cursor-not-allowed'
                                      : 'hover:bg-accent cursor-pointer',
                                  ].join(' ')}
                                >
                                  <span className="font-medium">{formatMove(item.itemId)}</span>
                                  <span className="text-muted-foreground text-xs">×{item.quantity}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </TabsContent>
                    )}
                  </Tabs>

                  {battle.type === 'wild' && (
                    <div className="pt-2 border-t">
                      {runConfirmPending ? (
                        <div className="flex gap-2">
                          <Button
                            variant="destructive"
                            onClick={handleSubmitRun}
                            disabled={submitting}
                            className="flex-1 min-h-11"
                          >
                            {submitting ? 'Running…' : 'Confirm Run'}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setRunConfirmPending(false)}
                            disabled={submitting}
                            className="min-h-11"
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => setRunConfirmPending(true)}
                          className="w-full min-h-11"
                        >
                          Run
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* DM: NPC actions during move submission — not applicable to pvp, where enemySide is a player roster, not NPCs */}
        {isDm && battle.type !== 'pvp' && battle.status === 'active' && battle.phase === 'move_submission' && battle.enemySide.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">NPC Actions</CardTitle>
                <div className="flex items-center gap-2">
                  {(() => {
                    const npcSlotsWithPokemon = battle.enemySide.filter(e => e.activePokemonId);
                    const allSubmitted = npcSlotsWithPokemon.length > 0 && npcSlotsWithPokemon.every(e => {
                      const actorId = e.npcId ?? e.activePokemonId!;
                      return battle.turnQueue.some(
                        q => q.actorId === actorId && q.actorType === 'npc'
                          && q.activePokemonId === e.activePokemonId,
                      );
                    });
                    return (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleAutoNpcSuggest}
                        disabled={submitting || allSubmitted || npcSlotsWithPokemon.length === 0}
                        className="min-h-9 text-xs"
                      >
                        Suggest Moves
                      </Button>
                    );
                  })()}
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleSubmitAllNpcMoves}
                    disabled={submitting || Object.values(npcSelectedMove).every(v => !v)}
                    className="min-h-9 text-xs"
                  >
                    Submit All
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {(() => {
                // Group NPC entries by npcId; wild entries render 1:1 in natural order.
                const seenNpcIds = new Set<string>();
                return battle.enemySide.map(entry => {
                  const isWild = !entry.npcId;
                  if (!isWild && seenNpcIds.has(entry.npcId!)) return null; // skip duplicate NPC slots
                  if (!isWild) seenNpcIds.add(entry.npcId!);

                  // ── Wild Pokémon ──────────────────────────────────────────
                  if (isWild) {
                    const actorId  = entry.activePokemonId ?? '';
                    const wildMoveSubmitted = battle.turnQueue.some(
                      e => e.actorId === actorId && e.actorType === 'npc'
                    );
                    const wildMoves = entry.activePokemonInfo?.moves ?? [];
                    return (
                      <div key={actorId} className="flex flex-col gap-2 border rounded-md p-3">
                        <p className="text-sm font-medium">
                          Wild {entry.activePokemonInfo?.speciesName ?? entry.npcName}
                        </p>
                        {entry.activePokemonId && (
                          <div className="flex items-center gap-2">
                            <Label htmlFor={`ai-${actorId}`} className="text-xs text-muted-foreground shrink-0">AI</Label>
                            <select
                              id={`ai-${actorId}`}
                              value={entry.aiStrategy ?? 'random'}
                              onChange={e => handleChangeNpcAiStrategy(actorId, e.target.value)}
                              className="h-9 md:h-8 rounded-md border px-2 py-1 text-sm md:text-xs bg-background"
                            >
                              {AI_STRATEGY_OPTIONS.map(s => <option key={s} value={s}>{AI_STRATEGY_LABELS[s]}</option>)}
                            </select>
                          </div>
                        )}
                        {!entry.activePokemonId ? (
                          <p className="text-xs text-muted-foreground">Fainted</p>
                        ) : wildMoveSubmitted ? (
                          <p className="text-xs text-muted-foreground">
                            {entry.activePokemonInfo?.name ?? 'Pokémon'} — move submitted
                          </p>
                        ) : wildMoves.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No moves available.</p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {npcSelectedMove[actorId]?.type === 'item' && (
                              <div className="rounded-md border border-primary bg-accent px-4 py-3 text-sm">
                                <span className="font-medium">Suggested: use {formatMove(npcSelectedMove[actorId].itemId)}</span>
                                <span className="text-muted-foreground text-xs block mt-0.5">Submit All will use this item instead of a move. Click a move below to override.</span>
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                            {wildMoves.map((m: MoveSlot) => {
                              const noPP = m.currentPP <= 0;
                              const isSelected = npcSelectedMove[actorId]?.type === 'move' && npcSelectedMove[actorId].moveId === m.moveId;
                              return (
                                <button
                                  key={m.moveId}
                                  onClick={() => !noPP && setNpcSelectedMove(prev => ({ ...prev, [actorId]: { type: 'move', moveId: m.moveId } }))}
                                  disabled={noPP}
                                  className={[
                                    'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                    noPP ? 'opacity-40 cursor-not-allowed bg-muted' : isSelected ? 'bg-accent border-primary' : 'hover:bg-accent cursor-pointer',
                                  ].join(' ')}
                                >
                                  <span className="font-medium">{formatMove(m.moveId)}</span>
                                  <span className="text-muted-foreground text-xs mt-0.5">PP {m.currentPP}/{m.maxPP}</span>
                                </button>
                              );
                            })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // ── NPC group (one or more slots per player) ──────────────
                  const npcId    = entry.npcId!;
                  const npcSlots = battle.enemySide.filter(e => e.npcId === npcId);
                  const party    = npcParties[npcId] ?? [];

                  return (
                    <div key={npcId} className="flex flex-col gap-2 border rounded-md p-3">
                      <p className="text-sm font-medium">{entry.npcName}</p>

                      {npcSlots.map((slot, slotIdx) => {
                        const slotKey        = `${npcId}:${slotIdx}`;
                        // Captured once so TypeScript can narrow it by .type below —
                        // narrowing doesn't carry across repeated npcSelectedMove[slotKey]
                        // indexed-access expressions, only a plain local variable.
                        const selectedAction = npcSelectedMove[slotKey];
                        const slotLabel      = npcSlots.length > 1 ? `Slot ${slotIdx + 1}` : null;
                        const activePokemon  = slot.activePokemonId
                          ? party.find((p: NpcPartyPokemon) => p._id === slot.activePokemonId)
                          : null;
                        const slotSubmitted  = battle.turnQueue.some(
                          e => e.actorId === npcId && e.actorType === 'npc'
                            && e.activePokemonId === slot.activePokemonId
                        );

                        return (
                          <div
                            key={slotKey}
                            className={npcSlots.length > 1
                              ? 'border-t pt-2 flex flex-col gap-2'
                              : 'flex flex-col gap-2'
                            }
                          >
                            {slotLabel && (
                              <p className="text-xs text-muted-foreground font-medium">{slotLabel}</p>
                            )}

                            {slot.activePokemonId && (
                              <div className="flex items-center gap-2">
                                <Label htmlFor={`ai-${slotKey}`} className="text-xs text-muted-foreground shrink-0">AI</Label>
                                <select
                                  id={`ai-${slotKey}`}
                                  value={slot.aiStrategy ?? 'random'}
                                  onChange={e => handleChangeNpcAiStrategy(npcId, e.target.value, slotIdx)}
                                  className="h-9 md:h-8 rounded-md border px-2 py-1 text-sm md:text-xs bg-background"
                                >
                                  {AI_STRATEGY_OPTIONS.map(s => <option key={s} value={s}>{AI_STRATEGY_LABELS[s]}</option>)}
                                </select>
                              </div>
                            )}

                            {!slot.activePokemonId ? (
                              expandedSendOut === slotKey ? (
                                <div className="flex flex-col gap-2">
                                  {partyLoading === npcId ? (
                                    <p className="text-sm text-muted-foreground">Loading party…</p>
                                  ) : party.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">No Pokémon in this NPC's party.</p>
                                  ) : (
                                    party.map((p: NpcPartyPokemon) => {
                                      const fainted = p.currentHp <= 0;
                                      return (
                                        <button
                                          key={p._id}
                                          onClick={() => !fainted && !submitting && handleDmSendOut(npcId, p._id, slotIdx)}
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
                                  onClick={() => fetchNpcParty(npcId, slotKey)}
                                  disabled={partyLoading === npcId}
                                  className="w-full min-h-9"
                                >
                                  {partyLoading === npcId ? 'Loading…' : 'Send Out Pokémon'}
                                </Button>
                              )
                            ) : slotSubmitted ? (
                              <p className="text-xs text-muted-foreground">
                                {slot.activePokemonInfo?.name ?? 'Pokémon'} — move submitted
                              </p>
                            ) : activePokemon ? (
                              <Tabs
                                value={npcActionTab[slotKey] ?? 'move'}
                                onValueChange={v => {
                                  setNpcActionTab(prev => ({ ...prev, [slotKey]: v as 'move' | 'switch' | 'item' }));
                                  if (v === 'item') fetchNpcBag(npcId);
                                }}
                              >
                                <TabsList>
                                  <TabsTrigger value="move">Move</TabsTrigger>
                                  <TabsTrigger value="switch">Switch</TabsTrigger>
                                  <TabsTrigger value="item">Item</TabsTrigger>
                                </TabsList>

                                <TabsContent value="move">
                                  <p className="text-sm text-muted-foreground mb-2">
                                    {slot.activePokemonInfo?.name ?? activePokemon.nickname ?? activePokemon.speciesName} — choose a move:
                                  </p>
                                  {selectedAction?.type === 'item' && (
                                    <div className="rounded-md border border-primary bg-accent px-4 py-3 text-sm mb-2">
                                      <span className="font-medium">Suggested: use {formatMove(selectedAction.itemId)}</span>
                                      <span className="text-muted-foreground text-xs block mt-0.5">Submit All will use this item instead of a move. Click a move below to override.</span>
                                    </div>
                                  )}
                                  {selectedAction?.type === 'switch' && (() => {
                                    const switchTo = party.find((p: NpcPartyPokemon) => p._id === selectedAction.switchToPokemonId);
                                    return (
                                      <div className="rounded-md border border-primary bg-accent px-4 py-3 text-sm mb-2">
                                        <span className="font-medium">Suggested: switch to {switchTo?.nickname ?? switchTo?.speciesName ?? 'another Pokémon'} (bad matchup)</span>
                                        <span className="text-muted-foreground text-xs block mt-0.5">Submit All will switch instead of using a move. Click a move below to override.</span>
                                      </div>
                                    );
                                  })()}
                                  <div className="grid grid-cols-2 gap-2">
                                    {(slot.activePokemonInfo?.moves ?? activePokemon.moves).map((m: MoveSlot) => {
                                      const noPP = m.currentPP <= 0;
                                      const isSelected = selectedAction?.type === 'move' && selectedAction.moveId === m.moveId;
                                      return (
                                        <button
                                          key={m.moveId}
                                          onClick={() => !noPP && setNpcSelectedMove(prev => ({ ...prev, [slotKey]: { type: 'move', moveId: m.moveId } }))}
                                          disabled={noPP}
                                          className={[
                                            'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                            noPP ? 'opacity-40 cursor-not-allowed bg-muted' : isSelected ? 'bg-accent border-primary' : 'hover:bg-accent cursor-pointer',
                                          ].join(' ')}
                                        >
                                          <span className="font-medium">{formatMove(m.moveId)}</span>
                                          <span className="text-muted-foreground text-xs mt-0.5">PP {m.currentPP}/{m.maxPP}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </TabsContent>

                                <TabsContent value="switch">
                                  <p className="text-sm text-muted-foreground mb-2">Switch out for:</p>
                                  <div className="flex flex-col gap-2">
                                    {party
                                      .filter((p: NpcPartyPokemon) => p._id !== slot.activePokemonId)
                                      .map((p: NpcPartyPokemon) => {
                                        const fainted = p.currentHp <= 0;
                                        return (
                                          <button
                                            key={p._id}
                                            onClick={() => !fainted && !submitting && handleDmSubmitSwitch(npcId, p._id, slot.activePokemonId!)}
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
                                      })}
                                  </div>
                                </TabsContent>

                                <TabsContent value="item">
                                  {npcBagLoading === npcId ? (
                                    <p className="text-sm text-muted-foreground">Loading bag…</p>
                                  ) : (() => {
                                    const battleItems = (npcBags[npcId] ?? []).filter(
                                      i => i.pocket === 'healing' || i.pocket === 'status_cure' || i.pocket === 'battle_boost'
                                        || (i.pocket === 'berry' && !EV_BERRIES.has(i.itemId)),
                                    );
                                    const selectedItemId = npcSelectedItem[slotKey] ?? null;
                                    if (battleItems.length === 0) {
                                      return <p className="text-sm text-muted-foreground">No usable items in bag.</p>;
                                    }
                                    return (
                                      <div className="flex flex-col gap-3">
                                        <div className="grid grid-cols-2 gap-2">
                                          {battleItems.map(item => {
                                            const isSelected = selectedItemId === item.itemId;
                                            return (
                                              <button
                                                key={item.itemId}
                                                onClick={() => setNpcSelectedItem(prev => ({
                                                  ...prev,
                                                  [slotKey]: isSelected ? null : item.itemId,
                                                }))}
                                                className={[
                                                  'flex flex-col items-start rounded-md border px-4 py-3 text-sm text-left transition-colors min-h-11',
                                                  isSelected ? 'bg-accent border-primary' : 'hover:bg-accent cursor-pointer',
                                                ].join(' ')}
                                              >
                                                <span className="font-medium">{formatMove(item.itemId)}</span>
                                                <span className="text-muted-foreground text-xs mt-0.5">x{item.quantity}</span>
                                              </button>
                                            );
                                          })}
                                        </div>
                                        {selectedItemId && (
                                          <div className="flex flex-col gap-2">
                                            <p className="text-sm text-muted-foreground">Use on:</p>
                                            {party.map((p: NpcPartyPokemon) => (
                                              <button
                                                key={p._id}
                                                onClick={() => !submitting && handleDmSubmitItem(npcId, selectedItemId, p._id, slotKey, slot.activePokemonId!)}
                                                disabled={submitting}
                                                className="flex items-center justify-between rounded-md border px-4 py-3 text-sm text-left min-h-11 transition-colors hover:bg-accent cursor-pointer"
                                              >
                                                <span className="font-medium">{p.nickname ?? p.speciesName}</span>
                                                <span className="text-muted-foreground text-xs">
                                                  Lv.{p.level} · HP {p.currentHp}
                                                </span>
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </TabsContent>
                              </Tabs>
                            ) : (
                              <p className="text-sm text-muted-foreground">Loading party…</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}
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
                    {isNoTargetMove
                      ? '.'
                      : isAutoTargetMove
                        ? ' — hits all active targets automatically.'
                        : battle.currentMoveAllyTarget === 'ally-only'
                          ? ' — select an ally below.'
                          : battle.currentMoveAllyTarget === 'ally-or-foe'
                            ? ' — select an ally or an opponent below.'
                            : isSingleTargetMove
                              ? ' — select one target below.'
                              : ' — select one or more targets below.'}
                  </p>

                  {!isNoTargetMove && !isAutoTargetMove && (
                    pickerTargets.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No valid targets available.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {pickerTargets.map(info => {
                          const selected = selectedTargets.includes(info._id);
                          const isAlly   = allyTargetIds.has(info._id);
                          return (
                            <button
                              key={info._id}
                              onClick={() =>
                                isSingleTargetMove
                                  ? setSelectedTargets([info._id])
                                  : setSelectedTargets(prev =>
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
                              <span className="flex items-center gap-2">
                                {info.name}
                                {isAlly && (
                                  <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                                    Ally
                                  </span>
                                )}
                              </span>
                              <span className="flex flex-col items-end gap-0.5">
                                <span className="text-muted-foreground text-xs">
                                  HP {info.currentHp}{info.maxHp != null ? `/${info.maxHp}` : ''}
                                </span>
                                <span className="flex gap-1">
                                  <StatusBadge info={info} />
                                  <StatStageBadges stages={info.statStages} />
                                </span>
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
                  ) : isAutoTargetMove ? (
                    <Button
                      onClick={() => handleAutoTargetMove(opposingTargets.map(t => t._id))}
                      disabled={submitting || opposingTargets.length === 0}
                      className="w-full min-h-11"
                    >
                      {submitting
                        ? 'Confirming…'
                        : `Use ${formatMove(currentTargetEntry.moveId)} — hits all (${opposingTargets.length})`}
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
                  <span className="font-medium text-foreground">{targetActorLabel}</span>
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
                        className="flex-1 h-11 md:h-9 rounded-md border px-3 py-2 text-base md:text-sm bg-background"
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
                        className="w-20 h-11 md:h-9 rounded-md border px-3 py-2 text-base md:text-sm bg-background"
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

        {/* Battle Log — visible to everyone once events exist, including after battle ends.
            Also shown with just the waiting line when the current turn has no logged
            events yet (e.g. targeting on turn 1, before anything has resolved). */}
        {battle.status !== 'waiting' && (battle.turnLog.length > 0 || battleLogWaitingLine) && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Battle Log</CardTitle>
                <Tabs
                  value={logMode}
                  onValueChange={v => {
                    setLogMode(v as 'live' | 'replay');
                    setReplayIndex(0);
                    setReplayPlaying(false);
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="live">Live</TabsTrigger>
                    <TabsTrigger value="replay">Replay</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </CardHeader>
            <CardContent>
              {logMode === 'live' ? (
                <div className="flex flex-col gap-4 max-h-64 overflow-y-auto pr-1">
                  {battle.turnLog.length === 0 && battleLogWaitingLine ? (
                    <div>
                      <p className="text-xs font-semibold mb-1 text-foreground">
                        Turn {battle.turnNumber}
                      </p>
                      <ul className="flex flex-col gap-1">
                        <li className="text-sm italic text-muted-foreground">
                          {battleLogWaitingLine}
                        </li>
                      </ul>
                    </div>
                  ) : (
                    [...battle.turnLog].reverse().map((entry, idx) => (
                      <div key={entry.turn}>
                        <p className={`text-xs font-semibold mb-1 ${idx === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                          Turn {entry.turn}
                        </p>
                        <ul className="flex flex-col gap-1">
                          {idx === 0 && battleLogWaitingLine && (
                            <li className="text-sm italic text-muted-foreground">
                              {battleLogWaitingLine}
                            </li>
                          )}
                          {[...entry.events].reverse().map((event, i) => (
                            <li
                              key={i}
                              className={`text-sm ${idx === 0 ? 'text-foreground' : 'text-muted-foreground'}`}
                            >
                              {event}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={replayIndex === 0}
                      onClick={() => { setReplayPlaying(false); setReplayIndex(i => Math.max(0, i - 1)); }}
                    >
                      ← Prev
                    </Button>
                    <div className="flex flex-col items-center gap-1">
                      <p className="text-xs text-muted-foreground">
                        Turn {battle.turnLog[replayIndex]?.turn ?? 1} of {battle.turnLog[battle.turnLog.length - 1]?.turn ?? 1}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={replayIndex >= battle.turnLog.length - 1 && !replayPlaying}
                        onClick={() => setReplayPlaying(p => !p)}
                      >
                        {replayPlaying ? 'Pause' : 'Play'}
                      </Button>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={replayIndex >= battle.turnLog.length - 1}
                      onClick={() => { setReplayPlaying(false); setReplayIndex(i => Math.min(battle.turnLog.length - 1, i + 1)); }}
                    >
                      Next →
                    </Button>
                  </div>
                  <div className="flex flex-col gap-4 max-h-64 overflow-y-auto pr-1">
                    {battle.turnLog.slice(0, replayIndex + 1).map((entry, idx, visible) => {
                      const isCurrent = idx === visible.length - 1;
                      return (
                        <div key={entry.turn}>
                          <p className={`text-xs font-semibold mb-1 ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                            Turn {entry.turn}
                          </p>
                          <ul className="flex flex-col gap-1">
                            {entry.events.map((event, i) => (
                              <li
                                key={i}
                                className={`text-sm ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}
                              >
                                {event}
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Player side — shows send-out and submission status for everyone */}
        <Card>
          <CardHeader><CardTitle>{playerSideTitle}</CardTitle></CardHeader>
          <CardContent>
            {battle.playerSide.length === 0 ? (
              <p className="text-sm text-muted-foreground">No players in this battle.</p>
            ) : (
              <TrainerRosterList entries={battle.playerSide} battle={battle} />
            )}
          </CardContent>
        </Card>

        {/* Enemy side */}
        <Card>
          <CardHeader><CardTitle>{enemySideTitle}</CardTitle></CardHeader>
          <CardContent>
            {battle.enemySide.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No enemies yet — enemies are added via the encounter builder (coming soon).
              </p>
            ) : battle.type === 'pvp' ? (
              // Pvp: enemySide is a roster of real trainers — render exactly like Player Side above.
              <TrainerRosterList entries={battle.enemySide} battle={battle} />
            ) : (
              <div className="flex flex-col gap-3">
                {(() => {
                  const seenNpcIds = new Set<string>();
                  return battle.enemySide.map(entry => {
                    const isWild = !entry.npcId;
                    if (!isWild && seenNpcIds.has(entry.npcId!)) return null;
                    if (!isWild) seenNpcIds.add(entry.npcId!);

                    if (isWild) {
                      return (
                        <div key={entry.activePokemonId ?? 'wild'}>
                          {entry.activePokemonInfo
                            ? <BattlePokemonCard info={entry.activePokemonInfo} />
                            : <p className="text-xs text-muted-foreground">Fainted / Caught</p>
                          }
                        </div>
                      );
                    }

                    // NPC group
                    const npcId    = entry.npcId!;
                    const npcSlots = battle.enemySide.filter(e => e.npcId === npcId);
                    return (
                      <div key={npcId} className="flex flex-col gap-2">
                        <span className="text-sm font-medium">{entry.npcName}</span>
                        {npcSlots.map((slot, slotIdx) => (
                          <div key={`${npcId}:${slotIdx}`} className={npcSlots.length > 1 ? 'pl-3 border-l ml-1' : ''}>
                            {npcSlots.length > 1 && (
                              <p className="text-xs text-muted-foreground mb-1">Slot {slotIdx + 1}</p>
                            )}
                            {slot.activePokemonInfo
                              ? <BattlePokemonCard info={slot.activePokemonInfo} />
                              : <p className="text-xs text-muted-foreground">No Pokémon out</p>
                            }
                          </div>
                        ))}
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
