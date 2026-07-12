import mongoose, { Schema } from 'mongoose';

type BadgeEntry = {
  badgeId: string;
  name: string;
  imageUrl: string;
  awardedAt: Date;
};

type IUser = {
  username: string;
  email: string;
  passwordHash: string;
  role: 'player' | 'dm' | 'admin';
  // Trainer IV points the player has allocated per stat (milestone 5.5).
  // Total earned pool is derived from badges.length * 5 (see lib/trainerIv.ts)
  // — never stored — this map only records what's already been spent.
  trainerStats: Map<string, number>;
  badges: BadgeEntry[];
  money: number;
  currentCampaignId: mongoose.Types.ObjectId | null;
};

const UserSchema = new Schema<IUser>(
  {
    username:          { type: String, required: true, unique: true, trim: true },
    email:             { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash:      { type: String, required: true },
    role:              { type: String, enum: ['player', 'dm', 'admin'], default: 'player' },
    trainerStats:      { type: Map, of: Number, default: {} },
    badges: [
      {
        badgeId:   { type: String, required: true },
        name:      { type: String, required: true },
        imageUrl:  { type: String, required: true },
        awardedAt: { type: Date, required: true },
        _id:       false,
      },
    ],
    money:             { type: Number, default: 0 },
    currentCampaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', UserSchema);
