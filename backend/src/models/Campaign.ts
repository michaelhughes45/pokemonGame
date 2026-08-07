import mongoose, { Schema } from 'mongoose';

type CustomBadge = {
  badgeId: string;
  name: string;
  imageUrl: string;
  createdAt: Date;
};

type ICampaign = {
  name: string;
  dmId: mongoose.Types.ObjectId;
  playerIds: mongoose.Types.ObjectId[];
  pendingInvites: Array<{ userId: mongoose.Types.ObjectId; sentAt: Date }>;
  isActive: boolean;
  levelCapEnabled: boolean;
  fieldModeEnabled: boolean;
  customBadges: CustomBadge[];
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
    // false = Town mode (default, /pc + /town accessible); true = Field mode (blocked)
    fieldModeEnabled: { type: Boolean, default: false },
    // DM-defined badges for homebrew gyms, beyond the hardcoded catalog in
    // lib/badgeData.ts. badgeId is generated on creation (not user-chosen) so
    // it can never collide with a catalog badgeId or another custom one.
    customBadges: [
      {
        badgeId:   { type: String, required: true },
        name:      { type: String, required: true },
        imageUrl:  { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        _id:       false,
      },
    ],
  },
  { timestamps: true }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);
