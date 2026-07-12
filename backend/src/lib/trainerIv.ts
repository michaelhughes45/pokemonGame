import mongoose from 'mongoose';
import { User } from '../models/User';
import { BaseStats, ZERO_IVS } from './statCalc';

export const TRAINER_IV_PER_BADGE = 5;

// Total IV points a trainer has ever earned — uncapped, grows automatically
// with badge count. Never stored; always derived fresh, same as the level cap.
export function getTrainerIvPool(badgeCount: number): number {
  return badgeCount * TRAINER_IV_PER_BADGE;
}

// Normalizes a stored spread (Mongoose Map, plain object, or missing) into a
// full BaseStats-shaped object — every stat present, defaulting to 0. This is
// the only shape sent to the client or passed to computeStats(), matching how
// EVs are always a full 6-key object rather than a sparse map.
export function ivsFromSpread(raw: unknown): BaseStats {
  const entries: Iterable<[string, number]> =
    raw instanceof Map ? raw.entries() : Object.entries((raw ?? {}) as Record<string, number>);
  const spread = Object.fromEntries(entries) as Partial<Record<keyof BaseStats, number>>;
  return {
    hp:    spread.hp ?? 0,
    atk:   spread.atk ?? 0,
    def:   spread.def ?? 0,
    spatk: spread.spatk ?? 0,
    spdef: spread.spdef ?? 0,
    speed: spread.speed ?? 0,
  };
}

function sumSpread(ivs: BaseStats): number {
  return ivs.hp + ivs.atk + ivs.def + ivs.spatk + ivs.spdef + ivs.speed;
}

// How many of the trainer's earned points are not yet allocated to any stat.
export function getUnspentTrainerIv(badgeCount: number, raw: unknown): number {
  return getTrainerIvPool(badgeCount) - sumSpread(ivsFromSpread(raw));
}

// Convenience for a single Pokémon: looks up its owner's spent IV spread.
// NPC/wild Pokémon never carry a bonus. One User lookup per call — call sites
// processing a whole list for one known owner should fetch the User once and
// reuse ivsFromSpread directly instead of calling this per Pokémon.
export async function getIvsForOwner(
  ownerId: mongoose.Types.ObjectId | string,
  ownerType: string,
): Promise<BaseStats> {
  if (ownerType !== 'player') return ZERO_IVS;
  const user = await User.findById(ownerId, 'trainerStats').lean();
  if (!user) return ZERO_IVS;
  return ivsFromSpread(user.trainerStats);
}
