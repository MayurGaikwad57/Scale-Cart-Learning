# 06 — M4 Performance: our own Redis (ScaleKV), caching, rate limiting, idempotency

**Constraint (2026-11-02):** nothing can be installed on the development machine. No Redis, no Kafka, no Docker.
**Decision:** build the infrastructure ourselves in Node.js, keeping the *real* architecture: a **separate process**
reached over **TCP** with **Redis's own wire protocol (RESP)**. Swapping in real Redis later would only mean changing `KV_URL`.

```
 Angular (4300) ──HTTP──► ScaleCart API (3000) ──TCP / RESP──► ScaleKV (6380)   our "Redis"
                                 │                               single-threaded, in-memory, TTL + LRU
                                 └──────────── SQL ────────────► PostgreSQL (5432)  source of truth
```

Why not just a `Map` inside the API? In production you run **several API instances** behind a load balancer.
A `Map` is per process: each instance would have its own cache (one invalidation reaches one instance only) and
its own rate-limit counters (a client gets N × the limit). State that must be **shared** has to live **outside** the
app processes. That is exactly why Redis exists.

---

## 1. ScaleKV: how a Redis-like store works (`backend/src/kv/`)

| File | Role |
|---|---|
| `resp.ts` | **RESP protocol**: encoder plus incremental parser. TCP is a byte *stream*, so one packet may hold half a command or three. RESP frames values with a type byte and lengths (`$5\r\nhello\r\n`). Lengths are in **bytes** (`₹` = 3 bytes). |
| `store.ts` | **Engine**: strings with TTL, `GET/SET (EX/PX/NX/XX)/DEL/EXISTS/INCR/INCRBY/DECR/EXPIRE/PEXPIRE/TTL/PTTL/PERSIST/KEYS/DBSIZE/FLUSHALL/INFO`. No networking, so it can be tested with a fake clock. |
| `server.ts` | TCP server. Parses commands, runs them, writes replies **in order** (that is what makes pipelining work). |
| `client.ts` | Client used by the API: one connection, pipelining, timeouts, fail-fast, reconnect with backoff. |
| `kv-server.ts` / `kv-cli.ts` | `npm run kv` (the process) and `npm run kv:cli` (our `redis-cli`). |

Key ideas, each one a classic interview topic:

- **Atomic without locks.** Node runs JS on one thread and `execute()` never awaits, so `INCR` finishes before any other
  client's command starts. Real Redis is single-threaded for the same reason (I/O threads, one execution thread).
- **Expiry = lazy + active.** *Lazy:* an expired key is deleted when someone touches it. *Active:* 10×/second the server
  samples 20 keys that have a TTL. If more than 25% were expired it repeats, within a 5 ms budget. Without the active part,
  expired keys that nobody reads would stay in memory forever.
- **Eviction = LRU.** A JS `Map` keeps insertion order, and every access re-inserts the key, so the first key is the least
  recently used one. When `maxKeys` is exceeded, that key is dropped (like `maxmemory` + `allkeys-lru`). Real Redis
  *approximates* LRU by sampling, to save the memory of a linked list.
- **Pipelining.** The client writes many commands without waiting. Replies come back in the same order, so a FIFO queue
  of pending promises matches them. The rate limiter sends 3 commands in **one round trip**.
- **Timeouts and the misaligned-reply bug.** If a command times out, its slot stays in the queue (marked settled) so its
  *late* reply is thrown away. Removing the slot instead would hand that late reply to the **next** command, which means
  wrong data. A test simulates exactly this (head-of-line blocking).
- **Fail fast.** While disconnected, commands are rejected **immediately** rather than queued. A cache must never make
  the app slower than having no cache.
- **Circuit breaker for a frozen server.** A server that keeps the TCP connection open but never answers is worse than a
  dead one, because every request waits the full timeout. After **3 timeouts in a row** the client drops the connection
  itself, so status becomes `down` and later commands fail fast. Reconnect then probes again with backoff.
- **Protected keys.** Eviction skips keys starting with `rl:`, `idem:`, `product:ver:`, `products:ver`
  (`KV_PROTECTED_PREFIXES`) as long as there is a plain cache entry to evict instead. A cached page can be rebuilt from
  PostgreSQL. A rate-limit counter or an idempotency record cannot, and evicting them would reset an attacker's login limit.
  With real Redis you would usually run a separate instance for such state.
- **Reconnect with exponential backoff:** 100 ms → 200 → 400 … max 5 s.
- **Security.** It binds to `127.0.0.1` and has no password. Never expose it (real Redis: `requirepass`/ACLs, TLS, private network).
- **Not implemented, on purpose:** persistence (RDB snapshots / AOF log), replication, other data types (lists, hashes,
  sets, sorted sets), transactions/Lua. Our data is a cache plus short-lived counters, so losing it on restart is acceptable.

---

## 2. Cache-aside for the catalog (`lib/cache.ts`, `modules/products/products.cache.ts`)

```
read:  ScaleKV ── HIT ──► return
          └─ MISS ──► PostgreSQL ──► SET key value PX ttl ──► return
write: UPDATE PostgreSQL (commit) ──► then invalidate the cache keys
```

