import mongoose, { Schema } from 'mongoose';

// ---------------------------------------------------------------------------
// Sub-document types
// ---------------------------------------------------------------------------

export type StatStages = {
  atk: number; def: number; spa: number; spd: number;
  spe: number; acc: number; eva: number;
};

export type PlayerSideEntry = {
  userId: mongoose.Types.ObjectId;
  activePokemonId: mongoose.Types.ObjectId | null;
  activeSentOutOnTurn: number | null;
  usedPokemonIds: mongoose.Types.ObjectId[];
  fainted: mongoose.Types.ObjectId[];
};

export type EnemySideEntry = {
  npcId?: mongoose.Types.ObjectId;  // absent for wild battles
  activePokemonId: mongoose.Types.ObjectId | null;
  activeSentOutOnTurn: number | null;
  fainted: mongoose.Types.ObjectId[];
};

export type TurnQueueEntry = {
  actorId: mongoose.Types.ObjectId;
  actorType: 'player' | 'npc';
  activePokemonId: mongoose.Types.ObjectId;
  actionType: 'move' | 'item' | 'switch' | 'catch' | 'run';
  moveId?: string;
  // Present only when actionType === 'item'
  itemId?: string;
  // Present only when actionType === 'switch'
  switchToPokemonId?: mongoose.Types.ObjectId;
  // Empty [] during move_submission for moves; pre-filled for item/switch actions
  targets: mongoose.Types.ObjectId[];
  resolved: boolean;
  flinched?: boolean;
};

type FieldCondition = {
  condition: string;
  turnsRemaining: number;
};

type CatchAttempt = {
  playerId: mongoose.Types.ObjectId;
  pokemonId: mongoose.Types.ObjectId;
  result: string;
};

type TurnLogEntry = {
  turn: number;
  events: string[];
};

// ---------------------------------------------------------------------------
// Top-level battle document type
// ---------------------------------------------------------------------------

export type IBattle = {
  campaignId: mongoose.Types.ObjectId;
  // 'pve' | 'wild' | 'pvp' — describes who the sides are.
  // Actual matchup size (1v1, 3v5, etc.) is derived from the
  // lengths of playerSide and enemySide, not stored separately.
  type: 'pve' | 'wild' | 'pvp';
  status: 'waiting' | 'active' | 'complete';
  // phase is only meaningful when status === 'active'
  phase: 'move_submission' | 'targeting' | 'end_of_round';
  playerSide: PlayerSideEntry[];
  enemySide: EnemySideEntry[];
  turnNumber: number;
  turnQueue: TurnQueueEntry[];
  // Index into the speed-sorted turnQueue pointing at who picks targets next
  currentTargetIndex: number;
  weather: 'rain' | 'sun' | 'sandstorm' | 'hail' | 'snow' | null;
  // null = no countdown (DM-set indefinite); number counts down each round
  weatherTurnsRemaining: number | null;
  fieldConditions: FieldCondition[];
  turnLog: TurnLogEntry[];
  catchAttempts: CatchAttempt[];
  // null = no limit (use full party of 6); set by DM when launching
  playerPokemonLimit: number | null;
  // null = no limit (all NPC Pokémon must faint); set by DM when launching
  npcPokemonLimit: number | null;
  // wild battles only — false lets DM use the wild Pokémon as a pure fight
  wildCatchable: boolean;
  // Keyed by pokemonId.toString(). Entries are added on first stage change and
  // deleted when a Pokémon switches out or faints. Schema.Types.Mixed so the
  // map is flexible; call battle.markModified('statStages') after mutations.
  statStages: Record<string, StatStages>;
  // Keyed by pokemonId.toString(). Tracks consecutive use of escalating-power moves
  // (Fury Cutter, Rollout, Ice Ball). Cleared on switch-out or faint.
  consecutiveMoves: Record<string, { moveId: string; count: number }>;
  // Keyed by pokemonId.toString(). Tracks Pokémon locked into a move for multiple turns
  // (Rollout, Thrash, Outrage, Petal Dance, etc.). Cleared on switch-out or faint.
  lockedMoves: Record<string, { moveId: string; turnsRemaining: number }>;
  expAwarded: boolean;
  encounterId: mongoose.Types.ObjectId | null;
  lastUpdatedAt: Date;
  endedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BattleSchema = new Schema<IBattle>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    type:       { type: String, enum: ['pve', 'wild', 'pvp'], required: true },
    status:     { type: String, enum: ['waiting', 'active', 'complete'], default: 'waiting' },
    phase:      {
      type:    String,
      enum:    ['move_submission', 'targeting', 'end_of_round'],
      default: 'move_submission',
    },

    playerSide: [
      {
        userId:               { type: Schema.Types.ObjectId, ref: 'User', required: true },
        activePokemonId:      { type: Schema.Types.ObjectId, ref: 'Pokemon', default: null },
        activeSentOutOnTurn:  { type: Number, default: null },
        usedPokemonIds:       [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
        fainted:              [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
        _id:                  false,
      },
    ],

    enemySide: [
      {
        npcId:               { type: Schema.Types.ObjectId, ref: 'Npc', default: null },
        activePokemonId:     { type: Schema.Types.ObjectId, ref: 'Pokemon', default: null },
        activeSentOutOnTurn: { type: Number, default: null },
        fainted:             [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
        _id:                 false,
      },
    ],

    turnNumber: { type: Number, default: 0 },

    turnQueue: [
      {
        actorId:         { type: Schema.Types.ObjectId, required: true },
        actorType:       { type: String, enum: ['player', 'npc'], required: true },
        activePokemonId: { type: Schema.Types.ObjectId, ref: 'Pokemon', required: true },
        actionType:        { type: String, enum: ['move', 'item', 'switch', 'catch', 'run'], default: 'move' },
        moveId:            { type: String, default: '' },
        itemId:            { type: String, default: null },
        switchToPokemonId: { type: Schema.Types.ObjectId, ref: 'Pokemon', default: null },
        targets:           [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
        resolved:        { type: Boolean, default: false },
        flinched:        { type: Boolean, default: false },
        _id:             false,
      },
    ],

    currentTargetIndex: { type: Number, default: 0 },

    weather: {
      type:    String,
      enum:    ['rain', 'sun', 'sandstorm', 'hail', 'snow', null],
      default: null,
    },

    weatherTurnsRemaining: { type: Number, default: null },

    fieldConditions: [
      {
        condition:      { type: String, required: true },
        turnsRemaining: { type: Number, required: true },
        _id:            false,
      },
    ],

    turnLog: [
      {
        turn:   { type: Number, required: true },
        events: [{ type: String }],
        _id:    false,
      },
    ],

    catchAttempts: [
      {
        playerId:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
        pokemonId: { type: Schema.Types.ObjectId, ref: 'Pokemon', required: true },
        result:    { type: String, required: true },
        _id:       false,
      },
    ],

    statStages:         { type: Schema.Types.Mixed, default: {} },
    consecutiveMoves:   { type: Schema.Types.Mixed, default: {} },
    lockedMoves:        { type: Schema.Types.Mixed, default: {} },
    playerPokemonLimit: { type: Number, default: null },
    npcPokemonLimit:    { type: Number, default: null },
    wildCatchable:      { type: Boolean, default: true },
    expAwarded:         { type: Boolean, default: false },
    encounterId:        { type: Schema.Types.ObjectId, ref: 'Encounter', default: null },
    lastUpdatedAt:      { type: Date, default: Date.now },
    endedAt:            { type: Date, default: null },
  },
  { timestamps: true }
);

export const Battle = mongoose.model<IBattle>('Battle', BattleSchema);
