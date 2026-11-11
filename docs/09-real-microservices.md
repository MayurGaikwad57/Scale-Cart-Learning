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
| 2 | **One app per service** — `apps/<name>` with own `package.json`, env schema, scripts; owned modules move in; event handlers split per app; lint rule "no app imports another app" | ✅ see "Phase 2 — what changed" below |
| 3 | **Database per service** — 4 databases + 4 DB users, own Prisma schema + migrations per app, no cross-DB foreign keys, own `processed_events`, `/internal/stock-alerts`, one-time data migration script (old DB kept as a backup) | ✅ see "Phase 3 — what changed" below |
| 4 | **Identity service** — users/auth out of order, own DB, RS256 + JWKS, gateway routes `/auth` → identity | ✅ see "Phase 4 — what changed" below |
| 5 | **Catalog service** — products out of order, own DB, `ProductCreated/Updated` + `StockChanged` events, stock copy, cart/checkout call catalog, gateway routes `/products` → catalog | ✅ see "Phase 5 — what changed" below |
| 6 | **Deploy per service** — Dockerfile per app, `docker-compose.yml`, GitHub Actions per app | ✅ see "Phase 6 — what changed" below (CI runs once the branch is pushed) |

## Phase 2 — what changed

- `apps/gateway`, `apps/order`, `apps/payment`, `apps/inventory`, `apps/notification`, `apps/scalekv`, `apps/scalelog`:
  each has its own `package.json`, `tsconfig.json`, `.env` / `.env.example` (only the settings it needs) and scripts
  (`npm run dev -w @scalecart/payment`, `build`, `start`, `worker`). `backend/` is gone.
- **Boundary check** (`npm run check:boundaries`, `tools/check-boundaries.ts`): an app importing another app, or
  reaching outside its folder, fails the build.
- **Crossings removed:**
  - inventory imported the order service's product-cache code -> inventory now publishes **`StockChanged`**
    (topic `inventory`, key = productId) and the order service's new **`product_cache`** consumer group refreshes
    its own cache. Product pages now catch up a few milliseconds later: *eventual consistency* (tests wait for it).
  - checkout imported `PAYMENT_METHODS` from the payment code -> it is part of the order/payment **contract**
    (`@scalecart/events`).
  - one shared `handlers.ts` + `once()` + one global consumer-group table -> each app has its own handlers and
    `once()`; the **consumer-group directory** (who consumes what, for the admin pages) is part of the contracts.
- **Connection budget:** every service now has its own pool (`DATABASE_POOL_MAX`, default 10). Postgres allows ~100
  connections in total, so replicas x pool size summed over all services must stay below that. The system tests run
  every service in one process, so they use small pools and at most 3 test files at once.
- `tests/system`: the whole-system tests, the only package allowed to import several apps.
- Still shared in phase 2 (removed in phase 3): the database, through a temporary `packages/legacy-db`.

## Phase 3 — what changed

- **4 databases, 4 database users** (`npm run db:create-service-dbs`, `tools/create-service-dbs.ts`):
  `scalecart_order` / `order_svc`, `scalecart_inventory` / `inventory_svc`, `scalecart_payment` / `payment_svc`,
  `scalecart_notification` / `notification_svc`. Each user owns its database; `CONNECT` is revoked from everyone
  else, so `payment_svc` gets *permission denied for database "scalecart_order"* (a system test proves it).
  The services no longer connect as the `postgres` superuser.
- **Each app owns its schema**: `apps/<name>/prisma/schema.prisma`, its own migrations (`0_init`), its own generated
  client (`src/generated`), its own connection string with a service-specific name (`ORDER_DATABASE_URL`, ...).
  The only foreign keys left are *inside* one service (e.g. reservation_items -> reservations).
- **Joins became copies, kept up to date by events:**
  - product pages and the cart showed stock by joining `inventory` -> the order service keeps its own
    `products.stock_available` (+ `stock_version`), updated by **StockChanged v2** (now carries `available` and the
    row `version`; an older event is ignored: *versioned update*). The checkout still asks the inventory service.
  - a new product + its stock row were ONE transaction -> the order service publishes **ProductCreated**
    (topic `products`); the inventory service's new **product_sync** group creates the stock row and keeps its own
    `product_info` (sku, name) - also updated by **ProductUpdated**.
  - stock alerts were joined with product names -> the inventory service answers `GET /internal/stock-alerts`
    with its own copy of the names; the order service's admin page asks it (and still works without it).
  - `processed_events`: one table per consumer, in that consumer's database.
