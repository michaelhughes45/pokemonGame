import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { TYPE_BG } from '../lib/typeColors';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';

const API = import.meta.env.VITE_API_URL;

// ── Shared helpers ───────────────────────────────────────────────────────────

type PokemonSummary = {
  _id: string;
  speciesId: number;
  nickname: string | null;
  level: number;
  currentHp: number;
  maxHp: number | null;
  gender: 'male' | 'female' | 'none';
  statusCondition: string | null;
  speciesName: string | null;
  types: string[];
  partySlot?: number | null; // only present on party members
};

function formatName(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function HpBar({ current, max }: { current: number; max: number | null }) {
  const pct   = max && max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
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

// A single pokemon card — used for both party and PC lists
function PokemonCard({ pokemon }: { pokemon: PokemonSummary }) {
  const displayName = pokemon.nickname
    ? formatName(pokemon.nickname)
    : pokemon.speciesName
      ? formatName(pokemon.speciesName)
      : `#${pokemon.speciesId}`;

  return (
    <CardContent className="pt-3 pb-3 flex gap-3 items-center">
      <img
        src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${pokemon.speciesId}.png`}
        alt={pokemon.speciesName ?? String(pokemon.speciesId)}
        width={56}
        height={56}
        className="pixelated shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-sm">{displayName}</span>
          {pokemon.nickname && pokemon.speciesName && (
            <span className="text-xs text-muted-foreground">({formatName(pokemon.speciesName)})</span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">Lv. {pokemon.level}</span>
        </div>
        <div className="flex gap-1 flex-wrap mt-1">
          {pokemon.types.map(t => (
            <span
              key={t}
              className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ${TYPE_BG[t] ?? 'bg-gray-400'}`}
            >
              {formatName(t)}
            </span>
          ))}
          {pokemon.statusCondition && (
            <Badge variant="secondary" className="text-[10px] uppercase">
              {pokemon.statusCondition}
            </Badge>
          )}
        </div>
        <HpBar current={pokemon.currentHp} max={pokemon.maxHp} />
      </div>
    </CardContent>
  );
}

// ── PCPage ───────────────────────────────────────────────────────────────────

