import mongoose, { Schema } from 'mongoose';

type IUser = {
  username: string;
  email: string;
  passwordHash: string;
  role: 'player' | 'dm' | 'admin';
  trainerStats: Map<string, number>;
  trainerStatChoice: string | null;
  badges: string[];
  money: number;
};

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['player', 'dm', 'admin'], default: 'player' },
    trainerStats: { type: Map, of: Number, default: {} },
    trainerStatChoice: { type: String, default: null },
    badges: { type: [String], default: [] },
    money: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>('User', UserSchema);
