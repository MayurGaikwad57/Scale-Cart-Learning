# ScaleCart — Distributed Order Processing Platform

## 1. PROJECT PURPOSE

We are building a flagship full-stack engineering project called **ScaleCart**.

The goal is NOT to build a generic e-commerce CRUD application.

The goal is to build a realistic order-processing platform that starts as a **modular monolith** and is progressively evolved into a **distributed microservices architecture**.

This project must demonstrate:

* Modern Angular
* Node.js + Express
* PostgreSQL
* Redis
* Kafka
* Microservices
* Distributed transactions
* Idempotency
* Outbox Pattern
* Saga Pattern
* Retry mechanisms
* Circuit breakers
* Rate limiting
* Bounded concurrency
* Load shedding
* Database replication
* WAL / CDC concepts
* Debezium
* Sharding concepts
* Consistent hashing
* Observability
* Production-oriented engineering decisions

The project should be designed so that every architectural decision can be explained in a technical interview.

---

# 2. CORE PRINCIPLE

Do NOT build everything at once.

The project must evolve incrementally:

```text
Phase 1
Complete Modular Monolith
        ↓
Phase 2
Redis + Performance
        ↓
Phase 3
Kafka + Async Processing
        ↓
Phase 4
Extract Microservices
        ↓
Phase 5
Reliability Patterns
        ↓
Phase 6
Database Scaling + CDC
        ↓
Phase 7
Observability + Interview Readiness
```

Do NOT prematurely introduce microservices.

The initial system must be a clean modular monolith.

Later, selected modules will be extracted into microservices for a specific architectural reason.

---

# 3. TECHNOLOGY STACK

## Frontend

Use modern Angular.

Required:

* Angular standalone architecture
* Signals
* computed()
* effect()
* Signal-based inputs/outputs where appropriate
* Modern Angular control flow
* Lazy loading
* Dependency injection using modern Angular APIs
* RxJS
* Reactive Forms
* HTTP interceptors
* Route guards
* OnPush / modern change detection concepts
* TypeScript

Do NOT structure the application around old Angular NgModule-heavy architecture.

Do NOT use Angular Material unless there is a specific reason.

Prefer clean Bootstrap/custom CSS where appropriate.

---

## Backend

Use:

* Node.js
* Express
* TypeScript
* PostgreSQL
* Redis
* Kafka
* Docker

Use a clean modular backend architecture.

Potential ORM/query layer can be selected based on project requirements, but the choice must be documented.

---

## Distributed Systems

Later phases will introduce:

* Kafka
* Redis
* Debezium
* API Gateway
* Microservices
* Outbox Pattern
* Saga Pattern
* Circuit Breaker
* Retry with exponential backoff
* Jitter
* Rate limiting
* Idempotency
* Bounded concurrency
* Load shedding
* Read replicas
* CDC
* Sharding design
* Consistent hashing

---

# 4. INITIAL ARCHITECTURE

Start with:

```text
                    Angular
                       |
                       v
                Node + Express
                       |
        +--------------+--------------+
        |              |              |
      Users         Products        Orders
        |              |              |
        |          Inventory          |
        |              |              |
        +--------------+--------------+
                       |
                       v
                  PostgreSQL
```

Internally the backend must be modular:

```text
backend/

src/

  config/

  middleware/

  modules/

    users/
    products/
    inventory/
    cart/
    orders/
    payments/

  routes/

  utils/

  app.ts
```

Each module should have clear responsibilities.

Prefer:

```text
controller
service
repository
routes
types
validation
```

where appropriate.

Do not create unnecessary abstraction layers just for the sake of design patterns.

---

# 5. BUSINESS DOMAIN

ScaleCart is an order-processing platform.

The user should be able to:

1. Register/login
2. Browse products
3. Search/filter products
4. View product details
5. Add products to cart
6. Modify cart
7. Checkout
8. Place an order
9. Reserve inventory
10. Process payment
11. View order status
12. View order history

