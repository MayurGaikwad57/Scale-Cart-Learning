# 02 — Architecture

## Phase 1 shape: modular monolith

```text
Angular (4200) -> Express API (3000) -> PostgreSQL (5432)

Express is ONE process, split into modules:
  users | products | inventory | cart | orders | payments
```

### Module rules
- Each module owns its folder: `routes`, `controller`, `service`, `repository`, `types`, `validation` (only where useful).
- A module calls another module **through its service**, never through its tables or repository.
- Known exception: `orders` runs a transaction that touches inventory. This coupling is deliberate; Outbox + Saga remove it in later phases.

### Layer responsibilities
| Layer | Job |
|---|---|
| routes | Map URL + method to a controller |
| controller | Parse request, call service, shape response |
| service | Business rules |
| repository | Database access (Prisma) |
| validation | zod schemas for input |

## Folder structure
```text
backend/src/{config,middleware,modules/*,routes,utils}, app.ts, server.ts
backend/prisma/{schema.prisma,migrations}
frontend/src/app/{core,shared,features}
docs/
```

## Decision log

Format: Problem → Options → Decision → Why → Trade-offs → Failure scenarios.

### D1. Modular monolith first
- **Problem:** how to structure the system at the start.
- **Options:** microservices from day one; plain monolith; modular monolith.
- **Decision:** modular monolith.
- **Why:** fastest to build, one transaction can protect order + stock, boundaries show where to split later.
- **Trade-offs:** one deployable unit; one shared database; whole app scales together.
- **Failure scenarios:** a bug in one module can take down the process; mitigated later by extracting services.

### D2. Prisma as the data layer (chosen by the project owner)
- **Problem:** how the code talks to PostgreSQL.
- **Options:** raw `pg`; Prisma; Drizzle/TypeORM.
- **Decision:** Prisma 7 with the `pg` driver adapter.
- **Why:** typed queries, schema as source of truth, versioned migrations.
- **Trade-offs:** Prisma has no `SELECT ... FOR UPDATE` API; row locks use `$queryRaw` inside `$transaction`. CHECK constraints must be written as raw SQL in migrations.
- **Failure scenarios:** forgetting the lock inside the transaction reintroduces the overselling race; covered by a concurrency test in M2.

### D3. Money as integer cents
- **Problem:** floating-point errors (0.1 + 0.2).
- **Decision:** store `price_cents` as `Int`.
- **Trade-offs:** must convert for display.

### D4. Oversell prevention
- **Problem:** two buyers purchase the last item simultaneously.
- **Options:** pessimistic row lock; conditional `UPDATE ... WHERE available >= qty`; optimistic version check; serializable isolation.
- **Decision:** row lock (`SELECT ... FOR UPDATE`) with consistent lock order by product id, plus a DB CHECK `available >= 0` as a last line of defence.
- **Why:** simple and correct. Consistent ordering avoids deadlocks.
- **Trade-offs:** contention on hot products; lock wait time.
- **Failure scenarios:** inconsistent lock order causes deadlocks; Postgres aborts one transaction, the app must retry or return an error.

### D5. Auth
- JWT bearer token + bcrypt. Stateless, fits the future gateway. Trade-off: revocation is harder.

### D6. Frontend
- Angular standalone + signals, no Angular Material. State placement: signals for session/cart, observables for HTTP/debounced search, local state for form UI.

### D7. Monorepo
- One repo (`backend/`, `frontend/`, `docs/`). One link to show; milestones span both apps; services join under `services/` later.
