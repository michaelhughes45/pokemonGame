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
  hiddenAbilitiesEnabled: boolean;
  customBadges: CustomBadge[];
  shopItemIds: string[];
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
    // Master switch for hidden abilities campaign-wide. Snapshotted onto each Battle at
    // creation (Battle.hiddenAbilitiesEnabled) — toggling mid-battle doesn't retroactively
    // change an in-progress fight, only battles launched afterward.
    hiddenAbilitiesEnabled: { type: Boolean, default: true },
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
    // Which SHOP_PRICES (lib/shopData.ts) itemIds the DM has put up for sale
    // in this campaign's Pokémart. Empty until the DM curates it — nothing is
    // for sale by default.
    shopItemIds: [{ type: String }],
  },
  { timestamps: true }
);

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);
