export function HpBar({ current, max }: { current: number; max: number | null }) {
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