Later the system will support:

* asynchronous payment
* inventory events
* notifications
* analytics
* event processing
* failure recovery

---

# 6. DATABASE

Initial PostgreSQL schema should include approximately:

```text
users

products

inventory

cart

cart_items

orders

order_items

payments
```

Later introduce:

```text
outbox_events
```

Database design must include:

* primary keys
* foreign keys
* constraints
* appropriate indexes
* transactions
* appropriate isolation considerations

Do not create indexes blindly.

Every important index should have a reason.

---

# 7. PHASE 1 — MODULAR MONOLITH

## Goal

Create a complete working product before introducing microservices.

Implement:

### Authentication

```text
POST /auth/register
POST /auth/login
```

### Products

```text
GET /products
GET /products/:id
POST /products
PUT /products/:id
DELETE /products/:id
```

Include:

* pagination
* filtering
* sorting

### Inventory

```text
GET /inventory/:productId
POST /inventory
```

### Cart

```text
GET /cart
POST /cart/items
PUT /cart/items/:id
DELETE /cart/items/:id
```

### Orders

```text
POST /orders
GET /orders
GET /orders/:id
```

### Initial order flow

```text
Client
  |
  v
Order API
  |
  v
Transaction
  |
  +--> Create Order
  |
  +--> Validate/Reserve Inventory
  |
  v
Commit
```

Important:

Study concurrent inventory updates.

Example:

Two users attempt to purchase the last available product simultaneously.

Understand:

* race conditions
* database transactions
* row locking
* isolation
* MVCC

---

# 8. PHASE 1 FRONTEND

Build modern Angular frontend.

Structure:

```text
src/app/

  core/

    auth/
    guards/
    interceptors/
    services/

  shared/

    components/
    directives/
    pipes/

  features/

    auth/
    products/
    cart/
    checkout/
    orders/
    admin/
```

Pages:

```text
Login
Register

Product List
Product Details

Cart

Checkout

Order Confirmation

Order History

Order Details
```

Use Signals intentionally.

Example conceptual state:

```text
products = signal(...)
cartItems = signal(...)

cartTotal = computed(...)
```

Do not use Signals just because they are new.

Document why a piece of state uses:

* Signal
* Observable
* Service
* Local component state

---

# 9. PHASE 2 — REDIS

Introduce Redis after the monolith works.

First implement:

## Product caching

```text
GET Product

      |
      v
    Redis
    /   \
  HIT   MISS
   |      |
 return  PostgreSQL
           |
           v
         Redis
```

Use Cache Aside.

Study:

* TTL
* cache invalidation
* cache stampede
* cache avalanche
* cache penetration

---

## Rate limiting

Use Redis for distributed rate limiting.

Example:

```text
100 requests/minute/user
```

Understand:

* fixed window
* sliding window
* token bucket

---

## Idempotency

Implement idempotency for order creation.

Example:

```text
Idempotency-Key: abc123
```

If the same request is retried:

```text
abc123
   |
   v
Existing result
   |
   v
Return same order
```

Do not create duplicate orders.

---

# 10. PHASE 3 — KAFKA

Introduce Kafka after the core business workflow is stable.

First create:

```text
OrderCreated
```

Flow:

```text
Order Service
      |
      v
    Kafka
      |
      v
 Consumer
```

Then create multiple consumers:

```text
                     Kafka
                       |
          +------------+------------+
          |            |            |
          v            v            v
      Payment      Inventory   Notification
      Consumer      Consumer      Consumer
```

Learn and implement:

* topics
* partitions
* producers
* consumers
* consumer groups
* offsets
* commits
* ordering
* at-least-once delivery
* duplicate messages
* consumer failure
* rebalancing
* retry
* DLQ

The Kafka implementation should be connected to real ScaleCart workflows.

Do not create Kafka demos unrelated to the application.

---

# 11. PHASE 4 — MICROSERVICES

