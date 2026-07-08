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
  trainerStats: Map<string, number>;
  trainerStatChoice: string | null;
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
    trainerStatChoice: { type: String, default: null },
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