| Key | TTL | Invalidated by |
|---|---|---|
| `product:<id>:v<pver>` | 60 s | `INCR product:ver:<id>`: product edit/delete, admin stock change, a **successful** checkout of that product |
| `products:list:v<ver>:<hash of query>` | 30 s | `INCR products:ver`: admin product/stock changes only |
| `products:categories:v<ver>` | 5 min | `INCR products:ver` |
| `product:<id>:v<pver>` = `__null__` (not found) | 15 s | (expires) |

- **Versioned keys.** We can't know which of the many cached list pages (search × category × price × sort × page) contain
  a changed product. `KEYS products:list:*` would be O(N) and blocks the single thread. Instead, one `INCR products:ver`
  makes **all** old list keys unreachable at once, and they expire through their TTL. A bonus: a reader that loaded old
  data during the write stores it under the *old* version, where nobody looks. That race is gone.
- **Invalidate after commit, never inside the transaction.** Otherwise a reader could re-cache the old row between our
  delete and our commit.
- **Why product keys are versioned too (found in code review).** With a plain `DEL` there is a race: a reader misses, reads
  the OLD row, then the writer commits and deletes, and only then does the reader store the old row. That stale copy is served
  for a full TTL. With versions, the late write lands in `product:<id>:v4` while everyone already reads `…:v5`, so nobody
  ever sees it. A test reproduces exactly this. (Other mitigations you may hear about: "delayed double delete", CDC-driven
  invalidation in M8.)
- **Checkout does NOT retire the list cache (found in code review).** Bumping `products:ver` on every order would, at one
  order per second, wipe every cached list page every second (hit rate ≈ 0). A sale refreshes only the sold product's own page,
  and a declined payment refreshes nothing because net stock is unchanged. **Trade-off:** the stock figure on a catalog *list*
  page may lag by up to 30 s. That is acceptable because the product page is exact and checkout re-checks real stock under row locks.
- **Admins bypass the cache.** They edit products and must see the change immediately.
- `X-Cache: HIT | MISS | BYPASS` response header makes it visible in DevTools. The **API counts its own hit rate** (Admin →
  System status), because ScaleKV's `keyspace_hits/misses` count *every* GET, including the rate limiter reading an empty
  counter. That would look like cache misses.

The three classic cache failures:

| Problem | What happens | Our defence |
|---|---|---|
| **Stampede** (thundering herd) | A hot key expires and hundreds of requests hit the DB at the same moment | **Single-flight**: concurrent misses for the same key in one process share one DB query. (Across instances: a short `SET lock NX PX` mutex, or refresh before expiry.) |
| **Avalanche** | Many keys created together expire together, and the DB gets everything at once | **TTL jitter** ±10% |
| **Penetration** | Requests for ids that don't exist always miss and always hit the DB (often an attack) | **Negative caching** (`__null__`, 15 s) plus UUID validation before any lookup. (At scale: a Bloom filter.) |

---

## 3. Rate limiting (`middleware/rateLimit.ts`)

| Rule | Limit | Keyed by |
|---|---|---|
| `global` | 300 / min | IP, every API call |
| `auth` | 10 / min | IP, login + register (slows password guessing) |
| `orders` | 10 / min | user, placing orders |

Algorithms compared:

| Algorithm | Idea | Pros / cons |
|---|---|---|
| Fixed window | one counter per minute | cheapest; **burst of 2× at the boundary** (100 at 12:00:59 + 100 at 12:01:00) |
| Sliding window log | store every request timestamp | exact; memory = O(limit) per client |
| Token bucket | refill `r` tokens/s up to capacity `b`; a request takes a token | allows controlled bursts; needs atomic read-modify-write of 2 fields (Lua in Redis) |
| **Sliding window counter** (ours) | `estimate = previous × (1 − elapsed%) + current` | 2 counters per client, no boundary burst, needs only `INCR`/`GET`; an approximation (assumes the previous window was evenly spread) |

The rules live in one object (`rules` in `rateLimit.ts`). The admin System page reads the same object, so it can never show stale numbers.

Per request: `SET cur 0 PX 2w NX` · `INCR cur` · `GET prev`, pipelined in one round trip. Setting the TTL *before*
the INCR means no counter can ever exist without an expiry. The response includes `RateLimit-Limit/Remaining/Reset`, and on 429 also `Retry-After`.

**Fail open.** If ScaleKV is down, requests are allowed. Fail closed would turn a cache outage into a full outage. A
bank's login limiter might choose differently; that is a trade-off, not a rule. Behind a proxy or load balancer,
`req.ip` is the *proxy's* address, so every user would share one bucket. Set `TRUST_PROXY` (number of hops, e.g. `1`) and
Express takes the client IP from `X-Forwarded-For`. Only do that behind a proxy you control, because the header is easy to fake.

---

## 4. Idempotent order creation (`lib/idempotency.ts`, `orders.service.ts`)

Problem: the order is placed but the response is lost (Wi-Fi drop, timeout). The client can't know if it worked. Retrying
might order twice. Solution: the client sends `Idempotency-Key: <uuid>` per **purchase attempt**, and the server returns the
**original result** for a repeated key.

