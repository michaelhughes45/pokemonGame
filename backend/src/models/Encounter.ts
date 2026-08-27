import mongoose, { Schema } from 'mongoose';

// ---------------------------------------------------------------------------
// Sub-document types
// ---------------------------------------------------------------------------

// PvE encounters: reference campaign NPCs by ID.
// slotCount: how many simultaneous active slots this NPC gets in the battle.
// null = match playerIds.length at launch time (original behaviour).
type EnemyEntry = {
  npcId:      mongoose.Types.ObjectId;
  slotCount:  number | null;
};

// Wild encounters: one entry per Pokémon that will be generated at launch.
// level is the exact level (not a range — the DM picks the level at build time).
// catchable controls whether players can throw Poké Balls at that slot.
type WildPokemonEntry = {
  speciesId: number; // PokeAPI national dex ID
  level: number;
  catchable: boolean;
};

// ---------------------------------------------------------------------------
// Top-level encounter document type
// ---------------------------------------------------------------------------

export type IEncounter = {
  campaignId: mongoose.Types.ObjectId;
  createdByDm: mongoose.Types.ObjectId;
  title: string;
  type: 'pve' | 'wild' | 'pvp';
  // PvE: which NPCs appear. Wild/PvP: leave empty.
  enemies: EnemyEntry[];
  // Wild: which Pokémon to generate at launch. PvE/PvP: leave empty.
  wildPokemon: WildPokemonEntry[];
  // Max distinct Pokémon each player may send out. null = no limit (full party of 6).
  // Carried into the Battle document when this encounter is launched.
  playerPokemonLimit: number | null;
  // Max NPC Pokémon that must faint before the enemy side is eliminated.
  // null = all NPC Pokémon must faint. Carried into the Battle document at launch.
  npcPokemonLimit: number | null;
  // EXP multiplier applied to all EXP awards during the battle. 1 = normal.
  // Carried into the Battle document at launch; read by awardExpToSide.
  expMultiplier: number;
  // pve only — Pokédollars paid to every playerSide trainer (not split) on victory.
  // Carried into the Battle document at launch. Always 0 for wild encounters.
  moneyReward: number;
  notes: string;
  isActive: boolean;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EncounterSchema = new Schema<IEncounter>(
  {
    campaignId:  { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    createdByDm: { type: Schema.Types.ObjectId, ref: 'User',     required: true },
    title:       { type: String, required: true, trim: true },
    type:        { type: String, enum: ['pve', 'wild', 'pvp'], required: true },

    enemies: [
      {
        npcId:     { type: Schema.Types.ObjectId, ref: 'Npc', required: true },
        slotCount: { type: Number, default: null },
        _id:       false,
      },
    ],

    wildPokemon: [
      {
        speciesId: { type: Number, required: true },
        level:     { type: Number, required: true },
        catchable: { type: Boolean, default: true },
        _id:       false,
      },
    ],

    playerPokemonLimit: { type: Number, default: null },
    npcPokemonLimit:    { type: Number, default: null },
    expMultiplier:      { type: Number, default: 1 },
    moneyReward:        { type: Number, default: 0 },
    notes:              { type: String, default: '' },
    isActive:           { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Encounter = mongoose.model<IEncounter>('Encounter', EncounterSchema);
