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
