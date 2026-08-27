import { StatStages } from '../models/Battle';
import { WEATHER_MOVES } from './weatherData';
import { TERRAIN_MOVES } from './terrainData';

export type StatusMoveEffect = {
  status: 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic' | 'confusion';
  chance: number; // 0–1
};

// Moves that inflict a status condition, either as their primary effect (chance 1)
// or as a secondary effect on damage moves. Keyed by PokeAPI move slug.
export const STATUS_MOVES: Record<string, StatusMoveEffect> = {
  // Paralysis
  'thunder-wave':       { status: 'paralysis', chance: 1 },
  'glare':              { status: 'paralysis', chance: 1 },
  'stun-spore':         { status: 'paralysis', chance: 1 },
  'nuzzle':             { status: 'paralysis', chance: 1 },
  'zap-cannon':         { status: 'paralysis', chance: 1 },
  'body-slam':          { status: 'paralysis', chance: 0.3 },
  'thunder':            { status: 'paralysis', chance: 0.3 },
  'thunderbolt':        { status: 'paralysis', chance: 0.1 },
  'discharge':          { status: 'paralysis', chance: 0.3 },
  'spark':              { status: 'paralysis', chance: 0.3 },
  'volt-tackle':        { status: 'paralysis', chance: 0.1 },
  'bounce':             { status: 'paralysis', chance: 0.3 },
  'bolt-strike':        { status: 'paralysis', chance: 0.2 },
  'buzzy-buzz':         { status: 'paralysis', chance: 1 },
  'dragon-breath':      { status: 'paralysis', chance: 0.3 },
  'force-palm':         { status: 'paralysis', chance: 0.3 },
  'freeze-shock':       { status: 'paralysis', chance: 0.3 }, // Ice-type but paralyzes, not freezes — matches 'bounce' (Flying) below, a real Pokémon type/effect mismatch
  'lick':               { status: 'paralysis', chance: 0.3 },
  'splishy-splash':     { status: 'paralysis', chance: 0.3 },
  'stoked-sparksurfer': { status: 'paralysis', chance: 1 },
  'thunder-fang':       { status: 'paralysis', chance: 0.1 },
  'thunder-punch':      { status: 'paralysis', chance: 0.1 },
  'thunder-shock':      { status: 'paralysis', chance: 0.1 },
  // Burn
  'will-o-wisp':     { status: 'burn', chance: 1 },
  'ember':           { status: 'burn', chance: 0.1 },
  'flamethrower':    { status: 'burn', chance: 0.1 },
  'fire-blast':      { status: 'burn', chance: 0.1 },
  'fire-punch':      { status: 'burn', chance: 0.1 },
  'flame-wheel':     { status: 'burn', chance: 0.1 },
  'blaze-kick':      { status: 'burn', chance: 0.1 },
  'heat-wave':       { status: 'burn', chance: 0.1 },
  'sacred-fire':     { status: 'burn', chance: 0.5 },
  'scald':           { status: 'burn', chance: 0.3 },
  'lava-plume':      { status: 'burn', chance: 0.3 },
  'blue-flare':      { status: 'burn', chance: 0.2 },
  'burning-jealousy': { status: 'burn', chance: 1 }, // Real effect only burns if the target's stats rose this turn; simplified to unconditional, same "close approximation" treatment as other condition-gated secondary effects
  'fire-fang':       { status: 'burn', chance: 0.1 },
  'flare-blitz':     { status: 'burn', chance: 0.1 },
  'ice-burn':        { status: 'burn', chance: 0.3 }, // Fire-type despite the name (Reshiram signature)
  'inferno':         { status: 'burn', chance: 1 },
  'pyro-ball':       { status: 'burn', chance: 0.1 },
  'scorching-sands': { status: 'burn', chance: 0.3 },
  'searing-shot':    { status: 'burn', chance: 0.3 },
  'sizzly-slide':    { status: 'burn', chance: 1 },
  'steam-eruption':  { status: 'burn', chance: 0.3 },
  // Toxic / Poison
  'toxic':         { status: 'toxic',  chance: 1 },
  'poison-powder': { status: 'poison', chance: 1 },
  'poison-gas':    { status: 'poison', chance: 1 },
  'poison-sting':  { status: 'poison', chance: 0.3 },
  'poison-jab':    { status: 'poison', chance: 0.3 },
  'gunk-shot':     { status: 'poison', chance: 0.3 },
  'cross-poison':  { status: 'poison', chance: 0.1 },
  'sludge':        { status: 'poison', chance: 0.3 },
  'sludge-bomb':   { status: 'poison', chance: 0.3 },
  'sludge-wave':   { status: 'poison', chance: 0.1 },
  'poison-fang':   { status: 'poison', chance: 0.5 },
  'poison-tail':   { status: 'poison', chance: 0.1 },
  'shell-side-arm': { status: 'poison', chance: 0.2 },
  'smog':          { status: 'poison', chance: 0.4 },
  'toxic-thread':  { status: 'poison', chance: 1 }, // also lowers the target's Speed — see STAT_STAGE_MOVES
  'twineedle':     { status: 'poison', chance: 0.2 },
  // Sleep
  'hypnosis':      { status: 'sleep', chance: 1 },
  'sleep-powder':  { status: 'sleep', chance: 1 },
  'spore':         { status: 'sleep', chance: 1 },
  'lovely-kiss':   { status: 'sleep', chance: 1 },
  'sing':          { status: 'sleep', chance: 1 },
  'grass-whistle': { status: 'sleep', chance: 1 },
  'dark-void':     { status: 'sleep', chance: 1 },
  // Freeze
  'ice-beam':        { status: 'freeze', chance: 0.1 },
  'blizzard':        { status: 'freeze', chance: 0.1 },
  'ice-punch':       { status: 'freeze', chance: 0.1 },
  'freeze-dry':      { status: 'freeze', chance: 0.1 },
  'powder-snow':     { status: 'freeze', chance: 0.1 },
  'freezing-glare':  { status: 'freeze', chance: 0.1 },
  'ice-fang':        { status: 'freeze', chance: 0.1 },
  // Confusion
  'confuse-ray':   { status: 'confusion', chance: 1 },
  'supersonic':    { status: 'confusion', chance: 1 },
  'sweet-kiss':    { status: 'confusion', chance: 1 },
  'teeter-dance':  { status: 'confusion', chance: 1 },
  'flatter':       { status: 'confusion', chance: 1 },
  'swagger':       { status: 'confusion', chance: 1 },
  'dynamic-punch': { status: 'confusion', chance: 1 }, // fixed from the dead 'dynamicpunch' slug (PokeAPI's real slug is hyphenated) — this 100% confusion had never once fired
  'hurricane':     { status: 'confusion', chance: 0.3 },
  'dizzy-punch':   { status: 'confusion', chance: 0.2 },
  'confusion':     { status: 'confusion', chance: 0.1 },
  'psybeam':       { status: 'confusion', chance: 0.1 },
  'water-pulse':   { status: 'confusion', chance: 0.2 },
  'chatter':       { status: 'confusion', chance: 1 },
  'rock-climb':    { status: 'confusion', chance: 0.2 },
  'signal-beam':   { status: 'confusion', chance: 0.1 },
  'strange-steam': { status: 'confusion', chance: 0.2 },
};

// Non-zero move priority values. Only moves deviating from 0 are listed.
// Values below verified against PokeAPI's live `priority` field (milestone 5.14 Wave 1
// audit) — several pre-existing entries (Protect family, Roar/Whirlwind, Counter/Mirror
// Coat, Trick Room, Revenge/Avalanche, Circle Throw/Dragon Tail) were off by one or two
// brackets from real game values and are corrected here, not just extended.
export const MOVE_PRIORITY: Record<string, number> = {
  // +5
  'helping-hand': 5,
  // +4
  'detect': 4, 'endure': 4, 'protect': 4, 'kings-shield': 4, 'spiky-shield': 4,
  'baneful-bunker': 4, 'obstruct': 4, 'silk-trap': 4, 'burning-bulwark': 4,
  'magic-coat': 4, 'max-guard': 4, 'snatch': 4,
  // +3
  'fake-out': 3, 'quick-guard': 3, 'wide-guard': 3, 'crafty-shield': 3, 'spotlight': 3, 'upper-hand': 3,
  // +2
  'extreme-speed': 2, 'feint': 2, 'first-impression': 2, 'follow-me': 2, 'rage-powder': 2,
  'ally-switch': 2, 'zippy-zap': 2,
  // +1
  'aqua-jet': 1, 'baby-doll-eyes': 1, 'bullet-punch': 1, 'ice-shard': 1,
  'mach-punch': 1, 'quick-attack': 1, 'shadow-sneak': 1, 'sucker-punch': 1,
  'vacuum-wave': 1, 'water-shuriken': 1, 'accelerock': 1, 'bide': 1, 'ion-deluge': 1,
  'jet-punch': 1, 'powder': 1, 'thunderclap': 1,
  // -1
  'vital-throw': -1,
  // -3
  'focus-punch': -3, 'beak-blast': -3, 'shell-trap': -3,
  // -4
  'revenge': -4, 'avalanche': -4,
  // -5
  'counter': -5, 'mirror-coat': -5, 'metal-burst': -5,
  // -6
  'roar': -6, 'whirlwind': -6, 'dragon-tail': -6, 'circle-throw': -6, 'teleport': -6,
  // -7
  'trick-room': -7, 'magic-room': -7, 'wonder-room': -7,
};

