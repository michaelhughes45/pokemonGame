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

  // ── Arceus type Plates (milestone 5.17a) ──────────────────────────────────
  // Mechanically identical to the type-boost items above (1.2x same-type move
  // power via @smogon/calc's own getItemBoostType) — one per non-Normal type,
  // so they slot into the same held_type pocket rather than a new one.
  'draco-plate':    'held_type', // Dragon
  'dread-plate':    'held_type', // Dark
  'earth-plate':    'held_type', // Ground
  'fist-plate':     'held_type', // Fighting
  'flame-plate':    'held_type', // Fire
  'icicle-plate':   'held_type', // Ice
  'insect-plate':   'held_type', // Bug
  'iron-plate':     'held_type', // Steel
  'meadow-plate':   'held_type', // Grass
  'mind-plate':     'held_type', // Psychic
  'pixie-plate':    'held_type', // Fairy
  'sky-plate':      'held_type', // Flying
  'splash-plate':   'held_type', // Water
  'spooky-plate':   'held_type', // Ghost
  'stone-plate':    'held_type', // Rock
  'toxic-plate':    'held_type', // Poison
  'zap-plate':      'held_type', // Electric

  // ── Competitive held items (milestone 5.17b) ──────────────────────────────
  // Separate pocket from held_type since these are battle-flow items (end-of-
  // round effects, move-choice locking, one-time triggers), not pure damage-
  // formula type boosters. Most of the damage-relevant ones (Choice items'
  // 1.5x, Life Orb's 1.3x, Eviolite/Assault Vest's 1.5x defensive boost,
  // Expert Belt's 1.2x) need no project code at all beyond this registration —
  // @smogon/calc already applies them internally once heldItem reaches
  // CalcPokemon (5.17a). DM-give-only, like Master Ball — not in the wild/NPC
  // random-drop pool (rollHeldItem below), which stays scoped to the held_type
  // pocket (34 items as of 5.17a's Plates) + mints.
  'leftovers':      'held_battle',
  'black-sludge':   'held_battle',
  'choice-band':    'held_battle',
  'choice-specs':   'held_battle',
  'choice-scarf':   'held_battle',
  'life-orb':       'held_battle',
  'focus-sash':     'held_battle',
  'assault-vest':   'held_battle',
  'eviolite':       'held_battle',
  'expert-belt':    'held_battle',

  // ── Evolution items (milestone 5.17c) ─────────────────────────────────────
  // Real PokeAPI 'use-item' evolution triggers, verified live against PokeAPI
  // (not guessed) — each itemId is the exact slug PokeAPI's evolution_details
  // uses, which is also exactly what canEvolveWithItem (lib/evolution.ts)
  // matches against. King's Rock and other trade-required evolution items are
  // deliberately excluded — this project has no trade system (same reasoning
  // as every other trade-only mechanic being out of scope). Consumed on use,
  // out-of-battle only, same convention as Rare Candy/mints — not "held".
  'fire-stone':       'evolution',
  'water-stone':      'evolution',
  'thunder-stone':    'evolution',
  'leaf-stone':       'evolution',
  'moon-stone':       'evolution',
  'sun-stone':        'evolution',
  'shiny-stone':      'evolution',
  'dusk-stone':       'evolution',
  'dawn-stone':       'evolution', // gender-gated: Kirlia (male) / Snorunt (female) — see canEvolveWithItem
  'ice-stone':        'evolution',
  'sweet-apple':      'evolution',
  'tart-apple':       'evolution',
  'syrupy-apple':     'evolution',
  'auspicious-armor': 'evolution',
  'malicious-armor':  'evolution',

  // ── Consumable battle stat-boosters (milestone 5.17d) ─────────────────────
  // Real PokeAPI 'stat-boosts' item category. X items and Dire Hit raise 2
  // stages (not the 1 stage PokeAPI's own generic effect_entries text still
  // describes) — a Gen 6+ buff, same "pick the modern generation's numbers"
  // judgment call already made for Exp. Share and TM/HM (see Key Decisions).
  'x-attack':   'battle_boost',
  'x-defense':  'battle_boost',
  'x-sp-atk':   'battle_boost',
  'x-sp-def':   'battle_boost',
  'x-speed':    'battle_boost',
  'x-accuracy': 'battle_boost',
  'dire-hit':   'battle_boost',
  'guard-spec': 'battle_boost',

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

// Exported in milestone 6.8 so campaignController's held-item-catalog endpoint
// can list the same pool this function draws from, without redriving the
// ITEM_POCKET_MAP filter a second time.
export const HELD_TYPE_ITEMS: string[] = Object.entries(ITEM_POCKET_MAP)
  .filter(([, pocket]) => pocket === 'held_type')
  .map(([itemId]) => itemId);

