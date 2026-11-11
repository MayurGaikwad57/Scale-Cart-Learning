# ScaleCart

Distributed order-processing platform: a modular monolith that evolves into microservices.
Since **M6** it runs as an **API gateway + 4 services** (order, payment, inventory, notification) — see `docs/08-microservices.md`;
since **M6.5** every service is its own app (`apps/`) — see `docs/09-real-microservices.md`.
See `project-plan.md` for the roadmap and `docs/` for design decisions.

- `apps/` **one folder per deployable service**, each with its own `package.json`, `.env`, and `npm run dev`:
  `gateway` :3000, `identity` :3005, `catalog` :3006, `order` :3001, `payment` :3002, `inventory` :3003, `notification` :3004,
  plus `scalekv` :6380 (**ScaleKV**, our own Redis) and `scalelog` :9093 (**ScaleLog**, our own Kafka). No Redis/Kafka install needed.
- `packages/service-kit` the **microservice chassis** every service shares: Express skeleton, health checks, request ids,
  errors, auth, service calls, ScaleKV/ScaleLog clients, consumer runtime.
- `packages/events` the **event contracts** between services: topics, event types, who consumes what.
- `tests/system` the **system tests**: the whole system in one test process (the only place allowed to import several apps).
- `frontend/` Angular 21 (standalone, signals) + Bootstrap

It is an **npm workspaces monorepo**. The two rules that make the services real microservices:
**an app never imports another app** (`npm run check:boundaries` enforces it), and **every service has its own
database** (`scalecart_identity`, `scalecart_catalog`, `scalecart_order`, `scalecart_inventory`, `scalecart_payment`,
`scalecart_notification`), reachable only with that service's own database user. Services talk only over HTTP and
events. Sign-in: the **identity** service is the only one holding the signing key (RS256); every other service verifies
tokens with its public key from `/.well-known/jwks.json`.
M6.5 progress and design: `docs/09-real-microservices.md`.

## Run locally

1. **Database:** a PostgreSQL server (any version 15+). Each service gets its own database on it (step 2).
   With Docker you can instead run the WHOLE backend as containers: see "Containers" below.
2. **Backend** (everything from the repo root)
   ```
   npm install                 # ONCE, at the repo root: installs and links every workspace
   # each service has its own settings: copy apps/<name>/.env.example to apps/<name>/.env
   # (gateway, identity, catalog, order, payment, inventory, notification), and .env.example to .env (ADMIN_DATABASE_URL)
   npm run db:create-service-dbs   # one database + one DB user per service; writes each URL into that app's .env
   npm run keys -w @scalecart/identity   # the token signing key (only the identity service gets it)
   npm run db:deploy           # create each service's tables in its own database
   npm run db:generate         # each service's Prisma client
   npm run dev                 # starts EVERYTHING: ScaleKV, ScaleLog, the 6 services and the gateway
   npm run seed                # (in a 2nd terminal, while dev runs) admin account (identity) + 14 products (catalog)
   ```
   `npm run dev` prefixes every log line with the process name and starts every app in its own folder (so it reads
   its own `.env`, like a container). To play with failures, run the pieces in separate terminals instead:
   `npm run kv`, `npm run log`, `npm run dev -w @scalecart/order`, `npm run dev -w @scalecart/payment`, ... and stop / start one.
   Production-like: `npm run build` then `npm run start:all` runs every app's compiled JavaScript.
3. **ScaleKV** (port 6380, optional: caching + rate limiting + fast idempotency):
   `npm run kv` (the store), `npm run kv:cli` (our redis-cli, e.g. `KEYS *`, `GET product:<id>`, `INFO`).
   Without it the services still work (they log "running without cache") and connect automatically when it starts.
4. **ScaleLog** (port 9093, optional: events): `npm run log` (data kept in `apps/scalelog/data`, git-ignored),
   `npm run log:cli -- DESCRIBE` (topics, groups, lag), `npm run worker -w @scalecart/notification` (an extra consumer
   -> watch the group rebalance). Payment is asynchronous, so without the broker orders wait in *Pending* and the order
   service's reconciler completes them once it is back.
5. **Frontend** (port 4300)
   ```
   cd frontend
   npm install
   npm start                   # http://localhost:4300
   ```

Demo admin (from the seed): `admin@scalecart.com` / `Admin@12345`. Register any other account in the UI to get a customer.

## Containers (Docker) and CI

Every app has its own **`apps/<name>/Dockerfile`** (multi-stage: build -> production dependencies only -> a small
non-root image with `tini` as PID 1 and a health check). Build one from the repo root:
`docker build -f apps/payment/Dockerfile -t scalecart/payment .`

**`docker-compose.yml`** runs the whole backend as containers: Postgres (an init script creates one database + one
user per service), ScaleKV, ScaleLog (with a volume), one-shot **migration jobs**, the 6 services (each with ONLY its
own database credentials, finding the others by container name) and the gateway on port 3000. See the comments at the
top of the file for the commands.

**`.github/workflows/ci.yml`** on every push: boundary check, type-check and all tests against a real PostgreSQL
(databases and users created exactly like locally), then builds the image of **only the apps that changed**
(one parallel job per app; a change in `packages/` rebuilds all of them).

## Things to try
- Add products to the cart, check out with the **success** test card, then with the **decline** test card (stock is released, the order shows CANCELLED).
- "Limited Edition Smartwatch" has stock **1**: log in as two different customers in two browsers (one normal, one private), put it in both carts, press *Place order* at the same moment. Exactly one wins.
- Log in as admin: *Admin* menu to add/edit/deactivate products and set stock.
- **M4 (cache):** open DevTools → Network, open a product twice. The `X-Cache` response header goes `MISS` → `HIT`. Admin → *System status* shows the hit rate live.
- **M4 (rate limit):** log in with a wrong password 11 times in a minute → "Too many requests. Please try again in N seconds."
- **M5 (events):** place an order and watch the **bell** in the navbar: the "notification" consumer adds a message a few seconds later. Admin → *Events* shows the topic's partitions, every consumer group's members, committed offsets and lag.
- **M5 (retry → DLQ → replay):** Admin → *Events*: switch on *Chaos* for "notification", place an order (it is retried 3×, then parked in the dead-letter queue while "analytics" still counts it), switch chaos off and press *Replay*.
- **M5 (rebalancing):** run `npm run worker -w @scalecart/notification` in another terminal: the group splits the 3 partitions between the service and the worker. Stop it and the API takes them back (immediately on Ctrl+C, after ~10 s if you kill it hard).
- **M6 (async payment):** place an order: the page says *processing your payment…* and turns into *confirmed* by itself about a second later. Admin → *Services* shows the 4 services, their routes, consumer groups, traffic through the gateway, and recent payments.
- **M6 (a service down):** run the services in separate terminals. Stop the payment service (`npm run dev -w @scalecart/payment` in its own terminal) and place orders: they stay *Pending* while the shop keeps working; start it again and they are charged. Stop inventory: checkout says "try again", nothing is charged, the cart is kept. Stop notification: only the bell fails.
- **M4 (degrade):** stop ScaleKV (Ctrl+C) while browsing: the shop keeps working (`X-Cache: BYPASS`), *System status* says *Down*. Start it again and the API reconnects by itself.

## Tests
```
npm test                    # ScaleKV + ScaleLog unit tests and the SYSTEM tests (tests/system): all services start
                            # in-process on random ports behind the gateway, with a real broker (database from
                            # tests/system/.env; they clean up after themselves)
npm run check:boundaries    # fails if any app imports another app
cd frontend && npm test     # unit tests
```
