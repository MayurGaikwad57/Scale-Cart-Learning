# 03 — Database design

Source of truth: `backend/prisma/schema.prisma`. Migrations: `backend/prisma/migrations/`.

## Tables
| Table | Purpose | Notes |
|---|---|---|
| users | accounts | `email` unique, `role` enum |
| products | catalog | `sku` unique, `price_cents` int |
| inventory | stock, 1:1 with product | `available`, `reserved`, `version` |
| cart | one per user | `user_id` unique |
| cart_items | lines in a cart | unique `(cart_id, product_id)` |
| orders | placed orders | `status` enum, `idempotency_key` (used in Phase 2) |
| order_items | lines in an order | `unit_price_cents` is a price snapshot |
| payments | payment attempts | `status` enum |

`outbox_events` is added later (Outbox phase).

## Constraints (and why)
- Primary keys are UUIDs: not guessable, safe to move across services or shards later.
- Foreign keys: no orphan rows (an order item always points to a real order and product).
- `inventory.available >= 0`, `reserved >= 0`: even a buggy service can never oversell.
- `cart_items.quantity > 0`, `order_items.quantity > 0`, `products.price_cents >= 0`: invalid data is rejected by the database itself.
- `UNIQUE (cart_id, product_id)`: one row per product per cart.
- `UNIQUE (user_id, idempotency_key)`: a retried order request cannot create a duplicate (Phase 2).
- The CHECK constraints are hand-written SQL at the end of the init migration because Prisma's schema language cannot express them.

## Indexes (each has a reason)
| Index | Serves |
|---|---|
| `products (category, price_cents)` | catalog filter by category, sort/range by price |
| `orders (user_id, created_at DESC)` | "my latest orders" |
| `order_items (order_id)` | load the items of an order |
| `payments (order_id)` | load payments of an order |
| unique indexes (email, sku, cart user, cart+product) | enforce uniqueness and make those lookups fast |

A full-text search (GIN) index on products is deferred until search is built.

## Transactions and isolation
- Checkout runs in one `$transaction` at `READ COMMITTED` (Postgres default).
- Stock rows are locked with `SELECT ... FOR UPDATE`, ordered by product id.
- MVCC: Postgres keeps row versions so plain reads do not block writers; the explicit lock is what serialises competing buyers.
