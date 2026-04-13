import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

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

        <GivePokemonCard token={token} />
        <ResetStarterCard token={token} />
      </div>
    </div>
  );
}
