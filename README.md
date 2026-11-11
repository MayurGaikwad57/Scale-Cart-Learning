# ScaleCart

Distributed order-processing platform: a modular monolith that evolves into microservices.
Since **M6** it runs as an **API gateway + 4 services** (order, payment, inventory, notification) — see `docs/08-microservices.md`.
See `project-plan.md` for the roadmap and `docs/` for design decisions.

- `backend/` Node + Express + TypeScript + Prisma + PostgreSQL
- `frontend/` Angular 21 (standalone, signals) + Bootstrap
- `backend/src/kv/` **ScaleKV**, our own Redis-like key-value store (Node, speaks the real Redis protocol). No Redis install needed.
- `backend/src/log/` **ScaleLog**, our own Kafka-like event log (topics, partitions, consumer groups, offsets, DLQ). No Kafka install needed.
- `backend/src/services/` the **microservices** (M6): `gateway` :3000, `order` :3001, `payment` :3002, `inventory` :3003, `notification` :3004.
- `packages/service-kit` the **microservice chassis** every service shares (M6.5): Express skeleton, health checks, request ids, errors, auth, service calls, ScaleKV/ScaleLog clients, consumer runtime.
- `packages/events` the **event contracts** between services (topics, event types, event ids).

The repo is an **npm workspaces monorepo** (root `package.json`): one `npm install` at the root links the shared
packages into every app. M6.5 is turning every service into its own app with its own database — see
`docs/09-real-microservices.md`.

## Run locally

1. **Database:** PostgreSQL with a database for ScaleCart (or `docker compose up -d` for one on port 5432).
2. **Backend** (API gateway on port 3000)
   ```
   npm install                 # ONCE, at the repo root: installs every workspace (backend + packages)
   cd backend
   cp .env.example .env        # then set DATABASE_URL
   npx prisma migrate deploy   # create the tables
   npm run seed                # admin account + 14 sample products
   npm run dev                 # starts EVERYTHING: ScaleKV, ScaleLog, the 4 services and the gateway
   ```
   `npm run dev` prefixes every log line with the process name. To play with failures, run the pieces in separate
   terminals instead: `npm run kv`, `npm run log`, `npm run svc:order`, `npm run svc:payment`, `npm run svc:inventory`,
   `npm run svc:notification`, `npm run svc:gateway` — then stop and start one of them. (Steps 3–4 describe ScaleKV and
   ScaleLog; `npm run dev` already starts them.)
3. **ScaleKV** (port 6380, optional: caching + rate limiting + fast idempotency). In a second terminal:
   ```
   cd backend
   npm run kv                  # the store itself
   npm run kv:cli              # optional: our redis-cli, e.g. KEYS *, GET product:<id>, INFO
   ```
   Without it the API still works (logs "running without cache"); it connects automatically when ScaleKV starts.
4. **ScaleLog** (port 9093, optional: events → notifications, low-stock alerts, sales report). In another terminal:
   ```
   cd backend
   npm run log                 # the broker; data is kept in backend/data/scalelog (git-ignored)
   npm run log:cli -- DESCRIBE # optional: look inside (topics, groups, lag)
   npm run worker              # optional: an extra consumer process -> watch the groups rebalance
   ```
   Since M6 payment is asynchronous, so the broker matters: without it orders wait in *Pending* and the order
   service's reconciler completes them once it is back. Each service runs its own consumer groups (`RUN_WORKERS=false` turns that off).
5. **Frontend** (port 4300)
   ```
   cd frontend
   npm install
   npm start                   # http://localhost:4300
   ```

Demo admin (from the seed): `admin@scalecart.com` / `Admin@12345`. Register any other account in the UI to get a customer.

## Things to try
- Add products to the cart, check out with the **success** test card, then with the **decline** test card (stock is released, the order shows CANCELLED).
- "Limited Edition Smartwatch" has stock **1**: log in as two different customers in two browsers (one normal, one private), put it in both carts, press *Place order* at the same moment. Exactly one wins.
- Log in as admin: *Admin* menu to add/edit/deactivate products and set stock.
- **M4 (cache):** open DevTools → Network, open a product twice. The `X-Cache` response header goes `MISS` → `HIT`. Admin → *System status* shows the hit rate live.
- **M4 (rate limit):** log in with a wrong password 11 times in a minute → "Too many requests. Please try again in N seconds."
- **M5 (events):** place an order and watch the **bell** in the navbar: the "notification" consumer adds a message a few seconds later. Admin → *Events* shows the topic's partitions, every consumer group's members, committed offsets and lag.
- **M5 (retry → DLQ → replay):** Admin → *Events*: switch on *Chaos* for "notification", place an order (it is retried 3×, then parked in the dead-letter queue while "analytics" still counts it), switch chaos off and press *Replay*.
- **M5 (rebalancing):** run `npm run worker` in another terminal: the groups split the 3 partitions between the API and the worker. Stop it and the API takes them back (immediately on Ctrl+C, after ~10 s if you kill it hard).
- **M6 (async payment):** place an order: the page says *processing your payment…* and turns into *confirmed* by itself about a second later. Admin → *Services* shows the 4 services, their routes, consumer groups, traffic through the gateway, and recent payments.
- **M6 (a service down):** run the services in separate terminals. Stop `npm run svc:payment` and place orders: they stay *Pending* while the shop keeps working; start it again and they are charged. Stop `svc:inventory`: checkout says "try again", nothing is charged, the cart is kept. Stop `svc:notification`: only the bell fails.
- **M4 (degrade):** stop ScaleKV (Ctrl+C) while browsing: the shop keeps working (`X-Cache: BYPASS`), *System status* says *Down*. Start it again and the API reconnects by itself.

## Tests
```
cd backend  && npm test     # API, concurrency and microservice tests: all services start in-process on random ports
                            # behind the gateway, with a real broker (use the database from .env, clean up after themselves)
cd frontend && npm test     # unit tests
```
