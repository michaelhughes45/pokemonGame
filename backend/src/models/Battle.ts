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
  npcId?: mongoose.Types.ObjectId;  // absent for wild and pvp battles
  userId?: mongoose.Types.ObjectId;  // present only for pvp battles (opposing trainer)
  activePokemonId: mongoose.Types.ObjectId | null;
  activeSentOutOnTurn: number | null;
  // Tracks distinct Pokémon sent out, same semantics as PlayerSideEntry.
  // Only populated for pvp battles (npc/wild entries don't enforce a Pokémon limit this way).
  usedPokemonIds: mongoose.Types.ObjectId[];
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

// Future Sight / Doom Desire (milestone 5.14 Wave 9) — damage is calculated from the
// ATTACKER's stats as they were at the moment of casting (a snapshot), since the real
// games let the attacker switch out or even faint before the hit lands and it still
// uses the original stats. targetSlotIndex identifies WHICH side-entry was targeted
// (not a specific Pokémon ID) — if that slot's occupant has since switched, the hit
// still lands on whoever is there now, matching the real games; if the slot is empty
// or its occupant has already fainted, it fizzles silently.
export type PendingAttack = {
  moveId: string;
  targetSide: 'playerSide' | 'enemySide';
  targetSlotIndex: number;
  turnsRemaining: number;
  attackerName: string;
  attackerSpeciesId: number;
  attackerLevel: number;
  attackerNature: string;
  attackerEvs: Record<string, number>;
  attackerIvs: Record<string, number>;
  attackerAbilitySlug: string | null;
  attackerHeldItem: string | null;
};

// Mimic (milestone 5.14 Wave 13) — unlike Sketch's permanent overwrite, Mimic's move-
// slot swap is temporary: it reverts the moment the user switches out or faints. This
// snapshots exactly what needs restoring — the ORIGINAL Mimic slot's data — keyed by
// slotIndex since the copied move's PP is decremented independently while it's active
// and can no longer be matched back to "the Mimic slot" by moveId alone.
export type MimicState = {
  slotIndex: number;
  originalMoveId: string;
  originalCurrentPP: number;
  originalMaxPP: number;
  originalPpUps: number;
};

