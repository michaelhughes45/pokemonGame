import mongoose, { Schema } from 'mongoose';

export type INpc = {
  campaignId:     mongoose.Types.ObjectId;
  createdByDm:    mongoose.Types.ObjectId;
  name:           string;
  type:           'trainer' | 'wild';
  party:          mongoose.Types.ObjectId[];
  aiStrategy:     'random' | 'optimal' | 'defensive' | 'custom';
  customAiNotes:  string | null;
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
    aiStrategy:     { type: String, enum: ['random', 'optimal', 'defensive', 'custom'], default: 'random' },
    customAiNotes:  { type: String, default: null },
    trainerClass:   { type: String, default: null },
    dialogueBefore: { type: String, default: null },
    dialogueAfter:  { type: String, default: null },
  },
  { timestamps: true }
);

export const Npc = mongoose.model<INpc>('Npc', NpcSchema);
