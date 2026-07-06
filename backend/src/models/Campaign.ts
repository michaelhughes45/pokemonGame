import mongoose, { Schema } from 'mongoose';

type ICampaign = {
  name: string;
  dmId: mongoose.Types.ObjectId;
  playerIds: mongoose.Types.ObjectId[];
  pendingInvites: Array<{ userId: mongoose.Types.ObjectId; sentAt: Date }>;
  isActive: boolean;
  levelCapEnabled: boolean;
};

const CampaignSchema = new Schema<ICampaign>(
  {
    name:      { type: String, required: true, trim: true },
    dmId:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    playerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    pendingInvites: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        sentAt: { type: Date, default: Date.now },
      },
    ],
    isActive:        { type: Boolean, default: true },
    levelCapEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);
