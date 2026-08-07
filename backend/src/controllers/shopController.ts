import { Request, Response } from 'express';
import { User } from '../models/User';
import { Campaign } from '../models/Campaign';
import { Item } from '../models/Item';
import { getBuyPrice, getSellPrice } from '../lib/shopData';
import { getPocket } from '../lib/itemData';

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ data: null, error: message });
}

function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

// ---------------------------------------------------------------------------
// POST /api/shop/buy
// Player buys an item from their own campaign's Pokémart.
// Body: { itemId, quantity? }
// ---------------------------------------------------------------------------
export async function buyItem(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { itemId, quantity = 1 } = req.body as { itemId?: string; quantity?: number };

  if (!itemId?.trim()) {
    return sendError(res, 400, 'itemId is required');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return sendError(res, 400, 'quantity must be an integer between 1 and 99');
  }
  const trimmedId = itemId.trim();

  const user = await User.findById(userId);
  if (!user?.currentCampaignId) {
    return sendError(res, 400, 'You are not in a campaign');
  }

  const campaign = await Campaign.findById(user.currentCampaignId);
  if (!campaign?.shopItemIds.includes(trimmedId)) {
    return sendError(res, 400, 'That item is not for sale in your Pokémart');
  }

  const buyPrice = getBuyPrice(trimmedId);
  if (buyPrice === null) {
    return sendError(res, 400, 'That item is not for sale');
  }
  const cost = buyPrice * quantity;

  // Atomic guard against a race between the balance check and the deduction —
  // only succeeds if the player still has enough money at write time.
  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, money: { $gte: cost } },
    { $inc: { money: -cost } },
    { new: true },
  );
  if (!updatedUser) {
    return sendError(res, 400, `Not enough money — costs ₽${cost}`);
  }

  const item = await Item.findOneAndUpdate(
    { ownerId: userId, itemId: trimmedId },
    { $inc: { quantity }, $setOnInsert: { pocket: getPocket(trimmedId) } },
    { upsert: true, new: true },
  );

  sendOk(res, {
    itemId:         item.itemId,
    quantity:       item.quantity,
    cost,
    moneyRemaining: updatedUser.money,
  }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/shop/sell
// Player sells an item from their own bag for money. Sellable regardless of
// whether the DM currently stocks it in the Pokémart — any item with a known
// price can be sold, same as a real Poké Mart.
// Body: { itemId, quantity? }
// ---------------------------------------------------------------------------
export async function sellItem(req: Request, res: Response): Promise<void> {
  const { userId } = req.user!;
  const { itemId, quantity = 1 } = req.body as { itemId?: string; quantity?: number };

  if (!itemId?.trim()) {
    return sendError(res, 400, 'itemId is required');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return sendError(res, 400, 'quantity must be an integer between 1 and 99');
  }
  const trimmedId = itemId.trim();

  const sellPrice = getSellPrice(trimmedId);
  if (sellPrice === null) {
    return sendError(res, 400, 'That item cannot be sold');
  }

  const item = await Item.findOne({ ownerId: userId, itemId: trimmedId });
  if (!item || item.quantity < quantity) {
    return sendError(res, 400, 'You do not have enough of that item');
  }

  if (item.quantity === quantity) {
    await Item.deleteOne({ _id: item._id });
  } else {
    item.quantity -= quantity;
    await item.save();
  }

  const proceeds = sellPrice * quantity;
  const updatedUser = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { money: proceeds } },
    { new: true },
  );

  sendOk(res, {
    itemId:         trimmedId,
    quantitySold:   quantity,
    proceeds,
    moneyRemaining: updatedUser!.money,
  });
}
