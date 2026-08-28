import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { apiError } from '../lib/apiError';
import { formatName } from '../lib/formatName';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

type Role = 'player' | 'dm' | 'admin';

type AdminUser = {
  _id: string;
  username: string;
  email: string;
  role: Role;
  createdAt: string;
  campaignName: string | null;
};

const ROLES: Role[] = ['player', 'dm', 'admin'];

const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'destructive'> = {
  admin:  'destructive',
  dm:     'default',
  player: 'secondary',
};

// Matches the native <select> style used throughout DmPage/DmPlayersPage
const selectClass =
  'border border-input bg-background rounded-md px-2 py-1.5 text-base md:text-sm min-h-11 md:min-h-9 ' +
  'focus:outline-none focus:ring-2 focus:ring-ring';


// ---------------------------------------------------------------------------
// UsersCard
// ---------------------------------------------------------------------------

type DeleteStep = 'confirm1' | 'confirm2' | 'busy';
type ResetCode = { token: string; expiresAt: string };

function UsersCard({ token, currentUserId }: { token: string | null; currentUserId: string | undefined }) {
  const [users,        setUsers]        = useState<AdminUser[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [actionError,   setActionError]   = useState('');
  const [savingId,      setSavingId]      = useState<string | null>(null);
  const [deleteTarget,  setDeleteTarget]  = useState<{ id: string; step: DeleteStep } | null>(null);
  const [resetBusyId,   setResetBusyId]   = useState<string | null>(null);
  const [resetError,    setResetError]    = useState('');
  const [resetCodes,    setResetCodes]    = useState<Record<string, ResetCode>>({});

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios
      .get(`${API}/api/admin/users`, { headers })
      .then(res => setUsers(res.data.data))
      .catch(err => setError(apiError(err, 'Failed to load users')))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleRoleChange(userId: string, newRole: Role) {
    setActionError('');
    setSavingId(userId);
    try {
      await axios.patch(`${API}/api/admin/users/${userId}/role`, { role: newRole }, { headers });
      setUsers(prev => prev.map(u => (u._id === userId ? { ...u, role: newRole } : u)));
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to update role'));
    } finally {
      setSavingId(null);
    }
  }

  async function handleGenerateResetCode(userId: string) {
    setResetError('');
    setResetBusyId(userId);
    try {
      const res = await axios.post(`${API}/api/admin/users/${userId}/password-reset-token`, {}, { headers });
      setResetCodes(prev => ({ ...prev, [userId]: { token: res.data.data.token, expiresAt: res.data.data.expiresAt } }));
    } catch (err: unknown) {
      setResetError(apiError(err, 'Failed to generate reset code'));
    } finally {
      setResetBusyId(null);
    }
  }

  async function handleDelete(userId: string) {
    setActionError('');
    setDeleteTarget({ id: userId, step: 'busy' });
    try {
      await axios.delete(`${API}/api/admin/users/${userId}`, { headers });
      setUsers(prev => prev.filter(u => u._id !== userId));
      setDeleteTarget(null);
    } catch (err: unknown) {
      setActionError(apiError(err, 'Failed to delete user'));
      setDeleteTarget(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Users ({users.length})</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}
        {!loading && !error && users.map(u => {
          const isSelf = u._id === currentUserId;
          const deleting = deleteTarget?.id === u._id ? deleteTarget.step : null;
          return (
            <div
              key={u._id}
              className={`flex flex-col gap-3 rounded-md border px-3 py-2 ${deleting ? 'border-destructive' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{u.username}</span>
                    <Badge variant={roleBadgeVariant[u.role]}>{u.role}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground truncate">{u.email}</span>
                  {u.campaignName && (
                    <span className="text-xs text-muted-foreground truncate">Campaign: {u.campaignName}</span>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <select
                    className={selectClass}
                    value={u.role}
                    disabled={isSelf || savingId === u._id}
                    title={isSelf ? "You can't change your own role" : undefined}
                    onChange={e => handleRoleChange(u._id, e.target.value as Role)}
                  >
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {resetCodes[u._id] && (
                <div className="flex flex-col gap-0.5 rounded-md bg-muted px-3 py-2">
                  <span className="text-sm">
                    Reset code: <span className="font-mono font-semibold">{resetCodes[u._id].token}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Give this to {u.username} — they enter it on the login page's "Forgot password"
                    form to set their own new password. Expires {new Date(resetCodes[u._id].expiresAt).toLocaleTimeString()}.
                  </span>
                </div>
              )}

              {!deleting && (
                <div className="flex items-center justify-end gap-2">
                  {resetError && <p className="text-sm text-destructive">{resetError}</p>}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resetBusyId === u._id}
                    onClick={() => handleGenerateResetCode(u._id)}
                  >
                    {resetBusyId === u._id ? 'Generating…' : 'Generate Reset Code'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                    disabled={isSelf}
                    title={isSelf ? "You can't delete your own account" : undefined}
                    onClick={() => setDeleteTarget({ id: u._id, step: 'confirm1' })}
                  >
                    Delete
                  </Button>
                </div>
              )}

              {deleting === 'confirm1' && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold text-destructive">
                    Delete {u.username}? This removes their Pokémon, items, and campaign membership.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setDeleteTarget(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1"
                      onClick={() => setDeleteTarget({ id: u._id, step: 'confirm2' })}
                    >
                      Yes, delete
                    </Button>
                  </div>
                </div>
              )}

              {(deleting === 'confirm2' || deleting === 'busy') && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold text-destructive">
                    Final confirmation — this cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={deleting === 'busy'}
                      onClick={() => setDeleteTarget(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="flex-1"
                      disabled={deleting === 'busy'}
                      onClick={() => handleDelete(u._id)}
                    >
                      {deleting === 'busy' ? 'Deleting…' : 'Confirm Delete'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PokedexCacheCard
// ---------------------------------------------------------------------------

type PokedexEntry = {
  _id: string;
  pokeApiId: number;
  name: string;
  types: string[];
  cachedAt: string;
};

function PokedexCacheCard({ token }: { token: string | null }) {
  const [query,       setQuery]       = useState('');
  const [entries,     setEntries]     = useState<PokedexEntry[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      axios
        .get(`${API}/api/admin/pokedex`, { headers, params: query ? { q: query } : {} })
        .then(res => setEntries(res.data.data))
        .catch(err => setError(apiError(err, 'Failed to load Pokédex cache')))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, query]);

  async function handleRefresh(id: string) {
    setRefreshError('');
    setRefreshingId(id);
    try {
      await axios.post(`${API}/api/admin/pokedex/${id}/refresh`, {}, { headers });
      setEntries(prev => prev.map(e => (e._id === id ? { ...e, cachedAt: new Date().toISOString() } : e)));
    } catch (err: unknown) {
      setRefreshError(apiError(err, 'Failed to refresh from PokeAPI'));
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Pokédex Cache</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input
          placeholder="Search cached species by name…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {refreshError && <p className="text-sm text-destructive">{refreshError}</p>}
        {!loading && !error && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No cached species match.</p>
        )}
        {!loading && !error && entries.map(e => (
          <div
            key={e._id}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 min-h-14"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">#{e.pokeApiId}</span>
                <span className="text-sm font-medium truncate">{formatName(e.name)}</span>
                {e.types.map(t => (
                  <Badge key={t} variant="secondary" className="capitalize">{t}</Badge>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">
                Cached {new Date(e.cachedAt).toLocaleString()}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshingId === e._id}
              onClick={() => handleRefresh(e._id)}
            >
              {refreshingId === e._id ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// BulkCleanupCard
// Sweeps every user whose username matches a pattern — built for clearing
// out disposable test accounts (verify*/tmdm*/tmplayer*) left over from live
// verification passes. Shows exactly who will be hit before anything is
// deleted, since a pattern match (unlike picking one user) can't be eyeballed
// in advance any other way.
// ---------------------------------------------------------------------------

const BULK_MIN_PATTERN_LENGTH = 3;
type SweepStep = 'idle' | 'confirm' | 'busy';
type SweepResult = { deleted: string[]; skipped: { username: string; reason: string }[] };

function BulkCleanupCard({ token }: { token: string | null }) {
  const [users,   setUsers]   = useState<AdminUser[]>([]);
  const [pattern, setPattern] = useState('');
  const [step,    setStep]    = useState<SweepStep>('idle');
  const [result,  setResult]  = useState<SweepResult | null>(null);
  const [error,   setError]   = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios
      .get(`${API}/api/admin/users`, { headers })
      .then(res => setUsers(res.data.data))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const trimmed = pattern.trim();
  const matches = trimmed.length >= BULK_MIN_PATTERN_LENGTH
    ? users.filter(u => u.username.toLowerCase().includes(trimmed.toLowerCase()))
    : [];
  const willDelete = matches.filter(u => u.role !== 'admin');

  async function handleSweep() {
    setError('');
    setStep('busy');
    try {
      const res = await axios.post(`${API}/api/admin/users/bulk-delete`, { pattern: trimmed }, { headers });
      setResult(res.data.data);
      setUsers(prev => prev.filter(u => !res.data.data.deleted.includes(u.username)));
      setStep('idle');
      setPattern('');
    } catch (err: unknown) {
      setError(apiError(err, 'Failed to sweep users'));
      setStep('idle');
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Bulk Cleanup</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Deletes every user whose username contains this text (e.g. "verify" for leftover test accounts).
          Admin accounts are always skipped.
        </p>
        <Input
          placeholder={`At least ${BULK_MIN_PATTERN_LENGTH} characters…`}
          value={pattern}
          disabled={step !== 'idle'}
          onChange={e => { setPattern(e.target.value); setResult(null); }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}

        {step === 'idle' && (
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
            disabled={trimmed.length < BULK_MIN_PATTERN_LENGTH}
            onClick={() => setStep('confirm')}
          >
            Preview Sweep
          </Button>
        )}

        {(step === 'confirm' || step === 'busy') && (
          <div className="flex flex-col gap-2">
            {matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No users match "{trimmed}".</p>
            ) : (
              <>
                <p className="text-sm font-semibold text-destructive">
                  This will delete {willDelete.length} account{willDelete.length === 1 ? '' : 's'}:
                </p>
                <ul className="text-xs text-muted-foreground flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                  {matches.map(u => (
                    <li key={u._id}>
                      {u.username}{u.role === 'admin' ? ' — skipped (admin)' : ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" disabled={step === 'busy'} onClick={() => setStep('idle')}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                disabled={step === 'busy' || willDelete.length === 0}
                onClick={handleSweep}
              >
                {step === 'busy' ? 'Sweeping…' : `Confirm Sweep (${willDelete.length})`}
              </Button>
            </div>
          </div>
        )}

        {result && (
          <div className="text-xs text-muted-foreground flex flex-col gap-0.5 border-t pt-2">
            <span>Deleted {result.deleted.length}: {result.deleted.join(', ') || '—'}</span>
            {result.skipped.length > 0 && (
              <span>Skipped {result.skipped.length}: {result.skipped.map(s => `${s.username} (${s.reason})`).join(', ')}</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AdminPage
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { token, user } = useAuth();

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <Link to="/dashboard" className="inline-flex items-center min-h-11 text-sm underline text-muted-foreground">
            ← Dashboard
          </Link>
        </div>

        <UsersCard token={token} currentUserId={user?.id} />
        <PokedexCacheCard token={token} />
        <BulkCleanupCard token={token} />
      </div>
    </div>
  );
}
