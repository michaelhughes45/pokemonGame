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
  'oran-berry':     'healing',
  'sitrus-berry':   'healing',
  'rare-candy':     'healing',

  // ── Status cures ─────────────────────────────────────────────────────────
  'antidote':       'status_cure',
  'parlyz-heal':    'status_cure',
  'burn-heal':      'status_cure',
  'ice-heal':       'status_cure',
  'awakening':      'status_cure',
  'full-heal':      'status_cure',
  'cheri-berry':    'status_cure',
  'chesto-berry':   'status_cure',
  'pecha-berry':    'status_cure',
  'rawst-berry':    'status_cure',
  'aspear-berry':   'status_cure',
  'lum-berry':      'status_cure',
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
};

/**
 * Returns the correct bag pocket for a given PokeAPI item slug,
 * or null if the item isn't in the supported list.
 */
export function getPocket(itemId: string): ItemPocket | null {
  return ITEM_POCKET_MAP[itemId] ?? null;
}
