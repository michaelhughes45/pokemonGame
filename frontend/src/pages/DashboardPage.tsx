import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { TYPE_BG } from '../lib/typeColors';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const API = import.meta.env.VITE_API_URL;

type PendingInvite = {
  _id: string;
  name: string;
  dmUsername: string;
};

type ActiveBattle = {
  _id: string;
  status: 'waiting' | 'active';
  type: 'pve' | 'wild' | 'pvp';
  turnNumber: number;
};

const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'destructive'> = {
  admin: 'destructive',
  dm:    'default',
  player: 'secondary',
};

type PartyMember = {
  _id: string;
  speciesId: number;
  nickname: string | null;
  level: number;
  currentHp: number;
  maxHp: number | null;
  gender: 'male' | 'female' | 'none';
  statusCondition: string | null;
  partySlot: number | null;
  speciesName: string | null;
  types: string[];
};

function formatName(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function HpBar({ current, max }: { current: number; max: number | null }) {
  const pct = max && max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground">
        {current}{max !== null ? `/${max}` : ''}
      </span>
    </div>
  );
}

// Same 6 stat keys the EV system uses — Trainer IV points (milestone 5.5) can
// be freely split across any of them, one point at a time.
const TRAINER_STAT_OPTIONS: { key: string; label: string }[] = [
  { key: 'hp',    label: 'HP'      },
  { key: 'atk',   label: 'Attack'  },
  { key: 'def',   label: 'Defense' },
  { key: 'spatk', label: 'Sp. Atk' },
  { key: 'spdef', label: 'Sp. Def' },
  { key: 'speed', label: 'Speed'   },
];

