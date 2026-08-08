import { NATURES } from './statCalc';
import { mintItemId } from './itemData';

// ---------------------------------------------------------------------------
// Hardcoded Pokémart price catalog. Hand-sourced from Bulbapedia (not a
// mechanical PokeAPI sweep — PokeAPI's `cost`/`prices` fields are effectively
// unpopulated for almost every item, confirmed by testing live). Prices are
// the standard/most common canonical Pokédollar value across generations
// where an item is genuinely sold in a mainline Poké Mart.
//
// Only items with a real, sourced number appear here. Most held-type items,
// most novelty Poké Balls, Rare Candy, PP Max, and the Elixir line are never
// sold in any mainline Poké Mart (confirmed on Bulbapedia, not assumed) and
// are intentionally absent — they stay DM-give-only via the existing item
// tools, exactly like Master Ball already is.
//
// A few items got a real number from a non-standard source rather than a
// regular Mart, called out inline:
//   - Ether / Max Revive / PP Up: only ever sold in B2W2's "Join Avenue"
//     shop, not a normal Mart, but it's a real published price.
//   - Berries and Blue/Yellow Flute: never sold anywhere, but per project
//     decision are priced flat at 50 so a TTRPG Pokémart can still offer
//     them (real games only give them a sell price, never a buy price).
// green-flute and poke-flute are excluded entirely: green-flute isn't a
// real Pokémon item (no PokeAPI/Bulbapedia entry — likely invented in
// milestone 2.6), and poke-flute is a pure story/key item with no price in
// either direction in any game.
//
// Sell price is never stored — it's always derived: half the buy price,
// floored, minimum 1 (see getSellPrice below).
//
// Mints are a project addition (not a real held item), so there's no
// Bulbapedia price to source — flat 1500 for all 25 per project decision.
// Generated from NATURES/mintItemId rather than hand-typed, same reasoning
// as mints being resolved by itemId pattern instead of an exhaustive table.
// ---------------------------------------------------------------------------

const MINT_PRICE = 1500;
const MINT_PRICES: Record<string, number> = Object.fromEntries(
  NATURES.map(nature => [mintItemId(nature), MINT_PRICE]),
);

export const SHOP_PRICES: Record<string, number> = {
  // ── Healing ──────────────────────────────────────────────────────────────
  'potion':         300,
  'super-potion':   700,
  'hyper-potion':   1200,
  'max-potion':     2500,
  'full-restore':   3000,
  'revive':         1500,
  'max-revive':     5000,  // Join Avenue (B2W2) — no regular Mart sells it

  // ── Status cures ─────────────────────────────────────────────────────────
  'antidote':       100,
  'parlyz-heal':    200,
  'burn-heal':      250,
  'ice-heal':       250,
  'awakening':      250,
  'full-heal':      600,
  'blue-flute':     50,   // never sold in any game; flat project price
  'yellow-flute':   50,   // never sold in any game; flat project price

  // ── PP recovery ───────────────────────────────────────────────────────────
  'ether':          1500, // Join Avenue (B2W2) — no regular Mart sells it

  // ── Stat boosters ─────────────────────────────────────────────────────────
  'hp-up':          9800,
  'protein':        9800,
  'iron':           9800,
  'calcium':        9800,
  'zinc':           9800,
  'carbos':         9800,
  'pp-up':          12500, // Join Avenue (B2W2) — no regular Mart sells it

  // ── Poké Balls ────────────────────────────────────────────────────────────
  'poke-ball':      200,
  'great-ball':     600,
  'ultra-ball':     1200,
  'net-ball':       1000,
  'nest-ball':      1000,
  'repeat-ball':    1000,
  'timer-ball':     1000,
  'luxury-ball':    1000,
  'dusk-ball':      1000,
  'heal-ball':      300,
  'quick-ball':     1000,
  'dive-ball':      1000,

  // ── Escape ────────────────────────────────────────────────────────────────
  'escape-rope':    550,

  // ── Berries ───────────────────────────────────────────────────────────────
  // Never sold in any mainline game; flat project price per-berry regardless
  // of effect, same "one tab regardless of effect" philosophy as the berry
  // bag pocket itself.
  'oran-berry':     50,
  'sitrus-berry':   50,
  'cheri-berry':    50,
  'chesto-berry':   50,
  'pecha-berry':    50,
  'rawst-berry':    50,
  'aspear-berry':   50,
  'lum-berry':      50,
  'pomeg-berry':    50,
  'kelpsy-berry':   50,
  'qualot-berry':   50,
  'hondew-berry':   50,
  'grepa-berry':    50,
  'tamato-berry':   50,

  // ── Mints ─────────────────────────────────────────────────────────────────
  ...MINT_PRICES,
};

export function getBuyPrice(itemId: string): number | null {
  return SHOP_PRICES[itemId] ?? null;
}

export function getSellPrice(itemId: string): number | null {
  const buy = SHOP_PRICES[itemId];
  if (buy === undefined) return null;
  return Math.max(1, Math.floor(buy / 2));
}
