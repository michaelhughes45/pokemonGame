import { Schema, model } from 'mongoose';

const AbilitySchema = new Schema(
  {
    name:        { type: String, required: true },
    isHidden:    { type: Boolean, required: true },
    effect:      { type: String, default: '' },
    implemented: { type: Boolean, default: false },
  },
  { _id: false }
);

const MoveSchema = new Schema(
  {
    name:        { type: String, required: true },
    type:        { type: String, default: '' },
    category:    { type: String, default: '' }, // 'physical' | 'special' | 'status'
    power:       { type: Number, default: null },
    accuracy:    { type: Number, default: null },
    pp:          { type: Number, default: null },
    priority:    { type: Number, default: 0 },
    effect:      { type: String, default: '' },
    implemented: { type: Boolean, default: false },
  },
  { _id: false }
);

const EvolutionStepSchema = new Schema(
  {
    speciesId:  { type: Number, required: true },
    condition:  { type: String, default: '' }, // e.g. 'level-up', 'use-item'
    value:      { type: String, default: '' }, // e.g. '16', 'fire-stone'
  },
  { _id: false }
);

const StatSchema = new Schema(
  {
    hp:    { type: Number, default: 0 },
    atk:   { type: Number, default: 0 },
    def:   { type: Number, default: 0 },
    spatk: { type: Number, default: 0 },
    spdef: { type: Number, default: 0 },
    speed: { type: Number, default: 0 },
  },
  { _id: false }
);

// Compact record used to determine a Pokémon's starting moveset by level.
// Stored separately from the full MoveSchema to keep the two concerns distinct:
// MoveSchema = Pokédex display data; LevelUpMoveSchema = moveset calculation.
const LevelUpMoveSchema = new Schema(
  {
    moveId: { type: String, required: true }, // PokeAPI slug == move name
    level:  { type: Number, required: true }, // minimum level across all game versions
  },
  { _id: false }
);

const PokedexCacheSchema = new Schema(
  {
    pokeApiId:      { type: Number, required: true, unique: true },
    name:           { type: String, required: true },
    types:          [{ type: String }],
    baseStats:      { type: StatSchema, required: true },
    abilities:      [AbilitySchema],
    moves:          [MoveSchema],
    levelUpMoves:   [LevelUpMoveSchema], // for moveset calculation — see LevelUpMoveSchema
    evolutionChain: [EvolutionStepSchema],
    evYield:        { type: StatSchema, required: true },
    catchRate:      { type: Number, default: 0 },
    expGroup:       { type: String, default: '' },
    genderRatio:    { type: Number, default: -1 }, // -1 = genderless, 0–8 = female eighths
    isLegendary:    { type: Boolean, default: false },
    isMythical:     { type: Boolean, default: false },
    cachedAt:       { type: Date, default: Date.now },
  },
  { timestamps: false }
);

export const PokedexCache = model('PokedexCache', PokedexCacheSchema);