// Moves that can cause the target to flinch. Value is flinch chance (0–1).
export const FLINCH_MOVES: Record<string, number> = {
  'air-slash':       0.3,
  'astonish':        0.3,
  'bite':            0.3,
  'bone-club':       0.1,
  'dark-pulse':      0.2,
  'dragon-rush':     0.2,
  'extrasensory':    0.1,
  'fake-out':        1.0,
  'headbutt':        0.3,
  'heart-stamp':     0.3,
  'hyper-fang':      0.1,
  'icicle-crash':    0.3,
  'iron-head':       0.3,
  'needle-arm':      0.3,
  'rock-slide':      0.3,
  'rolling-kick':    0.3,
  'snore':           0.3,
  'stomp':           0.3,
  'twister':         0.2,
  'waterfall':       0.2,
  'zen-headbutt':    0.2,
  'double-iron-bash': 0.3,
  'fiery-wrath':      0.2,
  'fire-fang':        0.1,
  'floaty-fall':      0.3,
  'ice-fang':         0.1,
  'sky-attack':       0.3,
  'steamroller':      0.3,
  'thunder-fang':     0.1,
  'zing-zap':         0.3,
};

// Moves that target only the user (stat boosts, recovery, etc.).
// These require no enemy target — submitting an empty targets array is valid.
export const SELF_TARGETING_MOVES = new Set([
  // Stat boosts
  'swords-dance', 'calm-mind', 'nasty-plot', 'bulk-up', 'iron-defense',
  'amnesia', 'agility', 'barrier', 'cosmic-power', 'growth', 'harden',
  'withdraw', 'defense-curl', 'coil', 'quiver-dance', 'shift-gear',
  'dragon-dance', 'shell-smash', 'geomancy', 'rock-polish', 'autotomize',
  'charge', 'focus-energy', 'meditate', 'sharpen', 'work-up',
  'double-team', 'minimize', 'acid-armor', 'clangorous-soul',
  // Milestone 5.14 Wave 1 additions — 'user-and-allies'-target moves (coaching, gear-up,
  // howl, magnetic-flux) are simplified to apply to the user only, since this project has
  // no generic ally-stat-stacking outside the dedicated ally-targeting moves (Wave 6);
  // no-retreat's trap-lock and tidy-up's hazard-clear are deferred to a later 5.14 wave.
  'coaching', 'cotton-guard', 'defend-order', 'extreme-evoboost', 'gear-up',
  'hone-claws', 'howl', 'magnetic-flux', 'no-retreat', 'tail-glow', 'tidy-up',
  // Fillet Away — costs 1/2 max HP like Belly Drum, see the custom guard in battleController.ts
  'fillet-away',
  // Recovery
  'recover', 'soft-boiled', 'roost', 'moonlight', 'morning-sun',
  'synthesis', 'rest', 'slack-off', 'milk-drink', 'heal-order', 'shore-up',
  // Other self-targeting
  'endure', 'belly-drum', 'substitute', 'ingrain', 'aqua-ring', 'magnet-rise', 'stockpile',
  // Swallow — heals based on the Stockpile count, consuming it (see the dedicated
  // Stockpile/Swallow blocks in battleController.ts). Spit Up is NOT here — it deals
  // damage to a foe and goes through the normal foe-targeting path instead.
  'swallow',
  // Protect family
  'protect', 'detect', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'obstruct',
  'silk-trap', 'burning-bulwark',
  // Side-wide protect (blocks the whole side, not just the user — resolved via
  // Battle.fieldConditions rather than a per-Pokémon volatileStatus)
  'wide-guard', 'quick-guard',
  // Screens + Mist/Safeguard (milestone 5.14 Wave 6) — also side-wide, 5 turns
  'reflect', 'light-screen', 'aurora-veil', 'mist', 'safeguard',
  // Entry hazards (milestone 5.14 Wave 7) — no target picker needed (always land on
  // the whole opposing side), even though they're resolved against the OPPONENT's
  // side rather than the caster's own, unlike every other move in this set.
  'stealth-rock', 'spikes', 'toxic-spikes', 'sticky-web',
  // Perish Song (milestone 5.14 Wave 8) — hits every active Pokémon on BOTH sides,
  // so it's routed here rather than through the (opponent-only) auto-target picker.
  'perish-song',
  // Healing Wish / Lunar Dance (milestone 5.14 Wave 10) — no foe target, faints the
  // user and queues a full heal for whoever's sent in next.
  'healing-wish', 'lunar-dance',
  // Room effects (field-wide, 5 turns, toggled off if used again while active —
  // also resolved via Battle.fieldConditions, see ROOM_MOVES below)
  'trick-room', 'magic-room', 'wonder-room',
  // Redirect (self-buff; the redirect effect itself is checked when OTHER moves target)
  'follow-me', 'rage-powder',
  // Self type-change (milestone 5.14 Wave 11) — Conversion/Camouflage/Conversion 2 change
  // the USER's own type, no target needed. Soak and Reflect Type are NOT here — both are
  // opponent-directed (Soak changes the TARGET's type, Reflect Type copies the TARGET's
  // type onto the user) and go through the normal foe-targeting path instead.
  'conversion', 'camouflage', 'conversion-2',
  // Recycle (milestone 5.14 Wave 12) — restores the user's own last-lost held item, no
  // target needed. Trick/Switcheroo/Knock Off/Thief/Covet/Bestow/Fling are NOT here —
  // all seven act on/steal from/give to a foe and go through the normal foe-targeting path.
  'recycle',
  // Sport moves — field-wide (not side-specific, unlike Reflect/Screens), no target
  // needed. See SPORT_MOVES below.
  'mud-sport', 'water-sport',
  // Milestone 6.9 — field/side-wide moves with no real foe target, same reasoning as
  // the groups above. Wide Guard/Quick Guard-style single-round side guard: mat-block.
  // Screens-style multi-turn side buff: tailwind, lucky-chant. Field-wide single-round:
  // ion-deluge. Field-wide instant effect touching every active Pokémon on both sides,
  // same shape as Perish Song above: haze, rototiller.
  'mat-block', 'tailwind', 'lucky-chant', 'ion-deluge', 'haze', 'rototiller',
  // Gravity (milestone 6.10) — field-wide, both sides, no foe target. Terrain moves are
  // NOT here despite being field-wide too — they get their own TERRAIN_MOVES dispatch
  // (mirroring WEATHER_MOVES) since they set Battle.terrain, not a self-target effect.
  'gravity',
  // Power Trick (milestone 6.12) — swaps the user's OWN Atk/Def, no foe target needed.
  // Guard Split/Power Split/Speed Swap are NOT here — all three act on a foe/ally and
  // go through the normal foe-targeting path, same as Guard Swap/Power Swap above.
  'power-trick',
  // Self-only utility (milestone 6.13). Splash and Teleport are pure flavor here —
  // Splash famously does nothing in the real games either; Teleport would force a
  // switch/flee in the real games, but this project doesn't model fleeing/forced-
  // switching mechanically at all (the existing 'run' action is flavor-only for the
  // same reason — the DM adjudicates leaving a fight, not a hard game rule), so it
  // gets the same treatment. Laser Focus pushes a one-hit guaranteed-crit volatile,
  // consumed in resolveMove. Sleep Talk is NOT here — it needs Metronome/Copycat's
  // foe-targeting reroll dispatch, not this self-targeting one.
  'splash', 'teleport', 'laser-focus',
  // Cleric/support (milestone 6.14). Aromatherapy/Heal Bell cure the CASTER'S WHOLE
  // PARTY's status (not just the active Pokémon) — real target is 'user-and-allies'.
  // Life Dew/Dragon Cheer are ALSO 'user-and-allies'/'all-allies' but simplified to
  // self-only, same precedent as coaching/gear-up/howl/magnetic-flux above (no generic
  // ally-stat-stacking outside the dedicated ally-targeting moves). Refresh cures the
  // user's own status; Wish queues a delayed self-heal; Destiny Bond/Grudge push a
  // volatile consumed in applyFaints if the user faints before its next move.
  'aromatherapy', 'heal-bell', 'life-dew', 'dragon-cheer', 'refresh', 'wish',
  'destiny-bond', 'grudge',
  // Imprison (milestone 6.15) — no foe target; blocks every opposing Pokémon from
  // using a move the user itself also knows (checked in checkMoveRestrictions).
  'imprison',
  // Acupressure (milestone 6.10) — real target is 'user-or-ally'; simplified to
  // self-only, same precedent as coaching/gear-up/howl/magnetic-flux above.
  'acupressure',
  // Jungle Healing (milestone 6.10) — real target is 'user-and-allies'; simplified to
  // self-only, same precedent as aromatherapy/heal-bell above (heals + cures own status).
  'jungle-healing',
  // Flower Shield/Court Change (milestone 6.10) — field-wide, no single foe target
  // needed, same shape as Haze/Perish Song above (sweeps every active Pokémon on both
  // sides / swaps side conditions between sides).
  'flower-shield', 'court-change',
  // Happy Hour (milestone 6.10) — real effect is doubling prize money, which this
  // project has no battle-prize-money system for; pure flavor, same treatment as Splash.
  'happy-hour',
  // Fairy Lock (milestone 6.10) — field-wide, no foe target, blocks switching for one
  // additional round (see the fieldConditions entry and the submitMove/dmSubmitMove
  // switch-action gate).
  'fairy-lock',
  // Teatime (milestone 6.10) — field-wide, no foe target, sweeps every active Pokémon
  // on both sides same as Flower Shield above.
  'teatime',
]);

