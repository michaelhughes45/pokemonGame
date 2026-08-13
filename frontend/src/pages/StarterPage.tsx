import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../hooks/useAuth';
import { apiError } from '../lib/apiError';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const API = import.meta.env.VITE_API_URL;

type SpeciesPreview = {
  pokeApiId: number;
  name: string;
  types: string[];
};

export default function StarterPage() {
  const { token } = useAuth();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SpeciesPreview | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  // Redirect to dashboard if already has a starter
  useEffect(() => {
    const savedToken = localStorage.getItem('token');
    axios
      .get(`${API}/api/starter`, { headers: { Authorization: `Bearer ${savedToken}` } })
      .then((res) => {
        if (res.data.data.hasStarter) navigate('/dashboard', { replace: true });
      })
      .catch(() => {});
  }, [navigate]);

  async function handleSearch(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!query.trim()) return;

    setSearchError('');
    setPreview(null);
    setSearching(true);

    try {
      const res = await axios.get(`${API}/api/pokedex/${query.trim().toLowerCase()}`);
      const d = res.data.data;
      setPreview({ pokeApiId: d.pokeApiId, name: d.name, types: d.types });
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setSearchError(`No Pokémon found for "${query}"`);
      } else {
        setSearchError('Search failed — is the backend running?');
      }
    } finally {
      setSearching(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setConfirmError('');
    setConfirming(true);

    try {
      await axios.post(
        `${API}/api/starter`,
        { speciesId: preview.pokeApiId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      navigate('/dashboard');
    } catch (err: unknown) {
      setConfirmError(apiError(err, 'Failed to choose starter'));
    } finally {
      setConfirming(false);
    }
  }

  // Capitalise the first letter of a hyphenated name (e.g. "mr-mime" → "Mr-mime")
  function formatName(name: string) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-md mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">Choose your starter</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Search by name or Pokédex number. Any Pokémon is fair game.
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            placeholder="e.g. pikachu or 25"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" disabled={searching} className="min-h-11">
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </form>

        {searchError && <p className="text-sm text-destructive">{searchError}</p>}

        {preview && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-4">
                <img
                  src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${preview.pokeApiId}.png`}
                  alt={preview.name}
                  width={96}
                  height={96}
                  className="pixelated"
                />
                <div className="flex flex-col gap-1">
                  <CardTitle>#{preview.pokeApiId} {formatName(preview.name)}</CardTitle>
                  <div className="flex gap-1 flex-wrap">
                    {preview.types.map((t) => (
                      <Badge key={t} variant="secondary">{t}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {confirmError && (
                <p className="text-sm text-destructive mb-3">{confirmError}</p>
              )}
              <Button
                onClick={handleConfirm}
                disabled={confirming}
                className="w-full min-h-11"
              >
                {confirming
                  ? 'Choosing…'
                  : `Choose ${formatName(preview.name)} as my starter`}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
