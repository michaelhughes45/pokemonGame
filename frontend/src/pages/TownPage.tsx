import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

export default function TownPage() {
  const { token, user } = useAuth();

  // Pokémon Center state
  const [healBusy, setHealBusy]     = useState(false);
  const [healMsg,  setHealMsg]      = useState('');

  async function healParty() {
    setHealBusy(true);
    setHealMsg('');
    try {
      const res = await axios.post(
        `${API}/api/pokemon/heal-party`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setHealMsg(res.data.data.message);
    } catch (err) {
      setHealMsg(
        axios.isAxiosError(err)
          ? (err.response?.data?.error ?? 'Healing failed.')
          : 'Healing failed.',
      );
    } finally {
      setHealBusy(false);
    }
  }

  const isDm = user?.role === 'dm' || user?.role === 'admin';

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-5">

        <Link to="/dashboard" className="text-sm underline text-muted-foreground">
          ← Back to dashboard
        </Link>

        <h1 className="text-2xl font-bold">Town</h1>

        {/* ── Pokémon Center ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pokémon Center</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Restore your party Pokémon to full health.
            </p>
            <Button
              onClick={healParty}
              disabled={healBusy}
              className="w-full min-h-11"
            >
              {healBusy ? 'Healing…' : 'Heal Party'}
            </Button>
            {healMsg && (
              <p className="text-sm text-center font-medium">{healMsg}</p>
            )}
          </CardContent>
        </Card>

        {/* ── Pokémart ── */}
        <PokemartCard token={token!} />

        {/* ── DM: heal NPC parties ── */}
        {isDm && <DmHealSection token={token!} />}

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pokémart — Buy lists whatever the DM has put up for sale in the campaign
// (Campaign.shopItemIds); Sell lists the player's own bag items that have a
// known sell price, sellable regardless of what's currently for sale.
// ---------------------------------------------------------------------------

type ShopCatalogEntry = { itemId: string; pocket: string | null; buyPrice: number; sellPrice: number | null };
type BagItem = { itemId: string; quantity: number };
type MartRow = { itemId: string; pocket: string | null; price: number; quantity?: number };

function formatItemName(slug: string): string {
  if (slug.startsWith('mint-')) {
    const nature = slug.slice(5);
    return `${nature.charAt(0).toUpperCase() + nature.slice(1)} Mint`;
  }
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const POCKET_LABELS: Record<string, string> = {
  healing:      'Healing',
  status_cure:  'Status Cures',
  pp_recovery:  'PP Recovery',
  stat_booster: 'Stat Boosters',
  held_type:    'Held Items',
  pokeballs:    'Poké Balls',
  escape:       'Escape',
  berry:        'Berries',
};

function PokemartCard({ token }: { token: string }) {
  const { user, refreshUser } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [catalog,     setCatalog]     = useState<ShopCatalogEntry[]>([]);
  const [shopItemIds, setShopItemIds] = useState<string[]>([]);
  const [bag,         setBag]         = useState<BagItem[]>([]);
  const [mode,        setMode]        = useState<'buy' | 'sell'>('buy');
  const [loading,     setLoading]     = useState(true);
  const [busy,        setBusy]        = useState<Record<string, boolean>>({});
  const [msgs,        setMsgs]        = useState<Record<string, string>>({});

  function loadAll() {
    return Promise.all([
      axios.get(`${API}/api/campaigns/shop-catalog`, { headers }),
      axios.get(`${API}/api/campaigns/mine`, { headers }),
      axios.get(`${API}/api/items`, { headers }),
    ]).then(([catalogRes, campaignRes, bagRes]) => {
      setCatalog(catalogRes.data.data ?? []);
      setShopItemIds(campaignRes.data.data?.shopItemIds ?? []);
      setBag(bagRes.data.data ?? []);
    });
  }

  useEffect(() => {
    setLoading(true);
    loadAll().catch(() => {}).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const catalogById = new Map(catalog.map(c => [c.itemId, c]));

  const buyList: MartRow[] = shopItemIds
    .map(id => catalogById.get(id))
    .filter((e): e is ShopCatalogEntry => Boolean(e))
    .map(e => ({ itemId: e.itemId, pocket: e.pocket, price: e.buyPrice }));

  const sellList: MartRow[] = bag
    .map(item => {
      const entry = catalogById.get(item.itemId);
      if (entry?.sellPrice == null) return null;
      return { itemId: item.itemId, pocket: entry.pocket, price: entry.sellPrice, quantity: item.quantity };
    })
    .filter((row): row is MartRow => row !== null);

  const grouped = (mode === 'buy' ? buyList : sellList).reduce<Record<string, MartRow[]>>((acc, row) => {
    const key = row.pocket ?? 'other';
    (acc[key] ??= []).push(row);
    return acc;
  }, {});

  async function handleTransaction(itemId: string, kind: 'buy' | 'sell') {
    setBusy(b => ({ ...b, [itemId]: true }));
    setMsgs(m => ({ ...m, [itemId]: '' }));
    try {
      const res = await axios.post(
        `${API}/api/shop/${kind}`,
        { itemId, quantity: 1 },
        { headers },
      );
      setMsgs(m => ({
        ...m,
        [itemId]: kind === 'buy' ? `Bought — now have ×${res.data.data.quantity}.` : `Sold for ₽${res.data.data.proceeds}.`,
      }));
      await Promise.all([loadAll(), refreshUser()]);
    } catch (err) {
      const label = kind === 'buy' ? 'Failed to buy' : 'Failed to sell';
      setMsgs(m => ({ ...m, [itemId]: axios.isAxiosError(err) ? (err.response?.data?.error ?? label) : label }));
    } finally {
      setBusy(b => ({ ...b, [itemId]: false }));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between">
          Pokémart
          {user && <span className="text-sm font-normal text-muted-foreground">₽{user.money.toLocaleString()}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={mode === 'buy' ? 'default' : 'outline'}
            className="flex-1 min-h-9"
            onClick={() => setMode('buy')}
          >
            Buy
          </Button>
          <Button
            size="sm"
            variant={mode === 'sell' ? 'default' : 'outline'}
            className="flex-1 min-h-9"
            onClick={() => setMode('sell')}
          >
            Sell
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : mode === 'buy' && buyList.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing for sale yet — ask your DM to stock the Mart.</p>
        ) : mode === 'sell' && sellList.length === 0 ? (
          <p className="text-sm text-muted-foreground">You don't have anything sellable.</p>
        ) : (
          Object.entries(grouped).map(([pocket, rows]) => (
            <div key={pocket} className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase">
                {POCKET_LABELS[pocket] ?? pocket}
              </p>
              {rows.map(row => (
                <div key={row.itemId} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {formatItemName(row.itemId)}
                      {row.quantity !== undefined && (
                        <span className="text-xs text-muted-foreground"> ×{row.quantity}</span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-mono">₽{row.price}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy[row.itemId]}
                        onClick={() => handleTransaction(row.itemId, mode)}
                        className="min-h-9"
                      >
                        {busy[row.itemId] ? '…' : mode === 'buy' ? 'Buy' : 'Sell'}
                      </Button>
                    </div>
                  </div>
                  {msgs[row.itemId] && (
                    <p className="text-xs text-muted-foreground text-right">{msgs[row.itemId]}</p>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// DM section — heal any NPC party
// ---------------------------------------------------------------------------

type Npc = { _id: string; name: string };

function DmHealSection({ token }: { token: string }) {
  const [npcs,    setNpcs]    = useState<Npc[]>([]);
  const [loaded,  setLoaded]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [msgs,    setMsgs]    = useState<Record<string, string>>({});
  const [busy,    setBusy]    = useState<Record<string, boolean>>({});

  async function loadNpcs() {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/api/dm/npcs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setNpcs(res.data.data ?? []);
      setLoaded(true);
    } catch {
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }

  async function healNpc(npcId: string) {
    setBusy(b => ({ ...b, [npcId]: true }));
    setMsgs(m => ({ ...m, [npcId]: '' }));
    try {
      const res = await axios.post(
        `${API}/api/dm/npcs/${npcId}/heal`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setMsgs(m => ({ ...m, [npcId]: res.data.data.message }));
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? 'Failed to heal.')
        : 'Failed to heal.';
      setMsgs(m => ({ ...m, [npcId]: msg }));
    } finally {
      setBusy(b => ({ ...b, [npcId]: false }));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">DM — Heal NPC Parties</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!loaded ? (
          <Button variant="outline" onClick={loadNpcs} disabled={loading} className="min-h-11">
            {loading ? 'Loading…' : 'Load NPCs'}
          </Button>
        ) : npcs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No NPCs in your campaign.</p>
        ) : (
          npcs.map(npc => (
            <div key={npc._id} className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{npc.name}</span>
              <div className="flex items-center gap-2">
                {msgs[npc._id] && (
                  <span className="text-xs text-muted-foreground">{msgs[npc._id]}</span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy[npc._id]}
                  onClick={() => healNpc(npc._id)}
                  className="min-h-11"
                >
                  {busy[npc._id] ? 'Healing…' : 'Heal'}
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
