import { z } from "zod";
import { prisma } from "../../config/prisma.js";
import { conflict, notFound } from "../../utils/errors.js";
import { uuid } from "../../utils/validation.js";

const MAX_QTY_PER_ITEM = 99;
const quantity = z.number().int().min(1).max(MAX_QTY_PER_ITEM);

export const addItemSchema = z.object({ productId: uuid, quantity: quantity.default(1) });
export const updateItemSchema = z.object({ quantity });

const itemInclude = {
  product: { include: { inventory: { select: { available: true } } } },
} as const;

// Each user has exactly one cart; it is created the first time it is needed.
// upsert + the UNIQUE(user_id) constraint makes this safe if two requests arrive together.
const getOrCreateCart = (userId: string) =>
  prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });

async function view(userId: string) {
  const cart = await getOrCreateCart(userId);
  const rows = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    include: itemInclude,
    orderBy: { id: "asc" },
  });
  const items = rows.map((r) => {
    const stock = r.product.inventory?.available ?? 0;
    return {
      id: r.id,
      productId: r.productId,
      name: r.product.name,
      sku: r.product.sku,
      category: r.product.category,
      priceCents: r.product.priceCents,
      quantity: r.quantity,
      lineTotalCents: r.product.priceCents * r.quantity,
      stock,
      // Lets the UI warn before checkout. Checkout re-checks under a lock; this is only a hint.
      purchasable: r.product.active && stock >= r.quantity,
    };
  });
  return {
    id: cart.id,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    totalCents: items.reduce((n, i) => n + i.lineTotalCents, 0),
  };
}

export const cartService = {
  get: view,

  async addItem(userId: string, productId: string, qty: number) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { inventory: { select: { available: true } } },
    });
    if (!product || !product.active) throw notFound("product_not_found");

    const cart = await getOrCreateCart(userId);
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
    });
    const wanted = (existing?.quantity ?? 0) + qty;
    const stock = product.inventory?.available ?? 0;
    if (wanted > stock) throw conflict("insufficient_stock", `Only ${stock} in stock`);
    if (wanted > MAX_QTY_PER_ITEM) throw conflict("quantity_limit", `Max ${MAX_QTY_PER_ITEM} per item`);

    await prisma.cartItem.upsert({
      where: { cartId_productId: { cartId: cart.id, productId } },
      create: { cartId: cart.id, productId, quantity: qty },
      update: { quantity: { increment: qty } },
    });
    return view(userId);
  },

  async updateItem(userId: string, itemId: string, qty: number) {
    const cart = await getOrCreateCart(userId);
    // Scoping by cartId means a user can never touch someone else's item (404, not 403: no info leak).
    const item = await prisma.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
      include: itemInclude,
    });
    if (!item) throw notFound("cart_item_not_found");
    const stock = item.product.inventory?.available ?? 0;
    if (qty > stock) throw conflict("insufficient_stock", `Only ${stock} in stock`);
    await prisma.cartItem.update({ where: { id: itemId }, data: { quantity: qty } });
    return view(userId);
  },

  async removeItem(userId: string, itemId: string) {
    const cart = await getOrCreateCart(userId);
    const { count } = await prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
    if (count === 0) throw notFound("cart_item_not_found");
    return view(userId);
  },
};
