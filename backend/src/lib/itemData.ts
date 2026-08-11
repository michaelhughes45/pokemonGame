import { ItemPocket } from '../models/Item';
import { NATURES } from './statCalc';

// ---------------------------------------------------------------------------
// Canonical itemId → pocket mapping.
// This is the single source of truth for which bag tab each item belongs to.
// Used by the DM give-item endpoint so the DM only needs to know the item slug
// — the server works out the correct pocket automatically.
// ---------------------------------------------------------------------------

export const ITEM_POCKET_MAP: Record<string, ItemPocket> = {
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
 *
 * TM/HM items aren't hardcoded like every other item here — there are
 * hundreds of possible moves, so any itemId of the form "tm-<moveId>" is
 * recognised by pattern instead of an exhaustive map entry. Whether the
 * move itself is a real TM/HM (not just any move) is validated separately
 * against the catalog in lib/tmHmData.ts. Mints follow the same pattern
 * ("mint-<nature>") since the nature is already encoded in the itemId.
 */
export function getPocket(itemId: string): ItemPocket | null {
  if (itemId.startsWith('tm-')) return 'tm_hm';
  if (itemId.startsWith('mint-')) return 'mint';
  return ITEM_POCKET_MAP[itemId] ?? null;
}

/**
 * Extracts the move slug from a TM/HM itemId ("tm-flamethrower" -> "flamethrower"),
 * or null if itemId isn't in that shape.
 */
export function moveIdFromTmItem(itemId: string): string | null {
  return itemId.startsWith('tm-') ? itemId.slice(3) : null;
}

/**
 * Builds the itemId for a given nature's mint, e.g. "Bold" -> "mint-bold".
 */
export function mintItemId(nature: string): string {
  return `mint-${nature.toLowerCase()}`;
}

/**
 * Extracts and validates the nature from a mint itemId ("mint-bold" -> "Bold"),
 * or null if itemId isn't a real mint for one of the 25 natures.
 */
export function natureFromMintItem(itemId: string): string | null {
  if (!itemId.startsWith('mint-')) return null;
  const slug = itemId.slice(5);
  return NATURES.find(n => n.toLowerCase() === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Random held item assignment (milestone 5.12)
// Wild-owned Pokémon (Npc.type:'wild' parties and standalone wild-battle
// spawns) can drop their held item to the player that faints them; trainer
// NPCs' held items never drop and are flavor only. Mints only ever matter as
// a drop (they have no passive effect while merely "held"), so they're only
// in the pool for sources that can actually drop — never for trainer NPCs.
// ---------------------------------------------------------------------------

const HELD_TYPE_ITEMS: string[] = Object.entries(ITEM_POCKET_MAP)
  .filter(([, pocket]) => pocket === 'held_type')
  .map(([itemId]) => itemId);

const MINT_ITEMS: string[] = NATURES.map(mintItemId);

// Half the time a wild/NPC Pokémon holds nothing at all, matching the real
// games' held-item rates loosely without needing a per-species table.
const NO_ITEM_CHANCE = 0.5;

/**
 * Rolls a random held item for a newly-created NPC or wild Pokémon, or null
 * for "holding nothing". `includeMints` should be true for anything that can
 * actually drop its held item (wild-type NPCs, standalone wild spawns) and
 * false for trainer-type NPCs, whose held items are flavor-only and never
 * transfer to a player.
 */
export function rollHeldItem(includeMints: boolean): string | null {
  if (Math.random() < NO_ITEM_CHANCE) return null;
  const pool = includeMints ? [...HELD_TYPE_ITEMS, ...MINT_ITEMS] : HELD_TYPE_ITEMS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Fling base power (milestone 5.14 Wave 12) — real values sourced from
// Bulbapedia/Serebii's Fling item-power tables, verified per-item (never
// guessed) same as every other real-item value in this project. Only the 17
// held_type items are covered, since heldItem is only ever populated with one
// of those (or a mint) by this project's item system. Poison Barb additionally
// poisons the target on a successful Fling hit — the one real Fling secondary
// effect among the items this project supports.
// ---------------------------------------------------------------------------

export const FLING_POWER: Record<string, number> = {
  'charcoal':       30,
  'mystic-water':   30,
  'magnet':         30,
  'miracle-seed':   30,
  'never-melt-ice': 30,
  'spell-tag':      30,
  'twisted-spoon':  30,
  'black-belt':     30,
  'black-glasses':  30,
  'metal-coat':     30,
  'silk-scarf':     10,
  'silver-powder':  10,
  'soft-sand':      10,
  'sharp-beak':     50,
  'dragon-fang':    70,
  'poison-barb':    70,
  'hard-stone':     100,
};

// Mints are a project-invented item type (Key Decision, milestone 5.12) with no
// real Fling value to source — flat low fallback, same "no real equivalent, flat
// project decision" treatment as their Pokémart price.
const MINT_FLING_POWER = 10;

export function getFlingPower(itemId: string): number | null {
  if (itemId.startsWith('mint-')) return MINT_FLING_POWER;
  return FLING_POWER[itemId] ?? null;
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
