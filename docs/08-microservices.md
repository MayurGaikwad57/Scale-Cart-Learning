# 08 — M6 Microservices: API gateway + payment, inventory and notification services

> **M6.5 update:** the code moved. `backend/src/services/<name>` is now `apps/<name>/src`, shared code is in
> `packages/service-kit`, event contracts in `packages/events`; run everything with `npm run dev` from the repo root.
> See `docs/09-real-microservices.md`.

**Goal (project-plan §11–12):** extract services from the modular monolith *gradually* — no rewrite — and put an
API gateway in front. **Constraint:** nothing can be installed (no Docker, no Kubernetes, no nginx). **Decision:** every
service is a separate Node process with its own port, started from the same repo; the gateway is our own reverse
proxy. The browser and the Angular app did not change their address: still `http://localhost:3000`.

```
                    Angular :4300
                         │  (one address, unchanged)
                         ▼
               ┌───────────────────┐   routing · edge auth · global rate limit · X-Request-Id · CORS
               │ API Gateway :3000 │   /internal/* never forwarded · dead service = 502, slow = 504
               └─────────┬─────────┘
     ┌───────────────────┼──────────────────────┬─────────────────────────┐
     ▼                   ▼                      ▼                         ▼
 Order svc :3001     Inventory svc :3003    Payment svc :3002      Notification svc :3004
 auth, products,     stock + reservations   payments table         notifications (the bell)
 cart, orders,       ▲ sync HTTP (reserve)  (no public API but     
 admin, analytics    │ from order svc       /admin/payments)       
     │  ▲            │                         ▲   │                       ▲
     │  └── payments topic ◄───────────────────┼───┘ PaymentSucceeded/Failed
     └────► orders topic ──────────────────────┴──► OrderCreated, OrderConfirmed, OrderCancelled ──┘
                  (ScaleLog :9093)            also read by inventory (commit/release) and analytics
```

Run it: `cd backend; npm run dev` starts **ScaleKV, ScaleLog, the 4 services and the gateway** in one terminal with
coloured prefixes (`src/scripts/dev-all.ts`). To experiment with failures, run them in separate terminals instead:
`npm run kv`, `npm run log`, `npm run svc:order`, `svc:payment`, `svc:inventory`, `svc:notification`, `svc:gateway`.

## 1. What moved where (`backend/src/services/`)

| Service | Port | Owns (writes) | HTTP | Consumer groups |
|---|---|---|---|---|
| **gateway** | 3000 | nothing (only ScaleKV rate-limit counters) | everything, forwarded | – |
| **order** | 3001 | users, products, cart, orders | `/auth /products /cart /orders /admin/system /admin/events` | `order` (payments topic), `analytics` |
| **payment** | 3002 | payments | `/admin/payments` | `payment` (orders topic) |
| **inventory** | 3003 | inventory, reservations | `/inventory`, `/internal/reservations` | `inventory` (orders topic) |
| **notification** | 3004 | notifications | `/notifications` | `notification` (orders topic) |

| File | What it is |
|---|---|
| `services/registry.ts` | Which services exist and where (service discovery, the simple way). |
| `services/shared/service-app.ts` | The "chassis": every service gets the same health checks, request ids, JSON errors, graceful shutdown. |
| `services/shared/http-client.ts` | Service-to-service HTTP with a **timeout** and the 3 outcomes (known / not delivered / unknown). |
| `services/shared/internal-auth.ts` | Shared-secret check for `/internal/*` (service identity). |
| `services/shared/request-context.ts` | `X-Request-Id` via AsyncLocalStorage, carried into HTTP calls and event headers. |
| `services/gateway/proxy.ts` | The reverse proxy (~80 lines): streaming, `X-Forwarded-*`, hop-by-hop headers, 502/504. |
| `services/gateway/app.ts` | Route table, edge auth, rate limit, `/health/ready` and `/admin/services` aggregation. |
| `services/inventory/reservations.ts` | The reservation state machine (reserve / commit / release, tombstones). |
| `services/payment/payment.handler.ts` | `OrderCreated` → charge once → `PaymentSucceeded/Failed`. |
| `services/order/payment-results.handler.ts` | Payment result → order `CONFIRMED/CANCELLED` → `OrderConfirmed/Cancelled`. |
| `services/order/reconciler.ts` | Sweeper that heals orders stuck in `PENDING` (lost events). |
| `events/workers.ts` | Every consumer group, its topic and the service that runs it. |
| `test-cluster.ts` | Starts the *whole* system in a test: every service on a random port + gateway + real broker. |

