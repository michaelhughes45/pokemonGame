import mongoose, { Schema } from 'mongoose';

type PokemonMove = {
  moveId: string;
  currentPP: number;
  maxPP: number;
  ppUps: number; // 0-3, how many PP Up/PP Max applications this move slot has received
};

type StatSpread = {
  hp: number; atk: number; def: number;
  spatk: number; spdef: number; speed: number;
};

type VolatileStatus = {
  condition: string;
  turnsRemaining: number;
};

type EvolutionOverride = {
  condition: string;
  value: string;
};

type IPokemon = {
  speciesId: number;
  ownerId: mongoose.Types.ObjectId;
  ownerType: 'player' | 'npc' | 'wild';
  nickname: string | null;
  level: number;
  exp: number;
  currentHp: number;
  nature: string;
  gender: 'male' | 'female' | 'none';
  heldItem: string | null;
  moves: PokemonMove[];
  evs: StatSpread;
  statusCondition: 'burn' | 'paralysis' | 'sleep' | 'freeze' | 'poison' | 'toxic' | null;
  statusCounter: number | null;
  volatileStatus: VolatileStatus[];
  evolutionOverrides: EvolutionOverride[];
  hasHiddenAbility: boolean;
  isInParty: boolean;
  partySlot: number | null;
  caughtAt: Date | null;
  caughtByPlayerId: mongoose.Types.ObjectId | null;
};

const StatSpreadSchema = new Schema<StatSpread>(
  { hp: Number, atk: Number, def: Number, spatk: Number, spdef: Number, speed: Number },
  { _id: false }
);

const PokemonSchema = new Schema<IPokemon>(
  {
    speciesId:     { type: Number, required: true },
    ownerId:       { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    ownerType:     { type: String, enum: ['player', 'npc', 'wild'], required: true },
    nickname:      { type: String, default: null },
    level:         { type: Number, required: true },
    exp:           { type: Number, default: 0 },
    currentHp:     { type: Number, required: true },
    nature:        { type: String, required: true },
    gender:        { type: String, enum: ['male', 'female', 'none'], required: true },
    heldItem:      { type: String, default: null },
    moves: [
      {
        moveId:    { type: String, required: true },
        currentPP: { type: Number, required: true },
        maxPP:     { type: Number, required: true },
        ppUps:     { type: Number, default: 0 },
        _id:       false,
      },
    ],
    evs: {
      type: StatSpreadSchema,
      default: () => ({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, speed: 0 }),
    },
    statusCondition: {
      type: String,
      enum: ['burn', 'paralysis', 'sleep', 'freeze', 'poison', 'toxic', null],
      default: null,
    },
    statusCounter: { type: Number, default: null },
    volatileStatus: [
      {
        condition:      { type: String, required: true },
        turnsRemaining: { type: Number, required: true },
        _id:            false,
      },
    ],
    evolutionOverrides: [
      {
        condition: { type: String, required: true },
        value:     { type: String, required: true },
        _id:       false,
      },
    ],
    hasHiddenAbility: { type: Boolean, default: false },
    isInParty:        { type: Boolean, default: false },
    partySlot:        { type: Number, default: null },
    caughtAt:         { type: Date, default: null },
    caughtByPlayerId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
  },
  { timestamps: true }
);

export const Pokemon = mongoose.model<IPokemon>('Pokemon', PokemonSchema);
