import { Pokemon } from '../models/Pokemon';
import { PokedexCache } from '../models/PokedexCache';
import { computeStats, BaseStats } from './statCalc';

type HealablePokemon = {
  _id: unknown;
  speciesId: number;
  level: number;
  nature: string;
  evs: BaseStats;
  currentHp: number;
  moves: { moveId: string; currentPP: number; maxPP: number }[];
};

// Restores every Pokémon in `party` to full HP + PP and clears status/volatile
// conditions. Shared by the player's own heal-party action and the DM's
// heal-NPC-party action — the only real difference between the two call sites
// is which IVs to compute max HP with (a player's Trainer IV spread vs
// ZERO_IVS for NPCs, which never carry one).
export async function healPartyPokemon(party: HealablePokemon[], ivs: BaseStats): Promise<void> {
  const speciesIds = [...new Set(party.map(p => p.speciesId))];
  const caches   = await PokedexCache.find({ pokeApiId: { $in: speciesIds } }, 'pokeApiId baseStats').lean();
  const cacheMap = new Map(caches.map(c => [c.pokeApiId as number, c]));

  await Promise.all(party.map(poke => {
    const cache = cacheMap.get(poke.speciesId);
    const maxHp = cache ? computeStats(cache.baseStats as BaseStats, poke.level, poke.nature, poke.evs, ivs).hp : poke.currentHp;
    const fullMoves = poke.moves.map(m => ({ ...m, currentPP: m.maxPP }));
    return Pokemon.updateOne(
      { _id: poke._id },
      { $set: { currentHp: maxHp, statusCondition: null, statusCounter: null, volatileStatus: [], moves: fullMoves } },
    );
  }));
}
