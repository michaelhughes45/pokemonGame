import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

// ── Campaign card ─────────────────────────────────────────────────────────────
// Shows the DM's current campaign. If they don't have one yet, shows a create
// form. If they do, shows the player list (with remove buttons) and an invite form.

type CampaignPlayer = { _id: string; username: string };
type PendingInvite  = { userId: string; username: string; sentAt: string };
type CampaignData = {
  _id: string;
  name: string;
  players: CampaignPlayer[];
  pendingInvites: PendingInvite[];
};

function CampaignCard({ token }: { token: string | null }) {
  const [campaign,       setCampaign]       = useState<CampaignData | null>(null);
  const [loading,        setLoading]        = useState(true);
  const [createName,     setCreateName]     = useState('');
  const [createLoading,  setCreateLoading]  = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteLoading,  setInviteLoading]  = useState(false);
  const [feedback,       setFeedback]       = useState('');
  const [error,          setError]          = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  // Fetch the DM's campaign on mount
  useEffect(() => {
    axios
      .get(`${API}/api/campaigns/mine`, { headers })
      .then(res => setCampaign(res.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function clearMessages() { setFeedback(''); setError(''); }

  async function handleCreate(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!createName.trim()) return;
    clearMessages(); setCreateLoading(true);
    try {
      await axios.post(`${API}/api/campaigns`, { name: createName.trim() }, { headers });
      // Re-fetch so we get the full campaign object with the new _id
      const res = await axios.get(`${API}/api/campaigns/mine`, { headers });
      setCampaign(res.data.data);
      setCreateName('');
      setFeedback('Campaign created.');
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to create campaign') : 'Failed to create campaign');
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleInvite(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!inviteUsername.trim()) return;
    clearMessages(); setInviteLoading(true);
    try {
      await axios.post(`${API}/api/campaigns/invite`, { username: inviteUsername.trim() }, { headers });
      // Re-fetch to show updated pending invites list
      const res = await axios.get(`${API}/api/campaigns/mine`, { headers });
      setCampaign(res.data.data);
      setInviteUsername('');
      setFeedback(`Invite sent to ${inviteUsername.trim()}.`);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to send invite') : 'Failed to send invite');
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleRemove(username: string) {
    clearMessages();
    try {
      await axios.delete(`${API}/api/campaigns/players/${encodeURIComponent(username)}`, { headers });
      const res = await axios.get(`${API}/api/campaigns/mine`, { headers });
      setCampaign(res.data.data);
      setFeedback(`Removed ${username} from campaign.`);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to remove player') : 'Failed to remove player');
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle>Campaign</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading…</p></CardContent>
      </Card>
    );
  }

  // No campaign yet — show the create form
  if (!campaign) {
    return (
      <Card>
        <CardHeader><CardTitle>Campaign</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            You don't have a campaign yet. Create one to start inviting players.
          </p>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input
                id="campaign-name"
                placeholder="e.g. Kanto Adventure"
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                required
              />
            </div>
            {error    && <p className="text-sm text-destructive">{error}</p>}
            {feedback && <p className="text-sm text-muted-foreground">{feedback}</p>}
            <Button type="submit" disabled={createLoading} className="min-h-11">
              {createLoading ? 'Creating…' : 'Create campaign'}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // Has a campaign — show players, pending invites, and invite form
  return (
    <Card>
      <CardHeader>
        <CardTitle>{campaign.name}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">

        {/* Player list */}
        <div>
          <p className="text-sm font-medium mb-2">Players ({campaign.players.length})</p>
          {campaign.players.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {campaign.players.map(p => (
                <li key={p._id} className="flex items-center justify-between text-sm">
                  <span>{p.username}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive min-h-9"
                    onClick={() => handleRemove(p.username)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Pending invites */}
        {campaign.pendingInvites.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Pending invites</p>
            <ul className="flex flex-col gap-1">
              {campaign.pendingInvites.map(i => (
                <li key={i.userId} className="text-sm text-muted-foreground">
                  {i.username} — awaiting response
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Invite form */}
        <form onSubmit={handleInvite} className="flex flex-col gap-3">
          <p className="text-sm font-medium">Invite a player</p>
          <div className="flex gap-2">
            <Input
              placeholder="Player username"
              value={inviteUsername}
              onChange={e => setInviteUsername(e.target.value)}
              required
              className="flex-1"
            />
            <Button type="submit" disabled={inviteLoading} className="min-h-11 shrink-0">
              {inviteLoading ? 'Sending…' : 'Invite'}
            </Button>
          </div>
        </form>

        {error    && <p className="text-sm text-destructive">{error}</p>}
        {feedback && <p className="text-sm text-muted-foreground">{feedback}</p>}

      </CardContent>
    </Card>
  );
}

const NATURES = [
  'Hardy','Lonely','Brave','Adamant','Naughty',
  'Bold','Relaxed','Impish','Lax',
  'Timid','Hasty','Jolly','Naive',
  'Modest','Mild','Quiet','Rash',
  'Calm','Gentle','Sassy','Careful',
  'Docile','Serious','Bashful','Quirky',
];

// Tailwind classes shared across all native <select> elements on this page
const selectClass = 'w-full border border-input bg-background rounded-md px-3 py-2 text-sm min-h-11 focus:outline-none focus:ring-2 focus:ring-ring';

// ── Reset starter card ───────────────────────────────────────────────────────

function ResetStarterCard({ token }: { token: string | null }) {
  const [username, setUsername] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState('');
  const [error,    setError]    = useState('');

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!username.trim()) return;
    setResult(''); setError(''); setLoading(true);
    try {
      const res = await axios.delete(
        `${API}/api/dm/players/${encodeURIComponent(username.trim())}/starter`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { deleted } = res.data.data;
      setResult(
        deleted === 0
          ? `${username} had no Pokémon — they can now pick a starter.`
          : `Reset complete. Removed ${deleted} Pokémon from ${username}.`
      );
      setUsername('');
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Reset failed') : 'Reset failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Reset Player Starter</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-username">Player username</Label>
            <Input
              id="reset-username"
              placeholder="e.g. ash"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>
          {error  && <p className="text-sm text-destructive">{error}</p>}
          {result && <p className="text-sm text-muted-foreground">{result}</p>}
          <Button type="submit" disabled={loading} className="min-h-11">
            {loading ? 'Resetting…' : 'Reset starter'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Give Pokémon card ────────────────────────────────────────────────────────

function GivePokemonCard({ token }: { token: string | null }) {
  const [username,  setUsername]  = useState('');
  const [species, setSpecies] = useState('');
  const [level,     setLevel]     = useState('5');
  const [nature,    setNature]    = useState('Hardy');
  const [gender,    setGender]    = useState('auto');
  const [loading,   setLoading]   = useState(false);
  const [result,    setResult]    = useState('');
  const [error,     setError]     = useState('');

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setResult(''); setError(''); setLoading(true);

    // Build the request body — only include gender if the DM picked a specific value
    const body: Record<string, unknown> = {
      species: species.trim(),
      level:   Number(level),
      nature,
    };
    if (gender !== 'auto') body.gender = gender;

    try {
      const res = await axios.post(
        `${API}/api/dm/players/${encodeURIComponent(username.trim())}/pokemon`,
        body,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const p = res.data.data;
      setResult(
        `Gave ${p.speciesName ?? `#${p.speciesId}`} (Lv. ${p.level}, ${p.nature}) to ${username}. ` +
        (p.isInParty ? `Added to party slot ${p.partySlot}.` : 'Sent to PC (party was full).')
      );
      setSpecies('');
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to give Pokémon') : 'Failed to give Pokémon');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Give Pokémon to Player</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="give-username">Player username</Label>
            <Input
              id="give-username"
              placeholder="e.g. ash"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="give-species">
              Species{' '}
              <span className="text-muted-foreground font-normal">(name or dex number — e.g. "pikachu" or 25)</span>
            </Label>
            <Input
              id="give-species"
              placeholder="e.g. pikachu or 25"
              value={species}
              onChange={e => setSpecies(e.target.value)}
              required
            />
          </div>

          {/* Level and Nature sit side-by-side on wider screens */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="give-level">Level</Label>
              <Input
                id="give-level"
                type="number"
                min={1}
                max={100}
                value={level}
                onChange={e => setLevel(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="give-nature">Nature</Label>
              {/*
                Native <select> — no shadcn component needed.
                selectClass applies the same border/background/radius
                as shadcn Input so it visually matches the other fields.
              */}
              <select
                id="give-nature"
                value={nature}
                onChange={e => setNature(e.target.value)}
                className={selectClass}
              >
                {NATURES.map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="give-gender">Gender</Label>
            <select
              id="give-gender"
              value={gender}
              onChange={e => setGender(e.target.value)}
              className={selectClass}
            >
              <option value="auto">Auto (derive from species)</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="none">None (genderless)</option>
            </select>
          </div>

          {error  && <p className="text-sm text-destructive">{error}</p>}
          {result && <p className="text-sm text-muted-foreground">{result}</p>}

          <Button type="submit" disabled={loading || !username.trim() || !species.trim()} className="min-h-11">
            {loading ? 'Giving…' : 'Give Pokémon'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Give Item card ───────────────────────────────────────────────────────────

function GiveItemCard({ token }: { token: string | null }) {
  const [username, setUsername] = useState('');
  const [itemId,   setItemId]   = useState('');
  const [quantity, setQuantity] = useState('1');
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState('');
  const [error,    setError]    = useState('');

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setResult(''); setError(''); setLoading(true);
    try {
      const res = await axios.post(
        `${API}/api/dm/items/give`,
        {
          username: username.trim(),
          itemId:   itemId.trim(),
          quantity: Number(quantity),
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = res.data.data;
      setResult(`Gave ×${quantity} ${d.itemId} to ${d.username}. They now have ×${d.quantity}.`);
      setItemId('');
      setQuantity('1');
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to give item') : 'Failed to give item');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Give Item to Player</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="item-username">Player username</Label>
            <Input
              id="item-username"
              placeholder="e.g. ash"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="item-id">
              Item ID{' '}
              <span className="text-muted-foreground font-normal">(PokeAPI slug — e.g. super-potion, poke-ball)</span>
            </Label>
            <Input
              id="item-id"
              placeholder="e.g. super-potion"
              value={itemId}
              onChange={e => setItemId(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="item-quantity">Quantity</Label>
            <Input
              id="item-quantity"
              type="number"
              min={1}
              max={99}
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              required
            />
          </div>

          {error  && <p className="text-sm text-destructive">{error}</p>}
          {result && <p className="text-sm text-muted-foreground">{result}</p>}

          <Button
            type="submit"
            disabled={loading || !username.trim() || !itemId.trim()}
            className="min-h-11"
          >
            {loading ? 'Giving…' : 'Give Item'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── NPC card ─────────────────────────────────────────────────────────────────
// Lists the DM's NPCs, lets them create new ones, and gives Pokémon to each.

type NpcSummary = { _id: string; name: string; type: string; partyCount: number };

function NpcCard({ token }: { token: string | null }) {
  const [npcs,         setNpcs]         = useState<NpcSummary[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [newName,      setNewName]      = useState('');
  const [newType,      setNewType]      = useState<'trainer' | 'wild'>('trainer');
  const [creating,     setCreating]     = useState(false);
  const [createError,  setCreateError]  = useState('');
  // Which NPC's give-pokemon form is expanded
  const [expandedNpc,  setExpandedNpc]  = useState<string | null>(null);
  // Give-pokemon form fields (shared across all NPCs — only one open at a time)
  const [gpSpecies,    setGpSpecies]    = useState('');
  const [gpLevel,      setGpLevel]      = useState('5');
  const [gpNature,     setGpNature]     = useState('Hardy');
  const [gpGender,     setGpGender]     = useState('auto');
  const [gpLoading,    setGpLoading]    = useState(false);
  const [gpResult,     setGpResult]     = useState('');
  const [gpError,      setGpError]      = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios.get(`${API}/api/dm/npcs`, { headers })
      .then(res => setNpcs(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleCreate(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateError(''); setCreating(true);
    try {
      const res = await axios.post(`${API}/api/dm/npcs`, { name: newName.trim(), type: newType }, { headers });
      setNpcs(prev => [...prev, res.data.data]);
      setNewName('');
    } catch (err: unknown) {
      setCreateError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to create NPC') : 'Failed to create NPC');
    } finally {
      setCreating(false);
    }
  }

  function openGivePokemon(npcId: string) {
    setExpandedNpc(npcId);
    setGpSpecies(''); setGpLevel('5'); setGpNature('Hardy'); setGpGender('auto');
    setGpResult(''); setGpError('');
  }

  async function handleGivePokemon(npcId: string) {
    if (!gpSpecies.trim()) return;
    setGpLoading(true); setGpResult(''); setGpError('');
    const body: Record<string, unknown> = { species: gpSpecies.trim(), level: Number(gpLevel), nature: gpNature };
    if (gpGender !== 'auto') body.gender = gpGender;
    try {
      const res = await axios.post(`${API}/api/dm/npcs/${npcId}/pokemon`, body, { headers });
      const p = res.data.data;
      setGpResult(`Added ${p.speciesName ?? `#${p.speciesId}`} (Lv. ${p.level}, ${p.nature}).`);
      setGpSpecies('');
      setNpcs(prev => prev.map(n => n._id === npcId ? { ...n, partyCount: n.partyCount + 1 } : n));
    } catch (err: unknown) {
      setGpError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to add Pokémon') : 'Failed to add Pokémon');
    } finally {
      setGpLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>NPCs</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-5">

        {/* NPC list */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : npcs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No NPCs yet — create one below.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {npcs.map(npc => (
              <li key={npc._id} className="flex flex-col gap-2 border rounded-md p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{npc.name}</span>
                  <span className="text-muted-foreground text-xs capitalize">
                    {npc.type} · {npc.partyCount} Pokémon
                  </span>
                </div>
                {expandedNpc === npc._id ? (
                  <div className="flex flex-col gap-3 pt-1">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`gp-species-${npc._id}`}>Species</Label>
                      <Input
                        id={`gp-species-${npc._id}`}
                        placeholder="e.g. gengar or 94"
                        value={gpSpecies}
                        onChange={e => setGpSpecies(e.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <Label>Level</Label>
                        <Input type="number" min={1} max={100} value={gpLevel} onChange={e => setGpLevel(e.target.value)} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label>Nature</Label>
                        <select value={gpNature} onChange={e => setGpNature(e.target.value)} className={selectClass}>
                          {NATURES.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label>Gender</Label>
                      <select value={gpGender} onChange={e => setGpGender(e.target.value)} className={selectClass}>
                        <option value="auto">Auto</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="none">Genderless</option>
                      </select>
                    </div>
                    {gpError  && <p className="text-sm text-destructive">{gpError}</p>}
                    {gpResult && <p className="text-sm text-muted-foreground">{gpResult}</p>}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleGivePokemon(npc._id)}
                        disabled={gpLoading || !gpSpecies.trim()}
                        className="flex-1 min-h-11"
                      >
                        {gpLoading ? 'Adding…' : 'Add Pokémon'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setExpandedNpc(null)}
                        className="min-h-11"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openGivePokemon(npc._id)}
                    className="w-full min-h-9"
                  >
                    + Add Pokémon
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Create NPC form */}
        <form onSubmit={handleCreate} className="flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">Create NPC</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="npc-name">Name</Label>
            <Input
              id="npc-name"
              placeholder="e.g. Rival Gary"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="npc-type">Type</Label>
            <select
              id="npc-type"
              value={newType}
              onChange={e => setNewType(e.target.value as 'trainer' | 'wild')}
              className={selectClass}
            >
              <option value="trainer">Trainer</option>
              <option value="wild">Wild</option>
            </select>
          </div>
          {createError && <p className="text-sm text-destructive">{createError}</p>}
          <Button type="submit" disabled={creating || !newName.trim()} className="min-h-11">
            {creating ? 'Creating…' : 'Create NPC'}
          </Button>
        </form>

      </CardContent>
    </Card>
  );
}

// ── NPC Party Manager card ───────────────────────────────────────────────────
// Lets the DM browse any NPC's Pokémon party and jump to the detail page for
// each one (move reminder, evolution override, etc.).

type NpcPartyPokemon = {
  _id: string;
  speciesId: number;
  speciesName: string;
  nickname: string | null;
  level: number;
  currentHp: number;
};

function NpcPartyManagerCard({ token }: { token: string | null }) {
  const [npcs,        setNpcs]        = useState<NpcSummary[]>([]);
  const [loaded,      setLoaded]      = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [selectedNpc, setSelectedNpc] = useState<string>('');
  const [party,       setParty]       = useState<NpcPartyPokemon[]>([]);
  const [partyLoading,setPartyLoading]= useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  async function loadNpcs() {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/api/dm/npcs`, { headers });
      setNpcs(res.data.data ?? []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadParty(npcId: string) {
    setSelectedNpc(npcId);
    setParty([]);
    if (!npcId) return;
    setPartyLoading(true);
    try {
      const res = await axios.get(`${API}/api/dm/npcs/${npcId}/party`, { headers });
      setParty(res.data.data ?? []);
    } catch {
      setParty([]);
    } finally {
      setPartyLoading(false);
    }
  }

  const selectedNpcName = npcs.find(n => n._id === selectedNpc)?.name ?? '';

  return (
    <Card>
      <CardHeader><CardTitle>NPC Party Manager</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!loaded ? (
          <Button variant="outline" onClick={loadNpcs} disabled={loading} className="min-h-11">
            {loading ? 'Loading…' : 'Load NPCs'}
          </Button>
        ) : npcs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No NPCs in your campaign yet.</p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <select
                value={selectedNpc}
                onChange={e => loadParty(e.target.value)}
                className={selectClass}
              >
                <option value="">— Select an NPC —</option>
                {npcs.map(n => (
                  <option key={n._id} value={n._id}>
                    {n.name} ({n.partyCount} Pokémon)
                  </option>
                ))}
              </select>
            </div>

            {selectedNpc && (
              partyLoading ? (
                <p className="text-sm text-muted-foreground">Loading party…</p>
              ) : party.length === 0 ? (
                <p className="text-sm text-muted-foreground">{selectedNpcName} has no Pokémon yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {party.map(poke => (
                    <li key={poke._id}>
                      <Link
                        to={`/pokemon/${poke._id}`}
                        className="flex items-center justify-between border rounded-md p-3 hover:bg-muted transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${poke.speciesId}.png`}
                            alt={poke.speciesName}
                            width={40}
                            height={40}
                            className="pixelated"
                          />
                          <div>
                            <p className="text-sm font-medium">
                              {poke.nickname
                                ? `${poke.nickname} (${poke.speciesName})`
                                : poke.speciesName}
                            </p>
                            <p className="text-xs text-muted-foreground">Lv. {poke.level}</p>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {poke.currentHp} HP →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Active Battles card ──────────────────────────────────────────────────────
// Shows the DM all non-complete battles for their campaign so they can
// navigate back into any open battle after leaving the page.

type DmBattle = {
  _id: string;
  type: 'pve' | 'wild' | 'pvp';
  status: 'waiting' | 'active';
  turnNumber: number;
};

const TYPE_LABELS: Record<string, string> = { pve: 'PvE', wild: 'Wild', pvp: 'PvP' };

function ActiveBattlesCard({ token }: { token: string | null }) {
  const [battles,    setBattles]    = useState<DmBattle[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios
      .get(`${API}/api/battles/dm`, { headers })
      .then(res => setBattles(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await axios.delete(`${API}/api/battles/${id}`, { headers });
      setBattles(prev => prev.filter(b => b._id !== id));
    } catch { /* silently ignore — battle stays in list */ }
    finally { setDeletingId(null); }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle>Active Battles</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading…</p></CardContent>
      </Card>
    );
  }

  if (battles.length === 0) return null;

  return (
    <Card>
      <CardHeader><CardTitle>Active Battles</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {battles.map(b => (
          <div key={b._id} className="flex items-center gap-2">
            <Link to={`/battle/${b._id}`} className="flex-1">
              <div className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted/50 transition-colors cursor-pointer min-h-11">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{TYPE_LABELS[b.type] ?? b.type} Battle</span>
                  <span className="text-xs text-muted-foreground">
                    {b.status === 'waiting' ? 'Waiting to start' : `Turn ${b.turnNumber}`}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">Enter →</span>
              </div>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive shrink-0 min-h-11"
              onClick={() => handleDelete(b._id)}
              disabled={deletingId === b._id}
            >
              {deletingId === b._id ? '…' : 'Delete'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Create Battle card ───────────────────────────────────────────────────────
// Loads the DM's campaign players, lets the DM check which ones join,
// pick a battle type, and optionally set a per-player Pokémon limit.
// On submit it POSTs to /api/battles and navigates to /battle/:id.

type CampaignPlayerBasic = { _id: string; username: string };

function CreateBattleCard({ token }: { token: string | null }) {
  const navigate = useNavigate();

  const [players,        setPlayers]        = useState<CampaignPlayerBasic[]>([]);
  const [npcs,           setNpcs]           = useState<NpcSummary[]>([]);
  const [loadingData,    setLoadingData]    = useState(true);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [selectedNpcs,   setSelectedNpcs]   = useState<Set<string>>(new Set());
  const [battleType,     setBattleType]     = useState<'pve' | 'wild' | 'pvp'>('pve');
  const [limit,          setLimit]          = useState('');
  const [loading,        setLoading]        = useState(false);
  const [error,          setError]          = useState('');

  // Wild battle state
  const [wildSpeciesId,      setWildSpeciesId]      = useState<number | null>(null);
  const [wildSpeciesName,    setWildSpeciesName]    = useState('');
  const [wildLevel,          setWildLevel]          = useState('');
  const [speciesQuery,       setSpeciesQuery]       = useState('');
  const [speciesLookupLoading, setSpeciesLookupLoading] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/campaigns/mine`, { headers }),
      axios.get(`${API}/api/dm/npcs`, { headers }),
    ])
      .then(([campaignRes, npcsRes]) => {
        setPlayers(campaignRes.data.data?.players ?? []);
        setNpcs(npcsRes.data.data ?? []);
      })
      .catch(() => {})
      .finally(() => setLoadingData(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function togglePlayer(id: string) {
    setSelectedPlayers(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleNpc(id: string) {
    setSelectedNpcs(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  async function handleSpeciesLookup() {
    if (!speciesQuery.trim()) return;
    setSpeciesLookupLoading(true);
    setError('');
    try {
      const res = await axios.get(`${API}/api/pokedex/${speciesQuery.trim().toLowerCase()}`, { headers });
      const s = res.data.data;
      setWildSpeciesId(s.pokeApiId);
      setWildSpeciesName(s.name);
      setSpeciesQuery('');
    } catch {
      setError(`Species "${speciesQuery}" not found.`);
    } finally {
      setSpeciesLookupLoading(false);
    }
  }

  async function handleRandomize() {
    setSpeciesLookupLoading(true);
    setError('');
    try {
      const randomId = Math.floor(Math.random() * 1025) + 1;
      const res = await axios.get(`${API}/api/pokedex/${randomId}`, { headers });
      const s = res.data.data;
      setWildSpeciesId(s.pokeApiId);
      setWildSpeciesName(s.name);
    } catch {
      setError('Failed to randomize species.');
    } finally {
      setSpeciesLookupLoading(false);
    }
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setError('');
    if (selectedPlayers.size === 0) {
      setError('Select at least one player.');
      return;
    }
    if (battleType === 'wild') {
      if (!wildSpeciesId) { setError('Look up or randomize a wild Pokémon species first.'); return; }
      const lvl = Number(wildLevel);
      if (!wildLevel.trim() || !Number.isInteger(lvl) || lvl < 1 || lvl > 100) {
        setError('Enter a valid level (1–100).');
        return;
      }
    }
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        type:      battleType,
        playerIds: Array.from(selectedPlayers),
        npcIds:    battleType === 'wild' ? [] : Array.from(selectedNpcs),
      };
      if (limit.trim() !== '') body.playerPokemonLimit = Number(limit);
      if (battleType === 'wild') {
        body.wildPokemon = { speciesId: wildSpeciesId, level: Number(wildLevel) };
      }

      const res = await axios.post(`${API}/api/battles`, body, { headers });
      navigate(`/battle/${res.data.data._id}`);
    } catch (err: unknown) {
      setError(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? 'Failed to create battle')
          : 'Failed to create battle'
      );
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Create Battle</CardTitle></CardHeader>
      <CardContent>
        {loadingData ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : players.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No players in your campaign yet. Invite some players first.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">

            {/* Player checkboxes */}
            <div className="flex flex-col gap-1.5">
              <Label>Players</Label>
              <div className="flex flex-col gap-2">
                {players.map(p => (
                  <label key={p._id} className="flex items-center gap-2 text-sm cursor-pointer min-h-11">
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
            </div>

            {/* NPC checkboxes (PvE) or wild Pokémon picker */}
            {battleType === 'wild' ? (
              <div className="flex flex-col gap-3">
                <Label>Wild Pokémon</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Species name (e.g. pikachu)"
                    value={speciesQuery}
                    onChange={e => setSpeciesQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSpeciesLookup(); } }}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSpeciesLookup}
                    disabled={speciesLookupLoading || !speciesQuery.trim()}
                    className="min-h-11"
                  >
                    Look up
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRandomize}
                    disabled={speciesLookupLoading}
                    className="min-h-11"
                  >
                    Random
                  </Button>
                </div>
                {wildSpeciesId && (
                  <p className="text-sm text-muted-foreground">
                    Selected:{' '}
                    <span className="capitalize font-medium text-foreground">{wildSpeciesName}</span>
                    {' '}(#{wildSpeciesId})
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="wild-level">Level</Label>
                  <Input
                    id="wild-level"
                    type="number"
                    min={1}
                    max={100}
                    placeholder="e.g. 10"
                    value={wildLevel}
                    onChange={e => setWildLevel(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              npcs.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label>NPCs</Label>
                  <div className="flex flex-col gap-2">
                    {npcs.map(n => (
                      <label key={n._id} className="flex items-center gap-2 text-sm cursor-pointer min-h-11">
                        <input
                          type="checkbox"
                          checked={selectedNpcs.has(n._id)}
                          onChange={() => toggleNpc(n._id)}
                          className="h-4 w-4"
                        />
                        <span>{n.name}</span>
                        <span className="text-muted-foreground text-xs">({n.partyCount} Pokémon)</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            )}

            {/* Battle type */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="battle-type">Battle type</Label>
              <select
                id="battle-type"
                value={battleType}
                onChange={e => setBattleType(e.target.value as 'pve' | 'wild' | 'pvp')}
                className={selectClass}
              >
                <option value="pve">PvE (players vs trainer NPC)</option>
                <option value="wild">Wild (players vs wild Pokémon)</option>
                <option value="pvp">PvP (players vs players)</option>
              </select>
            </div>

            {/* Optional per-player Pokémon limit */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="battle-limit">
                Pokémon limit per player{' '}
                <span className="text-muted-foreground font-normal">(optional — blank = no limit)</span>
              </Label>
              <Input
                id="battle-limit"
                type="number"
                min={1}
                max={6}
                placeholder="e.g. 3"
                value={limit}
                onChange={e => setLimit(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              disabled={loading || selectedPlayers.size === 0}
              className="min-h-11"
            >
              {loading ? 'Creating…' : 'Create Battle'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ── DmPage ───────────────────────────────────────────────────────────────────

export default function DmPage() {
  const { token } = useAuth();

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">DM Panel</h1>
          <Link to="/dashboard" className="text-sm underline text-muted-foreground">
            ← Dashboard
          </Link>
        </div>

        <CampaignCard token={token} />
        <ActiveBattlesCard token={token} />
        <NpcCard token={token} />
        <NpcPartyManagerCard token={token} />
        <CreateBattleCard token={token} />
        <GivePokemonCard token={token} />
        <GiveItemCard token={token} />
        <ResetStarterCard token={token} />
      </div>
    </div>
  );
}
