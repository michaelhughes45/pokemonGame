import { PokedexCache } from '../models/PokedexCache';

export type NewMoveSlot = { moveId: string; currentPP: number; maxPP: number; ppUps: number };

// Every level-up path (battle EXP, DM award-exp/level-up, Rare Candy) increments a
// Pokémon's level without ever touching its moveset — only the Move Reminder
// (replaceMoveSlot) and TM/HM teaching add/replace moves, both of which require an
// already-full 4 moves to pick a slot to overwrite. A Pokémon that hasn't yet filled
// all 4 slots (freshly caught below its species' natural moveset, etc.) needs newly
// learnable moves to fill those open slots automatically, same as the mainline games
// do below 4 known moves. Never overwrites an existing move — that stays Move
// Reminder/TM-only by design, matching how this project already treats "learn a move
// past 4" as a deliberate player action rather than automatic.
export async function getAutoLearnedMoves(
  speciesId: number,
  level: number,
  knownMoveIds: string[],
  knownMoveCount: number,
): Promise<NewMoveSlot[]> {
  if (knownMoveCount >= 4) return [];

  const species = await PokedexCache.findOne({ pokeApiId: speciesId })
    .select('levelUpMoves moves')
    .lean();
  if (!species) return [];

  const levelUpMoves = (species.levelUpMoves ?? []) as { moveId: string; level: number }[];
  const moveList     = (species.moves ?? []) as { name: string; pp: number | null }[];
  const known        = new Set(knownMoveIds);

  const learnable = levelUpMoves.filter(m => m.level === level && !known.has(m.moveId));

  const newMoves: NewMoveSlot[] = [];
  let slotsOpen = 4 - knownMoveCount;
  for (const m of learnable) {
    if (slotsOpen <= 0) break;
    const pp = moveList.find(mv => mv.name === m.moveId)?.pp ?? 5;
    newMoves.push({ moveId: m.moveId, currentPP: pp, maxPP: pp, ppUps: 0 });
    slotsOpen -= 1;
  }

  return newMoves;
}
