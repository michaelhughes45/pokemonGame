import { PokedexCache } from '../models/PokedexCache';

type EvolutionOverride = { condition: string; value: string };
type EvolutionStep    = { speciesId: number; condition: string; value: string };

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
  // Filter to steps that: target a different species, require level-up, and the threshold
  // has already been reached. Sort descending so the highest threshold wins if multiple match.
  const eligible = chain
    .filter(
      step =>
        step.condition === 'level-up' &&
        step.speciesId !== pokemon.speciesId &&
        parseInt(step.value, 10) <= pokemon.level
    )
    .sort((a, b) => parseInt(b.value, 10) - parseInt(a.value, 10));

  return eligible[0]?.speciesId ?? null;
}
