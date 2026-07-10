import { ItemPocket } from '../models/Item';

// ---------------------------------------------------------------------------
// Canonical itemId → pocket mapping.
// This is the single source of truth for which bag tab each item belongs to.
// Used by the DM give-item endpoint so the DM only needs to know the item slug
// — the server works out the correct pocket automatically.
// ---------------------------------------------------------------------------

const ITEM_POCKET_MAP: Record<string, ItemPocket> = {
  // ── Medicine (healing) ────────────────────────────────────────────────────
  'potion':         'healing',
  'super-potion':   'healing',
  'hyper-potion':   'healing',
  'max-potion':     'healing',
  'full-restore':   'healing',
  'revive':         'healing',
  'max-revive':     'healing',
  'rare-candy':     'healing',

  // ── Status cures ─────────────────────────────────────────────────────────
  'antidote':       'status_cure',
  'parlyz-heal':    'status_cure',
  'burn-heal':      'status_cure',
  'ice-heal':       'status_cure',
  'awakening':      'status_cure',
  'full-heal':      'status_cure',
  'poke-flute':     'status_cure',
  'blue-flute':     'status_cure',
  'green-flute':    'status_cure',
  'yellow-flute':   'status_cure',

  // ── PP recovery ───────────────────────────────────────────────────────────
  'ether':          'pp_recovery',
  'max-ether':      'pp_recovery',
  'elixir':         'pp_recovery',
  'max-elixir':     'pp_recovery',

  // ── Stat boosters (EVs — deferred to Phase 5) ────────────────────────────
  'hp-up':          'stat_booster',
  'protein':        'stat_booster',
  'iron':           'stat_booster',
  'calcium':        'stat_booster',
  'zinc':           'stat_booster',
  'carbos':         'stat_booster',
  'pp-up':          'stat_booster',
  'pp-max':         'stat_booster',

  // ── Held-type items ───────────────────────────────────────────────────────
  'charcoal':       'held_type',
  'mystic-water':   'held_type',
  'magnet':         'held_type',
  'miracle-seed':   'held_type',
  'never-melt-ice': 'held_type',
  'spell-tag':      'held_type',
  'twisted-spoon':  'held_type',
  'black-belt':     'held_type',
  'poison-barb':    'held_type',
  'soft-sand':      'held_type',
  'hard-stone':     'held_type',
  'silver-powder':  'held_type',
  'sharp-beak':     'held_type',
  'dragon-fang':    'held_type',
  'black-glasses':  'held_type',
  'silk-scarf':     'held_type',
  'metal-coat':     'held_type',

  // ── Poké Balls ────────────────────────────────────────────────────────────
  'poke-ball':      'pokeballs',
  'great-ball':     'pokeballs',
  'ultra-ball':     'pokeballs',
  'master-ball':    'pokeballs',
  'safari-ball':    'pokeballs',
  'level-ball':     'pokeballs',
  'lure-ball':      'pokeballs',
  'moon-ball':      'pokeballs',
  'friend-ball':    'pokeballs',
  'love-ball':      'pokeballs',
  'heavy-ball':     'pokeballs',
  'fast-ball':      'pokeballs',
  'sport-ball':     'pokeballs',
  'premier-ball':   'pokeballs',
  'repeat-ball':    'pokeballs',
  'timer-ball':     'pokeballs',
  'nest-ball':      'pokeballs',
  'net-ball':       'pokeballs',
  'dive-ball':      'pokeballs',
  'luxury-ball':    'pokeballs',
  'heal-ball':      'pokeballs',
  'quick-ball':     'pokeballs',
  'dusk-ball':      'pokeballs',
  'dream-ball':     'pokeballs',
  'beast-ball':     'pokeballs',
  'cherish-ball':   'pokeballs',

  // ── Escape ────────────────────────────────────────────────────────────────
  'escape-rope':    'escape',

  // ── Berries ───────────────────────────────────────────────────────────────
  // All berries share one bag tab regardless of what they do (healing,
  // status cure, or EV reduction) — this is the single source of truth,
  // so their in-battle effects (BATTLE_ITEM_EFFECTS below) are unaffected.
  'oran-berry':     'berry',
  'sitrus-berry':   'berry',
  'cheri-berry':    'berry',
  'chesto-berry':   'berry',
  'pecha-berry':    'berry',
  'rawst-berry':    'berry',
  'aspear-berry':   'berry',
  'lum-berry':      'berry',

  // EV-reducing berries — one per stat, -10 EV per use (main-game amount)
  'pomeg-berry':    'berry', // HP
  'kelpsy-berry':   'berry', // Attack
  'qualot-berry':   'berry', // Defense
  'hondew-berry':   'berry', // Sp. Attack
  'grepa-berry':    'berry', // Sp. Defense
  'tamato-berry':   'berry', // Speed
};

