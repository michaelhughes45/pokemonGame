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
  evs: { hp: number; atk: number; def: number; spatk: number; spdef: number; speed: number };
};

type EvStatKey = 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';
const EV_STAT_CAP = 252;
const EV_TOTAL_CAP = 510;
const EV_STAT_KEYS: EvStatKey[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'];
const EV_STAT_LABELS: Record<EvStatKey, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spatk: 'SpA', spdef: 'SpD', speed: 'Spe',
};

type PlayerBadge = { badgeId: string; name: string; imageUrl: string; awardedAt: string };

type BadgeCatalogEntry = {
  badgeId: string;
  name: string;
  region: string;
  imageUrl: string;
  gymLeader?: string;
  versionExclusive?: string;
};

type CustomBadgeEntry = { badgeId: string; name: string; imageUrl: string; createdAt: string };

type TrainerStats = Record<EvStatKey, number>;

type Roster = {
  party: RosterPokemon[];
  pc: RosterPokemon[];
  badges: PlayerBadge[];
  trainerStats: TrainerStats;
  trainerIvUnspent: number;
};

// Matches the native <select> style used throughout DmPage
const selectClass =
  'w-full border border-input bg-background rounded-md px-3 py-2 text-sm min-h-11 ' +
  'focus:outline-none focus:ring-2 focus:ring-ring';

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
// EvSummary
// Compact single-line EV readout: total/cap plus a chip per non-zero stat.
// ---------------------------------------------------------------------------

