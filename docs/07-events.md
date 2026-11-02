# 07 — M5 Events: our own Kafka ("ScaleLog")

**Constraint:** nothing can be installed (no Kafka, no Docker). **Decision:** build a Kafka-like broker in Node.js that
keeps Kafka's *model*: a **separate process**, **append-only partition logs on disk**, **consumer groups with
rebalancing**, **committed offsets stored in a log**, **at-least-once delivery**, **retry + DLQ**. It reuses ScaleKV's
RESP protocol and TCP client, so reconnects, timeouts and the circuit breaker come for free.

```
 checkout (API) ──PRODUCE──► ScaleLog broker :9093 ── topic "orders": orders-0.log  orders-1.log  orders-2.log
                                   │                   (+ __consumer_offsets-0.log, orders.<group>.dlq-0.log)
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
   group "notification"     group "inventory"         group "analytics"      each group gets EVERY event
   → notifications table    → stock_alerts table      → sales_daily table    and keeps its OWN offsets
   (bell in the navbar)     (low-stock list)          (daily sales report)
```

## 1. The pieces (`backend/src/log/`)

| File | What it is |
|---|---|
| `storage.ts` | `PartitionLog`: one append-only file per partition. Each line is a record `{offset, timestamp, key, value, headers}`. Every append is **fsync'ed before we answer**, so an acknowledged event survives a crash. A **torn last line** (power cut mid-write) is detected and cut off at startup. |
| `broker.ts` | Topics, partitioning, consumer groups, rebalancing, commits, fencing, admin offset reset, `DESCRIBE`. |
| `server.ts` / `log-server.ts` | `npm run log`, the broker process (same generic RESP server as ScaleKV: `kv/resp-server.ts`). |
| `client.ts` | Typed client (`produce`, `fetch`, `join`, `heartbeat`, `commit`, …) over the ScaleKV RESP connection. |
| `consumer.ts` | The **consumer runtime**: join, fetch, handle, commit, heartbeat, retry, DLQ. |
| `../events/*` | ScaleCart's use of it: the `OrderCreated` event, the three handlers, the worker process (`npm run worker`). |

Commands (try them with `npm run log:cli`): `CREATETOPIC`, `PRODUCE topic key value [headers]`,
`FETCH topic partition offset max`, `JOIN group topic member`, `HEARTBEAT`, `LEAVE`,
`COMMIT group topic partition offset member generation`, `COMMITTED group topic`, `SETOFFSET`, `DESCRIBE`.

## 2. Concepts, as built

**Topic and partitions.** `orders` has 3 partitions. A record's **offset** is its position in its partition and never
changes. Reading does **not** delete anything, which is the big difference from a queue like RabbitMQ: many groups read the
same log independently, and a log can be re-read (replay).

**Partitioning and ordering.** The key is the **order id**, and the partition is `FNV-1a(key) % 3`. All events of one order land in
the same partition and are processed one after another, so **per-key order** is preserved. There is no order *across*
partitions, which is the price of parallelism. (Real Kafka hashes in the *client* with murmur2; ours hashes in the broker.)

**Consumer groups.** Every partition is owned by exactly **one member** of a group, and different groups each see every event.
`notification`, `inventory` and `analytics` are three groups, so a slow analytics consumer never delays notifications.
Parallelism is capped by the partition count: 4 members on 3 partitions leaves one member idle (a test checks this).

**Rebalancing.** Members `JOIN`, then send a `HEARTBEAT` every second. The broker re-divides partitions (*range
assignment*) and bumps the group's **generation** whenever a member joins, leaves (`LEAVE` on Ctrl+C means immediate), or
goes silent for 10 s (crash: detected by the session timeout). Measured live: after a worker was killed hard, the API
took its partitions back after **10.3 s**.

**Offsets and commits.** After handling a record the member commits `offset + 1` ("processed everything before this"). Commits
are appended to the internal topic **`__consumer_offsets`**, exactly like Kafka, and replayed at broker startup. With no
commit yet, a group starts from the beginning (`auto.offset.reset = earliest`).

**Fencing (zombies).** A commit carries the member's generation. After a rebalance, the old owner's late commit gets
`ILLEGAL_GENERATION` / `NOT_ASSIGNED`, so a "zombie" can't overwrite the new owner's progress.

**Delivery guarantee: at-least-once.** We commit *after* handling. A crash between "handled" and "committed" means the
event is delivered again. (Committing before handling would be *at-most-once*: a crash loses the event.)
"Exactly-once delivery" doesn't exist across systems. What we build is an **exactly-once *effect***:

**Idempotent consumers (`processed_events`, "inbox").** Each handler runs inside
`once(group, eventId, tx => …)`, which inserts `(consumer_group, event_id)` **in the same DB transaction** as the side effect.
A redelivered event hits the primary key and is skipped. Both commit or both roll back. This matters most for
`analytics`, where `revenue += total` is *not* naturally idempotent. Tests deliver the same event twice and check that there is one notification
and revenue is counted once.

**Retry → DLQ → replay.** A failing handler is retried with exponential backoff (200 ms, 400 ms), then the record is
copied to `orders.<group>.dlq` with headers (`x-error`, `x-attempts`, `x-original-partition/offset`, …), committed, and
the partition **keeps flowing**. Without that, one *poison message* blocks its partition forever (head-of-line
blocking). If even the DLQ write fails, we don't commit, so it's retried later and nothing is lost. **Replay** (admin
button) re-publishes waiting DLQ records to `orders` and moves a replayer group's offset with `SETOFFSET`. Every group sees
the replayed event again; the groups that already handled it skip it (idempotency), and only the failed one does the work.
**Trade-off:** while an event sits in the DLQ, later events of the same order can overtake it.

