# 04 — API design (Phase 1)

Base URL: `http://localhost:3000`. JSON in, JSON out. Money is integer cents (paise).
Errors always look like `{ "error": "<code>", "message": "<human text>" }`; validation errors add `details: [{ path, message }]`.

| Method + path | Auth | Purpose |
|---|---|---|
| POST `/auth/register` | public | Create a CUSTOMER account, returns `{ user, token }` |
| POST `/auth/login` | public | Returns `{ user, token }` (JWT, 1h) |
| GET `/auth/me` | token | Who does this token belong to (session restore) |
| GET `/products` | public | Query: `page, pageSize(<=50), q, category, minPrice, maxPrice (cents), sort=newest\|price_asc\|price_desc\|name`. Admin may add `includeInactive=true` |
| GET `/products/categories` | public | Distinct active categories (for the filter) |
| GET `/products/:id` | public | One product (inactive ones only for admin) |
| POST `/products` | admin | Create (+ optional initial `stock`) |
| PUT `/products/:id` | admin | Partial update |
| DELETE `/products/:id` | admin | Soft delete (`active=false`) |
| GET `/inventory/:productId` | public | `{ available, reserved }` |
| POST `/inventory` | admin | Set absolute `available` stock |
| GET `/cart` | token | Cart with lines, `itemCount`, `totalCents` |
| POST `/cart/items` | token | `{ productId, quantity }`, merges with an existing line |
| PUT `/cart/items/:id` | token | `{ quantity }` |
| DELETE `/cart/items/:id` | token | Remove a line |
| POST `/orders` | token | Checkout. `{ paymentMethod: TEST_CARD_SUCCESS \| TEST_CARD_DECLINE }` |
| GET `/orders` | token | Own history, newest first, paginated |
| GET `/orders/:id` | token | Own order (someone else's is 404) |

Status codes used: 200/201/204 success; 400 invalid input or empty cart; 401 missing/invalid token or bad credentials; 403 wrong role; 404 not found (also used for "not yours" so existence is not leaked); 409 conflict (duplicate email/SKU, insufficient stock, inactive product); 500 unexpected (details only in server logs).

## Decision: soft delete for products
- **Problem:** `order_items` reference products by foreign key; hard delete would break history or be refused.
- **Options:** hard delete + cascade; hard delete refused when referenced; soft delete.
- **Decision:** `DELETE` sets `active=false`.
- **Trade-off:** deleted rows stay forever; every public query must filter `active`.

## Decision: checkout transaction (see 02-architecture D4)
Order of operations inside ONE transaction: lock the user's cart row → read cart → lock stock rows `ORDER BY product_id FOR UPDATE` → verify availability → reserve (`available→reserved`) → create order with price snapshot → simulated payment → success: reservation becomes a sale, cart emptied; decline: reservation released, order CANCELLED, cart kept.
- Locking the cart row first serialises a double-click: the second request finds an empty cart (400) instead of creating a second order.
- Retries that cross a network failure are NOT covered yet; that is the Phase 2 idempotency key (`orders.idempotency_key` already exists).

## Failure scenarios covered by tests
Last item with two buyers; 10 buyers for 3 items; carts sharing products in opposite order (no deadlock); double-click checkout; one short line rolls back the whole order; declined payment restores stock exactly; ownership checks on cart items and orders.