function EvSummary({ evs }: { evs: RosterPokemon['evs'] }) {
  const total = evs.hp + evs.atk + evs.def + evs.spatk + evs.spdef + evs.speed;
  const nonZero = (Object.keys(evs) as (keyof typeof evs)[]).filter(k => evs[k] > 0);
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
      <span>EVs: {total}/{EV_TOTAL_CAP}</span>
      {nonZero.map(k => (
        <span key={k} className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200 font-medium">
          {EV_STAT_LABELS[k]} {evs[k]}
        </span>
      ))}
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
        <EvSummary evs={poke.evs} />
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

  const [evOpen,   setEvOpen]   = useState(false);
  const [evInputs, setEvInputs] = useState<Record<EvStatKey, string>>(() =>
    Object.fromEntries(EV_STAT_KEYS.map(k => [k, String(poke.evs[k])])) as Record<EvStatKey, string>,
  );
  const [evBusy,   setEvBusy]   = useState(false);
  const [evError,  setEvError]  = useState('');

  function showMsg(text: string, error = false) {
    setMessage(text);
    setIsError(error);
    setTimeout(() => setMessage(''), 4000);
  }

  function openEvEditor() {
    setEvInputs(Object.fromEntries(EV_STAT_KEYS.map(k => [k, String(poke.evs[k])])) as Record<EvStatKey, string>);
    setEvError('');
    setEvOpen(true);
  }

  const evTotal = EV_STAT_KEYS.reduce((sum, k) => sum + (parseInt(evInputs[k], 10) || 0), 0);

  async function handleSaveEvs() {
    const parsed = {} as Record<EvStatKey, number>;
    for (const k of EV_STAT_KEYS) {
      const n = parseInt(evInputs[k], 10);
      if (!Number.isInteger(n) || n < 0 || n > EV_STAT_CAP) {
        setEvError(`${EV_STAT_LABELS[k]} must be an integer between 0 and ${EV_STAT_CAP}.`);
        return;
      }
      parsed[k] = n;
    }
    if (evTotal > EV_TOTAL_CAP) {
      setEvError(`Total EVs cannot exceed ${EV_TOTAL_CAP} (currently ${evTotal}).`);
      return;
    }
    setEvBusy(true);
    setEvError('');
    try {
      await axios.patch(
        `${API}/api/dm/pokemon/${poke._id}/evs`,
        { evs: parsed },
        { headers },
      );
      setEvOpen(false);
      onRefresh();
    } catch (err) {
      setEvError(apiError(err, 'Failed to update EVs'));
    } finally {
      setEvBusy(false);
    }
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
        <p className={`text-xs ${isError ? 'text-red-500 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{message}</p>
      )}

      {!evOpen ? (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={openEvEditor}>
          Edit EVs
        </Button>
      ) : (
        <div className="border rounded-md p-2 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {EV_STAT_KEYS.map(k => (
              <div key={k} className="flex flex-col gap-0.5">
                <label className="text-[10px] text-muted-foreground">{EV_STAT_LABELS[k]}</label>
                <input
                  type="number"
                  min={0}
                  max={EV_STAT_CAP}
                  value={evInputs[k]}
                  onChange={e => setEvInputs(prev => ({ ...prev, [k]: e.target.value }))}
                  disabled={evBusy}
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                />
              </div>
            ))}
          </div>
          <p className={`text-xs ${evTotal > EV_TOTAL_CAP ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'}`}>
            Total: {evTotal}/{EV_TOTAL_CAP}
          </p>
          {evError && <p className="text-xs text-red-500 dark:text-red-400">{evError}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={evBusy} onClick={handleSaveEvs} className="shrink-0">
              Save EVs
            </Button>
            <Button size="sm" variant="outline" disabled={evBusy} onClick={() => setEvOpen(false)} className="shrink-0">
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BadgeTile
// One awarded badge — image + name, with an optional revoke button.
// ---------------------------------------------------------------------------

function BadgeTile({ badge, onRevoke }: { badge: PlayerBadge; onRevoke?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1 w-20 text-center">
      <div className="relative">
        <img src={badge.imageUrl} alt={badge.name} className="w-12 h-12 object-contain" />
        {onRevoke && (
          <button
            type="button"
            onClick={onRevoke}
            title={`Revoke ${badge.name}`}
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center"
          >
            ×
          </button>
        )}
      </div>
      <span className="text-xs leading-tight">{badge.name}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrainerStatCard
// Shows a selected player's spent Trainer IV point spread (milestone 5.5)
// plus their unspent pool, and lets the DM reset the whole spread so the
// player can reallocate from scratch.
// ---------------------------------------------------------------------------

type TrainerStatCardProps = {
  username:         string;
  trainerStats:     TrainerStats;
  trainerIvUnspent: number;
  headers:          { Authorization: string };
  onRefresh:        () => void;
};

function TrainerStatCard({ username, trainerStats, trainerIvUnspent, headers, onRefresh }: TrainerStatCardProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');

  async function handleReset() {
    setBusy(true);
    try {
      const res = await axios.delete(`${API}/api/dm/players/${username}/trainer-stat`, { headers });
      setMessage(res.data.data?.message ?? 'Reset');
      setConfirming(false);
      onRefresh();
    } catch (err) {
      setMessage(apiError(err, 'Failed to reset'));
    } finally {
      setBusy(false);
    }
  }

  const spent = EV_STAT_KEYS.reduce((sum, key) => sum + trainerStats[key], 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Trainer IV Points
          <Badge variant="secondary" className="ml-2 text-xs">{trainerIvUnspent} unspent</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {spent === 0 ? (
          <p className="text-sm text-muted-foreground">No points allocated yet.</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {EV_STAT_KEYS.filter(key => trainerStats[key] > 0).map(key => (
              <span key={key}>{EV_STAT_LABELS[key]}: {trainerStats[key]}</span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {spent > 0 && !confirming && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              Reset
            </Button>
          )}
          {confirming && (
            <>
              <Button size="sm" variant="destructive" disabled={busy} onClick={handleReset}>
                Confirm Reset
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          )}
        </div>
        {message && <p className="text-xs text-muted-foreground">{message}</p>}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BadgesCard
// Shows a selected player's held badges and lets the DM award one from the
// catalog + campaign custom badges, or revoke a held one.
// ---------------------------------------------------------------------------

type BadgesCardProps = {
  username:      string;
  badges:        PlayerBadge[];
  catalog:       BadgeCatalogEntry[];
  customBadges:  CustomBadgeEntry[];
  headers:       { Authorization: string };
  onRefresh:     () => void;
};

function BadgesCard({ username, badges, catalog, customBadges, headers, onRefresh }: BadgesCardProps) {
  const [selectedBadgeId, setSelectedBadgeId] = useState('');
  const [busy,            setBusy]            = useState(false);
  const [message,         setMessage]         = useState('');
  const [isError,         setIsError]         = useState(false);

  function showMsg(text: string, error = false) {
    setMessage(text);
    setIsError(error);
    setTimeout(() => setMessage(''), 4000);
  }

  const heldIds = new Set(badges.map(b => b.badgeId));
  const regions = [...new Set(catalog.map(b => b.region))];
  const availableCustom = customBadges.filter(b => !heldIds.has(b.badgeId));

  async function handleAward() {
    if (!selectedBadgeId) return;
    setBusy(true);
    try {
      const res = await axios.post(
        `${API}/api/dm/players/${username}/badges`,
        { badgeId: selectedBadgeId },
        { headers },
      );
      const unlockedCount = res.data.data?.unlockedCount ?? 0;
      const suffix = unlockedCount > 0 ? ` (${unlockedCount} Pokémon leveled up!)` : '';
      showMsg((res.data.data?.message ?? 'Badge awarded') + suffix);
      setSelectedBadgeId('');
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to award badge'), true);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(badgeId: string) {
    setBusy(true);
    try {
      const res = await axios.delete(`${API}/api/dm/players/${username}/badges/${badgeId}`, { headers });
      showMsg(res.data.data?.message ?? 'Badge revoked');
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to revoke badge'), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Badges
          <Badge variant="secondary" className="ml-2 text-xs">{badges.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {badges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No badges yet.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {badges.map(b => (
              <BadgeTile key={b.badgeId} badge={b} onRevoke={() => handleRevoke(b.badgeId)} />
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <select
            value={selectedBadgeId}
            onChange={e => setSelectedBadgeId(e.target.value)}
            className={selectClass}
            disabled={busy}
          >
            <option value="">— Select a badge to award —</option>
            {regions.map(region => (
              <optgroup key={region} label={region}>
                {catalog
                  .filter(b => b.region === region && !heldIds.has(b.badgeId))
                  .map(b => (
                    <option key={b.badgeId} value={b.badgeId}>
                      {b.name}{b.versionExclusive ? ` (${b.versionExclusive})` : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
            {availableCustom.length > 0 && (
              <optgroup label="Custom">
                {availableCustom.map(b => (
                  <option key={b.badgeId} value={b.badgeId}>{b.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <Button size="sm" onClick={handleAward} disabled={busy || !selectedBadgeId} className="shrink-0">
            Award
          </Button>
        </div>
        {message && (
          <p className={`text-xs ${isError ? 'text-red-500 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{message}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CustomBadgesCard
// Campaign-wide (not player-scoped): lets the DM define homebrew badges
// beyond the hardcoded catalog, and remove ones no longer needed.
// ---------------------------------------------------------------------------

type CustomBadgesCardProps = {
  customBadges: CustomBadgeEntry[];
  headers:      { Authorization: string };
  onRefresh:    () => void;
};

function CustomBadgesCard({ customBadges, headers, onRefresh }: CustomBadgesCardProps) {
  const [name,     setName]     = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [message,  setMessage]  = useState('');
  const [isError,  setIsError]  = useState(false);

  function showMsg(text: string, error = false) {
    setMessage(text);
    setIsError(error);
    setTimeout(() => setMessage(''), 4000);
  }

  async function handleCreate() {
    if (!name.trim() || !imageUrl.trim()) {
      showMsg('Name and image URL are both required.', true);
      return;
    }
    setBusy(true);
    try {
      await axios.post(`${API}/api/dm/badges/custom`, { name: name.trim(), imageUrl: imageUrl.trim() }, { headers });
      setName('');
      setImageUrl('');
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to create custom badge'), true);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(badgeId: string) {
    setBusy(true);
    try {
      await axios.delete(`${API}/api/dm/badges/custom/${badgeId}`, { headers });
      onRefresh();
    } catch (err) {
      showMsg(apiError(err, 'Failed to delete custom badge'), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Custom Badges (homebrew)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {customBadges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No custom badges defined yet.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {customBadges.map(b => (
              <BadgeTile
                key={b.badgeId}
                badge={{ ...b, awardedAt: b.createdAt }}
                onRevoke={() => handleDelete(b.badgeId)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Badge name"
            className="flex-1 h-11 rounded-md border border-input bg-background px-3 py-1 text-sm min-w-0"
            disabled={busy}
          />
          <input
            value={imageUrl}
            onChange={e => setImageUrl(e.target.value)}
            placeholder="Image URL"
            className="flex-1 h-11 rounded-md border border-input bg-background px-3 py-1 text-sm min-w-0"
            disabled={busy}
          />
          <Button size="sm" onClick={handleCreate} disabled={busy} className="shrink-0">
            Add
          </Button>
        </div>
        {message && (
          <p className={`text-xs ${isError ? 'text-red-500 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{message}</p>
        )}
      </CardContent>
    </Card>
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

  const [catalog,          setCatalog]          = useState<BadgeCatalogEntry[]>([]);
  const [customBadges,     setCustomBadges]     = useState<CustomBadgeEntry[]>([]);
  const [customBadgesKey,  setCustomBadgesKey]  = useState(0);

  const refreshRoster = () => setRosterKey(k => k + 1);
  const refreshCustomBadges = () => setCustomBadgesKey(k => k + 1);

  // Load campaign player list + badge catalog on mount
  useEffect(() => {
    axios.get(`${API}/api/campaigns/mine`, { headers })
      .then(res => setPlayers(res.data.data?.players ?? []))
      .catch(err => setPlayersError(apiError(err, 'Failed to load campaign players')))
      .finally(() => setPlayersLoading(false));
    axios.get(`${API}/api/dm/badges`, { headers })
      .then(res => setCatalog(res.data.data ?? []))
      .catch(() => { /* catalog is optional for the rest of the page to function */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load custom badges on mount and whenever one is created/deleted
  useEffect(() => {
    axios.get(`${API}/api/dm/badges/custom`, { headers })
      .then(res => setCustomBadges(res.data.data ?? []))
      .catch(() => { /* non-fatal — award picker just won't show custom badges */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customBadgesKey]);

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
  if (playersError)   return <div className="p-6 text-center text-red-500 dark:text-red-400">{playersError}</div>;

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

      {/* Custom badges — campaign-wide, not tied to the selected player */}
      <CustomBadgesCard customBadges={customBadges} headers={headers} onRefresh={refreshCustomBadges} />

      {/* Roster */}
      {selectedUsername && (
        <div className="space-y-4">
          {rosterLoading && (
            <p className="text-center text-muted-foreground">Loading roster…</p>
          )}
          {rosterError && (
            <p className="text-center text-red-500 dark:text-red-400">{rosterError}</p>
          )}
          {roster && !rosterLoading && (
            <>
              <TrainerStatCard
                username={selectedUsername}
                trainerStats={roster.trainerStats}
                trainerIvUnspent={roster.trainerIvUnspent}
                headers={headers}
                onRefresh={refreshRoster}
              />
              <BadgesCard
                username={selectedUsername}
                badges={roster.badges}
                catalog={catalog}
                customBadges={customBadges}
                headers={headers}
                onRefresh={refreshRoster}
              />
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
