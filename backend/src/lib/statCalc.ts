type StatKey = 'atk' | 'def' | 'spatk' | 'spdef' | 'speed';

// Maps a nature name to which non-HP stat it boosts (+10%) and drops (-10%).
// Neutral natures (Hardy, Docile, Serious, Bashful, Quirky) have no entry.
const NATURE_MODIFIERS: Record<string, { boost?: StatKey; drop?: StatKey }> = {
  Lonely:  { boost: 'atk',   drop: 'def'   },
  Brave:   { boost: 'atk',   drop: 'speed' },
  Adamant: { boost: 'atk',   drop: 'spatk' },
  Naughty: { boost: 'atk',   drop: 'spdef' },
  Bold:    { boost: 'def',   drop: 'atk'   },
  Relaxed: { boost: 'def',   drop: 'speed' },
  Impish:  { boost: 'def',   drop: 'spatk' },
  Lax:     { boost: 'def',   drop: 'spdef' },
  Timid:   { boost: 'speed', drop: 'atk'   },
  Hasty:   { boost: 'speed', drop: 'def'   },
  Jolly:   { boost: 'speed', drop: 'spatk' },
  Naive:   { boost: 'speed', drop: 'spdef' },
  Modest:  { boost: 'spatk', drop: 'atk'   },
  Mild:    { boost: 'spatk', drop: 'def'   },
  Quiet:   { boost: 'spatk', drop: 'speed' },
  Rash:    { boost: 'spatk', drop: 'spdef' },
  Calm:    { boost: 'spdef', drop: 'atk'   },
  Gentle:  { boost: 'spdef', drop: 'def'   },
  Sassy:   { boost: 'spdef', drop: 'speed' },
  Careful: { boost: 'spdef', drop: 'spatk' },
};

export type BaseStats = {
  hp: number; atk: number; def: number;
  spatk: number; spdef: number; speed: number;
};

// Returns total accumulated EXP needed to reach `level` for a given growth rate.
// PokeAPI group names: slow, medium-fast, fast, medium-slow, slow-then-very-fast, fast-then-very-slow
export function expForLevel(level: number, expGroup: string): number {
  const n = level;
  switch (expGroup) {
    case 'slow':
      return Math.floor(5 * n ** 3 / 4);
    case 'medium':
    case 'medium-fast':
      return n ** 3;
    case 'fast':
      return Math.floor(4 * n ** 3 / 5);
    case 'medium-slow':
      return Math.max(0, Math.floor(6 * n ** 3 / 5 - 15 * n ** 2 + 100 * n - 140));
    case 'slow-then-very-fast': // erratic
      if (n <= 50) return Math.floor(n ** 3 * (100 - n) / 50);
      if (n <= 68) return Math.floor(n ** 3 * (150 - n) / 100);
      if (n <= 98) return Math.floor(n ** 3 * Math.floor((1911 - 10 * n) / 3) / 500);
      return Math.floor(n ** 3 * (160 - n) / 100);
    case 'fast-then-very-slow': // fluctuating
      if (n <= 15) return Math.floor(n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50);
      if (n <= 35) return Math.floor(n ** 3 * (n + 14) / 50);
      return Math.floor(n ** 3 * (Math.floor(n / 2) + 32) / 50);
    default:
      return n ** 3; // fallback to medium-fast
  }
}

// Gen 3+ stat formula. No IVs/EVs until Phase 5 (both treated as 0).
export function computeStats(base: BaseStats, level: number, nature: string): BaseStats {
  const mod = NATURE_MODIFIERS[nature] ?? {};

  function calcOther(b: number, key: StatKey): number {
    const raw  = Math.floor((2 * b * level) / 100) + 5;
    const mult = mod.boost === key ? 1.1 : mod.drop === key ? 0.9 : 1.0;
    return Math.floor(raw * mult);
  }

  return {
    hp:    Math.floor((2 * base.hp * level) / 100) + level + 10,
    atk:   calcOther(base.atk,   'atk'),
    def:   calcOther(base.def,   'def'),
    spatk: calcOther(base.spatk, 'spatk'),
    spdef: calcOther(base.spdef, 'spdef'),
    speed: calcOther(base.speed, 'speed'),
  };
}