- **Data migration** (`npm run db:migrate-legacy-data`): copied every row from the old shared database to its owner
  (row counts compared). The old database `scale_cart` was **not** changed and stays as a backup.
- `packages/legacy-db` deleted. New system tests: `tests/system/src/m65-service-databases.test.ts`.

## Phase 4 — what changed

- **`apps/identity`** (:3005, database `scalecart_identity`, user `identity_svc`): register, login, `/auth/me`, and
  `GET /.well-known/jwks.json`. The users table moved out of the order database (`npm run db:move-users-to-identity`,
  then the order migration `1_users_moved_to_identity` drops `users` and the two foreign keys to it).
- **RS256 + JWKS instead of one shared HS256 secret.** Before, every service had `JWT_SECRET` - so every service could
  also *forge* an admin token. Now only identity has the **private** key (`npm run keys -w @scalecart/identity`);
  the kit's `authenticate` downloads the **public** keys once, caches them, and verifies locally (no call to identity
  per request; if identity is down, logged-in users keep working). An unknown `kid` triggers one refetch - the basis
  of **key rotation**. `algorithms: ["RS256"]` blocks the **algorithm-confusion** attack (tested).
- `JWT_SECRET` is gone from every service. The gateway routes `/auth` to identity; the frontend did not change.
- Tests: users in the identity DB, tokens signed like a real login; new tests for a foreign key, a tampered payload,
  a missing `kid` and the algorithm-confusion attack.
- Not done (next steps in a real system): refresh tokens with rotation, HttpOnly-cookie sessions (the frontend keeps
  the token in localStorage), logout / token revocation, an off-the-shelf IdP (Keycloak, Auth0, Cognito).

## Phase 5 — what changed

- **`apps/catalog`** (:3006, database `scalecart_catalog`, user `catalog_svc`): `/products` (search, filter, admin CRUD),
  the product cache in ScaleKV, `/admin/system` (cache + ScaleKV status), and `POST /internal/products/batch`.
  It publishes `ProductCreated` / `ProductUpdated` and runs the `product_stock` group (its copy of the stock).
- Products moved out of the order database (`npm run db:move-products-to-catalog`, then the order migration
  `2_products_moved_to_catalog`, written by hand because it must **backfill** before it drops).
- The order service now **asks** the catalog:
  - the **cart** gets names / prices / stock in ONE batch call (no N+1). Catalog down -> the cart still loads with
    the lines marked unavailable (`degraded: "catalog_unavailable"`), checkout answers 503 and keeps the cart;
  - **checkout** fetches the prices BEFORE its transaction (never hold database locks across a network call),
    re-checks under the lock that the cart didn't change, and stores a **snapshot** (name, sku, category, price)
    on every order line - a past order never changes when a product is renamed or re-priced, and showing an
    order no longer needs the catalog.
- New tests: snapshot survives a rename, checkout uses the current catalog price, catalog-down behaviour.

## Phase 6 — what changed

- **A Dockerfile per app** (`apps/<name>/Dockerfile`, built from the repo root): stage `build` (npm ci on the
  manifests first for layer caching, then `npm run build -w <app>`), stage `prod-deps` (`npm prune --omit=dev
  --omit=optional` - Prisma CLI and TypeScript are *optional peers* of `@prisma/client` and survive `--omit=dev`
  alone; found by simulating the build), stage 3: `node:20.19-alpine` + `tini`, non-root `USER node`, `HEALTHCHECK`,
  only `dist/` + production `node_modules`. No secrets at build time; all configuration via environment variables.
- **`docker-compose.yml`**: Postgres with `infra/postgres/init-service-dbs.sh` (one database + one user per service,
  `CONNECT` revoked from PUBLIC), ScaleKV, ScaleLog with a volume, a one-shot **migration job per service** (the
  `build` target still has the Prisma CLI; services wait for `service_completed_successfully`), the 6 services with
  their own credentials and service discovery by container name, and the gateway as the only published port.
  `TRUST_PROXY=uniquelocal` lets services read the client IP forwarded by the gateway's container.
- **`.github/workflows/ci.yml`**: `checks` (boundaries, type-check, every test against a Postgres service container),
  `changes` (`dorny/paths-filter`: which apps changed), `images` (a matrix job per changed app, Buildx with GitHub
  Actions cache, not pushed). The system tests set their pool size in `vitest.config.ts`, so CI stays under
  PostgreSQL's 100 connections without a hand-written `.env`.
