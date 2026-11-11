# M6.5 — Real microservices

M6 split ScaleCart into a gateway + 4 services, but they still shared **one `package.json`, one database and
each other's code**. That is a *distributed monolith*, not microservices. M6.5 fixes that, step by step
(strangler fig: the system keeps working after every phase).

## The 3 rules

1. **A service never touches another service's database.** Each service has its own database and its own
   DB user that can only log in to that database — Postgres itself enforces the boundary.
2. **A service never imports another service's code.** Apps share only two small packages:
   `@scalecart/service-kit` (the chassis) and `@scalecart/events` (the event contracts). A lint rule fails
   the build if an app imports another app.
3. **Need another service's data? Ask its API, or keep a copy that its events keep up to date.**

## The end result: 7 services, 7 databases

| Service | Port | Its own database holds | Job |
|---|---|---|---|
| gateway | 3000 | — | the only door: routing, token check, rate limit |
| identity | 3005 | `users` | register / login, signs JWTs with **RS256**, publishes its public key (**JWKS**) |
| catalog | 3006 | `products` + a copy of stock | product list / search / admin CRUD, product cache |
| order | 3001 | `cart`, `cart_items`, `orders`, `order_items`, `sales_daily` | cart, checkout saga, analytics |
| inventory | 3003 | `inventory`, `reservations`, `reservation_items`, `stock_alerts` + a copy of product name/SKU | stock, reservations |
| payment | 3002 | `payments` | payments |
| notification | 3004 | `notifications` | the customer's bell |

Every consumer keeps its **own** `processed_events` table (idempotency stays inside the service).

## Data that crosses services today — and the real-world fix

| Today | After the split |
|---|---|
| Product list shows stock (joins `inventory`) | catalog keeps a **copy** of `available`, updated by `StockChanged` events (CQRS read model, may lag by milliseconds) |
| Creating a product creates its inventory row in the same transaction | catalog publishes `ProductCreated` (with initial stock) → inventory creates its row |
| Cart shows product name/price (joins `products`) | order calls catalog: `GET /internal/products?ids=…` |
| Checkout takes the price from `products` | order asks catalog for the **current** price at checkout and snapshots it into `order_items` |
| `stock_alerts` joins product name/SKU | inventory keeps its own copy via `ProductCreated` / `ProductUpdated` |
| Admin events page reads `stock_alerts` | inventory exposes `GET /internal/stock-alerts` |
| Inventory imports the product-cache code | `StockChanged` event → catalog clears its own cache |
| Foreign keys across services | plain ids; consistency comes from the saga and events |
| One `processed_events` table | one per service |
| HS256 JWT: every service knows the signing secret | RS256: only identity has the private key; others verify with the public key from `/.well-known/jwks.json` |

## Layout (npm workspaces — built into npm, nothing extra to install)

```
SalesCart/
├── package.json              workspaces
├── apps/                     one folder per DEPLOYABLE service (own package.json, .env, prisma/, Dockerfile)
│   ├── gateway/  identity/  catalog/  order/  inventory/  payment/  notification/
│   └── scalekv/  scalelog/   our Redis and Kafka
├── packages/
│   ├── service-kit/          the chassis (shared code, no business logic)
│   └── events/               the event contracts
├── frontend/
├── docker-compose.yml        postgres + every app
└── .github/workflows/        one CI pipeline per app (path filters: only changed apps build)
```

Shared packages are consumed as TypeScript source in development (`--conditions=development`, so no rebuild
while coding) and as compiled JavaScript in production (`tsc -b` builds them first, `dist/`).

## Phases (each = one branch → PR → code review → merge)

| # | Phase | Done when |
|---|---|---|
| 1 | **Workspaces + shared packages** — root workspaces, `packages/service-kit`, `packages/events`; the chassis no longer knows Prisma or any service's consumer groups (they are passed in). No behaviour change. | ✅ all tests pass, `npm run dev` and compiled `npm start` work |
| 2 | **One app per service** — `apps/<name>` with own `package.json`, env schema, scripts; owned modules move in; event handlers split per app; lint rule "no app imports another app" | each app builds and starts alone |
| 3 | **Database per service** — 4 databases + 4 DB users, own Prisma schema + migrations per app, no cross-DB foreign keys, own `processed_events`, `/internal/stock-alerts`, one-time data migration script (old DB kept as a backup) | each service can only reach its own DB; browser checkout works |
| 4 | **Identity service** — users/auth out of order, own DB, RS256 + JWKS, gateway routes `/auth` → identity | login/register work; only identity holds the signing key |
| 5 | **Catalog service** — products out of order, own DB, `ProductCreated/Updated` + `StockChanged` events, stock copy, cart/checkout call catalog, gateway routes `/products` → catalog | catalog, cart, checkout, admin product CRUD work end to end |
| 6 | **Deploy per service** — Dockerfile per app, `docker-compose.yml`, GitHub Actions per app | CI green for every app |

## Known gaps (on purpose)

- **Dual write** (save to DB, then publish) can lose an event if the process dies in between — M7's **outbox**
  fixes it, per service.
- Our own ScaleKV / ScaleLog instead of Redis / Kafka, everything on one machine (no Docker locally — CI builds
  the images). The **architecture** is real-world; the **infrastructure** is local.
