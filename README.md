# ScaleCart

Distributed order-processing platform: a modular monolith that evolves into microservices.
See `project-plan.md` for the roadmap and `docs/` for design decisions.

- `backend/` Node + Express + TypeScript + Prisma + PostgreSQL
- `frontend/` Angular 21 (standalone, signals) + Bootstrap
- `backend/src/kv/` **ScaleKV**, our own Redis-like key-value store (Node, speaks the real Redis protocol). No Redis install needed.

## Run locally

1. **Database:** PostgreSQL with a database for ScaleCart (or `docker compose up -d` for one on port 5432).
2. **Backend** (port 3000)
   ```
   cd backend
   cp .env.example .env        # then set DATABASE_URL
   npm install
   npx prisma migrate deploy   # create the tables
   npm run seed                # admin account + 14 sample products
   npm run dev
   ```
3. **ScaleKV** (port 6380, optional: caching + rate limiting + fast idempotency). In a second terminal:
   ```
   cd backend
   npm run kv                  # the store itself
   npm run kv:cli              # optional: our redis-cli, e.g. KEYS *, GET product:<id>, INFO
   ```
   Without it the API still works (logs "running without cache"); it connects automatically when ScaleKV starts.
4. **Frontend** (port 4300)
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
- **M4 (degrade):** stop ScaleKV (Ctrl+C) while browsing: the shop keeps working (`X-Cache: BYPASS`), *System status* says *Down*. Start it again and the API reconnects by itself.

## Tests
```
cd backend  && npm test     # API + concurrency tests (use the database from .env, clean up after themselves)
cd frontend && npm test     # unit tests
```
