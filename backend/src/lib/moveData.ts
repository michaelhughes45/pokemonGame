import { StatStages } from '../models/Battle';
import { WEATHER_MOVES } from './weatherData';

export type StatusMoveEffect = {
  status: 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic' | 'confusion';
  chance: number; // 0–1
};

// Moves that inflict a status condition, either as their primary effect (chance 1)
// or as a secondary effect on damage moves. Keyed by PokeAPI move slug.
export const STATUS_MOVES: Record<string, StatusMoveEffect> = {
  // Paralysis
  'thunder-wave':  { status: 'paralysis', chance: 1 },
  'glare':         { status: 'paralysis', chance: 1 },
  'stun-spore':    { status: 'paralysis', chance: 1 },
  'nuzzle':        { status: 'paralysis', chance: 1 },
  'zap-cannon':    { status: 'paralysis', chance: 1 },
  'body-slam':     { status: 'paralysis', chance: 0.3 },
  'thunder':       { status: 'paralysis', chance: 0.3 },
  'thunderbolt':   { status: 'paralysis', chance: 0.1 },
  'discharge':     { status: 'paralysis', chance: 0.3 },
  'spark':         { status: 'paralysis', chance: 0.3 },
  'volt-tackle':   { status: 'paralysis', chance: 0.1 },
  'bounce':        { status: 'paralysis', chance: 0.3 },
  // Burn
  'will-o-wisp':   { status: 'burn', chance: 1 },
  'ember':         { status: 'burn', chance: 0.1 },
  'flamethrower':  { status: 'burn', chance: 0.1 },
  'fire-blast':    { status: 'burn', chance: 0.1 },
  'fire-punch':    { status: 'burn', chance: 0.1 },
  'flame-wheel':   { status: 'burn', chance: 0.1 },
  'blaze-kick':    { status: 'burn', chance: 0.1 },
  'heat-wave':     { status: 'burn', chance: 0.1 },
  'sacred-fire':   { status: 'burn', chance: 0.5 },
  'scald':         { status: 'burn', chance: 0.3 },
  'lava-plume':    { status: 'burn', chance: 0.3 },
  'magma-storm':   { status: 'burn', chance: 0.3 },
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
  // Sleep
  'hypnosis':      { status: 'sleep', chance: 1 },
  'sleep-powder':  { status: 'sleep', chance: 1 },
  'spore':         { status: 'sleep', chance: 1 },
  'lovely-kiss':   { status: 'sleep', chance: 1 },
  'sing':          { status: 'sleep', chance: 1 },
  'grass-whistle': { status: 'sleep', chance: 1 },
  'dark-void':     { status: 'sleep', chance: 1 },
  // Freeze
  'ice-beam':      { status: 'freeze', chance: 0.1 },
  'blizzard':      { status: 'freeze', chance: 0.1 },
  'ice-punch':     { status: 'freeze', chance: 0.1 },
  'freeze-dry':    { status: 'freeze', chance: 0.1 },
  'powder-snow':   { status: 'freeze', chance: 0.1 },
  // Confusion
  'confuse-ray':   { status: 'confusion', chance: 1 },
  'supersonic':    { status: 'confusion', chance: 1 },
  'sweet-kiss':    { status: 'confusion', chance: 1 },
  'teeter-dance':  { status: 'confusion', chance: 1 },
  'flatter':       { status: 'confusion', chance: 1 },
  'swagger':       { status: 'confusion', chance: 1 },
  'dynamicpunch':  { status: 'confusion', chance: 1 },
  'hurricane':     { status: 'confusion', chance: 0.3 },
  'dizzy-punch':   { status: 'confusion', chance: 0.2 },
  'confusion':     { status: 'confusion', chance: 0.1 },
  'psybeam':       { status: 'confusion', chance: 0.1 },
  'water-pulse':   { status: 'confusion', chance: 0.2 },
};

// Non-zero move priority values. Only moves deviating from 0 are listed.
export const MOVE_PRIORITY: Record<string, number> = {
  // +3
  'detect': 3, 'endure': 3, 'protect': 3, 'kings-shield': 3, 'spiky-shield': 3,
  'baneful-bunker': 3, 'obstruct': 3, 'quick-guard': 3, 'wide-guard': 3,
  // +2
  'extreme-speed': 2, 'feint': 2, 'first-impression': 2,
  // +1
  'aqua-jet': 1, 'baby-doll-eyes': 1, 'bullet-punch': 1, 'ice-shard': 1,
  'mach-punch': 1, 'quick-attack': 1, 'shadow-sneak': 1, 'sucker-punch': 1,
  'vacuum-wave': 1, 'water-shuriken': 1,
  // -1
  'vital-throw': -1,
  // -3
  'focus-punch': -3, 'revenge': -3, 'avalanche': -3,
  // -4
  'roar': -4, 'whirlwind': -4, 'dragon-tail': -4, 'circle-throw': -4,
  // -5
  'trick-room': -5,
  // -6
  'counter': -6, 'mirror-coat': -6,
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
  // Recovery
  'recover', 'soft-boiled', 'roost', 'moonlight', 'morning-sun',
  'synthesis', 'rest', 'slack-off', 'milk-drink', 'heal-order', 'shore-up',
  // Other self-targeting
  'endure', 'belly-drum', 'substitute', 'ingrain', 'aqua-ring', 'magnet-rise', 'stockpile', 'curse',
  // Protect family
  'protect', 'detect', 'kings-shield', 'spiky-shield', 'baneful-bunker', 'obstruct',
]);

// Maps each protect-family move to the volatile condition it pushes.
// The condition name encodes which variant was used so the hit loop can apply the correct contact side-effect.
export const PROTECT_VOLATILE: Record<string, string> = {
  'protect':        'protecting',
  'detect':         'protecting',
  'kings-shield':   'protecting-kings-shield',
  'spiky-shield':   'protecting-spiky-shield',
  'baneful-bunker': 'protecting-baneful-bunker',
  'obstruct':       'protecting-obstruct',
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
  'stockpile':       [{ stat: 'def', stages: 1, target: 'self' }, { stat: 'spd', stages: 1, target: 'self' }],
  // Curse: non-Ghost variant (+1 Atk, +1 Def, −1 Spe). Ghost variant is handled separately in battles.ts.
  'curse':           [{ stat: 'atk', stages: 1, target: 'self' }, { stat: 'def', stages: 1, target: 'self' }, { stat: 'spe', stages: -1, target: 'self' }],
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
  // ── Damaging moves — chance-based self stat boost ──────────────────────────
  'charge-beam':   [{ stat: 'spa', stages: 1, target: 'self', chance: 0.7 }],
  'meteor-mash':   [{ stat: 'atk', stages: 1, target: 'self', chance: 0.2 }],
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
};

// All move IDs that require no enemy target selection.
// Sent to the client via the state endpoint so the UI can skip the target picker.
export const NO_TARGET_MOVE_IDS = new Set([
  ...Object.keys(WEATHER_MOVES),
  ...SELF_TARGETING_MOVES,
]);

// Moves that gain +1 priority when used by a Pokémon with Prankster.
// Derived from pure status moves (chance === 1), non-charging self-targeting moves,
// and weather moves — all are "Status" category in PokeAPI.
export const PRANKSTER_MOVES = new Set([
  ...Object.entries(STATUS_MOVES).filter(([, v]) => v.chance === 1).map(([k]) => k),
  ...[...SELF_TARGETING_MOVES].filter(m => !CHARGE_MOVES.has(m)),
  ...Object.keys(WEATHER_MOVES),
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