Only after the modular monolith is working.

Do not rewrite everything.

Gradually extract services.

Recommended order:

## Payment Service

Extract payment because it has:

* independent failure characteristics
* retries
* timeouts
* idempotency
* circuit breaker
* bounded concurrency

Architecture:

```text
Order Service
      |
      v
    Kafka
      |
      v
Payment Service
```

---

## Inventory Service

Extract inventory because it has:

* concurrency
* reservation
* contention
* independent scaling requirements

Architecture:

```text
Order Service
      |
      v
    Kafka
      |
      v
Inventory Service
```

---

## Notification Service

Notification should be asynchronous.

```text
Order Event
    |
    v
 Kafka
    |
    v
Notification Worker
```

---

# 12. API GATEWAY

Introduce an API Gateway after services exist.

Architecture:

```text
Angular
   |
   v
API Gateway
   |
   +------> Order Service
   |
   +------> Inventory Service
   |
   +------> Payment Service
```

Gateway responsibilities can include:

* routing
* authentication
* rate limiting
* request correlation
* basic aggregation where appropriate

Do not put business logic in the gateway.

---

# 13. PHASE 5 — OUTBOX PATTERN

Solve the dual-write problem.

Bad:

```text
BEGIN

Create Order
COMMIT

Publish Kafka event
```

If Kafka fails after the database commits, state becomes inconsistent.

Implement:

```text
orders
outbox_events
```

Same database transaction:

```text
BEGIN

Create Order

Create Outbox Event

COMMIT
```

Then:

```text
Outbox Publisher
       |
       v
     Kafka
```

Understand:

* atomicity
* polling publisher
* duplicate events
* idempotent consumers
* eventual consistency

---

# 14. PHASE 6 — SAGA

Implement an order workflow:

```text
Create Order
      |
      v
Reserve Inventory
      |
      v
Process Payment
      |
      v
Confirm Order
```

Failure:

```text
Payment Failed
      |
      v
Release Inventory
      |
      v
Cancel Order
```

Study:

* Saga
* orchestration
* choreography
* compensation
* eventual consistency

Prefer implementing one approach and documenting the alternative.

---

# 15. RETRY + CIRCUIT BREAKER

Implement resilient communication.

Example:

```text
Payment Service
       |
    timeout
       |
     retry
       |
 exponential backoff
       |
      jitter
```

Do NOT blindly retry everything.

Distinguish:

* retryable errors
* non-retryable errors

Add Circuit Breaker:

```text
CLOSED
  |
  v
Failures
  |
  v
OPEN
  |
  v
HALF OPEN
  |
  v
CLOSED
```

Understand how retries can amplify load.

---

# 16. BOUNDED CONCURRENCY

Protect downstream dependencies.

Bad:

```text
10,000 requests
      |
      v
10,000 downstream calls
```

Better:

```text
10,000 requests
      |
      v
Queue / limiter
      |
      v
Maximum 50 concurrent calls
      |
      v
Payment Service
```

Study:

* concurrency limits
* backpressure
* queueing
* load shedding
* tail latency

---

# 17. DATABASE SCALING

Start with:

```text
PostgreSQL Primary
```

Then design:

```text
                 Primary
                /       \
               v         v
          Read Replica  Read Replica
```

Study:

* WAL
* MVCC
* replication
* replica lag
* read-after-write consistency
* connection pooling
* read/write splitting

Do not implement unnecessary infrastructure just for demonstration.

The goal is to understand the tradeoffs and have an architecture that could evolve.

---

# 18. CDC + DEBEZIUM

Implement/experiment with:

```text
PostgreSQL
     |
     v
    WAL
     |
     v
 Debezium
     |
     v
   Kafka
     |
     +----> Analytics
     |
     +----> Audit
     |
     +----> Search/Other consumers
```

Understand:

* CDC
* WAL
* Debezium
* event streams
* eventual consistency

---

# 19. SHARDING

