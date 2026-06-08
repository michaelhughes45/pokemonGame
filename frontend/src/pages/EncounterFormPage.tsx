import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

// Matches the native <select> style used throughout DmPage
const selectClass =
  'w-full border border-input bg-background rounded-md px-3 py-2 text-sm min-h-11 ' +
  'focus:outline-none focus:ring-2 focus:ring-ring';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NpcSummary = { _id: string; name: string; partyCount: number };

// One row in the wild Pokémon list
type WildEntry = {
  speciesId:   number | null;
  speciesName: string;   // display only — derived from lookup, not sent to backend
  level:       string;   // kept as string so the input is controlled without coercion
  catchable:   boolean;
};

function apiError(err: unknown, fallback: string) {
  return axios.isAxiosError(err)
    ? (err.response?.data?.error ?? fallback)
    : fallback;
}

// ---------------------------------------------------------------------------
// WildEntryRow
// Self-contained component for one wild Pokémon slot.  Manages its own
// species-lookup state; reports data changes up via onChange.
// ---------------------------------------------------------------------------

type WildEntryRowProps = {
  entry:    WildEntry;
  index:    number;
  headers:  { Authorization: string };
  onChange: (index: number, updated: WildEntry) => void;
  onRemove: (index: number) => void;
};

function WildEntryRow({ entry, index, headers, onChange, onRemove }: WildEntryRowProps) {
  const [query,         setQuery]         = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError,   setLookupError]   = useState('');

  async function handleLookup() {
    if (!query.trim()) return;
    setLookupLoading(true);
    setLookupError('');
    try {
      const res = await axios.get(
        `${API}/api/pokedex/${encodeURIComponent(query.trim().toLowerCase())}`,
        { headers },
      );
      const s = res.data.data;
      onChange(index, { ...entry, speciesId: s.pokeApiId, speciesName: s.name });
      setQuery('');
    } catch {
      setLookupError(`"${query}" not found.`);
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleRandom() {
    setLookupLoading(true);
    setLookupError('');
    try {
      const randomId = Math.floor(Math.random() * 1025) + 1;
      const res = await axios.get(`${API}/api/pokedex/${randomId}`, { headers });
      const s = res.data.data;
      onChange(index, { ...entry, speciesId: s.pokeApiId, speciesName: s.name });
    } catch {
      setLookupError('Failed to randomize.');
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <div className="border rounded-md p-3 flex flex-col gap-3">

      {/* Species header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {entry.speciesId ? (
            <span className="capitalize">{entry.speciesName} (#{entry.speciesId})</span>
          ) : (
            <span className="text-muted-foreground">No species selected</span>
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive min-h-9 shrink-0"
          onClick={() => onRemove(index)}
        >
          Remove
        </Button>
      </div>

      {/* Species lookup */}
      <div className="flex gap-2">
        <Input
          placeholder="Name or dex number (e.g. pikachu, 25)"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleLookup(); } }}
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleLookup}
          disabled={lookupLoading || !query.trim()}
          className="min-h-11 shrink-0"
        >
          Look up
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRandom}
          disabled={lookupLoading}
          className="min-h-11 shrink-0"
        >
          Random
        </Button>
      </div>
      {lookupError && <p className="text-xs text-destructive">{lookupError}</p>}

      {/* Level + catchable */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Level</Label>
          <Input
            type="number"
            min={1}
            max={100}
            placeholder="e.g. 15"
            value={entry.level}
            onChange={e => onChange(index, { ...entry, level: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Catchable</Label>
          <label className="flex items-center gap-2 text-sm cursor-pointer min-h-11">
            <input
              type="checkbox"
              checked={entry.catchable}
              onChange={e => onChange(index, { ...entry, catchable: e.target.checked })}
              className="h-4 w-4"
            />
            Players can catch
          </label>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// EncounterFormPage
// Serves both /dm/encounters/new and /dm/encounters/:id/edit.
// Detects mode from useParams — if id is present, loads existing data.
// ---------------------------------------------------------------------------

export default function EncounterFormPage() {
  const { id }     = useParams<{ id: string }>();
  const isEdit     = Boolean(id);
  const navigate   = useNavigate();
  const { token }  = useAuth();
  const headers    = { Authorization: `Bearer ${token}` };

  // ── Page-level load state ──────────────────────────────────────────────
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError,   setPageError]   = useState('');

  // ── Form fields ────────────────────────────────────────────────────────
  const [title,              setTitle]              = useState('');
  const [type,               setType]               = useState<'pve' | 'wild'>('pve');
  // Map of npcId → slotCount (null = auto-match player count at launch)
  const [npcSlotCounts, setNpcSlotCounts] = useState<Map<string, number | null>>(new Map());
  const [wildEntries,        setWildEntries]        = useState<WildEntry[]>([]);
  const [playerPokemonLimit, setPlayerPokemonLimit] = useState('');
  const [npcPokemonLimit,    setNpcPokemonLimit]    = useState('');
  const [expMultiplier,      setExpMultiplier]      = useState('1');
  const [notes,              setNotes]              = useState('');
  const [isActive,           setIsActive]           = useState(true);

  // NPC list — loaded once and used for the PvE checkbox picker
  const [npcs, setNpcs] = useState<NpcSummary[]>([]);

  // ── Submit state ───────────────────────────────────────────────────────
  const [submitting,   setSubmitting]   = useState(false);
  const [submitError,  setSubmitError]  = useState('');

  // ── Load on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const npcsRes = await axios.get(`${API}/api/dm/npcs`, { headers });
        setNpcs(npcsRes.data.data ?? []);

        if (isEdit) {
          const encRes = await axios.get(`${API}/api/dm/encounters/${id}`, { headers });
          const enc    = encRes.data.data;

          setTitle(enc.title);
          setType(enc.type);
          setIsActive(enc.isActive);
          setNotes(enc.notes ?? '');
          setExpMultiplier(String(enc.expMultiplier ?? 1));
          setPlayerPokemonLimit(enc.playerPokemonLimit !== null ? String(enc.playerPokemonLimit) : '');
          setNpcPokemonLimit(enc.npcPokemonLimit !== null ? String(enc.npcPokemonLimit) : '');

          if (enc.type === 'pve') {
            const map = new Map<string, number | null>();
            (enc.enemies as Array<{ npcId: string; slotCount?: number | null }>).forEach(e => {
              map.set(e.npcId, e.slotCount ?? null);
            });
            setNpcSlotCounts(map);
          }

          if (enc.type === 'wild' && Array.isArray(enc.wildPokemon) && enc.wildPokemon.length > 0) {
            // Resolve species names for existing entries so they display correctly.
            // Each request is independent — failures fall back to "#speciesId".
            const entries: WildEntry[] = await Promise.all(
              (enc.wildPokemon as Array<{ speciesId: number; level: number; catchable: boolean }>)
                .map(async wp => {
                  try {
                    const res = await axios.get(`${API}/api/pokedex/${wp.speciesId}`, { headers });
                    return {
                      speciesId:   wp.speciesId,
                      speciesName: (res.data.data?.name as string) ?? `#${wp.speciesId}`,
                      level:       String(wp.level),
                      catchable:   wp.catchable,
                    };
                  } catch {
                    return {
                      speciesId:   wp.speciesId,
                      speciesName: `#${wp.speciesId}`,
                      level:       String(wp.level),
                      catchable:   wp.catchable,
                    };
                  }
                }),
            );
            setWildEntries(entries);
          }
        }
      } catch (err) {
        setPageError(apiError(err, 'Failed to load encounter data'));
      } finally {
        setPageLoading(false);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── NPC toggle + slot count ────────────────────────────────────────────
  function toggleNpc(npcId: string) {
    setNpcSlotCounts(prev => {
      const next = new Map(prev);
      if (next.has(npcId)) { next.delete(npcId); } else { next.set(npcId, null); }
      return next;
    });
  }

  function setNpcSlotCount(npcId: string, value: number | null) {
    setNpcSlotCounts(prev => new Map(prev).set(npcId, value));
  }

  // ── Wild entry helpers ─────────────────────────────────────────────────
  function addWildEntry() {
    setWildEntries(prev => [
      ...prev,
      { speciesId: null, speciesName: '', level: '', catchable: true },
    ]);
  }

  function updateWildEntry(index: number, updated: WildEntry) {
    setWildEntries(prev => prev.map((e, i) => (i === index ? updated : e)));
  }

  function removeWildEntry(index: number) {
    setWildEntries(prev => prev.filter((_, i) => i !== index));
  }

  // ── Submit ─────────────────────────────────────────────────────────────
  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault();
    setSubmitError('');

    if (!title.trim()) {
      setSubmitError('Title is required.');
      return;
    }
    if (type === 'pve' && npcSlotCounts.size === 0) {
      setSubmitError('Select at least one NPC for a PvE encounter.');
      return;
    }
    if (type === 'wild') {
      if (wildEntries.length === 0) {
        setSubmitError('Add at least one wild Pokémon.');
        return;
      }
      for (const wp of wildEntries) {
        if (!wp.speciesId) {
          setSubmitError('Look up a species for every wild Pokémon entry.');
          return;
        }
        const lvl = Number(wp.level);
        if (!wp.level.trim() || !Number.isInteger(lvl) || lvl < 1 || lvl > 100) {
          setSubmitError('Each wild Pokémon needs a valid level (1–100).');
          return;
        }
      }
    }

    const body: Record<string, unknown> = {
      title:              title.trim(),
      type,
      isActive,
      notes,
      expMultiplier:      Number(expMultiplier) || 1,
      playerPokemonLimit: playerPokemonLimit.trim() !== '' ? Number(playerPokemonLimit) : null,
      npcPokemonLimit:    npcPokemonLimit.trim()    !== '' ? Number(npcPokemonLimit)    : null,
    };

    if (type === 'pve') {
      body.enemies = Array.from(npcSlotCounts.entries()).map(([npcId, slotCount]) => ({
        npcId,
        ...(slotCount !== null ? { slotCount } : {}),
      }));
    } else {
      body.wildPokemon = wildEntries.map(wp => ({
        speciesId: wp.speciesId,
        level:     Number(wp.level),
        catchable: wp.catchable,
      }));
    }

    setSubmitting(true);
    try {
      if (isEdit) {
        await axios.put(`${API}/api/dm/encounters/${id}`, body, { headers });
      } else {
        await axios.post(`${API}/api/dm/encounters`, body, { headers });
      }
      navigate('/dm/encounters');
    } catch (err) {
      setSubmitError(apiError(err, 'Failed to save encounter'));
    } finally {
      setSubmitting(false);
    }
  }

  // ── Loading / error screens ────────────────────────────────────────────
  if (pageLoading) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="max-w-lg mx-auto">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="max-w-lg mx-auto flex flex-col gap-4">
          <p className="text-sm text-destructive">{pageError}</p>
          <Link to="/dm/encounters" className="text-sm underline">← Back to encounters</Link>
        </div>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">
            {isEdit ? 'Edit Encounter' : 'New Encounter'}
          </h1>
          <Link to="/dm/encounters" className="text-sm underline text-muted-foreground">
            ← Encounters
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{isEdit ? 'Edit details' : 'Encounter details'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">

              {/* Title ─────────────────────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enc-title">Title</Label>
                <Input
                  id="enc-title"
                  placeholder="e.g. Brock's Gym, Route 1 Grass"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  required
                />
              </div>

              {/* Type ──────────────────────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enc-type">Type</Label>
                <select
                  id="enc-type"
                  value={type}
                  onChange={e => setType(e.target.value as 'pve' | 'wild')}
                  className={selectClass}
                >
                  <option value="pve">PvE — players vs trainer NPC</option>
                  <option value="wild">Wild — players vs wild Pokémon</option>
                </select>
              </div>

              {/* ── PvE: NPC checkboxes ──────────────────────────────── */}
              {type === 'pve' && (
                <div className="flex flex-col gap-1.5">
                  <Label>NPCs in this encounter</Label>
                  {npcs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No NPCs in your campaign yet.{' '}
                      <Link to="/dm" className="underline">Create one on the DM panel.</Link>
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3 border rounded-md p-3">
                      {npcs.map(npc => {
                        const isChecked  = npcSlotCounts.has(npc._id);
                        const slotValue  = npcSlotCounts.get(npc._id) ?? null;
                        return (
                          <div key={npc._id} className="flex flex-col gap-1.5">
                            <label className="flex items-center gap-2 text-sm cursor-pointer min-h-9">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleNpc(npc._id)}
                                className="h-4 w-4"
                              />
                              <span>{npc.name}</span>
                              <span className="text-muted-foreground text-xs">
                                ({npc.partyCount} Pokémon)
                              </span>
                            </label>
                            {isChecked && (
                              <div className="flex items-center gap-2 pl-6">
                                <Label className="text-xs text-muted-foreground shrink-0">
                                  Slots
                                </Label>
                                <Input
                                  type="number"
                                  min={1}
                                  placeholder="Auto (= player count)"
                                  value={slotValue !== null ? String(slotValue) : ''}
                                  onChange={e => {
                                    const v = e.target.value.trim();
                                    setNpcSlotCount(npc._id, v ? Number(v) : null);
                                  }}
                                  className="h-8 text-sm"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Wild: Pokémon entry list ─────────────────────────── */}
              {type === 'wild' && (
                <div className="flex flex-col gap-3">
                  <Label>Wild Pokémon</Label>
                  {wildEntries.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No wild Pokémon yet — add one below.
                    </p>
                  )}
                  {wildEntries.map((entry, i) => (
                    <WildEntryRow
                      key={i}
                      index={i}
                      entry={entry}
                      headers={headers}
                      onChange={updateWildEntry}
                      onRemove={removeWildEntry}
                    />
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addWildEntry}
                    className="min-h-11"
                  >
                    + Add wild Pokémon
                  </Button>
                </div>
              )}

              {/* Player Pokémon limit ──────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enc-player-limit">
                  Player Pokémon limit{' '}
                  <span className="text-muted-foreground font-normal text-xs">
                    (blank = no limit)
                  </span>
                </Label>
                <Input
                  id="enc-player-limit"
                  type="number"
                  min={1}
                  placeholder="e.g. 3"
                  value={playerPokemonLimit}
                  onChange={e => setPlayerPokemonLimit(e.target.value)}
                />
              </div>

              {/* NPC Pokémon limit (PvE only) ──────────────────────────── */}
              {type === 'pve' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="enc-npc-limit">
                    NPC Pokémon limit{' '}
                    <span className="text-muted-foreground font-normal text-xs">
                      (blank = all must faint)
                    </span>
                  </Label>
                  <Input
                    id="enc-npc-limit"
                    type="number"
                    min={1}
                    placeholder="e.g. 3"
                    value={npcPokemonLimit}
                    onChange={e => setNpcPokemonLimit(e.target.value)}
                  />
                </div>
              )}

              {/* Exp multiplier ────────────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enc-exp">
                  Exp multiplier{' '}
                  <span className="text-muted-foreground font-normal text-xs">
                    (1 = normal · stored for Phase 5)
                  </span>
                </Label>
                <Input
                  id="enc-exp"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={expMultiplier}
                  onChange={e => setExpMultiplier(e.target.value)}
                />
              </div>

              {/* Notes ─────────────────────────────────────────────────── */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enc-notes">Notes (optional)</Label>
                <textarea
                  id="enc-notes"
                  rows={3}
                  placeholder="DM notes about this encounter…"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  className={
                    'w-full border border-input bg-background rounded-md px-3 py-2 ' +
                    'text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none'
                  }
                />
              </div>

              {/* Active toggle ─────────────────────────────────────────── */}
              <label className="flex items-center gap-2 text-sm cursor-pointer min-h-9">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={e => setIsActive(e.target.checked)}
                  className="h-4 w-4"
                />
                Active encounter
              </label>

              {submitError && <p className="text-sm text-destructive">{submitError}</p>}

              {/* Actions ───────────────────────────────────────────────── */}
              <div className="flex gap-3">
                <Button type="submit" disabled={submitting} className="flex-1 min-h-11">
                  {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create encounter'}
                </Button>
                <Link to="/dm/encounters">
                  <Button type="button" variant="ghost" className="min-h-11">
                    Cancel
                  </Button>
                </Link>
              </div>

            </form>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
