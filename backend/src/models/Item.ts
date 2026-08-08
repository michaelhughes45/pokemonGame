import mongoose, { Schema } from 'mongoose';

export type ItemPocket =
  | 'healing'
  | 'status_cure'
  | 'pp_recovery'
  | 'stat_booster'
  | 'held_type'
  | 'pokeballs'
  | 'escape'
  | 'berry'
  | 'tm_hm'
  | 'mint';

type IItem = {
  ownerId:   mongoose.Types.ObjectId;
  ownerType: 'player' | 'npc';
  itemId:    string;       // PokeAPI slug, e.g. "super-potion"
  quantity:  number;
  pocket:    ItemPocket;
};

const ItemSchema = new Schema<IItem>(
  {
    ownerId:   { type: Schema.Types.ObjectId, required: true },
    ownerType: { type: String, enum: ['player', 'npc'], default: 'player' },
    itemId:    { type: String, required: true },
    quantity:  { type: Number, required: true, min: 1 },
    pocket:    {
      type: String,
      enum: ['healing', 'status_cure', 'pp_recovery', 'stat_booster', 'held_type', 'pokeballs', 'escape', 'berry', 'tm_hm', 'mint'],
      required: true,
    },
  },
  { timestamps: true }
);

// One stack per (player, item) — no duplicates
ItemSchema.index({ ownerId: 1, itemId: 1 }, { unique: true });

export const Item = mongoose.model<IItem>('Item', ItemSchema);