Do not spend significant time implementing physical database sharding.

Instead:

Design the evolution:

```text
Single DB
   |
   v
Primary + Replicas
   |
   v
Partitioning
   |
   v
Sharding
```

Study:

* shard key
* hot partitions
* rebalancing
* cross-shard queries
* consistent hashing
* metadata/routing

Use ScaleCart examples.

---

# 20. MULTI-REGION DESIGN

Design:

```text
              Global Traffic
                    |
             +------+------+
             |             |
             v             v
          Region A      Region B
```

Discuss:

* latency
* replication
* failover
* consistency
* active-active
* active-passive
* disaster recovery

Do not spend weeks deploying actual multi-region infrastructure.

---

# 21. OBSERVABILITY

Add basic observability.

Track:

```text
Request count
Error rate
P95 latency
P99 latency
Kafka consumer lag
Failed payments
Inventory failures
Order throughput
```

Create an Angular admin/operations dashboard:

```text
----------------------------------------
          ScaleCart Operations
----------------------------------------

Orders/min              1,248
Payment Success          98.7%
API P95                  180ms
API P99                  410ms
Kafka Lag                 124
Failed Payments             17
Inventory Conflicts          3
----------------------------------------
```

The dashboard exists to demonstrate system behavior, not to become a separate analytics product.

---

# 22. TESTING

Testing must be incremental.

Backend:

* unit tests
* service tests
* API/integration tests

Important scenarios:

```text
Concurrent inventory purchase

Duplicate order request

Payment timeout

Kafka consumer failure

Duplicate Kafka message

Redis unavailable

Database failure

Retry exhaustion
```

Frontend:

* component tests where useful
* service tests
* important user-flow tests

Do not chase 100% coverage.

Prioritize business-critical paths.

---

# 23. DOCUMENTATION

Maintain a `/docs` directory.

Suggested structure:

```text
docs/

01-requirements.md

02-architecture.md

03-database-design.md

04-api-design.md

05-caching.md

06-kafka.md

07-microservices.md

08-outbox.md

09-saga.md

10-reliability.md

11-database-scaling.md

12-cdc.md

13-sharding.md

14-observability.md

15-interview-questions.md
```

Every major architectural decision should document:

```text
Problem
   ↓
Options
   ↓
Decision
   ↓
Why
   ↓
Trade-offs
   ↓
Failure scenarios
```

---

# 24. DEVELOPMENT RULES

## Rule 1

Do not generate the entire project at once.

Build one milestone at a time.

---

## Rule 2

Before implementing a major feature, explain:

1. What problem are we solving?
2. Why do we need it?
3. What alternatives exist?
4. What trade-off are we accepting?

Then implement.

---

## Rule 3

Keep the code production-oriented but not over-engineered.

Avoid unnecessary:

* abstractions
* design patterns
* libraries
* microservices
* infrastructure

---

## Rule 4

Every phase must leave the application runnable.

Never leave the repository broken while moving to the next phase.

---

## Rule 5

Do not introduce a technology just because it appears impressive on a resume.

Every technology must solve a real problem in ScaleCart.

---

# 25. INTERVIEW MODE

After every major phase, generate interview questions.

For example, after Redis:

```text
Why Redis?
Why Cache Aside?
What happens when Redis goes down?
What happens during cache stampede?
How would you invalidate the cache?
```

After Kafka:

```text
What happens when a consumer crashes?
What happens before offset commit?
How do you handle duplicates?
What causes rebalancing?
How do partitions affect scaling?
```

After microservices:

```text
Why did you extract Payment?
Why not extract everything?
How do services communicate?
What happens when one service is unavailable?
```

After Saga:

```text
Why can't we use a distributed transaction?
How do compensating transactions work?
What happens if compensation fails?
```

After database scaling:

```text
Why read replicas?
What is replica lag?
What is WAL?
How would you shard?
What causes hot partitions?
```

---

