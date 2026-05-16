import { useState } from 'react';
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
              className="w-full min-h-[44px]"
            >
              {healBusy ? 'Healing…' : 'Heal Party'}
            </Button>
            {healMsg && (
              <p className="text-sm text-center font-medium">{healMsg}</p>
            )}
          </CardContent>
        </Card>

        {/* ── Pokémart ── */}
        <Card className="opacity-60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pokémart</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Coming soon — shop for items.</p>
          </CardContent>
        </Card>

        {/* ── DM: heal NPC parties ── */}
        {isDm && <DmHealSection token={token!} />}

      </div>
    </div>
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
          <Button variant="outline" onClick={loadNpcs} disabled={loading} className="min-h-[44px]">
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
                  className="min-h-[44px]"
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
