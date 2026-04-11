import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

const API = import.meta.env.VITE_API_URL;

export default function DmPage() {
  const { token } = useAuth();

  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  async function handleReset(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!username.trim()) return;

    setResult('');
    setError('');
    setLoading(true);

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
      if (axios.isAxiosError(err)) {
        setError(err.response?.data?.error ?? 'Reset failed');
      } else {
        setError('Reset failed');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">DM Panel</h1>
          <Link to="/dashboard" className="text-sm underline text-muted-foreground">
            ← Dashboard
          </Link>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Reset Player Starter</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleReset} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="username">Player username</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="e.g. ash"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              {result && <p className="text-sm text-muted-foreground">{result}</p>}

              <Button type="submit" disabled={loading} className="min-h-11">
                {loading ? 'Resetting…' : 'Reset starter'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