export const MINT_ITEMS: string[] = NATURES.map(mintItemId);

// Half the time a wild/NPC Pokémon holds nothing at all, matching the real
// games' held-item rates loosely without needing a per-species table.
const NO_ITEM_CHANCE = 0.5;

/**
 * Rolls a random held item for a newly-created NPC or wild Pokémon, or null
 * for "holding nothing". `includeMints` should be true for anything that can
 * actually drop its held item (wild-type NPCs, standalone wild spawns) and
 * false for trainer-type NPCs, whose held items are flavor-only and never
 * transfer to a player.
 *
 * `eligibleIds` (milestone 6.8) is the DM-curated subset from
 * Campaign.randomHeldItemIds — undefined/null (the uncurated default) uses
 * the full pool unfiltered, matching every pre-6.8 call site's behavior
 * exactly; an explicit array (including an empty one) filters the pool down
 * to it, so a DM who's curated the pool down to nothing correctly gets
 * nothing rather than falling back to "unfiltered."
 */
export function rollHeldItem(includeMints: boolean, eligibleIds?: string[] | null): string | null {
  if (Math.random() < NO_ITEM_CHANCE) return null;
  const fullPool = includeMints ? [...HELD_TYPE_ITEMS, ...MINT_ITEMS] : HELD_TYPE_ITEMS;
  const pool = eligibleIds == null ? fullPool : fullPool.filter(id => eligibleIds.includes(id));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Fling base power (milestone 5.14 Wave 12; Plates added 5.17a) — real values
// sourced from Bulbapedia/Serebii's Fling item-power tables, verified per-item
// (never guessed) same as every other real-item value in this project.
// Poison Barb additionally poisons the target on a successful Fling hit — the
// one real Fling secondary effect among the items this project supports.
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
  // Every type Plate shares the same real Fling power (Bulbapedia).
  'draco-plate':    90,
  'dread-plate':    90,
  'earth-plate':    90,
  'fist-plate':     90,
  'flame-plate':    90,
  'icicle-plate':   90,
  'insect-plate':   90,
  'iron-plate':     90,
  'meadow-plate':   90,
  'mind-plate':     90,
  'pixie-plate':    90,
  'sky-plate':      90,
  'splash-plate':   90,
  'spooky-plate':   90,
  'stone-plate':    90,
  'toxic-plate':    90,
  'zap-plate':      90,
  // Competitive held items (milestone 5.17b) — real values from Bulbapedia,
  // cross-checked against @smogon/calc's own Fling table.
  'leftovers':      10,
  'choice-band':    10,
  'choice-specs':   10,
  'choice-scarf':   10,
  'focus-sash':     10,
  'expert-belt':    10,
  'black-sludge':   30,
  'life-orb':       30,
  'assault-vest':   80,
  'eviolite':       40,
};

// Choice Band/Specs/Scarf (milestone 5.17b) — the 1.5x damage boost itself is
// free from @smogon/calc once heldItem reaches CalcPokemon (5.17a); the
// move-choice lock is this project's own code (see submitTarget in
// battleController.ts), reusing this set to identify a Choice item by name.
export const CHOICE_ITEMS = new Set(['choice-band', 'choice-specs', 'choice-scarf']);

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
  | { kind: 'status_cure';  cures: string[] | 'all' }
  // X items (milestone 5.17d) — stat is one of StatStages' keys (atk/def/spa/
  // spd/spe/acc); target is always the item's own recipient (self).
  | { kind: 'stat_stage';   stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc'; stages: number }
  // Dire Hit — identical effect to the move Focus Energy (+2 crit stages),
  // reuses that exact volatile so all existing crit-stage logic applies for free.
  | { kind: 'crit_boost' }
  // Guard Spec — identical effect to the move Mist for the WHOLE team (5
  // turns), reuses that exact fieldConditions entry so all existing Mist
  // logic (blocks incoming negative stat changes) applies for free.
  | { kind: 'guard_spec' };

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

  // ── Consumable battle stat-boosters (milestone 5.17d) ─────────────────────
  'x-attack':   { kind: 'stat_stage', stat: 'atk', stages: 2 },
  'x-defense':  { kind: 'stat_stage', stat: 'def', stages: 2 },
  'x-sp-atk':   { kind: 'stat_stage', stat: 'spa', stages: 2 },
  'x-sp-def':   { kind: 'stat_stage', stat: 'spd', stages: 2 },
  'x-speed':    { kind: 'stat_stage', stat: 'spe', stages: 2 },
  'x-accuracy': { kind: 'stat_stage', stat: 'acc', stages: 2 },
  'dire-hit':   { kind: 'crit_boost' },
  'guard-spec': { kind: 'guard_spec' },
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