**Chaos switch.** Admin → Events toggles `chaos:fail:<group>` in ScaleKV, so every worker process sees it. That group then fails
every event, which makes retry → DLQ → replay visible in the UI.

## 3. The dual-write gap (on purpose, the motivation for M7)

Checkout commits the order in PostgreSQL **and then** publishes to ScaleLog. Those are two systems with no shared transaction.
If the broker is down, or the process dies between the two writes, the order exists but its event never does: no
notification, no analytics. We never fail the customer's checkout for that. Instead we **count** it
(`publisher.notPublished`, shown as a warning on the Events page; a test covers it). **M7's Outbox pattern** fixes it:
write the event into an `outbox` table in the *same* transaction as the order, and let a relay publish it.

## 4. Simplifications vs real Kafka (know them for interviews)

| Kafka | ScaleLog |
|---|---|
| Many brokers, replicated partitions, leader election, ISR, `acks=all` | One broker; durability by fsync per append |
| Segment files + index files + retention/compaction | One file per partition, everything kept, records also held in memory |
| Client-side partitioner (murmur2), batching, compression | Broker-side FNV-1a, one record per request |
| Group leader computes assignment; eager or cooperative rebalancing | Broker computes range assignment; members learn it on their next heartbeat |
| Long-poll fetch | Short poll (300 ms when idle) |
| Exactly-once *within Kafka* (idempotent producer + transactions) | Exactly-once *effect* via idempotent consumers in PostgreSQL |

## 5. Verification

- **Backend: 97 tests** (70 before + 27 new, incl. the review fixes in section 6). The broker and storage tests cover offsets, restart, torn writes, hashing, range
  assignment, expiry, fencing, offsets after restart, and admin reset. The consumer tests over TCP cover order, retry,
  DLQ, rebalancing, crash before commit (redelivery), and the zombie commit. The end-to-end tests do a real checkout → three groups →
  PostgreSQL, plus a duplicate, chaos → DLQ → replay, the admin view, and the broker being down. **Mutation-checked:** removing
  idempotency, fencing, dead-lettering, stable hashing, torn-write repair or member expiry makes a test fail.
- **Live:** four processes (API, worker, broker, ScaleKV). A worker joining split the partitions (API [0,1], worker [2]),
  and killing it hard gave them back after 10.3 s.
- **Browser (Edge):** checkout → bell badge in about 10 s → "Order confirmed"; Events page; chaos → DLQ (analytics unaffected)
  → replay → notification delivered; phone layouts. The phone run caught a real bug (the dropdown was cut off on the left,
  which a "no horizontal scroll" check couldn't see). It was fixed and the check now measures the panel's position.

## 6. Found in code review (PR #2) and fixed

These are worth knowing: each one is a classic distributed-systems mistake.

| Bug | Why it happened | Fix |
|---|---|---|
| A record written but **missing its newline** (crash between `}` and the newline) was kept, so the next record got glued onto it and both were lost on the next restart | Recovery assumed every parsed line had a newline | A line without its newline is an unfinished write and is always dropped |
| After a **broker restart** a consumer could keep stale partitions and spin | Generations live in broker memory and restart at 1; the consumer compared only the number | Compare the partition list too; after a fenced commit, heartbeat at once to fetch the real assignment |
| `once()` treated **any** unique violation as "already processed", so a real failure was silently committed (the event was lost) | Error codes are not error *sources* | Only the marker insert may mean "duplicate"; everything else is retried or dead-lettered |
| One **non-JSON record in a DLQ** broke the admin view of that queue | The DLQ is exactly where unreadable records go | Parse each record defensively; show "unreadable" |
| `COMMIT`/`SETOFFSET abc` stored `NaN` as an offset | `NaN < 0` is false, so range checks don't catch it | Whole-number validation on every numeric argument |
| Checkout **waited for the broker** (a stalled broker could add 3–9 s) | The publish was awaited although the order was already committed | Publish in the background; failures are still counted |
| Daily revenue in a 32-bit column | It overflows at about ₹2.1 crore/day | `BIGINT` (migration) |
| Opening the bell could mark an **unseen** notification read | Read-all raced with the list load | Load the list first, then mark the shown IDs only |
| API restarts left consumers registered for 10 s | No shutdown handler in the API | `SIGINT`/`SIGTERM` → consumers `LEAVE` |

Each fix has a test that fails when the fix is reverted (backend 97 tests, frontend 22).

## 7. Interview questions

1. **Kafka vs a queue (RabbitMQ/SQS): what changes when consuming doesn't delete?** *Hint:* many independent groups, replay, offsets instead of acks.
2. **How does Kafka keep events of one order in order, and what does that cost?** *Hint:* key → partition; no global order; partitions cap parallelism.
3. **A consumer crashes after writing to the DB but before committing. What happens, and how do you make it safe?** *Hint:* redelivery; at-least-once; idempotent consumer, with the marker in the same transaction.
4. **Explain a rebalance. What is a zombie consumer and how is it stopped?** *Hint:* heartbeats, session timeout, generation, fencing.
5. **One event always fails. What happens without a DLQ, and what does a DLQ cost you?** *Hint:* head-of-line blocking vs per-key ordering.
6. **Your order is saved but the event wasn't published. Why can this happen and how do you fix it?** *Hint:* dual write → transactional outbox (M7) or CDC (M8).
7. **What does "consumer lag" tell you and when do you alert on it?** *Hint:* end offset − committed; growing lag means consumers can't keep up.