# 26. PROJECT MILESTONES

Use these exact checkpoints.

## M1 — Foundation

* [ ] Repository
* [ ] Angular setup
* [ ] Node/Express setup
* [ ] PostgreSQL
* [ ] Docker
* [ ] Architecture

## M2 — Backend Core

* [ ] Auth
* [ ] Products
* [ ] Inventory
* [ ] Cart
* [ ] Orders
* [ ] Transactions

## M3 — Frontend Core

* [ ] Modern Angular
* [ ] Signals
* [ ] Product UI
* [ ] Cart
* [ ] Checkout
* [ ] Orders

## M4 — Performance

* [ ] Redis
* [ ] Cache Aside
* [ ] Rate limiting
* [ ] Idempotency

## M5 — Kafka

* [ ] Producer
* [ ] Consumer
* [ ] Topics
* [ ] Partitions
* [ ] Consumer groups
* [ ] Offsets
* [ ] Rebalancing
* [ ] Retry
* [ ] DLQ

## M6 — Microservices

* [ ] API Gateway
* [ ] Payment Service
* [ ] Inventory Service
* [ ] Notification Service

## M7 — Reliability

* [ ] Outbox
* [ ] Saga
* [ ] Retry
* [ ] Circuit breaker
* [ ] Timeout
* [ ] Bounded concurrency
* [ ] Load shedding

## M8 — Scaling

* [ ] Read replicas
* [ ] Replica lag
* [ ] WAL
* [ ] CDC
* [ ] Debezium
* [ ] Partitioning
* [ ] Sharding design
* [ ] Consistent hashing
* [ ] Multi-region design

## M9 — Observability

* [ ] Metrics
* [ ] Logs
* [ ] Error tracking
* [ ] Kafka lag
* [ ] Admin dashboard

## M10 — Interview

* [ ] Project explanation
* [ ] Architecture explanation
* [ ] Failure scenarios
* [ ] Scaling scenarios
* [ ] Trade-offs
* [ ] 30-minute system design
* [ ] 45-minute deep dive

---

# 27. IMPORTANT: HOW CLAUDE SHOULD WORK WITH ME

Do NOT simply dump large amounts of code.

For each milestone:

### Step 1 — Explain

Explain the architecture and reasoning.

### Step 2 — Plan

Show the files/components that will change.

### Step 3 — Implement

Implement the smallest useful increment.

### Step 4 — Test

Run/test the implementation.

### Step 5 — Explain

Explain what was actually implemented.

### Step 6 — Challenge

Give me 3–5 interview questions about what we just built.

### Step 7 — Checkpoint

Tell me:

```text
Completed:
Remaining:
Architecture learned:
Interview questions:
Potential issues:
```

Then wait for the next instruction.

---

# 28. IMPORTANT DEVELOPMENT PHILOSOPHY

I am building this project primarily for **learning + interview readiness**, not just for obtaining a GitHub repository.

Therefore, optimize for:

```text
Understanding
   >
Implementation speed
   >
Architectural complexity
```

The final project should allow me to explain:

> "I started with a modular monolith because it was simpler and allowed faster development. As different workloads developed different scaling and reliability requirements, I progressively extracted services. Kafka was introduced where asynchronous processing provided real value. Redis was introduced for caching, rate limiting and idempotency. The Outbox pattern solved the database/event dual-write problem, and Saga handled distributed business workflows."

That narrative is a core objective of the project.

---

# 29. FIRST TASK

Do NOT start implementing the entire project.

Start with:

## M1 — Foundation / Day 1

First provide:

1. Functional requirements
2. Non-functional requirements
3. High-level architecture
4. Initial database entities
5. Initial API boundaries
6. Frontend feature boundaries
7. Backend module boundaries
8. Development roadmap
9. Folder structure
10. Architecture decisions and their reasoning

Then wait for approval before generating implementation code.

**We will build ScaleCart incrementally and keep every milestone runnable.**
