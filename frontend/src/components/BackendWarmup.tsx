import { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';

const API = import.meta.env.VITE_API_URL;

// Render's free tier spins the backend down after 15 min idle; the first
// request afterward can take 30-50s to come back while it boots. Rather than
// leave a visitor staring at a blank/frozen page (which reads as "broken"),
// this gates the whole app behind one /health ping and shows a friendly
// message once the wait has gone on long enough to actually notice.
const BANNER_DELAY_MS = 1500;
const RETRY_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 90000;

type Status = 'checking' | 'awake' | 'timedOut';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function BackendWarmup({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [showBanner, setShowBanner] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setShowBanner(false);
    const bannerTimer = setTimeout(() => { if (!cancelled) setShowBanner(true); }, BANNER_DELAY_MS);

    async function pingUntilAwake() {
      const start = Date.now();
      while (!cancelled && Date.now() - start < MAX_WAIT_MS) {
        try {
          await axios.get(`${API}/health`, { timeout: 15000 });
          if (!cancelled) setStatus('awake');
          return;
        } catch {
          await sleep(RETRY_INTERVAL_MS);
        }
      }
      if (!cancelled) setStatus('timedOut');
    }

    pingUntilAwake();
    return () => { cancelled = true; clearTimeout(bannerTimer); };
  }, [retryKey]);

  if (status === 'awake') return <>{children}</>;

  if (!showBanner) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl text-center">
            {status === 'timedOut' ? 'Still waking up…' : 'Waking up the server'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 items-center text-center">
          <p className="text-sm text-muted-foreground">
            {status === 'timedOut'
              ? "This is taking longer than usual. It's hosted on a free tier that sleeps when idle — try again in a moment."
              : "This app is hosted on a free tier that sleeps after inactivity. It can take up to a minute to spin back up — thanks for your patience!"}
          </p>
          {status === 'timedOut' && (
            <Button size="sm" onClick={() => { setStatus('checking'); setRetryKey(k => k + 1); }}>
              Try again
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