This is the **strangler fig** pattern: the order service *is* the old monolith minus what was cut out. Catalog and
users would be the next extractions in a bigger system.

## 2. The new checkout (a sequence of local steps, not one transaction)

In M2–M5 checkout was **one database transaction** (lock cart → lock stock → reserve → order → pay → confirm). It
cannot be any more: stock now belongs to another service, payment to a third. So:

| # | Where | What | If it fails |
|---|---|---|---|
| 1 | order svc, **local tx** | lock cart, idempotency check, create order `PENDING` (price snapshot), **cart → order** | nothing happened (rolled back) |
| 2 | order → inventory, **sync HTTP, 3 s timeout** | reserve every line or nothing (same `FOR UPDATE ORDER BY product_id` locking as before) | **409** out of stock → undo step 1 (order deleted, cart back), answer 409 |
| | | | **not running** → undo step 1, answer 503 (we *know* nothing was reserved) |
| | | | **timeout / 5xx** → *unknown*: cancel the order (cart back, idempotency key freed), send `release` (tombstone) **and** publish `OrderCancelled`, answer 503 |
| 3 | order svc | publish `OrderCreated` v2 (`PENDING`, carries the payment method), answer **201 PENDING** | lost → the **reconciler** re-publishes it |
| 4 | payment svc (event) | charge **once** per order → `PaymentSucceeded` / `PaymentFailed` | service down → events wait in the log |
| 5 | order svc (event) | `PENDING → CONFIRMED` or `→ CANCELLED` (+ cart restored) → `OrderConfirmed` / `OrderCancelled` | publish fails → handler throws, event retried |
| 6 | inventory svc (event) | `OrderConfirmed` → reservation **sold**; `OrderCancelled` → **released** | idempotent state machine |
| 6 | notification svc (event) | the bell: "Order confirmed" / "Payment declined" / "Order cancelled" | idempotent (`once()`) |
| 6 | analytics (order svc) | daily sales projection | idempotent (`once()`) |

**Why reserve synchronously but pay asynchronously?** The customer must hear "out of stock" *now* (and it's the
contended, fast, internal step). Payment is the slow, external, flaky step: in the monolith a slow provider kept the
checkout transaction — and its row locks — open. Now checkout answers in ~150 ms and the browser polls the order
page until it is `CONFIRMED`/`CANCELLED` (the UI shows "processing your payment…").

Each step is atomic on its own; failures are repaired by explicit **compensations** (undo the order, restore the cart,
release the stock). That is the idea of a **saga** — M7 formalises it.

## 3. Distributed-systems ideas, as built

- **The third outcome.** A local function call returns or throws. A network call can also *time out*: the work may or
  may not have happened, and may *still be happening*. `http-client.ts` reports `unreachable` (safe: not delivered)
  vs `timeout`/`server_error` (unknown) so the caller picks the right compensation.
- **Tombstone.** After a reserve timed out, the order service releases. If the slow reserve arrives *after* the
  release, it would reserve stock for a dead order (leak). `release()` of an unknown order writes a `RELEASED` row;
  a later `reserve()` for it gets `409 reservation_released`. Test: *"TIMEOUT (outcome unknown) … refused (tombstone)"*.
- **Claim first, no check-then-act.** `reserve()` and `release()` both start with
  `INSERT … ON CONFLICT DO NOTHING RETURNING`. Two racing calls for the same order serialise on the primary key —
  the database decides who is first. Test: three simultaneous reserves → `[201, 200, 200]`, stock taken once.
- **Idempotency everywhere** (at-least-once delivery means every message can arrive twice):
  reservation state machine; payment `UNIQUE(order_id)` + provider idempotency key = orderId; conditional status
  update (`WHERE status = 'PENDING'`); notification/analytics `once()`.
- **Deterministic event ids.** `eventId = hash(type, orderId)` shaped as a UUID. Re-publishing "order X confirmed"
  produces the *same* id, so consumers recognise it as a duplicate instead of notifying twice.
- **"Must" publish inside consumers.** "Update row, then publish" is a dual write. Inside a consumer we publish in
  `must` mode: if it fails the handler throws, the offset isn't committed, the event is redelivered, the (already
  done, idempotent) update is a no-op and the publish is retried.