- **Verified locally (no Docker on this machine):** the Dockerfile's build steps in an empty folder from the git files
  only (`npm ci` -> build -> prune -> `node dist/main.js` with environment variables only, against its database);
  a clean-checkout CI build (install, boundaries, Prisma generate, type-check); Dockerfile keywords / COPY sources /
  stage names; compose and workflow YAML. **Not verified yet:** an actual `docker build` / `docker compose up` and
  the first CI run - both happen on GitHub once the branch is pushed.

## Known gaps (on purpose)

- **Dual write** (save to DB, then publish) can lose an event if the process dies in between — M7's **outbox**
  fixes it, per service.
- Follow-ups from the PR #6 code review - DONE in M6.6 (see "M6.6 — justified refactoring" below).
- Fixed from the review: a lost `ProductCreated` is re-published by the catalog's **announcer** (`announced_at`);
  inventory publishes `StockChanged` in the background (never delaying a reservation's answer); the JWKS cache
  REPLACES its key set on each fetch (retired keys stop being trusted) and waits for an in-flight fetch (no
  spurious 401s during rotation); identity trusts its own key locally; `db:deploy` runs the data moves BEFORE the
  order migrations that drop tables; the move scripts skip and report email/sku clashes instead of aborting; an
  idempotent retry replays even while the catalog is down; the boundary check also catches `import "x"` / `require()`.
- Our own ScaleKV / ScaleLog instead of Redis / Kafka, everything on one machine (no Docker locally — CI builds
  the images). The **architecture** is real-world; the **infrastructure** is local.

## M6.6 — justified refactoring (only changes backed by evidence)

The rule: measure or point at a concrete defect first; change only what that evidence justifies.

| Change | Evidence | Principle |
|---|---|---|
| Malformed JSON -> **400**, oversized body -> **413** (were 500) | reproduced live; now tested (mutation-checked) | correctness |
| `once()`, the worker process, the DB handle -> **service-kit** | byte-identical in 2 / 5 / 6 apps | DRY - one fix, one place |
| `orders.service.ts` (323 lines, 6 jobs) -> `checkout.saga.ts` (orchestration), `orders.service.ts` (state changes), `order.mapping.ts` (API + events), `orders.validation.ts`, `clients/inventory.client.ts` | six responsibilities in one file | Single responsibility; prepares M7's outbox |
| Rate-limit **rules** out of the kit; each service declares + reports its own, the gateway aggregates | the shared library contained the order service's business policy | Dependency inversion - change a limit without releasing the kit |
| Admin Events page renders the group directory from the API | its own copy of the list missed 2 new groups | Open/closed |
| **One** parameterised `Dockerfile`; each image installs **only its app's** production dependencies | 9 near-copies (one already broke CI); gateway shipped Prisma/pg/bcrypt | DRY; measured: gateway `node_modules` 15 MB instead of 88 MB |

**Measured and deliberately NOT changed - inventory reservation (one UPDATE per product under row locks):**

| products | median | p95 |
|---|---|---|
| 1 | 9.6 ms | 15.7 ms |
| 10 | 15.9 ms | 20.7 ms |
| 100 (max) | 88.1 ms | 101.4 ms |

~0.8 ms per product; most of the time is the fixed HTTP + transaction cost. A bulk `UPDATE` would save 1-7 ms on
normal carts - not worth hand-written SQL in the most delicate code path.

**Fixed from the PR #7 code review** (a refactor must not change behaviour - the first one did): the single
Dockerfile had lost ScaleKV/ScaleLog's `0.0.0.0` listen address and ScaleLog's data volume (now in the image;
ScaleLog builds with `--target stateful`); `ARG APP` moved below `npm ci` (one cached install instead of nine) and
an npm cache mount; the CI start check now runs every image until it prints "listening" (dummy settings); rate-limit
rule names are namespaced `<service>.<rule>` and a clash fails at startup; the 400/413 answers carry a readable
`message`; `prismaDb` moved to `service-kit/db.ts` (seed scripts no longer load the HTTP chassis).

**Considered and rejected (no evidence of a problem):** a DI framework (plain parameters already inject what
matters), repository interfaces over Prisma (tests run against real databases), splitting the events contract
file, optimising `restoreCart` (a rare compensation path), moving the service registry out of the kit (listing
the services IS its job, like DNS).