// Sport moves — Gen 5-7's version (the last generation where either was still a usable
// move; Gen 8+ removed both outright), maps moveId to the type it weakens. Field-wide,
// 5 turns, persists through switches (unlike Gen 3-4's "until the user switches out"
// per-Pokémon version). Damage multiplier is exact: 1352/4096 ≈ 0.33, i.e. roughly a
// 67% reduction — sourced from Bulbapedia, not the older Gen 3-4 flat 50%.
export const SPORT_MOVES: Record<string, string> = {
  'mud-sport':   'electric',
  'water-sport': 'fire',
};
export const SPORT_DAMAGE_MULTIPLIER = 1352 / 4096;

// Room effects — field-wide, last 5 turns, and uniquely among status moves in this
// project, using one again while it's already active ENDS it early instead of
// failing or refreshing the timer (matches the real games).
export const ROOM_MOVES = new Set(['trick-room', 'magic-room', 'wonder-room']);

export const ROOM_MESSAGES: Record<string, { start: string; end: string }> = {
  'trick-room':  { start: 'twisted the dimensions! Slower Pokémon will now move first!', end: 'The twisted dimensions returned to normal!' },
  'magic-room':  { start: "wrapped the battlefield in a bizarre room! Held items' effects are suppressed!", end: 'The bizarre room disappeared, and held items regained their effects!' },
  'wonder-room': { start: 'twisted the dimensions! Defense and Sp. Def are swapped!', end: 'The twisted dimensions returned to normal, and stats are back to normal!' },
};

// Maps each protect-family move to the volatile condition it pushes.
// The condition name encodes which variant was used so the hit loop can apply the correct contact side-effect.
export const PROTECT_VOLATILE: Record<string, string> = {
  'protect':          'protecting',
  'detect':           'protecting',
  'kings-shield':     'protecting-kings-shield',
  'spiky-shield':     'protecting-spiky-shield',
  'baneful-bunker':   'protecting-baneful-bunker',
  'obstruct':         'protecting-obstruct',
  // Found by the 5.14 Wave 1 audit — same protect family, missed by the original 4.12 build
  'silk-trap':        'protecting-silk-trap',
  'burning-bulwark':  'protecting-burning-bulwark',
};

// Two-turn moves that require a charge turn before firing.
export const CHARGE_MOVES = new Set([
  'geomancy',
  'solar-beam',
  'fly', 'dig', 'dive', 'bounce', 'sky-attack',
]);

export const CHARGE_MESSAGES: Record<string, string> = {
  'geomancy':   'is absorbing power!',
  'solar-beam': 'is absorbing sunlight!',
  'fly':        'flew up high!',
  'dig':        'dug a hole!',
  'dive':       'dove underwater!',
  'bounce':     'sprang up!',
  'sky-attack': 'is glowing!',
};

// Moves that make the user semi-invulnerable during the charge turn.
export const SEMI_INVULNERABLE_MOVES = new Set(['fly', 'dig', 'dive', 'bounce', 'sky-attack']);

// Binding/trapping moves — on a successful hit they trap the target for 4-5 turns
// (no switching/fleeing) and chip 1/8 max HP at the end of each of those rounds.
// The trap ends immediately if the move's user (not the target) faints or switches out.
export const BINDING_MOVES = new Set([
  'wrap', 'bind', 'fire-spin', 'whirlpool', 'sand-tomb', 'magma-storm',
  'clamp', 'infestation', 'thunder-cage', 'snap-trap',
]);

// Forced-switch moves — no player choice involved, a random other party member
// comes in automatically, matching the real games. Roar/Whirlwind are pure status
// (no damage, and bypass accuracy checks in modern gens); Dragon Tail/Circle Throw
// deal real damage first, then force the switch only if the target survived.
export const FORCE_SWITCH_STATUS_MOVES = new Set(['roar', 'whirlwind']);
export const FORCE_SWITCH_DAMAGE_MOVES = new Set(['dragon-tail', 'circle-throw']);

// Counter-attack moves — retaliate against whatever hit the user this turn, scaled
// by category. Only fires if the user actually took matching-category damage THIS
// turn (tracked on Battle.damageTakenThisTurn, cleared every round) AND the move is
// used against that same attacker — this project doesn't auto-redirect the target
// (real games do), so using one of these against the wrong opponent in a multi-battle
// just fails, same outcome as "no valid retaliation target" in the 1v1 case that
// covers the vast majority of use.
export const COUNTER_MOVES: Record<string, { category: 'physical' | 'special' | 'both'; multiplier: number }> = {
  'counter':      { category: 'physical', multiplier: 2 },
  'mirror-coat':  { category: 'special',  multiplier: 2 },
  'metal-burst':  { category: 'both',     multiplier: 1.5 },
};

// Ally-targeting moves — the first moves in this project to target a teammate's
// active Pokémon rather than a foe or the user. Only meaningful in battles with
// more than one active Pokémon per side (a real, already-supported battle shape —
// e.g. multi-player pve, pvp team battles). Heal Pulse alone can target either an
// ally or a foe; Helping Hand/Aromatic Mist are ally-only.
export const ALLY_ONLY_MOVES = new Set(['helping-hand', 'aromatic-mist', 'floral-healing']);
// Spotlight (milestone 6.15) — draws attention to whichever Pokémon it's used on
// (ally or foe), redirecting single-target foe moves to them the same way Follow Me/
// Rage Powder redirect to the user — see resolveRedirectTarget's own extended check.
export const ALLY_OR_FOE_MOVES = new Set(['heal-pulse', 'spotlight', 'purify']);

// Redirect moves — for the rest of this round, single-target foe moves that would
// have hit anyone on the user's side instead hit the user. Only affects moves whose
// PokeAPI target category resolves to 'single' (spread/auto moves ignore redirects,
// same as the real games). Rage Powder additionally exempts Grass-type attackers and
// the Overcoat ability; Follow Me has no such exemption.
export const REDIRECT_MOVES = new Set(['follow-me', 'rage-powder']);

// Metronome's random-move pool. Real Metronome can call almost any move in the
// game; this project scopes it to a curated set of well-known, definitely
// foe-targeting (never self/ally/weather/room) moves rather than the full
// PokeAPI move list, matching the "close approximation, not exhaustive" approach
// used for every other cut-list move so far. Whatever gets rolled runs through
// the exact same resolution path as if the user had used it directly — including
// binding, forced-switch, etc. tables if one of those happens to get picked.
export const METRONOME_POOL = [
  'tackle', 'ember', 'water-gun', 'thunderbolt', 'ice-beam', 'psychic', 'earthquake',
  'rock-slide', 'shadow-ball', 'flamethrower', 'surf', 'hydro-pump', 'thunder-wave',
  'toxic', 'will-o-wisp', 'sludge-bomb', 'dark-pulse', 'dragon-claw', 'close-combat', 'giga-drain',
];

export type StatEffect = { stat: keyof StatStages; stages: number; target: 'self' | 'foe'; chance?: number };