Two layers:

1. **ScaleKV (fast):** `SET idem:order:<user>:<key> {running, fingerprint} NX PX 60s`
   - NX failed and the record is *running* → **409 `request_in_progress`** (double-click / parallel retry)
   - NX failed and the record is *done* → **replay** the stored status + body, header `Idempotent-Replayed: true`
   - same key with a **different body** (fingerprint = SHA-256 of the body) → **422 `idempotency_key_reused`**
   - handler threw (e.g. cart empty) → delete the record so the same key may be retried after fixing it
   - success → store `{done, status, body}` for 24 h
2. **PostgreSQL (the guarantee):** `orders.idempotency_key` with `UNIQUE (user_id, idempotency_key)`, plus
   `orders.idempotency_fingerprint`, so a different body is still a 422 after the ScaleKV record is gone (found in code review).
   Inside the checkout transaction, **after** locking the user's cart row (`SELECT … FOR UPDATE`), we look for an order
   with that key. This is *lock, then check*: no other checkout of this user can run between the check and the insert. If
   anything still slips through, the unique constraint raises `P2002`, and we return the existing order.

Why both? ScaleKV can lose the record (restart, eviction, outage). The database can't, but it's slower and can't do
"in progress". Tests cover: same key twice, different body, two simultaneous requests, the ScaleKV record wiped, and ScaleKV down.

Frontend (`checkout.page.ts`, `orders.service.ts`): the key is created on the first click. It is **kept** when the outcome
is unknown: status 0 / 5xx, **and 409 `request_in_progress`** (the order may still succeed; found in code review). Pressing
again is then the same attempt. It is **dropped** after a clear answer or when the payment method changes. Automatic
retries: a lost answer twice (0.5 s, 1 s); "in progress" every 2 s for up to 20 s, which is longer than the server can take
(5 s waiting for a DB connection + 10 s transaction). That is safe *only because* of the key.

Honest note: our cart lock already stopped double *charges* in M2 (the second request found an empty cart). What
idempotency adds is the **right answer**: the retry gets *"here is your order"* instead of a confusing *"cart is empty"*.
And it is essential for APIs without a cart, such as payments.

---

## 5. Failure modes

| Situation | Behaviour |
|---|---|
| ScaleKV not configured (`KV_URL` empty) | Everything works from PostgreSQL; no rate limits; idempotency via the DB only |
| ScaleKV crashes while running | Commands fail fast; reads `BYPASS`; limits fail open; client reconnects automatically (verified live) |
| ScaleKV slow | 250 ms command timeout → treated as unavailable for that request |
| ScaleKV frozen (connection open, no replies) | 3 timeouts in a row → connection dropped → fail fast, reconnect probes |
| ScaleKV full | LRU evicts cache entries first; rate-limit counters, idempotency records and version counters are kept |
| ScaleKV restarted (data lost) | Cold cache (misses until warm); counters reset; DB layer still dedupes orders |
| Stale cache after a missed invalidation | Bounded by TTL (≤ 60 s); checkout always re-checks real stock under row locks, so you can never oversell |

## 6. Verification
- Backend: **70 tests** (32 from M1–M3 + 38 new: protocol, store, TCP client/server, cache, rate limits, idempotency,
  ScaleKV-down, plus one per code-review fix). New tests were **mutation-checked**: removing invalidation, the rate-limit
  check, both DB idempotency layers, the queue-slot handling, LRU refresh, per-product versions, scoped checkout
  invalidation, the DB fingerprint check, the circuit breaker or protected eviction makes them fail.
- Frontend: 20 unit tests (including the checkout retry policy).
- Code review of the PR found 10 issues; all were confirmed and fixed (sections 1–4 mark them "found in code review"). A browser run in Edge: cache MISS→HIT, checkout with the first request **dropped** → automatic
  retry with the same key → exactly one order; System page on desktop and mobile; login 429 message. Live kill/restart of
  ScaleKV: the shop kept serving (`BYPASS`) and the API reconnected on its own.

## 7. Interview questions (try answering before reading the hints)
1. **Why must a cache or rate limiter be a separate process when you run several API instances?**
   *Hint:* per-process state, invalidation reaching one instance only, N× the limit.
2. **Redis is single-threaded. Why is that fast, and why does it make `INCR` safe?**
   *Hint:* in-memory work is tiny, no lock contention, the network is the bottleneck, commands run to completion.
3. **Walk through cache-aside. Why delete after the DB commit and not before? What race remains?**
   *Hint:* re-caching an old row; TTL bounds it; versioned keys.
4. **Explain stampede vs avalanche vs penetration and one fix for each.**
5. **Fixed window vs sliding window counter vs token bucket: which would you pick for login, and for a public API?**
   *Hint:* the boundary burst; bursts allowed or not; fail open vs fail closed.
6. **A client retries `POST /orders` after a timeout. How do you guarantee one order? What if Redis lost the key?**
   *Hint:* the two layers; lock-then-check; the unique constraint; 409 vs replay vs 422.
7. **Your client library times out a command but the reply arrives later. What can go wrong?** *Hint:* reply misalignment on a pipelined connection.