/**
 * Returns the correct bag pocket for a given PokeAPI item slug,
 * or null if the item isn't in the supported list.
 */
export function getPocket(itemId: string): ItemPocket | null {
  return ITEM_POCKET_MAP[itemId] ?? null;
}

// ---------------------------------------------------------------------------
// Battle item effects
// Mirrors the relevant entries in items.ts ITEM_EFFECTS.
// ---------------------------------------------------------------------------

export type BattleItemEffect =
  | { kind: 'hp_flat';      amount: number }
  | { kind: 'hp_full' }
  | { kind: 'hp_full_cure' }
  | { kind: 'revive';       amount: 'half' | 'full' }
  | { kind: 'status_cure';  cures: string[] | 'all' };

export const BATTLE_ITEM_EFFECTS: Record<string, BattleItemEffect> = {
  'potion':         { kind: 'hp_flat',     amount: 20 },
  'super-potion':   { kind: 'hp_flat',     amount: 60 },
  'hyper-potion':   { kind: 'hp_flat',     amount: 120 },
  'max-potion':     { kind: 'hp_full' },
  'full-restore':   { kind: 'hp_full_cure' },
  'revive':         { kind: 'revive',      amount: 'half' },
  'max-revive':     { kind: 'revive',      amount: 'full' },
  'oran-berry':     { kind: 'hp_flat',     amount: 10 },
  'sitrus-berry':   { kind: 'hp_flat',     amount: 25 },
  'antidote':       { kind: 'status_cure', cures: ['poison', 'toxic'] },
  'parlyz-heal':    { kind: 'status_cure', cures: ['paralysis'] },
  'burn-heal':      { kind: 'status_cure', cures: ['burn'] },
  'ice-heal':       { kind: 'status_cure', cures: ['freeze'] },
  'awakening':      { kind: 'status_cure', cures: ['sleep'] },
  'full-heal':      { kind: 'status_cure', cures: 'all' },
  'cheri-berry':    { kind: 'status_cure', cures: ['paralysis'] },
  'chesto-berry':   { kind: 'status_cure', cures: ['sleep'] },
  'pecha-berry':    { kind: 'status_cure', cures: ['poison', 'toxic'] },
  'rawst-berry':    { kind: 'status_cure', cures: ['burn'] },
  'aspear-berry':   { kind: 'status_cure', cures: ['freeze'] },
  'lum-berry':      { kind: 'status_cure', cures: 'all' },
  'poke-flute':     { kind: 'status_cure', cures: ['sleep'] },
  'blue-flute':     { kind: 'status_cure', cures: ['sleep'] },
  'green-flute':    { kind: 'status_cure', cures: ['sleep'] },
};

// ---------------------------------------------------------------------------
// Catch mechanics
// ---------------------------------------------------------------------------

// Static ball catch-rate multipliers. Context-dependent balls (quick, timer,
// nest, net) are computed at resolution time using battle/Pokémon state.
export const BALL_MODIFIERS: Record<string, number> = {
  'ultra-ball':  2.0,
  'great-ball':  1.5,
  'dive-ball':   2.0,
  'dusk-ball':   2.0,
  'dream-ball':  4.0,
  'beast-ball':  0.1,
};

export function statusCatchModifier(status: string | null): number {
  if (status === 'sleep' || status === 'freeze') return 2.5;
  if (['paralysis', 'burn', 'poison', 'toxic'].includes(status ?? '')) return 1.5;
  return 1.0;
}