export const STAT_STAGE_MOVES: Record<string, StatEffect[]> = {
  // ── Self-boost moves ───────────────────────────────────────────────────────
  'swords-dance':    [{ stat: 'atk', stages: 2, target: 'self' }],
  'nasty-plot':      [{ stat: 'spa', stages: 2, target: 'self' }],
  'calm-mind':       [{ stat: 'spa', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }],
  'bulk-up':         [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }],
  'iron-defense':    [{ stat: 'def', stages: 2, target: 'self' }],
  'amnesia':         [{ stat: 'spd', stages: 2, target: 'self' }],
  'agility':         [{ stat: 'spe', stages: 2, target: 'self' }],
  'rock-polish':     [{ stat: 'spe', stages: 2, target: 'self' }],
  'barrier':         [{ stat: 'def', stages: 2, target: 'self' }],
  'harden':          [{ stat: 'def', stages: 1, target: 'self' }],
  'withdraw':        [{ stat: 'def', stages: 1, target: 'self' }],
  'defense-curl':    [{ stat: 'def', stages: 1, target: 'self' }],
  'acid-armor':      [{ stat: 'def', stages: 2, target: 'self' }],
  'cosmic-power':    [{ stat: 'def', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }],
  'growth':          [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spa', stages: 1, target: 'self' }],
  'coil':            [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }, { stat: 'acc', stages: 1, target: 'self' }],
  'dragon-dance':    [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spe', stages: 1, target: 'self' }],
  'quiver-dance':    [{ stat: 'spa', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }, { stat: 'spe', stages: 1, target: 'self' }],
  'geomancy':        [{ stat: 'spa', stages: 2, target: 'self' }, { stat: 'spd', stages: 2, target: 'self' }, { stat: 'spe', stages: 2, target: 'self' }],
  'shell-smash':     [{ stat: 'def', stages: -1, target: 'self' }, { stat: 'spd', stages: -1, target: 'self' }, { stat: 'atk', stages: 2, target: 'self' }, { stat: 'spa', stages: 2, target: 'self' }, { stat: 'spe', stages: 2, target: 'self' }],
  'shift-gear':      [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spe', stages: 2, target: 'self' }],
  'autotomize':      [{ stat: 'spe', stages: 2, target: 'self' }],
  'clangorous-soul': [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }, { stat: 'spa', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }, { stat: 'spe', stages: 1, target: 'self' }],
  'work-up':         [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spa', stages: 1, target: 'self' }],
  'meditate':        [{ stat: 'atk', stages: 1, target: 'self' }],
  'sharpen':         [{ stat: 'atk', stages: 1, target: 'self' }],
  'double-team':     [{ stat: 'eva', stages: 1, target: 'self' }],
  'minimize':        [{ stat: 'eva', stages: 2, target: 'self' }],
  'charge':          [{ stat: 'spd', stages: 1, target: 'self' }],
  // Stockpile is NOT listed here despite being a +Def/+SpDef self-boost — it's capped
  // at 3 uses and tracks a stack count (consumed by Spit Up/Swallow), so it's handled
  // as its own dedicated block in resolveSelfTargetMove instead of this generic table.
  // Curse: non-Ghost variant (+1 Atk, +1 Def, −1 Spe). Ghost variant is handled separately in battles.ts.
  'curse':           [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }, { stat: 'spe', stages: -1, target: 'self' }],
  // ── Milestone 5.14 Wave 1: status-class self-boost moves ──────────────────
  // 'user-and-allies'-target moves (coaching, gear-up, howl, magnetic-flux) simplified
  // to self-only, same reasoning as the SELF_TARGETING_MOVES comment above.
  'coaching':        [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }],
  'cotton-guard':    [{ stat: 'def', stages: 3, target: 'self' }],
  'defend-order':    [{ stat: 'def', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }],
  'extreme-evoboost': [{ stat: 'atk', stages: 2, target: 'self' }, { stat: 'def', stages: 2, target: 'self' }, { stat: 'spa', stages: 2, target: 'self' }, { stat: 'spd', stages: 2, target: 'self' }, { stat: 'spe', stages: 2, target: 'self' }],
  // Fillet Away is NOT listed here — it costs 1/2 max HP like Belly Drum, so it needs
  // the HP-gate to run BEFORE the stat change (same reason Belly Drum is hand-coded in
  // battleController.ts instead of going through this generic table).
  'gear-up':         [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spa', stages: 1, target: 'self' }],
  'hone-claws':      [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'acc', stages: 1, target: 'self' }],
  'howl':            [{ stat: 'atk', stages: 1, target: 'self' }],
  'magnetic-flux':   [{ stat: 'def', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }],
  // Trap-lock (no switching) isn't modeled — same deferred-mechanic treatment as other traps below
  'no-retreat':      [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }, { stat: 'spa', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }, { stat: 'spe', stages: 1, target: 'self' }],
  'tail-glow':       [{ stat: 'spa', stages: 3, target: 'self' }],
  // Hazard/Substitute-clear isn't modeled yet (hazards land in a later 5.14 wave)
  'tidy-up':         [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'spe', stages: 1, target: 'self' }],
  // ── Opponent-debuff moves ──────────────────────────────────────────────────
  'growl':           [{ stat: 'atk', stages: -1, target: 'foe' }],
  'tail-whip':       [{ stat: 'def', stages: -1, target: 'foe' }],
  'leer':            [{ stat: 'def', stages: -1, target: 'foe' }],
  'screech':         [{ stat: 'def', stages: -2, target: 'foe' }],
  'charm':           [{ stat: 'atk', stages: -2, target: 'foe' }],
  'feather-dance':   [{ stat: 'atk', stages: -2, target: 'foe' }],
  'baby-doll-eyes':  [{ stat: 'atk', stages: -1, target: 'foe' }],
  'tickle':          [{ stat: 'atk', stages: -1, target: 'foe' }, { stat: 'def', stages: -1, target: 'foe' }],
  'tearful-look':    [{ stat: 'atk', stages: -1, target: 'foe' }, { stat: 'spa', stages: -1, target: 'foe' }],
  'noble-roar':      [{ stat: 'atk', stages: -1, target: 'foe' }, { stat: 'spa', stages: -1, target: 'foe' }],
  'captivate':       [{ stat: 'spa', stages: -2, target: 'foe' }],
  'eerie-impulse':   [{ stat: 'spa', stages: -2, target: 'foe' }],
  'fake-tears':      [{ stat: 'spd', stages: -2, target: 'foe' }],
  'metal-sound':     [{ stat: 'spd', stages: -2, target: 'foe' }],
  'scary-face':      [{ stat: 'spe', stages: -2, target: 'foe' }],
  'string-shot':     [{ stat: 'spe', stages: -2, target: 'foe' }],
  'cotton-spore':    [{ stat: 'spe', stages: -2, target: 'foe' }],
  'sand-attack':     [{ stat: 'acc', stages: -1, target: 'foe' }],
  'smokescreen':     [{ stat: 'acc', stages: -1, target: 'foe' }],
  'flash':           [{ stat: 'acc', stages: -1, target: 'foe' }],
  'kinesis':         [{ stat: 'acc', stages: -1, target: 'foe' }],
  'sweet-scent':     [{ stat: 'eva', stages: -2, target: 'foe' }],
  // ── Milestone 5.14 Wave 1: status-class foe-target moves ──────────────────
  'confide':         [{ stat: 'spa', stages: -1, target: 'foe' }],
  'defog':           [{ stat: 'eva', stages: -1, target: 'foe' }], // hazard-clear deferred to a later 5.14 wave
  'memento':         [{ stat: 'atk', stages: -2, target: 'foe' }, { stat: 'spa', stages: -2, target: 'foe' }], // user-faints-after-use deferred (5.14 self-KO wave)
  'parting-shot':    [{ stat: 'atk', stages: -1, target: 'foe' }, { stat: 'spa', stages: -1, target: 'foe' }], // switch-out-after-use deferred, no U-turn/Volt Switch-style mechanic exists yet
  'play-nice':       [{ stat: 'atk', stages: -1, target: 'foe' }],
  'tar-shot':        [{ stat: 'spe', stages: -1, target: 'foe' }], // also makes target Fire-weak — not modeled
  'toxic-thread':    [{ stat: 'spe', stages: -1, target: 'foe' }], // also poisons — see STATUS_MOVES
  // Decorate and Spicy Extract are real oddities: they buff whoever they're used ON,
  // even a foe. 'target: foe' here just means "apply to whoever was targeted" — the
  // code doesn't care about the sign of the stages, so this is correct as-is.
  'decorate':        [{ stat: 'atk', stages: 2, target: 'foe' }, { stat: 'spa', stages: 2, target: 'foe' }],
  'spicy-extract':   [{ stat: 'atk', stages: 2, target: 'foe' }, { stat: 'def', stages: -2, target: 'foe' }],
  // ── Confusion + stat-boost moves (confusion handled by STATUS_MOVES) ─────────
  'swagger':         [{ stat: 'atk', stages: 2, target: 'foe' }],
  'flatter':         [{ stat: 'spa', stages: 1, target: 'foe' }],
  // ── Damaging moves — guaranteed self stat drop ─────────────────────────────
  'close-combat':  [{ stat: 'def', stages: -1, target: 'self' }, { stat: 'spd', stages: -1, target: 'self' }],
  'superpower':    [{ stat: 'atk', stages: -1, target: 'self' }, { stat: 'def', stages: -1, target: 'self' }],
  'overheat':      [{ stat: 'spa', stages: -2, target: 'self' }],
  'draco-meteor':  [{ stat: 'spa', stages: -2, target: 'self' }],
  'leaf-storm':    [{ stat: 'spa', stages: -2, target: 'self' }],
  'psycho-boost':  [{ stat: 'spa', stages: -2, target: 'self' }],
  'hammer-arm':    [{ stat: 'spe', stages: -1, target: 'self' }],
  'v-create':      [{ stat: 'def', stages: -1, target: 'self' }, { stat: 'spd', stages: -1, target: 'self' }, { stat: 'spe', stages: -1, target: 'self' }],
  // Milestone 5.14 Wave 1 additions — these look like foe-target damage moves
  // (PokeAPI's move-level `target` field says "selected-pokemon", i.e. who takes the
  // damage) but their stat change is a real self-cost/self-buff, not a foe debuff.
  'armor-cannon':    [{ stat: 'def', stages: -1, target: 'self' }, { stat: 'spd', stages: -1, target: 'self' }],
  'clanging-scales': [{ stat: 'def', stages: -1, target: 'self' }],
  'dragon-ascent':   [{ stat: 'def', stages: -1, target: 'self' }, { stat: 'spd', stages: -1, target: 'self' }],
  'fleur-cannon':    [{ stat: 'spa', stages: -2, target: 'self' }],
  'hyperspace-fury': [{ stat: 'def', stages: -1, target: 'self' }],
  'ice-hammer':      [{ stat: 'spe', stages: -1, target: 'self' }],
  'make-it-rain':    [{ stat: 'spa', stages: -1, target: 'self' }],
  'spin-out':        [{ stat: 'spe', stages: -2, target: 'self' }],
  // ── Damaging moves — chance-based foe stat drop ────────────────────────────
  'aurora-beam':   [{ stat: 'atk', stages: -1, target: 'foe', chance: 0.1 }],
  'crunch':        [{ stat: 'def', stages: -1, target: 'foe', chance: 0.2 }],
  'psychic':       [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'shadow-ball':   [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.2 }],
  'acid':          [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'acid-spray':    [{ stat: 'spd', stages: -2, target: 'foe', chance: 1 }],
  'bubble':        [{ stat: 'spe', stages: -1, target: 'foe', chance: 0.1 }],
  'bubble-beam':   [{ stat: 'spe', stages: -1, target: 'foe', chance: 0.1 }],
  'constrict':     [{ stat: 'spe', stages: -1, target: 'foe', chance: 0.1 }],
  'icy-wind':      [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'mud-shot':      [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'mud-slap':      [{ stat: 'acc', stages: -1, target: 'foe', chance: 1 }],
  'rock-smash':    [{ stat: 'def', stages: -1, target: 'foe', chance: 0.5 }],
  'energy-ball':   [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'flash-cannon':  [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'luster-purge':  [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.5 }],
  'mist-ball':     [{ stat: 'spa', stages: -1, target: 'foe', chance: 0.5 }],
  'octazooka':     [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.5 }],
  'muddy-water':   [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.3 }],
  'mirror-shot':   [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.3 }],
  // Milestone 5.14 Wave 1 additions
  'apple-acid':      [{ stat: 'spd', stages: -1, target: 'foe', chance: 1 }],
  'breaking-swipe':  [{ stat: 'atk', stages: -1, target: 'foe', chance: 1 }],
  'bug-buzz':        [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'bulldoze':        [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'chilling-water':  [{ stat: 'atk', stages: -1, target: 'foe', chance: 1 }],
  'crush-claw':      [{ stat: 'def', stages: -1, target: 'foe', chance: 0.5 }],
  'drum-beating':    [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'earth-power':     [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'electroweb':      [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'fire-lash':       [{ stat: 'def', stages: -1, target: 'foe', chance: 1 }],
  'focus-blast':     [{ stat: 'spd', stages: -1, target: 'foe', chance: 0.1 }],
  'glaciate':        [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'grav-apple':      [{ stat: 'def', stages: -1, target: 'foe', chance: 1 }],
  'iron-tail':       [{ stat: 'def', stages: -1, target: 'foe', chance: 0.3 }],
  'leaf-tornado':    [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.5 }],
  'liquidation':     [{ stat: 'def', stages: -1, target: 'foe', chance: 0.2 }],
  'low-sweep':       [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'lumina-crash':    [{ stat: 'spd', stages: -2, target: 'foe', chance: 1 }],
  'lunge':           [{ stat: 'atk', stages: -1, target: 'foe', chance: 1 }],
  'moonblast':       [{ stat: 'spa', stages: -1, target: 'foe', chance: 0.3 }],
  'mud-bomb':        [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.3 }],
  'mystical-fire':   [{ stat: 'spa', stages: -1, target: 'foe', chance: 1 }],
  'night-daze':      [{ stat: 'acc', stages: -1, target: 'foe', chance: 0.4 }],
  'play-rough':      [{ stat: 'atk', stages: -1, target: 'foe', chance: 0.1 }],
  'pounce':          [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'razor-shell':     [{ stat: 'def', stages: -1, target: 'foe', chance: 0.5 }],
  'rock-tomb':       [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'seed-flare':      [{ stat: 'spd', stages: -2, target: 'foe', chance: 0.4 }],
  'shadow-bone':     [{ stat: 'def', stages: -1, target: 'foe', chance: 0.2 }],
  'skitter-smack':   [{ stat: 'spa', stages: -1, target: 'foe', chance: 1 }],
  'snarl':           [{ stat: 'spa', stages: -1, target: 'foe', chance: 1 }],
  'spirit-break':    [{ stat: 'spa', stages: -1, target: 'foe', chance: 1 }],
  'struggle-bug':    [{ stat: 'spa', stages: -1, target: 'foe', chance: 1 }],
  // Real Syrup Bomb re-lowers Speed each turn for 3 turns; simplified to a single
  // one-shot drop, same "close approximation" treatment as other DOT-style effects.
  'syrup-bomb':      [{ stat: 'spe', stages: -1, target: 'foe', chance: 1 }],
  'thunderous-kick':  [{ stat: 'def', stages: -1, target: 'foe', chance: 1 }],
  'trop-kick':       [{ stat: 'atk', stages: -1, target: 'foe', chance: 1 }],
  // ── Damaging moves — chance-based self stat boost ──────────────────────────
  'charge-beam':   [{ stat: 'spa', stages: 1, target: 'self', chance: 0.7 }],
  'meteor-mash':   [{ stat: 'atk', stages: 1, target: 'self', chance: 0.2 }],
  // Milestone 5.14 Wave 1 additions
  'ancient-power':   [{ stat: 'atk', stages: 1, target: 'self', chance: 0.1 }, { stat: 'def', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spa', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spd', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spe', stages: 1, target: 'self', chance: 0.1 }],
  'silver-wind':     [{ stat: 'atk', stages: 1, target: 'self', chance: 0.1 }, { stat: 'def', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spa', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spd', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spe', stages: 1, target: 'self', chance: 0.1 }],
  'ominous-wind':    [{ stat: 'atk', stages: 1, target: 'self', chance: 0.1 }, { stat: 'def', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spa', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spd', stages: 1, target: 'self', chance: 0.1 }, { stat: 'spe', stages: 1, target: 'self', chance: 0.1 }],
  'clangorous-soulblaze': [{ stat: 'atk', stages: 1, target: 'self', chance: 1 }, { stat: 'def', stages: 1, target: 'self', chance: 1 }, { stat: 'spa', stages: 1, target: 'self', chance: 1 }, { stat: 'spd', stages: 1, target: 'self', chance: 1 }, { stat: 'spe', stages: 1, target: 'self', chance: 1 }],
  'aqua-step':       [{ stat: 'spe', stages: 1, target: 'self', chance: 1 }],
  'aura-wheel':      [{ stat: 'spe', stages: 1, target: 'self', chance: 1 }],
  'diamond-storm':   [{ stat: 'def', stages: 2, target: 'self', chance: 0.5 }],
  'electro-shot':    [{ stat: 'spa', stages: 1, target: 'self', chance: 1 }], // real move charges turn 1 and fires turn 2; not in CHARGE_MOVES, so this resolves as an immediate single-turn cast — a known simplification
  'fiery-dance':     [{ stat: 'spa', stages: 1, target: 'self', chance: 0.5 }],
  'flame-charge':    [{ stat: 'spe', stages: 1, target: 'self', chance: 1 }],
  'metal-claw':      [{ stat: 'atk', stages: 1, target: 'self', chance: 0.1 }],
  'power-up-punch':  [{ stat: 'atk', stages: 1, target: 'self', chance: 1 }],
  'rapid-spin':      [{ stat: 'spe', stages: 1, target: 'self', chance: 1 }], // hazard/Leech Seed removal deferred to a later 5.14 wave
  'steel-wing':      [{ stat: 'def', stages: 1, target: 'self', chance: 0.1 }],
  'torch-song':      [{ stat: 'spa', stages: 1, target: 'self', chance: 1 }],
  'trailblaze':      [{ stat: 'spe', stages: 1, target: 'self', chance: 1 }],
  // Zippy Zap always crit in its Let's Go debut, but that was removed as of Sword/Shield
  // — PokeAPI's current-gen crit_rate data confirms it no longer does (checked during
  // Wave 3's crit-ratio audit), so the earlier note claiming otherwise was wrong.
  'zippy-zap':       [{ stat: 'eva', stages: 1, target: 'self', chance: 1 }],
};

export const STAT_DISPLAY_NAMES: Record<keyof StatStages, string> = {
  atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def',
  spe: 'Speed',  acc: 'Accuracy', eva: 'Evasiveness',
};

// Recovery moves — heal the user without targeting an enemy.
export type RecoveryEffect = { type: 'flat'; fraction: number } | { type: 'weather' } | { type: 'rest' };

export const RECOVERY_MOVES: Record<string, RecoveryEffect> = {
  'recover':     { type: 'flat', fraction: 0.5 },
  'soft-boiled': { type: 'flat', fraction: 0.5 },
  'milk-drink':  { type: 'flat', fraction: 0.5 },
  'slack-off':   { type: 'flat', fraction: 0.5 },
  'heal-order':  { type: 'flat', fraction: 0.5 },
  'roost':       { type: 'flat', fraction: 0.5 },
  'shore-up':    { type: 'flat', fraction: 0.5 },
  'synthesis':   { type: 'weather' },
  'moonlight':   { type: 'weather' },
  'morning-sun': { type: 'weather' },
  'rest':        { type: 'rest' },
};

// Physical moves that make contact and can trigger contact-based defender abilities.
export const CONTACT_MOVES = new Set([
  // Normal
  'scratch', 'tackle', 'pound', 'headbutt', 'body-slam', 'take-down', 'double-edge',
  'quick-attack', 'extreme-speed', 'slam', 'strength', 'giga-impact', 'facade',
  'return', 'frustration', 'retaliate', 'skull-bash', 'hyper-fang', 'super-fang',
  'last-resort', 'double-hit', 'dizzy-punch', 'mega-punch', 'rage', 'rollout',
  'stomp', 'covet', 'fake-out', 'rapid-spin', 'thrash', 'double-kick', 'triple-kick',
  // Fighting
  'low-kick', 'karate-chop', 'submission', 'seismic-toss', 'cross-chop', 'dynamic-punch',
  'mach-punch', 'focus-punch', 'drain-punch', 'close-combat', 'high-jump-kick', 'jump-kick',
  'sky-uppercut', 'force-palm', 'brick-break', 'hammer-arm', 'superpower', 'low-sweep',
  'circle-throw', 'storm-throw', 'vital-throw', 'body-press',
  // Flying
  'peck', 'drill-peck', 'wing-attack', 'aerial-ace', 'brave-bird', 'sky-attack',
  'fly', 'bounce', 'pluck', 'acrobatics', 'dual-wingbeat',
  // Poison
  'poison-jab', 'cross-poison', 'poison-sting', 'lunge',
  // Ground
  'dig', 'slash', 'high-horsepower',
  // Rock
  'rock-smash', 'head-smash',
  // Bug
  'x-scissor', 'bug-bite', 'u-turn', 'fury-cutter', 'leech-life',
  'first-impression', 'fell-stinger',
  // Ghost
  'shadow-claw', 'shadow-sneak', 'lick', 'shadow-punch',
  // Steel
  'iron-tail', 'steel-wing', 'bullet-punch', 'meteor-mash', 'iron-head', 'smart-strike',
  'sunsteel-strike', 'behemoth-blade', 'behemoth-bash',
  // Fire
  'fire-punch', 'fire-fang', 'flame-charge', 'flare-blitz', 'flame-wheel',
  // Water
  'waterfall', 'aqua-tail', 'liquidation', 'dive', 'aqua-jet', 'crabhammer',
  // Electric
  'thunder-punch', 'thunder-fang', 'spark', 'wild-charge', 'volt-tackle', 'plasma-fists',
  // Ice
  'ice-punch', 'ice-fang', 'ice-ball',
  // Psychic
  'zen-headbutt', 'psychic-fangs',
  // Dark
  'crunch', 'bite', 'night-slash', 'sucker-punch', 'foul-play', 'assurance',
  'payback', 'revenge', 'spirit-break',
  // Milestone 5.14 Wave 12 bug fix — found during the Wave 8/9 audit but not fixed
  // until Knock Off/Thief were actually implemented: both are real contact moves.
  'knock-off', 'thief',
  // Dragon
  'dragon-claw', 'dragon-rush', 'outrage', 'dragon-tail', 'dual-chop', 'scale-shot',
  // Grass
  'vine-whip', 'leaf-blade', 'wood-hammer', 'power-whip', 'petal-dance',
]);

// Recoil moves — attacker takes damage after hitting.
export type RecoilEffect = { type: 'damage'; fraction: number } | { type: 'max-hp'; fraction: number };

export const RECOIL_MOVES: Record<string, RecoilEffect> = {
  'take-down':    { type: 'damage', fraction: 1 / 4 },
  'submission':   { type: 'damage', fraction: 1 / 4 },
  'wild-charge':  { type: 'damage', fraction: 1 / 4 },
  'head-charge':  { type: 'damage', fraction: 1 / 4 },
  'double-edge':  { type: 'damage', fraction: 1 / 3 },
  'brave-bird':   { type: 'damage', fraction: 1 / 3 },
  'flare-blitz':  { type: 'damage', fraction: 1 / 3 },
  'volt-tackle':  { type: 'damage', fraction: 1 / 3 },
  'wood-hammer':  { type: 'damage', fraction: 1 / 3 },
  'head-smash':   { type: 'damage', fraction: 1 / 2 },
  'struggle':     { type: 'max-hp', fraction: 1 / 4 },
  'light-of-ruin': { type: 'damage', fraction: 1 / 2 },
};

// Multi-hit moves — hit a fixed number of times or a random 2–5.
export type MultiHitEffect = { type: 'fixed'; count: number } | { type: 'variable' };

export const MULTI_HIT_MOVES: Record<string, MultiHitEffect> = {
  // Fixed 2-hit
  'double-kick':   { type: 'fixed', count: 2 },
  'bonemerang':    { type: 'fixed', count: 2 },
  'twineedle':     { type: 'fixed', count: 2 },
  'double-hit':    { type: 'fixed', count: 2 },
  'dual-chop':     { type: 'fixed', count: 2 },
  'dual-wingbeat': { type: 'fixed', count: 2 },
  'gear-grind':    { type: 'fixed', count: 2 },
  // Variable 2–5 hit (Gen 5+ distribution: 1/3 × 2, 1/3 × 3, 1/6 × 4, 1/6 × 5)
  'fury-attack':   { type: 'variable' },
  'double-slap':   { type: 'variable' },
  'comet-punch':   { type: 'variable' },
  'fury-swipes':   { type: 'variable' },
  'spike-cannon':  { type: 'variable' },
  'bullet-seed':   { type: 'variable' },
  'icicle-spear':  { type: 'variable' },
  'rock-blast':    { type: 'variable' },
  'arm-thrust':    { type: 'variable' },
  'pin-missile':   { type: 'variable' },
  'tail-slap':     { type: 'variable' },
  'bone-rush':     { type: 'variable' },
  'barrage':       { type: 'variable' },
  'scale-shot':    { type: 'variable' },
  'water-shuriken': { type: 'variable' },
  'dragon-darts':  { type: 'fixed', count: 2 },
  // Real hit counts. Surging Strikes' guaranteed crit is now modeled via
  // ALWAYS_CRIT_MOVES (milestone 5.14 Wave 3). Triple Kick/Triple Axel's per-hit power
  // still escalates (10/20/30 and 20/40/60) rather than hitting 3x at the move's flat
  // listed power — that nuance remains an accepted "close approximation" simplification.
  'surging-strikes': { type: 'fixed', count: 3 },
  'triple-kick':     { type: 'fixed', count: 3 },
  'triple-axel':     { type: 'fixed', count: 3 },
  // Beat Up deliberately excluded — its real hit count/power come from each of the
  // user's OTHER unfainted party members' own level/Attack stat, not the move's own
  // power or a simple hit-count roll; needs bespoke logic, not a MULTI_HIT_MOVES entry.
};

export function getHitCount(moveId: string): number {
  const effect = MULTI_HIT_MOVES[moveId];
  if (!effect) return 1;
  if (effect.type === 'fixed') return effect.count;
  return [2, 2, 3, 3, 4, 5][Math.floor(Math.random() * 6)];
}

// Drain moves — attacker restores HP equal to a fraction of damage dealt.
export type DrainEffect = { fraction: number };

export const DRAIN_MOVES: Record<string, DrainEffect> = {
  'absorb':           { fraction: 0.5 },
  'mega-drain':       { fraction: 0.5 },
  'giga-drain':       { fraction: 0.5 },
  'leech-life':       { fraction: 0.5 },
  'horn-leech':       { fraction: 0.5 },
  'parabolic-charge': { fraction: 0.5 },
  'bouncy-bubble':    { fraction: 0.5 },
  'dream-eater':      { fraction: 0.5 },
  'draining-kiss':    { fraction: 0.75 },
  'oblivion-wing':    { fraction: 0.75 },
  'drain-punch':      { fraction: 0.5 },
};

// Moves that lock the user in for multiple consecutive turns.
// totalTurns: how many turns total (including the first); 'random' = 2 or 3.
// confuseAfter: apply confusion to the user when the lock expires.
export type LockMoveEffect = { totalTurns: number | 'random'; confuseAfter: boolean };

export const LOCK_MOVES: Record<string, LockMoveEffect> = {
  'rollout':     { totalTurns: 5,        confuseAfter: false },
  'ice-ball':    { totalTurns: 5,        confuseAfter: false },
  'thrash':      { totalTurns: 'random', confuseAfter: true  },
  'outrage':     { totalTurns: 'random', confuseAfter: true  },
  'petal-dance': { totalTurns: 'random', confuseAfter: true  },
};

// Moves whose base power doubles with each consecutive use by the same Pokémon.
// basePower: starting power on the first use; maxCount: number of doublings before capping.
export type EscalatingPowerMove = { basePower: number; maxCount: number };

export const ESCALATING_POWER_MOVES: Record<string, EscalatingPowerMove> = {
  'fury-cutter': { basePower: 40, maxCount: 3 }, // 40 → 80 → 160 (stays at 160)
  'rollout':     { basePower: 30, maxCount: 5 }, // 30 → 60 → 120 → 240 → 480
  'ice-ball':    { basePower: 30, maxCount: 5 }, // 30 → 60 → 120 → 240 → 480
};

// All move IDs that require no enemy target selection.
// Sent to the client via the state endpoint so the UI can skip the target picker.
export const NO_TARGET_MOVE_IDS = new Set([
  ...Object.keys(WEATHER_MOVES),
  ...Object.keys(TERRAIN_MOVES),
  ...SELF_TARGETING_MOVES,
]);

// Moves that gain +1 priority when used by a Pokémon with Prankster.
// Derived from pure status moves (chance === 1), non-charging self-targeting moves,
// and weather/terrain moves — all are "Status" category in PokeAPI.
export const PRANKSTER_MOVES = new Set([
  ...Object.entries(STATUS_MOVES).filter(([, v]) => v.chance === 1).map(([k]) => k),
  ...[...SELF_TARGETING_MOVES].filter(m => !CHARGE_MOVES.has(m)),
  ...Object.keys(WEATHER_MOVES),
  ...Object.keys(TERRAIN_MOVES),
]);

// PokeAPI `target` values that mean "hit all active enemies" — no target picker needed.
// Friendly fire (all-adjacent hitting allies) is intentionally omitted for simplicity.
const AUTO_TARGET_VALUES = new Set([
  'all-opponents',
  'all-adjacent-foes',
  'all-adjacent',
  'all-pokemon',
  'all-other-pokemon',
  'entire-field',
]);

// Returns 'auto' for spread/field moves that hit all active enemies without a picker,
// 'single' for everything else (player picks exactly one target). Falls back to 'single'
// when the target field is empty or unrecognised.
export function getMoveTargetCategory(target: string): 'single' | 'auto' {
  return AUTO_TARGET_VALUES.has(target) ? 'auto' : 'single';
}

// Fixed-damage moves — their damage doesn't come from the normal power/stat formula,
// so they're cached with power:null and would otherwise silently deal 0 (milestone
// 5.14 Wave 2). Split into two groups: @smogon/calc has NATIVE support for the first
// group (handleFixedDamageMoves + a dedicated Final Gambit branch in its own gen789
// mechanics) — resolveMove just needs to stop short-circuiting on power:null and let
// them reach calculate(). The second group has no library support and is computed
// directly in resolveMove instead (target's current HP, user's level, etc.) — same
// "no @smogon/calc coverage, hand-roll it" treatment as Pain Split/Strength Sap.
export const LIBRARY_FIXED_DAMAGE_MOVES = new Set([
  'seismic-toss', 'night-shade', 'dragon-rage', 'sonic-boom', 'final-gambit',
]);
export const CUSTOM_FIXED_DAMAGE_MOVES = new Set([
  'endeavor', 'super-fang', 'ruination', 'psywave', 'natures-madness',
]);
export const FIXED_DAMAGE_MOVES = new Set([...LIBRARY_FIXED_DAMAGE_MOVES, ...CUSTOM_FIXED_DAMAGE_MOVES]);

// Variable-power moves — cached with power:null since PokeAPI has no single fixed
// value for them either, but unlike FIXED_DAMAGE_MOVES above, @smogon/calc computes
// their real base power ITSELF (from its own bundled species weight/speed/HP data)
// inside its own gen789 mechanics switch, then runs the normal damage formula with
// it — no hand-rolled math needed here at all, resolveMove just needs to stop
// short-circuiting on power:null and let them reach calculate(). Natural Gift needs
// the attacker to actually be holding a berry or @smogon/calc falls back to 0 power;
// that's checked before the calculate() call rather than added here, same as Fling's
// "nothing to fling" guard.
export const LIBRARY_VARIABLE_POWER_MOVES = new Set([
  'low-kick', 'grass-knot', 'heavy-slam', 'heat-crash', 'gyro-ball', 'electro-ball',
  'flail', 'reversal', 'wring-out', 'hard-press', 'natural-gift', 'crush-grip',
  // Punishment (milestone 6.10) — power scales with the TARGET's positive stat stages
  // (60 + 20 per stage, capped 200). @smogon/calc's own Punishment case already reads
  // this off calcTarget.boosts, which resolveMove already populates from battle.statStages.
  'punishment',
]);

// High-crit-ratio moves (milestone 5.14 Wave 3) — sourced from PokeAPI's move-level
// meta.crit_rate field, which encodes two distinct real mechanics under one number:
// a value of 1 raises the crit stage by 1 (stacks with Focus Energy's own +2 stages,
// same shared stage pool as the real games); a value of 6 means the move ALWAYS crits
// outright, bypassing the stage table entirely — a separate, stronger effect, not
// "6 stages". (A 27th move, 10,000,000 Volt Thunderbolt, has crit_rate 2 but is a
// Z-move exclusive to Pikachu — excluded, no Z-move system exists in this project.)
export const HIGH_CRIT_MOVES = new Set([
  'aeroblast', 'air-cutter', 'attack-order', 'blaze-kick', 'crabhammer', 'cross-chop',
  'cross-poison', 'drill-run', 'karate-chop', 'leaf-blade', 'night-slash', 'poison-tail',
  'psycho-cut', 'razor-leaf', 'razor-wind', 'shadow-claw', 'sky-attack', 'slash',
  'snipe-shot', 'spacial-rend', 'stone-edge',
]);
export const ALWAYS_CRIT_MOVES = new Set(['frost-breath', 'storm-throw', 'surging-strikes', 'wicked-blow']);

// Real Gen 6+ crit-stage table — index by total stage (capped at 3, which is
// "always crits" via the normal roll rather than the ALWAYS_CRIT_MOVES shortcut).
export const CRIT_STAGE_RATES = [1 / 24, 1 / 8, 1 / 2, 1];

// OHKO moves (milestone 5.14 Wave 4) — deal damage equal to the target's current HP
// on a hit. Own accuracy formula entirely separate from the move's own listed accuracy
// (level_diff + 30, clamped 0-100), auto-fails against a higher-level target, and is
// blocked outright by the target's Sturdy — a narrow, single-purpose ability check
// added here without building out Sturdy's other (unrelated) "survive a hit at full
// HP" effect, which isn't implemented anywhere in this project yet.
export const OHKO_MOVES = new Set(['guillotine', 'horn-drill', 'fissure', 'sheer-cold']);

// Recharge moves (milestone 5.14 Wave 5) — sourced from a live sweep of every PokeAPI
// move's effect text for "recharge" (no dedicated meta field exists for this, unlike
// ailment/drain/flinch/etc.), then hand-verified against two false positives the
// keyword match picked up (Sleep Talk's text merely LISTS these moves as an exception,
// it doesn't itself recharge; Shadow Half — a Pokémon Colosseum/XD Shadow-Pokémon-
// exclusive move — turned out to be a genuine 11th recharge move, not a false
// positive, and is included for completeness). The user must recharge (skip their
// next turn entirely) after USING one of these, regardless of whether it hit, missed,
// or was blocked by Protect — applied once per use, not once per target.
export const RECHARGE_MOVES = new Set([
  'blast-burn', 'eternabeam', 'frenzy-plant', 'giga-impact', 'hydro-cannon',
  'hyper-beam', 'meteor-assault', 'prismatic-laser', 'roar-of-time', 'rock-wrecker',
  'shadow-half',
]);

// Screens (milestone 5.14 Wave 6) — side-wide, 5 turns, same Battle.fieldConditions
// pattern as Wide Guard/Quick Guard (5.13). @smogon/calc has NATIVE damage-halving
// support for all three via Field.defenderSide.isReflect/isLightScreen/isAuroraVeil
// (and correctly excludes critical hits from the reduction on its own) — no need to
// hand-roll the damage math, just flip the right flag based on the defender's side.
export const SCREEN_MOVES = new Set(['reflect', 'light-screen', 'aurora-veil']);
export const SCREEN_MESSAGES: Record<string, string> = {
  'reflect':      'put up a Reflect wall! Physical damage is reduced!',
  'light-screen': 'put up a Light Screen! Special damage is reduced!',
  'aurora-veil':  'put up an Aurora Veil! Damage is reduced!',
};
// Mist blocks incoming NEGATIVE stat changes for the caster's side; Safeguard blocks
// incoming status conditions. Both reuse the same fieldConditions pattern.
export const MIST_MESSAGE = "became shrouded in mist! The team's stats can't be lowered!";
export const SAFEGUARD_MESSAGE = 'became cloaked in a mystical veil! The team is protected from status conditions!';

// Entry hazards (milestone 5.14 Wave 7) — set on the OPPONENT's side (unlike screens/
// Wide Guard, which protect the caster's own side), and trigger on send-out/switch-in
// rather than through the normal move-damage pipeline, so this is fully custom code —
// no @smogon/calc coverage applies here at all. Stacking count is encoded directly in
// the fieldConditions condition string (e.g. 'spikes:enemySide:2'), same convention as
// 'bound:<moveId>:<attackerId>' from milestone 5.13. Stealth Rock/Sticky Web are
// single-layer; Spikes/Toxic Spikes stack.
export const ENTRY_HAZARD_MOVES = new Set(['stealth-rock', 'spikes', 'toxic-spikes', 'sticky-web']);
export const STACKABLE_HAZARDS: Record<string, number> = { spikes: 3, 'toxic-spikes': 2 };
// Spikes damage fraction by layer count (index 0 unused, 1-indexed by layer count).
export const SPIKES_DAMAGE_FRACTION = [0, 1 / 8, 1 / 6, 1 / 4];

// Hazard-removal moves. Court Change (swaps every side condition between both sides)
// is deliberately excluded — genuinely more complex than a simple clear, and rare
// enough in practice that it's a better candidate for a future pass than this wave.
// Rapid Spin only clears the user's own side (it's a damaging move; hooks into the
// existing post-damage self-effect path from milestone 5.13's Wave 3 self-boost).
// Defog and Tidy Up clear BOTH sides — Defog additionally clears screens/Mist/
// Safeguard from both sides too (real Gen 6+ behavior), not just hazards.
export const RAPID_SPIN_HAZARD_CLEAR = new Set(['rapid-spin']);
export const BOTH_SIDES_HAZARD_CLEAR = new Set(['defog', 'tidy-up']);

// No-damage trapping moves (milestone 5.14 Wave 8) — reuse the exact same
// 'bound:<moveId>:<sourceId>' volatile as the real binding moves (Wrap/Bind/etc,
// milestone 5.13), including the switch-block check and release-when-source-leaves
// logic, but with no end-of-round chip damage and no turn-counted expiry (cast with
// turnsRemaining:99, only cleared when the trapper itself leaves the field).
// Octolock (milestone 6.10) shares this exact trap-with-no-chip-damage treatment —
// the ADDITIONAL -1 Def/-1 SpD-every-turn part is handled separately in
// applyEndOfRound's own bound: tick, gated on trapMoveId === 'octolock'.
export const NO_DAMAGE_TRAP_MOVES = new Set(['mean-look', 'block', 'spider-web', 'octolock']);

// Perish Song (milestone 5.14 Wave 8) — hits every active Pokémon on BOTH sides
// (self, allies, and opponents alike), so it's resolved through the self-targeting
// path rather than the normal single-side auto-target picker, which only ever hits
// the opposing side. Doesn't re-apply to a Pokémon already counting down.
export const PERISH_SONG_TURNS = 3;

// Delayed damage (milestone 5.14 Wave 9) — Future Sight/Doom Desire. Cast normally
// (target picked, accuracy checked at cast time like any move) but the hit itself
// lands 2 end-of-rounds later using the ATTACKER's stats as they were AT CAST TIME
// (a snapshot on Battle.pendingAttacks — see the PendingAttack type in models/Battle.ts),
// against whichever Pokémon occupies the targeted SLOT when the timer expires (not
// necessarily the originally-targeted Pokémon, if it's since switched out).
export const DELAYED_DAMAGE_MOVES = new Set(['future-sight', 'doom-desire']);
export const DELAYED_DAMAGE_TURNS = 2;

// Self-KO utility (milestone 5.14 Wave 10) — the user faints immediately after use,
// regardless of whether the move actually hit/succeeded. Explosion/Self-Destruct/
// Misty Explosion are otherwise ordinary damaging spread moves (power/type/target
// already come from the normal PokeAPI-cached move data, no special table needed for
// the damage itself); Memento's foe stat-drop was already built in Wave 1 — this only
// adds the missing self-faint. Healing Wish/Lunar Dance additionally queue a full
// heal for whoever's sent in next (see PendingWish in models/Battle.ts).
export const SELF_KO_MOVES = new Set([
  'explosion', 'self-destruct', 'misty-explosion', 'memento', 'healing-wish', 'lunar-dance',
]);
export const HEALING_WISH_MOVES = new Set(['healing-wish', 'lunar-dance']);

// Magnitude — random power roll (Bulbapedia's real probability table), announced as
// "Magnitude N!" before the hit. Not in LIBRARY_VARIABLE_POWER_MOVES since @smogon/calc
// has no native case for it — this project rolls it itself and passes it through
// resolveMove's existing powerOverride mechanism, same as Fling/escalating moves.
export const MAGNITUDE_TABLE: Array<{ magnitude: number; chance: number; power: number }> = [
  { magnitude: 4,  chance: 0.05, power: 10 },
  { magnitude: 5,  chance: 0.10, power: 30 },
  { magnitude: 6,  chance: 0.20, power: 50 },
  { magnitude: 7,  chance: 0.30, power: 70 },
  { magnitude: 8,  chance: 0.20, power: 90 },
  { magnitude: 9,  chance: 0.10, power: 110 },
  { magnitude: 10, chance: 0.05, power: 150 },
];

// Trump Card — power scales inversely with the move's OWN remaining PP at the moment
// it's used (before this use's own decrement). No @smogon/calc native case either.
export function getTrumpCardPower(currentPP: number): number {
  if (currentPP <= 1) return 200;
  if (currentPP === 2) return 80;
  if (currentPP === 3) return 60;
  if (currentPP === 4) return 50;
  return 40;
}

// Spit Up/Swallow both consume the user's full Stockpile count (see the dedicated
// Stockpile block in resolveSelfTargetMove — capped at 3, tracked as a stockpile:<n>
// volatile since it's not a plain stat-stage move) and fail outright with none banked.
// Spit Up's power scales 100/200/300 for 1/2/3 stacks; Swallow heals 25%/50%/100% of
// max HP for the same. Both also undo the Def/SpDef boosts Stockpile granted.
export const STOCKPILE_MAX = 3;
export function getSpitUpPower(stacks: number): number {
  return stacks * 100;
}
export function getSwallowHealFraction(stacks: number): number {
  return stacks === 1 ? 0.25 : stacks === 2 ? 0.5 : 1;
}