- **Reconciler.** Checkout's `OrderCreated` is published best-effort after commit. If it's lost, the order would stay
  `PENDING` forever with stock held. Every 10 s the order service takes orders `PENDING` > 20 s and re-reserves
  (idempotent) + re-publishes, with exponential backoff per order (20 s, 40 s … 5 min). It heals a lost
  `PaymentSucceeded` too: the payment service finds its saved payment and re-announces it.
- **Schema evolution.** `OrderCreated` v1 (M5: final status) and v2 (M6: `PENDING` + paymentMethod) are both in the
  log. Every consumer handles both (`outcomeOf()` in `events/handlers.ts`); a DLQ replay can bring v1 events back.
- **Source of truth.** Only the order service changes an order's status. Payment *reports a fact*; inventory and
  notification *react to the order's fate*. The order service keeps its **own copy** of the payment outcome
  (`orders.payment_status`) instead of reading the payment service's table.
- **Correlation id.** `X-Request-Id` from the gateway travels into every HTTP call and into event headers, so one
  click can be followed across gateway → order → inventory → (log) → payment → order → notification.
- **Gateway responsibilities and limits.** Routing, edge auth (reject a bad token before it costs a service anything),
  global rate limit, CORS, correlation, 502/504 instead of hanging, health aggregation. **No business logic.**
  Services still verify the JWT themselves (zero trust).
- **`req.ip` behind a proxy.** Services now see the *gateway* as the client. They trust `X-Forwarded-For` from
  loopback (`trust proxy = loopback`), otherwise everyone would share one per-IP login rate limit. The gateway trusts
  no forwarded header by default (a client could fake its IP).
- **Service identity.** `/internal/*` is never forwarded by the gateway *and* requires `X-Internal-Token`
  (constant-time compare). Production would use mTLS or signed service tokens.

## 4. Honest trade-offs / known gaps (know them for interviews)

| What we did | What a real system does | Why / when it matters |
|---|---|---|
| All services share **one PostgreSQL database**, with table ownership by convention | **Database per service** | Shared DB = hidden coupling (schema changes, shared load). The order service's product pages still JOIN `inventory` to show stock — a *read* across a boundary. Fix: inventory publishes `StockChanged` and the catalog keeps its own copy, or API composition. |
| Best-effort publish + reconciler | **Transactional outbox** (M7) | A crash between commit and publish is healed after ~20 s instead of being impossible. |
| Payment succeeds for an already-cancelled order → logged as "refund needed" | **Saga with a `RefundPayment` compensation** (M7) | Rare race (reservation released while payment was in flight). |
| No retry / circuit breaker on the reserve call, fixed 3 s timeout | Retries with backoff + jitter, **circuit breaker**, bulkheads (M7) | A dying inventory service still costs each checkout up to 3 s. |
| One shared secret for service calls | mTLS / SPIFFE identities | Secret leak = any caller is "a service". |
| Every order-service instance runs the reconciler | Leader election / a lock so only one sweeps | Harmless here because every step is idempotent, just wasteful. |
| Static service URLs in env | Service discovery (Kubernetes DNS, Consul) + load balancing across instances | Needed once a service has several instances. |

## 5. Verification

- **Backend: 111 tests** (was 97; 117 after the review fixes, see §6). Every test now goes **through the gateway to real service processes on random
  ports with a real broker** (`test-cluster.ts`). New `m6-microservices.test.ts` (14 tests): payment service down →
  orders wait PENDING → charged when it returns; gateway routing / correlation id / edge 401/403 / `/internal`
  blocked; internal token required; stopped service → 502 only for its routes, `/health/ready` = `degraded`;
  inventory down → 503, no order, cart intact; **reserve timeout → cancel + tombstone refuses the late reserve**;
  reservation idempotency and races; lost `OrderCreated` healed by the reconciler; the same `OrderCreated` delivered
  3× charges once; request id carried through 3 events across 2 topics. Suite run 3× in a row: all green.
- **Frontend: 23 unit tests** (+1: `503 inventory_unavailable` is a clear answer, not retried).
- **Live system** (`npm run dev`, 7 processes): 9/9 API checks (checkout answered **201 PENDING in 178 ms**, CONFIRMED
  after ~1.8 s; decline restores cart). **Edge headless browser: 10/10** (processing screen → confirmed without
  reload, decline screen, admin *Services* with 4 services up, *Events* with 5 groups, 390 px phone layout).

## 6. Found in code review (PR #4) and fixed

