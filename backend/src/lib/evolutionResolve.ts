import { PokedexCache } from '../models/PokedexCache';
import { fetchSpecies } from './pokeapi';
import { computeStats, BaseStats } from './statCalc';
import { slugToDisplayName } from './battleCalc';

// Resolves the species a Pokémon just evolved into (fetching + caching it on a
// cache miss) and computes its full HP at the Pokémon's current level/nature/
// EVs/IVs. Shared by every evolution-trigger path (Rare Candy, evolution items,
// the battle/DM/Rare-Candy level-up loop) so the cache-miss fallback and the
// full-heal-on-evolve HP recompute stay identical everywhere. `fullHp` is null
// only when the species' base stats couldn't be resolved at all — callers should
// leave the Pokémon's current HP untouched in that case.
export async function resolveEvolvedSpecies(
  evolveIntoId: number,
  level: number,
  nature: string,
  evs: BaseStats,
  ivs: BaseStats,
): Promise<{ displayName: string; fullHp: number | null }> {
  let evolved = await PokedexCache.findOne({ pokeApiId: evolveIntoId }).select('name baseStats').lean();
  if (!evolved) {
    try {
      const fetched = await fetchSpecies(evolveIntoId);
      const created = await PokedexCache.create(fetched);
      evolved = created.toObject();
    } catch { /* leave evolved null — name falls back below */ }
  }
  const fullHp = evolved?.baseStats
    ? computeStats(evolved.baseStats as BaseStats, level, nature, evs, ivs).hp
    : null;
  const displayName = evolved ? slugToDisplayName(evolved.name as string) : 'a new form';
  return { displayName, fullHp };
}
