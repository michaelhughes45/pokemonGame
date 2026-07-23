// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BaseStats = {
  hp: number; atk: number; def: number;
  spatk: number; spdef: number; speed: number;
};

type Ability = {
  name: string; isHidden: boolean; effect: string; implemented: boolean;
};

type Move = {
  name: string; type: string; category: string;
  power: number | null; accuracy: number | null;
  pp: number | null; priority: number;
  effect: string; flavorText: string; target: string; implemented: boolean;
};

type EvolutionStep = { speciesId: number; condition: string; value: string };

type LevelUpMove = { moveId: string; level: number };

export type TransformedSpecies = {
  pokeApiId: number;
  name: string;
  types: string[];
  baseStats: BaseStats;
  abilities: Ability[];
  moves: Move[];
  levelUpMoves: LevelUpMove[]; // sorted ascending by level, used for moveset calculation
  machineMoves: string[]; // moves this species can learn via TM/HM, in any game version
  evolutionChain: EvolutionStep[];
  evYield: BaseStats;
  catchRate: number;
  expGroup: string;
  genderRatio: number;
  isLegendary: boolean;
  isMythical: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// PokeAPI URLs end with the numeric ID, e.g. ".../pokemon-species/25/"
function extractIdFromUrl(url: string): number {
  const parts = url.split('/').filter(Boolean);
  return parseInt(parts[parts.length - 1], 10);
}

// PokeAPI returns the evolution chain as a recursive tree.
// We flatten it into a list of steps: each step is the species that
// results from the evolution, plus the condition that triggers it.
function flattenEvolutionChain(chain: any): EvolutionStep[] {
  const steps: EvolutionStep[] = [];

  function walk(node: any) {
    for (const next of node.evolves_to) {
      const speciesId = extractIdFromUrl(next.species.url);
      const detail = next.evolution_details[0]; // most pokemon have one trigger

      let condition = '';
      let value = '';

      if (detail) {
        condition = detail.trigger.name; // 'level-up' | 'use-item' | 'trade' | etc.

        if (detail.trigger.name === 'level-up' && detail.min_level) {
          value = String(detail.min_level);
        } else if (detail.trigger.name === 'use-item' && detail.item) {
          value = detail.item.name;
        } else if (detail.trigger.name === 'trade' && detail.held_item) {
          value = detail.held_item.name;
        }
        // Additional trigger types can be handled here in later milestones
      }

      steps.push({ speciesId, condition, value });
      walk(next); // recurse for multi-stage evolutions (e.g. Bulba → Ivy → Venu)
    }
  }

  walk(chain);
  return steps;
}

// Map PokeAPI stat names to our schema keys
const STAT_KEY_MAP: Record<string, keyof BaseStats> = {
  hp:              'hp',
  attack:          'atk',
  defense:         'def',
  'special-attack': 'spatk',
  'special-defense': 'spdef',
  speed:           'speed',
};

function emptyStats(): BaseStats {
  return { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 };
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

export async function fetchSpecies(idOrName: string | number): Promise<TransformedSpecies> {
  // --- Round 1: fetch base pokemon data and species data in parallel ---
  const [pokemonRes, speciesRes] = await Promise.all([
    fetch(`https://pokeapi.co/api/v2/pokemon/${idOrName}`),
    fetch(`https://pokeapi.co/api/v2/pokemon-species/${idOrName}`),
  ]);

  if (!pokemonRes.ok) throw new Error(`Pokemon not found: ${idOrName}`);
  if (!speciesRes.ok) throw new Error(`Species not found: ${idOrName}`);

  const pokemon = await pokemonRes.json() as any;
  const species = await speciesRes.json() as any;

  // Extract base stats and EV yields from the stats array
  const baseStats = emptyStats();
  const evYield   = emptyStats();

  for (const s of pokemon.stats) {
    const key = STAT_KEY_MAP[s.stat.name];
    if (key) {
      baseStats[key] = s.base_stat;
      evYield[key]   = s.effort;
    }
  }

  // Collect level-up moves with the level they're first learnable.
  // We take the minimum non-zero level across all game versions — this gives us
  // the earliest point a move could be learned in any mainline game, which is
  // the most inclusive choice for a TTRPG tool that isn't tied to one gen.
  const levelUpMoveData: LevelUpMove[] = [];
  const seen = new Set<string>();
  for (const m of pokemon.moves) {
    const levelUpLevels = (m.version_group_details as any[])
      .filter((d: any) => d.move_learn_method.name === 'level-up' && d.level_learned_at > 0)
      .map((d: any) => d.level_learned_at as number);

    if (levelUpLevels.length > 0 && !seen.has(m.move.name)) {
      seen.add(m.move.name);
      levelUpMoveData.push({
        moveId: m.move.name as string,
        level:  Math.min(...levelUpLevels),
      });
    }
  }
  levelUpMoveData.sort((a, b) => a.level - b.level);

  const levelUpMoveNames = levelUpMoveData.map(m => m.moveId);

  // Collect moves learnable via TM/HM ('machine') in any game version — this
  // is a per-species compatibility list, distinct from the global "does this
  // move exist as a real TM/HM at all" catalog in lib/tmHmData.ts.
  const machineMoveNames: string[] = [];
  const machineSeen = new Set<string>();
  for (const m of pokemon.moves) {
    const isMachineMove = (m.version_group_details as any[])
      .some((d: any) => d.move_learn_method.name === 'machine');
    if (isMachineMove && !machineSeen.has(m.move.name)) {
      machineSeen.add(m.move.name);
      machineMoveNames.push(m.move.name as string);
    }
  }

  // Full move detail (power, type, effect, etc.) is fetched for the union of
  // level-up and machine-learnable moves — a TM-taught move needs the same
  // cached data as a level-up move for battle resolution to find it.
  const detailMoveNames = Array.from(new Set([...levelUpMoveNames, ...machineMoveNames]));

  const abilityNames: string[] = pokemon.abilities.map((a: any) => a.ability.name);
  const abilityIsHiddenMap = new Map<string, boolean>(
    pokemon.abilities.map((a: any) => [a.ability.name, a.is_hidden as boolean])
  );

  // --- Round 2: ability details + evolution chain + move details, all parallel ---
  const [abilityDataList, evolutionChainData, moveDataList] = await Promise.all([
    Promise.all(
      abilityNames.map(name =>
        fetch(`https://pokeapi.co/api/v2/ability/${name}`).then(r => r.json())
      )
    ),
    fetch(species.evolution_chain.url).then(r => r.json()),
    Promise.all(
      detailMoveNames.map(name =>
        fetch(`https://pokeapi.co/api/v2/move/${name}`).then(r => r.json())
      )
    ),
  ]);

  // Transform abilities — prefer English short_effect, fall back to effect
  const abilities: Ability[] = (abilityDataList as any[]).map(data => {
    const entry = (data.effect_entries as any[]).find(e => e.language.name === 'en');
    return {
      name:        data.name as string,
      isHidden:    abilityIsHiddenMap.get(data.name) ?? false,
      effect:      entry?.short_effect ?? entry?.effect ?? '',
      implemented: false,
    };
  });

  // Transform moves
  const moves: Move[] = (moveDataList as any[]).map(data => {
    const entry = (data.effect_entries as any[]).find((e: any) => e.language.name === 'en');
    const flavorEntries = (data.flavor_text_entries as any[]).filter((e: any) => e.language.name === 'en');
    const flavorEntry = flavorEntries[flavorEntries.length - 1]; // newest game version
    return {
      name:        data.name as string,
      type:        data.type.name as string,
      category:    data.damage_class.name as string, // 'physical' | 'special' | 'status'
      power:       data.power ?? null,
      accuracy:    data.accuracy ?? null,
      pp:          data.pp ?? null,
      priority:    data.priority ?? 0,
      effect:      entry?.short_effect ?? entry?.effect ?? '',
      flavorText:  flavorEntry?.flavor_text?.replace(/\n|\f/g, ' ') ?? '',
      target:      data.target?.name ?? '',
      implemented: false,
    };
  });

  return {
    pokeApiId:      pokemon.id as number,
    name:           pokemon.name as string,
    types:          pokemon.types.map((t: any) => t.type.name as string),
    baseStats,
    abilities,
    moves,
    levelUpMoves:   levelUpMoveData,
    machineMoves:   machineMoveNames,
    evolutionChain: flattenEvolutionChain((evolutionChainData as any).chain),
    evYield,
    catchRate:      species.capture_rate as number,
    expGroup:       species.growth_rate.name as string,
    genderRatio:    species.gender_rate as number,
    isLegendary:    species.is_legendary as boolean,
    isMythical:     species.is_mythical as boolean,
  };
}
