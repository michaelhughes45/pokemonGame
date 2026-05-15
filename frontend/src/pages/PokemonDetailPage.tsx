import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../components/ui/sheet';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatSpread = { hp: number; atk: number; def: number; spatk: number; spdef: number; speed: number };

type EvolutionStep = {
  speciesId: number;
  condition: string;
  value: string;
  name: string | null;
};

type ReminderMove = {
  moveId: string;
  level: number;
  type: string;
  category: string;
  power: number | null;
  accuracy: number | null;
  pp: number | null;
};

type PokemonDetail = {
  _id: string;
  ownerId: string;
  speciesId: number;
  nickname: string | null;
  level: number;
  exp: number;
  currentHp: number;
  maxHp: number;
  nature: string;
  gender: 'male' | 'female' | 'none';
  heldItem: string | null;
  moves: { moveId: string; currentPP: number; maxPP: number }[];
  statusCondition: string | null;
  isInParty: boolean;
  partySlot: number | null;
  evolutionOverrides: { condition: string; value: string }[];
  stats: StatSpread;
  species: {
    name: string;
    types: string[];
    baseStats: StatSpread;
    abilities: { name: string; isHidden: boolean; effect: string; implemented: boolean }[];
    learnableMoves: {
      name: string; type: string; category: string;
      power: number | null; accuracy: number | null; pp: number | null;
    }[];
    reminderMoves: ReminderMove[];
    evolutionChain: EvolutionStep[];
    isLegendary: boolean;
    isMythical: boolean;
  };
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

// Standard Pokémon type colours (Tailwind bg classes)
const TYPE_BG: Record<string, string> = {
  normal:   'bg-stone-400',
  fire:     'bg-orange-500',
  water:    'bg-blue-500',
  electric: 'bg-yellow-400',
  grass:    'bg-green-500',
  ice:      'bg-cyan-300',
  fighting: 'bg-red-700',
  poison:   'bg-purple-500',
  ground:   'bg-yellow-600',
  flying:   'bg-indigo-300',
  psychic:  'bg-pink-500',
  bug:      'bg-lime-500',
  rock:     'bg-yellow-700',
  ghost:    'bg-purple-700',
  dragon:   'bg-indigo-600',
  dark:     'bg-gray-700',
  steel:    'bg-slate-400',
  fairy:    'bg-pink-300',
};

// Stat bar colour: red < 50, yellow < 80, green >= 80 (relative to 255 base-stat max)
function statBarColor(base: number): string {
  if (base < 50) return 'bg-red-500';
  if (base < 80) return 'bg-yellow-400';
  return 'bg-green-500';
}

// Capitalise and replace hyphens with spaces: "mr-mime" → "Mr Mime"
function formatName(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Gender symbol
function genderSymbol(g: 'male' | 'female' | 'none'): string {
  return g === 'male' ? '♂' : g === 'female' ? '♀' : '—';
}

// Move category label + colour
function categoryBadge(category: string) {
  const map: Record<string, { label: string; className: string }> = {
    physical: { label: 'PHY', className: 'bg-orange-500 text-white' },
    special:  { label: 'SPC', className: 'bg-blue-500 text-white' },
    status:   { label: 'STS', className: 'bg-gray-500 text-white' },
  };
  const entry = map[category] ?? { label: category.toUpperCase().slice(0, 3), className: 'bg-gray-400 text-white' };
  return (
    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${entry.className}`}>
      {entry.label}
    </span>
  );
}

// Human-readable evolution condition
function formatCondition(condition: string, value: string): string {
  if (!condition) return '';
  if (condition === 'level-up' && value) return `Lv. ${value}`;
  if (condition === 'level-up') return 'Level up';
  if (condition === 'use-item' && value) return formatName(value);
  if (condition === 'trade' && value) return `Trade (${formatName(value)})`;
  if (condition === 'trade') return 'Trade';
  return formatName(condition);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatRow({ label, base, actual }: { label: string; base: number; actual: number }) {
  const pct = Math.min(100, Math.round((base / 255) * 100));
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-14 text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${statBarColor(base)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right font-mono text-xs text-muted-foreground">{base}</span>
      <span className="w-10 text-right font-mono font-semibold">{actual}</span>
    </div>
  );
}

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-mono font-semibold">
        {current}/{max}
      </span>
    </div>
  );
}

function PpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  const color = pct > 50 ? 'bg-blue-400' : pct > 25 ? 'bg-yellow-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground">{current}/{max}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PokemonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [pokemon, setPokemon] = useState<PokemonDetail | null>(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);

  // Move Reminder state
  const [reminderSlot, setReminderSlot]     = useState<number | null>(null);
  const [reminderOpen, setReminderOpen]     = useState(false);
  const [reminderBusy, setReminderBusy]     = useState(false);
  const [reminderError, setReminderError]   = useState('');

  // Evolution override state (DM only)
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideMsg,  setOverrideMsg]  = useState('');

  // Release state — tracks which step of the two-step confirmation we're on:
  // 'idle' | 'confirm1' (first warning) | 'confirm2' (final warning) | 'busy' (request in flight)
  type ReleaseStep = 'idle' | 'confirm1' | 'confirm2' | 'busy';
  const [releaseStep, setReleaseStep] = useState<ReleaseStep>('idle');
  const [releaseError, setReleaseError] = useState('');

  useEffect(() => {
    if (!id) return;
    axios
      .get(`${API}/api/pokemon/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setPokemon(res.data.data))
      .catch(err => {
        setError(
          axios.isAxiosError(err)
            ? (err.response?.data?.error ?? 'Failed to load Pokémon')
            : 'Failed to load Pokémon'
        );
      })
      .finally(() => setLoading(false));
  }, [id, token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (error || !pokemon) {
    return (
      <div className="min-h-screen bg-background p-4">
        <p className="text-destructive">{error || 'Pokémon not found.'}</p>
        <Link to="/dashboard" className="text-sm underline text-muted-foreground mt-2 inline-block">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Move Reminder handler
  // ---------------------------------------------------------------------------
  async function selectMove(moveId: string) {
    if (reminderSlot === null || !pokemon) return;
    setReminderBusy(true);
    setReminderError('');
    try {
      const res = await axios.patch(
        `${API}/api/pokemon/${pokemon._id}/moves`,
        { slot: reminderSlot, moveId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Update local state so the UI reflects the new moveset immediately
      setPokemon(prev =>
        prev ? { ...prev, moves: res.data.data.moves } : prev
      );
      setReminderOpen(false);
    } catch (err) {
      setReminderError(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? 'Failed to change move')
          : 'Failed to change move'
      );
    } finally {
      setReminderBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Release handler
  // ---------------------------------------------------------------------------
  async function confirmRelease() {
    if (!pokemon) return;
    setReleaseStep('busy');
    setReleaseError('');
    try {
      await axios.delete(
        `${API}/api/pokemon/${pokemon._id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      navigate('/dashboard');
    } catch (err) {
      setReleaseError(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? 'Failed to release Pokémon')
          : 'Failed to release Pokémon'
      );
      setReleaseStep('confirm2');
    }
  }

  // ---------------------------------------------------------------------------
  // Evolution override handler (DM only)
  // ---------------------------------------------------------------------------
  async function toggleEvolutionBlock() {
    if (!pokemon) return;
    const isPrevented = pokemon.evolutionOverrides.some(o => o.condition === 'prevent');
    setOverrideBusy(true);
    setOverrideMsg('');
    try {
      const method = isPrevented ? 'delete' : 'post';
      await axios[method](
        `${API}/api/dm/pokemon/${pokemon._id}/evolution-override`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setPokemon(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          evolutionOverrides: isPrevented
            ? prev.evolutionOverrides.filter(o => o.condition !== 'prevent')
            : [...prev.evolutionOverrides, { condition: 'prevent', value: '' }],
        };
      });
      setOverrideMsg(isPrevented ? 'Evolution block lifted.' : 'Evolution blocked.');
    } catch (err) {
      setOverrideMsg(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? 'Failed to update override')
          : 'Failed to update override',
      );
    } finally {
      setOverrideBusy(false);
    }
  }

  const { species } = pokemon;

  // Can the logged-in user use the Move Reminder on this Pokémon?
  const canRemind =
    user?.id === pokemon.ownerId || user?.role === 'dm' || user?.role === 'admin';

  // Can the logged-in user release this Pokémon?
  const canRelease =
    user?.id === pokemon.ownerId || user?.role === 'dm' || user?.role === 'admin';

  const isDm         = user?.role === 'dm' || user?.role === 'admin';
  const isPrevented  = pokemon.evolutionOverrides.some(o => o.condition === 'prevent');

  // Display name: nickname takes priority, else species name
  const displayName = pokemon.nickname
    ? `${formatName(pokemon.nickname)} (${formatName(species.name)})`
    : formatName(species.name);

  // Build the evolution chain display.
  // The chain lists species that things EVOLVE INTO. The current species is the
  // "base" if its speciesId doesn't appear in any chain step.
  const isBaseForme = !species.evolutionChain.some(s => s.speciesId === pokemon.speciesId);

  // Look up current Pokémon's position in the chain (if it appears)
  const currentStepIdx = species.evolutionChain.findIndex(s => s.speciesId === pokemon.speciesId);

  // For move details, build a lookup from the learnable moves cache
  const learnableMap = new Map(species.learnableMoves.map(m => [m.name, m]));

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-5">

        {/* ── Back link ── */}
        <Link to="/dashboard" className="text-sm underline text-muted-foreground">
          ← Back to dashboard
        </Link>

        {/* ── Header ── */}
        <Card>
          <CardContent className="pt-5 flex gap-4 items-start">
            <img
              src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.speciesId}.png`}
              alt={species.name}
              width={96}
              height={96}
              className="pixelated shrink-0"
            />
            <div className="flex flex-col gap-2 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold leading-tight">{displayName}</h1>
                {species.isLegendary && (
                  <Badge variant="destructive">Legendary</Badge>
                )}
                {species.isMythical && (
                  <Badge variant="destructive">Mythical</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                #{pokemon.speciesId}
              </p>
              <div className="flex gap-1 flex-wrap">
                {species.types.map(t => (
                  <span
                    key={t}
                    className={`text-xs font-semibold text-white px-2 py-0.5 rounded ${TYPE_BG[t] ?? 'bg-gray-400'}`}
                  >
                    {formatName(t)}
                  </span>
                ))}
              </div>
              <div className="flex gap-3 text-sm flex-wrap">
                <span><span className="text-muted-foreground">Lv.</span> {pokemon.level}</span>
                <span><span className="text-muted-foreground">Nature:</span> {pokemon.nature}</span>
                <span><span className="text-muted-foreground">Gender:</span> {genderSymbol(pokemon.gender)}</span>
              </div>
              {pokemon.statusCondition && (
                <Badge variant="secondary" className="w-fit uppercase text-xs">
                  {pokemon.statusCondition}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── HP ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">HP</CardTitle>
          </CardHeader>
          <CardContent>
            <HpBar current={pokemon.currentHp} max={pokemon.maxHp} />
          </CardContent>
        </Card>

        {/* ── Stats ── */}
        {/*
          Why two numbers per row?
          - The bar + grey number = BASE stat from PokedexCache (comparable across species, max 255)
          - The bold number = ACTUAL stat at this Pokémon's level & nature (what battles use)
        */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stats</CardTitle>
            <p className="text-xs text-muted-foreground">bar = base · grey = base value · bold = actual at Lv. {pokemon.level}</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <StatRow label="HP"      base={species.baseStats.hp}    actual={pokemon.stats.hp} />
            <StatRow label="Attack"  base={species.baseStats.atk}   actual={pokemon.stats.atk} />
            <StatRow label="Defense" base={species.baseStats.def}   actual={pokemon.stats.def} />
            <StatRow label="Sp.Atk"  base={species.baseStats.spatk} actual={pokemon.stats.spatk} />
            <StatRow label="Sp.Def"  base={species.baseStats.spdef} actual={pokemon.stats.spdef} />
            <StatRow label="Speed"   base={species.baseStats.speed} actual={pokemon.stats.speed} />
          </CardContent>
        </Card>

        {/* ── Moves ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Moves</CardTitle>
            {canRemind && (
              <p className="text-xs text-muted-foreground">Tap Change to swap a move.</p>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pokemon.moves.length === 0 ? (
              <p className="text-sm text-muted-foreground">No moves.</p>
            ) : (
              pokemon.moves.map((m, idx) => {
                const detail = learnableMap.get(m.moveId);
                return (
                  <div key={`${m.moveId}-${idx}`} className="border rounded-md p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm flex-1 min-w-0">{formatName(m.moveId)}</span>
                      {detail && (
                        <>
                          <span
                            className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ${TYPE_BG[detail.type] ?? 'bg-gray-400'}`}
                          >
                            {formatName(detail.type)}
                          </span>
                          {categoryBadge(detail.category)}
                          {detail.power !== null && (
                            <span className="text-xs text-muted-foreground">PWR {detail.power}</span>
                          )}
                          {detail.accuracy !== null && (
                            <span className="text-xs text-muted-foreground">ACC {detail.accuracy}%</span>
                          )}
                        </>
                      )}
                      {canRemind && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-7 px-2 text-xs shrink-0"
                          onClick={() => {
                            setReminderSlot(idx);
                            setReminderError('');
                            setReminderOpen(true);
                          }}
                        >
                          Change
                        </Button>
                      )}
                    </div>
                    <PpBar current={m.currentPP} max={m.maxPP} />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* ── Move Reminder Sheet ── */}
        <Sheet open={reminderOpen} onOpenChange={setReminderOpen}>
          <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
            <SheetHeader className="pb-2">
              <SheetTitle>
                {reminderSlot !== null
                  ? `Replace: ${formatName(pokemon.moves[reminderSlot]?.moveId ?? '')}`
                  : 'Choose a Move'}
              </SheetTitle>
              <SheetDescription>
                Moves learnable at or below Lv. {pokemon.level}
              </SheetDescription>
            </SheetHeader>

            {reminderError && (
              <p className="text-sm text-destructive px-6 pb-2">{reminderError}</p>
            )}

            <div className="flex flex-col gap-2 px-6 pb-6">
              {species.reminderMoves.length === 0 ? (
                <p className="text-sm text-muted-foreground">No moves available.</p>
              ) : (
                species.reminderMoves.map(rm => {
                  const alreadyKnown = pokemon.moves.some(m => m.moveId === rm.moveId);
                  const isCurrentSlot =
                    reminderSlot !== null &&
                    pokemon.moves[reminderSlot]?.moveId === rm.moveId;
                  return (
                    <button
                      key={rm.moveId}
                      disabled={reminderBusy || isCurrentSlot}
                      onClick={() => selectMove(rm.moveId)}
                      className={`
                        w-full text-left border rounded-md p-3 transition-colors
                        ${isCurrentSlot
                          ? 'opacity-50 cursor-not-allowed bg-muted'
                          : alreadyKnown
                          ? 'opacity-60 hover:bg-accent'
                          : 'hover:bg-accent'}
                        ${reminderBusy ? 'pointer-events-none' : ''}
                      `}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground w-10 shrink-0">
                          Lv.{rm.level}
                        </span>
                        <span className="font-semibold text-sm">{formatName(rm.moveId)}</span>
                        {rm.type && (
                          <span
                            className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ${TYPE_BG[rm.type] ?? 'bg-gray-400'}`}
                          >
                            {formatName(rm.type)}
                          </span>
                        )}
                        {rm.category && categoryBadge(rm.category)}
                        {rm.power !== null && (
                          <span className="text-xs text-muted-foreground">PWR {rm.power}</span>
                        )}
                        {rm.accuracy !== null && (
                          <span className="text-xs text-muted-foreground">ACC {rm.accuracy}%</span>
                        )}
                        {rm.pp !== null && (
                          <span className="text-xs text-muted-foreground">PP {rm.pp}</span>
                        )}
                        {alreadyKnown && !isCurrentSlot && (
                          <Badge variant="secondary" className="text-[10px] ml-auto">known</Badge>
                        )}
                        {isCurrentSlot && (
                          <Badge variant="secondary" className="text-[10px] ml-auto">current</Badge>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </SheetContent>
        </Sheet>

        {/* ── Held Item ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Held Item</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              {pokemon.heldItem ? formatName(pokemon.heldItem) : (
                <span className="text-muted-foreground">None</span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* ── Abilities ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Abilities</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {species.abilities.map(a => (
              <div key={a.name}>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{formatName(a.name)}</span>
                  {a.isHidden && (
                    <Badge variant="secondary" className="text-xs">Hidden</Badge>
                  )}
                </div>
                {a.effect && (
                  <p className="text-xs text-muted-foreground mt-0.5">{a.effect}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Evolution Path ── */}
        {/*
          The evolution chain from the cache lists species that this family evolves INTO.
          The base species is NOT included in the chain (it never "evolves into" itself).
          So: if the current species doesn't appear in the chain, it IS the base.
          We show: [current (base)] → [step 1] → [step 2] …
          Or: … → [current (highlighted)] → [remaining steps] …
        */}
        {species.evolutionChain.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Evolution Path</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {/* Prepend the base forme if this pokemon is the base */}
                {isBaseForme && (
                  <div className="flex flex-col items-center gap-1">
                    <img
                      src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.speciesId}.png`}
                      alt={species.name}
                      width={48}
                      height={48}
                      className="pixelated"
                    />
                    <span className="font-semibold text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
                      {formatName(species.name)}
                    </span>
                  </div>
                )}

                {species.evolutionChain.map((step, idx) => {
                  const isCurrent = step.speciesId === pokemon.speciesId;
                  // For non-base formes, prepend the steps before the current one as dimmed
                  const isPast = !isBaseForme && currentStepIdx > -1 && idx < currentStepIdx;
                  return (
                    <div key={step.speciesId} className="flex items-center gap-2">
                      {/* Arrow + condition label */}
                      <div className="flex flex-col items-center text-muted-foreground">
                        <span className="text-[10px] leading-tight max-w-15 text-center">
                          {formatCondition(step.condition, step.value)}
                        </span>
                        <span className="text-base">→</span>
                      </div>
                      {/* Evolution target */}
                      <div className={`flex flex-col items-center gap-1 ${isPast ? 'opacity-40' : ''}`}>
                        <img
                          src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${step.speciesId}.png`}
                          alt={step.name ?? String(step.speciesId)}
                          width={48}
                          height={48}
                          className="pixelated"
                        />
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded font-semibold ${
                            isCurrent
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {step.name ? formatName(step.name) : `#${step.speciesId}`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* DM evolution block toggle */}
              {isDm && (
                <div className="mt-3 flex flex-col gap-1">
                  {isPrevented && (
                    <p className="text-xs text-yellow-600 font-medium">Evolution is blocked for this Pokémon.</p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className={isPrevented
                      ? 'border-yellow-500 text-yellow-600 hover:bg-yellow-50 w-fit'
                      : 'border-muted text-muted-foreground w-fit'}
                    disabled={overrideBusy}
                    onClick={toggleEvolutionBlock}
                  >
                    {isPrevented ? 'Lift Evolution Block' : 'Block Evolution'}
                  </Button>
                  {overrideMsg && (
                    <p className="text-xs text-muted-foreground">{overrideMsg}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Release ── */}
        {canRelease && (
          <Card className={releaseStep !== 'idle' ? 'border-destructive' : ''}>
            <CardContent className="pt-5 flex flex-col gap-3">
              {releaseStep === 'idle' && (
                <Button
                  variant="outline"
                  className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground w-full"
                  onClick={() => setReleaseStep('confirm1')}
                >
                  Release {pokemon.nickname ? formatName(pokemon.nickname) : formatName(species.name)}
                </Button>
              )}

              {releaseStep === 'confirm1' && (
                <>
                  <p className="text-sm font-semibold text-destructive">
                    Are you sure? Releasing a Pokémon is permanent.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatName(pokemon.nickname ?? species.name)} will be gone forever and cannot be recovered.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={() => setReleaseStep('idle')}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => setReleaseStep('confirm2')}
                    >
                      Yes, release
                    </Button>
                  </div>
                </>
              )}

              {(releaseStep === 'confirm2' || releaseStep === 'busy') && (
                <>
                  <p className="text-sm font-semibold text-destructive">
                    Final confirmation — are you absolutely sure?
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This cannot be undone. {formatName(pokemon.nickname ?? species.name)} will be released into the wild permanently.
                  </p>
                  {releaseError && (
                    <p className="text-xs text-destructive">{releaseError}</p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={releaseStep === 'busy'}
                      onClick={() => { setReleaseStep('idle'); setReleaseError(''); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      disabled={releaseStep === 'busy'}
                      onClick={confirmRelease}
                    >
                      {releaseStep === 'busy' ? 'Releasing…' : 'Confirm Release'}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}