// Healing Wish / Lunar Dance (milestone 5.14 Wave 10) — the user faints immediately
// on use, and whichever Pokémon is sent into that same slot NEXT (no delay, unlike
// PendingAttack) is fully healed. restorePP distinguishes Lunar Dance (also restores
// every move's PP) from Healing Wish (HP + status only).
export type PendingWish = {
  targetSide: 'playerSide' | 'enemySide';
  targetSlotIndex: number;
  restorePP: boolean;
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
  // pve only — Pokédollars paid to every playerSide trainer (not split) on victory.
  // Set by the DM at creation, or copied from Encounter.moneyReward at launch. Always
  // 0 for wild/pvp battles (wild has no trainer to pay it out, pvp deliberately excluded).
  moneyReward: number;
  // Snapshotted from Campaign.hiddenAbilitiesEnabled at battle creation. Toggling the
  // campaign setting mid-battle doesn't retroactively change an in-progress fight —
  // only battles launched after the toggle pick up the new value.
  hiddenAbilitiesEnabled: boolean;
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
  // Keyed by pokemonId.toString(). The most recent damaging hit each Pokémon has taken
  // THIS round, for Counter/Mirror Coat/Metal Burst — overwritten (not accumulated) on
  // every hit, cleared entirely at the end of every round in applyEndOfRound.
  damageTakenThisTurn: Record<string, { amount: number; category: string; attackerId: string }>;
  // Keyed by pokemonId.toString(). The most recent move each Pokémon actually executed
  // this battle, for Sketch (reads the TARGET's entry). Recorded under the resolved
  // moveId, not a wrapper name — e.g. a Metronome/Copycat use is recorded under whatever
  // it rolled/copied into. Never cleared on switch-out; a stale read is a harmless edge case.
  lastMoveByPokemon: Record<string, string>;
  // The most recent move ANY Pokémon executed this battle, for Copycat. Same
  // resolved-moveId convention as lastMoveByPokemon.
  globalLastMoveUsed: string | null;
  // Keyed by pokemonId.toString(). Set on entry when the Pokémon's real ability is Trace
  // and a valid opposing ability was copied — the effective ability slug for every
  // ability-slug lookup afterward. Cleared on switch-out or faint, same as statStages.
  tracedAbility: Record<string, string>;
  // Keyed by pokemonId.toString(). Set by Soak/Conversion/Camouflage/Reflect Type/
  // Conversion 2 (milestone 5.14 Wave 11) — this Pokémon's real type array is
  // overridden with this value everywhere types matter (damage effectiveness, STAB,
  // @smogon/calc's own internal type calc, frontend type badges). Cleared on
  // switch-out or faint, same as statStages/tracedAbility.
  typeOverride: Record<string, string[]>;
  // Keyed by pokemonId.toString(). The TYPE of the most recent damaging hit this
  // Pokémon has taken, for Conversion 2 — unlike damageTakenThisTurn this persists
  // across rounds (only cleared on switch-out or faint), since Conversion 2 needs to
  // react to "the last move that hit me" regardless of which round that was.
  lastHitMoveType: Record<string, string>;
  // Keyed by pokemonId.toString(). Present only while a Mimic-copied move is currently
  // occupying the user's Mimic slot — see MimicState above. Reverted (and the entry
  // removed) on switch-out or faint, same lifetime as typeOverride/tracedAbility.
  mimicState: Record<string, MimicState>;
  // Future Sight / Doom Desire (milestone 5.14 Wave 9) — see the PendingAttack type
  // above for the full explanation. Resolved (and removed) in applyEndOfRound once
  // turnsRemaining hits 0.
  pendingAttacks: PendingAttack[];
  // Healing Wish / Lunar Dance (milestone 5.14 Wave 10) — see PendingWish above.
  // Consumed (and removed) the moment a Pokémon is sent into the matching slot.
  pendingWishes: PendingWish[];
  expAwarded: boolean;
  moneyAwarded: boolean;
  // Set once the battle completes. For pve/wild this always mirrors "did the players win"
  // (playerSide) vs lose (enemySide). For pvp it tells you which trainer roster is left
  // standing — the frontend uses it to render a personalized win/loss banner per viewer,
  // since the turn log itself is shared and can't say "you win" from one side's perspective.
  winningSide: 'playerSide' | 'enemySide' | null;
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
        userId:              { type: Schema.Types.ObjectId, ref: 'User', default: null },
        activePokemonId:     { type: Schema.Types.ObjectId, ref: 'Pokemon', default: null },
        activeSentOutOnTurn: { type: Number, default: null },
        usedPokemonIds:      [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
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
    damageTakenThisTurn: { type: Schema.Types.Mixed, default: {} },
    lastMoveByPokemon:   { type: Schema.Types.Mixed, default: {} },
    globalLastMoveUsed:  { type: String, default: null },
    tracedAbility:       { type: Schema.Types.Mixed, default: {} },
    typeOverride:        { type: Schema.Types.Mixed, default: {} },
    lastHitMoveType:     { type: Schema.Types.Mixed, default: {} },
    mimicState:          { type: Schema.Types.Mixed, default: {} },
    pendingAttacks: [
      {
        moveId:              { type: String, required: true },
        targetSide:          { type: String, enum: ['playerSide', 'enemySide'], required: true },
        targetSlotIndex:     { type: Number, required: true },
        turnsRemaining:      { type: Number, required: true },
        attackerName:        { type: String, required: true },
        attackerSpeciesId:   { type: Number, required: true },
        attackerLevel:       { type: Number, required: true },
        attackerNature:      { type: String, required: true },
        attackerEvs:         { type: Schema.Types.Mixed, required: true },
        attackerIvs:         { type: Schema.Types.Mixed, required: true },
        attackerAbilitySlug: { type: String, default: null },
        attackerHeldItem:    { type: String, default: null },
        _id:                 false,
      },
    ],
    pendingWishes: [
      {
        targetSide:      { type: String, enum: ['playerSide', 'enemySide'], required: true },
        targetSlotIndex: { type: Number, required: true },
        restorePP:       { type: Boolean, default: false },
        _id:              false,
      },
    ],
    playerPokemonLimit: { type: Number, default: null },
    npcPokemonLimit:    { type: Number, default: null },
    wildCatchable:      { type: Boolean, default: true },
    moneyReward:        { type: Number, default: 0 },
    hiddenAbilitiesEnabled: { type: Boolean, default: true },
    expAwarded:         { type: Boolean, default: false },
    moneyAwarded:       { type: Boolean, default: false },
    winningSide:        { type: String, enum: ['playerSide', 'enemySide', null], default: null },
    encounterId:        { type: Schema.Types.ObjectId, ref: 'Encounter', default: null },
    lastUpdatedAt:      { type: Date, default: Date.now },
    endedAt:            { type: Date, default: null },
  },
  { timestamps: true }
);

export const Battle = mongoose.model<IBattle>('Battle', BattleSchema);
