import mongoose, { Schema } from 'mongoose';

// Milestone 6.5 — redefined from 'random'|'optimal'|'defensive'|'custom'. 'optimal'
// is renamed 'highest-damage' (same scoring); 'defensive''s low-HP-heal behavior
// folds into the new 'smartest' tier (6.7, not yet built — aliased to
// 'highest-damage' scoring until then); 'custom' (backed by the unused
// customAiNotes free-text field, zero actual logic) is dropped outright.
export type AiStrategy = 'worst' | 'random' | 'highest-damage' | 'smartest';

export type INpc = {
  campaignId:     mongoose.Types.ObjectId;
  createdByDm:    mongoose.Types.ObjectId;
  name:           string;
  type:           'trainer' | 'wild';
  party:          mongoose.Types.ObjectId[];
  aiStrategy:     AiStrategy;
  trainerClass:   string | null;
  dialogueBefore: string | null;
  dialogueAfter:  string | null;
};

const NpcSchema = new Schema<INpc>(
  {
    campaignId:     { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    createdByDm:    { type: Schema.Types.ObjectId, ref: 'User',     required: true },
    name:           { type: String, required: true, trim: true },
    type:           { type: String, enum: ['trainer', 'wild'], default: 'trainer' },
    party:          [{ type: Schema.Types.ObjectId, ref: 'Pokemon' }],
    aiStrategy:     { type: String, enum: ['worst', 'random', 'highest-damage', 'smartest'], default: 'random' },
    trainerClass:   { type: String, default: null },
    dialogueBefore: { type: String, default: null },
    dialogueAfter:  { type: String, default: null },
  },
  { timestamps: true }
);

export const Npc = mongoose.model<INpc>('Npc', NpcSchema);
