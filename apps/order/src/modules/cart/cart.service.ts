import { z } from "zod";
import { prisma } from "../../config/prisma.js";
import { conflict, notFound } from "@scalecart/service-kit/errors";
import { uuid } from "@scalecart/service-kit/validation";
import { getProducts, type CatalogProduct } from "../../catalog.js";

const MAX_QTY_PER_ITEM = 99;
const quantity = z.number().int().min(1).max(MAX_QTY_PER_ITEM);

export const addItemSchema = z.object({ productId: uuid, quantity: quantity.default(1) });
export const updateItemSchema = z.object({ quantity });

// Each user has exactly one cart; it is created the first time it is needed.
// upsert + the UNIQUE(user_id) constraint makes this safe if two requests arrive together.
const getOrCreateCart = (userId: string) =>
  prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });

/**
 * The cart holds only product ids and quantities. Names, prices and stock come from the CATALOG
 * service (one batch call). If it is down, the cart still loads - lines are shown as unavailable
 * instead of failing the whole page (GRACEFUL DEGRADATION); checkout will refuse until it is back.
 */
async function view(userId: string) {
  const cart = await getOrCreateCart(userId);
  const rows = await prisma.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { id: "asc" } });
  let products = new Map<string, CatalogProduct>();
  let catalogDown = false;
  try {
    products = await getProducts(rows.map((r) => r.productId));
  } catch {
    catalogDown = true;
  }
  const items = rows.map((r) => {
    const p = products.get(r.productId);
    const stock = p?.stock ?? 0; // the catalog's copy of the inventory number
    return {
      id: r.id,
      productId: r.productId,
      name: p?.name ?? (catalogDown ? "(details unavailable right now)" : "(no longer available)"),
      sku: p?.sku ?? "",
      category: p?.category ?? "",
      priceCents: p?.priceCents ?? 0,
      quantity: r.quantity,
      lineTotalCents: (p?.priceCents ?? 0) * r.quantity,
      stock,
      // Lets the UI warn before checkout. Checkout re-checks; this is only a hint.
      purchasable: !!p && p.active && stock >= r.quantity,
    };
  });
  return {
    id: cart.id,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    totalCents: items.reduce((n, i) => n + i.lineTotalCents, 0),
    ...(catalogDown ? { degraded: "catalog_unavailable" } : {}),
  };
}

export const cartService = {
  get: view,

  async addItem(userId: string, productId: string, qty: number) {
    const product = (await getProducts([productId])).get(productId); // ask the catalog
    if (!product || !product.active) throw notFound("product_not_found");

    const cart = await getOrCreateCart(userId);
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_productId: { cartId: cart.id, productId } },
    });
    const wanted = (existing?.quantity ?? 0) + qty;
    const stock = product.stock;
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
    const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
    if (!item) throw notFound("cart_item_not_found");
    const stock = (await getProducts([item.productId])).get(item.productId)?.stock ?? 0;
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
