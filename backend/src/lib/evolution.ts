import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from './pokeapi';

type EvolutionOverride = { condition: string; value: string };
type EvolutionStep    = { speciesId: number; condition: string; value: string };
type EvolutionStepWithFrom = EvolutionStep & { fromSpeciesId?: number | null; gender?: number | null };

/**
 * Returns the speciesId the Pokémon should evolve into, or null if no
 * level-up evolution should trigger right now.
 *
 * Only handles condition === 'level-up'. Item/trade evolutions are triggered
 * explicitly (Phase 4+) and are not checked here.
 */
export async function canEvolve(pokemon: {
  speciesId: number;
  level: number;
  evolutionOverrides: EvolutionOverride[];
}): Promise<number | null> {
  if (pokemon.evolutionOverrides.some(o => o.condition === 'prevent')) return null;

  const species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }).lean();
  if (!species) return null;

  const chain = (species.evolutionChain ?? []) as EvolutionStep[];

  // The stored chain covers the whole line (e.g. Bulba→Ivy→Venu all on Bulbasaur's entry).
  // Sort ascending so the chain is in evolution order, then find where the current species
  // sits. The next step after it is the only valid forward evolution — checking all steps
  // that meet the level threshold would incorrectly flag prior evolutions as eligible
  // (e.g. Venusaur seeing Ivysaur@16 and "devolving").
  const levelUpChain = chain
    .filter(step => step.condition === 'level-up')
    .sort((a, b) => parseInt(a.value, 10) - parseInt(b.value, 10));

  const currentIdx = levelUpChain.findIndex(step => step.speciesId === pokemon.speciesId);
  // Base species is not listed as a target in the chain, so currentIdx === -1 → next is [0].
  const nextStep = levelUpChain[currentIdx + 1];

  if (!nextStep) return null;
  return parseInt(nextStep.value, 10) <= pokemon.level ? nextStep.speciesId : null;
}

// PokeAPI's gender convention on an evolution_details entry: 1 = female, 2 = male,
// absent/null = no gender requirement. Maps to this project's stored gender string.
function genderMatches(stepGender: number | null | undefined, pokemonGender: string): boolean {
  if (stepGender == null) return true;
  if (stepGender === 1) return pokemonGender === 'female';
  if (stepGender === 2) return pokemonGender === 'male';
  return true;
}

/**
 * Returns the speciesId a Pokémon should evolve into by using a given item
 * (a Fire Stone, Sweet Apple, etc. — milestone 5.17c), or null if that item
 * doesn't trigger an evolution for this Pokémon right now.
 *
 * Unlike canEvolve's level-up path (which approximates "next step" by sorted
 * position, since level thresholds are inherently ordered), item matching is
 * exact: every use-item step records which species it evolves FROM
 * (fromSpeciesId), so this only ever matches a step that's actually reachable
 * from the Pokémon's current species — safe even for branching lines (Eevee)
 * where multiple items lead to different targets from the same source.
 */
export async function canEvolveWithItem(pokemon: {
  speciesId: number;
  gender: string;
  evolutionOverrides: EvolutionOverride[];
}, itemId: string): Promise<number | null> {
  if (pokemon.evolutionOverrides.some(o => o.condition === 'prevent')) return null;

  let species = await PokedexCache.findOne({ pokeApiId: pokemon.speciesId }).lean();
  if (!species) return null;

  let chain = (species.evolutionChain ?? []) as EvolutionStepWithFrom[];

  // Cache entries fetched before milestone 5.17c have use-item steps with no
  // fromSpeciesId — same auto-refresh-on-touch convention as levelUpMoves/
  // machineMoves backfilling in earlier milestones, scoped to only the species
  // that actually needs it (an item-evolution check on it).
  const needsRefresh = chain.some(step => step.condition === 'use-item' && step.fromSpeciesId == null);
  if (needsRefresh) {
    try {
      const fetched = await fetchSpecies(pokemon.speciesId);
      await PokedexCache.updateOne(
        { pokeApiId: pokemon.speciesId },
        { $set: { evolutionChain: fetched.evolutionChain } },
      );
      chain = fetched.evolutionChain as EvolutionStepWithFrom[];
    } catch { /* fall through with the stale chain — worst case, this item won't match */ }
  }

  const step = chain.find(s =>
    s.condition === 'use-item' && s.value === itemId
    && s.fromSpeciesId === pokemon.speciesId
    && genderMatches(s.gender, pokemon.gender),
  );

  return step ? step.speciesId : null;
}
