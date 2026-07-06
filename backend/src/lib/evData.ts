import { BaseStats } from './statCalc';

export const EV_STAT_CAP = 252;
export const EV_TOTAL_CAP = 510;
export const EV_STAT_DISPLAY_NAMES: Record<keyof BaseStats, string> = {
  hp: 'HP', atk: 'Attack', def: 'Defense', spatk: 'Sp. Atk', spdef: 'Sp. Def', speed: 'Speed',
};

// Adds `gain` to `current`, clamped to the 252-per-stat / 510-total EV caps.
// Returns the new spread plus the display names of stats that actually increased.
export function applyEvGain(current: BaseStats, gain: BaseStats): { evs: BaseStats; gainedStats: string[] } {
  const evs = { ...current };
  const gainedStats: string[] = [];
  let total = (Object.keys(evs) as (keyof BaseStats)[]).reduce((sum, k) => sum + evs[k], 0);
  for (const stat of Object.keys(gain) as (keyof BaseStats)[]) {
    if (total >= EV_TOTAL_CAP) break;
    const room = Math.min(EV_STAT_CAP - evs[stat], EV_TOTAL_CAP - total, gain[stat]);
    if (room > 0) {
      evs[stat] += room;
      total += room;
      gainedStats.push(EV_STAT_DISPLAY_NAMES[stat]);
    }
  }
  return { evs, gainedStats };
}