export default function DashboardPage() {
  const { user, token, logout, refreshUser } = useAuth();
  const navigate = useNavigate();

  const [party, setParty]               = useState<PartyMember[]>([]);
  const [partyLoading, setPartyLoading] = useState(true);
  const [invites, setInvites]           = useState<PendingInvite[]>([]);
  const [inviteError, setInviteError]   = useState('');
  const [activeBattle, setActiveBattle] = useState<ActiveBattle | null>(null);
  const [allocateBusy, setAllocateBusy]   = useState(false);
  const [allocateError, setAllocateError] = useState('');

  async function handleAllocateTrainerStat(stat: string) {
    setAllocateBusy(true);
    setAllocateError('');
    try {
      await axios.post(
        `${API}/api/auth/trainer-stat`,
        { stat, amount: 1 },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await refreshUser();
    } catch (err) {
      setAllocateError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to allocate point') : 'Failed to allocate point');
    } finally {
      setAllocateBusy(false);
    }
  }

  function handleLogout() {
    logout();
    navigate('/login');
  }

  // Fetch the player's party on mount
  useEffect(() => {
    axios
      .get(`${API}/api/pokemon/party`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setParty(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setPartyLoading(false));
  }, [token]);

  // Fetch active battle for players (surfaces "Battle in progress" card); polls so the card
  // disappears automatically when the battle completes without requiring a page reload.
  useEffect(() => {
    if (!user || user.role !== 'player') return;
    let cancelled = false;

    function fetchActiveBattle() {
      axios
        .get(`${API}/api/battles/active`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then(res => { if (!cancelled) setActiveBattle(res.data.data ?? null); })
        .catch(() => {});
    }

    fetchActiveBattle();
    const interval = setInterval(fetchActiveBattle, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [token, user]);

  // Fetch pending campaign invites for players
  useEffect(() => {
    if (!user || user.role !== 'player') return;
    axios
      .get(`${API}/api/campaigns/invites`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setInvites(res.data.data ?? []))
      .catch(() => {});
  }, [token, user]);

  async function handleInviteRespond(campaignId: string, action: 'accept' | 'decline') {
    setInviteError('');
    try {
      await axios.post(
        `${API}/api/campaigns/invite/respond`,
        { campaignId, action },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Remove the invite from the list regardless of accept/decline
      setInvites(prev => prev.filter(i => i._id !== campaignId));
    } catch (err: unknown) {
      setInviteError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to respond') : 'Failed to respond');
    }
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        {/* ── Top bar ── */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <Button variant="outline" onClick={handleLogout} className="min-h-11">
            Log out
          </Button>
        </div>

        {/* ── Active battle banner (players only) ── */}
        {activeBattle && (
          <Link to={`/battle/${activeBattle._id}`}>
            <Card className="border-green-500 bg-green-50 hover:bg-green-100 dark:border-green-700 dark:bg-green-950 dark:hover:bg-green-900 transition-colors cursor-pointer">
              <CardContent className="pt-4 flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <p className="font-semibold text-sm text-green-900 dark:text-green-100">
                    {activeBattle.status === 'waiting' ? 'Battle Starting…' : `Battle in Progress — Turn ${activeBattle.turnNumber}`}
                  </p>
                  <p className="text-xs text-green-700 dark:text-green-400 capitalize">{activeBattle.type} battle</p>
                </div>
                <span className="text-green-700 dark:text-green-400 text-sm font-medium">Enter →</span>
              </CardContent>
            </Card>
          </Link>
        )}

        {/* ── Navigation links ── */}
        <div className="flex flex-col gap-1">
          {party.length === 0 && !partyLoading && (
            <Link to="/starter" className="text-sm underline text-muted-foreground">
              Pick your starter Pokémon →
            </Link>
          )}
          {party.length > 0 && (
            <Link to="/party" className="text-sm underline text-muted-foreground">
              Manage Party →
            </Link>
          )}
          <Link to="/pc" className="text-sm underline text-muted-foreground">
            PC Storage →
          </Link>
          <Link to="/bag" className="text-sm underline text-muted-foreground">
            Bag →
          </Link>
          <Link to="/town" className="text-sm underline text-muted-foreground">
            Town →
          </Link>
          {(user.role === 'dm' || user.role === 'admin') && (
            <Link to="/dm" className="text-sm underline text-muted-foreground">
              DM Panel →
            </Link>
          )}
          {user.role === 'admin' && (
            <Link to="/admin" className="text-sm underline text-muted-foreground">
              Admin Panel →
            </Link>
          )}
        </div>

        {/* ── Pending campaign invites (players only) ── */}
        {invites.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3">Campaign Invites</h2>
            <div className="flex flex-col gap-3">
              {invites.map(invite => (
                <Card key={invite._id}>
                  <CardContent className="pt-4 flex flex-col gap-3">
                    <div>
                      <p className="font-medium text-sm">{invite.name}</p>
                      <p className="text-xs text-muted-foreground">from DM: {invite.dmUsername}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="min-h-9 flex-1"
                        onClick={() => handleInviteRespond(invite._id, 'accept')}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-9 flex-1"
                        onClick={() => handleInviteRespond(invite._id, 'decline')}
                      >
                        Decline
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
            </div>
          </div>
        )}

        {/* ── Trainer card ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {user.username}
              <Badge variant={roleBadgeVariant[user.role] ?? 'secondary'}>
                {user.role}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Trainer IV points</span>
                <span>{user.trainerIvUnspent} unspent</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Earn 5 points per badge. Spend them on any stat — once spent, a point is
                locked in unless your DM resets it.
              </p>
              <div className="flex flex-col gap-1">
                {TRAINER_STAT_OPTIONS.map(opt => (
                  <div key={opt.key} className="flex items-center justify-between text-sm">
                    <span>{opt.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{user.trainerStats[opt.key as keyof typeof user.trainerStats]}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={allocateBusy || user.trainerIvUnspent <= 0}
                        onClick={() => handleAllocateTrainerStat(opt.key)}
                        className="min-h-8 min-w-8 px-2"
                      >
                        +1
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {allocateError && <p className="text-xs text-destructive">{allocateError}</p>}
            </div>
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Badges</span>
                <span>{user.badges.length}</span>
              </div>
              {user.badges.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {user.badges.map(b => (
                    <img
                      key={b.badgeId}
                      src={b.imageUrl}
                      alt={b.name}
                      title={b.name}
                      className="w-9 h-9 object-contain"
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Money</span>
              <span>₽{user.money.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        {/* ── Party ── */}
        {/*
          Each card links to /pokemon/:id so the player can tap into the detail view.
          The HP bar uses currentHp / maxHp (computed by the backend from base stats + level + nature).
          Types are shown as coloured chips, same palette as the detail page.
        */}
        {(partyLoading || party.length > 0) && (
          <div>
            <h2 className="text-lg font-semibold mb-3">Your Party</h2>
            {partyLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="flex flex-col gap-3">
                {party.map(p => (
                  <Link key={String(p._id)} to={`/pokemon/${p._id}`}>
                    <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                      <CardContent className="pt-4 flex gap-3 items-start">
                        <img
                          src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.speciesId}.png`}
                          alt={p.speciesName ?? String(p.speciesId)}
                          width={64}
                          height={64}
                          className="pixelated shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="font-semibold text-sm">
                              {p.nickname
                                ? `${formatName(p.nickname)}`
                                : p.speciesName
                                  ? formatName(p.speciesName)
                                  : `#${p.speciesId}`}
                            </span>
                            {p.nickname && p.speciesName && (
                              <span className="text-xs text-muted-foreground">
                                ({formatName(p.speciesName)})
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto">
                              Lv. {p.level}
                            </span>
                          </div>
                          <div className="flex gap-1 flex-wrap mt-1">
                            {p.types.map(t => (
                              <span
                                key={t}
                                className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ${TYPE_BG[t] ?? 'bg-gray-400'}`}
                              >
                                {formatName(t)}
                              </span>
                            ))}
                            {p.statusCondition && (
                              <Badge variant="secondary" className="text-[10px] uppercase">
                                {p.statusCondition}
                              </Badge>
                            )}
                          </div>
                          <HpBar current={p.currentHp} max={p.maxHp} />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
