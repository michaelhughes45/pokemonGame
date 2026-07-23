import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

const API = import.meta.env.VITE_API_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemPocket =
  | 'healing' | 'status_cure' | 'pp_recovery'
  | 'stat_booster' | 'held_type' | 'pokeballs' | 'escape' | 'berry' | 'tm_hm';

type BagItem = {
  _id: string;
  itemId: string;
  quantity: number;
  pocket: ItemPocket;
};

type PartyMember = {
  _id: string;
  speciesId: number;
  nickname: string | null;
  speciesName: string | null;
  level: number;
  currentHp: number;
  maxHp: number | null;
  statusCondition: string | null;
  moves: { moveId: string; currentPP: number; maxPP: number; ppUps: number }[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POCKET_LABEL: Record<ItemPocket, string> = {
  healing:      'Medicine',
  status_cure:  'Status Cures',
  pp_recovery:  'PP Items',
  stat_booster: 'Vitamins',
  held_type:    'Held Items',
  pokeballs:    'Poké Balls',
  escape:       'Escape',
  berry:        'Berries',
  tm_hm:        'TMs & HMs',
};

// Canonical pocket display order, reused wherever pockets are sorted/matched.
const POCKET_ORDER: ItemPocket[] = [
  'healing', 'status_cure', 'pp_recovery', 'stat_booster', 'held_type', 'pokeballs', 'escape', 'berry', 'tm_hm',
];

// Pockets that cannot be used outside of battle (show a notice, skip targeting flow)
const BATTLE_ONLY_POCKETS: ItemPocket[] = ['pokeballs'];

// Pockets whose items are consumed directly with no Pokémon target needed
const DIRECT_USE_POCKETS: ItemPocket[] = ['escape'];

// Items that target a single move (need moveIndex) vs all moves.
// Ether/Max Ether restore PP; PP Up/PP Max raise a move's max PP instead —
// both need the same move-picker flow, just with different picker semantics.
const PP_ONE_ITEMS = new Set(['ether', 'max-ether', 'pp-up', 'pp-max']);
const PP_UP_ITEMS = new Set(['pp-up', 'pp-max']);

// Format a PokeAPI slug like "super-potion" → "Super Potion".
// TM/HM items ("tm-flamethrower") are special-cased to "TM: Flamethrower"
// rather than the naive "Tm Flamethrower" the generic split would produce.
function formatItemName(slug: string): string {
  if (slug.startsWith('tm-')) {
    return `TM: ${formatItemName(slug.slice(3))}`;
  }
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatPokemonName(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BagPage
// ---------------------------------------------------------------------------

export default function BagPage() {
  const { token } = useAuth();

  const [items, setItems]               = useState<BagItem[]>([]);
  const [party, setParty]               = useState<PartyMember[]>([]);
  const [loading, setLoading]           = useState(true);

  // Use-item flow state
  const [selectedItem, setSelectedItem]   = useState<BagItem | null>(null);
  const [targetPokemon, setTargetPokemon] = useState<PartyMember | null>(null);
  const [using, setUsing]                 = useState(false);
  const [feedback, setFeedback]           = useState<{ ok: boolean; msg: string } | null>(null);

  // Which pocket tab is active — default to first occupied pocket
  const [activePocket, setActivePocket] = useState<ItemPocket>('healing');

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function loadBag() {
    const [itemsRes, partyRes] = await Promise.all([
      axios.get(`${API}/api/items`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API}/api/pokemon/party`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const fetchedItems: BagItem[] = itemsRes.data.data ?? [];
    setItems(fetchedItems);

    // Party from /party doesn't include moves — fetch detail for each member
    // so the PP-item flow can show move slots. We do this in parallel.
    const partyBasic: Omit<PartyMember, 'moves'>[] = partyRes.data.data ?? [];
    const detailed = await Promise.all(
      partyBasic.map((p) =>
        axios
          .get(`${API}/api/pokemon/${p._id}`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => ({
            _id:             String(p._id),
            speciesId:       p.speciesId,
            nickname:        p.nickname,
            speciesName:     p.speciesName,
            level:           p.level,
            currentHp:       p.currentHp,
            maxHp:           p.maxHp,
            statusCondition: p.statusCondition,
            moves:           (r.data.data?.moves ?? []) as PartyMember['moves'],
          }))
          .catch(() => ({
            _id:             String(p._id),
            speciesId:       p.speciesId,
            nickname:        p.nickname,
            speciesName:     p.speciesName,
            level:           p.level,
            currentHp:       p.currentHp,
            maxHp:           p.maxHp,
            statusCondition: p.statusCondition,
            moves:           [] as PartyMember['moves'],
          }))
      )
    );
    setParty(detailed);

    // Default active pocket to first occupied one
    if (fetchedItems.length > 0) {
      const firstOccupied = POCKET_ORDER.find(p =>
        fetchedItems.some(i => i.pocket === p)
      );
      if (firstOccupied) setActivePocket(firstOccupied);
    }
  }

  useEffect(() => {
    loadBag().finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Use-item flow
  // ---------------------------------------------------------------------------

  // Group items by pocket for the tab UI
  const byPocket = items.reduce<Partial<Record<ItemPocket, BagItem[]>>>((acc, item) => {
    (acc[item.pocket] ??= []).push(item);
    return acc;
  }, {});

  const occupiedPockets = (Object.keys(byPocket) as ItemPocket[]).sort((a, b) => {
    return POCKET_ORDER.indexOf(a) - POCKET_ORDER.indexOf(b);
  });

  function selectItem(item: BagItem) {
    // Reset flow whenever a new item is picked
    setSelectedItem(item);
    setTargetPokemon(null);
    setFeedback(null);
  }

  function clearSelection() {
    setSelectedItem(null);
    setTargetPokemon(null);
    setFeedback(null);
  }

  // For items that don't need a Pokémon target (e.g. Escape Rope)
  async function applyItemDirect(item: BagItem) {
    setUsing(true);
    setFeedback(null);
    try {
      const res = await axios.post(
        `${API}/api/items/use`,
        { itemId: item.itemId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setFeedback({ ok: true, msg: res.data.data.message });
      await loadBag();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? 'Failed to use item.')
        : 'Failed to use item.';
      setFeedback({ ok: false, msg });
    } finally {
      setUsing(false);
    }
  }

  async function applyItem(moveIndex?: number) {
    if (!selectedItem || !targetPokemon) return;
    setUsing(true);
    setFeedback(null);
    try {
      const body: Record<string, unknown> = {
        itemId:    selectedItem.itemId,
        pokemonId: targetPokemon._id,
      };
      if (typeof moveIndex === 'number') body.moveIndex = moveIndex;

      const res = await axios.post(`${API}/api/items/use`, body, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setFeedback({ ok: true, msg: res.data.data.message });
      // Reload the bag so quantities update
      await loadBag();
      // Clear the targeting flow after success
      setSelectedItem(null);
      setTargetPokemon(null);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? 'Failed to use item.')
        : 'Failed to use item.';
      setFeedback({ ok: false, msg });
    } finally {
      setUsing(false);
    }
  }

  // Teach a TM/HM into one of the target Pokémon's 4 move slots. Unlike every
  // other bag item, this does NOT go through /api/items/use and the item is
  // never consumed (TM/HM items are reusable — Gen 8+ style).
  async function teachMove(slot: number) {
    if (!selectedItem || !targetPokemon) return;
    setUsing(true);
    setFeedback(null);
    try {
      await axios.patch(
        `${API}/api/pokemon/${targetPokemon._id}/teach-tm`,
        { slot, itemId: selectedItem.itemId },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setFeedback({ ok: true, msg: `Taught ${formatItemName(selectedItem.itemId.slice(3))}!` });
      await loadBag();
      setSelectedItem(null);
      setTargetPokemon(null);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? 'Failed to teach move.')
        : 'Failed to teach move.';
      setFeedback({ ok: false, msg });
    } finally {
      setUsing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  // The inline notice shown instead of the targeting flow for non-usable pockets
  function pocketNotice(pocket: ItemPocket): string | null {
    if (BATTLE_ONLY_POCKETS.includes(pocket))
      return 'These items can only be used in battle.';
    return null;
  }

  // Teaching a TM/HM also needs a move-slot pick, same two-step shape as
  // Ether/PP Up, but it replaces a slot instead of applying an effect to it.
  const isTeachItem = selectedItem !== null && selectedItem.pocket === 'tm_hm';

  // Whether the selected item requires picking a single move (Ether / Max Ether / PP Up / PP Max / TM-HM)
  const needsMoveTarget =
    selectedItem !== null && (PP_ONE_ITEMS.has(selectedItem.itemId) || isTeachItem);

  // PP Up / PP Max target a move's PP-Up count, not its current PP
  const isPpUpItem =
    selectedItem !== null && PP_UP_ITEMS.has(selectedItem.itemId);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <p className="text-sm text-muted-foreground">Loading bag…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Bag</h1>
          <Link to="/dashboard" className="text-sm underline text-muted-foreground">
            ← Dashboard
          </Link>
        </div>

        {/* ── Global feedback banner ── */}
        {feedback && (
          <p className={`text-sm ${feedback.ok ? 'text-green-600' : 'text-destructive'}`}>
            {feedback.msg}
          </p>
        )}

        {/* ── Empty bag ── */}
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Your bag is empty. Ask your DM to give you some items!
          </p>
        )}

        {/* ── Bag tabs ── */}
        {occupiedPockets.length > 0 && (
          <Tabs
            value={activePocket}
            onValueChange={(v) => {
              setActivePocket(v as ItemPocket);
              clearSelection();
            }}
          >
            <TabsList className="flex flex-wrap h-auto gap-1">
              {occupiedPockets.map((pocket) => (
                <TabsTrigger key={pocket} value={pocket} className="text-xs">
                  {POCKET_LABEL[pocket]}
                </TabsTrigger>
              ))}
            </TabsList>

            {occupiedPockets.map((pocket) => {
              const notice   = pocketNotice(pocket);
              const pocketItems = byPocket[pocket] ?? [];

              return (
                <TabsContent key={pocket} value={pocket} className="flex flex-col gap-3 mt-4">

                  {/* Notice for battle-only / deferred pockets */}
                  {notice && (
                    <p className="text-sm text-muted-foreground italic">{notice}</p>
                  )}

                  {/* Item list */}
                  {pocketItems.map((item) => {
                    const isSelected = selectedItem?._id === item._id;
                    return (
                      <Card
                        key={item._id}
                        className={isSelected ? 'border-primary' : ''}
                      >
                        <CardContent className="pt-4 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="font-medium text-sm">
                              {formatItemName(item.itemId)}
                            </span>
                            <Badge variant="secondary">×{item.quantity}</Badge>
                          </div>
                          {notice ? (
                            // Battle-only / deferred — no use button
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : isSelected ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="min-h-9"
                              onClick={clearSelection}
                            >
                              Cancel
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="min-h-9"
                              disabled={using}
                              onClick={() =>
                                DIRECT_USE_POCKETS.includes(item.pocket)
                                  ? applyItemDirect(item)
                                  : selectItem(item)
                              }
                            >
                              {item.pocket === 'tm_hm' ? 'Teach' : 'Use'}
                            </Button>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}

                  {/* ── Targeting flow ── */}
                  {selectedItem && selectedItem.pocket === pocket && !notice && (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-medium">
                        {needsMoveTarget && targetPokemon
                          ? isTeachItem
                            ? `Replace which move with ${formatItemName(selectedItem.itemId.slice(3))}?`
                            : `Choose a move on ${targetPokemon.nickname ? formatPokemonName(targetPokemon.nickname) : formatPokemonName(targetPokemon.speciesName ?? '')}:`
                          : 'Choose a Pokémon:'}
                      </p>

                      {/* Move picker — shown for Ether/Max Ether/PP Up/PP Max after a pokemon is selected */}
                      {needsMoveTarget && targetPokemon ? (
                        <div className="flex flex-col gap-2">
                          {targetPokemon.moves.length === 0 ? (
                            <p className="text-sm text-muted-foreground">This Pokémon has no moves.</p>
                          ) : (
                            targetPokemon.moves.map((move, idx) => (
                              <Button
                                key={idx}
                                variant="outline"
                                className="justify-between min-h-11"
                                disabled={using || (!isTeachItem && (isPpUpItem ? (move.ppUps ?? 0) >= 3 : move.currentPP >= move.maxPP))}
                                onClick={() => isTeachItem ? teachMove(idx) : applyItem(idx)}
                              >
                                <span>{formatItemName(move.moveId)}</span>
                                <span className="text-xs text-muted-foreground font-mono">
                                  {isTeachItem ? 'Replace' : isPpUpItem ? `PP Ups: ${move.ppUps ?? 0}/3` : `${move.currentPP}/${move.maxPP} PP`}
                                </span>
                              </Button>
                            ))
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="self-start"
                            onClick={() => setTargetPokemon(null)}
                          >
                            ← Back
                          </Button>
                        </div>
                      ) : (
                        /* Party picker */
                        <div className="flex flex-col gap-2">
                          {party.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              You have no Pokémon in your party.
                            </p>
                          ) : (
                            party.map((p) => (
                              <Button
                                key={p._id}
                                variant="outline"
                                className="justify-between min-h-11"
                                disabled={using}
                                onClick={() => {
                                  if (needsMoveTarget) {
                                    // For Ether/Max Ether: select the pokemon then show moves
                                    setTargetPokemon(p);
                                  } else {
                                    // For all other items: select pokemon and use immediately
                                    setTargetPokemon(p);
                                    // Trigger use via effect — but we need the updated state.
                                    // Instead, call with explicit args to avoid stale closure.
                                    applyItemOn(p);
                                  }
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  <img
                                    src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${p.speciesId}.png`}
                                    alt={p.speciesName ?? ''}
                                    width={32}
                                    height={32}
                                    className="pixelated"
                                  />
                                  <span className="text-sm">
                                    {p.nickname
                                      ? formatPokemonName(p.nickname)
                                      : formatPokemonName(p.speciesName ?? `#${p.speciesId}`)}
                                  </span>
                                  {p.statusCondition && (
                                    <Badge variant="secondary" className="text-[10px] uppercase">
                                      {p.statusCondition}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="text-xs text-muted-foreground">Lv. {p.level}</span>
                                  <HpBar current={p.currentHp} max={p.maxHp} />
                                </div>
                              </Button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </TabsContent>
              );
            })}
          </Tabs>
        )}

      </div>
    </div>
  );

  // Variant of applyItem that takes the pokemon as an arg so we don't rely on
  // setTargetPokemon having flushed before calling the async function.
  async function applyItemOn(pokemon: PartyMember, moveIndex?: number) {
    if (!selectedItem) return;
    setUsing(true);
    setFeedback(null);
    try {
      const body: Record<string, unknown> = {
        itemId:    selectedItem.itemId,
        pokemonId: pokemon._id,
      };
      if (typeof moveIndex === 'number') body.moveIndex = moveIndex;

      const res = await axios.post(`${API}/api/items/use`, body, {
        headers: { Authorization: `Bearer ${token}` },
      });

      setFeedback({ ok: true, msg: res.data.data.message });
      await loadBag();
      setSelectedItem(null);
      setTargetPokemon(null);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? 'Failed to use item.')
        : 'Failed to use item.';
      setFeedback({ ok: false, msg });
    } finally {
      setUsing(false);
    }
  }
}
