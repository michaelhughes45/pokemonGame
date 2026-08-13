import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { expForLevel } from './statCalc';

// One-time migration: bumps any Pokémon whose exp is below the minimum for
// their level up to expForLevel(level, expGroup). Safe to run multiple times
// — only touches Pokémon that still need fixing. Shared by the admin and DM
// fix-pokemon-exp routes, which are otherwise identical.
export async function fixAllPokemonExp(): Promise<{ fixed: number; total: number }> {
  const allPokemon = await Pokemon.find({}, '_id speciesId level exp').lean();

  const speciesIds = [...new Set(allPokemon.map(p => p.speciesId))];
  const caches = await PokedexCache.find(
    { pokeApiId: { $in: speciesIds } },
    'pokeApiId expGroup',
  ).lean();
  const expGroupMap = new Map(
    caches.map(c => [c.pokeApiId as number, (c.expGroup as string) || 'medium-fast']),
  );

  const toFix = allPokemon
    .map(p => ({ ...p, minExp: expForLevel(p.level, expGroupMap.get(p.speciesId) ?? 'medium-fast') }))
    .filter(p => p.exp < p.minExp);

  await Promise.all(toFix.map(p =>
    Pokemon.updateOne({ _id: p._id }, { $set: { exp: p.minExp } }),
  ));

  return { fixed: toFix.length, total: allPokemon.length };
}
