import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const API = import.meta.env.VITE_API_URL;

// ── Shared helpers (same as DashboardPage) ──────────────────────────────────

const TYPE_BG: Record<string, string> = {
  normal:   'bg-stone-400',   fire:     'bg-orange-500',
  water:    'bg-blue-500',    electric: 'bg-yellow-400',
  grass:    'bg-green-500',   ice:      'bg-cyan-300',
  fighting: 'bg-red-700',     poison:   'bg-purple-500',
  ground:   'bg-yellow-600',  flying:   'bg-indigo-300',
  psychic:  'bg-pink-500',    bug:      'bg-lime-500',
  rock:     'bg-yellow-700',  ghost:    'bg-purple-700',
  dragon:   'bg-indigo-600',  dark:     'bg-gray-700',
  steel:    'bg-slate-400',   fairy:    'bg-pink-300',
};

type PartyMember = {
  _id: string;
  speciesId: number;
  nickname: string | null;
  level: number;
  currentHp: number;
  maxHp: number | null;
  gender: 'male' | 'female' | 'none';
  statusCondition: string | null;
  partySlot: number | null;
  speciesName: string | null;
  types: string[];
};

function formatName(name: string): string {
  return name
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

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

// ── SortableCard ─────────────────────────────────────────────────────────────
// Each party member is wrapped in this component. It calls useSortable() which
// hands us the CSS transform (how far to visually shift the card while dragging)
// and event listeners (which element starts the drag when grabbed).

function SortableCard({ pokemon, slot }: { pokemon: PartyMember; slot: number }) {
  const {
    attributes,   // ARIA attributes for accessibility (role, aria-roledescription, etc.)
    listeners,    // Pointer/touch event handlers — we put these on the grip icon only
    setNodeRef,   // Callback ref — attach to the root DOM element so dnd-kit can track it
    transform,    // {x, y, scaleX, scaleY} — how far this card has moved during the drag
    transition,   // CSS transition string — smooth animation when other cards shift out of the way
    isDragging,   // True while this specific card is being dragged
  } = useSortable({ id: pokemon._id });

  // CSS.Transform.toString converts the {x,y} object into a CSS translate() string
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // While dragging, raise the card above others so it doesn't clip behind them
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  const displayName = pokemon.nickname
    ? formatName(pokemon.nickname)
    : pokemon.speciesName
      ? formatName(pokemon.speciesName)
      : `#${pokemon.speciesId}`;

  return (
    // setNodeRef + style go on the root element — dnd-kit measures this for collision detection
    <div ref={setNodeRef} style={style} className="flex items-center gap-2">

      {/* Slot number — visual only */}
      <span className="text-xs font-mono text-muted-foreground w-4 shrink-0 text-center">
        {slot}
      </span>

      {/*
        The grip icon is the drag handle. listeners go here (not on the whole card) so
        that tapping the card to navigate still works — only the grip starts a drag.
        attributes also go here so screen readers announce it as a drag handle.
      */}
      <button
        {...listeners}
        {...attributes}
        className="touch-none cursor-grab active:cursor-grabbing p-1 text-muted-foreground shrink-0 min-h-11 min-w-11 flex items-center justify-center"
        aria-label={`Drag to reorder ${displayName}`}
      >
        <GripVertical size={18} />
      </button>

      {/* The card itself is a Link — tap anywhere except the handle to navigate */}
      <Link to={`/pokemon/${pokemon._id}`} className="flex-1 min-w-0">
        <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
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
                  <span className="text-xs text-muted-foreground">
                    ({formatName(pokemon.speciesName)})
                  </span>
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
        </Card>
      </Link>
    </div>
  );
}

// ── PartyPage ────────────────────────────────────────────────────────────────

export default function PartyPage() {
  const { token } = useAuth();
  const [party, setParty]     = useState<PartyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    axios
      .get(`${API}/api/pokemon/party`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then(res => setParty(res.data.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  // PointerSensor handles both mouse clicks and touch events.
  // activationConstraint means the drag only starts after moving 8px —
  // this prevents accidental drags when the user just taps the handle.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    // active = the card that was dragged; over = the card it was dropped on top of.
    // If they're the same (user picked up and put down without moving), do nothing.
    if (!over || active.id === over.id) return;

    setParty(prev => {
      const oldIndex = prev.findIndex(p => p._id === active.id);
      const newIndex = prev.findIndex(p => p._id === over.id);

      // arrayMove returns a new array with the item moved to its new position
      const reordered = arrayMove(prev, oldIndex, newIndex);

      // Optimistic update: update local state immediately so the UI feels instant,
      // then fire the API call in the background. If it fails, show an error.
      const order = reordered.map(p => p._id);
      setSaveError(null);
      axios
        .patch(
          `${API}/api/pokemon/party/reorder`,
          { order },
          { headers: { Authorization: `Bearer ${token}` } }
        )
        .catch(() => setSaveError('Failed to save order — please try again.'));

      return reordered;
    });
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-6">

        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="text-sm text-muted-foreground underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-bold">Party</h1>
        </div>

        {loading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {!loading && party.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Your party is empty.{' '}
            <Link to="/starter" className="underline">Pick a starter</Link>.
          </p>
        )}

        {saveError && (
          <p className="text-sm text-destructive">{saveError}</p>
        )}

        {!loading && party.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground -mt-2">
              Drag the <GripVertical className="inline" size={14} /> handle to reorder. Tap a card to view details.
            </p>

            {/*
              DndContext is the top-level drag coordinator.
              - sensors: how drag gestures are detected
              - collisionDetection: the algorithm that decides which item you're hovering over.
                closestCenter works well for lists — it picks the item whose center point is
                nearest to your pointer.
              - onDragEnd: called once when the user releases
            */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              {/*
                SortableContext tells dnd-kit the ordered list of IDs. It must receive the IDs
                in the same order as the rendered items — this is how it knows what moved where.
              */}
              <SortableContext
                items={party.map(p => p._id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-2">
                  {party.map((p, i) => (
                    <SortableCard key={p._id} pokemon={p} slot={i + 1} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </>
        )}

      </div>
    </div>
  );
}