export default function PCPage() {
  const { token } = useAuth();

  const [party,   setParty]   = useState<PokemonSummary[]>([]);
  const [pc,      setPc]      = useState<PokemonSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // The PC pokemon the user has selected to move into the party.
  // When this is set and the party is full, the UI switches into "swap mode"
  // where party cards show a "Swap out" button instead of navigating.
  const [selectedPcId, setSelectedPcId] = useState<string | null>(null);

  // refetchKey is a counter. Incrementing it re-runs the fetch effect.
  // The refetch() helper also resets loading/error synchronously — called
  // from event handlers (not effects), so the linter is happy.
  const [refetchKey, setRefetchKey] = useState(0);
  const refetch = () => {
    setLoading(true);
    setError(null);
    setRefetchKey(k => k + 1);
  };

  // Fetch both lists in parallel. Only calls setState inside promise callbacks
  // (never synchronously in the effect body) to satisfy the linter rule.
  // loading starts as true from useState, so no need to set it here on first run.
  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/pokemon/party`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API}/api/pokemon/pc`,    { headers: { Authorization: `Bearer ${token}` } }),
    ])
      .then(([partyRes, pcRes]) => {
        setParty(partyRes.data.data ?? []);
        setPc(pcRes.data.data ?? []);
      })
      .catch(() => setError('Failed to load Pokémon. Please refresh.'))
      .finally(() => setLoading(false));
  }, [token, refetchKey]);

  const partyFull = party.length >= 6;

  async function handleMoveToParty(pcPokemonId: string) {
    if (partyFull) {
      // Party is full — enter swap mode instead of moving immediately.
      // The user now needs to tap a party member to swap out.
      setSelectedPcId(pcPokemonId);
      return;
    }

    // Party has room — move directly
    try {
      await axios.post(
        `${API}/api/pokemon/party/swap`,
        { pcPokemonId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSelectedPcId(null);
      refetch(); // re-fetch both lists to reflect the change
    } catch {
      setError('Failed to move Pokémon. Please try again.');
    }
  }

  async function handleSwap(partyPokemonId: string) {
    if (!selectedPcId) return;

    try {
      await axios.post(
        `${API}/api/pokemon/party/swap`,
        { pcPokemonId: selectedPcId, partyPokemonId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSelectedPcId(null);
      refetch();
    } catch {
      setError('Failed to swap Pokémon. Please try again.');
    }
  }

  async function handleWithdraw(partyPokemonId: string) {
    try {
      await axios.post(
        `${API}/api/pokemon/party/withdraw`,
        { partyPokemonId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      refetch();
    } catch {
      setError('Failed to move Pokémon to PC. Please try again.');
    }
  }

  const selectedPc = pc.find(p => p._id === selectedPcId);

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-bold">PC Storage</h1>
        </div>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error   && <p className="text-sm text-destructive">{error}</p>}

        {!loading && (
          <>
            {/* ── Party (shown at top as swap targets when in swap mode) ── */}
            {party.length > 0 && (
              <section>
                <div className="flex items-baseline gap-2 mb-2">
                  <h2 className="text-base font-semibold">Party ({party.length}/6)</h2>
                  {selectedPcId && (
                    <span className="text-sm text-muted-foreground">
                      — tap a member to swap out for{' '}
                      <span className="font-medium text-foreground">
                        {selectedPc
                          ? (selectedPc.nickname
                              ? formatName(selectedPc.nickname)
                              : selectedPc.speciesName
                                ? formatName(selectedPc.speciesName)
                                : `#${selectedPc.speciesId}`)
                          : '…'}
                      </span>
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {party.map(p => (
                    <Card
                      key={String(p._id)}
                      // In swap mode the whole card becomes a button.
                      // Outside swap mode it links to the detail page, with a
                      // separate "→ PC" button to withdraw without swapping.
                      className={selectedPcId
                        ? 'cursor-pointer ring-2 ring-primary/30 hover:ring-primary transition-all'
                        : ''}
                      onClick={selectedPcId ? () => handleSwap(p._id) : undefined}
                    >
                      {selectedPcId
                        ? <PokemonCard pokemon={p} />
                        : (
                          <div className="flex items-center gap-2">
                            <Link to={`/pokemon/${p._id}`} className="flex-1 min-w-0">
                              <PokemonCard pokemon={p} />
                            </Link>
                            {party.length > 1 && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="shrink-0 mr-3 min-h-11"
                                onClick={() => handleWithdraw(p._id)}
                              >
                                → PC
                              </Button>
                            )}
                          </div>
                        )
                      }
                    </Card>
                  ))}
                </div>
              </section>
            )}

            {/* ── Cancel swap mode ── */}
            {selectedPcId && (
              <Button variant="outline" onClick={() => setSelectedPcId(null)}>
                Cancel
              </Button>
            )}

            {/* ── PC list ── */}
            <section>
              <h2 className="text-base font-semibold mb-2">
                PC ({pc.length} {pc.length === 1 ? 'Pokémon' : 'Pokémon'})
              </h2>

              {pc.length === 0 && (
                <p className="text-sm text-muted-foreground">No Pokémon in PC storage.</p>
              )}

              <div className="flex flex-col gap-2">
                {pc.map(p => {
                  const isSelected = p._id === selectedPcId;
                  return (
                    <Card
                      key={String(p._id)}
                      className={isSelected ? 'ring-2 ring-primary' : ''}
                    >
                      <div className="flex items-center gap-2">
                        <Link to={`/pokemon/${p._id}`} className="flex-1 min-w-0">
                          <PokemonCard pokemon={p} />
                        </Link>
                        {/* Only show the move button when not already selected */}
                        {!isSelected && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 mr-3 min-h-11"
                            onClick={() => handleMoveToParty(p._id)}
                          >
                            {partyFull ? '⇄ Swap' : '→ Party'}
                          </Button>
                        )}
                        {isSelected && (
                          <span className="shrink-0 mr-3 text-xs text-primary font-medium">
                            Select party member ↑
                          </span>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          </>
        )}

      </div>
    </div>
  );
}