| # | Problem | Fix |
|---|---|---|
| 1 | After a reserve **timeout**, stock was given back only by a best-effort release + best-effort event. If both were lost, the units stayed `HELD` forever. | **Reservation sweeper** in the inventory service (`inventory/sweeper.ts`). Every 30 s it looks at reservations `HELD` for more than 2 min and asks the order service (`GET /internal/orders/:id/status`) what happened: CONFIRMED → commit, CANCELLED/absent → release, PENDING → leave. "Ask the source of truth, then repair." |
| 2 | The gateway **appended** to the client's own `X-Forwarded-For`. Services trust loopback, so a faked header became `req.ip` and bypassed the per-IP login limit. | The gateway **replaces** the header with the one address it trusts (`req.ip`). Test: 11 logins with 11 fake IPs → the 11th is 429. |
| 3 | `npm start` ran the dev watcher (`tsx watch` on `.ts`) instead of the build. | The launcher detects it runs from `dist/` and starts the compiled `.js` with plain node, cwd = backend root. |
| 4 | A cart with more than 100 products → inventory 400 → treated as "unknown" → "inventory unavailable, try again" forever. | 400 `too_many_items` at checkout. Any other 4xx from inventory = "definitely nothing reserved" (undo), never "unknown". |
| 5 | The reconciler took the 50 oldest PENDING orders, then skipped those backing off → 50 hopeless orders could starve newer ones. | Orders in backoff are excluded **in the query**. |
| 6 | Restoring the cart added the order's quantities on top → items re-added while PENDING were **doubled**. | Each line becomes `max(cart now, ordered)`. |
| 7 | Every payment failure became "payment declined"; a duplicate delivery lost the real reason. | Reason derived from the stored method; `payment_failed` vs `payment_declined`. |
| 8 | A release didn't refresh low-stock alerts (stale alert after a cancel). | Release updates/clears existing alerts (but never *creates* one — a cancel is not a sale). |
| 9 | A closed browser tab was counted as a service error / 502 on Admin › Services. | The proxy marks "client gone" and doesn't count it. |
| 10 | Dead code (`publishOrderCreated` with random ids, `ORDERS_PARTITIONS`), duplicated group filter. | Removed; gateway uses `groupsOfService()`. |

**Found by the new tests while fixing:** raw SQL wrote `now()` into a timestamp column. The database runs in
**Asia/Calcutta** (+5:30) but Prisma stores **UTC**, so every reservation looked 5.5 hours younger than it was and the
sweeper never saw it. Raw inserts now write `now() AT TIME ZONE 'UTC'`. Lesson: one time-zone convention
everywhere, or use `timestamptz`.

Tests after the fixes: **backend 117** (6 new regression tests), frontend 23.

## 7. Interview questions

1. **Why extract payment first, and why make it asynchronous?** *Hint:* independent failure mode, external latency,
   locks held during a slow call; customer gets an answer, events wait while the service is down.
2. **Why is stock reservation still synchronous?** *Hint:* the customer needs "out of stock" now; fast, internal,
   contended; async would mean accepting orders you must later cancel.
3. **A call to the inventory service times out. Did it reserve the stock? What do you do?** *Hint:* unknown outcome;
   compensate (release) idempotently; tombstone against the late request.
4. **How do you make "charge the card" safe when the event can arrive twice?** *Hint:* unique constraint per order,
   provider idempotency key, check-before-call, return the stored result.
5. **What does an API gateway do, and what must it not do?** *Hint:* routing, auth, rate limit, correlation, TLS,
   aggregation — no business logic (or it becomes the new monolith). Why do services still check the token?
6. **Shared database vs database per service?** *Hint:* coupling and independent deployability vs joins and
   transactions; how to keep reads working (events + local copies, API composition, CQRS).
7. **The order is saved but `OrderCreated` was lost. How does the system recover, and how would you prevent it?**
   *Hint:* reconciler/sweeper now; transactional outbox or CDC (M7/M8).
8. **How do you follow one request across five processes?** *Hint:* correlation id in headers and event headers →
   distributed tracing (OpenTelemetry) in M9.
9. **What is the strangler fig pattern?** *Hint:* gateway in front, cut one capability out at a time, keep shipping.
10. **What new failure modes did microservices add that the monolith didn't have?** *Hint:* partial failure,
    timeouts, duplicates, ordering, eventual consistency, versioned contracts, operational cost.
