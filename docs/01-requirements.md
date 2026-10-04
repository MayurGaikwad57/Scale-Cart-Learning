# 01 — Requirements

## Functional requirements (Phase 1)

| Area | What the user / admin can do |
|---|---|
| Auth | Register and log in (JWT). Roles: `CUSTOMER`, `ADMIN`. |
| Catalog | List products with pagination, filtering (category, price range, text) and sorting. View details. Admin: create / update / delete. |
| Inventory | Admin sets stock per product. Anyone can read availability. |
| Cart | One cart per user. Add, change quantity, remove items. |
| Checkout | `POST /orders` turns the cart into an order in **one database transaction**: create order, validate and reserve stock, record payment (simulated). |
| Orders | View order status, history and details. |

Order statuses (Phase 1): `PENDING → CONFIRMED | CANCELLED`. More states arrive with the Saga (Phase 6).

## Non-functional requirements

| Quality | Phase 1 target | Later phase |
|---|---|---|
| Correctness | Never oversell stock, even under concurrent checkouts | Idempotent order creation (Phase 2) |
| Consistency | ACID inside one Postgres transaction | Eventual consistency via Outbox + Saga |
| Performance | Catalog reads < 100 ms p95 | Redis cache-aside (Phase 2) |
| Security | bcrypt password hashing, JWT, validated input, no raw string SQL | Gateway auth + rate limiting |
| Observability | Health endpoints, structured logs | Metrics + dashboard (Phase 7) |
| Maintainability | Strict module boundaries | Easy service extraction |

## Out of scope for Phase 1
Redis, Kafka, microservices, real payment provider, email notifications.
